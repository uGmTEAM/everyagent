'use strict';

/**
 * 记忆写入流水线。
 *
 * 契约依据：
 *   §2     MemoryItem / 最小必填集 / §2.3 source_span 与 evidence_refs 关系 /
 *          §2.4 quality_flag 与 quality_reasons / §2.5 状态组合矩阵；
 *   §3     §3.1 字段语义、§3.2 scope 与 org/tenant/share_scope 一致性；
 *   §7     §7.1 per-item 幂等键、§7.2 fencing_token 状态机、§7.3 批量 200/207/422；
 *   §9.1   evidence_span 引用计数 ref_count；
 *   §17.1  EvidenceSpan、§17.2 DerivedEdge、§17.3 AuditEvent；
 *   附录 C 冲突覆盖规则（同实体同谓词、superseded 与 cold_archived 互斥、M4 不自动覆盖）。
 *
 * 硬约束：
 *   - 只复用基线模块，不修改 constants/schema/ddl/store/tokenizer/embedding/scoring/assemble；
 *   - 批量逐条提交：一条失败不影响其他条，全部成功 200 / 部分成功 207 / 全部失败 422；
 *   - 成功条目必须同时写 memory_item、memory_evidence_span、三级向量
 *     （item/segment/fragment）、memory_fulltext_index、memory_derived_edge；
 *   - audit.js 正由其他同事并行创建，此处用可选 require，绝不硬依赖。
 */

const crypto = require('node:crypto');

const {
  SCHEMA_VERSION,
  SCOPE,
  LAYER,
  MEMORY_TYPE,
  QUALITY_FLAG,
  SENSITIVITY,
  LIFECYCLE_STATE,
  AUDIT_ACTION,
  ERROR_CODE,
  WRITE_IDEMPOTENCY,
  LIMITS,
} = require('./constants');
const schema = require('./schema');
const embeddingLib = require('./embedding');
const { parseJson, toJson, nowIso } = require('./store');

// §17.1 / §17.2 子 schema 版本（与 schema.js 中 EvidenceSpan / DerivedEdge 的 enum 对齐）
const EVIDENCE_SPAN_SCHEMA_VERSION = 'evidence_span.v4.1';
const DERIVED_EDGE_SCHEMA_VERSION = 'derived_edge.v4.1';

// 契约未给默认值的两处，取可配置默认并在返回值中记录（见文件末尾「建议追加常量」说明）。
const DEFAULT_SENSITIVITY = SENSITIVITY.S1;
const DEFAULT_LAYER = LAYER.M3;
const DEFAULT_EMBEDDING_DIM = 1024;
const DEFAULT_SOURCE_TYPE = 'dialogue_turn';

// audit.js 可选加载：并行开发期间可能尚不存在。
let auditModule = null;
try {
  // eslint-disable-next-line global-require
  auditModule = require('./audit');
} catch (error) {
  auditModule = null;
}

// §9.1 ref_event 明细表未在附录 A 单列；本实现只用 memory_evidence_span.ref_count 做原子增减。

// ---------------------------------------------------------------------------
// 基础工具（全部确定性、无 Date.now、无随机）
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined);
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function numberOr(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function integerOr(value, fallback) {
  const parsed = numberOr(value, fallback);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

// 时间统一归一为 ISO 字符串；不可解析时保留原值，避免静默篡改调用方数据。
// （§5.1 要求同输入同输出，因此所有时间都由入参注入，不在此处读系统时钟。）
function normalizeTimestamp(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    return value;
  }
  return fallback;
}

function addSecondsIso(iso, seconds) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + Math.max(0, seconds) * 1000).toISOString();
}

function addDaysIso(iso, days) {
  return addSecondsIso(iso, days * 86400);
}

function failure(code, field, message) {
  return { ok: false, code, field, message };
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of toArray(values)) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function jsonOf(storeLibToJson, value) {
  if (value === undefined) return null;
  return storeLibToJson(value);
}

// ---------------------------------------------------------------------------
// content_hash 与幂等键（§7.1）
// ---------------------------------------------------------------------------

/**
 * 条目内容哈希。用于 per-item 幂等键与 evidence_span.content_hash。
 * 只对「会改变语义」的字段取哈希，避免 created_at/now 造成重放不幂等。
 */
function computeContentHash(source = {}) {
  const payload = stableStringify({
    type: source.type ?? '',
    summary_short: source.summary_short ?? '',
    summary_long: source.summary_long ?? '',
    structured: source.structured ?? null,
    tags: source.tags ?? [],
    source_turn_id: source.source_turn_id ?? '',
  });
  return `sha256:${sha256Hex(payload)}`;
}

/**
 * §7.1 幂等键（per-item）。
 *
 * 契约原文公式：
 *   sha256(user_id | agent_id | event_id | item_i.source_turn_id | extractor_version | memory_item.v4.1)
 *
 * 【已知缺陷】原文公式不含 item_index 与 content_hash：同一批 items 若共用同一 event_id /
 * source_turn_id，则所有 item 会算出同一个幂等键，批量写入退化为「只有第一条生效」。
 * 本实现以 per-item 为准，在摘要中并入 item_index 与 content_hash（并把 operation 一并纳入，
 * 便于写/更新等不同操作互不串扰），这是对契约缺陷的显式修正，不是自创语义。
 *
 * @param {{user_id?:string, agent_id?:string, source_turn_id?:string,
 *          item_index?:number, content_hash?:string, operation?:string}} input
 * @returns {string} `sha256:<hex>`
 */
function idempotencyKey(input = {}) {
  const parts = [
    input.user_id ?? '',
    input.agent_id ?? '',
    input.source_turn_id ?? '',
    String(integerOr(input.item_index, 0)),
    input.content_hash ?? '',
    input.operation ?? 'write',
    SCHEMA_VERSION,
  ];
  return `sha256:${sha256Hex(parts.join('|'))}`;
}

// ---------------------------------------------------------------------------
// §2 MemoryItem 归一化
// ---------------------------------------------------------------------------

/**
 * §2.3：source_span 与 evidence_refs 的四种组合归一化。
 * 规则 5（都给但 source_span 不在 evidence_refs 中）按契约返回 400 专用错误码，
 * 不做静默补齐，避免掩盖上游抽取错误。
 */
function normalizeEvidenceRefs(sourceSpan, evidenceRefs) {
  const refs = uniqueStrings(evidenceRefs);
  const span = sourceSpan === null || sourceSpan === undefined || sourceSpan === ''
    ? null
    : String(sourceSpan);

  if (span && refs.length > 0) {
    if (!refs.includes(span)) {
      return {
        ok: false,
        code: ERROR_CODE.EVIDENCE_REFS_MISSING_SOURCE_SPAN,
        field: 'evidence.evidence_refs',
        message: '§2.3 evidence_refs 必须包含 source_span',
      };
    }
    return { ok: true, source_span: span, evidence_refs: refs };
  }
  if (span && refs.length === 0) {
    // §2.3 规则 3：只给 source_span -> evidence_refs=[source_span]
    return { ok: true, source_span: span, evidence_refs: [span] };
  }
  if (!span && refs.length > 0) {
    // §2.3 规则 4：只给 evidence_refs -> source_span=evidence_refs[0]
    return { ok: true, source_span: refs[0], evidence_refs: refs };
  }
  return { ok: true, source_span: null, evidence_refs: [] };
}

/**
 * §3.1/§3.2：scope 与 org_id/tenant_id/share_scope 一致性约束。
 * 违反返回 400 invalid_scope_org_combination。
 */
function normalizeScopeFields({ scope, tenantId, orgId, shareScope, shareProvided }) {
  const allowedScopes = Object.values(SCOPE);
  if (!allowedScopes.includes(scope)) {
    return {
      ok: false,
      code: ERROR_CODE.INVALID_ENUM,
      field: 'identity.scope',
      message: `scope 取值 ${JSON.stringify(scope)} 不在合法枚举内: ${allowedScopes.join(' | ')}`,
    };
  }

  const tenant = tenantId === undefined || tenantId === null || tenantId === '' ? null : String(tenantId);
  const org = orgId === undefined || orgId === null || orgId === '' ? null : String(orgId);
  let share = uniqueStrings(shareScope);

  if (scope === SCOPE.SESSION || scope === SCOPE.USER) {
    // §3.2：scope=user/session -> org_id 必须 NULL，share_scope 必须 []
    if (org !== null) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_SCOPE_ORG_COMBINATION,
        field: 'identity.org_id',
        message: `§3.2 scope=${scope} 时 org_id 必须为 NULL`,
      };
    }
    if (shareProvided && share.length > 0) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_SCOPE_ORG_COMBINATION,
        field: 'governance.share_scope',
        message: `§3.2 scope=${scope} 时 share_scope 必须为 []`,
      };
    }
    share = [];
  } else if (scope === SCOPE.ORG) {
    // §3.2：scope=org -> org_id/tenant_id 必填，share_scope 必须包含 "org"
    if (org === null || tenant === null) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_SCOPE_ORG_COMBINATION,
        field: 'identity.org_id',
        message: '§3.2 scope=org 时 org_id 与 tenant_id 必填',
      };
    }
    if (shareProvided && !share.includes('org')) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_SCOPE_ORG_COMBINATION,
        field: 'governance.share_scope',
        message: '§3.2 scope=org 时 share_scope 必须包含 "org"',
      };
    }
    if (!share.includes('org')) share.push('org');
  } else if (scope === SCOPE.GLOBAL) {
    // §3.2：scope=global -> tenant_id 必填；share_scope 必须包含 "global"
    if (tenant === null) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_SCOPE_ORG_COMBINATION,
        field: 'identity.tenant_id',
        message: '§3.2 scope=global 时 tenant_id 必填',
      };
    }
    if (shareProvided && !share.includes('global')) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_SCOPE_ORG_COMBINATION,
        field: 'governance.share_scope',
        message: '§3.2 scope=global 时 share_scope 必须包含 "global"',
      };
    }
    if (!share.includes('global')) share.push('global');
  }

  return { ok: true, tenant_id: tenant, org_id: org, share_scope: share };
}

/**
 * 归一化 MemoryItem：补默认值、生成 mem_id、补 schema_version / created_at / version /
 * lifecycle_state，并把 source_span 归一化进 evidence_refs（§2.3）。
 * 归一化后强制调用 schema.validateMemoryItem；失败返回 {ok:false, code, field, message}。
 *
 * 支持的入参形态：
 *   1) §2.1 嵌套 Canonical Schema（推荐）；
 *   2) 扁平便捷形态（mem_id / type / summary_short / structured 等顶层字段）；
 *   3) §7.3 请求 item 的最小形态（content 为字符串，配合 context 的 user_id/agent_id/now）。
 *
 * @param {object} input
 * @param {{agentId?:string, userId?:string, scope?:string, tenantId?:string, orgId?:string,
 *          now?:string|number|Date, sessionId?:string, itemIndex?:number,
 *          sourceTurnId?:string, embedder?:object|Function}} [options]
 * @returns {{ok:true, item:object, content_hash:string, defaults_applied:string[]}
 *          | {ok:false, code:string, field:string, message:string}}
 */
function normalizeMemoryItem(input, options = {}) {
  if (!isPlainObject(input)) {
    return failure(ERROR_CODE.INVALID_PAYLOAD, '$object', 'MemoryItem 必须是普通对象');
  }

  const defaultsApplied = [];
  const noteDefault = (name) => {
    if (!defaultsApplied.includes(name)) defaultsApplied.push(name);
  };

  const identitySrc = isPlainObject(input.identity) ? input.identity : {};
  const rawContent = input.content;
  const contentSrc = isPlainObject(rawContent) ? rawContent : {};
  const contentText = typeof rawContent === 'string'
    ? rawContent
    : (typeof input.text === 'string'
      ? input.text
      : (typeof input.raw_text === 'string' ? input.raw_text : null));

  const now = normalizeTimestamp(
    options.now ?? input.timestamp ?? options.timestamp,
    nowIso()
  );
  if (options.now === undefined && input.timestamp === undefined) noteDefault('evidence.created_at');

  // ---- identity ----
  const userId = identitySrc.user_id ?? input.user_id ?? options.userId ?? options.user_id ?? null;
  if (userId === null || String(userId) === '') {
    return failure(ERROR_CODE.INVALID_PAYLOAD, 'identity.user_id', '§2.2 identity.user_id 必填');
  }
  const agentId = identitySrc.agent_id ?? input.agent_id ?? options.agentId ?? options.agent_id ?? null;
  if (agentId === null || String(agentId) === '') {
    return failure(ERROR_CODE.INVALID_PAYLOAD, 'identity.agent_id', '§2.2 identity.agent_id 必填');
  }

  const scope = identitySrc.scope ?? input.scope ?? options.scope ?? SCOPE.USER;
  if ((identitySrc.scope ?? input.scope ?? options.scope) === undefined) noteDefault('identity.scope');

  const layer = identitySrc.layer ?? input.layer ?? DEFAULT_LAYER;
  if ((identitySrc.layer ?? input.layer) === undefined) noteDefault('identity.layer');

  const type = identitySrc.type ?? input.type ?? null;
  if (type === null) {
    return failure(ERROR_CODE.INVALID_PAYLOAD, 'identity.type', '§2.2 identity.type 必填');
  }
  if (!Object.values(MEMORY_TYPE).includes(type)) {
    return failure(
      ERROR_CODE.INVALID_ENUM,
      'identity.type',
      `type 取值 ${JSON.stringify(type)} 不在合法枚举内: ${Object.values(MEMORY_TYPE).join(' | ')}`
    );
  }
  if (!Object.values(LAYER).includes(layer)) {
    return failure(
      ERROR_CODE.INVALID_ENUM,
      'identity.layer',
      `layer 取值 ${JSON.stringify(layer)} 不在合法枚举内: ${Object.values(LAYER).join(' | ')}`
    );
  }

  // ---- content ----
  const summaryShort = contentSrc.summary_short
    ?? input.summary_short
    ?? contentText
    ?? null;
  if (typeof summaryShort !== 'string' || summaryShort.trim() === '') {
    return failure(
      ERROR_CODE.INVALID_PAYLOAD,
      'content.summary_short',
      '§2.2 content.summary_short 必填且不能为空'
    );
  }

  const summaryLong = contentSrc.summary_long
    ?? input.summary_long
    ?? (contentText && contentText !== summaryShort ? contentText : null);
  const structured = isPlainObject(contentSrc.structured)
    ? contentSrc.structured
    : (isPlainObject(input.structured) ? input.structured : null);
  const tags = uniqueStrings(contentSrc.tags ?? input.tags);
  const entities = toArray(contentSrc.entities ?? input.entities);
  const relations = toArray(contentSrc.relations ?? input.relations);
  const embeddingRefsSrc = isPlainObject(contentSrc.embedding_refs)
    ? contentSrc.embedding_refs
    : (isPlainObject(input.embedding_refs) ? input.embedding_refs : {});

  // ---- evidence ----
  const evidenceSrc = isPlainObject(input.evidence) ? input.evidence : {};
  const refsResult = normalizeEvidenceRefs(
    evidenceSrc.source_span ?? input.source_span,
    evidenceSrc.evidence_refs ?? input.evidence_refs
  );
  if (!refsResult.ok) return refsResult;

  const sourceTurns = uniqueStrings(
    (evidenceSrc.source_turns ?? input.source_turns) !== undefined
      ? (evidenceSrc.source_turns ?? input.source_turns)
      : (options.sourceTurnId ? [options.sourceTurnId] : [])
  );
  const derivedFrom = uniqueStrings(evidenceSrc.derived_from ?? input.derived_from ?? []);
  const evidenceCreatedAt = normalizeTimestamp(
    evidenceSrc.created_at ?? input.created_at,
    now
  );
  const whyRecalledLog = toArray(evidenceSrc.why_recalled_log ?? input.why_recalled_log);

  // ---- quality ----
  const qualitySrc = isPlainObject(input.quality) ? input.quality : {};
  const importance = numberOr(qualitySrc.importance ?? input.importance, 0.5);
  const confidence = numberOr(qualitySrc.confidence ?? input.confidence, 0.5);
  const sourceReliability = numberOr(qualitySrc.source_reliability ?? input.source_reliability, 0.5);
  const recency = numberOr(qualitySrc.recency ?? input.recency, undefined);
  const accessCount = integerOr(qualitySrc.access_count ?? input.access_count, 0);
  const decayScore = numberOr(qualitySrc.decay_score ?? input.decay_score, undefined);
  const qualityFlag = qualitySrc.quality_flag ?? input.quality_flag ?? QUALITY_FLAG.NORMAL;
  if ((qualitySrc.quality_flag ?? input.quality_flag) === undefined) noteDefault('quality.quality_flag');
  const qualityReasons = toArray(qualitySrc.quality_reasons ?? input.quality_reasons);
  if (importance === 0.5 && qualitySrc.importance === undefined && input.importance === undefined) {
    noteDefault('quality.importance');
  }
  if (confidence === 0.5 && qualitySrc.confidence === undefined && input.confidence === undefined) {
    noteDefault('quality.confidence');
  }
  if (sourceReliability === 0.5
      && qualitySrc.source_reliability === undefined
      && input.source_reliability === undefined) {
    noteDefault('quality.source_reliability');
  }

  // ---- temporal ----
  const temporalSrc = isPlainObject(input.temporal) ? input.temporal : {};
  const validFrom = normalizeTimestamp(temporalSrc.valid_from ?? input.valid_from, now);
  if (temporalSrc.valid_from === undefined && input.valid_from === undefined) {
    noteDefault('temporal.valid_from');
  }
  const validTo = temporalSrc.valid_to ?? input.valid_to ?? null;
  const supersededBy = temporalSrc.superseded_by ?? input.superseded_by ?? null;
  const supersedes = uniqueStrings(temporalSrc.supersedes ?? input.supersedes);
  const versionChain = uniqueStrings(temporalSrc.version_chain ?? input.version_chain);
  const lastAccess = normalizeTimestamp(temporalSrc.last_access ?? input.last_access, null);

  // ---- governance ----
  const governanceSrc = isPlainObject(input.governance) ? input.governance : {};
  const sensitivity = governanceSrc.sensitivity ?? input.sensitivity ?? DEFAULT_SENSITIVITY;
  if ((governanceSrc.sensitivity ?? input.sensitivity) === undefined) {
    noteDefault('governance.sensitivity');
  }
  if (!Object.values(SENSITIVITY).includes(sensitivity)) {
    return failure(
      ERROR_CODE.INVALID_ENUM,
      'governance.sensitivity',
      `sensitivity 取值 ${JSON.stringify(sensitivity)} 不在合法枚举内: ${Object.values(SENSITIVITY).join(' | ')}`
    );
  }
  const aclVersion = integerOr(governanceSrc.acl_version ?? input.acl_version, 1);
  if ((governanceSrc.acl_version ?? input.acl_version) === undefined) {
    noteDefault('governance.acl_version');
  }
  const shareProvided = (governanceSrc.share_scope ?? input.share_scope) !== undefined;
  const shareResult = normalizeScopeFields({
    scope,
    tenantId: identitySrc.tenant_id ?? input.tenant_id ?? options.tenantId ?? options.tenant_id,
    orgId: identitySrc.org_id ?? input.org_id ?? options.orgId ?? options.org_id,
    shareScope: governanceSrc.share_scope ?? input.share_scope,
    shareProvided,
  });
  if (!shareResult.ok) return shareResult;
  if (!shareProvided) noteDefault('governance.share_scope');

  // ---- mem_id 与 version_chain ----
  const contentHash = computeContentHash({
    type,
    summary_short: summaryShort,
    summary_long: summaryLong,
    structured,
    tags,
    source_turn_id: options.sourceTurnId ?? input.source_turn_id ?? '',
  });

  const explicitMemId = identitySrc.mem_id ?? input.mem_id ?? null;
  const memId = explicitMemId !== null && String(explicitMemId) !== ''
    ? String(explicitMemId)
    : `mem_${sha256Hex([
      String(userId),
      String(agentId),
      String(options.sourceTurnId ?? input.source_turn_id ?? ''),
      String(integerOr(options.itemIndex ?? input.item_index, 0)),
      contentHash,
      now,
    ].join('|')).slice(0, 24)}`;
  if (explicitMemId === null || String(explicitMemId) === '') noteDefault('identity.mem_id');

  const finalVersionChain = versionChain.length > 0 ? versionChain : [memId];
  if (versionChain.length === 0) noteDefault('temporal.version_chain');

  const ownerUserId = identitySrc.owner_user_id
    ?? input.owner_user_id
    ?? ((scope === SCOPE.USER || scope === SCOPE.SESSION) ? String(userId) : null);

  const lifecycleState = input.lifecycle_state ?? LIFECYCLE_STATE.ACTIVE;
  if (input.lifecycle_state === undefined) noteDefault('lifecycle_state');
  if (!Object.values(LIFECYCLE_STATE).includes(lifecycleState)) {
    return failure(
      ERROR_CODE.INVALID_ENUM,
      'lifecycle_state',
      `lifecycle_state 取值 ${JSON.stringify(lifecycleState)} 不在合法枚举内`
    );
  }

  const version = integerOr(input.version, 1);
  if (input.version === undefined) noteDefault('version');

  const item = {
    schema_version: SCHEMA_VERSION,
    identity: {
      mem_id: memId,
      user_id: String(userId),
      tenant_id: shareResult.tenant_id,
      org_id: shareResult.org_id,
      owner_user_id: ownerUserId === null ? null : String(ownerUserId),
      agent_id: String(agentId),
      scope,
      layer,
      type,
    },
    content: {
      summary_short: summaryShort,
      summary_long: summaryLong === null || summaryLong === undefined ? null : String(summaryLong),
      structured: structured === null ? null : structured,
      tags,
      entities,
      relations,
      embedding_refs: {
        item: embeddingRefsSrc.item ?? `vec_${memId}_item`,
        segment: embeddingRefsSrc.segment ?? null,
        fragment: embeddingRefsSrc.fragment ?? null,
      },
      raw_text_ref: contentSrc.raw_text_ref ?? input.raw_text_ref ?? refsResult.source_span,
      media_ref: contentSrc.media_ref ?? input.media_ref ?? null,
    },
    quality: {
      importance,
      confidence,
      source_reliability: sourceReliability,
      recency: recency === undefined ? null : recency,
      access_count: accessCount,
      decay_score: decayScore === undefined ? null : decayScore,
      quality_flag: qualityFlag,
      quality_reasons: qualityReasons,
    },
    temporal: {
      valid_from: validFrom,
      valid_to: validTo,
      superseded_by: supersededBy,
      supersedes,
      version_chain: finalVersionChain,
      last_access: lastAccess,
    },
    evidence: {
      source_turns: sourceTurns,
      source_span: refsResult.source_span,
      evidence_refs: refsResult.evidence_refs,
      derived_from: derivedFrom,
      created_at: evidenceCreatedAt,
      why_recalled_log: whyRecalledLog,
    },
    affect_ext: isPlainObject(input.affect_ext) ? input.affect_ext : null,
    governance: {
      sensitivity,
      retention_policy: governanceSrc.retention_policy ?? input.retention_policy ?? null,
      acl_version: aclVersion,
      share_scope: shareResult.share_scope,
      audit_ref: governanceSrc.audit_ref ?? input.audit_ref ?? null,
    },
    lifecycle_state: lifecycleState,
    version,
    // 顶层 created_at 仅供物理表使用，schema 校验只读取 evidence.created_at。
    created_at: evidenceCreatedAt,
  };

  const validation = schema.validateMemoryItem(item);
  if (!validation.ok) {
    return failure(validation.code, validation.field, validation.message);
  }

  return {
    ok: true,
    item,
    content_hash: contentHash,
    defaults_applied: defaultsApplied,
  };
}

// ---------------------------------------------------------------------------
// DB 行 ↔ MemoryItem（冲突判定与 supersede 用）
// ---------------------------------------------------------------------------

function rowToMemoryItem(row) {
  if (!row) return null;
  return {
    schema_version: row.schema_version,
    mem_id: row.mem_id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    org_id: row.org_id,
    agent_id: row.agent_id,
    scope: row.scope,
    layer: row.layer,
    type: row.type,
    summary_short: row.summary_short,
    summary_long: row.summary_long,
    structured: parseJson(row.structured_json, null),
    tags: parseJson(row.tags_json, []),
    importance: row.importance,
    confidence: row.confidence,
    source_reliability: row.source_reliability,
    quality_flag: row.quality_flag,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    superseded_by: row.superseded_by,
    supersedes: parseJson(row.supersedes_json, []),
    version_chain: parseJson(row.version_chain_json, []),
    source_span: row.source_span_id,
    evidence_refs: [],
    sensitivity: row.sensitivity,
    share_scope: parseJson(row.share_scope_json, []),
    acl_version: row.acl_version,
    lifecycle_state: row.lifecycle_state,
    version: row.version,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// 冲突判定（附录 C / §2.4 / §2.5）
// ---------------------------------------------------------------------------

const ENTITY_STRUCTURED_KEYS = Object.freeze(['entity', 'subject']);
const PREDICATE_STRUCTURED_KEYS = Object.freeze(['predicate', 'attribute']);
const VALUE_STRUCTURED_KEYS = Object.freeze(['value', 'value_text', 'object', 'object_value']);

function readFirstDefined(source, keys) {
  if (!isPlainObject(source)) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
}

/** 同实体同谓词判定键（与 scoring.mmrSelect 的 entity_key/predicate_key 口径保持一致）。 */
function relationKeysOf(entry) {
  const structured = entry?.content?.structured ?? entry?.structured ?? null;
  const entity = entry?.entity_key
    ?? entry?.entity
    ?? readFirstDefined(structured, ENTITY_STRUCTURED_KEYS);
  const predicate = entry?.predicate_key
    ?? entry?.predicate
    ?? readFirstDefined(structured, PREDICATE_STRUCTURED_KEYS);
  if (entity === undefined || predicate === undefined) return null;
  return { entity: String(entity), predicate: String(predicate) };
}

function structuredValueKey(entry) {
  const structured = entry?.content?.structured ?? entry?.structured ?? null;
  if (!isPlainObject(structured)) return null;
  const explicit = readFirstDefined(structured, VALUE_STRUCTURED_KEYS);
  if (explicit !== undefined) return stableStringify(explicit);
  const rest = { ...structured };
  for (const key of [...ENTITY_STRUCTURED_KEYS, ...PREDICATE_STRUCTURED_KEYS]) delete rest[key];
  if (Object.keys(rest).length === 0) return null;
  return stableStringify(rest);
}

function relationKeysEqual(a, b) {
  if (!a || !b) return false;
  return a.entity === b.entity && a.predicate === b.predicate;
}

// 附录 C：满足任意两条才算「强冲突」。
function conflictStrength(candidate, existing) {
  let score = 0;
  if (structuredValueKey(candidate) !== structuredValueKey(existing)) score += 1; // 同一 structured 字段键值不同
  if (windowOverlap(candidate, existing)) score += 1; // valid_from/valid_to 区间重叠
  if (entityJaccard(candidate, existing) >= 0.6) score += 1; // 实体集合 Jaccard >= 0.60
  return score;
}

function windowOverlap(a, b) {
  const aFrom = Date.parse(a?.temporal?.valid_from ?? a?.valid_from ?? '');
  const aToRaw = a?.temporal?.valid_to ?? a?.valid_to ?? null;
  const aTo = aToRaw === null ? Infinity : Date.parse(aToRaw);
  const bFrom = Date.parse(b?.temporal?.valid_from ?? b?.valid_from ?? '');
  const bToRaw = b?.temporal?.valid_to ?? b?.valid_to ?? null;
  const bTo = bToRaw === null ? Infinity : Date.parse(bToRaw);
  if (!Number.isFinite(aFrom) || !Number.isFinite(bFrom)) return false;
  return aFrom <= bTo && bFrom <= aTo;
}

function entityJaccard(a, b) {
  const setA = new Set(uniqueStrings(a?.content?.entities ?? a?.entities ?? []).map(String));
  const setB = new Set(uniqueStrings(b?.content?.entities ?? b?.entities ?? []).map(String));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 查找同实体同谓词的现存条目（§2.4 / 附录 C）。
 * 只取 active / cold_archived；superseded 与 deleted_* 已不可召回，也不再作为覆盖目标。
 */
function findConflictItems(store, item) {
  const keys = relationKeysOf(item);
  if (!keys) return [];

  const identity = item.identity || {};
  const rows = store.all(
    `SELECT * FROM memory_item
      WHERE user_id = ? AND scope = ?
        AND lifecycle_state IN ('active', 'cold_archived')
        AND structured_json IS NOT NULL
      ORDER BY mem_id`,
    String(identity.user_id),
    String(identity.scope)
  );

  const conflicts = [];
  for (const row of rows) {
    const existing = rowToMemoryItem(row);
    if (!existing) continue;
    if (relationKeysEqual(keys, relationKeysOf(existing))) conflicts.push(existing);
  }
  return conflicts;
}

/**
 * resolveConflict 的完整结果版本（内部使用，保留冲突对象以便落地 supersede）。
 * @returns {{decision:'new'|'duplicate'|'supersede'|'needs_review',
 *            conflicts:object[], duplicate:object|null, reason:string}}
 */
function resolveConflictDetail(store, item, existing) {
  const candidates = existing === undefined || existing === null
    ? findConflictItems(store, item)
    : (Array.isArray(existing) ? existing : [existing]);

  const itemId = item?.identity?.mem_id ?? item?.mem_id ?? null;
  const keys = relationKeysOf(item);
  const valueKey = structuredValueKey(item);
  const itemHash = isPlainObject(item?.content) || isPlainObject(item?.quality)
    ? computeContentHash({
      type: item?.identity?.type ?? item?.type,
      summary_short: item?.content?.summary_short ?? item?.summary_short,
      summary_long: item?.content?.summary_long ?? item?.summary_long,
      structured: item?.content?.structured ?? item?.structured,
      tags: item?.content?.tags ?? item?.tags,
    })
    : null;

  const live = [];
  for (const entry of candidates) {
    if (!entry) continue;
    const entryId = entry.identity?.mem_id ?? entry.mem_id ?? null;
    const state = entry.lifecycle_state;
    if (state === LIFECYCLE_STATE.SUPERSEDED
        || state === LIFECYCLE_STATE.DELETED_PENDING
        || state === LIFECYCLE_STATE.DELETED_TOMBSTONE) continue;
    if (itemId !== null && entryId === itemId) {
      return { decision: 'duplicate', conflicts: [], duplicate: entry, reason: 'same_mem_id' };
    }
    if (keys && relationKeysEqual(keys, relationKeysOf(entry))) {
      const entryHash = computeContentHash({
        type: entry.type,
        summary_short: entry.summary_short,
        summary_long: entry.summary_long,
        structured: entry.structured,
        tags: entry.tags,
      });
      if ((valueKey !== null && valueKey === structuredValueKey(entry)) || entryHash === itemHash) {
        return { decision: 'duplicate', conflicts: [], duplicate: entry, reason: 'same_value' };
      }
      live.push(entry);
    }
  }

  if (live.length === 0) {
    return { decision: 'new', conflicts: [], duplicate: null, reason: 'no_conflict' };
  }

  // 按 mem_id 字典序取主冲突，保证同输入同决策。
  live.sort((a, b) => (String(a.identity?.mem_id ?? a.mem_id) < String(b.identity?.mem_id ?? b.mem_id) ? -1 : 1));
  const primary = live[0];
  const primaryLayer = primary.layer ?? primary.identity?.layer;

  // 附录 C 覆盖规则 7：M4 永久档案只允许人工或强冲突标记覆盖，不自动降级。
  if (primaryLayer === LAYER.M4) {
    return { decision: 'needs_review', conflicts: live, duplicate: null, reason: 'm4_manual_only' };
  }

  // §2.5：superseded 与 cold_archived 互斥。覆盖时旧条目统一进入 superseded，
  // 即 cold_archived 被覆盖后不再保留 cold_archived 状态（superseded 是终态之一）。
  const strength = conflictStrength(item, primary);
  if (strength < 2) {
    return { decision: 'needs_review', conflicts: live, duplicate: null, reason: 'weak_conflict' };
  }
  return { decision: 'supersede', conflicts: live, duplicate: null, reason: 'strong_conflict' };
}

/**
 * §2.4 / §4.x / 附录 C：同实体同谓词冲突决策。
 * @returns {'new'|'duplicate'|'supersede'|'needs_review'}
 */
function resolveConflict(store, item, existing) {
  return resolveConflictDetail(store, item, existing).decision;
}

// ---------------------------------------------------------------------------
// 审计（可选依赖）
// ---------------------------------------------------------------------------

function resolveAudit(auditOverride) {
  if (auditOverride === null) return null;
  if (auditOverride && typeof auditOverride.append === 'function') return auditOverride;
  return auditModule;
}

function appendAudit(store, audit, event) {
  if (!audit || typeof audit.append !== 'function') return null;
  try {
    const result = audit.append(store, event);
    if (result && typeof result === 'object') return result;
    return null;
  } catch (error) {
    // 审计失败不得让业务写入回滚（§10 只追加；此处显式降级）。
    return null;
  }
}

function buildAuditEvent({ actor, action, userId, agentId, objectType, objectId, now, before, after, reason, sensitivity, requestId }) {
  return {
    schema_version: 'audit_event.v4.1',
    user_id: String(userId),
    agent_id: agentId === null || agentId === undefined ? null : String(agentId),
    actor: isPlainObject(actor) ? actor : { type: 'agent', id: String(agentId ?? 'agent') },
    action,
    object_type: objectType,
    object_id: String(objectId),
    request_id: requestId ?? null,
    before: before ?? null,
    after: after ?? null,
    reason: reason ?? null,
    sensitivity: sensitivity ?? null,
    created_at: now,
    immutable: true,
  };
}

// ---------------------------------------------------------------------------
// 物理落地：memory_item / evidence_span / 三级向量 / 全文索引 / derived_edge
// ---------------------------------------------------------------------------

function insertRow(store, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return store.run(sql, ...keys.map((key) => (row[key] === undefined ? null : row[key])));
}

/** §3.3 向量命名空间：user/session -> user_id；org/global -> tenant_id|org_id（NULL 用 __GLOBAL__）。 */
function vectorNamespaceOf(item) {
  const identity = item.identity;
  if (identity.scope === SCOPE.ORG || identity.scope === SCOPE.GLOBAL) {
    return `${identity.tenant_id}|${identity.org_id ?? '__GLOBAL__'}`;
  }
  return String(identity.user_id);
}

function resolveEmbedder(embedder) {
  if (typeof embedder === 'function') {
    return { model: 'custom', embed: (texts) => embedder(texts) };
  }
  if (embedder && typeof embedder.embedSync === 'function') {
    return { model: embedder.model || 'custom', embed: (texts) => embedder.embedSync(texts) };
  }
  if (embedder && typeof embedder.embed === 'function') {
    return { model: embedder.model || 'custom', embed: (texts) => embedder.embed(texts) };
  }
  return null;
}

/**
 * 生成单条向量。支持注入同步 embedder；若注入的是异步 embedder（返回 Promise），
 * 本模块保持同步语义，整体回落 embedding.hashEmbedding，并在返回中标记 degraded。
 */
function embedText(text, options = {}) {
  const dim = Number.isInteger(options.embeddingDim) && options.embeddingDim > 0
    ? options.embeddingDim
    : DEFAULT_EMBEDDING_DIM;
  const fallback = () => ({
    vector: embeddingLib.hashEmbedding(text, dim),
    model: 'hashEmbedding',
    degraded: true,
  });

  const provider = resolveEmbedder(options.embedder);
  if (!provider) return fallback();

  try {
    const output = provider.embed([text]);
    if (!Array.isArray(output)) return fallback();
    const row = output[0];
    if (!Array.isArray(row) || row.length === 0) return fallback();
    if (!row.every((value) => Number.isFinite(Number(value)))) return fallback();
    return { vector: row.map(Number), model: provider.model, degraded: false };
  } catch (error) {
    return fallback();
  }
}

function insertVectorRow(store, table, row) {
  try {
    insertRow(store, table, row);
  } catch (error) {
    // 向量索引写失败不应吞掉主记录；抛出让整条 item 事务回滚，由批次标记该 item 失败。
    throw error;
  }
}

/**
 * 写入 evidence_span（§17.1）并维护 ref_count（§9.1）。
 * 同一 mem 重复引用同一 span 不重复计数（幂等）；不同 mem 引用同一 span 则原子 +1。
 * 附录 A 未单列 ref_event 明细表，因此只维护 ref_count 计数列，明细建议后续补表。
 */
function persistEvidenceSpans(store, item, now, sourceTurnId) {
  const identity = item.identity;
  const evidence = item.evidence;
  const createdSpans = [];
  const primarySpan = evidence.source_span;

  for (const spanId of uniqueStrings(evidence.evidence_refs)) {
    const existing = store.get(
      'SELECT span_id, mem_id, ref_count FROM memory_evidence_span WHERE span_id = ?',
      spanId
    );

    if (existing) {
      if (String(existing.mem_id ?? '') !== String(item.identity.mem_id)) {
        store.run(
          'UPDATE memory_evidence_span SET ref_count = ref_count + 1 WHERE span_id = ?',
          spanId
        );
      }
      createdSpans.push(spanId);
      continue;
    }

    const isPrimary = spanId === primarySpan;
    insertRow(store, 'memory_evidence_span', {
      span_id: spanId,
      user_id: String(identity.user_id),
      agent_id: String(identity.agent_id),
      mem_id: String(identity.mem_id),
      source_type: DEFAULT_SOURCE_TYPE,
      source_id: isPrimary ? (sourceTurnId ?? null) : null,
      source_turn_id: isPrimary ? (sourceTurnId ?? null) : null,
      raw_text: isPrimary ? (item.content.summary_long ?? item.content.summary_short) : null,
      text_excerpt: isPrimary ? item.content.summary_short : null,
      start_offset: null,
      end_offset: null,
      media_ref: item.content.media_ref ?? null,
      t_stamp: isPrimary ? item.temporal.valid_from : null,
      page_no: null,
      bbox_json: null,
      language: null,
      sensitivity: item.governance.sensitivity,
      content_hash: isPrimary
        ? computeContentHash({
          type: item.identity.type,
          summary_short: item.content.summary_short,
          summary_long: item.content.summary_long,
          structured: item.content.structured,
          tags: item.content.tags,
        })
        : null,
      ref_count: 1,
      deletion_state: 'active',
      audit_ref: item.governance.audit_ref ?? null,
      schema_version: EVIDENCE_SPAN_SCHEMA_VERSION,
      created_at: now,
    });
    createdSpans.push(spanId);
  }

  return createdSpans;
}

function persistVectors(store, item, options, createdSpans) {
  const identity = item.identity;
  const ns = vectorNamespaceOf(item);
  const text = `${item.content.summary_short}\n${item.content.summary_long ?? ''}`.trim();
  const embedded = embedText(text, options);
  const dim = embedded.vector.length;
  const aclVersion = item.governance.acl_version;

  // 1) 条目级向量（§2.1 embedding_refs.item）
  const itemVecId = item.content.embedding_refs.item || `vec_${identity.mem_id}_item`;
  insertVectorRow(store, 'memory_vector_index_item', {
    vec_id: itemVecId,
    mem_id: String(identity.mem_id),
    user_id: String(identity.user_id),
    tenant_id: identity.tenant_id ?? null,
    org_id: identity.org_id ?? null,
    vector_json: toJson(embedded.vector),
    dim,
    model: embedded.model,
    vector_ns: ns,
    acl_version: aclVersion,
    created_at: item.evidence.created_at,
  });

  // 2) 段级向量：优先 embedding_refs.segment；无显式段时用 media_ref 作为段标识。
  const segmentRefs = uniqueStrings(
    item.content.embedding_refs.segment ?? (item.content.media_ref ? [item.content.media_ref] : [])
  );
  for (const segId of segmentRefs) {
    insertVectorRow(store, 'memory_vector_index_segment', {
      vec_id: `vec_${sha256Hex(`segment|${identity.mem_id}|${segId}`).slice(0, 24)}_segment`,
      seg_id: segId,
      mem_id: String(identity.mem_id),
      file_id: item.content.media_ref ?? segId,
      user_id: String(identity.user_id),
      tenant_id: identity.tenant_id ?? null,
      org_id: identity.org_id ?? null,
      vector_json: toJson(embedded.vector),
      dim,
      model: embedded.model,
      vector_ns: ns,
      acl_version: aclVersion,
      created_at: item.evidence.created_at,
    });
  }

  // 3) 片段级向量：每个 evidence span 即一个证据片段（§17.1）。
  const fragmentRefs = new Set(uniqueStrings([
    ...createdSpans,
    ...uniqueStrings(item.content.embedding_refs.fragment),
  ]));
  for (const fragmentId of fragmentRefs) {
    insertVectorRow(store, 'memory_vector_index_fragment', {
      vec_id: `vec_${sha256Hex(`fragment|${identity.mem_id}|${fragmentId}`).slice(0, 24)}_fragment`,
      fragment_id: fragmentId,
      span_id: createdSpans.includes(fragmentId) ? fragmentId : (item.evidence.source_span ?? null),
      mem_id: String(identity.mem_id),
      user_id: String(identity.user_id),
      tenant_id: identity.tenant_id ?? null,
      org_id: identity.org_id ?? null,
      vector_json: toJson(embedded.vector),
      dim,
      model: embedded.model,
      vector_ns: ns,
      acl_version: aclVersion,
      created_at: item.evidence.created_at,
    });
  }

  return {
    item_vec_id: itemVecId,
    segment_count: segmentRefs.length,
    fragment_count: fragmentRefs.size,
    model: embedded.model,
    degraded: embedded.degraded,
  };
}

function fulltextTextOf(item) {
  const parts = [
    item.content.summary_short,
    item.content.summary_long ?? '',
    item.content.tags.join(' '),
    item.content.structured ? stableStringify(item.content.structured) : '',
  ];
  return parts.filter((part) => part && String(part).trim() !== '').join('\n');
}

function persistFulltext(store, item, createdSpans) {
  const identity = item.identity;
  const scopeColumns = {
    tenant_id: identity.tenant_id ?? null,
    org_id: identity.org_id ?? null,
  };

  insertRow(store, 'memory_fulltext_index', {
    index_id: `ft_${sha256Hex(`memory_item|${identity.mem_id}`).slice(0, 24)}`,
    user_id: String(identity.user_id),
    ...scopeColumns,
    object_type: 'memory_item',
    object_id: String(identity.mem_id),
    source_type: null,
    text_content: fulltextTextOf(item),
    language: null,
    created_at: item.evidence.created_at,
  });

  // 证据片段也进入全文索引，供 §16.2 search_raw 与 raw_bm25 召回使用。
  for (const spanId of createdSpans) {
    insertRow(store, 'memory_fulltext_index', {
      index_id: `ft_${sha256Hex(`evidence_span|${identity.mem_id}|${spanId}`).slice(0, 24)}`,
      user_id: String(identity.user_id),
      ...scopeColumns,
      object_type: 'evidence_span',
      object_id: spanId,
      source_type: DEFAULT_SOURCE_TYPE,
      text_content: `${item.content.summary_short}\n${item.content.summary_long ?? ''}`.trim(),
      language: null,
      created_at: item.evidence.created_at,
    });
  }
}

/** §17.2 DerivedEdge：memory_item -> evidence_span（derived_from）；同时记录显式血缘。 */
function persistDerivedEdges(store, item, now) {
  const identity = item.identity;
  const targets = [
    ...uniqueStrings(item.evidence.evidence_refs).map((id) => ({ type: 'evidence_span', id })),
    ...uniqueStrings(item.evidence.derived_from).map((id) => ({
      type: String(id).startsWith('mem_') ? 'memory_item' : 'evidence_span',
      id,
    })),
  ];

  for (const target of targets) {
    const edgeId = `edge_${sha256Hex([
      'memory_item',
      identity.mem_id,
      target.type,
      target.id,
      'derived_from',
    ].join('|')).slice(0, 24)}`;
    insertRow(store, 'memory_derived_edge', {
      edge_id: edgeId,
      user_id: String(identity.user_id),
      from_type: 'memory_item',
      from_id: String(identity.mem_id),
      to_type: target.type,
      to_id: String(target.id),
      relation: 'derived_from',
      provenance_json: toJson({
        pipeline: 'memory_write',
        extractor: identity.agent_id,
      }),
      deletion_state: 'active',
      schema_version: DERIVED_EDGE_SCHEMA_VERSION,
      created_at: now,
    });
  }
}

/** memory_version_chain：新条目自身的版本行（附录 C 版本链）。 */
function persistVersionChain(store, item, now) {
  const identity = item.identity;
  store.run(
    `INSERT INTO memory_version_chain
       (mem_id, version, superseded_by, supersedes_json, version_chain_json, valid_from, valid_to, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mem_id, version) DO UPDATE SET
       superseded_by = excluded.superseded_by,
       supersedes_json = excluded.supersedes_json,
       version_chain_json = excluded.version_chain_json,
       valid_from = excluded.valid_from,
       valid_to = excluded.valid_to`,
    String(identity.mem_id),
    integerOr(item.version, 1),
    item.temporal.superseded_by ?? null,
    toJson(item.temporal.supersedes),
    toJson(item.temporal.version_chain),
    item.temporal.valid_from,
    item.temporal.valid_to ?? null,
    SCHEMA_VERSION,
    now
  );
}

function memoryItemRow(item) {
  const identity = item.identity;
  const content = item.content;
  const quality = item.quality;
  const temporal = item.temporal;
  const evidence = item.evidence;
  const governance = item.governance;

  return {
    mem_id: String(identity.mem_id),
    user_id: String(identity.user_id),
    tenant_id: identity.tenant_id ?? null,
    org_id: identity.org_id ?? null,
    owner_user_id: identity.owner_user_id ?? null,
    agent_id: String(identity.agent_id),
    scope: identity.scope,
    layer: identity.layer,
    type: identity.type,
    summary_short: content.summary_short,
    summary_long: content.summary_long ?? null,
    structured_json: toJson(content.structured),
    tags_json: toJson(content.tags),
    entities_json: toJson(content.entities),
    relations_json: toJson(content.relations),
    embedding_refs_json: toJson(content.embedding_refs),
    raw_text_ref: content.raw_text_ref ?? null,
    media_ref: content.media_ref ?? null,
    source_span_id: evidence.source_span,
    source_turns_json: toJson(evidence.source_turns),
    derived_from_json: toJson(evidence.derived_from),
    why_recalled_log_json: toJson(evidence.why_recalled_log),
    importance: quality.importance,
    confidence: quality.confidence,
    source_reliability: quality.source_reliability,
    recency: quality.recency ?? null,
    access_count: quality.access_count,
    decay_score: quality.decay_score ?? null,
    quality_flag: quality.quality_flag,
    quality_reasons_json: toJson(quality.quality_reasons),
    valid_from: temporal.valid_from,
    valid_to: temporal.valid_to ?? null,
    superseded_by: temporal.superseded_by ?? null,
    supersedes_json: toJson(temporal.supersedes),
    version_chain_json: toJson(temporal.version_chain),
    last_access: temporal.last_access ?? null,
    sensitivity: governance.sensitivity,
    retention_policy: governance.retention_policy ?? null,
    acl_version: governance.acl_version,
    share_scope_json: toJson(governance.share_scope),
    audit_ref: governance.audit_ref ?? null,
    affect_ext_json: toJson(item.affect_ext),
    lifecycle_state: item.lifecycle_state,
    version: item.version,
    schema_version: item.schema_version,
    created_at: item.created_at,
  };
}

/** 完整落地一条已归一化且已决策的条目（调用方负责事务）。 */
function persistItem(store, item, options) {
  const now = options.now;

  insertRow(store, 'memory_item', memoryItemRow(item));
  const createdSpans = persistEvidenceSpans(store, item, now, options.sourceTurnId);
  const vectors = persistVectors(store, item, options, createdSpans);
  persistFulltext(store, item, createdSpans);
  persistDerivedEdges(store, item, now);
  persistVersionChain(store, item, now);

  return {
    mem_id: String(item.identity.mem_id),
    evidence_span_ids: createdSpans,
    vectors,
  };
}

/**
 * 附录 C 覆盖规则：新建新版本 + 旧版本 superseded_by 指向新版本 + 双向 version_chain 合并 +
 * 旧版本 valid_to = 新版本 valid_from；不物理删除旧值。
 */
function applySupersede(store, newItem, oldItem, now) {
  const oldId = String(oldItem.identity?.mem_id ?? oldItem.mem_id);
  const newId = String(newItem.identity.mem_id);
  const oldChain = uniqueStrings(oldItem.temporal?.version_chain ?? oldItem.version_chain);
  const newChain = uniqueStrings(newItem.temporal.version_chain);
  const mergedChain = uniqueStrings([...oldChain, ...newChain, oldId, newId]);

  newItem.temporal.supersedes = uniqueStrings([...newItem.temporal.supersedes, oldId]);
  newItem.temporal.version_chain = mergedChain;

  store.run(
    `UPDATE memory_item
        SET lifecycle_state = ?, superseded_by = ?, valid_to = ?,
            supersedes_json = ?, version_chain_json = ?
      WHERE mem_id = ?`,
    LIFECYCLE_STATE.SUPERSEDED,
    newId,
    newItem.temporal.valid_from,
    toJson(uniqueStrings([...oldItem.temporal?.supersedes ?? oldItem.supersedes, newId])),
    toJson(mergedChain),
    oldId
  );

  store.run(
    `INSERT INTO memory_version_chain
       (mem_id, version, superseded_by, supersedes_json, version_chain_json, valid_from, valid_to, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mem_id, version) DO UPDATE SET
       superseded_by = excluded.superseded_by,
       version_chain_json = excluded.version_chain_json,
       valid_to = excluded.valid_to`,
    oldId,
    integerOr(oldItem.version ?? oldItem.identity?.version, 1),
    newId,
    toJson(uniqueStrings([...oldItem.temporal?.supersedes ?? oldItem.supersedes, newId])),
    toJson(mergedChain),
    oldItem.temporal?.valid_from ?? oldItem.valid_from ?? null,
    newItem.temporal.valid_from,
    SCHEMA_VERSION,
    now
  );

  return { superseded_mem_id: oldId, superseded_by: newId, version_chain: mergedChain };
}

// ---------------------------------------------------------------------------
// 幂等状态机（§7.2）
// ---------------------------------------------------------------------------

function isExpired(expiresAt, now) {
  if (!expiresAt) return true;
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return true;
  return expiresMs <= nowMs;
}

function readIdempotency(store, key) {
  return store.get('SELECT * FROM write_idempotency WHERE idempotency_key = ?', key);
}

/**
 * 幂等记录指向的条目是否已不可召回（被遗忘）。
 * 只有 deleted_pending / deleted_tombstone 视为「可重新写入」：
 * 同一内容被 forget 之后再次写入属于新写入，不应被旧幂等记录永久拦截。
 */
function isRevivableTarget(store, memId) {
  if (!memId) return true;
  const row = store.get('SELECT lifecycle_state FROM memory_item WHERE mem_id = ?', memId);
  if (!row) return true;
  return row.lifecycle_state === LIFECYCLE_STATE.DELETED_PENDING
    || row.lifecycle_state === LIFECYCLE_STATE.DELETED_TOMBSTONE;
}

/**
 * 获取 / 续租幂等锁：fencing_token++（§7.2 规则 1）。
 * 返回 state='succeeded' 时调用方直接返回 duplicate；
 * state='processing' 表示未超时，调用方返回 409 duplicate_processing + retryable。
 */
function acquireIdempotency(store, { key, userId, itemIndex, contentHash, now, fencingToken, errorCode = null }) {
  const existing = readIdempotency(store, key);

  if (existing && existing.state === 'succeeded') {
    return { state: 'succeeded', record: existing, token: Number(existing.fencing_token || 0) };
  }
  if (existing && existing.state === 'processing' && !isExpired(existing.expires_at, now)) {
    return { state: 'processing', record: existing, token: Number(existing.fencing_token || 0) };
  }

  const token = Math.max(
    Number(existing?.fencing_token || 0),
    integerOr(fencingToken, 0)
  ) + 1;
  const expiresAt = addSecondsIso(now, WRITE_IDEMPOTENCY.PROCESSING_TIMEOUT_SECONDS);

  if (existing) {
    store.run(
      `UPDATE write_idempotency
          SET state = 'processing', request_hash = ?, error_code = ?, retry_count = retry_count + 1,
              fencing_token = ?, processing_started_at = ?, updated_at = ?, expires_at = ?
        WHERE idempotency_key = ?`,
      contentHash,
      errorCode,
      token,
      now,
      now,
      expiresAt,
      key
    );
  } else {
    insertRow(store, 'write_idempotency', {
      idempotency_key: key,
      user_id: String(userId),
      item_index: integerOr(itemIndex, 0),
      content_hash: contentHash,
      state: 'processing',
      request_hash: contentHash,
      result_ref: null,
      error_code: errorCode,
      retry_count: 0,
      fencing_token: token,
      processing_started_at: now,
      expires_at: expiresAt,
      audit_ref: null,
      created_at: now,
      updated_at: now,
    });
  }

  return { state: 'acquired', record: readIdempotency(store, key), token };
}

/** 完成任务：校验 token 仍是当前 token（§7.2 规则 2）；不一致则被 fenced。 */
function completeIdempotency(store, { key, token, resultRef, now }) {
  const result = store.run(
    `UPDATE write_idempotency
        SET state = 'succeeded', result_ref = ?, error_code = NULL, updated_at = ?, expires_at = ?
      WHERE idempotency_key = ? AND fencing_token = ?`,
    resultRef,
    now,
    addDaysIso(now, WRITE_IDEMPOTENCY.TERMINAL_TTL_DAYS),
    key,
    token
  );
  return Number(result?.changes ?? 0) === 1;
}

function markIdempotencyFailed(store, { key, token, errorCode, now }) {
  try {
    store.run(
      `UPDATE write_idempotency
          SET state = 'failed', error_code = ?, updated_at = ?
        WHERE idempotency_key = ? AND fencing_token = ?`,
      errorCode,
      now,
      key,
      token
    );
  } catch (error) {
    // 失败态记录属于尽力而为，不覆盖原始错误。
  }
}

// ---------------------------------------------------------------------------
// 写入主流程
// ---------------------------------------------------------------------------

const RETRYABLE_CODES = new Set([
  ERROR_CODE.INTERNAL_ERROR,
  ERROR_CODE.DEPENDENCY_UNAVAILABLE,
  ERROR_CODE.DUPLICATE_PROCESSING,
  ERROR_CODE.VERSION_CONFLICT,
]);

function isRetryable(errorCode) {
  return RETRYABLE_CODES.has(errorCode);
}

function failedResult(itemIndex, errorCode, message, extra = {}) {
  return {
    item_index: itemIndex,
    ok: false,
    error_code: errorCode,
    retryable: isRetryable(errorCode),
    message: message ?? null,
    ...extra,
  };
}

function normalizeErrorCode(code) {
  if (code === 'VALIDATION_ERROR') return ERROR_CODE.INVALID_PAYLOAD;
  if (typeof code === 'string' && code !== '') return code;
  return ERROR_CODE.INTERNAL_ERROR;
}

function resolveContext(options) {
  const context = isPlainObject(options.context) ? options.context : {};
  return {
    userId: context.user_id ?? context.userId ?? options.user_id ?? options.userId ?? null,
    agentId: context.agent_id ?? context.agentId ?? options.agent_id ?? options.agentId ?? null,
    scope: context.scope ?? options.scope ?? undefined,
    tenantId: context.tenant_id ?? context.tenantId ?? options.tenant_id ?? options.tenantId ?? null,
    orgId: context.org_id ?? context.orgId ?? options.org_id ?? options.orgId ?? null,
    sessionId: context.session_id ?? context.sessionId ?? options.session_id ?? options.sessionId ?? null,
    now: normalizeTimestamp(context.now ?? options.now, null),
    embedder: options.embedder ?? context.embedder ?? null,
    embeddingDim: options.embedding_dim ?? options.embeddingDim ?? context.embedding_dim ?? null,
    audit: resolveAudit(options.audit ?? context.audit),
  };
}

/**
 * 单条写入内部实现（批量与单写共用）。
 * @returns {{result:object, written:boolean, duplicate:boolean, superseded:string[]}}
 */
function writeItemInternal(store, rawItem, index, options) {
  const ctx = resolveContext(options);
  const sourceTurnId = options.source_turn_id
    ?? rawItem?.source_turn_id
    ?? options.context?.source_turn_id
    ?? null;

  const normalized = normalizeMemoryItem(rawItem, {
    userId: ctx.userId,
    agentId: ctx.agentId ?? store.agentId,
    scope: ctx.scope,
    tenantId: ctx.tenantId,
    orgId: ctx.orgId,
    now: ctx.now,
    sessionId: ctx.sessionId,
    itemIndex: integerOr(rawItem?.item_index, index),
    sourceTurnId,
  });

  if (!normalized.ok) {
    return {
      result: failedResult(index, normalizeErrorCode(normalized.code), normalized.message, {
        field: normalized.field ?? null,
      }),
      written: false,
      duplicate: false,
      superseded: [],
    };
  }

  const item = normalized.item;
  const now = item.evidence.created_at;
  const key = idempotencyKey({
    user_id: item.identity.user_id,
    agent_id: item.identity.agent_id,
    source_turn_id: sourceTurnId ?? '',
    item_index: integerOr(rawItem?.item_index, index),
    content_hash: normalized.content_hash,
    operation: 'write',
  });

  // 幂等预检：已成功 -> duplicate；仍在 processing 且未超时 -> 409 duplicate_processing。
  // 例外：若幂等记录指向的条目已被遗忘（deleted_*），说明这是一次重新写入而不是重放，
  // 允许正常写入，否则被 forget 过的内容永远写不回来。
  const precheck = readIdempotency(store, key);
  const revived = Boolean(
    precheck && precheck.state === 'succeeded' && isRevivableTarget(store, precheck.result_ref)
  );
  if (revived) {
    // 复位旧幂等记录（保留痕迹），让本次写入重新占用同一键。
    store.run(
      `UPDATE write_idempotency
          SET state = 'failed', error_code = 'revived_target_rewrite', updated_at = ?
        WHERE idempotency_key = ? AND state = 'succeeded'`,
      now,
      key
    );
  }
  if (precheck && precheck.state === 'succeeded' && !revived) {
    const memId = precheck.result_ref ?? null;
    appendAudit(store, ctx.audit, buildAuditEvent({
      actor: options.actor,
      action: AUDIT_ACTION.MEMORY_WRITE,
      userId: item.identity.user_id,
      agentId: item.identity.agent_id,
      objectType: 'memory_item',
      objectId: memId ?? item.identity.mem_id,
      now,
      after: { state: 'duplicate', idempotency_key: key },
      reason: 'idempotent_replay',
      sensitivity: item.governance.sensitivity,
      requestId: options.request_id,
    }));
    return {
      result: { item_index: index, ok: true, mem_id: memId, duplicate: true, status: 'duplicate' },
      written: false,
      duplicate: true,
      superseded: [],
    };
  }
  if (precheck && precheck.state === 'processing' && !isExpired(precheck.expires_at, now)) {
    appendAudit(store, ctx.audit, buildAuditEvent({
      actor: options.actor,
      action: AUDIT_ACTION.MEMORY_WRITE_FENCED,
      userId: item.identity.user_id,
      agentId: item.identity.agent_id,
      objectType: 'memory_item',
      objectId: item.identity.mem_id,
      now,
      after: { state: 'processing', fencing_token: Number(precheck.fencing_token || 0) },
      reason: 'duplicate_processing',
      sensitivity: item.governance.sensitivity,
      requestId: options.request_id,
    }));
    return {
      result: failedResult(index, ERROR_CODE.DUPLICATE_PROCESSING, '§7.2 processing 未超时，禁止重复执行', {
        retry_after: WRITE_IDEMPOTENCY.PROCESSING_TIMEOUT_SECONDS,
      }),
      written: false,
      duplicate: false,
      superseded: [],
    };
  }

  const itemIndex = integerOr(rawItem?.item_index, index);
  let token = null;
  let supersededIds = [];
  let memId = item.identity.mem_id;
  let evidenceSpanIds = [];
  let qualityFlag = item.quality.quality_flag;
  let conflictDecision = 'new';

  try {
    const outcome = store.tx(() => {
      const acquired = acquireIdempotency(store, {
        key,
        userId: item.identity.user_id,
        itemIndex,
        contentHash: normalized.content_hash,
        now,
        fencingToken: options.fencing_token,
      });

      if (acquired.state === 'succeeded') {
        return {
          duplicate: true,
          memId: acquired.record.result_ref ?? null,
          written: false,
          superseded: [],
          token: null,
        };
      }
      if (acquired.state === 'processing') {
        return {
          processing: true,
          token: acquired.token,
          memId: item.identity.mem_id,
        };
      }

      token = acquired.token;

      const detail = resolveConflictDetail(store, item, undefined);
      conflictDecision = detail.decision;

      if (detail.decision === 'duplicate') {
        completeIdempotency(store, {
          key,
          token,
          resultRef: detail.duplicate.identity?.mem_id ?? detail.duplicate.mem_id,
          now,
        });
        return {
          duplicate: true,
          memId: detail.duplicate.identity?.mem_id ?? detail.duplicate.mem_id,
          written: false,
          superseded: [],
          token,
        };
      }

      if (detail.decision === 'needs_review') {
        // §2.4 / §22.2：强冲突未解 -> needs_review（仍写入，但低权召回）。
        item.quality.quality_flag = QUALITY_FLAG.NEEDS_REVIEW;
        item.quality.quality_reasons = uniqueStrings([
          ...item.quality.quality_reasons,
          detail.reason,
        ]);
        qualityFlag = item.quality.quality_flag;
      }

      const superseded = [];
      if (detail.decision === 'supersede') {
        for (const oldItem of detail.conflicts) {
          superseded.push(applySupersede(store, item, oldItem, now));
        }
      }

      const persisted = persistItem(store, item, {
        now: item.evidence.created_at,
        sourceTurnId,
        embedder: ctx.embedder,
        embeddingDim: ctx.embeddingDim,
      });

      const completed = completeIdempotency(store, {
        key,
        token,
        resultRef: persisted.mem_id,
        now,
      });
      if (!completed) {
        const error = new Error('§7.2 fencing_token 校验失败，本次写入被丢弃');
        error.code = ERROR_CODE.DUPLICATE_PROCESSING;
        throw error;
      }

      return {
        written: true,
        duplicate: false,
        memId: persisted.mem_id,
        evidenceSpanIds: persisted.evidence_span_ids,
        vectors: persisted.vectors,
        superseded,
        token,
        decision: conflictDecision,
      };
    });

    if (outcome?.processing) {
      return {
        result: failedResult(index, ERROR_CODE.DUPLICATE_PROCESSING, '§7.2 processing 未超时，禁止重复执行', {
          retry_after: WRITE_IDEMPOTENCY.PROCESSING_TIMEOUT_SECONDS,
        }),
        written: false,
        duplicate: false,
        superseded: [],
      };
    }

    if (outcome?.duplicate) {
      memId = outcome.memId;
      return {
        result: { item_index: index, ok: true, mem_id: memId, duplicate: true, status: 'duplicate' },
        written: false,
        duplicate: true,
        superseded: [],
      };
    }

    memId = outcome.memId;
    evidenceSpanIds = outcome.evidenceSpanIds ?? [];
    supersededIds = (outcome.superseded ?? []).map((entry) => entry.superseded_mem_id);

    // §17.3 / §10：写入与覆盖各写一条审计；audit.js 缺失时静默跳过。
    const auditId = appendAudit(store, ctx.audit, buildAuditEvent({
      actor: options.actor,
      action: AUDIT_ACTION.MEMORY_WRITE,
      userId: item.identity.user_id,
      agentId: item.identity.agent_id,
      objectType: 'memory_item',
      objectId: memId,
      now,
      after: {
        layer: item.identity.layer,
        type: item.identity.type,
        quality_flag: qualityFlag,
        conflict_decision: conflictDecision,
        evidence_span_ids: evidenceSpanIds,
      },
      reason: conflictDecision === 'needs_review' ? 'conflict_needs_review' : null,
      sensitivity: item.governance.sensitivity,
      requestId: options.request_id,
    }));

    for (const supersededId of supersededIds) {
      appendAudit(store, ctx.audit, buildAuditEvent({
        actor: options.actor,
        action: AUDIT_ACTION.MEMORY_SUPERSEDE,
        userId: item.identity.user_id,
        agentId: item.identity.agent_id,
        objectType: 'memory_item',
        objectId: supersededId,
        now,
        before: { lifecycle_state: LIFECYCLE_STATE.ACTIVE },
        after: { lifecycle_state: LIFECYCLE_STATE.SUPERSEDED, superseded_by: memId },
        reason: 'conflict_supersede',
        sensitivity: item.governance.sensitivity,
        requestId: options.request_id,
      }));
    }

    return {
      result: {
        item_index: index,
        ok: true,
        mem_id: memId,
        duplicate: false,
        status: 'succeeded',
        conflict_decision: conflictDecision,
        quality_flag: qualityFlag,
        evidence_span_ids: evidenceSpanIds,
        superseded: supersededIds,
        audit_ref: auditId?.event_id ?? auditId?.audit_ref ?? null,
      },
      written: true,
      duplicate: false,
      superseded: supersededIds,
    };
  } catch (error) {
    if (token !== null) {
      markIdempotencyFailed(store, {
        key,
        token,
        errorCode: normalizeErrorCode(error?.code),
        now,
      });
    }
    if (error?.code === ERROR_CODE.DUPLICATE_PROCESSING) {
      appendAudit(store, ctx.audit, buildAuditEvent({
        actor: options.actor,
        action: AUDIT_ACTION.MEMORY_WRITE_FENCED,
        userId: item.identity.user_id,
        agentId: item.identity.agent_id,
        objectType: 'memory_item',
        objectId: memId,
        now,
        after: { fencing_token: token },
        reason: 'fencing_token_mismatch',
        sensitivity: item.governance.sensitivity,
        requestId: options.request_id,
      }));
    }
    return {
      result: failedResult(
        index,
        normalizeErrorCode(error?.code),
        error?.message ?? '写入失败',
        { conflict_decision: conflictDecision }
      ),
      written: false,
      duplicate: false,
      superseded: supersededIds,
    };
  }
}

/**
 * §7.3 批量写入。
 *
 * @param {object} store getStore() 返回的 store
 * @param {{items:object[], source_turn_id?:string, context?:object, fencing_token?:number,
 *          actor?:object, request_id?:string, now?:string, embedder?:object|Function,
 *          embedding_dim?:number, audit?:object|null}} options
 * @returns {{status:200|207|422, results:object[], written:number, failed:number,
 *            duplicates:number, ...}}
 */
function writeBatch(store, options = {}) {
  if (!store || typeof store.tx !== 'function') {
    throw new TypeError('writeBatch: store 必须由 getStore() 返回');
  }
  const items = Array.isArray(options.items) ? options.items : [];
  if (items.length === 0) {
    return {
      status: 422,
      ok: false,
      schema_version: 'write_response.v4.1',
      request_id: options.request_id ?? null,
      results: [],
      written: 0,
      failed: 0,
      duplicates: 0,
      succeeded_mem_ids: [],
      failed_items: [],
      evidence_span_ids: [],
      routed_layers: [],
      errors: [failedResult(null, ERROR_CODE.INVALID_PAYLOAD, '§7.3 items 不能为空')],
    };
  }

  if (items.length > LIMITS.BATCH_ITEMS_MAX) {
    const error = failedResult(null, ERROR_CODE.INVALID_PAYLOAD, `批量 items 超过上限 ${LIMITS.BATCH_ITEMS_MAX}`);
    return {
      status: 422,
      ok: false,
      schema_version: 'write_response.v4.1',
      request_id: options.request_id ?? null,
      results: [error],
      written: 0,
      failed: items.length,
      duplicates: 0,
      succeeded_mem_ids: [],
      failed_items: [error],
      evidence_span_ids: [],
      routed_layers: [],
    };
  }

  const results = [];
  const succeededMemIds = [];
  const failedItems = [];
  const evidenceSpanIds = [];
  const routedLayers = new Set();
  let written = 0;
  let failed = 0;
  let duplicates = 0;

  for (let index = 0; index < items.length; index += 1) {
    const rawItem = items[index];
    let outcome;
    try {
      outcome = writeItemInternal(store, rawItem, index, options);
    } catch (error) {
      outcome = {
        result: failedResult(index, normalizeErrorCode(error?.code), error?.message ?? '写入失败'),
        written: false,
        duplicate: false,
        superseded: [],
      };
    }

    results.push(outcome.result);
    if (outcome.written) {
      written += 1;
      if (outcome.result.mem_id) succeededMemIds.push(outcome.result.mem_id);
      for (const spanId of outcome.result.evidence_span_ids ?? []) evidenceSpanIds.push(spanId);
      if (rawItem?.layer) routedLayers.add(rawItem.layer);
    } else if (outcome.duplicate) {
      duplicates += 1;
      if (outcome.result.mem_id) succeededMemIds.push(outcome.result.mem_id);
    } else {
      failed += 1;
      failedItems.push(outcome.result);
    }
  }

  // §7.3：全部成功 200；部分成功 207；全部失败 422。
  // duplicate 视为「已被幂等接受」，不计入 failed，因此全 duplicate 返回 200。
  const status = failed === items.length ? 422 : (failed > 0 ? 207 : 200);

  return {
    status,
    ok: status === 200,
    partial_success: status === 207,
    schema_version: 'write_response.v4.1',
    request_id: options.request_id ?? null,
    results,
    written,
    failed,
    duplicates,
    succeeded_mem_ids: uniqueStrings(succeededMemIds),
    failed_items: failedItems,
    evidence_span_ids: uniqueStrings(evidenceSpanIds),
    routed_layers: [...routedLayers].sort(),
  };
}

/**
 * 单条写入便捷函数（§7.3 单事件写入等价于 items 长度 1）。
 * @param {object} store
 * @param {object} item
 * @param {object} [options] writeBatch 的额外参数（context / now / source_turn_id / fencing_token / actor / request_id / embedder）
 * @returns {object} 首条结果 + batch.status
 */
function writeOne(store, item, options = {}) {
  const batch = writeBatch(store, {
    items: [item],
    source_turn_id: options.source_turn_id ?? item?.source_turn_id ?? null,
    context: options.context ?? options,
    fencing_token: options.fencing_token,
    actor: options.actor,
    request_id: options.request_id,
    now: options.now,
    embedder: options.embedder,
    embedding_dim: options.embedding_dim,
    audit: options.audit,
  });
  const result = batch.results[0] ?? failedResult(0, ERROR_CODE.INVALID_PAYLOAD, '无写入结果');
  return {
    ...result,
    status: batch.status,
    batch_status: batch.status,
    batch,
  };
}

module.exports = {
  normalizeMemoryItem,
  idempotencyKey,
  computeContentHash,
  writeBatch,
  writeOne,
  resolveConflict,
  // 以下为辅助导出，便于自检与后续模块复用（不是本任务要求的对外契约面）
  resolveConflictDetail,
  findConflictItems,
  rowToMemoryItem,
};
