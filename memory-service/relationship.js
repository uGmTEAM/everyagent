'use strict';

/**
 * 关系层 · 关系边 / 里程碑 / 召回关系权重接口
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §17.6  RelationshipEdge / Milestone（target_type、target_id、intimacy、
 *            trust、familiarity、sentiment_history、milestones、last_interaction）；
 *   - §4.2   relationship_weight 维度（retrieval 读取同一张 relationship_edge 表）；
 *   - §20.2  关系行为：状态驱动倾向；越界亲密/不当承诺属硬红线（本文件不做表达拦截）。
 *
 * 设计取舍：
 *   - §17.6 表没有 from/to/relation 列，而任务要求写入 from/to/relation；
 *     沿用 quota.js 的惰性补列模式（PRAGMA table_info + ALTER TABLE ADD COLUMN），
 *     不改 ddl.js、不新建表；
 *   - 单个 weight 映射为 intimacy/trust/familiarity 三者同值，
 *     使 retrieval.js 的 0.5*intimacy+0.3*trust+0.2*familiarity 恰好等于 weight；
 *   - 里程碑表没有 agent_id / edge_id 列，同样惰性补齐。
 */

const {
  AUDIT_ACTION,
  SENSITIVITY,
} = require('./constants');
const audit = require('./audit');
const crypto = require('node:crypto');

const RELATIONSHIP_SCHEMA_VERSION = 'relationship_edge.v4.1';
const MILESTONE_SCHEMA_VERSION = 'milestone.v4.1';

// §17.6 Milestone.type 枚举
const MILESTONE_TYPE = Object.freeze([
  'first_meeting',
  'co_complete',
  'conflict_resolve',
  'important_share',
  'long_companionship',
]);
const MILESTONE_TYPE_SET = new Set(MILESTONE_TYPE);

// 关系权重公式与 retrieval.js 的 resolveRelationshipWeight 保持一致（§4.2）
const RELATIONSHIP_WEIGHT_FORMULA = Object.freeze({
  intimacy: 0.5,
  trust: 0.3,
  familiarity: 0.2,
});
const DEFAULT_RELATIONSHIP_WEIGHT = 0.5;

const readyStores = new WeakSet();

function nowIso() {
  return new Date().toISOString();
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function tableColumns(store, table) {
  return new Set(store.all(`PRAGMA table_info(${table})`).map((column) => column.name));
}

/**
 * 惰性补齐 §17.6 表结构未定义、但任务/契约语义需要的列。
 * 幂等：同一 store 只执行一次。
 */
function ensureSchema(store) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('ensureSchema: store 必须由 getStore() 返回');
  }
  if (readyStores.has(store)) return;

  const edgeColumns = tableColumns(store, 'relationship_edge');
  if (!edgeColumns.has('from_type')) store.run('ALTER TABLE relationship_edge ADD COLUMN from_type TEXT');
  if (!edgeColumns.has('from_id')) store.run('ALTER TABLE relationship_edge ADD COLUMN from_id TEXT');
  if (!edgeColumns.has('relation')) store.run('ALTER TABLE relationship_edge ADD COLUMN relation TEXT');

  const milestoneColumns = tableColumns(store, 'relationship_milestone');
  if (!milestoneColumns.has('agent_id')) store.run('ALTER TABLE relationship_milestone ADD COLUMN agent_id TEXT');
  if (!milestoneColumns.has('edge_id')) store.run('ALTER TABLE relationship_milestone ADD COLUMN edge_id TEXT');

  readyStores.add(store);
}

function normalizeEndpoint(value, defaultType) {
  if (isPlainObject(value)) {
    const type = value.type ?? value.target_type ?? defaultType;
    const id = value.id ?? value.target_id ?? value.value;
    return { type: String(type ?? defaultType), id: String(id ?? '') };
  }
  return { type: String(defaultType), id: String(value ?? '') };
}

function edgeWeight(row) {
  return clamp01(
    RELATIONSHIP_WEIGHT_FORMULA.intimacy * num(row.intimacy, 0)
    + RELATIONSHIP_WEIGHT_FORMULA.trust * num(row.trust, 0)
    + RELATIONSHIP_WEIGHT_FORMULA.familiarity * num(row.familiarity, 0)
  );
}

function rowToEdge(row) {
  return {
    schema_version: row.schema_version ?? RELATIONSHIP_SCHEMA_VERSION,
    edge_id: row.edge_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    from_type: row.from_type ?? 'agent',
    from_id: row.from_id ?? row.agent_id,
    relation: row.relation ?? null,
    target_type: row.target_type,
    target_id: row.target_id,
    intimacy: num(row.intimacy, 0),
    trust: num(row.trust, 0),
    familiarity: num(row.familiarity, 0),
    weight: edgeWeight(row),
    sentiment_history: parseJson(row.sentiment_history_json, []),
    milestones: parseJson(row.milestones_json, []),
    last_interaction: row.last_interaction ?? null,
    updated_at: row.updated_at,
  };
}

/**
 * 写入/更新关系边（§17.6）。
 *
 * @param {object} store
 * @param {object} params
 *   {user_id, agent_id, from, to, relation, weight, intimacy, trust, familiarity,
 *    valence, event, now}
 * @returns {{ok:boolean, edge:object, created:boolean, audit_ref:string|null, soft:Array, hard:Array}}
 */
function upsertEdge(store, params = {}) {
  ensureSchema(store);
  const userId = String(params.user_id ?? '');
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  const now = params.now ?? nowIso();
  if (!userId) throw contractError('INVALID_PAYLOAD', 'upsertEdge: user_id 必填（§17.6）');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'upsertEdge: agent_id 必填（§17.6）');

  const from = normalizeEndpoint(params.from, 'agent');
  const to = normalizeEndpoint(params.to, 'user');
  if (!from.id || !to.id) throw contractError('INVALID_PAYLOAD', 'upsertEdge: from/to 必须给出 id（§17.6）');

  const relation = String(params.relation ?? (to.type === 'user' ? 'assistant' : 'related'));
  const weight = Number.isFinite(Number(params.weight)) && params.weight !== null && params.weight !== undefined
    ? clamp01(Number(params.weight))
    : null;
  const intimacy = clamp01(num(params.intimacy, weight ?? DEFAULT_RELATIONSHIP_WEIGHT));
  const trust = clamp01(num(params.trust, weight ?? DEFAULT_RELATIONSHIP_WEIGHT));
  const familiarity = clamp01(num(params.familiarity, weight ?? DEFAULT_RELATIONSHIP_WEIGHT));

  const existing = store.get(
    `SELECT * FROM relationship_edge
      WHERE user_id = ? AND agent_id = ? AND target_type = ? AND target_id = ?
        AND COALESCE(relation, '') = ?
      ORDER BY updated_at DESC LIMIT 1`,
    userId,
    agentId,
    to.type,
    to.id,
    relation
  );

  const soft = [];
  const hard = [];
  const sentimentHistory = existing ? parseJson(existing.sentiment_history_json, []) : [];
  if (params.valence !== undefined || params.event !== undefined) {
    sentimentHistory.push({
      timestamp: now,
      valence: clamp01(num(params.valence, 0.5)),
      event: params.event === undefined ? null : String(params.event),
    });
  }

  const edgeId = existing?.edge_id ?? generateId('rel');
  if (existing) {
    store.run(
      `UPDATE relationship_edge
          SET from_type = ?, from_id = ?, relation = ?, intimacy = ?, trust = ?,
              familiarity = ?, sentiment_history_json = ?, last_interaction = ?, updated_at = ?
        WHERE edge_id = ?`,
      from.type,
      from.id,
      relation,
      intimacy,
      trust,
      familiarity,
      toJson(sentimentHistory.slice(-100)),
      now,
      now,
      edgeId
    );
  } else {
    store.run(
      `INSERT INTO relationship_edge
        (edge_id, user_id, agent_id, target_type, target_id, intimacy, trust,
         familiarity, sentiment_history_json, milestones_json, last_interaction,
         updated_at, schema_version, created_at, from_type, from_id, relation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
      edgeId,
      userId,
      agentId,
      to.type,
      to.id,
      intimacy,
      trust,
      familiarity,
      toJson(sentimentHistory.slice(-100)),
      now,
      now,
      RELATIONSHIP_SCHEMA_VERSION,
      now,
      from.type,
      from.id,
      relation
    );
  }

  if (!params.intimacy && !params.trust && !params.familiarity && weight !== null) {
    soft.push(softNote(
      'WEIGHT_MAPPED_TO_THREE_DIMENSIONS',
      `单个 weight=${weight} 映射为 intimacy/trust/familiarity 同值，retrieval 加权后仍等于 weight`,
      '§4.2/§17.6'
    ));
  }

  const auditResult = safeAudit(store, {
    user_id: userId,
    agent_id: agentId,
    action: AUDIT_ACTION.RELATIONSHIP_UPDATE,
    target_type: 'relationship_edge',
    target_id: edgeId,
    before: existing ? { intimacy: existing.intimacy, trust: existing.trust, familiarity: existing.familiarity } : null,
    after: { intimacy, trust, familiarity, relation, from, to },
    reason: params.reason ?? '关系边更新（§17.6）',
    actor: params.actor ?? { type: 'agent', id: agentId },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  const row = store.get('SELECT * FROM relationship_edge WHERE edge_id = ?', edgeId);
  return {
    ok: true,
    edge: rowToEdge(row),
    created: !existing,
    audit_ref: auditResult?.audit_ref ?? null,
    soft,
    hard,
  };
}

/**
 * 新增关系里程碑（§17.6）。
 *
 * @param {object} store
 * @param {object} params
 *   {user_id, agent_id, edge_id, title, occurred_at, type, description,
 *    affect_tag, evidence_refs, significance, now}
 * @returns {object}
 */
function addMilestone(store, params = {}) {
  ensureSchema(store);
  const userId = String(params.user_id ?? '');
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  const edgeId = String(params.edge_id ?? '');
  const now = params.now ?? nowIso();
  if (!userId) throw contractError('INVALID_PAYLOAD', 'addMilestone: user_id 必填（§17.6）');
  if (!edgeId) throw contractError('INVALID_PAYLOAD', 'addMilestone: edge_id 必填（§17.6）');
  if (!params.title) throw contractError('INVALID_PAYLOAD', 'addMilestone: title 必填（§17.6）');

  const edge = store.get(
    'SELECT * FROM relationship_edge WHERE edge_id = ? AND user_id = ?',
    edgeId,
    userId
  );
  if (!edge) {
    return {
      ok: false,
      blocked: true,
      code: 'EDGE_NOT_FOUND',
      reason: '里程碑必须挂在已存在的关系边上（§17.6）',
      soft: [],
      hard: [hardNote('EDGE_NOT_FOUND', '关系边不存在', '§17.6')],
    };
  }

  const type = params.type === undefined ? 'important_share' : String(params.type);
  if (!MILESTONE_TYPE_SET.has(type)) {
    throw contractError('INVALID_ENUM', `addMilestone: type=${type} 不在 §17.6 枚举内`);
  }

  const milestoneId = generateId('ms');
  const soft = [];
  if (params.type === undefined) {
    soft.push(softNote('MILESTONE_TYPE_DEFAULTED', '未提供 type，按 important_share 落库；建议调用方显式声明', '§17.6'));
  }
  const evidenceRefs = Array.isArray(params.evidence_refs) && params.evidence_refs.length
    ? params.evidence_refs.map(String)
    : [`milestone:${milestoneId}`];
  if (!Array.isArray(params.evidence_refs) || !params.evidence_refs.length) {
    soft.push(softNote(
      'EVIDENCE_REFS_PLACEHOLDER',
      '未提供 evidence_refs（§17.6 要求 >=1），暂以里程碑自引用占位，后续应回填真实 span',
      '§17.6'
    ));
  }

  const occurredAt = params.occurred_at ?? now;
  const significance = clamp01(num(params.significance, 0.6));

  store.run(
    `INSERT INTO relationship_milestone
      (milestone_id, user_id, target_id, type, description, t_stamp, affect_tag_json,
       evidence_refs_json, significance, deletion_state, schema_version, created_at,
       agent_id, edge_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    milestoneId,
    userId,
    String(edge.target_id),
    type,
    String(params.title ?? params.description ?? ''),
    String(occurredAt),
    toJson(params.affect_tag ?? null),
    toJson(evidenceRefs),
    significance,
    MILESTONE_SCHEMA_VERSION,
    now,
    agentId,
    edgeId
  );

  const milestones = parseJson(edge.milestones_json, []);
  if (!milestones.includes(milestoneId)) milestones.push(milestoneId);
  store.run(
    'UPDATE relationship_edge SET milestones_json = ?, updated_at = ? WHERE edge_id = ?',
    toJson(milestones),
    now,
    edgeId
  );

  const auditResult = safeAudit(store, {
    user_id: userId,
    agent_id: agentId,
    action: AUDIT_ACTION.RELATIONSHIP_UPDATE,
    target_type: 'relationship_milestone',
    target_id: milestoneId,
    before: null,
    after: { edge_id: edgeId, type, title: params.title, occurred_at: occurredAt, significance },
    reason: params.reason ?? '关系里程碑写入（§17.6）',
    actor: params.actor ?? { type: 'agent', id: agentId },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  return {
    ok: true,
    milestone: {
      schema_version: MILESTONE_SCHEMA_VERSION,
      milestone_id: milestoneId,
      user_id: userId,
      agent_id: agentId,
      edge_id: edgeId,
      target_id: String(edge.target_id),
      type,
      description: String(params.title ?? params.description ?? ''),
      t_stamp: String(occurredAt),
      affect_tag: params.affect_tag ?? null,
      evidence_refs: evidenceRefs,
      significance,
      deletion_state: 'active',
    },
    edge_id: edgeId,
    audit_ref: auditResult?.audit_ref ?? null,
    soft,
    hard: [],
  };
}

/**
 * 读取关系权重最高的边（§17.6 / §4.2）。
 *
 * @param {object} store
 * @param {{user_id:string, agent_id:string, limit?:number, target_type?:string}} params
 * @returns {{ok:boolean, edges:Array, soft:Array, hard:Array}}
 */
function getTopEdges(store, params = {}) {
  ensureSchema(store);
  const userId = String(params.user_id ?? '');
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  if (!userId) throw contractError('INVALID_PAYLOAD', 'getTopEdges: user_id 必填（§17.6）');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'getTopEdges: agent_id 必填（§17.6）');

  const limit = Math.max(1, Math.min(500, Math.floor(num(params.limit, 10))));
  const targetType = params.target_type ? String(params.target_type) : null;
  const rows = targetType
    ? store.all(
      'SELECT * FROM relationship_edge WHERE user_id = ? AND agent_id = ? AND target_type = ?',
      userId,
      agentId,
      targetType
    )
    : store.all('SELECT * FROM relationship_edge WHERE user_id = ? AND agent_id = ?', userId, agentId);

  const edges = rows
    .map(rowToEdge)
    .sort((a, b) => (b.weight - a.weight) || (String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.edge_id).localeCompare(String(b.edge_id))))
    .slice(0, limit);

  return { ok: true, edges, soft: [], hard: [] };
}

/**
 * 面向 recall 的关系权重接口（§4.2）。
 * retrieval.js 直接读表；本函数供其他调用方复用同一口径。
 *
 * @param {object} store
 * @param {{user_id:string, agent_id?:string, target_type?:string, target_id?:string}} params
 * @returns {{ok:boolean, weight:number, edge_id:string|null, source:string, soft:Array, hard:Array}}
 */
function relationshipWeight(store, params = {}) {
  ensureSchema(store);
  const userId = String(params.user_id ?? '');
  const agentId = params.agent_id ? String(params.agent_id) : null;
  const targetType = String(params.target_type ?? 'user');
  const targetId = String(params.target_id ?? userId);
  if (!userId) throw contractError('INVALID_PAYLOAD', 'relationshipWeight: user_id 必填（§4.2）');

  const row = agentId
    ? store.get(
      `SELECT * FROM relationship_edge
        WHERE user_id = ? AND agent_id = ? AND target_type = ? AND target_id = ?
        ORDER BY updated_at DESC, edge_id LIMIT 1`,
      userId,
      agentId,
      targetType,
      targetId
    )
    : store.get(
      `SELECT * FROM relationship_edge
        WHERE user_id = ? AND target_type = ? AND target_id = ?
        ORDER BY updated_at DESC, edge_id LIMIT 1`,
      userId,
      targetType,
      targetId
    );

  if (!row) {
    return {
      ok: true,
      weight: DEFAULT_RELATIONSHIP_WEIGHT,
      edge_id: null,
      source: 'default',
      soft: [softNote('RELATIONSHIP_EDGE_EMPTY', '无关系边，按 §4.2 缺失值取 0.5', '§4.2')],
      hard: [],
    };
  }
  return {
    ok: true,
    weight: edgeWeight(row),
    edge_id: row.edge_id,
    source: 'relationship_edge',
    soft: [],
    hard: [],
  };
}

/** retrieval 可直接使用的数值接口（§4.2）。 */
function getRelationshipWeight(store, params = {}) {
  return relationshipWeight(store, params).weight;
}

module.exports = {
  RELATIONSHIP_SCHEMA_VERSION,
  MILESTONE_SCHEMA_VERSION,
  MILESTONE_TYPE,
  RELATIONSHIP_WEIGHT_FORMULA,
  DEFAULT_RELATIONSHIP_WEIGHT,
  ensureSchema,
  upsertEdge,
  addMilestone,
  getTopEdges,
  relationshipWeight,
  getRelationshipWeight,
};
