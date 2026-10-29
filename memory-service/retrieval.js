'use strict';

/**
 * 八路召回与主链路（§4 评分/融合/MMR、§5 预算组装、§6 召回响应、§17.9 RecallCandidate、
 * §3.5 检索谓词、§8.2 缓存命中 ACL 校验、§16.3 S3 拒绝注入）。
 *
 * 八路召回（本模块的 channel 口径）：
 *   1) vector_item       条目级向量         -> route=semantic
 *   2) vector_segment    段级向量（D1/D2）   -> route=semantic
 *   3) vector_fragment   片段级向量（证据）  -> route=semantic
 *   4) fulltext          全文索引（LIKE/FTS5）-> route=raw_bm25
 *   5) entity_graph      derived_edge 图扩展 -> route=graph
 *   6) relation          relationship_edge   -> route=affect
 *   7) temporal          valid_from/valid_to -> route=temporal
 *   8) prospective       trigger_condition/due_time -> route=prospective
 *
 * 契约正文只在 §17.9 给出 route 枚举，未给出「八路」与 route 的一一映射；
 * 上述映射是本实现的最接近口径，已在完成回复的「契约歧义与取舍」中列明。
 *
 * 确定性约束（§5.1 同输入同输出、任务要求「两次相同查询结果完全一致」）：
 *   - 内部绝不调用 Date.now()/new Date()，所有时间来自 req.now；
 *   - 所有 SQL 均显式 ORDER BY，合并/排序均带 mem_id 字典序 tie-breaker；
 *   - route_stats.duration_ms 默认恒为 0；只有调用方显式传 measure_stats=true 才记录真实耗时
 *     （此时输出不保证逐字节一致，属于可观测性开关，不参与验收比对）。
 */

const crypto = require('node:crypto');

const {
  RECALL_ROUTE,
  ROUTE_BONUS,
  SENSITIVITY,
  LIFECYCLE_STATE,
  TOKEN_BUDGET,
  MMR,
  CACHE_TTL,
  LIMITS,
} = require('./constants');
const schema = require('./schema');
const embeddingLib = require('./embedding');
const scoring = require('./scoring');
const assemble = require('./assemble');
const { parseJson } = require('./store');

// cache.js 由其他同事并行创建；接口假定为 cache.get(key) / cache.set(key, value, ttl)，
// 且缓存值需带 ACL 相关字段（§8.2）。缺失时整条缓存链路静默跳过。
let cacheModule = null;
try {
  // eslint-disable-next-line global-require
  cacheModule = require('./cache');
} catch (error) {
  cacheModule = null;
}

const RECALL_RESPONSE_SCHEMA_VERSION = 'recall_response.v4.1';
const PROPERTY_TIME_WINDOW_DAYS = 365; // 与 scoring.computeRecencyFromTimestamp 的默认窗口对齐
const DEFAULT_SENSITIVITY_MAX = SENSITIVITY.S2; // §16.3：S3 默认拒绝注入
const DEFAULT_MAX_ITEMS = 2000; // 单次召回的内存候选上限（防止全表扫描）
const SQL_IN_CHUNK = 400;

// 八路 channel 的顺序（同时作为并列时的稳定 tie-breaker）
const CHANNELS = Object.freeze([
  'vector_item',
  'vector_segment',
  'vector_fragment',
  'fulltext',
  'entity_graph',
  'relation',
  'temporal',
  'prospective',
]);

const CHANNEL_ROUTE = Object.freeze({
  vector_item: RECALL_ROUTE.SEMANTIC,
  vector_segment: RECALL_ROUTE.SEMANTIC,
  vector_fragment: RECALL_ROUTE.SEMANTIC,
  fulltext: RECALL_ROUTE.RAW_BM25,
  entity_graph: RECALL_ROUTE.GRAPH,
  relation: RECALL_ROUTE.AFFECT,
  temporal: RECALL_ROUTE.TEMPORAL,
  prospective: RECALL_ROUTE.PROSPECTIVE,
});

// why_recalled 只允许 S/A/T/V 四个前缀（§6/§17.9/§17.11 与 constants.WHY_CODE）。
const CHANNEL_WHY_CODE = Object.freeze({
  vector_item: 'S',
  vector_segment: 'S',
  vector_fragment: 'S',
  fulltext: 'S',
  entity_graph: 'A',
  relation: 'A',
  temporal: 'T',
  prospective: 'T',
});

const SENSITIVITY_RANK = Object.freeze(
  Object.keys(SENSITIVITY).reduce((acc, key, index) => {
    acc[SENSITIVITY[key]] = index;
    return acc;
  }, {})
);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined);
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of toArray(values)) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// 时间只做解析/比较，不读时钟；不可解析返回 null。
function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 契约未给默认 now 的兜底值：固定纪元，保证同输入同输出，并给出 warning。 */
const EPOCH_FALLBACK = '1970-01-01T00:00:00.000Z';

function normalizeIso(value, fallback) {
  const ms = toMs(value);
  if (ms === null) return fallback;
  return new Date(ms).toISOString();
}

function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

function chunks(list, size) {
  const output = [];
  for (let i = 0; i < list.length; i += size) output.push(list.slice(i, i + size));
  return output;
}

function normalizeQueryText(query) {
  if (typeof query !== 'string') return '';
  return query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 查询分词（中文近似）：ASCII 词按空白/标点切；CJK 连续串同时产出整体与二元组。
 * 契约要求 FTS5 不可用时用 LIKE + 中文分词近似，此处即为该近似分词器。
 */
function tokenizeTerms(query, maxTerms = 64) {
  const normalized = normalizeQueryText(query);
  if (normalized === '') return [];

  const terms = new Set();
  const segments = normalized
    .split(/[\s,，。.、；;：:!！?？"'“”‘’()（）[\]【】<>《》/\\|+*_\-~`]+/)
    .filter(Boolean);

  for (const segment of segments) {
    if (/^[a-z0-9_.@#]+$/.test(segment)) {
      if (segment.length >= 2) terms.add(segment);
      continue;
    }
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(segment)) {
      terms.add(segment);
      const chars = Array.from(segment);
      if (chars.length === 1) terms.add(segment);
      for (let i = 0; i + 1 < chars.length; i += 1) {
        terms.add(chars[i] + chars[i + 1]);
      }
      continue;
    }
    if (segment.length >= 2) terms.add(segment);
  }

  return [...terms].slice(0, maxTerms);
}

function containsAnyTerm(haystack, terms) {
  if (!haystack || terms.length === 0) return false;
  const text = normalizeQueryText(haystack);
  return terms.some((term) => text.includes(term));
}

// ---------------------------------------------------------------------------
// 作用域谓词（§3.5）与候选全集装载
// ---------------------------------------------------------------------------

const SCOPE_SESSION = 'session';
const SCOPE_USER = 'user';
const SCOPE_ORG = 'org';
const SCOPE_GLOBAL = 'global';

function normalizeScopeList(req, warnings) {
  const raw = req.scope;
  const requested = raw === undefined || raw === null || raw === ''
    ? null
    : uniqueStrings(Array.isArray(raw) ? raw : [raw]);

  const list = requested ?? [SCOPE_SESSION, SCOPE_USER].concat(
    req.tenant_id && req.org_id ? [SCOPE_ORG] : [],
    req.tenant_id ? [SCOPE_GLOBAL] : []
  );

  if (list.includes('session')) {
    // memory_item 物理表没有 session_id 列（附录 A 未列该列），
    // 无法做 session 级隔离，只能按 user_id 收窄；此处显式告警而不是静默越权。
    warnings.push({
      code: 'session_scope_isolation_unsupported',
      message: '§3.5 scope=session 需要 session_id 谓词，但 memory_item 无 session_id 列，已退化为 user_id 过滤',
    });
  }
  return list;
}

/**
 * 构造 §3.5 检索谓词。
 * org/global 作用域必须带 tenant_id/org_id，缺失时整条召回拒绝（返回 null）。
 */
function buildScopePredicate(req, warnings) {
  const scopes = normalizeScopeList(req, warnings);
  const clauses = [];
  const params = [];
  let authzDenied = false;

  for (const scope of scopes) {
    if (scope === SCOPE_SESSION) {
      if (!req.session_id) {
        warnings.push({
          code: 'session_id_missing',
          message: '§3.5 scope=session 需要 session_id；本次仅按 user_id 过滤',
        });
      }
      clauses.push(`(scope = 'session' AND user_id = ?)`);
      params.push(String(req.user_id));
      continue;
    }
    if (scope === SCOPE_USER) {
      clauses.push(`(scope = 'user' AND user_id = ?)`);
      params.push(String(req.user_id));
      continue;
    }
    if (scope === SCOPE_ORG) {
      if (!req.tenant_id || !req.org_id) {
        warnings.push({
          code: 'org_scope_requires_tenant_and_org',
          message: '§3.3/§3.5 scope=org 检索必须带 tenant_id 与 org_id',
        });
        continue;
      }
      if (typeof req.authz_role_allows === 'function') {
        let allowed = false;
        try {
          allowed = req.authz_role_allows(req.user_id, req.org_id) === true;
        } catch (error) {
          allowed = false;
        }
        if (!allowed) {
          authzDenied = true;
          continue;
        }
      }
      clauses.push(`(scope = 'org' AND tenant_id = ? AND org_id = ?)`);
      params.push(String(req.tenant_id), String(req.org_id));
      continue;
    }
    if (scope === SCOPE_GLOBAL) {
      if (!req.tenant_id) {
        warnings.push({
          code: 'global_scope_requires_tenant',
          message: '§3.3/§3.5 scope=global 检索必须带 tenant_id',
        });
        continue;
      }
      if (typeof req.authz_global_allows === 'function') {
        let allowed = false;
        try {
          allowed = req.authz_global_allows(req.user_id, req.tenant_id) === true;
        } catch (error) {
          allowed = false;
        }
        if (!allowed) {
          authzDenied = true;
          continue;
        }
      }
      if (req.org_id) {
        clauses.push(`(scope = 'global' AND tenant_id = ? AND (org_id IS NULL OR org_id = ?))`);
        params.push(String(req.tenant_id), String(req.org_id));
      } else {
        clauses.push(`(scope = 'global' AND tenant_id = ? AND org_id IS NULL)`);
        params.push(String(req.tenant_id));
      }
    }
  }

  if (clauses.length === 0) {
    if (authzDenied) {
      warnings.push({
        code: 'authz_denied',
        message: '§3.5 调用方无 org/global 读权限，拒绝检索',
      });
    }
    return null;
  }

  return { sql: clauses.join(' OR '), params };
}

/** memory_item 行 -> MemoryItem（含扁平别名，供 scoring/assemble 直接消费）。 */
function rowToItem(row, spanRefs, tombstoned) {
  const evidenceRefs = spanRefs.length > 0 ? spanRefs : [row.source_span_id];
  const structured = parseJson(row.structured_json, null);
  const tags = parseJson(row.tags_json, []);
  const entities = parseJson(row.entities_json, []);
  const qualityReasons = parseJson(row.quality_reasons_json, []);

  return {
    schema_version: row.schema_version,
    mem_id: row.mem_id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    org_id: row.org_id,
    owner_user_id: row.owner_user_id,
    agent_id: row.agent_id,
    scope: row.scope,
    layer: row.layer,
    type: row.type,
    summary_short: row.summary_short,
    summary_long: row.summary_long,
    structured,
    tags,
    entities,
    relations: parseJson(row.relations_json, []),
    embedding_refs: parseJson(row.embedding_refs_json, {}),
    raw_text_ref: row.raw_text_ref,
    media_ref: row.media_ref,
    quality: {
      importance: row.importance,
      confidence: row.confidence,
      source_reliability: row.source_reliability,
      recency: row.recency,
      access_count: row.access_count,
      decay_score: row.decay_score,
      quality_flag: row.quality_flag,
      quality_reasons: qualityReasons,
    },
    temporal: {
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      superseded_by: row.superseded_by,
      supersedes: parseJson(row.supersedes_json, []),
      version_chain: parseJson(row.version_chain_json, []),
      last_access: row.last_access,
    },
    evidence: {
      source_turns: parseJson(row.source_turns_json, []),
      source_span: row.source_span_id,
      evidence_refs: evidenceRefs,
      derived_from: parseJson(row.derived_from_json, []),
      created_at: row.created_at,
      why_recalled_log: parseJson(row.why_recalled_log_json, []),
      deletion_state: tombstoned.has(row.source_span_id) ? 'tombstone' : 'active',
    },
    affect_ext: parseJson(row.affect_ext_json, null),
    governance: {
      sensitivity: row.sensitivity,
      retention_policy: row.retention_policy,
      acl_version: row.acl_version,
      share_scope: parseJson(row.share_scope_json, []),
      audit_ref: row.audit_ref,
    },
    lifecycle_state: row.lifecycle_state,
    version: row.version,
    created_at: row.created_at,
    // 扁平别名：scoring / assemble 兼容扁平与嵌套两种形态。
    importance: row.importance,
    confidence: row.confidence,
    source_reliability: row.source_reliability,
    quality_flag: row.quality_flag,
    sensitivity: row.sensitivity,
    evidence_ref: row.source_span_id,
    evidence_refs: evidenceRefs,
  };
}

/**
 * 装载候选全集：先按 §3.5 作用域 + 生命周期过滤，再按 sensitivity 与 assertRecallable 过滤。
 * 空库/空作用域返回空 Map，不抛错。
 */
function loadUniverse(store, req, warnings) {
  const universe = {
    items: new Map(),
    // mem_id -> 条目级原始向量（供 §4.5 MMR 近重复判定；无向量时为空）
    vectors: new Map(),
    spanMem: new Map(),
    tombstoned: new Set(),
    blocked_evidence: new Set(),
    blocked_sensitivity: 0,
    truncated: false,
  };

  const predicate = buildScopePredicate(req, warnings);
  if (!predicate) return universe;

  const layers = uniqueStrings(req.layer ?? req.layers);
  const types = uniqueStrings(req.types ?? req.type);
  const maxItems = Number.isInteger(req.max_items) && req.max_items > 0
    ? req.max_items
    : DEFAULT_MAX_ITEMS;

  let sql = `SELECT * FROM memory_item
     WHERE (${predicate.sql})
       AND lifecycle_state IN ('active', 'cold_archived')`;
  const params = [...predicate.params];
  if (layers.length > 0) {
    sql += ` AND layer IN (${placeholders(layers.length)})`;
    params.push(...layers);
  }
  if (types.length > 0) {
    sql += ` AND type IN (${placeholders(types.length)})`;
    params.push(...types);
  }
  sql += ' ORDER BY mem_id LIMIT ?';
  params.push(maxItems + 1);

  let rows = [];
  try {
    rows = store.all(sql, ...params);
  } catch (error) {
    warnings.push({ code: 'universe_query_failed', message: String(error?.message ?? error) });
    return universe;
  }
  if (rows.length > maxItems) {
    rows = rows.slice(0, maxItems);
    universe.truncated = true;
    warnings.push({
      code: 'universe_truncated',
      message: `候选全集超过上限 ${maxItems}，已按 mem_id 截断`,
    });
  }

  const maxSensitivity = req.sensitivity_max ?? DEFAULT_SENSITIVITY_MAX;
  const maxRank = Number.isFinite(maxSensitivity)
    ? maxSensitivity
    : (SENSITIVITY_RANK[String(maxSensitivity).toUpperCase()] ?? SENSITIVITY_RANK[SENSITIVITY.S2]);
  const s3Allowed = req.purpose === 'safety' || req.purpose === 'audit';

  for (const row of rows) {
    const item = rowToItem(row, [], new Set());
    const rank = SENSITIVITY_RANK[String(row.sensitivity).toUpperCase()];
    if (rank !== undefined && rank > maxRank) {
      universe.blocked_sensitivity += 1;
      continue;
    }
    // §16.3：S3 默认拒绝注入；仅 purpose=safety/audit 且显式授权时可返回 pointer。
    if (rank === 3 && !s3Allowed) {
      universe.blocked_sensitivity += 1;
      continue;
    }
    try {
      schema.assertRecallable(item);
    } catch (error) {
      continue;
    }
    universe.items.set(row.mem_id, item);
  }

  const memIds = [...universe.items.keys()];
  if (memIds.length === 0) return universe;

  // 证据 span：补齐 evidence_refs（§2.3 要求 source_span 在内）并记录不可下钻集合。
  for (const chunk of chunks(memIds, SQL_IN_CHUNK)) {
    let spanRows = [];
    try {
      spanRows = store.all(
        `SELECT mem_id, span_id, deletion_state FROM memory_evidence_span
          WHERE mem_id IN (${placeholders(chunk.length)})
          ORDER BY span_id`,
        ...chunk
      );
    } catch (error) {
      warnings.push({ code: 'evidence_query_failed', message: String(error?.message ?? error) });
      break;
    }
    for (const span of spanRows) {
      const memId = span.mem_id;
      if (!universe.items.has(memId)) continue;
      universe.spanMem.set(span.span_id, memId);
      if (span.deletion_state === 'tombstone' || span.deletion_state === 'content_deleted_audit_retained') {
        universe.tombstoned.add(span.span_id);
      }
      const item = universe.items.get(memId);
      if (!item.__spanRefs) item.__spanRefs = [];
      item.__spanRefs.push(span.span_id);
    }
  }

  for (const item of universe.items.values()) {
    const refs = uniqueStrings([item.evidence.source_span, ...(item.__spanRefs ?? [])]);
    item.evidence.evidence_refs = refs;
    item.evidence_refs = refs;
    delete item.__spanRefs;
  }

  universe.blocked_evidence = universe.tombstoned;
  return universe;
}

// ---------------------------------------------------------------------------
// 八路召回：各路均「检索不到就返回空，绝不抛错」
// ---------------------------------------------------------------------------

function sortHits(hits) {
  return hits.sort((a, b) => {
    if (b.route_score !== a.route_score) return b.route_score - a.route_score;
    return a.mem_id < b.mem_id ? -1 : (a.mem_id > b.mem_id ? 1 : 0);
  });
}

function withRanks(hits, route, limit) {
  return sortHits(hits)
    .slice(0, limit)
    .map((hit, index) => ({
      mem_id: hit.mem_id,
      route,
      channel: hit.channel,
      route_rank: index + 1,
      route_score: clamp(hit.route_score, 0, 1),
      similarity: hit.similarity ?? null,
    }));
}

/** 三级向量召回（§17 三级向量 + §4.5 条目级余弦重排）。 */
function vectorChannel(store, table, channel, req, universe, queryVector) {
  const memIds = [...universe.items.keys()];
  if (memIds.length === 0 || !Array.isArray(queryVector) || queryVector.length === 0) return [];

  const route = CHANNEL_ROUTE[channel];
  const best = new Map();

  for (const chunk of chunks(memIds, SQL_IN_CHUNK)) {
    let rows = [];
    try {
      rows = store.all(
        `SELECT mem_id, vector_json, dim, acl_version FROM ${table}
          WHERE mem_id IN (${placeholders(chunk.length)})
          ORDER BY vec_id`,
        ...chunk
      );
    } catch (error) {
      // 索引表缺失或结构异常：本路返回空
      return withRanks([...best.values()], route, MMR.TOP_N);
    }

    for (const row of rows) {
      if (!row.mem_id) continue;
      const item = universe.items.get(row.mem_id);
      if (!item) continue;
      const aclVersion = Number(row.acl_version);
      const itemAcl = Number(item.governance.acl_version);
      if (Number.isFinite(aclVersion) && Number.isFinite(itemAcl) && aclVersion !== itemAcl) {
        continue; // §8.2 资源 ACL 版本不一致 -> 视为陈旧索引
      }
      const vector = parseJson(row.vector_json, null);
      if (!Array.isArray(vector) || vector.length !== queryVector.length) continue;
      let similarity = 0;
      try {
        similarity = clamp(embeddingLib.cosine(queryVector, vector), 0, 1);
      } catch (error) {
        similarity = 0;
      }
      const existing = best.get(row.mem_id);
      if (!existing || similarity > existing.route_score) {
        best.set(row.mem_id, {
          mem_id: row.mem_id,
          channel,
          route_score: similarity,
          similarity,
        });
        // 记录条目级向量，供后续 MMR 近重复判定（§4.5）
        if (channel === 'vector_item') universe.vectors.set(row.mem_id, vector);
      }
    }
  }

  return withRanks([...best.values()], route, MMR.TOP_N);
}

/** 全文召回（§16.2 / raw_bm25）。优先 FTS5（若存在镜像表），否则 LIKE + 中文分词近似。 */
const ftsProbeCache = new Map();

function hasFtsMirror(store) {
  const key = store.file ?? store.agentId ?? '__default__';
  if (ftsProbeCache.has(key)) return ftsProbeCache.get(key);
  let exists = false;
  try {
    const row = store.get(
      `SELECT name FROM sqlite_master
        WHERE (type = 'table' OR type = 'view') AND name = 'memory_fulltext_index_fts'`
    );
    exists = !!row;
  } catch (error) {
    exists = false;
  }
  ftsProbeCache.set(key, exists);
  return exists;
}

function fulltextChannel(store, req, universe, terms) {
  const memIds = [...universe.items.keys()];
  if (memIds.length === 0 || terms.length === 0) return [];

  const hits = new Map();
  const termCount = terms.length;
  const scopeSql = req.tenant_id ? ' AND (tenant_id IS NULL OR tenant_id = ?)' : '';
  const scopeParams = req.tenant_id ? [String(req.tenant_id)] : [];
  const limit = 5000;

  let rows = [];
  let usedFts = false;
  if (hasFtsMirror(store)) {
    try {
      const matchExpression = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
      rows = store.all(
        `SELECT object_type, object_id FROM memory_fulltext_index_fts
          WHERE memory_fulltext_index_fts MATCH ?
          ORDER BY rowid LIMIT ?`,
        matchExpression,
        limit
      );
      usedFts = true;
      // FTS 路径只给命中集合，分数在下方统一按词项覆盖率计算（避免依赖 bm25 实现差异）。
      const ids = new Set(rows.map((row) => `${row.object_type}\u0000${row.object_id}`));
      rows = [...ids].map((key) => {
        const [objectType, objectId] = key.split('\u0000');
        return { object_type: objectType, object_id: objectId, text_content: '' };
      });
    } catch (error) {
      usedFts = false;
      rows = [];
    }
  }

  if (!usedFts) {
    const likeClauses = terms.map(() => 'text_content LIKE ? ESCAPE \'\\\'').join(' OR ');
    const likeParams = terms.map((term) => `%${escapeLike(term)}%`);
    try {
      rows = store.all(
        `SELECT object_type, object_id, text_content FROM memory_fulltext_index
          WHERE user_id = ?${scopeSql} AND (${likeClauses})
          ORDER BY index_id LIMIT ?`,
        String(req.user_id),
        ...scopeParams,
        ...likeParams,
        limit
      );
    } catch (error) {
      return [];
    }
  }

  for (const row of rows) {
    let memId = null;
    if (row.object_type === 'memory_item') {
      memId = row.object_id;
    } else if (row.object_type === 'evidence_span') {
      memId = universe.spanMem.get(row.object_id) ?? null;
    }
    if (!memId || !universe.items.has(memId)) continue;

    const text = normalizeQueryText(row.text_content ?? '');
    let matched = 0;
    for (const term of terms) if (text.includes(term)) matched += 1;
    // FTS5 路径没有原文时按「命中即满分」的保守近似
    const score = usedFts && text === ''
      ? 1
      : (matched === 0 ? 0 : matched / termCount);
    if (score <= 0) continue;

    const existing = hits.get(memId);
    if (!existing || score > existing.route_score) {
      hits.set(memId, { mem_id: memId, channel: 'fulltext', route_score: clamp(score, 0, 1) });
    }
  }

  return withRanks([...hits.values()], CHANNEL_ROUTE.fulltext, MMR.TOP_N);
}

/** 图召回（§17.2 derived_edge 血缘扩展，最多 2 跳）。 */
function entityGraphChannel(store, req, universe, terms) {
  if (universe.items.size === 0) return [];

  const seeds = [];
  for (const item of universe.items.values()) {
    const haystack = [
      item.summary_short,
      stableStringify(item.structured ?? {}),
      item.entities.join(' '),
      item.tags.join(' '),
    ].join(' ');
    if (containsAnyTerm(haystack, terms)) seeds.push(item.mem_id);
  }

  const pinned = uniqueStrings(req.must_inject).filter((id) => universe.items.has(id));
  const seedSet = uniqueStrings([...pinned, ...seeds]).slice(0, MMR.TOP_N);

  const scores = new Map();
  for (const seed of seedSet) scores.set(seed, 1);

  if (seedSet.length === 0) return [];

  let frontier = seedSet;
  for (let hop = 1; hop <= 2 && frontier.length > 0; hop += 1) {
    const next = [];
    const hopScore = hop === 1 ? 0.75 : 0.55;
    for (const chunk of chunks(frontier, SQL_IN_CHUNK)) {
      let rows = [];
      try {
        rows = store.all(
          `SELECT from_id, to_id FROM memory_derived_edge
            WHERE user_id = ?
              AND (deletion_state IS NULL OR deletion_state = 'active')
              AND from_id IN (${placeholders(chunk.length)})
            ORDER BY edge_id`,
          String(req.user_id),
          ...chunk
        );
      } catch (error) {
        return withRanks([...scores.entries()].map(([mem_id, route_score]) => ({
          mem_id,
          channel: 'entity_graph',
          route_score,
        })), CHANNEL_ROUTE.entity_graph, MMR.TOP_N);
      }
      for (const row of rows) {
        const target = universe.items.has(row.to_id)
          ? row.to_id
          : (universe.spanMem.get(row.to_id) ?? null);
        if (!target || !universe.items.has(target)) continue;
        const existing = scores.get(target);
        if (existing === undefined || hopScore > existing) {
          scores.set(target, hopScore);
          next.push(target);
        }
      }
    }
    frontier = uniqueStrings(next);
  }

  return withRanks([...scores.entries()].map(([mem_id, route_score]) => ({
    mem_id,
    channel: 'entity_graph',
    route_score,
  })), CHANNEL_ROUTE.entity_graph, MMR.TOP_N);
}

/** 关系召回（§17.6 relationship_edge -> type=relationship 的记忆）。 */
function relationChannel(store, req, universe) {
  if (universe.items.size === 0) return [];

  let rows = [];
  try {
    if (req.agent_id) {
      rows = store.all(
        'SELECT * FROM relationship_edge WHERE user_id = ? AND agent_id = ? ORDER BY edge_id',
        String(req.user_id),
        String(req.agent_id)
      );
    } else {
      rows = store.all(
        'SELECT * FROM relationship_edge WHERE user_id = ? ORDER BY edge_id',
        String(req.user_id)
      );
    }
  } catch (error) {
    return [];
  }
  if (rows.length === 0) return [];

  const edgeWeights = new Map();
  for (const row of rows) {
    const intimacy = Number(row.intimacy) || 0;
    const trust = Number(row.trust) || 0;
    const familiarity = Number(row.familiarity) || 0;
    const weight = clamp(0.5 * intimacy + 0.3 * trust + 0.2 * familiarity, 0, 1);
    const existing = edgeWeights.get(row.target_id);
    if (existing === undefined || weight > existing) edgeWeights.set(row.target_id, weight);
  }

  const hits = [];
  for (const item of universe.items.values()) {
    // 关系路只召回 type=relationship 的条目；其余类型由其它路覆盖。
    if (item.type !== 'relationship') continue;
    const haystack = [
      stableStringify(item.structured ?? {}),
      item.entities.join(' '),
      item.summary_short,
    ].join(' ');
    for (const [targetId, weight] of edgeWeights.entries()) {
      if (haystack.includes(targetId)) {
        hits.push({ mem_id: item.mem_id, channel: 'relation', route_score: clamp(weight, 0, 1) });
        break;
      }
    }
  }

  return withRanks(hits, CHANNEL_ROUTE.relation, MMR.TOP_N);
}

/** 时间召回（§4.3 / valid_from、valid_to 时间窗口）。 */
function temporalChannel(store, req, universe, now) {
  if (universe.items.size === 0) return [];

  const range = isPlainObject(req.time_range) ? req.time_range : {};
  const startMs = toMs(range.start);
  const endMs = toMs(range.end) ?? toMs(now);
  if (endMs === null) return [];

  const hits = [];
  for (const item of universe.items.values()) {
    const fromMs = toMs(item.temporal.valid_from);
    if (fromMs === null || fromMs > endMs) continue;
    const toMsValue = toMs(item.temporal.valid_to);
    if (startMs !== null && toMsValue !== null && toMsValue < startMs) continue;
    const recency = scoring.computeRecencyFromTimestamp(
      item.temporal.valid_from,
      now,
      PROPERTY_TIME_WINDOW_DAYS
    );
    const score = recency === null ? 0 : clamp(recency, 0, 1);
    if (score <= 0) continue;
    hits.push({ mem_id: item.mem_id, channel: 'temporal', route_score: score });
  }

  return withRanks(hits, CHANNEL_ROUTE.temporal, MMR.TOP_N);
}

/** 前瞻召回（§15.2 / §17.7：trigger_condition 与 due_time 命中）。 */
function prospectiveChannel(store, req, universe, terms, now) {
  if (universe.items.size === 0) return [];

  let rows = [];
  try {
    rows = store.all(
      `SELECT * FROM prospective_store
        WHERE user_id = ? AND status IN ('pending', 'triggered')
        ORDER BY prospective_id`,
      String(req.user_id)
    );
  } catch (error) {
    return [];
  }

  const nowMs = toMs(now);
  const hits = new Map();

  for (const row of rows) {
    const dueMs = toMs(row.due_time);
    const trigger = parseJson(row.trigger_condition_json, {});
    const triggerText = stableStringify(trigger ?? {});
    const payloadText = String(row.payload ?? '');

    let score = 0;
    if (dueMs !== null && nowMs !== null && dueMs <= nowMs) score = Math.max(score, 0.9);
    if (trigger.type === 'time' && dueMs !== null && nowMs !== null && dueMs <= nowMs) {
      score = Math.max(score, 0.9);
    }
    if (containsAnyTerm(`${triggerText} ${payloadText} ${row.target_entity ?? ''}`, terms)) {
      score = Math.max(score, 0.8);
    }
    if (score === 0) continue;

    // 前瞻条目 -> 记忆条目：证据 span 映射优先，其次 target_entity / payload 词项匹配。
    const evidenceRefs = parseJson(row.evidence_refs_json, []);
    const mapped = new Set();
    for (const spanId of toArray(evidenceRefs)) {
      const memId = universe.spanMem.get(String(spanId));
      if (memId) mapped.add(memId);
    }
    if (mapped.size === 0) {
      for (const item of universe.items.values()) {
        const haystack = [
          item.summary_short,
          stableStringify(item.structured ?? {}),
          item.entities.join(' '),
        ].join(' ');
        const entity = row.target_entity;
        if (entity && haystack.includes(entity)) {
          mapped.add(item.mem_id);
          break;
        }
        if (containsAnyTerm(haystack, tokenizeTerms(payloadText))) {
          mapped.add(item.mem_id);
          break;
        }
      }
    }
    for (const memId of mapped) {
      if (!universe.items.has(memId)) continue;
      const existing = hits.get(memId);
      if (!existing || score > existing.route_score) {
        hits.set(memId, { mem_id: memId, channel: 'prospective', route_score: clamp(score, 0, 1) });
      }
    }
  }

  return withRanks([...hits.values()], CHANNEL_ROUTE.prospective, MMR.TOP_N);
}

/**
 * 用户级关系权重（§4.2 relationship_weight 维度）。
 * 从 relationship_edge 中取 target_type=user / target_id=caller 的边，权重缺省 0.5。
 */
function resolveRelationshipWeight(store, req, warnings) {
  try {
    const row = store.get(
      `SELECT intimacy, trust, familiarity FROM relationship_edge
        WHERE user_id = ? AND target_type = 'user' AND target_id = ?
        ORDER BY edge_id LIMIT 1`,
      String(req.user_id),
      String(req.user_id)
    );
    if (!row) return 0.5;
    const intimacy = Number(row.intimacy) || 0;
    const trust = Number(row.trust) || 0;
    const familiarity = Number(row.familiarity) || 0;
    return clamp(0.5 * intimacy + 0.3 * trust + 0.2 * familiarity, 0, 1);
  } catch (error) {
    warnings.push({ code: 'relationship_query_failed', message: String(error?.message ?? error) });
    return 0.5;
  }
}

// ---------------------------------------------------------------------------
// 融合、MMR、组装（§4 / §5）
// ---------------------------------------------------------------------------

function resolveQueryVector(req, warnings) {
  if (Array.isArray(req.query_vector) && req.query_vector.length > 0) {
    return req.query_vector.map(Number);
  }
  const embedder = req.use_embedder;
  if (typeof embedder === 'function') {
    try {
      const output = embedder([normalizeQueryText(req.query)]);
      if (Array.isArray(output) && Array.isArray(output[0])) return output[0].map(Number);
      if (Array.isArray(output) && typeof output[0] === 'number') return output.map(Number);
    } catch (error) {
      warnings.push({ code: 'embedder_failed', message: String(error?.message ?? error) });
    }
  } else if (embedder && typeof embedder.embedSync === 'function') {
    try {
      const output = embedder.embedSync([normalizeQueryText(req.query)]);
      if (Array.isArray(output) && Array.isArray(output[0])) return output[0].map(Number);
    } catch (error) {
      warnings.push({ code: 'embedder_failed', message: String(error?.message ?? error) });
    }
  } else if (embedder && typeof embedder.embed === 'function') {
    // 同步召回链不接受异步 embedder：返回 Promise 时回落 hashEmbedding。
    warnings.push({
      code: 'async_embedder_unsupported',
      message: 'recall 为同步链路，异步 embedder 已回落 embedding.hashEmbedding',
    });
  }
  return embeddingLib.hashEmbedding(normalizeQueryText(req.query), 1024);
}

/**
 * 合并八路结果：同一 mem_id 保留各维最高分，记录命中 route 集合与主 route。
 */
function mergeChannelHits(channelResults) {
  const merged = new Map();

  for (const channel of CHANNELS) {
    const hits = channelResults[channel] ?? [];
    for (const hit of hits) {
      const existing = merged.get(hit.mem_id);
      if (!existing) {
        merged.set(hit.mem_id, {
          mem_id: hit.mem_id,
          channels: [hit.channel],
          route_scores: { [hit.channel]: hit.route_score },
          route_ranks: { [hit.channel]: hit.route_rank },
          route: hit.route,
          best_channel: hit.channel,
          best_route_score: hit.route_score,
          similarity: hit.similarity ?? null,
        });
        continue;
      }
      if (!existing.channels.includes(hit.channel)) {
        existing.channels.push(hit.channel);
        existing.route_scores[hit.channel] = hit.route_score;
        existing.route_ranks[hit.channel] = hit.route_rank;
      } else if (hit.route_score > existing.route_scores[hit.channel]) {
        existing.route_scores[hit.channel] = hit.route_score;
        existing.route_ranks[hit.channel] = hit.route_rank;
      }
      const channelIndex = CHANNELS.indexOf(hit.channel);
      const bestIndex = CHANNELS.indexOf(existing.best_channel);
      if (
        hit.route_score > existing.best_route_score ||
        (hit.route_score === existing.best_route_score && channelIndex < bestIndex)
      ) {
        existing.best_channel = hit.channel;
        existing.route = hit.route;
        existing.best_route_score = hit.route_score;
      }
    }
  }

  return [...merged.values()].sort((a, b) => (a.mem_id < b.mem_id ? -1 : (a.mem_id > b.mem_id ? 1 : 0)));
}

/**
 * 多路 route_bonus（§4.1）：按「命中 channel」累计原始值，单路取 min(0.0200, v)，
 * 多路取 min(0.0300, sum(v))，最后统一除以 0.0300 只归一一次。
 * 注意：三个向量 channel 都映射到 semantic（原始值 0），因此不会虚增 bonus。
 */
function channelRouteBonus(channels) {
  const values = channels.map((channel) => {
    const route = CHANNEL_ROUTE[channel];
    const key = String(route).toUpperCase();
    return Number.isFinite(ROUTE_BONUS[key]) ? ROUTE_BONUS[key] : 0;
  });
  if (values.length === 0) return { raw_bonus: 0, route_bonus_norm: 0 };
  const raw = values.length === 1
    ? Math.min(ROUTE_BONUS.SINGLE_ROUTE_CAP, values[0])
    : Math.min(ROUTE_BONUS.MULTI_ROUTE_CAP, values.reduce((sum, value) => sum + value, 0));
  return { raw_bonus: raw, route_bonus_norm: raw / ROUTE_BONUS.NORMALIZER };
}

function whyCodeOf(merged, universe, relationshipWeight) {
  const codes = {};
  const add = (key, value) => {
    if (!Number.isFinite(value) || value <= 0) return;
    codes[key] = Math.max(codes[key] ?? 0, value);
  };

  for (const channel of merged.channels) {
    const routeScore = merged.route_scores[channel] ?? 0;
    const item = universe.items.get(merged.mem_id);
    if (channel === 'vector_fragment' && item?.media_ref) {
      // 视觉/媒体片段召回使用 V 前缀（§17.11 why_recalled_code）
      add('V', routeScore);
      add(CHANNEL_WHY_CODE[channel], routeScore);
      continue;
    }
    if (channel === 'relation' || channel === 'entity_graph') {
      add('A', routeScore);
      continue;
    }
    add(CHANNEL_WHY_CODE[channel], routeScore);
  }
  // 图/关系路若得分为 0，退化为用户关系权重（仍属 A 维）
  if (!codes.A && Object.keys(codes).length === 0) add('A', relationshipWeight);

  const ordered = ['S', 'A', 'T', 'V']
    .filter((key) => Number.isFinite(codes[key]) && codes[key] > 0)
    .map((key) => `${key}:${codes[key].toFixed(2)}`);
  return ordered.join('|');
}

function buildCandidates(store, mergedHits, universe, req, now, warnings) {
  const relationshipWeight = resolveRelationshipWeight(store, req, warnings);
  const scenario = req.scenario ?? 'default';
  const candidates = [];

  for (const merged of mergedHits) {
    const item = universe.items.get(merged.mem_id);
    if (!item) continue;

    const routes = uniqueStrings(merged.channels.map((channel) => CHANNEL_ROUTE[channel]));
    const bonus = channelRouteBonus(merged.channels);
    const vectorSimilarity = Math.max(
      merged.route_scores.vector_item ?? 0,
      merged.route_scores.vector_segment ?? 0,
      merged.route_scores.vector_fragment ?? 0
    );
    const recency = scoring.computeRecencyFromTimestamp(
      item.temporal.valid_from,
      now,
      PROPERTY_TIME_WINDOW_DAYS
    ) ?? 0;
    const decay = scoring.decayScore({
      importance: item.importance,
      access_count: item.quality.access_count,
      created_at: item.created_at,
      valid_from: item.temporal.valid_from,
      now,
    }).decay_score;

    const fused = scoring.fuseScore(
      {
        similarity: vectorSimilarity,
        importance: item.importance,
        recency,
        decay_score: decay,
        affect_consistency: item.type === 'affect' && merged.channels.includes('relation') ? 0.8 : 0.5,
        relationship_weight: relationshipWeight,
        source_reliability: item.quality.source_reliability,
        routes,
        route_bonus_norm: bonus.route_bonus_norm,
      },
      scenario,
      { now }
    );

    const whyCode = whyCodeOf(merged, universe, relationshipWeight);
    const candidate = {
      schema_version: 'recall_candidate.v4.1',
      mem_id: merged.mem_id,
      route: merged.route,
      route_rank: merged.route_ranks[merged.best_channel] ?? 1,
      route_score: clamp(merged.best_route_score, 0, 1),
      similarity: fused.dimensions.similarity,
      importance: fused.dimensions.importance,
      recency: fused.dimensions.recency,
      decay_score: fused.dimensions.decay_score,
      affect_consistency: fused.dimensions.affect_consistency,
      relationship_weight: fused.dimensions.relationship_weight,
      source_reliability: fused.dimensions.source_reliability,
      route_bonus: bonus.raw_bonus,
      route_bonus_norm: bonus.route_bonus_norm,
      routes,
      channels: merged.channels,
      final_score: fused.final_score,
      why_recalled_code: whyCode === '' ? null : whyCode,
      why_recalled_reason: whyCode === '' ? `route:${merged.best_channel}` : null,
      summary_short: item.summary_short,
      structured: item.structured,
      tags: item.tags,
      confidence: item.confidence,
      evidence_ref: item.evidence_ref,
      evidence_refs: item.evidence_refs,
      // 供 assemble.mmr 去重（§4.5）与文档一致性使用
      entity_key: item.structured?.entity ?? item.structured?.subject ?? null,
      predicate_key: item.structured?.predicate ?? item.structured?.attribute ?? null,
      version_chain: item.temporal.version_chain,
      // §4.5：MMR 需要原始向量做近重复判定；取条目级向量（无则 null，退化为按分数选）。
      embedding: universe.vectors.get(merged.mem_id) ?? null,
      // §8.2：缓存资源 ACL 版本
      acl_version: Number(item.governance.acl_version ?? 0),
      // 内部字段：组装阶段拼装 MemoryItem 视图
      __item: item,
    };
    candidates.push(candidate);
  }

  // §5.4 sort_by(final_score desc, mem_id asc)
  candidates.sort((a, b) => {
    if (b.final_score !== a.final_score) return b.final_score - a.final_score;
    return a.mem_id < b.mem_id ? -1 : (a.mem_id > b.mem_id ? 1 : 0);
  });

  return { candidates, relationshipWeight };
}

/**
 * buildCandidates 需要访问 store 以解析 relationship_weight；已改为显式传参，
 * 避免模块级可变状态（同输入同输出不依赖调用顺序）。
 */

// ---------------------------------------------------------------------------
// 缓存（§8.1/§8.2，可选依赖）
// ---------------------------------------------------------------------------

function computeCacheKey(req) {
  const filters = {
    types: uniqueStrings(req.types ?? req.type),
    layers: uniqueStrings(req.layer ?? req.layers),
    scope: uniqueStrings(Array.isArray(req.scope) ? req.scope : [req.scope]),
  };
  const normalized = normalizeQueryText(req.query);
  const parts = [
    req.user_id ?? '',
    req.tenant_id ?? '',
    req.org_id ?? '',
    req.session_id ?? '',
    normalized,
    stableStringify(filters),
    String(req.sensitivity_max ?? DEFAULT_SENSITIVITY_MAX),
    req.purpose ?? '',
    String(req.top_k ?? MMR.TOP_K_DEFAULT),
    req.injection_mode ?? 'two_stage',
    String(req.include_why_recalled !== false),
    String(req.affect_state_snapshot_hash ?? 'affect_off'),
    String(req.persona_version ?? ''),
    String(req.relationship_version ?? ''),
    String(req.caller_acl_version ?? 1),
    'query_norm_v1',
    CACHE_TTL.CACHE_SCHEMA_VERSION,
  ];
  return `sha256:${sha256Hex(parts.join('|'))}`;
}

function computeAclHash(req) {
  const parts = [
    req.user_id ?? '',
    req.tenant_id ?? '',
    req.org_id ?? '',
    uniqueStrings(req.roles).sort().join(','),
    String(req.sensitivity_max ?? DEFAULT_SENSITIVITY_MAX),
    req.purpose ?? '',
    uniqueStrings(req.scope_allow_list).sort().join(','),
    String(req.caller_acl_version ?? 1),
  ];
  return `sha256:${sha256Hex(parts.join('|'))}`;
}

/**
 * §8.2 命中校验：schema_version / caller_acl_version / 资源 ACL 版本 / acl_hash 全部通过才返回。
 * cache.js 缺失时直接返回 null。
 */
function readCache(store, req, warnings) {
  if (!cacheModule || typeof cacheModule.get !== 'function') return null;
  const key = computeCacheKey(req);
  let cached = null;
  try {
    cached = cacheModule.get(key);
  } catch (error) {
    return null;
  }
  if (!cached || typeof cached !== 'object' || typeof cached.then === 'function') return null;

  if (cached.cache_schema_version !== CACHE_TTL.CACHE_SCHEMA_VERSION) return null;
  if (Number(cached.caller_acl_version ?? 1) !== Number(req.caller_acl_version ?? 1)) {
    warnings.push({ code: 'cache_acl_mismatch', reason: 'caller_acl_version' });
    return null;
  }
  if (cached.acl_hash_at_write && cached.acl_hash_at_write !== computeAclHash(req)) {
    warnings.push({ code: 'cache_acl_mismatch', reason: 'acl_hash' });
    return null;
  }

  const memIds = uniqueStrings(cached.mem_ids);
  const versions = [];
  for (const chunk of chunks(memIds, SQL_IN_CHUNK)) {
    let rows = [];
    try {
      rows = store.all(
        `SELECT mem_id, acl_version, lifecycle_state FROM memory_item
          WHERE mem_id IN (${placeholders(chunk.length)}) ORDER BY mem_id`,
        ...chunk
      );
    } catch (error) {
      return null;
    }
    if (rows.length !== chunk.length) {
      warnings.push({ code: 'cache_acl_mismatch', reason: 'resource_missing' });
      return null;
    }
    for (const row of rows) {
      if (row.lifecycle_state === LIFECYCLE_STATE.DELETED_TOMBSTONE
          || row.lifecycle_state === LIFECYCLE_STATE.DELETED_PENDING
          || row.lifecycle_state === LIFECYCLE_STATE.SUPERSEDED) {
        warnings.push({ code: 'cache_acl_mismatch', reason: 'resource_not_recallable' });
        return null;
      }
      versions.push(Number(row.acl_version ?? 0));
    }
  }
  const resourceHash = `sha256:${sha256Hex(versions.sort((a, b) => a - b).join(','))}`;
  if (cached.resource_acl_versions_hash && cached.resource_acl_versions_hash !== resourceHash) {
    warnings.push({ code: 'cache_acl_mismatch', reason: 'resource_acl_versions' });
    return null;
  }

  return { key, cached };
}

function writeCache(store, req, key, response) {
  if (!cacheModule || typeof cacheModule.set !== 'function' || !key) return;
  // §8.3：S3 禁止缓存；S2 默认不缓存，仅显式开启时缓存。
  if (req.purpose === 'safety' || req.purpose === 'audit') return;
  const ttl = Number(req.cache_ttl_seconds ?? CACHE_TTL.S1_DEFAULT_SECONDS);
  const payload = {
    ...response,
    // 缓存值自带版本号（§8.2），不放覆盖 recall_response.schema_version
    cache_schema_version: CACHE_TTL.CACHE_SCHEMA_VERSION,
    caller_acl_version: Number(req.caller_acl_version ?? 1),
    acl_hash_at_write: computeAclHash(req),
    mem_ids: response.candidates.map((entry) => entry.mem_id),
    resource_acl_versions_hash: `sha256:${sha256Hex(
      response.candidates.map((entry) => Number(entry.acl_version ?? 0)).sort((a, b) => a - b).join(',')
    )}`,
  };
  try {
    cacheModule.set(key, payload, ttl);
  } catch (error) {
    // 缓存写失败不影响召回结果
  }
}

// ---------------------------------------------------------------------------
// recall 主入口
// ---------------------------------------------------------------------------

/**
 * 八路召回主链路。
 *
 * @param {object} store getStore() 返回的 store
 * @param {{query?:string, user_id:string, agent_id?:string, scope?:string|string[],
 *          tenant_id?:string, org_id?:string, session_id?:string, layer?:string|string[],
 *          types?:string|string[], top_k?:number, token_budget?:number|object,
 *          scenario?:string, now?:string, must_inject?:Array, use_embedder?:Function|object,
 *          request_id?:string, time_range?:{start?:string,end?:string},
 *          sensitivity_max?:string|number, purpose?:string, include_why_recalled?:boolean,
 *          measure_stats?:boolean, caller_acl_version?:number, query_vector?:number[],
 *          max_items?:number, cache_ttl_seconds?:number}} req
 * @returns {object} RecallResponse（§6）
 */
function recall(store, req = {}) {
  if (!store || typeof store.all !== 'function') {
    throw new TypeError('recall: store 必须由 getStore() 返回');
  }

  const warnings = [];
  if (!req.user_id) {
    return emptyResponse(req, warnings.concat([{
      code: 'missing_user_id',
      message: '§3.1 user_id 必填，召回已拒绝',
    }]));
  }

  let now = req.now;
  if (now === undefined || now === null) {
    now = EPOCH_FALLBACK;
    warnings.push({
      code: 'now_missing',
      message: '调用方未传 req.now，已使用固定纪元兜底以保证确定性',
    });
  }
  now = normalizeIso(now, EPOCH_FALLBACK);

  const requestId = req.request_id
    ?? `req_${sha256Hex([req.user_id, req.agent_id ?? '', normalizeQueryText(req.query), now].join('|')).slice(0, 24)}`;

  // 缓存读取（可选依赖；命中也要过 §8.2 ACL 校验）
  try {
    const cached = readCache(store, req, warnings);
    if (cached) {
      return {
        ...cached.cached,
        request_id: requestId,
        cache_hit: true,
      };
    }
  } catch (error) {
    warnings.push({ code: 'cache_read_failed', message: String(error?.message ?? error) });
  }

  const routeStats = {};
  for (const channel of CHANNELS) {
    routeStats[channel] = { channel, route: CHANNEL_ROUTE[channel], hits: 0, duration_ms: 0 };
  }

  const universe = loadUniverse(store, req, warnings);
  const terms = tokenizeTerms(req.query);
  const queryVector = resolveQueryVector(req, warnings);
  const measure = req.measure_stats === true;

  function runChannel(channel, fn) {
    const started = measure ? process.hrtime.bigint() : null;
    let hits = [];
    try {
      hits = fn() ?? [];
    } catch (error) {
      // 单路失败绝不影响整体召回（降级为空结果 + warning）
      hits = [];
      routeStats[channel].error = 'route_failed';
      warnings.push({ code: `route_failed:${channel}`, message: String(error?.message ?? error) });
    }
    routeStats[channel].hits = hits.length;
    if (measure && started !== null) {
      routeStats[channel].duration_ms = Number(process.hrtime.bigint() - started) / 1e6;
    }
    return hits;
  }

  let channelResults;
  let candidates;
  try {
    channelResults = {
      vector_item: runChannel('vector_item', () => vectorChannel(
        store, 'memory_vector_index_item', 'vector_item', req, universe, queryVector
      )),
      vector_segment: runChannel('vector_segment', () => vectorChannel(
        store, 'memory_vector_index_segment', 'vector_segment', req, universe, queryVector
      )),
      vector_fragment: runChannel('vector_fragment', () => vectorChannel(
        store, 'memory_vector_index_fragment', 'vector_fragment', req, universe, queryVector
      )),
      fulltext: runChannel('fulltext', () => fulltextChannel(store, req, universe, terms)),
      entity_graph: runChannel('entity_graph', () => entityGraphChannel(store, req, universe, terms)),
      relation: runChannel('relation', () => relationChannel(store, req, universe)),
      temporal: runChannel('temporal', () => temporalChannel(store, req, universe, now)),
      prospective: runChannel('prospective', () => prospectiveChannel(store, req, universe, terms, now)),
    };

    const merged = mergeChannelHits(channelResults);
    const built = buildCandidates(store, merged, universe, req, now, warnings);
    candidates = built.candidates;
  } finally {
    // 释放本次召回持有的中间状态（当前无模块级状态；保留结构以便后续扩展）
  }

  // §4.5 MMR 去冗余（lambda=0.72 / top_n=30 / duplicate_threshold=0.88）。
  const topK = Number.isInteger(req.top_k) && req.top_k >= 0
    ? Math.max(0, req.top_k)
    : MMR.TOP_K_DEFAULT;
  const mmrCandidates = scoring.mmrSelect(
    candidates.map((candidate) => ({
      ...candidate,
      relevance: candidate.final_score,
    })),
    topK
  );

  // assemble 需要 MemoryItem 视图 + 各维分数；去掉内部字段避免进入响应。
  const assembledInputs = mmrCandidates.map((candidate) => {
    const item = candidate.__item;
    const plain = { ...candidate };
    delete plain.__item;
    delete plain.embedding;
    return {
      ...item,
      ...plain,
      // 平铺字段优先级高于 item 视图，保证 why/final_score/表单目标一致
      mem_id: plain.mem_id,
      final_score: plain.final_score,
      why_recalled: parseWhyCode(plain.why_recalled_code),
      why_recalled_code: plain.why_recalled_code,
      why_recalled_reason: plain.why_recalled_reason,
    };
  });

  const assembled = assemble.assembleContext({
    candidates: assembledInputs,
    budget: req.token_budget ?? {
      window: TOKEN_BUDGET.DEFAULT_WINDOW,
    },
    must_inject: req.must_inject,
    now,
    scenario: req.scenario ?? 'default',
    include_why_recalled: req.include_why_recalled !== false,
    context: {
      caller_sensitivity_max: sensitivityRankOf(req.sensitivity_max ?? DEFAULT_SENSITIVITY_MAX),
      tombstoned_evidence: universe.tombstoned,
      deleted_evidence: universe.blocked_evidence,
    },
  });

  // §16.3 S3 矩阵：即使用户显式授权（purpose=safety/audit + sensitivity_max=S3），
  // 也只允许 pointer 注入，绝不把 S3 正文/摘要渲染进上下文。
  const s3Ids = new Set();
  for (const item of assembledInputs) {
    const sensitivity = String(item.sensitivity ?? item.governance?.sensitivity ?? '').toUpperCase();
    if (sensitivity === 'S3') s3Ids.add(item.mem_id);
  }
  if (s3Ids.size > 0 && assembled.selected.some((entry) => s3Ids.has(entry.mem_id) && entry.injected_form !== 'pointer')) {
    const renderContext = {
      caller_sensitivity_max: sensitivityRankOf(req.sensitivity_max ?? DEFAULT_SENSITIVITY_MAX),
      tombstoned_evidence: universe.tombstoned,
      deleted_evidence: universe.blocked_evidence,
    };
    const itemById = new Map(assembledInputs.map((item) => [item.mem_id, item]));
    let used = assembled.used_tokens;
    const selected = assembled.selected.map((entry) => {
      if (!s3Ids.has(entry.mem_id) || entry.injected_form === 'pointer') return entry;
      const item = itemById.get(entry.mem_id);
      used -= entry.tokens;
      if (!item) return { ...entry, injected_form: 'pointer', tokens: 0, content: null };
      const pointer = assemble.renderForm(item, 'pointer', {
        include_why_recalled: req.include_why_recalled !== false,
        context: renderContext,
      });
      used += pointer.tokens;
      return { ...pointer, form_downgraded: true, s3_pointer_only: true };
    });
    assembled.selected = selected;
    assembled.pointers = selected.filter((entry) => entry.injected_form === 'pointer');
    assembled.used_tokens = Math.max(0, used);
    assembled.pointer_ratio = assemble.computePointerRatio(selected);
    assembled.degraded = true;
    assembled.degraded_reasons = [...(assembled.degraded_reasons ?? []), 's3_pointer_only'];
  }

  const degraded = assembled.degraded || warnings.some((warning) => {
    const code = String(warning.code ?? '');
    return code.startsWith('route_failed:') || code.endsWith('_failed');
  });

  const response = {
    ok: true,
    schema_version: RECALL_RESPONSE_SCHEMA_VERSION,
    request_id: requestId,
    route_stats: routeStats,
    candidates: assembledInputs,
    selected: assembled.selected,
    dropped: assembled.dropped,
    pointers: assembled.pointers,
    used_tokens: assembled.used_tokens,
    budget: assembled.budget,
    evidence_completeness: assembled.evidence_completeness,
    degraded,
    warnings: [...warnings, ...assembled.warnings],
    candidate_count: assembledInputs.length,
    pointer_ratio: assembled.pointer_ratio,
    cache_hit: false,
  };

  try {
    writeCache(store, req, computeCacheKey(req), response);
  } catch (error) {
    // 缓存写失败不影响召回
  }

  return response;
}

function parseWhyCode(code) {
  if (typeof code !== 'string' || code.trim() === '') return null;
  const result = {};
  for (const part of code.split('|')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = Number(part.slice(index + 1).trim());
    if (key && Number.isFinite(value)) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function sensitivityRankOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return SENSITIVITY_RANK[String(value).toUpperCase()] ?? SENSITIVITY_RANK[DEFAULT_SENSITIVITY_MAX];
}

function emptyResponse(req, warnings) {
  const emptyBudget = assemble.allocateBudget(TOKEN_BUDGET.DEFAULT_WINDOW);
  const routeStats = {};
  for (const channel of CHANNELS) {
    routeStats[channel] = { channel, route: CHANNEL_ROUTE[channel], hits: 0, duration_ms: 0 };
  }
  return {
    ok: true,
    schema_version: RECALL_RESPONSE_SCHEMA_VERSION,
    request_id: req.request_id ?? null,
    route_stats: routeStats,
    candidates: [],
    selected: [],
    dropped: [],
    pointers: [],
    used_tokens: 0,
    budget: emptyBudget,
    evidence_completeness: 0,
    degraded: true,
    warnings,
    candidate_count: 0,
    pointer_ratio: 0,
    cache_hit: false,
  };
}

module.exports = {
  recall,
  // 以下为辅助导出，便于自检与后续模块复用（不是本任务要求的对外契约面）
  tokenizeTerms,
  loadUniverse,
  computeCacheKey,
  computeAclHash,
  CHANNELS,
  CHANNEL_ROUTE,
};
