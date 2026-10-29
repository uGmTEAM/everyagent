'use strict';

/**
 * 前瞻层 · 前瞻记忆创建 / 到期与条件命中 / 过期
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §17.7  ProspectiveItem（type / payload / trigger_condition / target_entity /
 *            status / evidence_refs）；
 *   - §15.2  前瞻记忆过期：status=pending 且 due_time + grace_seconds(86400) < now
 *            -> expired；event 触发：event_type + entity_key 命中 -> triggered；
 *   - §10    prospective.trigger / prospective.done / prospective.cancel / prospective.expired；
 *   - 附录 B idx_user_status_due(user_id,status,due_time)。
 *
 * 设计取舍：
 *   - due() 只返回 pending 并原子置为 triggered，避免同一条件重复注入；
 *   - expire() 严格按 §15.2 的 grace_seconds 处理 pending；
 *     lifecycle.sweep 里另有一条「pending/triggered 且 due_time<now 直接过期」的旧逻辑，
 *     两者口径不同，见交付说明的契约歧义列表；
 *   - 未提供 evidence_refs 时以自引用占位，并给出 soft 标记，避免伪造真实 span。
 */

const {
  AUDIT_ACTION,
  SENSITIVITY,
} = require('./constants');
const audit = require('./audit');
const crypto = require('node:crypto');

const PROSPECTIVE_SCHEMA_VERSION = 'prospective_item.v4.1';

// §17.7 枚举（与 schema.js 保持一致，不新增第二套事实源）
const PROSPECTIVE_TYPE = Object.freeze(['todo', 'reminder', 'promise', 'follow_up']);
const TRIGGER_TYPE = Object.freeze(['entity', 'time', 'event', 'entity_or_time']);
const STATUS = Object.freeze(['pending', 'triggered', 'done', 'cancelled', 'expired']);

const PROSPECTIVE_TYPE_SET = new Set(PROSPECTIVE_TYPE);
const TRIGGER_TYPE_SET = new Set(TRIGGER_TYPE);
const STATUS_SET = new Set(STATUS);

// §15.2 grace_seconds 默认 86400
const DEFAULT_GRACE_SECONDS = 86400;

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

function generateId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${crypto.randomBytes(5).toString('hex')}`;
}

function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * 归一化 trigger_condition 与 due_time（§17.7 / §15.2）。
 * 支持字符串（视为 entity）与对象两种形态；无 type 时按字段推断。
 *
 * @returns {{ok:boolean, trigger:object, due_time:string|null, trigger_type:string, soft:Array}}
 */
function normalizeTriggerCondition(raw, item = {}, now = nowIso()) {
  const soft = [];
  let trigger = {};
  if (typeof raw === 'string' && raw.trim()) {
    trigger = { type: 'entity', entity: raw.trim() };
  } else if (isPlainObject(raw)) {
    trigger = clone(raw);
  } else if (raw !== undefined && raw !== null) {
    throw contractError('INVALID_PAYLOAD', 'create: trigger_condition 必须是对象或实体字符串（§17.7）');
  }

  const rawDue = trigger.due_time ?? trigger.time ?? trigger.at ?? item.due_time ?? null;
  let dueTime = null;
  if (rawDue !== null && rawDue !== undefined && rawDue !== '') {
    dueTime = toIso(rawDue);
    if (dueTime === null) {
      soft.push(softNote(
        'DUE_TIME_NOT_ISO',
        `due_time=${JSON.stringify(rawDue)} 无法解析为 ISO 时间，按原值保存`,
        '§17.7/§15.2'
      ));
      dueTime = String(rawDue);
    }
  }

  const entity = trigger.entity ?? trigger.entity_key ?? item.target_entity ?? null;
  const eventType = trigger.event_type ?? trigger.event ?? null;
  let type = trigger.type ?? item.trigger_type ?? null;
  if (type !== null && !TRIGGER_TYPE_SET.has(String(type))) {
    soft.push(softNote(
      'TRIGGER_TYPE_INVALID',
      `trigger_condition.type=${JSON.stringify(type)} 不在 §17.7 枚举内，按字段推断`,
      '§17.7'
    ));
    type = null;
  }
  if (!type) {
    if (dueTime && (entity || eventType)) type = entity ? 'entity_or_time' : 'event';
    else if (dueTime) type = 'time';
    else if (eventType) type = 'event';
    else if (entity) type = 'entity';
    else type = 'time';
    soft.push(softNote('TRIGGER_TYPE_INFERRED', `推断 trigger_condition.type=${type}`, '§17.7'));
  }

  const normalized = { ...trigger, type };
  normalized.due_time = dueTime;
  if (entity !== null) normalized.entity = entity;
  if (eventType !== null) normalized.event_type = eventType;
  if (trigger.entity_key !== undefined) normalized.entity_key = trigger.entity_key;
  if (trigger.event_type === undefined && trigger.event !== undefined) normalized.event_type = trigger.event;

  return { ok: true, trigger: normalized, due_time: dueTime, trigger_type: type, soft };
}

function rowToItem(row) {
  return {
    schema_version: row.schema_version ?? PROSPECTIVE_SCHEMA_VERSION,
    prospective_id: row.prospective_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    type: row.type,
    payload: row.payload,
    trigger_condition: parseJson(row.trigger_condition_json, {}),
    target_entity: row.target_entity ?? null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    evidence_refs: parseJson(row.evidence_refs_json, []),
  };
}

/**
 * 创建前瞻项（§17.7）。
 *
 * @param {object} store
 * @param {{user_id:string, agent_id:string, item:object, now?:string}} params
 * @returns {{ok:boolean, item:object, soft:Array, hard:Array}}
 */
function create(store, params = {}) {
  const userId = String(params.user_id ?? '');
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  const now = params.now ?? nowIso();
  if (!userId) throw contractError('INVALID_PAYLOAD', 'create: user_id 必填（§17.7）');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'create: agent_id 必填（§17.7）');
  if (!isPlainObject(params.item)) throw contractError('INVALID_PAYLOAD', 'create: item 必填（§17.7）');

  const item = params.item;
  const payload = item.payload;
  if (payload === undefined || payload === null || String(payload) === '') {
    throw contractError('INVALID_PAYLOAD', 'create: item.payload 必填（§17.7）');
  }

  const soft = [];
  const type = String(item.type ?? 'reminder');
  if (!PROSPECTIVE_TYPE_SET.has(type)) {
    throw contractError('INVALID_ENUM', `create: type=${type} 不在 §17.7 枚举内`);
  }
  if (item.type === undefined) {
    soft.push(softNote('PROSPECTIVE_TYPE_DEFAULTED', '未提供 type，按 reminder 落库', '§17.7'));
  }

  const normalized = normalizeTriggerCondition(item.trigger_condition, item, now);
  soft.push(...normalized.soft);

  if (item.status !== undefined && item.status !== 'pending') {
    soft.push(softNote('STATUS_FORCED_PENDING', `新建前瞻项强制 pending，忽略 status=${item.status}`, '§17.7'));
  }

  const prospectiveId = String(item.prospective_id ?? generateId('pro'));
  const evidenceRefs = Array.isArray(item.evidence_refs) && item.evidence_refs.length
    ? item.evidence_refs.map(String)
    : [`prospective:${prospectiveId}`];
  if (!Array.isArray(item.evidence_refs) || !item.evidence_refs.length) {
    soft.push(softNote(
      'EVIDENCE_REFS_PLACEHOLDER',
      '未提供 evidence_refs（§17.7 要求 >=1），暂以前瞻项自引用占位',
      '§17.7'
    ));
  }

  const targetEntity = item.target_entity ?? normalized.trigger.entity ?? null;

  store.run(
    `INSERT INTO prospective_store
      (prospective_id, user_id, agent_id, type, payload, trigger_condition_json,
       trigger_type, target_entity, due_time, status, evidence_refs_json,
       updated_at, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    prospectiveId,
    userId,
    agentId,
    type,
    String(payload),
    toJson(normalized.trigger),
    normalized.trigger_type,
    targetEntity === null ? null : String(targetEntity),
    normalized.due_time,
    toJson(evidenceRefs),
    now,
    PROSPECTIVE_SCHEMA_VERSION,
    now
  );

  const row = store.get('SELECT * FROM prospective_store WHERE prospective_id = ?', prospectiveId);
  return { ok: true, item: rowToItem(row), soft, hard: [] };
}

function includesEntity(haystack, needle) {
  if (haystack === null || haystack === undefined || !needle) return false;
  return String(haystack).includes(String(needle));
}

/**
 * 判断一条前瞻项是否到期/条件命中（纯函数，§15.2）。
 *
 * @param {object} item rowToItem 形态
 * @param {{now?:string, event?:object, entity?:string}} context
 * @returns {{hit:boolean, reasons:Array<string>}}
 */
function matchCondition(item, context = {}) {
  const now = context.now ?? nowIso();
  const nowMs = toMs(now);
  const trigger = isPlainObject(item.trigger_condition) ? item.trigger_condition : {};
  const type = trigger.type ?? item.trigger_type ?? null;
  const dueMs = toMs(item.due_time ?? trigger.due_time);
  const reasons = [];

  if (dueMs !== null && nowMs !== null && dueMs <= nowMs) {
    reasons.push('due_time');
  }

  const event = isPlainObject(context.event) ? context.event : null;
  if (event && (type === 'event' || type === 'entity_or_time')) {
    const eventType = trigger.event_type ?? trigger.event ?? null;
    const eventKey = trigger.entity_key ?? trigger.entity ?? null;
    const typeMatch = event.type !== undefined && eventType !== null && String(event.type) === String(eventType);
    const keyTarget = event.entity_key ?? event.entity ?? context.entity ?? null;
    const keyMatch = keyTarget === null || eventKey === null
      ? true
      : includesEntity(keyTarget, eventKey) || includesEntity(eventKey, keyTarget);
    if (typeMatch && keyMatch) reasons.push('event');
  }

  const entity = context.entity ?? (event ? (event.entity ?? event.entity_key ?? null) : null);
  if (entity !== null && entity !== undefined && entity !== '') {
    const candidates = [trigger.entity, trigger.entity_key, item.target_entity].filter(Boolean);
    if (candidates.some((candidate) => includesEntity(entity, candidate) || includesEntity(candidate, entity))) {
      reasons.push('entity');
    }
  }

  return { hit: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * 返回到期/条件命中的前瞻项（§15.2），命中后置 triggered 并写 prospective.trigger 审计。
 *
 * @param {object} store
 * @param {{now?:string, user_id:string, agent_id?:string, event?:object,
 *          entity?:string, include_triggered?:boolean, limit?:number}} params
 * @returns {{ok:boolean, items:Array, count:number, now:string, soft:Array, hard:Array}}
 */
function due(store, params = {}) {
  const userId = String(params.user_id ?? '');
  const agentId = params.agent_id ? String(params.agent_id) : null;
  const now = params.now ?? nowIso();
  if (!userId) throw contractError('INVALID_PAYLOAD', 'due: user_id 必填（§15.2）');

  const statuses = params.include_triggered ? ['pending', 'triggered'] : ['pending'];
  const rows = agentId
    ? store.all(
      `SELECT * FROM prospective_store
        WHERE user_id = ? AND agent_id = ? AND status IN (${statuses.map(() => '?').join(',')})
        ORDER BY CASE WHEN due_time IS NULL THEN 1 ELSE 0 END, due_time, created_at`,
      userId,
      agentId,
      ...statuses
    )
    : store.all(
      `SELECT * FROM prospective_store
        WHERE user_id = ? AND status IN (${statuses.map(() => '?').join(',')})
        ORDER BY CASE WHEN due_time IS NULL THEN 1 ELSE 0 END, due_time, created_at`,
      userId,
      ...statuses
    );

  const soft = [];
  const hits = [];
  const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 100)));

  for (const row of rows) {
    if (hits.length >= limit) break;
    const item = rowToItem(row);
    const match = matchCondition(item, { now, event: params.event, entity: params.entity });
    if (!match.hit) continue;

    let updated = item;
    if (row.status === 'pending') {
      store.run(
        "UPDATE prospective_store SET status = 'triggered', updated_at = ? WHERE prospective_id = ? AND status = 'pending'",
        now,
        row.prospective_id
      );
      updated = { ...item, status: 'triggered', updated_at: now };
      safeAudit(store, {
        user_id: row.user_id,
        agent_id: row.agent_id,
        action: AUDIT_ACTION.PROSPECTIVE_TRIGGER,
        target_type: 'prospective_item',
        target_id: row.prospective_id,
        before: { status: row.status, due_time: row.due_time },
        after: { status: 'triggered', matched: match.reasons },
        reason: `trigger:${match.reasons.join('+')}`,
        actor: { type: 'system', id: 'prospective_due' },
        sensitivity: SENSITIVITY.S2,
        now,
      });
    }
    hits.push({ ...updated, matched: match.reasons });
  }

  if (!hits.length) {
    soft.push(softNote('PROSPECTIVE_NONE_DUE', '没有到期或条件命中的前瞻项', '§15.2'));
  }

  return { ok: true, items: hits, count: hits.length, now, soft, hard: [] };
}

/**
 * 过期扫描（§15.2）：pending 且 due_time + grace_seconds < now -> expired。
 *
 * @param {object} store
 * @param {{now?:string, grace_seconds?:number, user_id?:string, agent_id?:string}} params
 * @returns {{ok:boolean, expired:Array, count:number, cutoff:string, soft:Array, hard:Array}}
 */
function expire(store, params = {}) {
  const now = params.now ?? nowIso();
  const nowMs = toMs(now);
  if (nowMs === null) throw contractError('INVALID_PAYLOAD', 'expire: now 必须是可解析时间');
  const graceSeconds = Number.isFinite(Number(params.grace_seconds))
    ? Math.max(0, Number(params.grace_seconds))
    : DEFAULT_GRACE_SECONDS;
  const cutoff = new Date(nowMs - graceSeconds * 1000).toISOString();

  const filters = ["status = 'pending'", 'due_time IS NOT NULL', 'due_time < ?'];
  const values = [cutoff];
  if (params.user_id) {
    filters.push('user_id = ?');
    values.push(String(params.user_id));
  }
  if (params.agent_id) {
    filters.push('agent_id = ?');
    values.push(String(params.agent_id));
  }

  const rows = store.all(
    `SELECT * FROM prospective_store WHERE ${filters.join(' AND ')}`,
    ...values
  );
  const expired = [];
  for (const row of rows) {
    store.run(
      "UPDATE prospective_store SET status = 'expired', updated_at = ? WHERE prospective_id = ? AND status = 'pending'",
      now,
      row.prospective_id
    );
    expired.push({ ...rowToItem(row), status: 'expired', updated_at: now });
    safeAudit(store, {
      user_id: row.user_id,
      agent_id: row.agent_id,
      action: AUDIT_ACTION.PROSPECTIVE_EXPIRED,
      target_type: 'prospective_item',
      target_id: row.prospective_id,
      before: { status: row.status, due_time: row.due_time },
      after: { status: 'expired', grace_seconds: graceSeconds },
      reason: 'due_time_expired_with_grace',
      actor: { type: 'system', id: 'prospective_expire' },
      sensitivity: SENSITIVITY.S2,
      now,
    });
  }

  return {
    ok: true,
    expired,
    count: expired.length,
    cutoff,
    grace_seconds: graceSeconds,
    soft: expired.length ? [] : [softNote('PROSPECTIVE_NONE_EXPIRED', '没有满足过期条件的前瞻项', '§15.2')],
    hard: [],
  };
}

module.exports = {
  PROSPECTIVE_SCHEMA_VERSION,
  PROSPECTIVE_TYPE,
  TRIGGER_TYPE,
  STATUS,
  DEFAULT_GRACE_SECONDS,
  normalizeTriggerCondition,
  create,
  matchCondition,
  due,
  expire,
};
