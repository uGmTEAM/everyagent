'use strict';

/**
 * Token 预算分配与上下文组装（§5 + 附录 G）。
 *
 * 硬性规则（对应任务与契约）：
 *   - §5.1 不硬截断 evidence_id：预算不足时按压缩梯度降级，绝不截断 content/evidence；
 *   - §4.4 summary_long 预算不足只允许先降到 summary_short，不得直接跳 structured；
 *   - §5.2 superseded / deleted_* 不可注入；degraded 最高 tags；cold_archived 最高 pointer；
 *   - §5.5 pointer 必须有 why 码或可下钻 evidence_ref；每个入选条目必须通过完整性校验；
 *   - §5.4 空 selected 不做 pointer 断言；pointer 比例不达标只 warn；used <= budget；
 *   - §5.1/§5.4 同输入、同版本、同预算必须同输出：本模块不使用 Date.now / 随机数，
 *     时间一律由入参 now 传入；预算再利用最多 1 轮。
 */

const {
  TOKEN_BUDGET,
  LIFECYCLE_STATE,
  QUALITY_FLAG,
  SENSITIVITY,
  WHY_CODE,
} = require('./constants');
const { estimateTokens } = require('./tokenizer');
const scoring = require('./scoring');

const { minForm, nextDowngrade, targetForm, formCap, fuseScore } = scoring;

// 附录 G 三档运行时预算（总窗口 token 数）。
const WINDOW_DEFINITIONS = Object.freeze({
  window_8k: Object.freeze({ total_tokens: 8192, ratios: TOKEN_BUDGET.WINDOW_8K }),
  window_32k: Object.freeze({ total_tokens: 32768, ratios: TOKEN_BUDGET.WINDOW_32K }),
  window_128k: Object.freeze({ total_tokens: 131072, ratios: TOKEN_BUDGET.WINDOW_128K }),
});

// §19 sensitivity 枚举顺序（S0 < S1 < S2 < S3）。
const SENSITIVITY_RANK = Object.freeze(
  Object.keys(SENSITIVITY).reduce((acc, key, index) => {
    acc[SENSITIVITY[key]] = index;
    return acc;
  }, {})
);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function memIdOf(item) {
  return item && item.mem_id !== null && item.mem_id !== undefined ? String(item.mem_id) : '';
}

function formRankOf(form) {
  const index = TOKEN_BUDGET.DOWNGRADE_ORDER.indexOf(form);
  return index === -1 ? TOKEN_BUDGET.DOWNGRADE_ORDER.length : index;
}

/**
 * 附录 G 预算分配。
 * @param {string|number|{window?:string,total_tokens?:number,ratios?:object}} [window]
 * @param {{preset?:string, ratios?:object, overrides?:object}} [opts]
 * @returns {{window:string|null, total_tokens:number|null, system_persona_static:number,
 *            current_dialogue:number, recalled_memory:number, tools_task:number,
 *            output_buffer:number}}
 */
function allocateBudget(window = TOKEN_BUDGET.DEFAULT_WINDOW, opts = {}) {
  const source = window && typeof window === 'object' ? window : {};
  const rawWindow = window && typeof window === 'object'
    ? (source.window ?? source.preset ?? TOKEN_BUDGET.DEFAULT_WINDOW)
    : window;

  const presetName = typeof rawWindow === 'string'
    ? rawWindow
    : (opts.preset || TOKEN_BUDGET.DEFAULT_WINDOW);
  const preset = WINDOW_DEFINITIONS[presetName];
  if (!preset) {
    throw new RangeError(`未知预算档位: ${presetName}（合法: ${Object.keys(WINDOW_DEFINITIONS).join('|')}）`);
  }

  const totalTokens = isFiniteNumber(rawWindow)
    ? Math.max(0, Math.floor(rawWindow))
    : (isFiniteNumber(source.total_tokens) ? Math.max(0, Math.floor(source.total_tokens)) : preset.total_tokens);

  const ratios = { ...preset.ratios, ...(source.ratios || {}), ...(opts.ratios || {}) };
  const overrides = { ...(source.overrides || {}), ...(opts.overrides || {}) };

  const keys = [
    'system_persona_static',
    'current_dialogue',
    'recalled_memory',
    'tools_task',
    'output_buffer',
  ];
  const result = {
    window: typeof rawWindow === 'string' ? rawWindow : (opts.preset || null),
    total_tokens: totalTokens,
  };
  for (const key of keys) {
    result[key] = isFiniteNumber(overrides[key])
      ? Math.max(0, Math.floor(overrides[key]))
      : Math.max(0, Math.floor(totalTokens * (isFiniteNumber(ratios[key]) ? ratios[key] : 0)));
  }
  return result;
}

/**
 * 归一化 budget 入参（§5.4 budget.recalled_memory）。
 * 支持：number（直接视为 recalled_memory）、{recalled_memory}、{window|window_tokens|total_tokens}。
 * @param {number|object|undefined} budget
 * @param {object} [opts]
 * @returns {object}
 */
function normalizeBudget(budget, opts = {}) {
  if (isFiniteNumber(budget)) {
    return {
      window: null,
      total_tokens: null,
      system_persona_static: 0,
      current_dialogue: 0,
      recalled_memory: Math.max(0, Math.floor(budget)),
      tools_task: 0,
      output_buffer: 0,
    };
  }

  const source = budget && typeof budget === 'object' ? budget : {};
  const windowArg = source.window ?? source.window_tokens ?? source.total_tokens ?? opts.window;
  const base = windowArg !== undefined
    ? allocateBudget(windowArg, { ...opts, ...source })
    : allocateBudget(TOKEN_BUDGET.DEFAULT_WINDOW, opts);

  if (isFiniteNumber(source.recalled_memory)) {
    base.recalled_memory = Math.max(0, Math.floor(source.recalled_memory));
  }
  return base;
}

/**
 * §5.2 injectable：lifecycle_state 必须为 active/cold_archived；deleted_* 与 superseded 不可注入；
 * sensitivity <= caller_sensitivity_max；scope 谓词与权限由调用方通过 context 回调给出。
 * （§5.2 明确此处不调用 evidence_completeness_ok。）
 * @param {object} item
 * @param {{caller_sensitivity_max?:string|number, canRead?:Function,
 *          scope_allowed?:Function, can_read_scope?:Function}} [context]
 * @returns {boolean}
 */
function injectable(item, context = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;

  const lifecycle = item.lifecycle_state ?? (item.lifecycle && item.lifecycle.state);
  if (lifecycle === LIFECYCLE_STATE.DELETED_PENDING ||
      lifecycle === LIFECYCLE_STATE.DELETED_TOMBSTONE ||
      lifecycle === LIFECYCLE_STATE.SUPERSEDED) {
    return false;
  }
  if (lifecycle !== LIFECYCLE_STATE.ACTIVE && lifecycle !== LIFECYCLE_STATE.COLD_ARCHIVED) {
    return false;
  }

  const deletionState = item.deletion_state ?? (item.evidence && item.evidence.deletion_state);
  if (deletionState === 'tombstone' || deletionState === 'content_deleted_audit_retained') {
    return false;
  }

  const sensitivity = item.sensitivity
    ?? (item.governance && item.governance.sensitivity)
    ?? SENSITIVITY.S0;
  const maxSensitivity = context.caller_sensitivity_max;
  if (maxSensitivity !== undefined && maxSensitivity !== null) {
    const itemRank = SENSITIVITY_RANK[String(sensitivity).toUpperCase()];
    const maxRank = isFiniteNumber(maxSensitivity)
      ? maxSensitivity
      : SENSITIVITY_RANK[String(maxSensitivity).toUpperCase()];
    if (itemRank !== undefined && maxRank !== undefined && itemRank > maxRank) return false;
  }

  // §3.5 scope 谓词 / §3.4 share_grant：纯算法层不查库，由调用方注入判定。
  if (typeof context.scope_allowed === 'function' && !context.scope_allowed(item)) return false;
  if (typeof context.can_read_scope === 'function' && !context.can_read_scope(item)) return false;
  if (typeof context.canRead === 'function' && !context.canRead(item)) return false;

  return true;
}

function hasStructured(item) {
  const structured = item.structured ?? (item.content && item.content.structured);
  return !!structured && typeof structured === 'object' && !Array.isArray(structured);
}

function hasTags(item) {
  const tags = item.tags ?? (item.content && item.content.tags);
  return Array.isArray(tags) && tags.length > 0;
}

function longTextOf(item) {
  const text = item.summary_long ?? (item.content && item.content.summary_long);
  return typeof text === 'string' ? text : '';
}

function shortTextOf(item) {
  const text = item.summary_short ?? (item.content && item.content.summary_short);
  return typeof text === 'string' ? text : '';
}

// 条目实际可渲染到哪些形态。
function formRenderable(item, form) {
  switch (form) {
    case 'summary_long':
      return longTextOf(item).length > 0;
    case 'summary_short':
      return shortTextOf(item).length > 0;
    case 'structured':
      return hasStructured(item);
    case 'tags':
      return hasTags(item);
    case 'pointer':
      return true;
    default:
      return false;
  }
}

// 条目实际可渲染到的最高形态（契约未显式要求，但可避免渲染不存在的 summary_long）。
function bestRenderableForm(item) {
  if (longTextOf(item).length > 0) return 'summary_long';
  if (shortTextOf(item).length > 0) return 'summary_short';
  if (hasStructured(item)) return 'structured';
  if (hasTags(item)) return 'tags';
  return 'pointer';
}

/**
 * §5.2/§5.3 target_form = min_form(分档目标, form_cap, 可渲染上限)。
 * 若 form_cap 指定的形态缺少对应内容（例如 degraded 但无 tags），继续沿梯度下降，
 * 直到有内容可渲染或到达 pointer，避免输出空的 structured/tags。
 * @param {object} item
 * @param {number} [finalScore]
 * @returns {string}
 */
function resolveTargetForm(item, finalScore) {
  const score = isFiniteNumber(finalScore)
    ? finalScore
    : (isFiniteNumber(item.final_score) ? item.final_score : 0);
  const tier = targetForm(score, { has_structured: hasStructured(item) });
  let form = minForm(minForm(tier, formCap(item)), bestRenderableForm(item));
  while (form !== 'pointer' && form !== 'drop' && !formRenderable(item, form)) {
    form = nextDowngrade(form);
  }
  return form;
}

function evidenceRefOf(item) {
  if (typeof item.evidence_ref === 'string' && item.evidence_ref) return item.evidence_ref;
  const refs = item.evidence_refs ?? (item.evidence && item.evidence.evidence_refs);
  if (Array.isArray(refs) && typeof refs[0] === 'string' && refs[0]) return refs[0];
  const span = item.source_span ?? (item.evidence && item.evidence.source_span);
  if (typeof span === 'string' && span) return span;
  return null;
}

function evidenceRefsOf(item) {
  const refs = item.evidence_refs ?? (item.evidence && item.evidence.evidence_refs);
  if (Array.isArray(refs)) return refs.filter((ref) => typeof ref === 'string' && ref);
  const single = evidenceRefOf(item);
  return single ? [single] : [];
}

/**
 * §5.5 可下钻：span 存在 + 未 tombstone + 调用者有读权限。
 * 纯算法层用 context 回调/集合表达后两项。
 * @param {object} item
 * @param {{tombstoned_evidence?:string[]|Set<string>, deleted_evidence?:string[]|Set<string>,
 *          canReadEvidence?:Function}} [context]
 * @returns {boolean}
 */
function isEvidenceDrillable(item, context = {}) {
  if (!item || typeof item !== 'object') return false;
  const ref = evidenceRefOf(item);
  if (!ref) return false;

  const blocked = context.tombstoned_evidence ?? context.deleted_evidence;
  if (Array.isArray(blocked) && blocked.includes(ref)) return false;
  if (blocked instanceof Set && blocked.has(ref)) return false;
  if (context.evidence_drillable && typeof context.evidence_drillable === 'object') {
    const flag = context.evidence_drillable[ref];
    if (flag === false) return false;
  }

  if (typeof context.canReadEvidence === 'function') {
    try {
      if (!context.canReadEvidence(ref)) return false;
    } catch (error) {
      return false;
    }
  }
  return true;
}

function parseWhyCode(code) {
  const codes = {};
  if (typeof code !== 'string' || code.trim() === '') return null;
  for (const part of code.split('|')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (!key || rawValue === '') continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) codes[key] = value;
  }
  return Object.keys(codes).length > 0 ? codes : null;
}

/**
 * 归一化 why_recalled（对象或 §17.9 的 "S:0.82|A:0.60|T:0.30" 编码）。
 * @param {object} item
 * @param {boolean} [include=true]
 * @returns {{codes:object|null, reason:string|null}}
 */
function whyRecalledOf(item, include = true) {
  if (!include || !item || typeof item !== 'object') return { codes: null, reason: null };

  const raw = item.why_recalled;
  let codes = null;
  let reason = null;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const collected = {};
    for (const key of Object.keys(raw)) {
      if (key === 'reason') {
        if (typeof raw[key] === 'string' && raw[key].trim()) reason = raw[key];
        continue;
      }
      const value = Number(raw[key]);
      if (Number.isFinite(value)) collected[key] = value;
    }
    if (Object.keys(collected).length > 0) codes = collected;
  } else if (typeof raw === 'string') {
    codes = parseWhyCode(raw);
  }

  if (!codes && typeof item.why_recalled_code === 'string') {
    codes = parseWhyCode(item.why_recalled_code);
  }
  if (!reason && typeof item.why_recalled_reason === 'string' && item.why_recalled_reason.trim()) {
    reason = item.why_recalled_reason;
  }
  return { codes, reason };
}

function hasNonZeroWhy(codes) {
  if (!codes) return false;
  for (const key of Object.keys(codes)) {
    if (Number.isFinite(codes[key]) && codes[key] > 0) return true;
  }
  return false;
}

/**
 * §5.5 evidence_completeness_ok(item, form)。
 * pointer：include_why_recalled=true 时要求 why 非空 且 evidence 可下钻；false 时仅要求 evidence 可下钻。
 * 其他形态：evidence 可下钻 或 why 非空。
 * @param {object} item
 * @param {string} form
 * @param {{include_why_recalled?:boolean, tombstoned_evidence?:string[]|Set<string>,
 *          deleted_evidence?:string[]|Set<string>, canReadEvidence?:Function}} [opts]
 * @returns {boolean}
 */
function evidenceCompletenessOk(item, form, opts = {}) {
  if (!item || typeof item !== 'object') return false;
  const includeWhy = opts.include_why_recalled !== false;
  const drillable = isEvidenceDrillable(item, opts);
  const why = whyRecalledOf(item, includeWhy);
  const whyOk = hasNonZeroWhy(why.codes) || !!(why.reason && why.reason.trim());

  if (form === 'pointer') {
    return includeWhy ? (whyOk && drillable) : drillable;
  }
  return drillable || whyOk;
}

function sanitizeSegment(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/\|/g, '/')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatScore(value) {
  return (isFiniteNumber(value) ? value : 0).toFixed(2);
}

/**
 * 指针行格式严格照 §6 示例：
 *   [mem_1024 | 偏好:猫 | 置信0.90 | S:0.82|A:0.60|T:0.30]
 * why 为空时：有显式 reason 用 why:<reason>，否则用 E:<evidence_ref>（§5.5 允许 evidence 下钻替代）。
 * @param {object} item
 * @param {{include_why_recalled?:boolean, label?:string}} [opts]
 * @returns {string}
 */
function buildPointerLine(item, opts = {}) {
  const memId = sanitizeSegment(item.mem_id === null || item.mem_id === undefined ? '' : item.mem_id);
  const shortText = shortTextOf(item);
  const label = opts.label
    ?? item.pointer_label
    ?? `${item.type ?? 'memory'}:${shortText || longTextOf(item) || ''}`;
  const confidence = clamp(
    Number(
      item.confidence !== undefined
        ? item.confidence
        : (item.quality && item.quality.confidence)
    ),
    0,
    1
  );

  const includeWhy = opts.include_why_recalled !== false;
  const why = whyRecalledOf(item, includeWhy);
  const codes = why.codes || {};
  const segments = [];

  // 契约正文只出现 S/A/T/V 四个前缀（constants.WHY_CODE），固定顺序保证可复现。
  for (const key of Object.keys(WHY_CODE)) {
    if (Number.isFinite(codes[key]) && codes[key] > 0) {
      segments.push(`${key}:${formatScore(codes[key])}`);
    }
  }
  for (const key of Object.keys(codes).sort()) {
    if (Object.prototype.hasOwnProperty.call(WHY_CODE, key)) continue;
    if (Number.isFinite(codes[key]) && codes[key] > 0) {
      segments.push(`${sanitizeSegment(key)}:${formatScore(codes[key])}`);
    }
  }

  let whySegment;
  if (segments.length > 0) {
    whySegment = segments.join('|');
  } else if (why.reason) {
    whySegment = `why:${sanitizeSegment(why.reason)}`;
  } else {
    const ref = evidenceRefOf(item);
    whySegment = ref ? `E:${sanitizeSegment(ref)}` : 'why:unspecified';
  }

  return `[${memId} | ${sanitizeSegment(label)} | 置信${formatScore(confidence)} | ${whySegment}]`;
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * 渲染 5 种形态（§5.3 / §6）。
 * @param {object} item
 * @param {'summary_long'|'summary_short'|'structured'|'tags'|'pointer'} form
 * @param {{include_why_recalled?:boolean, label?:string, context?:object}} [opts]
 * @returns {object|null} drop 返回 null
 */
function renderForm(item, form, opts = {}) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('renderForm: item 必须是对象');
  }
  if (form === 'drop') return null;
  if (!TOKEN_BUDGET.RENDER_FORMS.includes(form)) {
    throw new RangeError(`renderForm: 未知形态 ${form}`);
  }

  const includeWhy = opts.include_why_recalled !== false;
  const why = whyRecalledOf(item, includeWhy);
  const context = opts.context || {};
  const rendered = {
    mem_id: memIdOf(item),
    injected_form: form,
    pointer_line: null,
    content: null,
    structured: null,
    tags: null,
    evidence_ref: evidenceRefOf(item),
    evidence_refs: evidenceRefsOf(item),
    why_recalled: includeWhy ? why.codes : null,
    why_recalled_reason: includeWhy ? why.reason : null,
    final_score: isFiniteNumber(item.final_score) ? item.final_score : 0,
    evidence_drillable: isEvidenceDrillable(item, context),
    tokens: 0,
  };

  let payload = '';
  switch (form) {
    case 'summary_long': {
      rendered.content = longTextOf(item) || shortTextOf(item);
      payload = rendered.content;
      break;
    }
    case 'summary_short': {
      rendered.content = shortTextOf(item);
      payload = rendered.content;
      break;
    }
    case 'structured': {
      const structured = item.structured ?? (item.content && item.content.structured) ?? null;
      rendered.structured = structured;
      payload = stableStringify(structured);
      break;
    }
    case 'tags': {
      const tags = item.tags ?? (item.content && item.content.tags);
      rendered.tags = Array.isArray(tags) ? tags.map(String) : null;
      payload = rendered.tags ? rendered.tags.join(', ') : '';
      break;
    }
    case 'pointer': {
      rendered.pointer_line = buildPointerLine(item, {
        include_why_recalled: includeWhy,
        label: opts.label,
      });
      payload = rendered.pointer_line;
      break;
    }
    default:
      break;
  }

  rendered.tokens = estimateTokens(payload);
  return rendered;
}

function normalizeMustInject(mustInject) {
  const ids = new Set();
  if (!Array.isArray(mustInject)) return ids;
  for (const entry of mustInject) {
    if (typeof entry === 'string') ids.add(entry);
    else if (entry && typeof entry === 'object' && entry.mem_id !== null && entry.mem_id !== undefined) {
      ids.add(String(entry.mem_id));
    }
  }
  return ids;
}

function dedupeKeepBest(selected) {
  const order = [];
  const byMemId = new Map();
  for (const entry of selected) {
    const existing = byMemId.get(entry.mem_id);
    if (!existing) {
      byMemId.set(entry.mem_id, entry);
      order.push(entry.mem_id);
      continue;
    }
    // keep_best：final_score 更高者胜；同分保留更完整（更靠前）的形态。
    if (
      entry.final_score > existing.final_score ||
      (entry.final_score === existing.final_score &&
        formRankOf(entry.injected_form) < formRankOf(existing.injected_form))
    ) {
      byMemId.set(entry.mem_id, entry);
    }
  }
  return order.map((memId) => byMemId.get(memId));
}

function recomputeUsed(selected) {
  let used = 0;
  for (const entry of selected) used += entry.tokens;
  return used;
}

/**
 * fill_by_target_form（§5.4）：按压缩梯度逐级尝试，绝不硬截断；空间不够就降级。
 * @returns {{selected:Array, used:number, dropped:Array, downgraded:boolean}}
 */
function fillByTargetForm(items, limit, usedStart, opts) {
  const selected = [];
  const dropped = [];
  let used = usedStart;
  let downgraded = false;

  for (const item of items) {
    const target = item.target_form;
    const memId = memIdOf(item);

    if (target === 'drop') {
      dropped.push({
        mem_id: memId,
        reason: 'below_threshold',
        target_form: target,
        final_score: item.final_score,
      });
      continue;
    }

    let form = target;
    let chosen = null;
    let failureReason = 'budget_exhausted';

    while (form !== 'drop') {
      const rendered = renderForm(item, form, opts.render);
      const cost = rendered ? rendered.tokens : 0;
      const complete = evidenceCompletenessOk(item, form, {
        ...opts.context,
        include_why_recalled: opts.include_why_recalled,
      });

      if (used + cost <= limit && complete) {
        chosen = rendered;
        used += cost;
        break;
      }

      failureReason = used + cost > limit ? 'budget_exhausted' : 'evidence_incomplete';
      form = nextDowngrade(form);
    }

    if (chosen) {
      chosen.target_form = target;
      chosen.form_downgraded = chosen.injected_form !== target;
      if (chosen.form_downgraded) downgraded = true;
      selected.push(chosen);
    } else {
      dropped.push({
        mem_id: memId,
        reason: failureReason,
        target_form: target,
        final_score: item.final_score,
      });
    }
  }

  return { selected, used, dropped, downgraded };
}

/**
 * §5.5 / §12 evidence_completeness_rate = 可回溯条目数 / 注入条目数。
 * 可回溯口径采用「evidence 可下钻」；空集返回 0（不参与断言）。
 * @param {Array<object>} selected
 * @param {Map<string,object>} [itemById]
 * @param {object} [context]
 * @returns {number}
 */
function computeEvidenceCompletenessRate(selected, itemById, context = {}) {
  if (!Array.isArray(selected) || selected.length === 0) return 0;
  let drillable = 0;
  for (const entry of selected) {
    const item = itemById ? itemById.get(entry.mem_id) : entry;
    if (isEvidenceDrillable(item, context)) drillable += 1;
  }
  return drillable / selected.length;
}

function computePointerRatio(selected) {
  if (!Array.isArray(selected) || selected.length === 0) return 0;
  const pointers = selected.filter((entry) => entry.injected_form === 'pointer').length;
  return pointers / selected.length;
}

/**
 * §5.4 assemble_context_v41。
 *
 * 入参既可以是对象，也可以沿用 (candidates, budget, opts) 位置参数：
 *   assembleContext({ candidates, budget, must_inject, now, include_why_recalled, context, scenario })
 *
 * @returns {{selected:Array<object>, dropped:Array<object>, pointers:Array<object>,
 *            used_tokens:number, evidence_completeness:number, degraded:boolean,
 *            pointer_ratio:number, warnings:Array<object>, degraded_reasons:string[],
 *            budget:object}}
 */
function assembleContext(input, budgetArg, optsArg) {
  const args = Array.isArray(input)
    ? { ...(optsArg || {}), candidates: input, budget: budgetArg }
    : (input && typeof input === 'object' ? input : {});

  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  const context = args.context ?? args.ctx ?? {};
  const includeWhy = args.include_why_recalled !== false;
  const now = args.now;
  const scenario = args.scenario ?? 'default';
  const budget = normalizeBudget(args.budget ?? args.token_budget, args);
  const limit = Math.max(0, Math.floor(budget.recalled_memory));
  const mustInject = normalizeMustInject(args.must_inject);
  const warnings = [];
  const degradedReasons = [];

  const emptyResult = () => ({
    selected: [],
    dropped: [],
    pointers: [],
    used_tokens: 0,
    evidence_completeness: 0,
    degraded: true,
    pointer_ratio: 0,
    warnings,
    degraded_reasons: degradedReasons,
    budget,
  });

  // 空集：跳过断言，标记 degraded，不 throw（§5.4 空 selected 跳过断言）。
  if (candidates.length === 0) {
    warnings.push({ code: 'empty_selection', message: '候选集为空，跳过 pointer/完整性断言' });
    degradedReasons.push('empty_selection');
    return emptyResult();
  }

  const dropped = [];
  const eligible = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      dropped.push({
        mem_id: '',
        reason: 'invalid_candidate',
        target_form: 'drop',
        final_score: 0,
      });
      continue;
    }

    const item = { ...candidate };
    const memId = memIdOf(item);

    if (!injectable(item, context)) {
      if (mustInject.has(memId)) {
        warnings.push({ code: 'must_inject_rejected', mem_id: memId });
      }
      dropped.push({
        mem_id: memId,
        reason: 'not_injectable',
        target_form: 'drop',
        final_score: isFiniteNumber(item.final_score) ? item.final_score : 0,
      });
      continue;
    }

    let finalScore;
    if (isFiniteNumber(item.final_score)) {
      finalScore = clamp(item.final_score, 0, 1);
    } else {
      finalScore = fuseScore(item, scenario, {
        now,
        recency_window_days: args.recency_window_days,
      }).final_score;
    }
    item.final_score = finalScore;

    let target = resolveTargetForm(item, finalScore);
    // 必须注入项至少保留 pointer（但不突破 form_cap；superseded/deleted 已在上面拦截）。
    if (mustInject.has(memId) && target === 'drop') {
      target = minForm('pointer', formCap(item));
    }
    item.target_form = target;
    eligible.push(item);
  }

  // §5.4 sort_by(final_score desc, mem_id asc)；必须注入项前置，保证预算优先。
  const wrappers = eligible.map((item, index) => ({
    item,
    index,
    must: mustInject.has(memIdOf(item)),
  }));
  wrappers.sort((a, b) => {
    if (a.must !== b.must) return a.must ? -1 : 1;
    if (b.item.final_score !== a.item.final_score) {
      return b.item.final_score - a.item.final_score;
    }
    const aId = memIdOf(a.item);
    const bId = memIdOf(b.item);
    if (aId !== bId) return aId < bId ? -1 : 1;
    return a.index - b.index;
  });
  const orderedItems = wrappers.map((wrapper) => wrapper.item);

  // mem_id -> item（排序后首个为准，保持确定性）。
  const itemById = new Map();
  for (const item of orderedItems) {
    const memId = memIdOf(item);
    if (!itemById.has(memId)) itemById.set(memId, item);
  }

  const renderOpts = {
    render: { include_why_recalled: includeWhy, context },
    context,
    include_why_recalled: includeWhy,
  };

  // 第一轮：按 target_form 填充。
  const first = fillByTargetForm(orderedItems, limit, 0, renderOpts);
  let selected = first.selected;
  let used = first.used;
  dropped.push(...first.dropped);
  if (first.downgraded) degradedReasons.push('form_downgraded');

  selected = dedupeKeepBest(selected);
  used = recomputeUsed(selected);

  // pointer guardrail（§5.4）：不足时把低分非指针条目降为 pointer，只 warn 不 assert。
  if (selected.length > 0) {
    const minRatio = TOKEN_BUDGET.GUARDRAILS.min_pointer_keep_ratio;
    const required = Math.ceil(selected.length * minRatio);
    let pointerCount = selected.filter((entry) => entry.injected_form === 'pointer').length;

    if (pointerCount < required) {
      const downgradeQueue = selected
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.injected_form !== 'pointer')
        .sort((a, b) => {
          if (a.entry.final_score !== b.entry.final_score) {
            return a.entry.final_score - b.entry.final_score;
          }
          if (a.entry.mem_id !== b.entry.mem_id) {
            return a.entry.mem_id < b.entry.mem_id ? -1 : 1;
          }
          return a.index - b.index;
        });

      for (const { entry, index } of downgradeQueue) {
        if (pointerCount >= required) break;
        const item = itemById.get(entry.mem_id);
        if (!item) continue;

        const pointer = renderForm(item, 'pointer', renderOpts.render);
        const complete = evidenceCompletenessOk(item, 'pointer', {
          ...context,
          include_why_recalled: includeWhy,
        });
        if (!pointer || !complete) continue;

        const saved = entry.tokens - pointer.tokens;
        if (saved > 0) {
          pointer.target_form = entry.target_form;
          pointer.form_downgraded = true;
          selected[index] = pointer;
          used -= saved;
          pointerCount += 1;
          degradedReasons.push('pointer_ratio_forced_downgrade');
          // 保留一次降级事件即可，去重后输出。
        }
      }
    }

    if (pointerCount < required) {
      warnings.push({
        code: 'pointer_ratio_unmet',
        pointer_count: pointerCount,
        required,
        total: selected.length,
      });
      degradedReasons.push('pointer_ratio_unmet');
    }
  }

  // 预算再利用：最多 1 轮（§5.4 / §5.1）。
  if (used < limit) {
    const selectedIds = new Set(selected.map((entry) => entry.mem_id));
    const unselected = orderedItems.filter((item) => {
      const memId = memIdOf(item);
      return !selectedIds.has(memId) && item.target_form !== 'drop';
    });

    if (unselected.length > 0) {
      const second = fillByTargetForm(unselected, limit, used, renderOpts);
      if (second.selected.length > 0) {
        selected = dedupeKeepBest(selected.concat(second.selected));
        used = recomputeUsed(selected);
        if (second.downgraded) degradedReasons.push('form_downgraded');
      }
    }
  }

  // 末尾完整性兜底（§5.4）：不通过者移出选中集并标记降级，不 throw（纯函数返回数据）。
  const verified = [];
  for (const entry of selected) {
    const item = itemById.get(entry.mem_id);
    if (item && evidenceCompletenessOk(item, entry.injected_form, {
      ...context,
      include_why_recalled: includeWhy,
    })) {
      verified.push(entry);
    } else {
      dropped.push({
        mem_id: entry.mem_id,
        reason: 'evidence_incomplete',
        target_form: entry.target_form ?? entry.injected_form,
        final_score: entry.final_score,
      });
      degradedReasons.push('evidence_completeness_failed');
    }
  }
  selected = verified;
  used = recomputeUsed(selected);

  // 硬约束 used <= budget 的确定性兜底：只可能因极端浮点/自定义渲染触发。
  while (used > limit && selected.length > 0) {
    let worstIndex = 0;
    for (let i = 1; i < selected.length; i += 1) {
      const current = selected[i];
      const worst = selected[worstIndex];
      if (
        current.final_score < worst.final_score ||
        (current.final_score === worst.final_score && current.mem_id < worst.mem_id)
      ) {
        worstIndex = i;
      }
    }
    const [removed] = selected.splice(worstIndex, 1);
    used -= removed.tokens;
    dropped.push({
      mem_id: removed.mem_id,
      reason: 'budget_exhausted',
      target_form: removed.target_form ?? removed.injected_form,
      final_score: removed.final_score,
    });
    degradedReasons.push('budget_overflow_guard');
  }

  // dropped 去重（同一 mem_id 只保留首次原因），并排除最终已选中者。
  const selectedIds = new Set(selected.map((entry) => entry.mem_id));
  const seenDropped = new Set();
  const finalDropped = [];
  for (const entry of dropped) {
    if (selectedIds.has(entry.mem_id)) continue;
    const key = `${entry.mem_id}\u0000${entry.reason}`;
    if (seenDropped.has(key)) continue;
    seenDropped.add(key);
    finalDropped.push(entry);
  }

  const pointers = selected.filter((entry) => entry.injected_form === 'pointer');
  const evidenceCompleteness = computeEvidenceCompletenessRate(selected, itemById, context);
  const pointerRatio = computePointerRatio(selected);
  const degraded = degradedReasons.length > 0 || selected.length === 0;
  if (selected.length === 0) degradedReasons.push('empty_selection');

  return {
    selected,
    dropped: finalDropped,
    pointers,
    used_tokens: used,
    evidence_completeness: evidenceCompleteness,
    degraded,
    pointer_ratio: pointerRatio,
    warnings,
    degraded_reasons: [...new Set(degradedReasons)],
    budget,
  };
}

module.exports = {
  allocateBudget,
  normalizeBudget,
  minForm,
  injectable,
  resolveTargetForm,
  evidenceRefOf,
  evidenceRefsOf,
  isEvidenceDrillable,
  evidenceCompletenessOk,
  buildPointerLine,
  renderForm,
  computePointerRatio,
  computeEvidenceCompletenessRate,
  assembleContext,
};
