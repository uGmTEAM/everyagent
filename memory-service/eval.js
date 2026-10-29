'use strict';

/**
 * 记忆评测执行器（eval_case.v4.1）。
 *
 * 契约依据：
 *   - 汇总、.txt §11.1（eval_case schema）、§11.2（判定规则）、§11.3（run_case 伪代码）
 *   - 汇总、.txt §12（指标口径与阈值）
 *   - 汇总、.txt §23.5（评测执行器测试清单）
 *
 * 设计约束：
 *   1. mode 仅支持 contains | exact | subset | overlap（§11.2 规则 3）。
 *   2. expected_error 与 expected_blocked 互斥（§11.2 规则 1）。
 *   3. min_hit 仅对 overlap 生效，默认 1（§11.2 规则 8）。
 *   4. 所有非空期望字段 AND 组合（§11.2 规则 2）；combination 只接受 "and"。
 *   5. 时间只取 evalCase.now 或 ctx.now；本文件不出现 Date.now，保证 now 冻结（§11.2 规则 9）。
 *
 * 本模块只读复用以下既有模块：
 *   retrieval.recall / write.writeOne / tokenizer.estimateTokens / scoring.duplicateInjectionRate。
 *
 * 执行器扩展字段（不属于 §11.1 契约字段，仅服务于本执行器与自检）：
 *   - case.setup.items：执行前写入的记忆条目（便于在空库/已有库上跑同一批用例）。
 *   - case.setup.repeat：同一批 setup 重复写入次数，用于幂等用例。
 *   - case.expect_setup_idempotent：要求同一事件重复写入返回同一 mem_id（§23.1 per-item 幂等）。
 *   - case.token_budget / case.must_inject / case.types / case.layers / case.sensitivity_max /
 *     case.purpose / case.top_k / case.scenario：透传给 recall 请求。
 *   - case.expected_evidence_completeness_min：§12 证据完整率下限（§11.1 未单列该期望字段）。
 *   - ctx.executor(evalCase, ctx)：自定义召回响应，用于构造 error/blocked 负例。
 */

const { estimateTokens } = require('./tokenizer');
const { duplicateInjectionRate } = require('./scoring');
const { normalizeBudget } = require('./assemble');

const EVAL_SCHEMA_VERSION = 'eval_case.v4.1';
// §11.2 规则 3：mode 仅此 4 种；error/blocked/audit 旧值 deprecated，不再接受。
const EVAL_MODES = Object.freeze(['contains', 'exact', 'subset', 'overlap']);
// §11.1 示例 now；仅在 defaultCases 缺少 ctx.now 时作为确定性默认值（不是 Date.now）。
const DEFAULT_NOW = '2026-10-26T10:00:00.000Z';

class EvalCaseError extends Error {
  constructor(field, message) {
    super(`eval_case 校验失败（${field}）：${message}`);
    this.name = 'EvalCaseError';
    this.code = 'invalid_eval_case';
    this.field = field;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values) {
  if (values === null || values === undefined) return [];
  const list = Array.isArray(values) ? values : [values];
  const out = [];
  for (const value of list) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function round4(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isValidTime(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function resolveNow(evalCase, ctx) {
  const now = evalCase.now ?? (ctx && ctx.now) ?? null;
  if (!isValidTime(now)) {
    // §11.2 规则 9：不退化到系统时钟，缺少冻结时间直接拒绝，避免同一用例跨天结果漂移。
    throw new EvalCaseError('now', '必须提供 evalCase.now 或 ctx.now（ISO 时间），禁止使用 Date.now');
  }
  return now;
}

// ---------------------------------------------------------------------------
// §11.2 规则 1/3/8：schema 与互斥校验
// ---------------------------------------------------------------------------

function inferStatusForError(code) {
  // 契约只明确 sensitivity_blocked -> HTTP 451（§11.2 规则 5 / §16.3）；
  // 其余错误码按 §18.1 的语义给默认状态，允许用例显式 expected_status 覆盖。
  const map = {
    sensitivity_blocked: 451,
    unauthorized: 401,
    user_scope_mismatch: 403,
    authz_denied: 403,
    quota_exceeded: 429,
    duplicate_processing: 409,
    version_conflict: 409,
    dependency_unavailable: 503,
    internal_error: 500,
  };
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : 400;
}

function normalizeExpectedError(value) {
  if (typeof value === 'string') {
    return { code: value, status: inferStatusForError(value) };
  }
  if (isPlainObject(value)) {
    const code = value.code ?? value.error_code ?? value.expected_error_code ?? null;
    const status = value.status ?? value.http_status ?? value.expected_status ?? null;
    return {
      code: code === null ? null : String(code),
      status: finiteOrNull(status),
    };
  }
  return { code: null, status: null };
}

function hasExpectedError(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (isPlainObject(value)) {
    const normalized = normalizeExpectedError(value);
    return Boolean(normalized.code || normalized.status !== null);
  }
  return true;
}

function validateCase(evalCase, ctx) {
  if (!isPlainObject(evalCase)) {
    throw new EvalCaseError('$object', 'eval_case 必须是普通对象');
  }
  if (typeof evalCase.case_id !== 'string' || evalCase.case_id.trim() === '') {
    throw new EvalCaseError('case_id', 'case_id 必填且不能为空');
  }
  if (evalCase.schema_version !== undefined && evalCase.schema_version !== EVAL_SCHEMA_VERSION) {
    throw new EvalCaseError(
      'schema_version',
      `必须为 ${EVAL_SCHEMA_VERSION}，实际 ${JSON.stringify(evalCase.schema_version)}`
    );
  }
  if (typeof evalCase.query !== 'string') {
    throw new EvalCaseError('query', 'query 必须是字符串');
  }
  if (typeof evalCase.user_id !== 'string' || evalCase.user_id.trim() === '') {
    throw new EvalCaseError('user_id', '§11.1 user_id 必填');
  }

  const assertion = evalCase.assertion === undefined ? {} : evalCase.assertion;
  if (!isPlainObject(assertion)) {
    throw new EvalCaseError('assertion', 'assertion 必须是对象');
  }
  const mode = assertion.mode === undefined ? 'contains' : assertion.mode;
  if (!EVAL_MODES.includes(mode)) {
    throw new EvalCaseError(
      'assertion.mode',
      `仅支持 ${EVAL_MODES.join(' | ')}（§11.2 规则 3，旧值 error/blocked/audit 已 deprecated）`
    );
  }
  if (assertion.combination !== undefined && assertion.combination !== 'and') {
    throw new EvalCaseError('assertion.combination', '§11.2 规则 2：多断言只允许 AND 组合');
  }
  if (assertion.min_hit !== undefined) {
    if (!Number.isInteger(assertion.min_hit) || assertion.min_hit < 1) {
      throw new EvalCaseError('assertion.min_hit', 'min_hit 必须是 >= 1 的整数');
    }
  }

  const expectError = hasExpectedError(evalCase.expected_error);
  const expectBlocked = evalCase.expected_blocked === true;
  if (evalCase.expected_blocked !== undefined && typeof evalCase.expected_blocked !== 'boolean') {
    throw new EvalCaseError('expected_blocked', 'expected_blocked 必须是布尔值');
  }
  // §11.2 规则 1：互斥校验（本任务自检明确要求该组合被拒绝）。
  if (expectError && expectBlocked) {
    throw new EvalCaseError(
      'expected_error',
      'expected_error 与 expected_blocked 互斥，不能同时非空（§11.2 规则 1）'
    );
  }

  for (const field of [
    'expected_mem_ids',
    'expected_span_ids',
    'expected_media_refs',
    'expected_injected_forms',
    'must_not_include',
    'tags',
  ]) {
    if (evalCase[field] !== undefined && !Array.isArray(evalCase[field])) {
      throw new EvalCaseError(field, `${field} 必须是数组`);
    }
  }

  const pointerMin = evalCase.expected_pointer_ratio_min;
  if (pointerMin !== undefined && pointerMin !== null &&
      (!Number.isFinite(pointerMin) || pointerMin < 0 || pointerMin > 1)) {
    throw new EvalCaseError('expected_pointer_ratio_min', '必须是 0~1 的数值');
  }
  const usedMax = evalCase.expected_used_tokens_max;
  if (usedMax !== undefined && usedMax !== null && (!Number.isFinite(usedMax) || usedMax < 0)) {
    throw new EvalCaseError('expected_used_tokens_max', '必须是非负数值');
  }
  const evidenceMin = evalCase.expected_evidence_completeness_min;
  if (evidenceMin !== undefined && evidenceMin !== null &&
      (!Number.isFinite(evidenceMin) || evidenceMin < 0 || evidenceMin > 1)) {
    throw new EvalCaseError('expected_evidence_completeness_min', '必须是 0~1 的数值');
  }

  return {
    mode,
    // §11.2 规则 8：min_hit 只对 overlap 生效；其他模式归一为 null（忽略，而不是报错）。
    minHit: mode === 'overlap' ? (assertion.min_hit ?? 1) : null,
    now: resolveNow(evalCase, ctx),
    expectError,
    expectBlocked,
    expectedError: normalizeExpectedError(evalCase.expected_error),
    expectedStatus: finiteOrNull(evalCase.expected_status),
  };
}

// ---------------------------------------------------------------------------
// 执行上下文与响应归一化
// ---------------------------------------------------------------------------

function resolveRecall(ctx) {
  if (ctx && typeof ctx.recall === 'function') return ctx.recall;
  if (ctx && ctx.retrieval && typeof ctx.retrieval.recall === 'function') return ctx.retrieval.recall;
  return require('./retrieval').recall;
}

function resolveWrite(ctx) {
  if (ctx && ctx.write && typeof ctx.write.writeOne === 'function') return ctx.write.writeOne;
  if (ctx && typeof ctx.writeOne === 'function') return ctx.writeOne;
  return require('./write').writeOne;
}

function responseStatusOf(response) {
  if (!response || typeof response !== 'object') return null;
  if (Number.isFinite(response.status)) return response.status;
  if (Number.isFinite(response.http_status)) return response.http_status;
  if (response.ok === false) return 400;
  return 200;
}

function responseErrorCodeOf(response) {
  if (!response || typeof response !== 'object') return null;
  return response.error_code
    ?? response.code
    ?? (response.error && typeof response.error === 'object' ? response.error.code : null)
    ?? null;
}

function responseBlockedOf(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.blocked === true) return true;
  if (response.safety && response.safety.blocked === true) return true;
  return false;
}

function responseSelected(response) {
  return response && Array.isArray(response.selected) ? response.selected : [];
}

function responseCandidates(response) {
  return response && Array.isArray(response.candidates) ? response.candidates : [];
}

function selectedIdsOf(response) {
  const ids = [];
  for (const entry of responseSelected(response)) {
    if (entry && entry.mem_id !== undefined && entry.mem_id !== null) {
      const id = String(entry.mem_id);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * 召回集合：优先使用响应显式 mem_ids；否则取 candidates ∪ selected。
 * §11.3 check_lists 的 resp.mem_ids 在本地召回响应中没有同名字段，故做确定性合并。
 */
function recalledMemIdsOf(response) {
  if (response && Array.isArray(response.mem_ids)) return uniqueStrings(response.mem_ids);
  const ids = [];
  for (const item of responseCandidates(response)) {
    if (item && item.mem_id !== undefined && item.mem_id !== null) ids.push(String(item.mem_id));
  }
  for (const item of responseSelected(response)) {
    if (item && item.mem_id !== undefined && item.mem_id !== null) ids.push(String(item.mem_id));
  }
  return uniqueStrings(ids);
}

function evidenceRefsOf(response) {
  const refs = [];
  for (const entry of [...responseCandidates(response), ...responseSelected(response)]) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.evidence_refs)) refs.push(...entry.evidence_refs);
    if (entry.evidence_ref !== undefined && entry.evidence_ref !== null) refs.push(entry.evidence_ref);
    if (entry.evidence && typeof entry.evidence === 'object') {
      if (Array.isArray(entry.evidence.evidence_refs)) refs.push(...entry.evidence.evidence_refs);
      if (entry.evidence.source_span !== undefined && entry.evidence.source_span !== null) {
        refs.push(entry.evidence.source_span);
      }
    }
  }
  return uniqueStrings(refs);
}

function mediaRefsOf(response) {
  if (response && Array.isArray(response.media_refs)) return uniqueStrings(response.media_refs);
  const refs = [];
  for (const entry of [...responseCandidates(response), ...responseSelected(response)]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.media_ref !== undefined && entry.media_ref !== null) refs.push(entry.media_ref);
    if (entry.content && entry.content.media_ref !== undefined && entry.content.media_ref !== null) {
      refs.push(entry.content.media_ref);
    }
  }
  return uniqueStrings(refs);
}

function lookupStoreColumn(ctx, memIds, column) {
  if (!ctx || !ctx.store || typeof ctx.store.all !== 'function' || memIds.length === 0) return [];
  const allowed = new Set(['media_ref']);
  if (!allowed.has(column)) return [];
  const placeholders = memIds.map(() => '?').join(', ');
  try {
    const rows = ctx.store.all(
      `SELECT ${column} AS value FROM memory_item WHERE mem_id IN (${placeholders}) ORDER BY mem_id`,
      ...memIds
    );
    const out = [];
    for (const row of rows) {
      if (row && row.value !== null && row.value !== undefined) out.push(String(row.value));
    }
    return uniqueStrings(out);
  } catch (error) {
    return [];
  }
}

function lookupAuditActions(ctx, evalCase, now) {
  if (!ctx || !ctx.store || typeof ctx.store.all !== 'function') return [];
  try {
    const rows = ctx.store.all(
      `SELECT action FROM memory_audit_log
        WHERE user_id = ? AND created_at <= ?
        ORDER BY created_at DESC, event_id DESC LIMIT 500`,
      String(evalCase.user_id),
      String(now)
    );
    return uniqueStrings(rows.map((row) => row.action));
  } catch (error) {
    return [];
  }
}

function auditActionsOf(ctx, response, evalCase, now) {
  const actions = [];
  if (response && Array.isArray(response.audit_actions)) actions.push(...response.audit_actions);
  if (response && Array.isArray(response.audit)) actions.push(...response.audit);
  if (response && isPlainObject(response.audit) && Array.isArray(response.audit.actions)) {
    actions.push(...response.audit.actions);
  }
  if (ctx && Array.isArray(ctx.audit_actions)) actions.push(...ctx.audit_actions);

  const normalized = [];
  for (const entry of actions) {
    if (typeof entry === 'string') normalized.push(entry);
    else if (entry && typeof entry === 'object' && entry.action) normalized.push(String(entry.action));
  }
  normalized.push(...lookupAuditActions(ctx, evalCase, now));
  return uniqueStrings(normalized);
}

function auditContains(actions, action) {
  if (!action) return false;
  return actions.includes(String(action));
}

// ---------------------------------------------------------------------------
// 断言构造
// ---------------------------------------------------------------------------

function makeAssertion(name, ok, expected, actual, detail) {
  return {
    name,
    ok: ok === true,
    expected,
    actual,
    detail: detail ?? '',
  };
}

function setAssertion(name, expectedList, actualList, mode, minHit) {
  const expected = uniqueStrings(expectedList);
  const actual = uniqueStrings(actualList);
  if (expected.length === 0) return null;

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  let ok = false;
  let detail = '';

  if (mode === 'contains') {
    const missing = expected.filter((value) => !actualSet.has(value));
    ok = missing.length === 0;
    detail = `contains：召回需包含全部期望；缺失 ${missing.length} 个`;
  } else if (mode === 'exact') {
    ok = expected.length === actual.length && expected.every((value) => actualSet.has(value));
    detail = 'exact：召回集合必须与期望集合相等';
  } else if (mode === 'subset') {
    const extra = actual.filter((value) => !expectedSet.has(value));
    ok = extra.length === 0;
    detail = `subset：召回必须是期望的子集；多出 ${extra.length} 个`;
  } else if (mode === 'overlap') {
    const hits = expected.filter((value) => actualSet.has(value));
    ok = hits.length >= minHit;
    detail = `overlap：至少命中 min_hit=${minHit} 个，实际命中 ${hits.length} 个`;
  }

  return makeAssertion(name, ok, {
    mode,
    values: expected,
    min_hit: mode === 'overlap' ? minHit : null,
  }, actual, detail);
}

// ---------------------------------------------------------------------------
// §12 指标
// ---------------------------------------------------------------------------

function isTombstone(entry, candidate) {
  const lifecycle = entry && entry.lifecycle_state
    ? entry.lifecycle_state
    : (candidate && candidate.lifecycle_state);
  if (lifecycle === 'deleted_pending' || lifecycle === 'deleted_tombstone') return true;
  const deletion = entry && entry.deletion_state
    ? entry.deletion_state
    : (candidate && (candidate.deletion_state ?? candidate.evidence?.deletion_state));
  return deletion === 'tombstone' || deletion === 'content_deleted_audit_retained';
}

function rawSpanTokensOf(entry, candidate) {
  const sources = [
    entry && entry.raw_span_tokens,
    candidate && candidate.raw_span_tokens,
    candidate && candidate.evidence && candidate.evidence.raw_span_tokens,
    candidate && candidate.raw_text,
    candidate && candidate.evidence && candidate.evidence.raw_text,
    candidate && candidate.evidence && candidate.evidence.text_excerpt,
    candidate && candidate.summary_long,
    entry && entry.content,
  ];
  for (const source of sources) {
    if (typeof source === 'number' && Number.isFinite(source) && source >= 0) return source;
    if (typeof source === 'string' && source.length > 0) return estimateTokens(source);
  }
  // 契约未给 raw_span_tokens 的响应字段；没有原文时退化为 summary_short 的 token 估算。
  const fallback = candidate && candidate.summary_short;
  return typeof fallback === 'string' ? estimateTokens(fallback) : 0;
}

function budgetTokensOf(budget) {
  if (typeof budget === 'number' && Number.isFinite(budget)) return Math.max(0, Math.floor(budget));
  if (isPlainObject(budget)) {
    if (Number.isFinite(budget.recalled_memory)) return Math.max(0, Math.floor(budget.recalled_memory));
    try {
      return normalizeBudget(budget).recalled_memory;
    } catch (error) {
      return 0;
    }
  }
  return 0;
}

/**
 * §12 指标计算。
 *
 * @param {object} result 召回响应，或 runCase 返回值（自动取 result.response）
 * @param {{budget?:number|object, candidates?:Array, selected?:Array,
 *          expected_mem_ids?:string[]}} [options]
 * @returns {object} 指标（0~1 比例保留 4 位）
 *
 * 口径说明：
 *   - recall_hit_rate（本函数键名 hit_rate）= 被采纳召回条目数 / 召回注入条目数。
 *     本地响应没有“生成引用/用户确认/fetch_*”采纳事件时，退化为“命中期望的注入条目数 /
 *     注入条目数”，并以 hit_rate_is_fallback 标记；契约 §12 未定义该降级口径。
 *   - compression_ratio 分母只算 recalled_memory 预算内注入 token；tombstone 不进分子，
 *     指针条目按 pointer 渲染 token 计入分母（§12 原文）。
 *   - duplicate_injection_rate 复用 scoring.duplicateInjectionRate：重复条目数 / 注入条目数。
 *   - precision@k / recall@k 的 k 取本次预算内实际注入条目数（本地无显式 k 参数时）。
 */
function metricsFor(result, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  // 直接传入 runCase 结果且未要求重算时，复用其已计算的指标。
  if (isPlainObject(result) && isPlainObject(result.metrics) && Object.keys(opts).length === 0) {
    return result.metrics;
  }
  const response = result && isPlainObject(result.response) ? result.response : (result || {});
  const selected = Array.isArray(opts.selected)
    ? opts.selected
    : responseSelected(response);
  const candidates = Array.isArray(opts.candidates)
    ? opts.candidates
    : responseCandidates(response);

  const candidateById = new Map();
  for (const candidate of candidates) {
    if (!candidate || candidate.mem_id === undefined || candidate.mem_id === null) continue;
    const id = String(candidate.mem_id);
    if (!candidateById.has(id)) candidateById.set(id, candidate);
  }

  const expected = uniqueStrings(
    opts.expected_mem_ids
    ?? (result && result.expected_mem_ids)
    ?? response.expected_mem_ids
    ?? []
  );
  const relevant = new Set(expected);

  const injectedIds = selected.map((entry) => (
    entry && entry.mem_id !== undefined && entry.mem_id !== null ? String(entry.mem_id) : ''
  ));
  const injectedCount = injectedIds.length;
  const uniqueInjectedCount = new Set(injectedIds).size;
  const hitIds = injectedIds.filter((id) => relevant.has(id));

  // 采纳事件（若调用方显式提供）优先；否则按“命中期望”降级。
  let adoptedCount = null;
  let hasAdoptionSignal = false;
  for (const entry of selected) {
    if (!entry || typeof entry !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(entry, 'adopted')) {
      hasAdoptionSignal = true;
      if (entry.adopted === true) adoptedCount = (adoptedCount ?? 0) + 1;
    }
  }
  if (!hasAdoptionSignal) adoptedCount = null;
  const hitRateFallback = adoptedCount === null;
  const hitCount = hitRateFallback ? hitIds.length : adoptedCount;
  const hitRate = injectedCount === 0 ? 0 : hitCount / injectedCount;
  const precisionAtK = injectedCount === 0 ? 0 : hitIds.length / injectedCount;
  const recallAtK = expected.length === 0 ? 0 : hitIds.length / expected.length;

  // §12 evidence_completeness_rate = 可回溯条目数 / 注入条目数。
  const responseCompleteness = finiteOrNull(response.evidence_completeness);
  let drillable = 0;
  for (const entry of selected) {
    const candidate = entry && entry.mem_id !== undefined
      ? candidateById.get(String(entry.mem_id))
      : null;
    if (entry && entry.evidence_drillable === true) drillable += 1;
    else if (entry && entry.evidence_ref) drillable += 1;
    else if (candidate && Array.isArray(candidate.evidence_refs) && candidate.evidence_refs.length > 0) {
      drillable += 1;
    }
  }
  const evidenceCompleteness = responseCompleteness !== null
    ? responseCompleteness
    : (injectedCount === 0 ? 0 : drillable / injectedCount);

  // §12 compression_ratio：分子 raw_span_tokens of injected mems；分母 recalled_memory 注入 token。
  let rawSpanTokens = 0;
  let injectionTokens = 0;
  for (const entry of selected) {
    const id = entry && entry.mem_id !== undefined && entry.mem_id !== null ? String(entry.mem_id) : '';
    const candidate = candidateById.get(id) ?? null;
    if (isTombstone(entry, candidate)) continue;
    rawSpanTokens += rawSpanTokensOf(entry, candidate);
    injectionTokens += entry && Number.isFinite(entry.tokens) ? entry.tokens : 0;
  }
  const compressionRatio = injectionTokens === 0 ? 0 : rawSpanTokens / injectionTokens;

  const duplicate = duplicateInjectionRate(selected);
  const usedTokens = finiteOrNull(response.used_tokens) !== null
    ? response.used_tokens
    : selected.reduce((sum, entry) => sum + (entry && Number.isFinite(entry.tokens) ? entry.tokens : 0), 0);
  const budgetTokens = budgetTokensOf(opts.budget ?? response.budget);
  const budgetUtilization = budgetTokens > 0 ? usedTokens / budgetTokens : 0;

  const pointerCount = selected.filter((entry) => entry && entry.injected_form === 'pointer').length;

  const resultMetrics = {
    hit_rate: round4(hitRate),
    precision_at_k: round4(precisionAtK),
    recall_at_k: round4(recallAtK),
    evidence_completeness: round4(evidenceCompleteness),
    compression_ratio: round4(compressionRatio),
    duplicate_injection_rate: round4(duplicate.rate),
    used_tokens: Math.max(0, usedTokens),
    budget_utilization: round4(budgetUtilization),
    // 辅助计数（便于排障；runSuite 只聚合数值型指标）
    candidate_count: candidates.length,
    injected_count: injectedCount,
    unique_injected_count: uniqueInjectedCount,
    expected_count: expected.length,
    pointer_count: pointerCount,
    pointer_ratio: round4(injectedCount === 0 ? 0 : pointerCount / injectedCount),
    raw_span_tokens: rawSpanTokens,
    injection_tokens: injectionTokens,
    budget_tokens: budgetTokens,
    duplicate_injected_count: duplicate.duplicate_count,
    hit_rate_is_fallback: hitRateFallback,
  };
  // 契约与任务描述使用 precision@k / recall@k 记法；同时提供下划线键便于代码访问。
  Object.defineProperty(resultMetrics, 'precision@k', { value: resultMetrics.precision_at_k, enumerable: false });
  Object.defineProperty(resultMetrics, 'recall@k', { value: resultMetrics.recall_at_k, enumerable: false });
  return resultMetrics;
}

// ---------------------------------------------------------------------------
// setup 写入（执行器扩展；服务写入→召回链路）
// ---------------------------------------------------------------------------

function runSetup(ctx, evalCase, now, assertions) {
  const setup = evalCase.setup;
  if (!isPlainObject(setup) || !Array.isArray(setup.items) || setup.items.length === 0) {
    return { attempted: false, records: [] };
  }
  if (!ctx || !ctx.store) {
    assertions.push(makeAssertion(
      'setup_write',
      false,
      'ctx.store 可用',
      null,
      'setup 需要 ctx.store（getStore() 返回）'
    ));
    return { attempted: true, records: [] };
  }

  let writeOne;
  try {
    writeOne = resolveWrite(ctx);
  } catch (error) {
    assertions.push(makeAssertion('setup_write', false, 'write 模块可用', null, String(error.message)));
    return { attempted: true, records: [] };
  }

  const repeatRaw = Number(setup.repeat ?? 1);
  const repeat = Number.isInteger(repeatRaw) ? Math.min(3, Math.max(1, repeatRaw)) : 1;
  const sourceTurn = setup.source_turn_id ?? `turn_${evalCase.case_id}`;
  const records = [];

  for (const item of setup.items) {
    if (!isPlainObject(item)) continue;
    const itemUser = item.user_id ?? evalCase.user_id;
    const itemAgent = item.agent_id ?? evalCase.agent_id ?? (ctx.agentId ?? null);
    for (let round = 0; round < repeat; round += 1) {
      let result = null;
      try {
        result = writeOne(ctx.store, item, {
          source_turn_id: sourceTurn,
          context: {
            user_id: itemUser,
            agent_id: itemAgent,
            now,
          },
          request_id: `eval_setup:${evalCase.case_id}:${item.item_index ?? 0}:${round}`,
          now,
        });
      } catch (error) {
        result = { ok: false, code: error?.code ?? 'write_threw', message: error?.message ?? String(error) };
      }
      records.push({
        mem_id: result && result.mem_id !== undefined ? String(result.mem_id) : null,
        ok: Boolean(result && result.ok),
        status: result ? result.status ?? null : null,
        duplicate: Boolean(result && result.duplicate),
        code: result ? result.code ?? null : null,
        message: result ? result.message ?? null : null,
        round,
        expected_mem_id: item.mem_id ?? null,
      });
    }
  }

  const failed = records.filter((record) => !record.ok);
  assertions.push(makeAssertion(
    'setup_write',
    failed.length === 0,
    `setup 写入 ${records.length} 次全部成功`,
    {
      attempted: records.length,
      succeeded: records.length - failed.length,
      failed: failed.map((record) => ({
        mem_id: record.mem_id,
        code: record.code,
        message: record.message,
        round: record.round,
      })),
    },
    '§23.1 写入→召回前置数据准备'
  ));

  if (evalCase.expect_setup_idempotent === true) {
    // 同一 item 跨轮次的 mem_id 必须完全一致；第一轮成功、后续轮次 duplicate 或 succeeded 均视为幂等。
    const byItem = new Map();
    for (let index = 0; index < setup.items.length; index += 1) {
      const itemKey = setup.items[index].mem_id ?? `#${index}`;
      const itemRecords = records.filter((record, recordIndex) => {
        return Math.floor(recordIndex / repeat) === index;
      });
      byItem.set(itemKey, itemRecords);
    }
    const unstable = [];
    for (const [itemKey, itemRecords] of byItem.entries()) {
      const ids = uniqueStrings(itemRecords.map((record) => record.mem_id));
      if (ids.length !== 1) {
        unstable.push({ item: itemKey, mem_ids: ids });
      }
    }
    assertions.push(makeAssertion(
      'setup_idempotent',
      unstable.length === 0 && failed.length === 0,
      '同一事件重复写入产生同一组 mem_id（§23.1 per-item 幂等）',
      unstable.length === 0 ? 'mem_id 稳定' : unstable,
      '重复写入轮次见 setup.repeat'
    ));
  }

  return { attempted: true, records };
}

// ---------------------------------------------------------------------------
// §11.3 run_case
// ---------------------------------------------------------------------------

function executeRecall(ctx, evalCase, now) {
  if (ctx && typeof ctx.executor === 'function') {
    const custom = ctx.executor(evalCase, ctx);
    if (custom && typeof custom.then === 'function') {
      throw new EvalCaseError('ctx.executor', 'executor 必须是同步函数（runCase 返回同步结果）');
    }
    return custom ?? {};
  }

  if (!ctx || !ctx.store) {
    throw new Error('runCase 需要 ctx.store（getStore() 返回）或 ctx.executor');
  }

  const recall = resolveRecall(ctx);
  const request = {
    query: evalCase.query,
    user_id: evalCase.user_id,
    agent_id: evalCase.agent_id ?? (ctx.agentId ?? undefined),
    top_k: evalCase.top_k,
    now,
    token_budget: evalCase.token_budget ?? evalCase.budget,
    scenario: evalCase.scenario,
    must_inject: evalCase.must_inject,
    types: evalCase.types,
    layer: evalCase.layers ?? evalCase.layer,
    sensitivity_max: evalCase.sensitivity_max,
    purpose: evalCase.purpose,
    include_why_recalled: evalCase.include_why_recalled,
    request_id: evalCase.request_id ?? `eval:${evalCase.case_id}:${now}`,
  };
  // 未显式设置的字段保持 undefined，避免覆盖 recall 的契约默认值。
  for (const key of Object.keys(request)) {
    if (request[key] === undefined) delete request[key];
  }
  return recall(ctx.store, request);
}

function errorFromThrow(error) {
  const status = Number.isFinite(error?.status) ? error.status : 500;
  const code = error?.code && typeof error.code === 'string' ? error.code : 'internal_error';
  return {
    ok: false,
    status,
    error_code: code,
    blocked: false,
    selected: [],
    candidates: [],
    used_tokens: 0,
    message: error?.message ?? String(error),
  };
}

/**
 * §11.3 run_case：执行单条用例并返回断言与指标。
 *
 * @param {object} ctx {store, now?, agentId?, executor?, recall?, write?, audit_actions?}
 * @param {object} evalCase eval_case.v4.1
 * @returns {{case_id:string, ok:boolean, assertions:Array, metrics:object}}
 */
function runCase(ctx, evalCase) {
  const checked = validateCase(evalCase, ctx); // 校验失败直接抛出，满足“互斥组合被拒绝”
  const now = checked.now;
  const assertions = [];

  // 1) 执行器扩展：写入前置数据（写入→召回）。
  runSetup(ctx, evalCase, now, assertions);

  // 2) 执行召回（默认走 retrieval.recall，可被 ctx.executor 覆盖以构造负例）。
  let response = {};
  let executionError = null;
  try {
    response = executeRecall(ctx, evalCase, now);
  } catch (error) {
    executionError = error;
    response = errorFromThrow(error);
  }

  const status = responseStatusOf(response);
  const errorCode = responseErrorCodeOf(response);
  const blocked = responseBlockedOf(response);
  const selected = responseSelected(response);
  const recalledIds = recalledMemIdsOf(response);
  const auditActions = auditActionsOf(ctx, response, evalCase, now);

  // 3) metrics 先算：expected_evidence_completeness_min 依赖指标值。
  const metrics = metricsFor(
    { ...response, expected_mem_ids: evalCase.expected_mem_ids ?? [] },
    {
      budget: evalCase.token_budget ?? evalCase.budget ?? response.budget,
      candidates: responseCandidates(response),
      selected,
      expected_mem_ids: evalCase.expected_mem_ids ?? [],
    }
  );

  // 4) §11.2 规则 4/5：error 或 blocked 分支互斥，且都跳过列表检查。
  if (checked.expectError) {
    const expected = checked.expectedError;
    // §11.3：expected_status 显式优先；未给时取 expected_error 对象内的 status，最后按错误码推断。
    const expectedStatus = checked.expectedStatus ?? expected.status ?? inferStatusForError(expected.code);
    const ok = expected.code !== null && expectedStatus !== null &&
      status === expectedStatus && errorCode === expected.code;
    assertions.push(makeAssertion(
      'expected_error',
      ok,
      { status: expectedStatus, error_code: expected.code },
      { status, error_code: errorCode },
      '§11.2 规则 4：校验 HTTP status + error_code，跳过列表检查，仍校验 audit'
    ));
  } else if (checked.expectBlocked) {
    // §11.3 R1 修复：删除 sensitivity_blocked 死条件；改用显式布尔或。
    const hasSafetyAudit = auditContains(auditActions, 'safety.block');
    const blockedOk = blocked && (hasSafetyAudit || (status === 451 && errorCode === 'sensitivity_blocked'));
    assertions.push(makeAssertion(
      'expected_blocked',
      blockedOk,
      '(blocked=true) 且（safety.block 审计 或 HTTP 451 + sensitivity_blocked）',
      { blocked, status, error_code: errorCode, safety_block_audit: hasSafetyAudit },
      '§11.2 规则 5 / §11.3：blocked 分支跳过列表检查'
    ));
  } else {
    // §11.2 规则 3 + 规则 8：仅普通召回才做列表检查；min_hit 只作用于 overlap。
    const memAssertion = setAssertion(
      'expected_mem_ids', evalCase.expected_mem_ids, recalledIds, checked.mode, checked.minHit
    );
    if (memAssertion) assertions.push(memAssertion);

    const spanAssertion = setAssertion(
      'expected_span_ids',
      evalCase.expected_span_ids,
      evalCase.expected_span_ids === undefined ? [] : evidenceRefsOf(response),
      checked.mode,
      checked.minHit
    );
    if (spanAssertion) assertions.push(spanAssertion);

    const mediaActual = mediaRefsOf(response).concat(
      lookupStoreColumn(ctx, recalledIds, 'media_ref')
    );
    const mediaAssertion = setAssertion(
      'expected_media_refs', evalCase.expected_media_refs, mediaActual, checked.mode, checked.minHit
    );
    if (mediaAssertion) assertions.push(mediaAssertion);
  }

  // §11.2 规则 5：expected_blocked_action 额外要求审计含该 action。
  if (evalCase.expected_blocked_action) {
    assertions.push(makeAssertion(
      'expected_blocked_action',
      auditContains(auditActions, evalCase.expected_blocked_action),
      evalCase.expected_blocked_action,
      auditActions,
      '§11.2 规则 5：审计必须含指定 action'
    ));
  }

  // §11.2 规则 6：审计 action 独立 AND。
  if (evalCase.expected_audit_action) {
    assertions.push(makeAssertion(
      'expected_audit_action',
      auditContains(auditActions, evalCase.expected_audit_action),
      evalCase.expected_audit_action,
      auditActions,
      '§11.2 规则 6：expected_audit_action 独立 AND'
    ));
  }

  // §11.2 规则 7：must_not_include 独立 AND，检查召回 mem_ids。
  if (Array.isArray(evalCase.must_not_include) && evalCase.must_not_include.length > 0) {
    const forbidden = uniqueStrings(evalCase.must_not_include);
    const leaked = forbidden.filter((id) => recalledIds.includes(id));
    assertions.push(makeAssertion(
      'must_not_include',
      leaked.length === 0,
      forbidden,
      recalledIds,
      `§11.2 规则 7：召回不得包含任一；实际泄漏 ${leaked.length} 个`
    ));
  }

  // §11.3：expected_injected_forms（契约未定义匹配细节，取“期望形态均出现”的包含语义）。
  if (Array.isArray(evalCase.expected_injected_forms) && evalCase.expected_injected_forms.length > 0) {
    const expectedForms = uniqueStrings(evalCase.expected_injected_forms);
    const actualForms = uniqueStrings(selected.map((entry) => entry && entry.injected_form));
    const missing = expectedForms.filter((form) => !actualForms.includes(form));
    assertions.push(makeAssertion(
      'expected_injected_forms',
      missing.length === 0,
      expectedForms,
      actualForms,
      '§11.3 forms_match：期望的注入形态均需出现（取包含语义）'
    ));
  }

  // §11.3 expected_pointer_ratio_min；§5.4/§23.2：空 selected 跳过 pointer 断言。
  if (evalCase.expected_pointer_ratio_min !== undefined && evalCase.expected_pointer_ratio_min !== null) {
    if (selected.length === 0) {
      assertions.push(makeAssertion(
        'expected_pointer_ratio_min',
        true,
        evalCase.expected_pointer_ratio_min,
        null,
        '§5.4/§23.2：空 selected 跳过 pointer 断言'
      ));
    } else {
      const ratio = finiteOrNull(response.pointer_ratio) !== null
        ? response.pointer_ratio
        : metrics.pointer_ratio;
      assertions.push(makeAssertion(
        'expected_pointer_ratio_min',
        ratio >= evalCase.expected_pointer_ratio_min,
        evalCase.expected_pointer_ratio_min,
        ratio,
        '§11.3 expected_pointer_ratio_min'
      ));
    }
  }

  // §11.3 expected_used_tokens_max（§12 预算硬约束）。
  if (evalCase.expected_used_tokens_max !== undefined && evalCase.expected_used_tokens_max !== null) {
    const used = metrics.used_tokens;
    assertions.push(makeAssertion(
      'expected_used_tokens_max',
      used <= evalCase.expected_used_tokens_max,
      evalCase.expected_used_tokens_max,
      used,
      '§11.3 expected_used_tokens_max / §5.4 预算硬约束'
    ));
  }

  if (evalCase.expected_partial_success !== undefined && evalCase.expected_partial_success !== null) {
    const actual = response.partial_success ?? response.parse_status ?? null;
    assertions.push(makeAssertion(
      'expected_partial_success',
      actual === evalCase.expected_partial_success,
      evalCase.expected_partial_success,
      actual,
      '§11.3 expected_partial_success'
    ));
  }

  if (evalCase.expected_cache_state !== undefined && evalCase.expected_cache_state !== null) {
    const actual = response.cache_state
      ?? (response.cache_hit === true ? 'hit' : (response.cache_hit === false ? 'miss' : null));
    assertions.push(makeAssertion(
      'expected_cache_state',
      actual === evalCase.expected_cache_state,
      evalCase.expected_cache_state,
      actual,
      '§11.3 expected_cache_state'
    ));
  }

  if (evalCase.expected_deletion_job_state !== undefined && evalCase.expected_deletion_job_state !== null) {
    const actual = response.deletion_job_state ?? response.deletion_job?.status ?? null;
    assertions.push(makeAssertion(
      'expected_deletion_job_state',
      actual === evalCase.expected_deletion_job_state,
      evalCase.expected_deletion_job_state,
      actual,
      '§11.3 expected_deletion_job_state'
    ));
  }

  if (evalCase.expected_prospective_status !== undefined && evalCase.expected_prospective_status !== null) {
    const actual = response.prospective_status ?? response.prospective?.status ?? null;
    assertions.push(makeAssertion(
      'expected_prospective_status',
      actual === evalCase.expected_prospective_status,
      evalCase.expected_prospective_status,
      actual,
      '§11.3 expected_prospective_status'
    ));
  }

  // 执行器扩展：§12 证据完整率下限（§11.1 无该期望字段）。
  if (evalCase.expected_evidence_completeness_min !== undefined &&
      evalCase.expected_evidence_completeness_min !== null) {
    assertions.push(makeAssertion(
      'expected_evidence_completeness_min',
      metrics.evidence_completeness >= evalCase.expected_evidence_completeness_min,
      evalCase.expected_evidence_completeness_min,
      metrics.evidence_completeness,
      '§12 evidence_completeness_rate = 可回溯条目数 / 注入条目数'
    ));
  }

  // §11.2 规则 2：所有非空期望字段 AND 组合。允许“只做 setup 幂等”的用例没有召回断言。
  const ok = assertions.every((assertion) => assertion.ok === true);

  const caseResult = {
    case_id: evalCase.case_id,
    ok,
    assertions,
    metrics,
    // 以下为执行器辅助信息，便于失败定位；不属于 §11 契约返回体。
    query: evalCase.query,
    user_id: evalCase.user_id,
    now,
    execution_error: executionError ? String(executionError.message ?? executionError) : null,
    observed: {
      status,
      error_code: errorCode,
      blocked,
      candidate_ids: uniqueStrings(responseCandidates(response).map((item) => item?.mem_id)),
      selected_ids: selectedIdsOf(response),
      used_tokens: metrics.used_tokens,
      pointer_ratio: metrics.pointer_ratio,
      audit_actions: auditActions,
    },
  };
  // 保留原始响应供 metricsFor(runCase 结果) 复用，但不参与序列化与报告表格。
  Object.defineProperty(caseResult, 'response', {
    value: response,
    enumerable: false,
    configurable: true,
  });
  return caseResult;
}

// ---------------------------------------------------------------------------
// runSuite / summarize
// ---------------------------------------------------------------------------

function runSuite(ctx, cases) {
  const list = Array.isArray(cases) ? cases : [];
  const caseResults = [];
  const failures = [];
  const metricValues = new Map();

  for (const evalCase of list) {
    let result;
    try {
      result = runCase(ctx, evalCase);
    } catch (error) {
      result = {
        case_id: evalCase && evalCase.case_id ? evalCase.case_id : '(missing_case_id)',
        ok: false,
        assertions: [makeAssertion(
          'schema_valid',
          false,
          'eval_case 校验通过',
          { code: error?.code ?? null, field: error?.field ?? null },
          String(error?.message ?? error)
        )],
        metrics: metricsFor({}),
        query: evalCase && evalCase.query,
        user_id: evalCase && evalCase.user_id,
        now: (evalCase && evalCase.now) ?? (ctx && ctx.now) ?? null,
        execution_error: String(error?.message ?? error),
        observed: null,
      };
    }
    caseResults.push(result);

    if (result.ok !== true) {
      const failedAssertions = result.assertions
        .filter((assertion) => assertion.ok !== true)
        .map((assertion) => ({
          name: assertion.name,
          expected: assertion.expected,
          actual: assertion.actual,
          detail: assertion.detail,
        }));
      failures.push({
        case_id: result.case_id,
        failed_assertions: failedAssertions,
        execution_error: result.execution_error ?? null,
      });
    }

    if (result.metrics && typeof result.metrics === 'object') {
      for (const [metric, value] of Object.entries(result.metrics)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (!metricValues.has(metric)) metricValues.set(metric, []);
        metricValues.get(metric).push(value);
      }
    }
  }

  const byMetric = {};
  for (const [metric, values] of metricValues.entries()) {
    const sum = values.reduce((acc, value) => acc + value, 0);
    byMetric[metric] = {
      count: values.length,
      mean: round4(sum / values.length),
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  const total = caseResults.length;
  const passed = caseResults.filter((result) => result.ok === true).length;
  return {
    total,
    passed,
    failed: total - passed,
    by_metric: byMetric,
    failures,
    cases: caseResults,
  };
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width, align = 'left') {
  const value = String(text);
  const pad = Math.max(0, width - displayWidth(value));
  return align === 'right' ? `${' '.repeat(pad)}${value}` : `${value}${' '.repeat(pad)}`;
}

function table(rows, aligns = []) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const columns = rows[0].length;
  const widths = new Array(columns).fill(0);
  for (const row of rows) {
    for (let index = 0; index < columns; index += 1) {
      widths[index] = Math.max(widths[index], displayWidth(row[index] ?? ''));
    }
  }
  return rows.map((row) => row.map((cell, index) => (
    padDisplay(cell ?? '', widths[index], aligns[index] ?? 'left')
  )).join('  ').replace(/\s+$/, '')).join('\n');
}

function formatMetricValue(metric, value) {
  if (!Number.isFinite(value)) return String(value);
  if (metric === 'used_tokens' || metric === 'candidate_count' || metric === 'injected_count' ||
      metric === 'unique_injected_count' || metric === 'expected_count' || metric === 'pointer_count' ||
      metric === 'raw_span_tokens' || metric === 'injection_tokens' || metric === 'budget_tokens' ||
      metric === 'duplicate_injected_count') {
    return String(value);
  }
  return value.toFixed(4);
}

const METRIC_ORDER = [
  'hit_rate',
  'precision_at_k',
  'recall_at_k',
  'evidence_completeness',
  'compression_ratio',
  'duplicate_injection_rate',
  'used_tokens',
  'budget_utilization',
];

/**
 * 生成中文文本报告（表格化），返回值可直接写入 .txt/.md 文件。
 * @param {object} suiteResult runSuite 返回值
 * @returns {string}
 */
function summarize(suiteResult) {
  const suite = isPlainObject(suiteResult) ? suiteResult : {};
  const cases = Array.isArray(suite.cases) ? suite.cases : [];
  const total = Number.isInteger(suite.total) ? suite.total : cases.length;
  const passed = Number.isInteger(suite.passed)
    ? suite.passed
    : cases.filter((item) => item.ok === true).length;
  const failed = Number.isInteger(suite.failed) ? suite.failed : Math.max(0, total - passed);
  const passRate = total === 0 ? 0 : (passed / total) * 100;
  const frozenNow = (cases.find((item) => item.now) || {}).now ?? '(未记录)';

  const lines = [];
  lines.push('记忆评测报告（eval_case.v4.1）');
  lines.push('='.repeat(60));
  lines.push(`用例总数：${total}    通过：${passed}    失败：${failed}    通过率：${passRate.toFixed(2)}%`);
  lines.push(`冻结时间 now：${frozenNow}（§11.2 规则 9，不使用系统时钟）`);
  lines.push('');

  lines.push('【指标汇总】');
  const byMetric = isPlainObject(suite.by_metric) ? suite.by_metric : {};
  const metrics = Object.keys(byMetric);
  const ordered = METRIC_ORDER.filter((metric) => metrics.includes(metric))
    .concat(metrics.filter((metric) => !METRIC_ORDER.includes(metric)).sort());
  if (ordered.length === 0) {
    lines.push('（无可用数值指标）');
  } else {
    const rows = [['指标', '样本数', '均值', '最小', '最大']];
    for (const metric of ordered) {
      const entry = byMetric[metric] || {};
      rows.push([
        metric,
        String(entry.count ?? 0),
        formatMetricValue(metric, entry.mean),
        formatMetricValue(metric, entry.min),
        formatMetricValue(metric, entry.max),
      ]);
    }
    lines.push(table(rows, ['left', 'right', 'right', 'right', 'right']));
  }
  lines.push('');

  lines.push('【用例结果】');
  if (cases.length === 0) {
    lines.push('（无用例）');
  } else {
    const rows = [['case_id', '结果', '断言数', '失败断言']];
    for (const item of cases) {
      const assertionList = Array.isArray(item.assertions) ? item.assertions : [];
      const failedNames = assertionList.filter((assertion) => assertion.ok !== true).map((a) => a.name);
      rows.push([
        item.case_id ?? '(unknown)',
        item.ok === true ? 'PASS' : 'FAIL',
        String(assertionList.length),
        failedNames.length === 0 ? '-' : failedNames.join(', '),
      ]);
    }
    lines.push(table(rows, ['left', 'left', 'right', 'left']));
  }
  lines.push('');

  lines.push('【失败明细】');
  const failures = Array.isArray(suite.failures) ? suite.failures : [];
  if (failures.length === 0) {
    lines.push('无');
  } else {
    for (const failure of failures) {
      lines.push(`- ${failure.case_id}`);
      const failedAssertions = Array.isArray(failure.failed_assertions) ? failure.failed_assertions : [];
      if (failedAssertions.length === 0) {
        lines.push(`  执行错误：${failure.execution_error ?? '(未知)'}`);
        continue;
      }
      for (const assertion of failedAssertions) {
        lines.push(`  · ${assertion.name}`);
        lines.push(`    期望：${JSON.stringify(assertion.expected)}`);
        lines.push(`    实际：${JSON.stringify(assertion.actual)}`);
        if (assertion.detail) lines.push(`    说明：${assertion.detail}`);
      }
      if (failure.execution_error) lines.push(`    执行错误：${failure.execution_error}`);
    }
  }
  lines.push('='.repeat(60));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// defaultCases：可在空库/已有库上重复运行的基础用例（§23.1/§23.2/§23.5）
// ---------------------------------------------------------------------------

function makeSetupItem(spec) {
  return {
    mem_id: spec.mem_id,
    item_index: spec.item_index ?? 0,
    source_span: spec.source_span,
    type: spec.type,
    layer: spec.layer,
    summary_short: spec.summary_short,
    summary_long: spec.summary_long ?? spec.summary_short,
    structured: spec.structured ?? null,
    tags: spec.tags ?? [],
    entities: spec.entities ?? [],
    media_ref: spec.media_ref,
    importance: spec.importance ?? 0.8,
    confidence: spec.confidence ?? 0.9,
    source_reliability: spec.source_reliability ?? 0.9,
    sensitivity: spec.sensitivity ?? 'S1',
    ...(spec.user_id ? { user_id: spec.user_id } : {}),
  };
}

function defaultCases(ctx = {}) {
  const now = (ctx && ctx.now) || DEFAULT_NOW;
  const agentId = ctx && ctx.agentId ? ctx.agentId : undefined;
  const base = (caseId, extra) => ({
    schema_version: EVAL_SCHEMA_VERSION,
    case_id: caseId,
    now,
    agent_id: agentId,
    assertion: { mode: 'contains', min_hit: 1, combination: 'and' },
    token_budget: 800,
    top_k: 5,
    ...extra,
  });

  const cases = [];

  // 1) M1 fact：写入→召回→证据完整（fulltext 命中最基础链路）。
  cases.push(base('eval_m1_fact_contains', {
    query: 'evalm1fact 用户喜欢猫',
    user_id: 'user_eval_m1_fact',
    setup: {
      source_turn_id: 'turn_eval_m1_fact',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m1_fact',
        source_span: 'span_eval_m1_fact',
        type: 'fact',
        layer: 'M1',
        summary_short: 'evalm1fact 用户喜欢猫',
        summary_long: 'evalm1fact 用户说自己很喜欢猫，这是 M1 工作记忆中的事实。',
        structured: { entity: 'evalm1fact', predicate: 'pet', value: '猫' },
        tags: ['evalm1fact', '猫'],
        sensitivity: 'S0',
      })],
    },
    expected_mem_ids: ['mem_eval_m1_fact'],
    expected_used_tokens_max: 800,
    expected_evidence_completeness_min: 0.95,
  }));

  // 2) M2 preference：不同 type + M2 层。
  cases.push(base('eval_m2_preference_contains', {
    query: 'evalm2pref 用户偏好',
    user_id: 'user_eval_m2_pref',
    setup: {
      source_turn_id: 'turn_eval_m2_pref',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m2_pref',
        source_span: 'span_eval_m2_pref',
        type: 'preference',
        layer: 'M2',
        summary_short: 'evalm2pref 用户偏好喝美式咖啡',
        summary_long: 'evalm2pref 用户在当前会话里提到自己偏好喝美式咖啡。',
        structured: { entity: 'user', predicate: 'prefers', value: '美式咖啡' },
        tags: ['evalm2pref', '偏好'],
      })],
    },
    expected_mem_ids: ['mem_eval_m2_pref'],
    expected_used_tokens_max: 800,
  }));

  // 3) M2 task + 预算不超：must_inject 保证目标入选，再校验 used_tokens。
  cases.push(base('eval_m2_task_budget', {
    query: 'evalm2task 任务',
    user_id: 'user_eval_m2_task',
    token_budget: 120,
    must_inject: ['mem_eval_m2_task'],
    setup: {
      source_turn_id: 'turn_eval_m2_task',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m2_task',
        source_span: 'span_eval_m2_task',
        type: 'task',
        layer: 'M2',
        summary_short: 'evalm2task 用户要买猫粮',
        summary_long: 'evalm2task 用户今天需要完成买猫粮的任务。',
        structured: { entity: 'evalm2task', predicate: 'todo', value: '买猫粮' },
        tags: ['evalm2task', '任务'],
      })],
    },
    expected_mem_ids: ['mem_eval_m2_task'],
    expected_used_tokens_max: 120,
  }));

  // 4) M3 task + exact：该 user 只有一条记忆，召回集合可精确相等。
  cases.push(base('eval_m3_task_exact', {
    query: 'evalm3exact 交付报告',
    user_id: 'user_eval_m3_exact',
    assertion: { mode: 'exact', combination: 'and' },
    setup: {
      source_turn_id: 'turn_eval_m3_exact',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m3_exact',
        source_span: 'span_eval_m3_exact',
        type: 'task',
        layer: 'M3',
        summary_short: 'evalm3exact 用户周五交付报告',
        summary_long: 'evalm3exact 用户需要在周五交付项目报告。',
        structured: { entity: 'evalm3exact', predicate: 'deadline', value: '周五' },
        tags: ['evalm3exact', '任务'],
      })],
    },
    expected_mem_ids: ['mem_eval_m3_exact'],
  }));

  // 5) M3 procedure + contains：同 user 额外一条无关记忆，contains 允许召回多出条目。
  cases.push(base('eval_m3_procedure_contains', {
    query: 'evalm3proc 报销流程',
    user_id: 'user_eval_m3_proc',
    setup: {
      source_turn_id: 'turn_eval_m3_proc',
      items: [
        makeSetupItem({
          mem_id: 'mem_eval_m3_proc',
          item_index: 0,
          source_span: 'span_eval_m3_proc',
          type: 'procedure',
          layer: 'M3',
          summary_short: 'evalm3proc 用户报销流程：先填单再审批',
          summary_long: 'evalm3proc 用户公司的报销流程是先填单、再走审批。',
          structured: { entity: 'evalm3proc', predicate: 'steps', value: '填单→审批' },
          tags: ['evalm3proc', '流程'],
        }),
        makeSetupItem({
          mem_id: 'mem_eval_m3_proc_other',
          item_index: 1,
          source_span: 'span_eval_m3_proc_other',
          type: 'fact',
          layer: 'M3',
          summary_short: 'evalm3proc-other 用户住在杭州',
          structured: { entity: 'user', predicate: 'city', value: '杭州' },
          tags: ['evalm3proc-other'],
        }),
      ],
    },
    expected_mem_ids: ['mem_eval_m3_proc'],
    expected_used_tokens_max: 800,
  }));

  // 6) M3 relationship + overlap（min_hit 只对 overlap 生效，默认 1）。
  cases.push(base('eval_m3_relationship_overlap', {
    query: 'evalrelA evalrelB 朋友',
    user_id: 'user_eval_m3_rel',
    assertion: { mode: 'overlap', min_hit: 1, combination: 'and' },
    setup: {
      source_turn_id: 'turn_eval_m3_rel',
      items: [
        makeSetupItem({
          mem_id: 'mem_eval_m3_rel_a',
          item_index: 0,
          source_span: 'span_eval_m3_rel_a',
          type: 'relationship',
          layer: 'M3',
          summary_short: 'evalrelA 用户和小明是朋友',
          structured: { entity: 'user', predicate: 'friend', value: '小明' },
          tags: ['evalrelA', '关系'],
        }),
        makeSetupItem({
          mem_id: 'mem_eval_m3_rel_b',
          item_index: 1,
          source_span: 'span_eval_m3_rel_b',
          type: 'relationship',
          layer: 'M3',
          summary_short: 'evalrelB 用户和小红是同事',
          structured: { entity: 'user', predicate: 'colleague', value: '小红' },
          tags: ['evalrelB', '关系'],
        }),
      ],
    },
    expected_mem_ids: ['mem_eval_m3_rel_a', 'mem_eval_m3_rel_b'],
  }));

  // 7) M3 subset：召回必须是期望集合的子集（允许只命中其中一条）。
  cases.push(base('eval_m3_subset', {
    query: 'evalsubA 资料',
    user_id: 'user_eval_m3_subset',
    assertion: { mode: 'subset', combination: 'and' },
    setup: {
      source_turn_id: 'turn_eval_m3_subset',
      items: [
        makeSetupItem({
          mem_id: 'mem_eval_m3_subset_a',
          item_index: 0,
          source_span: 'span_eval_m3_subset_a',
          type: 'fact',
          layer: 'M3',
          summary_short: 'evalsubA 用户保存了项目资料',
          structured: { entity: 'evalsubA', predicate: 'has', value: '资料' },
          tags: ['evalsubA'],
        }),
        makeSetupItem({
          mem_id: 'mem_eval_m3_subset_b',
          item_index: 1,
          source_span: 'span_eval_m3_subset_b',
          type: 'task',
          layer: 'M3',
          summary_short: 'evalsubB 用户下周整理资料',
          structured: { entity: 'evalsubB', predicate: 'todo', value: '整理资料' },
          tags: ['evalsubB'],
        }),
      ],
    },
    expected_mem_ids: ['mem_eval_m3_subset_a', 'mem_eval_m3_subset_b'],
  }));

  // 8) M4 fact：永久档案层可写入、可召回。
  cases.push(base('eval_m4_fact_contains', {
    query: 'evalm4fact 档案',
    user_id: 'user_eval_m4_fact',
    setup: {
      source_turn_id: 'turn_eval_m4_fact',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m4_fact',
        source_span: 'span_eval_m4_fact',
        type: 'fact',
        layer: 'M4',
        summary_short: 'evalm4fact 用户的档案编号是 A-102',
        summary_long: 'evalm4fact 用户永久档案中的编号为 A-102。',
        structured: { entity: 'evalm4fact', predicate: 'archive_no', value: 'A-102' },
        tags: ['evalm4fact', '档案'],
      })],
    },
    expected_mem_ids: ['mem_eval_m4_fact'],
  }));

  // 9) M2 affect：情感类记忆召回。
  cases.push(base('eval_m2_affect_contains', {
    query: 'evalaffect 心情',
    user_id: 'user_eval_m2_affect',
    setup: {
      source_turn_id: 'turn_eval_m2_affect',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m2_affect',
        source_span: 'span_eval_m2_affect',
        type: 'affect',
        layer: 'M2',
        summary_short: 'evalaffect 用户今天心情不错',
        summary_long: 'evalaffect 用户今天情绪偏正面，心情不错。',
        structured: { entity: 'user', predicate: 'emotion', value: '开心' },
        tags: ['evalaffect', '情感'],
        sensitivity: 'S2',
      })],
    },
    expected_mem_ids: ['mem_eval_m2_affect'],
  }));

  // 10) M1 media_dossier：多模态记忆召回。
  cases.push(base('eval_m1_media_contains', {
    query: 'evalmedia 猫照片',
    user_id: 'user_eval_m1_media',
    setup: {
      source_turn_id: 'turn_eval_m1_media',
      items: [makeSetupItem({
        mem_id: 'mem_eval_m1_media',
        source_span: 'span_eval_m1_media',
        type: 'media_dossier',
        layer: 'M1',
        summary_short: 'evalmedia 用户上传了猫的照片',
        summary_long: 'evalmedia 用户上传了一张猫的照片，Dossier 摘要可用。',
        structured: { entity: 'file', predicate: 'content', value: '猫照片' },
        tags: ['evalmedia', '多模态'],
        media_ref: 'media_eval_m1',
        sensitivity: 'S2',
      })],
    },
    expected_mem_ids: ['mem_eval_m1_media'],
    expected_media_refs: ['media_eval_m1'],
  }));

  // 11) 证据完整率：§12 可回溯条目数 / 注入条目数 >= 0.95。
  cases.push(base('eval_evidence_completeness', {
    query: 'evalevidence 证据',
    user_id: 'user_eval_evidence',
    setup: {
      source_turn_id: 'turn_eval_evidence',
      items: [makeSetupItem({
        mem_id: 'mem_eval_evidence',
        source_span: 'span_eval_evidence',
        type: 'fact',
        layer: 'M3',
        summary_short: 'evalevidence 用户提供了可回溯证据',
        summary_long: 'evalevidence 该条目带有 source_span，可直接下钻到原文。',
        structured: { entity: 'evalevidence', predicate: 'has', value: '证据' },
        tags: ['evalevidence'],
      })],
    },
    expected_mem_ids: ['mem_eval_evidence'],
    expected_evidence_completeness_min: 0.95,
  }));

  // 12) 幂等：同一 setup 事件重复写入两轮，mem_id 必须稳定。
  cases.push(base('eval_idempotent_write', {
    query: 'evalidem 幂等',
    user_id: 'user_eval_idem',
    setup: {
      source_turn_id: 'turn_eval_idem',
      repeat: 2,
      items: [makeSetupItem({
        mem_id: 'mem_eval_idem',
        source_span: 'span_eval_idem',
        type: 'fact',
        layer: 'M3',
        summary_short: 'evalidem 同一事件只产生一组 id',
        summary_long: 'evalidem 用于验证 per-item 幂等的记忆条目。',
        structured: { entity: 'evalidem', predicate: 'idempotent', value: 'yes' },
        tags: ['evalidem'],
      })],
    },
    expect_setup_idempotent: true,
    expected_mem_ids: ['mem_eval_idem'],
  }));

  // 13) 跨用户隔离：其他 user 的同关键词条目不得出现在召回中。
  cases.push(base('eval_must_not_include_other_user', {
    query: 'evaliso 隐私',
    user_id: 'user_eval_isolation',
    setup: {
      source_turn_id: 'turn_eval_isolation',
      items: [
        makeSetupItem({
          mem_id: 'mem_eval_iso_owner',
          item_index: 0,
          source_span: 'span_eval_iso_owner',
          type: 'fact',
          layer: 'M3',
          summary_short: 'evaliso 用户自己的隐私条目',
          structured: { entity: 'evaliso', predicate: 'owner', value: 'self' },
          tags: ['evaliso'],
        }),
        makeSetupItem({
          mem_id: 'mem_eval_iso_other',
          item_index: 1,
          source_span: 'span_eval_iso_other',
          type: 'fact',
          layer: 'M3',
          summary_short: 'evaliso 其他用户的隐私条目',
          structured: { entity: 'evaliso', predicate: 'owner', value: 'other' },
          tags: ['evaliso'],
          user_id: 'user_eval_isolation_other',
        }),
      ],
    },
    expected_mem_ids: ['mem_eval_iso_owner'],
    must_not_include: ['mem_eval_iso_other'],
  }));

  // 14) S3 默认不注入：S3 条目必须被召回层过滤。
  cases.push(base('eval_s3_not_injected', {
    query: 'evals3 医疗',
    user_id: 'user_eval_s3',
    setup: {
      source_turn_id: 'turn_eval_s3',
      items: [
        makeSetupItem({
          mem_id: 'mem_eval_s3_normal',
          item_index: 0,
          source_span: 'span_eval_s3_normal',
          type: 'fact',
          layer: 'M3',
          summary_short: 'evals3 用户普通医疗记录',
          structured: { entity: 'evals3', predicate: 'level', value: 'normal' },
          tags: ['evals3'],
          sensitivity: 'S1',
        }),
        makeSetupItem({
          mem_id: 'mem_eval_s3_secret',
          item_index: 1,
          source_span: 'span_eval_s3_secret',
          type: 'fact',
          layer: 'M3',
          summary_short: 'evals3 用户 S3 医疗档案',
          // 谓词与普通记录不同，避免 §2.5 同实体同谓词冲突把 S1 记录 superseded。
          structured: { entity: 'evals3', predicate: 'secret_level', value: 'secret' },
          tags: ['evals3'],
          // 契约 §16.3：S3 默认拒绝注入。
          sensitivity: 'S3',
        }),
      ],
    },
    expected_mem_ids: ['mem_eval_s3_normal'],
    must_not_include: ['mem_eval_s3_secret'],
  }));

  // 15) 混合 type + 预算不超：同一 user 两种 type，校验召回与预算硬约束。
  cases.push(base('eval_mixed_types_budget', {
    query: 'evalmixed 综合',
    user_id: 'user_eval_mixed',
    token_budget: 160,
    setup: {
      source_turn_id: 'turn_eval_mixed',
      items: [
        makeSetupItem({
          mem_id: 'mem_eval_mixed_fact',
          item_index: 0,
          source_span: 'span_eval_mixed_fact',
          type: 'fact',
          layer: 'M2',
          summary_short: 'evalmixed 用户的综合事实记录',
          structured: { entity: 'evalmixed', predicate: 'fact', value: 'one' },
          tags: ['evalmixed'],
        }),
        makeSetupItem({
          mem_id: 'mem_eval_mixed_task',
          item_index: 1,
          source_span: 'span_eval_mixed_task',
          type: 'task',
          layer: 'M3',
          summary_short: 'evalmixed 用户的综合任务记录',
          structured: { entity: 'evalmixed', predicate: 'task', value: 'two' },
          tags: ['evalmixed'],
        }),
      ],
    },
    expected_mem_ids: ['mem_eval_mixed_fact', 'mem_eval_mixed_task'],
    expected_used_tokens_max: 160,
  }));

  return cases;
}

module.exports = {
  EVAL_SCHEMA_VERSION,
  EVAL_MODES,
  EvalCaseError,
  runCase,
  metricsFor,
  runSuite,
  summarize,
  defaultCases,
  // 以下为辅助导出，便于自检与排障（不属于本任务要求的对外契约面）。
  validateCase,
};
