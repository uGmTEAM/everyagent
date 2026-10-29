'use strict';

/**
 * M4 · 永久档案覆盖审批状态机（override request）
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §14  M4 审批状态机：
 *          requested -> reviewing -> approved -> applied -> closed
 *          requested -> rejected / withdrawn
 *          approved  -> expired
 *          规则 1：自动冲突只产生 override request，不自动覆盖；
 *          规则 2：仅 requested_by 可 withdraw，admin 走 reject；
 *          规则 3：仅 requested 可 withdraw，必须 reason；
 *          规则 4：approved 后 TTL=7d 未 apply -> expired；
 *          规则 5：applied 完成审计后 -> closed；
 *          规则 6：before/after 快照用 memory_item.v4.1 子集，conflict_refs 指向 mem_id/audit_event_id；
 *   - §19  M4 override state 枚举（constants.M4_STATE）；
 *   - §10  memory.m4_override_request / approve / reject / apply / withdraw / expired；
 *   - §23.1 M4 不被自动降级（仅显式审批放行）。
 *
 * 设计取舍：
 *   - 附录 A 的 26 张表没有 m4_override 物理表；为满足 §14 状态持久化，
 *     本模块首次调用时惰性创建 m4_override 辅助表（CREATE TABLE IF NOT EXISTS），
 *     不修改 ddl.js 与任何既有文件；
 *   - §10 audit_action 没有 start_review / close 动作：
 *     requested->reviewing 记 memory.m4_override_request（reason=submit_review），
 *     applied->closed 记 memory.m4_override_apply（reason=apply_audit_completed）；
 *   - review(decision=approve) 允许从 requested 一次性完成 submit_review + approve
 *     （API §14 的 review 是终态入口），但状态机校验仍严格按 M4_STATE。
 */

const {
  M4_STATE,
  AUDIT_ACTION,
  SENSITIVITY,
  LIFECYCLE_STATE,
  QUALITY_FLAG,
} = require('./constants');
const audit = require('./audit');
const lifecycle = require('./lifecycle');
const crypto = require('node:crypto');

const M4_SCHEMA_VERSION = 'm4_override.v4.1';

// §14 规则 4：approved 后 TTL=7d
const APPROVAL_TTL_DAYS = 7;
const DAY_MS = 86400000;

// §14 状态机（唯一事实源仍为 constants.M4_STATE）
const ALLOWED_TRANSITIONS = Object.freeze({
  [M4_STATE.REQUESTED]: Object.freeze([M4_STATE.REVIEWING, M4_STATE.REJECTED, M4_STATE.WITHDRAWN]),
  [M4_STATE.REVIEWING]: Object.freeze([M4_STATE.APPROVED, M4_STATE.REJECTED]),
  [M4_STATE.APPROVED]: Object.freeze([M4_STATE.APPLIED, M4_STATE.EXPIRED]),
  [M4_STATE.APPLIED]: Object.freeze([M4_STATE.CLOSED]),
  [M4_STATE.CLOSED]: Object.freeze([]),
  [M4_STATE.REJECTED]: Object.freeze([]),
  [M4_STATE.WITHDRAWN]: Object.freeze([]),
  [M4_STATE.EXPIRED]: Object.freeze([]),
});

// 允许执行 submit_review / review 的角色（§14 API 注释：admin/owner）
const REVIEW_ROLES = Object.freeze(['admin', 'owner']);
const REVIEW_ROLE_SET = new Set(REVIEW_ROLES);

// before/after 快照只允许 memory_item.v4.1 子集（§14 规则 6）
const SNAPSHOT_COLUMNS = Object.freeze([
  'mem_id',
  'layer',
  'scope',
  'type',
  'lifecycle_state',
  'quality_flag',
  'summary_short',
  'summary_long',
  'structured_json',
  'tags_json',
  'importance',
  'confidence',
  'valid_from',
  'valid_to',
  'superseded_by',
  'version',
  'sensitivity',
  'retention_policy',
  'affect_ext_json',
  'audit_ref',
]);

// apply 时可写回 memory_item 的列（禁止改主键/归属字段/证据字段）
const APPLYABLE_COLUMNS = Object.freeze([
  'lifecycle_state',
  'quality_flag',
  'quality_reasons_json',
  'summary_short',
  'summary_long',
  'structured_json',
  'tags_json',
  'importance',
  'confidence',
  'valid_to',
  'superseded_by',
  'sensitivity',
  'retention_policy',
  'affect_ext_json',
  'audit_ref',
  'version',
]);

const SNAPSHOT_COLUMN_SET = new Set(SNAPSHOT_COLUMNS);
const APPLYABLE_COLUMN_SET = new Set(APPLYABLE_COLUMNS);

// 辅助表 DDL（契约附录 A 未列，见文件头设计取舍）
const M4_TABLE_DDL = `CREATE TABLE IF NOT EXISTS m4_override (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  mem_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  auto_conflict INTEGER NOT NULL DEFAULT 0,
  before_json TEXT,
  after_json TEXT,
  conflict_refs_json TEXT,
  reviewer TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  comment TEXT,
  approved_at TEXT,
  applied_at TEXT,
  closed_at TEXT,
  withdrawn_at TEXT,
  expired_at TEXT,
  expires_at TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const M4_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_m4_state ON m4_override(user_id, state, expires_at)`;

const readyStores = new WeakSet();

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function generateId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${crypto.randomBytes(5).toString('hex')}`;
}

function safeAudit(store, params) {
  if (!store || typeof store.run !== 'function') return null;
  try {
    return audit.append(store, params);
  } catch {
    return null;
  }
}

function softNote(code, message, section) {
  return { code, level: 'soft', message, section };
}

function hardNote(code, message, section, extra = {}) {
  return { code, level: 'hard', message, section, ...extra };
}

function blocked(code, message, section, extra = {}) {
  return {
    ok: false,
    blocked: true,
    code,
    reason: message,
    section,
    soft: [],
    hard: [hardNote(code, message, section, extra)],
    ...extra,
  };
}

/** 惰性创建 m4_override 辅助表（幂等）。 */
function ensureTable(store) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('ensureTable: store 必须由 getStore() 返回');
  }
  if (readyStores.has(store)) return;
  store.run(M4_TABLE_DDL);
  store.run(M4_INDEX_DDL);
  readyStores.add(store);
}

function assertState(state) {
  if (!Object.values(M4_STATE).includes(state)) {
    throw contractError('INVALID_ENUM', `§19 非法 M4 override state: ${state}`);
  }
  return state;
}

function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// 快照与读取
// ---------------------------------------------------------------------------

function snapshotOf(row) {
  const snapshot = {};
  for (const column of SNAPSHOT_COLUMNS) {
    if (row[column] !== undefined) snapshot[column] = row[column];
  }
  return snapshot;
}

function sanitizeSnapshot(input) {
  if (!isPlainObject(input)) return {};
  const out = {};
  for (const key of Object.keys(input)) {
    if (SNAPSHOT_COLUMN_SET.has(key)) out[key] = input[key];
  }
  return out;
}

function rowToRequest(row) {
  return {
    schema_version: row.schema_version ?? M4_SCHEMA_VERSION,
    request_id: row.request_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    mem_id: row.mem_id,
    requested_by: row.requested_by,
    state: row.state,
    reason: row.reason,
    source: row.source ?? 'manual',
    auto_conflict: Boolean(row.auto_conflict),
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    conflict_refs: parseJson(row.conflict_refs_json, []),
    reviewer: row.reviewer ?? null,
    submitted_at: row.submitted_at ?? null,
    reviewed_at: row.reviewed_at ?? null,
    comment: row.comment ?? null,
    approved_at: row.approved_at ?? null,
    applied_at: row.applied_at ?? null,
    closed_at: row.closed_at ?? null,
    withdrawn_at: row.withdrawn_at ?? null,
    expired_at: row.expired_at ?? null,
    expires_at: row.expires_at ?? null,
    ttl_days: APPROVAL_TTL_DAYS,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readRequest(store, requestId) {
  return store.get('SELECT * FROM m4_override WHERE request_id = ?', String(requestId));
}

function readMemItem(store, memId) {
  return store.get('SELECT * FROM memory_item WHERE mem_id = ?', String(memId));
}

function sensitivityOf(row) {
  const level = row?.sensitivity;
  return Object.values(SENSITIVITY).includes(level) ? level : SENSITIVITY.S2;
}

// ---------------------------------------------------------------------------
// 过期（§14 规则 4）
// ---------------------------------------------------------------------------

function expireRow(store, row, now) {
  assertState(row.state);
  if (!canTransition(row.state, M4_STATE.EXPIRED)) {
    return null;
  }
  store.run(
    'UPDATE m4_override SET state = ?, expired_at = ?, updated_at = ? WHERE request_id = ?',
    M4_STATE.EXPIRED,
    now,
    now,
    row.request_id
  );
  const result = safeAudit(store, {
    user_id: row.user_id,
    agent_id: row.agent_id,
    action: AUDIT_ACTION.MEMORY_M4_OVERRIDE_EXPIRED,
    target_type: 'm4_override',
    target_id: row.request_id,
    before: { state: row.state, approved_at: row.approved_at, expires_at: row.expires_at },
    after: { state: M4_STATE.EXPIRED },
    reason: 'approved_ttl_7d_not_applied',
    actor: { type: 'system', id: 'm4_expire' },
    sensitivity: SENSITIVITY.S2,
    now,
  });
  return {
    ...rowToRequest({ ...row, state: M4_STATE.EXPIRED, expired_at: now, updated_at: now }),
    audit_ref: result?.audit_ref ?? null,
  };
}

/**
 * 扫描 approved 且 TTL=7d 未 apply 的请求 -> expired（§14 规则 4）。
 *
 * @param {object} store
 * @param {{now?:string, user_id?:string}} params
 * @returns {{ok:boolean, expired:Array, count:number, soft:Array, hard:Array}}
 */
function expire(store, params = {}) {
  ensureTable(store);
  const now = params.now ?? nowIso();
  if (toMs(now) === null) throw contractError('INVALID_PAYLOAD', 'expire: now 必须是可解析时间');
  const filters = [`state = ?`, 'expires_at IS NOT NULL', 'expires_at <= ?'];
  const values = [M4_STATE.APPROVED, now];
  if (params.user_id) {
    filters.push('user_id = ?');
    values.push(String(params.user_id));
  }
  const rows = store.all(`SELECT * FROM m4_override WHERE ${filters.join(' AND ')}`, ...values);
  const expired = [];
  for (const row of rows) {
    const result = expireRow(store, row, now);
    if (result) expired.push(result);
  }
  return {
    ok: true,
    expired,
    count: expired.length,
    soft: expired.length ? [] : [softNote('M4_NONE_EXPIRED', '没有 TTL 到期未 apply 的 approved 请求', '§14')],
    hard: [],
  };
}

function approveTtl(approvedAt) {
  const ms = toMs(approvedAt);
  return new Date(ms + APPROVAL_TTL_DAYS * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// 公开 API（§14）
// ---------------------------------------------------------------------------

/**
 * 创建 M4 override request（§14 API request）。绝不直接修改 memory_item。
 *
 * @param {object} store
 * @param {{mem_id:string, requested_by:string, reason:string, now?:string,
 *          conflict_refs?:Array, before?:object, after?:object,
 *          source?:'manual'|'auto_conflict', request_id?:string,
 *          user_id?:string, agent_id?:string}} params
 * @returns {object}
 */
function request(store, params = {}) {
  ensureTable(store);
  const memId = String(params.mem_id ?? '');
  const requestedBy = String(params.requested_by ?? '');
  const reason = params.reason === undefined || params.reason === null ? '' : String(params.reason);
  const now = params.now ?? nowIso();
  if (!memId) throw contractError('INVALID_PAYLOAD', 'request: mem_id 必填（§14）');
  if (!requestedBy) throw contractError('INVALID_PAYLOAD', 'request: requested_by 必填（§14）');
  if (!reason.trim()) throw contractError('INVALID_PAYLOAD', 'request: reason 必填（§14 规则 6 审计可追溯）');

  const item = readMemItem(store, memId);
  if (!item) {
    return blocked('MEM_NOT_FOUND', `memory_item ${memId} 不存在，无法发起 M4 override`, '§14', { mem_id: memId });
  }
  const userId = String(params.user_id ?? item.user_id ?? '');
  const agentId = String(params.agent_id ?? item.agent_id ?? store?.agentId ?? '');
  const source = params.source === 'auto_conflict' ? 'auto_conflict' : 'manual';
  const autoConflict = source === 'auto_conflict';
  const conflictRefs = Array.isArray(params.conflict_refs) ? params.conflict_refs.map(String) : [];

  const before = params.before ? sanitizeSnapshot(params.before) : snapshotOf(item);
  const after = params.after
    ? sanitizeSnapshot(params.after)
    : {
      lifecycle_state: LIFECYCLE_STATE.SUPERSEDED,
      superseded_by: params.superseded_by ?? (conflictRefs[0] ?? null),
      quality_flag: QUALITY_FLAG.NORMAL,
    };

  const requestId = String(params.request_id ?? generateId('m4'));
  store.run(
    `INSERT INTO m4_override
      (request_id, user_id, agent_id, mem_id, requested_by, state, reason, source,
       auto_conflict, before_json, after_json, conflict_refs_json, schema_version,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    requestId,
    userId,
    agentId || null,
    memId,
    requestedBy,
    M4_STATE.REQUESTED,
    reason,
    source,
    autoConflict ? 1 : 0,
    toJson(before),
    toJson(after),
    toJson(conflictRefs),
    M4_SCHEMA_VERSION,
    now,
    now
  );

  const auditResult = safeAudit(store, {
    user_id: userId,
    agent_id: agentId || null,
    action: AUDIT_ACTION.MEMORY_M4_OVERRIDE_REQUEST,
    target_type: 'm4_override',
    target_id: requestId,
    before: null,
    after: { state: M4_STATE.REQUESTED, mem_id: memId, source, conflict_refs: conflictRefs },
    reason,
    actor: { type: 'user', id: requestedBy },
    sensitivity: sensitivityOf(item),
    now,
  });

  const row = readRequest(store, requestId);
  const soft = [];
  const hard = [];
  const blockedInfo = autoConflict
    ? {
      code: 'M4_NO_AUTO_OVERRIDE',
      message: '§14 规则 1：M4 自动冲突只产生 override request，不自动覆盖',
      section: '§14/§23.1',
      request_id: requestId,
    }
    : null;
  if (autoConflict) {
    hard.push(hardNote(
      'M4_NO_AUTO_OVERRIDE',
      '§14 规则 1：自动冲突不得自动覆盖，仅生成待审批请求',
      '§14'
    ));
  } else {
    soft.push(softNote('M4_REQUEST_CREATED', 'override 请求已创建，等待 submit_review/review', '§14'));
  }

  return {
    ok: true,
    request: { ...rowToRequest(row), audit_ref: auditResult?.audit_ref ?? null },
    state: M4_STATE.REQUESTED,
    applied: false,
    blocked: blockedInfo,
    soft,
    hard,
  };
}

/** 自动冲突入口：只创建请求并显式返回 blocked 原因（§14 规则 1）。 */
function autoConflict(store, params = {}) {
  return request(store, { ...params, source: 'auto_conflict' });
}

/**
 * requested -> reviewing（§14 API submit_review）。
 *
 * @param {object} store
 * @param {{request_id:string, reviewer:string, role?:string, now?:string}} params
 * @returns {object}
 */
function submitReview(store, params = {}) {
  ensureTable(store);
  const requestId = String(params.request_id ?? '');
  const reviewer = String(params.reviewer ?? '');
  const now = params.now ?? nowIso();
  if (!requestId) throw contractError('INVALID_PAYLOAD', 'submitReview: request_id 必填（§14）');
  if (!reviewer) throw contractError('INVALID_PAYLOAD', 'submitReview: reviewer 必填（§14）');
  if (params.role !== undefined && !REVIEW_ROLE_SET.has(String(params.role))) {
    return blocked('M4_REVIEWER_NOT_ALLOWED', `reviewer role=${params.role} 无权限（§14：admin/owner）`, '§14', { request_id: requestId });
  }

  const row = readRequest(store, requestId);
  if (!row) return blocked('M4_NOT_FOUND', `m4_override ${requestId} 不存在`, '§14', { request_id: requestId });
  if (!canTransition(row.state, M4_STATE.REVIEWING)) {
    return blocked(
      'M4_INVALID_TRANSITION',
      `§14 状态机不允许 ${row.state} -> reviewing`,
      '§14',
      { request_id: requestId, state: row.state }
    );
  }

  store.run(
    'UPDATE m4_override SET state = ?, reviewer = ?, submitted_at = ?, updated_at = ? WHERE request_id = ?',
    M4_STATE.REVIEWING,
    reviewer,
    now,
    now,
    requestId
  );

  // §10 没有 start_review 动作：以 request 动作 + reason 标记（见文件头取舍）
  const auditResult = safeAudit(store, {
    user_id: row.user_id,
    agent_id: row.agent_id,
    action: AUDIT_ACTION.MEMORY_M4_OVERRIDE_REQUEST,
    target_type: 'm4_override',
    target_id: requestId,
    before: { state: row.state },
    after: { state: M4_STATE.REVIEWING, reviewer },
    reason: 'submit_review',
    actor: { type: 'user', id: reviewer },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  return {
    ok: true,
    request: { ...rowToRequest(readRequest(store, requestId)), audit_ref: auditResult?.audit_ref ?? null },
    state: M4_STATE.REVIEWING,
    soft: [softNote('M4_IN_REVIEW', '已进入 reviewing，等待 approve/reject', '§14')],
    hard: [],
  };
}

/**
 * 审批（§14 API review）。decision: approve | reject | withdraw。
 *
 * @param {object} store
 * @param {{request_id:string, reviewer:string, decision:string, comment?:string,
 *          reason?:string, role?:string, now?:string}} params
 * @returns {object}
 */
function review(store, params = {}) {
  ensureTable(store);
  const requestId = String(params.request_id ?? '');
  const reviewer = String(params.reviewer ?? '');
  const now = params.now ?? nowIso();
  const decision = String(params.decision ?? '').toLowerCase();
  if (!requestId) throw contractError('INVALID_PAYLOAD', 'review: request_id 必填（§14）');
  if (!reviewer) throw contractError('INVALID_PAYLOAD', 'review: reviewer 必填（§14）');

  if (decision === 'withdraw') {
    return withdraw(store, {
      request_id: requestId,
      actor: reviewer,
      reason: params.reason ?? params.comment,
      now,
    });
  }

  const targetState = decision === 'approve' || decision === 'approved'
    ? M4_STATE.APPROVED
    : (decision === 'reject' || decision === 'rejected' ? M4_STATE.REJECTED : null);
  if (!targetState) {
    throw contractError('INVALID_ENUM', `review: decision=${params.decision} 非法（approve|reject|withdraw）`);
  }
  if (params.role !== undefined && !REVIEW_ROLE_SET.has(String(params.role))) {
    return blocked('M4_REVIEWER_NOT_ALLOWED', `reviewer role=${params.role} 无权限（§14：admin/owner）`, '§14', { request_id: requestId });
  }

  const row = readRequest(store, requestId);
  if (!row) return blocked('M4_NOT_FOUND', `m4_override ${requestId} 不存在`, '§14', { request_id: requestId });

  // approve 允许从 requested 一次性 submit_review + approve（§14 API review 为终态入口）；
  // reject 按契约允许 requested -> rejected 与 reviewing -> rejected。
  if (targetState === M4_STATE.APPROVED) {
    if (row.state !== M4_STATE.REQUESTED && row.state !== M4_STATE.REVIEWING) {
      return blocked('M4_INVALID_TRANSITION', `§14 状态机不允许 ${row.state} -> approved`, '§14', { request_id: requestId, state: row.state });
    }
  } else if (!canTransition(row.state, M4_STATE.REJECTED)) {
    return blocked('M4_INVALID_TRANSITION', `§14 状态机不允许 ${row.state} -> rejected`, '§14', { request_id: requestId, state: row.state });
  }

  const comment = params.comment ?? params.reason ?? null;
  const approvedAt = targetState === M4_STATE.APPROVED ? now : null;
  const expiresAt = approvedAt ? approveTtl(approvedAt) : null;

  store.run(
    `UPDATE m4_override
        SET state = ?, reviewer = ?, submitted_at = COALESCE(submitted_at, ?),
            reviewed_at = ?, comment = ?, approved_at = ?, expires_at = ?, updated_at = ?
      WHERE request_id = ?`,
    targetState,
    reviewer,
    now,
    now,
    comment === null ? null : String(comment),
    approvedAt,
    expiresAt,
    now,
    requestId
  );

  const auditResult = safeAudit(store, {
    user_id: row.user_id,
    agent_id: row.agent_id,
    action: targetState === M4_STATE.APPROVED
      ? AUDIT_ACTION.MEMORY_M4_OVERRIDE_APPROVE
      : AUDIT_ACTION.MEMORY_M4_OVERRIDE_REJECT,
    target_type: 'm4_override',
    target_id: requestId,
    before: { state: row.state },
    after: { state: targetState, reviewer, expires_at: expiresAt, comment },
    reason: comment ?? (targetState === M4_STATE.APPROVED ? 'approved' : 'rejected'),
    actor: { type: 'user', id: reviewer },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  const soft = [];
  if (targetState === M4_STATE.APPROVED) {
    soft.push(softNote('M4_APPROVED_TTL', `approved 后 ${APPROVAL_TTL_DAYS} 日内未 apply 将自动 expired（§14 规则 4）`, '§14'));
  } else {
    soft.push(softNote('M4_REJECTED_TERMINAL', 'rejected 为终态，需重新发起 request', '§14'));
  }

  return {
    ok: true,
    request: { ...rowToRequest(readRequest(store, requestId)), audit_ref: auditResult?.audit_ref ?? null },
    state: targetState,
    soft,
    hard: [],
  };
}

/**
 * 撤回（§14 API withdraw）：仅 requested_by 本人、仅 requested 状态、必须 reason。
 *
 * @param {object} store
 * @param {{request_id:string, actor:string, reason?:string, now?:string}} params
 * @returns {object}
 */
function withdraw(store, params = {}) {
  ensureTable(store);
  const requestId = String(params.request_id ?? '');
  const actor = String(params.actor ?? '');
  const reason = params.reason === undefined || params.reason === null ? '' : String(params.reason);
  const now = params.now ?? nowIso();
  if (!requestId) throw contractError('INVALID_PAYLOAD', 'withdraw: request_id 必填（§14）');
  if (!actor) throw contractError('INVALID_PAYLOAD', 'withdraw: actor 必填（§14）');

  const row = readRequest(store, requestId);
  if (!row) return blocked('M4_NOT_FOUND', `m4_override ${requestId} 不存在`, '§14', { request_id: requestId });
  if (actor !== row.requested_by) {
    return blocked(
      'M4_WITHDRAW_NOT_OWNER',
      '§14 规则 2：仅 requested_by 可 withdraw；admin 请走 reject',
      '§14',
      { request_id: requestId, requested_by: row.requested_by, actor }
    );
  }
  if (row.state !== M4_STATE.REQUESTED) {
    return blocked(
      'M4_WITHDRAW_INVALID_STATE',
      `§14 规则 3：仅 requested 可 withdraw，当前 ${row.state}`,
      '§14',
      { request_id: requestId, state: row.state }
    );
  }
  if (!reason.trim()) {
    return blocked('M4_WITHDRAW_REASON_REQUIRED', '§14 规则 3：withdraw 必须提供 reason', '§14', { request_id: requestId });
  }

  store.run(
    'UPDATE m4_override SET state = ?, withdrawn_at = ?, comment = ?, updated_at = ? WHERE request_id = ?',
    M4_STATE.WITHDRAWN,
    now,
    reason,
    now,
    requestId
  );
  const auditResult = safeAudit(store, {
    user_id: row.user_id,
    agent_id: row.agent_id,
    action: AUDIT_ACTION.MEMORY_M4_OVERRIDE_WITHDRAW,
    target_type: 'm4_override',
    target_id: requestId,
    before: { state: row.state },
    after: { state: M4_STATE.WITHDRAWN },
    reason,
    actor: { type: 'user', id: actor },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  return {
    ok: true,
    request: { ...rowToRequest(readRequest(store, requestId)), audit_ref: auditResult?.audit_ref ?? null },
    state: M4_STATE.WITHDRAWN,
    soft: [softNote('M4_WITHDRAWN', '请求已撤回（终态）', '§14')],
    hard: [],
  };
}

function applySnapshotToItem(store, item, after) {
  const fields = [];
  const values = [];
  for (const column of Object.keys(after)) {
    if (!APPLYABLE_COLUMN_SET.has(column)) continue;
    fields.push(`${column} = ?`);
    values.push(after[column] === undefined ? null : after[column]);
  }
  if (!fields.length) return false;
  values.push(item.mem_id);
  store.run(`UPDATE memory_item SET ${fields.join(', ')} WHERE mem_id = ?`, ...values);
  return true;
}

/**
 * 生效（§14 API apply）：approved -> applied -> closed。
 *
 * @param {object} store
 * @param {{request_id:string, now?:string, actor?:object}} params
 * @returns {object}
 */
function apply(store, params = {}) {
  ensureTable(store);
  const requestId = String(params.request_id ?? '');
  const now = params.now ?? nowIso();
  if (!requestId) throw contractError('INVALID_PAYLOAD', 'apply: request_id 必填（§14）');

  let row = readRequest(store, requestId);
  if (!row) return blocked('M4_NOT_FOUND', `m4_override ${requestId} 不存在`, '§14', { request_id: requestId });

  // approved TTL 到期：先自动 expired，再拒绝本次 apply（§14 规则 4）
  if (row.state === M4_STATE.APPROVED) {
    const expiresMs = toMs(row.expires_at);
    const nowMs = toMs(now);
    if (expiresMs !== null && nowMs !== null && expiresMs <= nowMs) {
      const expired = expireRow(store, row, now);
      return {
        ...blocked(
          'M4_APPROVAL_EXPIRED',
          `§14 规则 4：approved 后 ${APPROVAL_TTL_DAYS} 日未 apply，已自动 expired`,
          '§14',
          { request_id: requestId, request: expired }
        ),
        state: M4_STATE.EXPIRED,
      };
    }
  }

  if (!canTransition(row.state, M4_STATE.APPLIED)) {
    return blocked(
      'M4_INVALID_TRANSITION',
      `§14 状态机不允许 ${row.state} -> applied（仅 approved 可 apply）`,
      '§14',
      { request_id: requestId, state: row.state }
    );
  }

  const item = readMemItem(store, row.mem_id);
  if (!item) {
    return blocked('MEM_NOT_FOUND', `memory_item ${row.mem_id} 不存在，无法 apply`, '§14', { request_id: requestId });
  }

  const after = parseJson(row.after_json, {});
  const targetLifecycle = after.lifecycle_state;
  if (targetLifecycle !== undefined && targetLifecycle !== null) {
    const check = lifecycle.transition(
      { ...item, lifecycle_state: item.lifecycle_state },
      targetLifecycle,
      { now, reason: 'm4_override', m4_approved: true }
    );
    if (!check.ok) {
      return blocked(check.code ?? 'M4_APPLY_ILLEGAL_LIFECYCLE', check.message, '§22.1/§23.1', { request_id: requestId });
    }
  }

  // approved -> applied（§14 规则 5）
  store.run(
    'UPDATE m4_override SET state = ?, applied_at = ?, updated_at = ? WHERE request_id = ?',
    M4_STATE.APPLIED,
    now,
    now,
    requestId
  );
  const appliedAudit = safeAudit(store, {
    user_id: row.user_id,
    agent_id: row.agent_id,
    action: AUDIT_ACTION.MEMORY_M4_OVERRIDE_APPLY,
    target_type: 'm4_override',
    target_id: requestId,
    before: { state: row.state },
    after: { state: M4_STATE.APPLIED, mem_id: row.mem_id, after },
    reason: 'apply_override',
    actor: params.actor ?? { type: 'user', id: row.reviewer ?? row.requested_by },
    sensitivity: sensitivityOf(item),
    now,
  });

  const updated = applySnapshotToItem(store, item, after);

  // applied 完成审计后 -> closed（§14 规则 5）
  store.run(
    'UPDATE m4_override SET state = ?, closed_at = ?, updated_at = ? WHERE request_id = ?',
    M4_STATE.CLOSED,
    now,
    now,
    requestId
  );
  const closedAudit = safeAudit(store, {
    user_id: row.user_id,
    agent_id: row.agent_id,
    action: AUDIT_ACTION.MEMORY_M4_OVERRIDE_APPLY,
    target_type: 'm4_override',
    target_id: requestId,
    before: { state: M4_STATE.APPLIED },
    after: { state: M4_STATE.CLOSED, applied_at: now },
    // §10 没有 m4_override_close 动作，沿用 apply 并在 reason 标记
    reason: 'apply_audit_completed',
    actor: params.actor ?? { type: 'user', id: row.reviewer ?? row.requested_by },
    sensitivity: sensitivityOf(item),
    now,
  });

  row = readRequest(store, requestId);
  return {
    ok: true,
    request: {
      ...rowToRequest(row),
      audit_ref: closedAudit?.audit_ref ?? appliedAudit?.audit_ref ?? null,
    },
    state: M4_STATE.CLOSED,
    applied: true,
    memory_item_updated: updated,
    audit_refs: [appliedAudit?.audit_ref ?? null, closedAudit?.audit_ref ?? null].filter(Boolean),
    soft: [softNote('M4_APPLIED_CLOSED', '§14 规则 5：applied 完成审计后进入 closed', '§14')],
    hard: [],
  };
}

/**
 * 读取审批请求（§14 API GET）。
 * approved 且已超过 7d TTL 时自动转 expired（规则 4）。
 *
 * @param {object} store
 * @param {{request_id:string, now?:string, auto_expire?:boolean}} params
 * @returns {object}
 */
function get(store, params = {}) {
  ensureTable(store);
  const requestId = String(params.request_id ?? '');
  const now = params.now ?? nowIso();
  if (!requestId) throw contractError('INVALID_PAYLOAD', 'get: request_id 必填（§14）');

  let row = readRequest(store, requestId);
  if (!row) return blocked('M4_NOT_FOUND', `m4_override ${requestId} 不存在`, '§14', { request_id: requestId });

  const autoExpire = params.auto_expire !== false;
  if (autoExpire && row.state === M4_STATE.APPROVED) {
    const expiresMs = toMs(row.expires_at);
    const nowMs = toMs(now);
    if (expiresMs !== null && nowMs !== null && expiresMs <= nowMs) {
      expireRow(store, row, now);
      row = readRequest(store, requestId);
    }
  }

  return {
    ok: true,
    request: rowToRequest(row),
    state: row.state,
    soft: [],
    hard: [],
  };
}

module.exports = {
  M4_SCHEMA_VERSION,
  APPROVAL_TTL_DAYS,
  ALLOWED_TRANSITIONS,
  REVIEW_ROLES,
  SNAPSHOT_COLUMNS,
  APPLYABLE_COLUMNS,
  ensureTable,
  request,
  autoConflict,
  submitReview,
  review,
  withdraw,
  apply,
  expire,
  get,
  canTransition,
};
