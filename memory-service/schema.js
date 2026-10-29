'use strict';

/**
 * 数据契约校验基线（§17 十二个 schema + §2 MemoryItem）。
 *
 * 纯函数模块：不读数据库、不访问文件系统、不产生副作用。
 * 字段规格统一为：{ type, required, enum?, min?, max? }
 *   - min/max 对 number/integer 表示数值范围，对 string/array 表示长度范围；
 *   - 未在契约出现的字段一律不加入规格，避免自创字段。
 */

const {
  SCHEMA_VERSION,
  SCOPE,
  LAYER,
  MEMORY_TYPE,
  QUALITY_FLAG,
  SENSITIVITY,
  LIFECYCLE_STATE,
  AUDIT_ACTION,
  RECALL_ROUTE,
  TOKEN_BUDGET,
} = require('./constants');

// 字段规格构造器：仅接受契约允许的 5 个键。
function field(type, required, extra) {
  const spec = { type, required };
  if (extra && extra.enum !== undefined) spec.enum = extra.enum;
  if (extra && extra.min !== undefined) spec.min = extra.min;
  if (extra && extra.max !== undefined) spec.max = extra.max;
  return spec;
}

// §17.1 EvidenceSpan.source_type；§19 source_type
const SOURCE_TYPE = [
  'dialogue_turn',
  'tool_output',
  'file_asr',
  'file_ocr',
  'file_frame',
  'file_region',
  'document_paragraph',
  'system_event',
];

// §17.1 EvidenceSpan.deletion_state；§19 deletion_state
const EVIDENCE_DELETION_STATE = [
  'active',
  'orphan_pending',
  'content_deleted_audit_retained',
  'tombstone',
];

// §17.2 DerivedEdge.from_type/to_type
const DERIVED_NODE_TYPE = [
  'memory_item',
  'evidence_span',
  'dossier_d0',
  'dossier_d1',
  'dossier_d2',
  'reflection',
];

// §17.2 DerivedEdge.relation
const DERIVED_RELATION = [
  'derived_from',
  'aggregated_from',
  'summarized_from',
  'reflected_from',
  'corrected_by',
];

// §17.6 Milestone.type
const MILESTONE_TYPE = [
  'first_meeting',
  'co_complete',
  'conflict_resolve',
  'important_share',
  'long_companionship',
];

// §17.7 ProspectiveItem.type / trigger_condition.type / status
const PROSPECTIVE_TYPE = ['todo', 'reminder', 'promise', 'follow_up'];
const PROSPECTIVE_TRIGGER_TYPE = ['entity', 'time', 'event', 'entity_or_time'];
const PROSPECTIVE_STATUS = ['pending', 'triggered', 'done', 'cancelled', 'expired'];

// §17.10 QueryRewriteResult.intent
const QUERY_INTENT = ['memory_recall', 'raw_search', 'file_query', 'task_query', 'smalltalk'];

// §17.11 MediaSearchResult.level（D0-D3 四层，§13）
const DOSSIER_LEVEL = ['D0', 'D1', 'D2', 'D3'];

// §2 MemoryItem 字段规格（嵌套字段使用点路径；§2.2 最小必填集）
const MEMORY_ITEM_SCHEMA = Object.freeze({
  schema_version: field('string', true, { enum: [SCHEMA_VERSION] }),

  'identity.mem_id': field('string', true),
  'identity.user_id': field('string', true),
  'identity.tenant_id': field('string', false),
  'identity.org_id': field('string', false),
  'identity.owner_user_id': field('string', false),
  'identity.agent_id': field('string', true),
  'identity.scope': field('string', true, { enum: Object.values(SCOPE) }),
  'identity.layer': field('string', true, { enum: Object.values(LAYER) }),
  'identity.type': field('string', true, { enum: Object.values(MEMORY_TYPE) }),

  'content.summary_short': field('string', true),
  'content.summary_long': field('string', false),
  'content.structured': field('object', false),
  'content.tags': field('array', false),
  'content.entities': field('array', false),
  'content.relations': field('array', false),
  'content.embedding_refs': field('object', false),
  'content.raw_text_ref': field('string', false),
  'content.media_ref': field('string', false),

  'quality.importance': field('number', true, { min: 0, max: 1 }),
  'quality.confidence': field('number', true, { min: 0, max: 1 }),
  'quality.source_reliability': field('number', true, { min: 0, max: 1 }),
  'quality.recency': field('number', false, { min: 0, max: 1 }),
  'quality.access_count': field('integer', false, { min: 0 }),
  'quality.decay_score': field('number', false, { min: 0, max: 1 }),
  'quality.quality_flag': field('string', true, { enum: Object.values(QUALITY_FLAG) }),
  'quality.quality_reasons': field('array', true),

  'temporal.valid_from': field('string', true),
  'temporal.valid_to': field('string', false),
  'temporal.superseded_by': field('string', false),
  'temporal.supersedes': field('array', false),
  'temporal.version_chain': field('array', false),
  'temporal.last_access': field('string', false),

  'evidence.source_turns': field('array', false),
  'evidence.source_span': field('string', true),
  'evidence.evidence_refs': field('array', true, { min: 1 }),
  'evidence.derived_from': field('array', true),
  'evidence.created_at': field('string', true),
  'evidence.why_recalled_log': field('array', false),

  affect_ext: field('object', false),

  'governance.sensitivity': field('string', true, { enum: Object.values(SENSITIVITY) }),
  'governance.retention_policy': field('string', false),
  'governance.acl_version': field('integer', true, { min: 0 }),
  'governance.share_scope': field('array', true),
  'governance.audit_ref': field('string', false),

  lifecycle_state: field('string', true, { enum: Object.values(LIFECYCLE_STATE) }),
  version: field('integer', true, { min: 1 }),
});

// §17.1 EvidenceSpan
const EvidenceSpan = Object.freeze({
  schema_version: field('string', true, { enum: ['evidence_span.v4.1'] }),
  span_id: field('string', true),
  user_id: field('string', true),
  agent_id: field('string', false),
  mem_id: field('string', false),
  source_type: field('string', true, { enum: SOURCE_TYPE }),
  source_id: field('string', false),
  source_turn_id: field('string', false),
  raw_text: field('string', false),
  text_excerpt: field('string', false),
  start_offset: field('integer', false, { min: 0 }),
  end_offset: field('integer', false, { min: 0 }),
  media_ref: field('string', false),
  t_stamp: field('string', false),
  page_no: field('integer', false, { min: 0 }),
  bbox: field('object', false),
  language: field('string', false),
  sensitivity: field('string', false, { enum: Object.values(SENSITIVITY) }),
  content_hash: field('string', false),
  created_at: field('string', true),
  deletion_state: field('string', false, { enum: EVIDENCE_DELETION_STATE }),
  audit_ref: field('string', false),
});

// §17.2 DerivedEdge
const DerivedEdge = Object.freeze({
  schema_version: field('string', true, { enum: ['derived_edge.v4.1'] }),
  edge_id: field('string', true),
  user_id: field('string', true),
  from_type: field('string', true, { enum: DERIVED_NODE_TYPE }),
  from_id: field('string', true),
  to_type: field('string', true, { enum: DERIVED_NODE_TYPE }),
  to_id: field('string', true),
  relation: field('string', true, { enum: DERIVED_RELATION }),
  provenance: field('object', false),
  created_at: field('string', true),
  deletion_state: field('string', false, { enum: EVIDENCE_DELETION_STATE }),
});

// §17.3 AuditEvent
const AuditEvent = Object.freeze({
  schema_version: field('string', true, { enum: ['audit_event.v4.1'] }),
  event_id: field('string', true),
  user_id: field('string', true),
  agent_id: field('string', false),
  actor: field('object', true),
  action: field('string', true, { enum: Object.values(AUDIT_ACTION) }),
  object_type: field('string', true),
  object_id: field('string', true),
  request_id: field('string', false),
  before: field('object', false),
  after: field('object', false),
  reason: field('string', false),
  sensitivity: field('string', false, { enum: Object.values(SENSITIVITY) }),
  ip_hash: field('string', false),
  created_at: field('string', true),
  immutable: field('boolean', false),
});

// §17.4 AffectState
const AffectState = Object.freeze({
  schema_version: field('string', true, { enum: ['affect_state.v4.1'] }),
  user_id: field('string', true),
  agent_id: field('string', true),
  current_emotion: field('object', true),
  current_mood: field('object', true),
  attitudes: field('array', true),
  updated_at: field('string', true),
  history: field('array', false),
});

// §17.5 PersonaProfile
const PersonaProfile = Object.freeze({
  schema_version: field('string', true, { enum: ['persona_profile.v4.1'] }),
  persona_id: field('string', true),
  agent_id: field('string', true),
  identity: field('object', true),
  traits: field('object', true),
  values: field('object', true),
  style: field('object', true),
  consistency: field('object', true),
  version: field('integer', true, { min: 1 }),
  updated_at: field('string', true),
});

// §17.6 RelationshipEdge
const RelationshipEdge = Object.freeze({
  schema_version: field('string', true, { enum: ['relationship_edge.v4.1'] }),
  edge_id: field('string', true),
  user_id: field('string', true),
  agent_id: field('string', true),
  target_type: field('string', true),
  target_id: field('string', true),
  intimacy: field('number', true, { min: 0, max: 1 }),
  trust: field('number', true, { min: 0, max: 1 }),
  familiarity: field('number', true, { min: 0, max: 1 }),
  sentiment_history: field('array', false),
  milestones: field('array', false),
  last_interaction: field('string', false),
  updated_at: field('string', true),
});

// §17.6 Milestone
const Milestone = Object.freeze({
  schema_version: field('string', true, { enum: ['milestone.v4.1'] }),
  milestone_id: field('string', true),
  user_id: field('string', true),
  target_id: field('string', true),
  type: field('string', true, { enum: MILESTONE_TYPE }),
  description: field('string', false),
  t_stamp: field('string', true),
  affect_tag: field('object', false),
  evidence_refs: field('array', true, { min: 1 }),
  significance: field('number', true, { min: 0, max: 1 }),
  deletion_state: field('string', false, { enum: EVIDENCE_DELETION_STATE }),
});

// §17.7 ProspectiveItem
const ProspectiveItem = Object.freeze({
  schema_version: field('string', true, { enum: ['prospective_item.v4.1'] }),
  prospective_id: field('string', true),
  user_id: field('string', true),
  agent_id: field('string', true),
  type: field('string', true, { enum: PROSPECTIVE_TYPE }),
  payload: field('string', true),
  trigger_condition: field('object', true),
  target_entity: field('string', false),
  status: field('string', true, { enum: PROSPECTIVE_STATUS }),
  created_at: field('string', true),
  updated_at: field('string', true),
  evidence_refs: field('array', true, { min: 1 }),
});

// §17.8 AffectRecognitionResult
const AffectRecognitionResult = Object.freeze({
  schema_version: field('string', true, { enum: ['affect_recognition.v4.1'] }),
  user_id: field('string', true),
  source_span: field('string', true),
  target: field('object', true),
  valence: field('number', true, { min: -1, max: 1 }), // §0 约定 valence 单独为 -1..1
  arousal: field('number', true, { min: 0, max: 1 }),
  dominance: field('number', true, { min: 0, max: 1 }),
  emotion_label: field('string', false),
  intensity: field('number', false, { min: 0, max: 1 }),
  confidence: field('number', false, { min: 0, max: 1 }),
  source: field('string', true),
  decay_profile: field('string', false),
  evidence_refs: field('array', true, { min: 1 }),
});

// §17.9 RecallCandidate
const RecallCandidate = Object.freeze({
  schema_version: field('string', true, { enum: ['recall_candidate.v4.1'] }),
  mem_id: field('string', true),
  route: field('string', true, { enum: Object.values(RECALL_ROUTE) }),
  route_rank: field('integer', false, { min: 1 }),
  route_score: field('number', false, { min: 0, max: 1 }),
  similarity: field('number', false, { min: 0, max: 1 }),
  importance: field('number', false, { min: 0, max: 1 }),
  recency: field('number', false, { min: 0, max: 1 }),
  decay_score: field('number', false, { min: 0, max: 1 }),
  affect_consistency: field('number', false, { min: 0, max: 1 }),
  relationship_weight: field('number', false, { min: 0, max: 1 }),
  source_reliability: field('number', false, { min: 0, max: 1 }),
  why_recalled_code: field('string', false),
  summary_short: field('string', false),
  structured: field('object', false),
  evidence_ref: field('string', false),
  injected_form: field('string', false, { enum: TOKEN_BUDGET.RENDER_FORMS }),
});

// §17.10 QueryRewriteResult
const QueryRewriteResult = Object.freeze({
  schema_version: field('string', true, { enum: ['query_rewrite.v4.1'] }),
  user_id: field('string', true),
  original_query: field('string', true),
  normalized_query: field('string', true),
  intent: field('string', true, { enum: QUERY_INTENT }),
  entities: field('array', false),
  time_range: field('object', false),
  synonyms: field('array', false),
  filters: field('object', false),
  rewrite_confidence: field('number', true, { min: 0, max: 1 }),
});

// §17.11 MediaSearchResult
const MediaSearchResult = Object.freeze({
  schema_version: field('string', true, { enum: ['media_search_result.v4.1'] }),
  query: field('string', true),
  file_id: field('string', true),
  level: field('string', true, { enum: DOSSIER_LEVEL }),
  seg_id: field('string', false),
  t_start: field('string', false),
  t_end: field('string', false),
  caption: field('string', false),
  visual_desc: field('string', false),
  asr_text: field('string', false),
  ocr_text: field('string', false),
  speaker: field('string', false),
  emotion: field('object', false),
  entities: field('array', false),
  evidence_refs: field('array', true, { min: 1 }),
  why_recalled_code: field('string', false),
});

// §17 共 12 个 schema。§2 的 MemoryItem 不属于 §17，单独挂为非枚举别名，
// 以便使用 SCHEMAS.MemoryItem 的同时保持 Object.keys(SCHEMAS).length === 12。
const SCHEMAS = {
  EvidenceSpan,
  DerivedEdge,
  AuditEvent,
  AffectState,
  PersonaProfile,
  RelationshipEdge,
  Milestone,
  ProspectiveItem,
  AffectRecognitionResult,
  RecallCandidate,
  QueryRewriteResult,
  MediaSearchResult,
};

Object.defineProperty(SCHEMAS, 'MemoryItem', {
  value: MEMORY_ITEM_SCHEMA,
  enumerable: false,
  writable: false,
  configurable: false,
});

function getPath(obj, path) {
  const parts = path.split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function invalid(fieldName, message) {
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    field: fieldName,
    message,
  };
}

function checkType(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function checkLengthRange(value, min, max) {
  const size = typeof value === 'string' || Array.isArray(value) ? value.length : value;
  if (min !== undefined && size < min) return false;
  if (max !== undefined && size > max) return false;
  return true;
}

function validateFields(schema, obj) {
  for (const fieldName of Object.keys(schema)) {
    const spec = schema[fieldName];
    const value = getPath(obj, fieldName);

    // 缺省与显式 null 都视为“未提供”；必填字段直接 400 语义。
    if (value === undefined || value === null) {
      if (spec.required) {
        return invalid(fieldName, `缺少必填字段: ${fieldName}`);
      }
      continue;
    }

    if (!checkType(spec.type, value)) {
      return invalid(fieldName, `字段 ${fieldName} 类型应为 ${spec.type}`);
    }

    if (spec.enum && !spec.enum.includes(value)) {
      return invalid(
        fieldName,
        `字段 ${fieldName} 取值 ${JSON.stringify(value)} 不在合法枚举内: ${spec.enum.join(' | ')}`
      );
    }

    if (!checkLengthRange(value, spec.min, spec.max)) {
      return invalid(
        fieldName,
        `字段 ${fieldName} 超出范围 min=${spec.min} max=${spec.max}`
      );
    }
  }

  return { ok: true };
}

// §2 的跨字段硬校验（必填之外的部分）。
function validateMemoryItemRules(obj) {
  const evidenceRefs = getPath(obj, 'evidence.evidence_refs');
  const sourceSpan = getPath(obj, 'evidence.source_span');

  // §2.3：evidence_refs 必须 >= 1 且必须包含 source_span。
  if (Array.isArray(evidenceRefs)) {
    if (evidenceRefs.length < 1) {
      return invalid('evidence.evidence_refs', '§2.3 evidence_refs 长度必须 >= 1');
    }
    if (!evidenceRefs.includes(sourceSpan)) {
      return {
        ok: false,
        code: 'evidence_refs_missing_source_span',
        field: 'evidence.evidence_refs',
        message: '§2.3 evidence_refs 必须包含 source_span',
      };
    }
  }

  // §2.4：normal 时 quality_reasons 必须为空；needs_review/degraded 至少 1 项。
  const qualityFlag = getPath(obj, 'quality.quality_flag');
  const qualityReasons = getPath(obj, 'quality.quality_reasons');
  if (Array.isArray(qualityReasons)) {
    if (qualityFlag === QUALITY_FLAG.NORMAL && qualityReasons.length !== 0) {
      return invalid(
        'quality.quality_reasons',
        '§2.4 quality_flag=normal 时 quality_reasons 必须为 []'
      );
    }
    if (
      (qualityFlag === QUALITY_FLAG.NEEDS_REVIEW || qualityFlag === QUALITY_FLAG.DEGRADED) &&
      qualityReasons.length < 1
    ) {
      return invalid(
        'quality.quality_reasons',
        `§2.4 quality_flag=${qualityFlag} 时 quality_reasons 至少 1 项`
      );
    }
  }

  // §2.5：superseded 与 cold_archived 互斥（superseded 是终态之一）。
  // lifecycle_state 本身是单值枚举；此处额外拦截调用方同时传入布尔标记的写法。
  const lifecycle = getPath(obj, 'lifecycle_state');
  const superseded = lifecycle === LIFECYCLE_STATE.SUPERSEDED || obj.superseded === true;
  const coldArchived = lifecycle === LIFECYCLE_STATE.COLD_ARCHIVED || obj.cold_archived === true;
  if (superseded && coldArchived) {
    return invalid('lifecycle_state', '§2.5 superseded 与 cold_archived 互斥');
  }

  return { ok: true };
}

/**
 * 校验指定 schema。
 * @param {string} schemaName SCHEMAS 的键（含 MemoryItem 别名）
 * @param {object} obj 待校验对象
 * @returns {{ok:true, value:object}|{ok:false, code:string, field:string, message:string}}
 */
function validate(schemaName, obj) {
  const schema = SCHEMAS[schemaName];
  if (!schema) {
    return invalid('$schema', `未知 schema: ${schemaName}`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return invalid('$object', '待校验对象必须是普通对象');
  }

  const fieldsResult = validateFields(schema, obj);
  if (!fieldsResult.ok) return fieldsResult;

  if (schemaName === 'MemoryItem') {
    const rulesResult = validateMemoryItemRules(obj);
    if (!rulesResult.ok) return rulesResult;
  }

  return { ok: true, value: obj };
}

// §2 MemoryItem 便捷入口
function validateMemoryItem(obj) {
  return validate('MemoryItem', obj);
}

/**
 * §5.2/§22：deleted_* 不可召回；superseded 不参与常规召回。
 * cold_archived 仍可低权召回或仅返回指针（§5.2 / §22.1）。
 * 不可召回时抛出 Error，code=MEMORY_NOT_RECALLABLE。
 */
function assertRecallable(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    const error = new Error('assertRecallable 需要 memory_item 对象');
    error.code = 'MEMORY_NOT_RECALLABLE';
    error.reason = 'invalid_item';
    throw error;
  }

  const state = item.lifecycle_state;
  const deletionState = item.deletion_state;

  if (
    state === LIFECYCLE_STATE.DELETED_PENDING ||
    state === LIFECYCLE_STATE.DELETED_TOMBSTONE
  ) {
    const error = new Error(`§22.1 生命周期状态 ${state} 不可召回`);
    error.code = 'MEMORY_NOT_RECALLABLE';
    error.reason = state;
    throw error;
  }

  if (deletionState === 'tombstone' || deletionState === 'content_deleted_audit_retained') {
    const error = new Error(`§17.1 deletion_state=${deletionState} 不可召回`);
    error.code = 'MEMORY_NOT_RECALLABLE';
    error.reason = deletionState;
    throw error;
  }

  if (state === LIFECYCLE_STATE.SUPERSEDED) {
    const error = new Error('§22.1 superseded 仅审计/历史查询，不参与常规召回');
    error.code = 'MEMORY_NOT_RECALLABLE';
    error.reason = state;
    throw error;
  }

  if (state !== LIFECYCLE_STATE.ACTIVE && state !== LIFECYCLE_STATE.COLD_ARCHIVED) {
    const error = new Error(`§5.2 生命周期状态 ${state} 不可注入/召回`);
    error.code = 'MEMORY_NOT_RECALLABLE';
    error.reason = state;
    throw error;
  }

  return true;
}

module.exports = {
  SCHEMAS,
  MEMORY_ITEM_SCHEMA,
  validate,
  validateMemoryItem,
  assertRecallable,
};
