'use strict';

/**
 * 治理层 · 审计（只追加 / WORM 链 / 脱敏 / 审计壳）
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §10    audit_action.v4.1 完整枚举；审计壳字段；before/after 脱敏；
 *   - §17.3  AuditEvent（字段映射到 memory_audit_log）；
 *   - §21.3  只追加、哈希链/WORM、默认 180 天 / 敏感 365 天保留；
 *   - §9.2   step5 audit_shell_done（不含原文）、step7 audit_done。
 *
 * 设计取舍（契约未在附录 A 单列审计链表，本文件只写既有 memory_audit_log）：
 *   - 每条事件在 created_at 排序 + rowid 次序上形成哈希链；
 *   - 由于 node:sqlite 为同步 API，单进程内 append 的“读上一条 hash + 插入”天然串行；
 *     多进程并发写同一库时仍需外部锁（契约只要求“建议哈希链或 WORM”）。
 */

const crypto = require('node:crypto');
const {
  AUDIT_ACTION,
  SENSITIVITY,
  AUDIT_RETENTION_DAYS,
} = require('./constants');

// §17.3 AuditEvent.schema_version
const AUDIT_SCHEMA_VERSION = 'audit_event.v4.1';
// 哈希链前缀：首条事件的前驱
const GENESIS_HASH = 'GENESIS';
const HASH_PREFIX = 'sha256:';

const ACTION_LIST = Object.freeze(Object.values(AUDIT_ACTION));
const ACTION_SET = new Set(ACTION_LIST);
const SENSITIVITY_SET = new Set(Object.values(SENSITIVITY));

// 脱敏哈希前缀（与 §8 的 sha256: 口径保持一致）
const REDACT_PREFIX = 'sha256:';
// S2 下超过该长度的字符串也视为原文（避免摘要/长字段漏网）
const MAX_PLAIN_STRING = 64;

// 常见原文型字段：S2/S3 一律只保留 hash（§10 “只保留 hash 或枚举”）
const SENSITIVE_KEYS = new Set([
  'raw_text',
  'text_excerpt',
  'summary_short',
  'summary_long',
  'summary',
  'caption',
  'visual_desc',
  'asr_text',
  'ocr_text',
  'transcript',
  'payload',
  'content',
  'body',
  'text',
  'source_text',
  'description',
  'query',
  'normalized_query',
  'structured',
  'tags',
  'entities',
  'relations',
  'emotion',
  'key_points',
  'speakers',
  'topics',
  'key_entities',
  'outline_refs',
  'seg_refs',
  'raw_text_ref',
  'media_ref',
  'frame_ref',
  'asr_ref',
  'ocr_ref',
  'file_name',
  'subject',
  'value',
]);

// S3 仍允许保留的枚举/标识型字段（§10 允许“hash 或枚举”）
const S3_ALLOWED_KEYS = new Set([
  'event_id',
  'object_id',
  'object_type',
  'target_id',
  'target_type',
  'action',
  'status',
  'state',
  'step_id',
  'lifecycle_state',
  'quality_flag',
  'sensitivity',
  'sensitivity_max',
  'layer',
  'type',
  'scope',
  'role',
  'relation',
  'from_type',
  'to_type',
  'from_id',
  'to_id',
  'mem_id',
  'span_id',
  'user_id',
  'tenant_id',
  'org_id',
  'agent_id',
  'owner_user_id',
  'request_id',
  'job_id',
  'audit_ref',
  'reason',
  'timestamp',
  'created_at',
  'updated_at',
  'valid_from',
  'valid_to',
  'expires_at',
  'hash',
  'prev_hash',
  'retention_policy',
  'error_code',
]);

// S3 下仍可保留的枚举字符串（避免把状态值也哈希掉）
const ENUM_STRINGS = new Set([
  ...Object.values(AUDIT_ACTION),
  'active',
  'cold_archived',
  'superseded',
  'deleted_pending',
  'deleted_tombstone',
  'normal',
  'needs_review',
  'degraded',
  'pending',
  'ref_releasing',
  'cascading',
  'content_deleted_audit_retained',
  'completed',
  'retrying',
  'failed_manual',
  'done',
  'failed',
  'S0',
  'S1',
  'S2',
  'S3',
  'M1',
  'M2',
  'M3',
  'M4',
  'session',
  'user',
  'org',
  'global',
]);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/** 稳定 JSON 序列化：对象键字典序，保证同一内容哈希可复现。 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function redactMarker(value) {
  const serialized = stableStringify(value);
  const marker = {
    redacted: true,
    hash: `${REDACT_PREFIX}${sha256Hex(serialized)}`,
  };
  if (typeof value === 'string') marker.length = value.length;
  return marker;
}

function normalizeSensitivity(value, fallback = SENSITIVITY.S2) {
  if (value === null || value === undefined || value === '') return fallback;
  if (SENSITIVITY_SET.has(value)) return value;
  throw contractError('INVALID_ENUM', `§21.1 非法敏感分级: ${value}`);
}

function sensitivityRank(level) {
  return ['S0', 'S1', 'S2', 'S3'].indexOf(level);
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function generateEventId(now) {
  const stamp = String(now).replace(/[-:.TZ]/g, '').slice(0, 14);
  return `aud_${stamp}_${crypto.randomBytes(6).toString('hex')}`;
}

function truncate(value, max) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : stableStringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 脱敏（§10：S2/S3 的 before/after 只保留 hash 或枚举）
// ---------------------------------------------------------------------------

/**
 * 递归脱敏。
 * @param {*} input 任意 before/after 载荷
 * @param {string} sensitivity S0/S1 原样返回；S2 敏感字段与长文本哈希；
 *                             S3 仅保留枚举/标识/数字，其余全部哈希
 */
function redact(input, sensitivity = SENSITIVITY.S2) {
  const level = normalizeSensitivity(sensitivity);
  if (sensitivityRank(level) <= sensitivityRank(SENSITIVITY.S1)) {
    return clone(input);
  }
  return redactNode(input, level, null);
}

function redactNode(node, level, key) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map((entry) => redactNode(entry, level, key));
  if (isPlainObject(node)) {
    const out = {};
    for (const childKey of Object.keys(node)) {
      const normalizedKey = childKey.toLowerCase();
      if (level === SENSITIVITY.S3 && !S3_ALLOWED_KEYS.has(normalizedKey)) {
        out[childKey] = redactMarker(node[childKey]);
        continue;
      }
      if (SENSITIVE_KEYS.has(normalizedKey)) {
        out[childKey] = redactMarker(node[childKey]);
        continue;
      }
      out[childKey] = redactNode(node[childKey], level, normalizedKey);
    }
    return out;
  }
  if (typeof node === 'string') {
    // 已经是 sha256 摘要的值继续保留（否则审计壳 hash 会被二次哈希）
    if (/^sha256:[0-9a-f]{64}$/.test(node)) return node;
    if (level === SENSITIVITY.S3) {
      // 白名单键（id/枚举/状态）保留；其余字符串一律按原文处理
      if (key && S3_ALLOWED_KEYS.has(key)) return node;
      if (ENUM_STRINGS.has(node)) return node;
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(node)) return node; // ISO 时间保留
      return redactMarker(node);
    }
    // S2：长文本视为原文，短标识/枚举保留
    if (node.length > MAX_PLAIN_STRING) return redactMarker(node);
    return node;
  }
  return node;
}

/**
 * 审计壳：§10 / §21.3 只允许 event_id / object_id / action / timestamp / reason / hash。
 * 显式白名单构造，调用方传入的其余字段（含原文）一律丢弃。
 */
function buildShell(event = {}) {
  return {
    event_id: event.event_id ?? event.eventId ?? null,
    object_id: event.object_id ?? event.objectId ?? event.target_id ?? null,
    action: event.action ?? null,
    timestamp: event.timestamp ?? event.created_at ?? null,
    reason: truncate(event.reason ?? event.purpose ?? null, 200),
    hash: event.hash ?? null,
  };
}

// ---------------------------------------------------------------------------
// 哈希链
// ---------------------------------------------------------------------------

function computeEventHash(row, prevHash) {
  const payload = {
    event_id: row.event_id ?? null,
    user_id: row.user_id ?? null,
    agent_id: row.agent_id ?? null,
    action: row.action ?? null,
    object_type: row.object_type ?? null,
    object_id: row.object_id ?? null,
    request_id: row.request_id ?? null,
    before_json: row.before_json ?? null,
    after_json: row.after_json ?? null,
    reason: row.reason ?? null,
    sensitivity: row.sensitivity ?? null,
    created_at: row.created_at ?? null,
  };
  return `${HASH_PREFIX}${sha256Hex(`audit_chain_v1|${prevHash}|${stableStringify(payload)}`)}`;
}

function previousHash(store, userId) {
  const row = store.get(
    `SELECT hash FROM memory_audit_log
      WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
    userId
  );
  return row?.hash ?? GENESIS_HASH;
}

// ---------------------------------------------------------------------------
// 只追加 guard
// ---------------------------------------------------------------------------

/**
 * §10/§21.3 只追加 guard：禁止对 memory_audit_log 发 UPDATE/DELETE。
 * 审计模块自身也只提供 append，不提供任何修改入口。
 */
function guard(sql) {
  const text = String(sql ?? '').toUpperCase();
  if (!text.includes('MEMORY_AUDIT_LOG')) return true;
  if (/(^|[^A-Z_])(UPDATE|DELETE|DROP|ALTER|TRUNCATE)([^A-Z_]|$)/.test(text)) {
    throw contractError(
      'AUDIT_APPEND_ONLY_VIOLATION',
      '§10/§21.3 memory_audit_log 只追加，禁止 UPDATE/DELETE/DROP/ALTER'
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 追加一条审计事件（§10 / §17.3）。
 *
 * 兼容 write.js 的驼峰入参（userId/agentId/objectType/objectId/requestId）与
 * 治理层的契约入参（user_id/agent_id/target_type/target_id）。
 *
 * @param {object} store getStore() 返回的 store
 * @param {object} params 审计事件
 * @returns {{ok:true,event_id:string,audit_ref:string,hash:string,created_at:string}}
 */
function append(store, params = {}) {
  if (!store || typeof store.run !== 'function') {
    throw contractError('INVALID_PAYLOAD', 'append: store 必须由 getStore() 返回');
  }

  const userId = params.user_id ?? params.userId;
  if (!userId) throw contractError('INVALID_PAYLOAD', '§3.1 user_id 必填');

  const agentId = params.agent_id ?? params.agentId ?? null;
  const action = params.action;
  if (!ACTION_SET.has(action)) {
    throw contractError('INVALID_ENUM', `§10 非法 audit_action: ${action}`);
  }

  const objectType = params.target_type ?? params.object_type ?? params.objectType;
  const objectId = params.target_id ?? params.object_id ?? params.objectId;
  if (!objectType) throw contractError('INVALID_PAYLOAD', 'object_type/target_type 必填');
  if (objectId === undefined || objectId === null || objectId === '') {
    throw contractError('INVALID_PAYLOAD', 'object_id/target_id 必填');
  }

  const createdAt = params.now ?? params.created_at ?? nowIso();
  const sensitivity = normalizeSensitivity(
    params.sensitivity,
    SENSITIVITY.S2 // 未声明时按 S2 处理，宁可多脱敏
  );

  // §10：before/after 必须脱敏；S2/S3 只保留 hash 或枚举
  const before = params.before === undefined ? null : redact(params.before, sensitivity);
  const after = params.after === undefined ? null : redact(params.after, sensitivity);
  const beforeJson = before === null ? null : stableStringify(before);
  const afterJson = after === null ? null : stableStringify(after);

  const actor = isPlainObject(params.actor)
    ? clone(params.actor)
    : { type: 'agent', id: String(agentId ?? 'agent') };

  // DDL 无 purpose 列：purpose 属于 ABAC 属性，写入 reason（§17.3 只定义 reason）
  const reason = params.reason ?? params.purpose ?? null;
  const requestId = params.request_id ?? params.requestId ?? null;
  const ipHash = params.ip_hash ?? null;

  const eventId = params.event_id ?? generateEventId(createdAt);
  const prevHash = previousHash(store, userId);

  const row = {
    event_id: eventId,
    user_id: userId,
    agent_id: agentId,
    action,
    object_type: String(objectType),
    object_id: String(objectId),
    request_id: requestId,
    before_json: beforeJson,
    after_json: afterJson,
    reason: reason === null ? null : String(reason),
    sensitivity,
    created_at: createdAt,
  };
  const hash = computeEventHash(row, prevHash);

  guard('INSERT INTO memory_audit_log');
  store.run(
    `INSERT INTO memory_audit_log
      (event_id, user_id, agent_id, actor_json, action, object_type, object_id,
       request_id, before_json, after_json, reason, sensitivity, ip_hash, hash,
       immutable, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    eventId,
    String(userId),
    agentId === null ? null : String(agentId),
    stableStringify(actor),
    action,
    String(objectType),
    String(objectId),
    requestId,
    beforeJson,
    afterJson,
    reason === null ? null : String(reason),
    sensitivity,
    ipHash,
    hash,
    AUDIT_SCHEMA_VERSION,
    createdAt
  );

  return {
    ok: true,
    event_id: eventId,
    audit_ref: eventId,
    hash,
    created_at: createdAt,
    schema_version: AUDIT_SCHEMA_VERSION,
  };
}

/** 读取某用户全部审计事件（升序），供哈希链校验。 */
function readUserChain(store, userId) {
  return store.all(
    `SELECT rowid AS _rowid, event_id, user_id, agent_id, action, object_type, object_id,
            request_id, before_json, after_json, reason, sensitivity, hash, created_at
       FROM memory_audit_log
      WHERE user_id = ?
      ORDER BY created_at ASC, rowid ASC`,
    userId
  );
}

function buildChain(rows) {
  const chain = [];
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const expected = computeEventHash(row, prev);
    chain.push({
      row,
      prev_hash: prev,
      expected_hash: expected,
      hash_valid: Boolean(row.hash) && row.hash === expected,
    });
    prev = row.hash ?? expected;
  }
  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index];
    const next = chain[index + 1];
    current.next_hash = next ? next.row.hash ?? null : null;
    // 下一条的 hash 是基于当前条目的 stored hash 计算的：
    // 当前条目被篡改时，下一条的重算必然失败。
    current.next_link_valid = next ? next.hash_valid : true;
  }
  return chain;
}

/**
 * 审计链校验（§21.3）。
 * @returns {{ok:boolean, broken_at:string|null, count:number}}
 */
function verifyChain(store, { user_id } = {}) {
  if (!user_id) throw contractError('INVALID_PAYLOAD', 'verifyChain: user_id 必填');
  const rows = readUserChain(store, user_id);
  const chain = buildChain(rows);
  const broken = chain.find((entry) => !entry.hash_valid);
  return {
    ok: !broken,
    broken_at: broken ? broken.row.event_id : null,
    count: chain.length,
  };
}

/**
 * 按时间倒序返回目标对象的审计链，并给出每条 hash 的前后链接校验结果。
 *
 * @param {object} store
 * @param {{target_id:string, user_id:string, limit?:number, now?:string}} params
 */
function trace(store, { target_id, user_id, limit, now } = {}) {
  if (!target_id) throw contractError('INVALID_PAYLOAD', 'trace: target_id 必填');
  if (!user_id) throw contractError('INVALID_PAYLOAD', 'trace: user_id 必填');

  // 全链用于计算前后链接；目标子集只做展示。
  const chain = buildChain(readUserChain(store, user_id));
  const selected = chain
    .filter((entry) => entry.row.object_id === String(target_id))
    .slice()
    .reverse();

  const max = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), selected.length)
    : selected.length;
  const events = selected.slice(0, max).map((entry) => ({
    event_id: entry.row.event_id,
    action: entry.row.action,
    object_type: entry.row.object_type,
    object_id: entry.row.object_id,
    created_at: entry.row.created_at,
    hash: entry.row.hash,
    prev_hash: entry.prev_hash,
    next_hash: entry.next_hash,
    hash_valid: entry.hash_valid,
    prev_link_valid: entry.hash_valid,
    next_link_valid: entry.next_link_valid,
  }));

  return {
    ok: events.every((event) => event.hash_valid && event.next_link_valid),
    target_id,
    count: events.length,
    now: now ?? null,
    events,
  };
}

/**
 * §21.3 审计保留期统计：默认 180 天，敏感事件（S2/S3）365 天。
 * memory_audit_log 是只追加/WORM，不能在此删除；这里只给出到期数量与截止时间，
 * 由导出/归档管线按合规策略处理（契约未定义审计清理接口）。
 */
function retentionReport(store, {
  now = nowIso(),
  default_days = AUDIT_RETENTION_DAYS.DEFAULT,
  sensitive_days = AUDIT_RETENTION_DAYS.SENSITIVE,
} = {}) {
  const base = new Date(now).getTime();
  const defaultCutoff = new Date(base - default_days * 86400000).toISOString();
  const sensitiveCutoff = new Date(base - sensitive_days * 86400000).toISOString();

  const defaultDue = Number(store.get(
    `SELECT COUNT(*) AS n FROM memory_audit_log
      WHERE created_at < ? AND (sensitivity IS NULL OR sensitivity IN ('S0','S1'))`,
    defaultCutoff
  )?.n ?? 0);
  const sensitiveDue = Number(store.get(
    `SELECT COUNT(*) AS n FROM memory_audit_log
      WHERE created_at < ? AND sensitivity IN ('S2','S3')`,
    sensitiveCutoff
  )?.n ?? 0);

  return {
    now,
    default_days,
    sensitive_days,
    default_cutoff: defaultCutoff,
    sensitive_cutoff: sensitiveCutoff,
    default_due: defaultDue,
    sensitive_due: sensitiveDue,
  };
}

/** §10 audit_action.v4.1 完整枚举。 */
function listActions() {
  return ACTION_LIST;
}

module.exports = {
  AUDIT_SCHEMA_VERSION,
  GENESIS_HASH,
  append,
  trace,
  verifyChain,
  retentionReport,
  listActions,
  redact,
  buildShell,
  guard,
  // 供自检使用
  computeEventHash,
  stableStringify,
};
