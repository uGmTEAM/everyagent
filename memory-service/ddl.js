'use strict';

/**
 * 物理存储 DDL 基线（附录 A 的 26 张表 + 附录 B 关键索引）。
 *
 * 约定：
 *   - 只导出 SQL 语句与表名，不包含数据库连接/执行逻辑；
 *   - 类型仅使用 SQLite 亲和类型 TEXT / INTEGER / REAL；
 *   - JSON 字段统一以 TEXT 存 JSON 字符串，字段名以 _json 结尾并在注释标注；
 *   - 主键使用契约中的 id 字段名；每张表都补 created_at；
 *   - 附录 A 只列用途而正文有字段定义的表，按正文补齐并在注释标注来源章节。
 */

// 附录 A：物理存储表清单（顺序与附录 A 完全一致，共 26 张）
const TABLES = Object.freeze([
  'memory_item',
  'memory_evidence_span',
  'memory_derived_edge',
  'memory_audit_log',
  'memory_version_chain',
  'memory_vector_index_item',
  'memory_vector_index_segment',
  'memory_vector_index_fragment',
  'memory_fulltext_index',
  'affect_state',
  'affect_history',
  'persona_profile',
  'relationship_edge',
  'relationship_milestone',
  'prospective_store',
  'file_entity',
  'dossier_d0',
  'dossier_d1',
  'dossier_d2',
  'dossier_d3',
  'deletion_job',
  'quota_usage',
  'recall_log',
  'migration_package',
  'write_idempotency',
  'share_grant',
]);

// 建表 SQL（§2.6 / §3.4 / §7.2 / §9.3 / §13 / §17 / §22 / 附录 A）
const createTableStatements = Object.freeze([
  // §2 memory_item：字段取 §2.6 DB 扁平映射 + §2.1 Canonical Schema
  `CREATE TABLE IF NOT EXISTS memory_item (
  mem_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  org_id TEXT,
  owner_user_id TEXT,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  layer TEXT NOT NULL,
  type TEXT NOT NULL,
  summary_short TEXT NOT NULL,
  summary_long TEXT,
  structured_json TEXT, -- JSON字符串（§2.1 content.structured）
  tags_json TEXT, -- JSON字符串（§2.1 content.tags）
  entities_json TEXT, -- JSON字符串（§2.1 content.entities）
  relations_json TEXT, -- JSON字符串（§2.1 content.relations）
  embedding_refs_json TEXT, -- JSON字符串：item/segment/fragment 三级向量引用（§2.1）
  raw_text_ref TEXT,
  media_ref TEXT,
  source_span_id TEXT NOT NULL, -- §2.6 source_span 扁平映射为 source_span_id
  source_turns_json TEXT, -- JSON字符串（§2.1 evidence.source_turns）
  derived_from_json TEXT NOT NULL, -- JSON字符串（§2.1 evidence.derived_from）
  why_recalled_log_json TEXT, -- JSON字符串（§2.1 evidence.why_recalled_log）
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  source_reliability REAL NOT NULL,
  recency REAL,
  access_count INTEGER NOT NULL DEFAULT 0,
  decay_score REAL,
  quality_flag TEXT NOT NULL,
  quality_reasons_json TEXT NOT NULL, -- JSON字符串（§2.1 quality.quality_reasons）
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  superseded_by TEXT,
  supersedes_json TEXT, -- JSON字符串（§2.1 temporal.supersedes）
  version_chain_json TEXT, -- JSON字符串（§2.1 temporal.version_chain）
  last_access TEXT,
  sensitivity TEXT NOT NULL,
  retention_policy TEXT,
  acl_version INTEGER NOT NULL DEFAULT 1,
  share_scope_json TEXT NOT NULL, -- JSON字符串（§2.1 governance.share_scope）
  audit_ref TEXT,
  affect_ext_json TEXT, -- JSON字符串（§2.1 affect_ext）
  lifecycle_state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §17.1 EvidenceSpan + §9.1 引用计数
  `CREATE TABLE IF NOT EXISTS memory_evidence_span (
  span_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  mem_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_turn_id TEXT,
  raw_text TEXT,
  text_excerpt TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  media_ref TEXT,
  t_stamp TEXT,
  page_no INTEGER,
  bbox_json TEXT, -- JSON字符串（§17.1 bbox）
  language TEXT,
  sensitivity TEXT,
  content_hash TEXT,
  ref_count INTEGER NOT NULL DEFAULT 0, -- §9.1 ref_count 原子增减（ref_event 明细表在附录A未单列）
  deletion_state TEXT,
  audit_ref TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §17.2 DerivedEdge
  `CREATE TABLE IF NOT EXISTS memory_derived_edge (
  edge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  provenance_json TEXT, -- JSON字符串（§17.2 provenance）
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §17.3 AuditEvent + §10 WORM/只追加 + §21.3 保留
  `CREATE TABLE IF NOT EXISTS memory_audit_log (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  actor_json TEXT NOT NULL, -- JSON字符串（§17.3 actor）
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  request_id TEXT,
  before_json TEXT, -- JSON字符串，S2/S3 只保留 hash 或枚举（§10）
  after_json TEXT, -- JSON字符串，S2/S3 只保留 hash 或枚举（§10）
  reason TEXT,
  sensitivity TEXT,
  ip_hash TEXT,
  hash TEXT, -- §10 审计壳 hash；WORM/哈希链建议见 §21.3
  immutable INTEGER NOT NULL DEFAULT 1, -- §10 只追加，禁止更新/删除
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // 附录 A 仅列用途：版本链与 superseded 关系；字段取 §2.1/附录 C
  `CREATE TABLE IF NOT EXISTS memory_version_chain (
  mem_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  superseded_by TEXT,
  supersedes_json TEXT, -- JSON字符串（§2.1 temporal.supersedes）
  version_chain_json TEXT, -- JSON字符串（附录 C 版本链）
  valid_from TEXT,
  valid_to TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mem_id, version)
);`,

  // §17 三级向量：条目级；字段取 §2.1 embedding_refs / §3.3 命名空间，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS memory_vector_index_item (
  vec_id TEXT PRIMARY KEY, -- 对应 embedding_refs.item，如 vec_mem_01J_item（§2.1）
  mem_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  org_id TEXT,
  vector_json TEXT, -- JSON数组（SQLite 亲和类型无 BLOB，按约定用 TEXT 存向量）
  dim INTEGER,
  model TEXT,
  vector_ns TEXT, -- §3.3 向量命名空间 user_id 或 tenant_id|org_id
  acl_version INTEGER,
  created_at TEXT NOT NULL
);`,

  // §17 三级向量：段级；字段取 §13 D1/D2 与 §3.3，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS memory_vector_index_segment (
  vec_id TEXT PRIMARY KEY,
  seg_id TEXT NOT NULL,
  mem_id TEXT,
  file_id TEXT,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  org_id TEXT,
  vector_json TEXT, -- JSON数组
  dim INTEGER,
  model TEXT,
  vector_ns TEXT, -- §3.3 向量命名空间
  acl_version INTEGER,
  created_at TEXT NOT NULL
);`,

  // §17 三级向量：片段级；字段取 §17.1 EvidenceSpan 与 §3.3，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS memory_vector_index_fragment (
  vec_id TEXT PRIMARY KEY,
  fragment_id TEXT NOT NULL,
  span_id TEXT,
  mem_id TEXT,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  org_id TEXT,
  vector_json TEXT, -- JSON数组
  dim INTEGER,
  model TEXT,
  vector_ns TEXT, -- §3.3 向量命名空间
  acl_version INTEGER,
  created_at TEXT NOT NULL
);`,

  // 附录 A 仅列用途：原文/ASR/OCR/caption 全文索引；字段取 §16.2/§17.1
  `CREATE TABLE IF NOT EXISTS memory_fulltext_index (
  index_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  org_id TEXT,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  source_type TEXT,
  text_content TEXT, -- 原文/ASR/OCR/caption 文本（§16.2 全文检索）
  language TEXT,
  created_at TEXT NOT NULL
);`,

  // §17.4 AffectState（当前情感状态）
  `CREATE TABLE IF NOT EXISTS affect_state (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  current_emotion_json TEXT NOT NULL, -- JSON字符串（§17.4 current_emotion）
  current_mood_json TEXT NOT NULL, -- JSON字符串（§17.4 current_mood）
  attitudes_json TEXT NOT NULL, -- JSON字符串（§17.4 attitudes）
  updated_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);`,

  // §17.4 history：情感演化轨迹（附录 A 仅列用途，字段取 §17.4 history）
  `CREATE TABLE IF NOT EXISTS affect_history (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  before_json TEXT, -- JSON字符串（§17.4 history.before）
  after_json TEXT, -- JSON字符串（§17.4 history.after）
  trigger_span_id TEXT,
  delta_reason TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id, timestamp)
);`,

  // §17.5 PersonaProfile
  `CREATE TABLE IF NOT EXISTS persona_profile (
  persona_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  identity_json TEXT NOT NULL, -- JSON字符串（§17.5 identity）
  traits_json TEXT NOT NULL, -- JSON字符串（§17.5 traits）
  values_json TEXT NOT NULL, -- JSON字符串（§17.5 values）
  style_json TEXT NOT NULL, -- JSON字符串（§17.5 style）
  consistency_json TEXT NOT NULL, -- JSON字符串（§17.5 consistency）
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §17.6 RelationshipEdge
  `CREATE TABLE IF NOT EXISTS relationship_edge (
  edge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  intimacy REAL NOT NULL,
  trust REAL NOT NULL,
  familiarity REAL NOT NULL,
  sentiment_history_json TEXT, -- JSON字符串（§17.6 sentiment_history）
  milestones_json TEXT, -- JSON字符串（§17.6 milestones）
  last_interaction TEXT,
  updated_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §17.6 Milestone
  `CREATE TABLE IF NOT EXISTS relationship_milestone (
  milestone_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  t_stamp TEXT NOT NULL,
  affect_tag_json TEXT, -- JSON字符串（§17.6 affect_tag）
  evidence_refs_json TEXT NOT NULL, -- JSON字符串（§17.6 evidence_refs）
  significance REAL NOT NULL,
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §17.7 ProspectiveItem；due_time 供附录 B 索引使用
  `CREATE TABLE IF NOT EXISTS prospective_store (
  prospective_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  trigger_condition_json TEXT NOT NULL, -- JSON字符串（§17.7 trigger_condition）
  trigger_type TEXT, -- 取 §17.7 trigger_condition.type
  target_entity TEXT,
  due_time TEXT, -- 取 §17.7 trigger_condition.due_time；附录 B idx_user_status_due 需要
  status TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL, -- JSON字符串（§17.7 evidence_refs）
  updated_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §13 file_entity：字段取 §13 Dossier meta 与附录 A 用途
  `CREATE TABLE IF NOT EXISTS file_entity (
  file_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  org_id TEXT,
  agent_id TEXT,
  scope TEXT,
  source TEXT,
  media_type TEXT,
  file_name TEXT,
  mime TEXT,
  size INTEGER,
  duration INTEGER,
  upload_time TEXT,
  language_json TEXT, -- JSON字符串（§13 meta.language）
  hash TEXT,
  sensitivity_flag TEXT,
  parse_status TEXT,
  degraded_reasons_json TEXT, -- JSON字符串（§13 degraded_reasons）
  lifecycle_state TEXT,
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §13 D0：字段取 §13 D0 生成规则，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS dossier_d0 (
  file_id TEXT PRIMARY KEY, -- D0 为文件级，主键取 file_id（§13）
  user_id TEXT NOT NULL,
  title TEXT,
  summary_1line TEXT,
  summary_para TEXT,
  topics_json TEXT, -- JSON字符串（§13 D0.topics）
  key_entities_json TEXT, -- JSON字符串（§13 D0.key_entities）
  outline_refs_json TEXT, -- JSON字符串（§13 D0.outline_refs）
  embedding_file TEXT, -- §13 D0.embedding_file
  parse_status TEXT,
  lifecycle_state TEXT,
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §13 D1：字段取 §13 D1 生成规则，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS dossier_d1 (
  sec_id TEXT PRIMARY KEY, -- §13 outline_refs 使用 sec_xx 标识
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  key_points_json TEXT, -- JSON字符串（§13 D1.key_points）
  speakers_json TEXT, -- JSON字符串（§13 D1.speakers）
  entities_json TEXT, -- JSON字符串（§13 D1.entities）
  affect_tag_json TEXT, -- JSON字符串（§13 D1.affect_tag）
  embedding_sec TEXT, -- §13 D1.embedding_sec
  seg_refs_json TEXT, -- JSON字符串（§13 D1.seg_refs）
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §13 D2：字段取 §13 D2 生成规则，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS dossier_d2 (
  seg_id TEXT PRIMARY KEY, -- §13 D2 片段标识 seg_xx
  file_id TEXT NOT NULL,
  sec_id TEXT,
  user_id TEXT NOT NULL,
  t_start TEXT,
  t_end TEXT,
  caption TEXT,
  visual_desc TEXT,
  asr_text TEXT,
  ocr_text TEXT,
  speaker TEXT,
  emotion_json TEXT, -- JSON字符串（§13 D2 情感）
  entities_json TEXT, -- JSON字符串（§13 D2 实体）
  embedding_seg TEXT, -- §13 D2 每段生成向量
  evidence_refs_json TEXT, -- JSON字符串（§13 D2 写 D3 证据）
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §13 D3：复用 evidence_span 的 span_id，附录 A 仅列用途
  `CREATE TABLE IF NOT EXISTS dossier_d3 (
  span_id TEXT PRIMARY KEY, -- 复用 memory_evidence_span.span_id（§13/附录 A）
  file_id TEXT NOT NULL,
  seg_id TEXT,
  user_id TEXT NOT NULL,
  source_type TEXT,
  t_stamp TEXT,
  page_no INTEGER,
  bbox_json TEXT, -- JSON字符串（坐标/区域）
  frame_ref TEXT,
  asr_ref TEXT,
  ocr_ref TEXT,
  deletion_state TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,

  // §9.2/§9.3 deletion_job；user_id 为附录 B 索引所需，§9.3 未列
  `CREATE TABLE IF NOT EXISTS deletion_job (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, -- §9.3 未列 user_id；附录 B idx_user_state(user_id,state) 要求，按 §3 全表 user_id 约定补齐
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  state TEXT NOT NULL,
  ref_release_done TEXT, -- JSON字符串：step_id/status/idempotency_key/last_error（§9.2/§9.3）
  derived_edge_update_done TEXT, -- JSON字符串（§9.2 步骤 2）
  index_delete_done TEXT, -- JSON字符串（§9.2 步骤 3）
  content_delete_done TEXT, -- JSON字符串（§9.2 步骤 4）
  audit_shell_done TEXT, -- JSON字符串（§9.2 步骤 5）
  quota_release_done TEXT, -- JSON字符串（§9.2 步骤 6）
  audit_done TEXT, -- JSON字符串（§9.2 步骤 7）
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retry INTEGER NOT NULL DEFAULT 5,
  failed_at_state TEXT,
  last_error_json TEXT, -- JSON字符串（§9.3 last_error）
  audit_ref TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,

  // 附录 A 仅列用途：配额使用；字段取 §12 quota_usage_ratio 分项
  `CREATE TABLE IF NOT EXISTS quota_usage (
  user_id TEXT PRIMARY KEY, -- 契约未给配额表 id，取 §12 归属字段 user_id
  tenant_id TEXT,
  org_id TEXT,
  storage_bytes INTEGER,
  item_count INTEGER,
  parse_count INTEGER,
  index_count INTEGER,
  token_count INTEGER,
  storage_ratio REAL, -- §12 quota_usage_ratio.storage_ratio
  item_count_ratio REAL, -- §12
  parse_ratio REAL, -- §12
  index_ratio REAL, -- §12
  token_ratio REAL, -- §12
  updated_at TEXT,
  created_at TEXT NOT NULL
);`,

  // 附录 A 仅列用途：召回决策日志；字段取 §17.9 RecallCandidate + §6 + §8
  `CREATE TABLE IF NOT EXISTS recall_log (
  request_id TEXT NOT NULL,
  mem_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  route TEXT,
  route_rank INTEGER,
  route_score REAL,
  similarity REAL,
  importance REAL,
  recency REAL,
  decay_score REAL,
  affect_consistency REAL,
  relationship_weight REAL,
  source_reliability REAL,
  final_score REAL, -- §6 召回响应 final_score
  why_recalled_code TEXT, -- §6/§17.9 why_recalled
  injected_form TEXT,
  evidence_ref TEXT,
  recall_cache_key TEXT, -- §8.1 缓存键（附录 A 未单列缓存物理表，此处落审计）
  caller_acl_version INTEGER, -- §8.2 命中校验
  acl_hash_at_write TEXT, -- §8.2 命中校验
  resource_acl_versions_hash TEXT, -- §8.2 命中校验
  cache_expires_at TEXT, -- §8.3 TTL
  cache_hit INTEGER, -- §8.2 缓存是否命中
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, mem_id)
);`,

  // 附录 A 仅列用途：导入导出迁移包；字段取 §24/§25 迁移完整率要求
  `CREATE TABLE IF NOT EXISTS migration_package (
  package_id TEXT PRIMARY KEY, -- 契约未给字段名；作为必要主键补齐
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  package_type TEXT,
  state TEXT,
  object_count INTEGER,
  evidence_completeness REAL, -- §25 迁移包证据与血缘完整率 >= 0.95
  hash TEXT,
  created_at TEXT NOT NULL,
  exported_at TEXT,
  imported_at TEXT
);`,

  // §7.1/§7.2 写入幂等（per-item 幂等键，含 item_index 与 content_hash）
  `CREATE TABLE IF NOT EXISTS write_idempotency (
  idempotency_key TEXT PRIMARY KEY, -- §7.1 per-item 幂等键
  user_id TEXT NOT NULL, -- §3 全表 user_id 分区约定
  item_index INTEGER NOT NULL, -- §7.3 批量 item_index
  content_hash TEXT, -- 任务要求按 item 记录内容哈希（§17.1 content_hash）
  state TEXT NOT NULL, -- §7.2 processing/succeeded/failed/retryable/expired
  request_hash TEXT, -- §7.2 request_hash
  result_ref TEXT,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  processing_started_at TEXT,
  expires_at TEXT,
  audit_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,

  // §3.4 share_grant（字段逐一照契约）
  `CREATE TABLE IF NOT EXISTS share_grant (
  grant_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at TEXT,
  acl_version INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);`,
]);

// 索引 SQL（附录 B 关键索引；外加唯一索引与 §8 缓存键索引）
const indexStatements = Object.freeze([
  'CREATE INDEX IF NOT EXISTS idx_user_layer_type ON memory_item(user_id, layer, type);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_quality ON memory_item(user_id, quality_flag);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_valid ON memory_item(user_id, valid_from, valid_to);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_superseded ON memory_item(user_id, superseded_by);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_source ON memory_evidence_span(user_id, source_type, source_id);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_hash ON memory_evidence_span(user_id, content_hash);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_fulltext ON memory_evidence_span(text_excerpt);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_time ON memory_audit_log(user_id, created_at);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_object ON memory_audit_log(object_type, object_id);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_action ON memory_audit_log(user_id, action);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_status_due ON prospective_store(user_id, status, due_time);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_trigger_entity ON prospective_store(user_id, target_entity);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_user_state ON deletion_job(user_id, state);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_created ON deletion_job(created_at);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_grantee ON share_grant(grantee_user_id, resource_type, resource_id);', // 附录 B
  'CREATE INDEX IF NOT EXISTS idx_expires ON share_grant(expires_at);', // 附录 B
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_write_idempotency_key ON write_idempotency(idempotency_key);', // §7.1 per-item 幂等键唯一
  'CREATE INDEX IF NOT EXISTS idx_recall_cache_key ON recall_log(recall_cache_key);', // §8.1/§8.2 缓存键审计检索
]);

// 建表在前、索引在后，供上层按顺序执行
const statements = Object.freeze([...createTableStatements, ...indexStatements]);

module.exports = {
  TABLES,
  indexes: indexStatements,
  statements,
  createTableStatements,
  createIndexStatements: indexStatements,
};
