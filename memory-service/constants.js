'use strict';

/**
 * 《AI Agent 记忆能力框架 · 单一事实源 v4.1》常量基线。
 *
 * 本文件只放契约常量，不包含任何运行逻辑。后续模块应 require 本文件，
 * 禁止各自硬编码枚举值，避免出现第二套事实源。
 *
 * 契约文件：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 */

// 内存条目 schema 版本（§2.2：必须等于 memory_item.v4.1）
const SCHEMA_VERSION = 'memory_item.v4.1';

// 作用域（§19 枚举字典；§3 作用域与隔离）
const SCOPE = Object.freeze({
  SESSION: 'session',
  USER: 'user',
  ORG: 'org',
  GLOBAL: 'global',
});

// 记忆四层（§19 枚举字典；§24 M1-M4）
const LAYER = Object.freeze({
  M1: 'M1',
  M2: 'M2',
  M3: 'M3',
  M4: 'M4',
});

// 记忆类型（§19 枚举字典）
const MEMORY_TYPE = Object.freeze({
  FACT: 'fact',
  PREFERENCE: 'preference',
  AFFECT: 'affect',
  TASK: 'task',
  RELATIONSHIP: 'relationship',
  PROCEDURE: 'procedure',
  MEDIA_DOSSIER: 'media_dossier',
});

// 质量标记（§2.4、§19、§22.2）
// v4.1 明确：归档走 lifecycle_state=cold_archived，archived 已废弃，不属于 quality_flag。
const QUALITY_FLAG = Object.freeze({
  NORMAL: 'normal',
  NEEDS_REVIEW: 'needs_review',
  DEGRADED: 'degraded',
});

// 敏感分级（§19、§21.1）
const SENSITIVITY = Object.freeze({
  S0: 'S0',
  S1: 'S1',
  S2: 'S2',
  S3: 'S3',
});

// 生命周期状态（§19、§22.1）
const LIFECYCLE_STATE = Object.freeze({
  ACTIVE: 'active',
  COLD_ARCHIVED: 'cold_archived',
  SUPERSEDED: 'superseded',
  DELETED_PENDING: 'deleted_pending',
  DELETED_TOMBSTONE: 'deleted_tombstone',
});

// 审计动作完整枚举（§10 audit_action.v4.1）
const AUDIT_ACTION = Object.freeze({
  MEMORY_WRITE: 'memory.write',
  MEMORY_MERGE: 'memory.merge',
  MEMORY_SUPERSEDE: 'memory.supersede',
  MEMORY_RECALL: 'memory.recall',
  MEMORY_FETCH_SUMMARY: 'memory.fetch_summary',
  MEMORY_FETCH_STRUCTURED: 'memory.fetch_structured',
  MEMORY_FETCH_SPAN: 'memory.fetch_span',
  MEMORY_SEARCH_RAW: 'memory.search_raw',
  MEMORY_DELETE: 'memory.delete',
  MEMORY_EXPORT: 'memory.export',
  MEMORY_IMPORT: 'memory.import',
  MEMORY_COLD_ARCHIVE: 'memory.cold_archive',
  MEMORY_REACTIVATE: 'memory.reactivate',
  MEMORY_CONSOLIDATE: 'memory.consolidate',
  MEMORY_REFLECT: 'memory.reflect',
  MEMORY_QUALITY_REVIEW: 'memory.quality_review',
  MEMORY_QUALITY_UPGRADE: 'memory.quality_upgrade',
  MEMORY_QUALITY_DEGRADE: 'memory.quality_degrade',
  MEMORY_M4_OVERRIDE_REQUEST: 'memory.m4_override_request',
  MEMORY_M4_OVERRIDE_APPROVE: 'memory.m4_override_approve',
  MEMORY_M4_OVERRIDE_REJECT: 'memory.m4_override_reject',
  MEMORY_M4_OVERRIDE_APPLY: 'memory.m4_override_apply',
  MEMORY_M4_OVERRIDE_WITHDRAW: 'memory.m4_override_withdraw',
  MEMORY_M4_OVERRIDE_EXPIRED: 'memory.m4_override_expired',
  MEMORY_CACHE_HIT: 'memory.cache_hit',
  MEMORY_CACHE_INVALIDATE: 'memory.cache_invalidate',
  MEMORY_WRITE_FENCED: 'memory.write_fenced',
  AFFECT_UPDATE: 'affect.update',
  PERSONA_UPDATE: 'persona.update',
  RELATIONSHIP_UPDATE: 'relationship.update',
  SAFETY_BLOCK: 'safety.block',
  FILE_DELETE: 'file.delete',
  FILE_PARSE: 'file.parse',
  EVIDENCE_DELETE: 'evidence.delete',
  EVIDENCE_ORPHAN_DETECTED: 'evidence.orphan_detected',
  PROSPECTIVE_TRIGGER: 'prospective.trigger',
  PROSPECTIVE_DONE: 'prospective.done',
  PROSPECTIVE_CANCEL: 'prospective.cancel',
  PROSPECTIVE_EXPIRED: 'prospective.expired',
  DELETION_JOB_RETRY: 'deletion_job.retry',
  DELETION_JOB_COMPLETE: 'deletion_job.complete',
  DELETION_JOB_FAILED_MANUAL: 'deletion_job.failed_manual',
  AUTHZ_DENIED: 'authz.denied',
  CACHE_ACL_MISMATCH: 'cache.acl_mismatch',
  MEDIA_PARSE_DEGRADED: 'media.parse_degraded',
});

// 多模态解析状态（§13 parse_status）
const PARSE_STATUS = Object.freeze({
  SUCCESS: 'success',
  PARTIAL_SUCCESS: 'partial_success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

// M4 审批状态（§14 状态机；§19 M4 override state）
const M4_STATE = Object.freeze({
  REQUESTED: 'requested',
  REVIEWING: 'reviewing',
  APPROVED: 'approved',
  APPLIED: 'applied',
  CLOSED: 'closed',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
});

// 八路召回名称唯一口径（§17.9 RecallCandidate.route）
// 注意：§26 一页速查只写“六路”，以 §17.9 的八路为契约口径。
const RECALL_ROUTE = Object.freeze({
  SEMANTIC: 'semantic',
  STRUCTURED: 'structured',
  GRAPH: 'graph',
  TEMPORAL: 'temporal',
  AFFECT: 'affect',
  RAW_BM25: 'raw_bm25',
  PROSPECTIVE: 'prospective',
  FLASHBACK: 'flashback',
});

// why_recalled 编码（§6 示例、§17.9、§17.11）
// 契约正文只显式出现 S/A/T/V 四个前缀，禁止在此自创未出现的编码。
const WHY_CODE = Object.freeze({
  S: 'semantic',
  A: 'affect',
  T: 'temporal',
  V: 'visual',
});

// API 错误码（§18.1 错误码；§2.3/§3.2 的专用 400 错误码）
const ERROR_CODE = Object.freeze({
  INVALID_PAYLOAD: 'invalid_payload',
  INVALID_ENUM: 'invalid_enum',
  INVALID_SCHEMA_VERSION: 'invalid_schema_version',
  UNAUTHORIZED: 'unauthorized',
  USER_SCOPE_MISMATCH: 'user_scope_mismatch',
  DUPLICATE_PROCESSING: 'duplicate_processing',
  VERSION_CONFLICT: 'version_conflict',
  CONFLICT_UNRESOLVED: 'conflict_unresolved',
  EXTRACTION_FAILED: 'extraction_failed',
  MEDIA_PARSE_FAILED: 'media_parse_failed',
  QUOTA_EXCEEDED: 'quota_exceeded',
  SENSITIVITY_BLOCKED: 'sensitivity_blocked',
  INTERNAL_ERROR: 'internal_error',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  // §2.3：source_span 必须包含在 evidence_refs 中，违反返回 400 专用错误码
  EVIDENCE_REFS_MISSING_SOURCE_SPAN: 'evidence_refs_missing_source_span',
  // §3.2：scope 与 org_id/tenant_id/share_scope 组合非法，返回 400
  INVALID_SCOPE_ORG_COMBINATION: 'invalid_scope_org_combination',
});

// 融合权重唯一口径（§4.2 融合公式与缺失值；§4.1 为 route_bonus）
// 每个场景档位内 8 个维度权重之和为 1.00。
const WEIGHTS = Object.freeze({
  DEFAULT: Object.freeze({
    w_sim: 0.42,
    w_imp: 0.15,
    w_rec: 0.10,
    w_decay: 0.08,
    w_aff: 0.08,
    w_rel: 0.06,
    w_relia: 0.08,
    w_bonus: 0.03,
  }),
  CUSTOMER_SERVICE: Object.freeze({
    w_sim: 0.48,
    w_imp: 0.16,
    w_rec: 0.10,
    w_decay: 0.07,
    w_aff: 0.04,
    w_rel: 0.04,
    w_relia: 0.09,
    w_bonus: 0.02,
  }),
  COMPANION: Object.freeze({
    w_sim: 0.36,
    w_imp: 0.14,
    w_rec: 0.10,
    w_decay: 0.08,
    w_aff: 0.14,
    w_rel: 0.10,
    w_relia: 0.05,
    w_bonus: 0.03,
  }),
  ASSISTANT: Object.freeze({
    w_sim: 0.46,
    w_imp: 0.15,
    w_rec: 0.10,
    w_decay: 0.08,
    w_aff: 0.05,
    w_rel: 0.05,
    w_relia: 0.09,
    w_bonus: 0.02,
  }),
});

// 各路召回 route_bonus 原始值（§4.1 route_bonus 唯一口径）
// raw_bonus 先按单路/多路取上限，再只归一一次：route_bonus_norm = raw_bonus / 0.0300；
// 融合时只允许加一次 route_bonus_norm * w_bonus，不得在召回过程中提前归一或重复归一。
const ROUTE_BONUS = Object.freeze({
  SEMANTIC: 0, // §4.1 单路原始值 semantic=0
  STRUCTURED: 0.0100, // §4.1
  GRAPH: 0.0150, // §4.1
  TEMPORAL: 0.0050, // §4.1
  AFFECT: 0.0100, // §4.1
  RAW_BM25: 0.0150, // §4.1
  PROSPECTIVE: 0.0200, // §4.1
  FLASHBACK: 0.0100, // §4.1
  MULTI_ROUTE_CAP: 0.0300, // §4.1 多路 raw_bonus=min(0.0300, sum(命中原始值))
  SINGLE_ROUTE_CAP: 0.0200, // §4.1 单路 raw_bonus=min(0.0200, 该路原始值)
  NORMALIZER: 0.0300, // §4.1 route_bonus_norm 的唯一归一化分母
});

// 分档阈值（§4.4 分档 target_form）
// final_score >= 0.90 -> summary_long；>=0.75 -> summary_short；>=0.55 -> structured/tags；
// >=0.35 -> pointer；<0.35 -> drop。
const TIER_THRESHOLDS = Object.freeze({
  SUMMARY_LONG: 0.90,
  SUMMARY_SHORT: 0.75,
  STRUCTURED: 0.55,
  POINTER: 0.35,
});

// Token 预算与组装（§5；三档比例取附录 G）
// 5 种 render 形态（§5.3 压缩梯度中的可渲染形态），drop 不是 render 形态。
const TOKEN_BUDGET = Object.freeze({
  RENDER_FORMS: Object.freeze([
    'summary_long',
    'summary_short',
    'structured',
    'tags',
    'pointer',
  ]),
  DOWNGRADE_ORDER: Object.freeze([
    'summary_long',
    'summary_short',
    'structured',
    'tags',
    'pointer',
    'drop',
  ]),
  // 附录 G：window_8k / window_32k / window_128k 的预算占比
  WINDOW_8K: Object.freeze({
    system_persona_static: 0.10,
    current_dialogue: 0.40,
    recalled_memory: 0.25,
    tools_task: 0.10,
    output_buffer: 0.15,
  }),
  WINDOW_32K: Object.freeze({
    system_persona_static: 0.15,
    current_dialogue: 0.35,
    recalled_memory: 0.30,
    tools_task: 0.10,
    output_buffer: 0.10,
  }),
  WINDOW_128K: Object.freeze({
    system_persona_static: 0.15,
    current_dialogue: 0.30,
    recalled_memory: 0.35,
    tools_task: 0.10,
    output_buffer: 0.10,
  }),
  // 默认值，待配置覆盖（契约附录 G 只给三档，未指定运行时默认档位）
  DEFAULT_WINDOW: 'window_32k',
  // 附录 G guardrails
  GUARDRAILS: Object.freeze({
    min_pointer_keep_ratio: 0.50,
    evidence_completeness_min: 0.95,
    // 注意：附录 G 写 0.05，§12 告警阈值写 duplicate_injection_rate > 0.10；两者分属硬上限与告警线。
    duplicate_injection_max: 0.05,
  }),
});

// MMR 与去冗余（§4.5）
const MMR = Object.freeze({
  LAMBDA: 0.72, // §4.5 MMR lambda
  TOP_N: 30, // §4.5 候选 top_n
  TOP_K_DEFAULT: 5, // §4.5 top_k 默认 5
  TOP_K_MIN: 3, // §4.5 预算伸缩 3-8
  TOP_K_MAX: 8, // §4.5 预算伸缩 3-8
  DUPLICATE_THRESHOLD: 0.88, // §4.5 duplicate_threshold（去重相似阈值）
});

// 情感衰减与沉淀（§15.1）
const AFFECT_DECAY = Object.freeze({
  EMOTION_HALF_LIFE_TURNS: 5, // §15.1 emotion.half_life_turns
  EMOTION_HALF_LIFE_MINUTES: 15, // §15.1 emotion.half_life_minutes
  MOOD_HALF_LIFE_HOURS: 6, // §15.1 mood.half_life_hours
  ATTITUDE_HALF_LIFE_DAYS: 30, // §15.1 attitude.half_life_days
  INTIMACY_HALF_LIFE_DAYS: 90, // §15.1 intimacy.half_life_days
  AFFECT_CEILING: 0.90, // §15.1 saturation.affect_ceiling
  SAME_DIRECTION_MARGINAL_DECAY: 0.75, // §15.1 saturation.same_direction_marginal_decay
  COOLING_PERIOD_MINUTES: 30, // §15.1 saturation.cooling_period_minutes
  AFFECT_CONSISTENCY_STRENGTH_DEFAULT: 0.30, // §15.1 recall.affect_consistency_strength_default
  FLASHBACK_STRENGTH_DEFAULT: 0.20, // §15.1 recall.flashback_strength_default
});

// 审计保留（§21.3：默认 180 天，敏感事件 365 天）
const AUDIT_RETENTION_DAYS = Object.freeze({
  DEFAULT: 180,
  SENSITIVE: 365,
});

// page_token TTL 与分页（§16.2）
const PAGE_TOKEN_TTL_SECONDS = 300; // §16.2 page_token TTL=300s

// 召回缓存 TTL（§8.3）
const CACHE_TTL = Object.freeze({
  S1_DEFAULT_SECONDS: 300, // §8.3 s1.default_seconds
  S1_SESSION_HIGH_FREQ_SECONDS: 60, // §8.3 s1.session_high_freq_seconds
  S1_MAX_SECONDS: 600, // §8.3 s1.max_seconds
  S2_TTL_SECONDS: 60, // §8.3 s2.if_enabled.ttl_seconds
  CACHE_SCHEMA_VERSION: 'recall_cache.v4.1', // §8.2 缓存值 schema_version
});

// 写入幂等与 fencing（§7.2）
const WRITE_IDEMPOTENCY = Object.freeze({
  PROCESSING_TIMEOUT_SECONDS: 120, // §7.2 processing_timeout=120s
  TERMINAL_TTL_DAYS: 7, // §7.2 succeeded/failed/expired TTL=7d
  LOCK_TTL_BUFFER_SECONDS: 30, // §7.2 锁 TTL=timeout+30s
});

// 删除任务重试（§9.3）
const DELETION_JOB = Object.freeze({
  MAX_RETRY: 5, // §9.3 max_retry
  BACKOFF_BASE_SECONDS: 30, // §9.3 retry_backoff 基数 30s
  BACKOFF_MAX_SECONDS: 1800, // §9.3 指数退避上限 30min
});

// 通用上限（§2.3、§7.3、§16.2）
const LIMITS = Object.freeze({
  EVIDENCE_REFS_MIN: 1, // §2.3 evidence_refs 长度 >= 1
  // 默认值，待配置覆盖（§7.3 未给批量 items 上限数值，仅规定 200/207/422 语义）
  BATCH_ITEMS_MAX: 100,
  SEARCH_PAGE_SIZE_DEFAULT: 20, // §16.2 page_size 默认 20
  SEARCH_PAGE_SIZE_MAX: 100, // §16.2 page_size 最大 100
});

module.exports = {
  SCHEMA_VERSION,
  SCOPE,
  LAYER,
  MEMORY_TYPE,
  QUALITY_FLAG,
  SENSITIVITY,
  LIFECYCLE_STATE,
  AUDIT_ACTION,
  PARSE_STATUS,
  M4_STATE,
  RECALL_ROUTE,
  WHY_CODE,
  ERROR_CODE,
  WEIGHTS,
  ROUTE_BONUS,
  TIER_THRESHOLDS,
  TOKEN_BUDGET,
  MMR,
  AFFECT_DECAY,
  AUDIT_RETENTION_DAYS,
  PAGE_TOKEN_TTL_SECONDS,
  CACHE_TTL,
  WRITE_IDEMPOTENCY,
  DELETION_JOB,
  LIMITS,
};
