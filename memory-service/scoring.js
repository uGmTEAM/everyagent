'use strict';

/**
 * 评分、融合、时效衰减、分档与 MMR（§4）。
 *
 * 纯函数模块：不读时钟、不读数据库、不使用随机数。
 * 所有时间相关计算都要求调用方显式传入 now（ISO 字符串 / Date / 毫秒时间戳），
 * 以保证「同输入、同版本、同预算必须同输出」（§5.1）。
 */

const {
  WEIGHTS,
  ROUTE_BONUS,
  RECALL_ROUTE,
  TIER_THRESHOLDS,
  TOKEN_BUDGET,
  MMR,
  QUALITY_FLAG,
  LIFECYCLE_STATE,
} = require('./constants');

const { cosine } = require('./embedding');

// 场景权重档位名（§4.2）与 constants.WEIGHTS 的映射。
const SCENARIO_KEYS = Object.freeze({
  default: 'DEFAULT',
  customer_service: 'CUSTOMER_SERVICE',
  companion: 'COMPANION',
  assistant: 'ASSISTANT',
});

const DOWNGRADE_ORDER = TOKEN_BUDGET.DOWNGRADE_ORDER;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// 读取点路径（兼容 MemoryItem 嵌套结构与 RecallCandidate 扁平结构）。
function readPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cursor = obj;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstFinite(obj, paths) {
  for (const path of paths) {
    const value = readPath(obj, path);
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

/**
 * 解析场景权重（§4.2）。
 * @param {string|{w_sim:number,w_imp:number,w_rec:number,w_decay:number,
 *                 w_aff:number,w_rel:number,w_relia:number,w_bonus:number}} [scenario='default']
 * @returns {Readonly<object>}
 */
function resolveWeights(scenario = 'default') {
  if (scenario && typeof scenario === 'object') {
    return Object.freeze({
      w_sim: scenario.w_sim,
      w_imp: scenario.w_imp,
      w_rec: scenario.w_rec,
      w_decay: scenario.w_decay,
      w_aff: scenario.w_aff,
      w_rel: scenario.w_rel,
      w_relia: scenario.w_relia,
      w_bonus: scenario.w_bonus,
    });
  }
  const key = SCENARIO_KEYS[String(scenario).toLowerCase()];
  if (!key) {
    throw new RangeError(`未知场景权重: ${scenario}（合法: default|customer_service|companion|assistant）`);
  }
  return WEIGHTS[key];
}

function normalizeRoutes(routes) {
  if (routes === null || routes === undefined || routes === '') return [];
  const list = Array.isArray(routes) ? routes : [routes];
  const valid = new Set(Object.values(RECALL_ROUTE));
  const unique = [];
  for (const route of list) {
    if (route === null || route === undefined || route === '') continue;
    const name = String(route);
    if (!valid.has(name)) {
      throw new RangeError(`未知召回路径 route: ${name}（见 §17.9 / §19）`);
    }
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

/**
 * route_bonus 唯一口径（§4.1）。
 * 单路：raw = min(0.0200, 该路原始值)；多路：raw = min(0.0300, sum(命中原始值))；
 * route_bonus_norm = raw / 0.0300，只在融合中加一次。
 * @param {string|string[]} routes
 * @returns {{routes:string[], mode:'none'|'single'|'multi', raw_bonus:number, route_bonus_norm:number}}
 */
function computeRouteBonus(routes) {
  const list = normalizeRoutes(routes);
  if (list.length === 0) {
    return { routes: [], mode: 'none', raw_bonus: 0, route_bonus_norm: 0 };
  }

  const values = list.map((route) => {
    const key = route.toUpperCase();
    const value = ROUTE_BONUS[key];
    return isFiniteNumber(value) ? value : 0;
  });

  let rawBonus;
  if (list.length === 1) {
    rawBonus = Math.min(ROUTE_BONUS.SINGLE_ROUTE_CAP, values[0]);
  } else {
    const sum = values.reduce((acc, value) => acc + value, 0);
    rawBonus = Math.min(ROUTE_BONUS.MULTI_ROUTE_CAP, sum);
  }

  return {
    routes: list,
    mode: list.length === 1 ? 'single' : 'multi',
    raw_bonus: rawBonus,
    route_bonus_norm: rawBonus / ROUTE_BONUS.NORMALIZER,
  };
}

function resolveRouteBonus(input) {
  if (!input || typeof input !== 'object') return { ...computeRouteBonus([]), source: 'none' };

  if (isFiniteNumber(input.route_bonus_norm)) {
    const norm = clamp(input.route_bonus_norm, 0, 1);
    return {
      routes: normalizeRoutes(input.routes || input.route),
      mode: 'explicit',
      raw_bonus: norm * ROUTE_BONUS.NORMALIZER,
      route_bonus_norm: norm,
      source: 'route_bonus_norm',
    };
  }
  if (isFiniteNumber(input.route_bonus_raw)) {
    const raw = clamp(input.route_bonus_raw, 0, ROUTE_BONUS.MULTI_ROUTE_CAP);
    return {
      routes: normalizeRoutes(input.routes || input.route),
      mode: 'explicit',
      raw_bonus: raw,
      route_bonus_norm: raw / ROUTE_BONUS.NORMALIZER,
      source: 'route_bonus_raw',
    };
  }
  const bonus = computeRouteBonus(input.routes || input.route);
  return { ...bonus, source: bonus.routes.length ? 'routes' : 'none' };
}

/**
 * 由时间戳计算 recency（§4.2「recency 按 valid_from 计算」）。
 * 契约未给公式，采用默认并可配置：与 §4.3 的 age 口径一致的 365 天线性窗口，
 * recency = clamp(1 - age_days / 365, 0, 1)。
 * @param {string|number|Date} validFrom
 * @param {string|number|Date} now
 * @param {number} [windowDays=365]
 * @returns {number|null} 时间不可解析时返回 null
 */
function computeRecencyFromTimestamp(validFrom, now, windowDays = 365) {
  const fromMs = toTimestamp(validFrom);
  const nowMs = toTimestamp(now);
  if (fromMs === null || nowMs === null) return null;
  const ageDays = Math.max(0, (nowMs - fromMs) / 86400000);
  return clamp(1 - ageDays / windowDays, 0, 1);
}

function toTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * 解析候选六维输入并套用 §4.2 缺失值规则。
 * 注意：契约 §4.2 公式的六个加权项是 similarity / importance / recency / decay_score /
 * affect_consistency / relationship_weight / source_reliability（加 route_bonus），
 * 不含 confidence / evidence_strength；这两项不参与加权，避免自创权重。
 * @param {object} input
 * @param {object} [opts]
 * @param {string[]} [fallbacksOut]
 * @returns {{similarity:number, importance:number, recency:number, decay_score:number,
 *            affect_consistency:number, relationship_weight:number, source_reliability:number}}
 */
function resolveScoreDimensions(input = {}, opts = {}, fallbacksOut = []) {
  const source = input && typeof input === 'object' ? input : {};

  const similarity = firstFinite(source, ['similarity', 'route_score']);
  const importance = firstFinite(source, ['importance', 'quality.importance']);
  const explicitRecency = firstFinite(source, ['recency', 'quality.recency']);
  const decayValue = firstFinite(source, ['decay_score', 'quality.decay_score']);
  const affect = firstFinite(source, ['affect_consistency']);
  const relationship = firstFinite(source, ['relationship_weight']);
  const reliability = firstFinite(source, ['source_reliability', 'quality.source_reliability']);

  let recency;
  if (explicitRecency !== undefined) {
    recency = clamp(explicitRecency, 0, 1);
  } else {
    const computed = computeRecencyFromTimestamp(
      readPath(source, 'temporal.valid_from') ?? source.valid_from,
      opts.now,
      isFiniteNumber(opts.recency_window_days) ? opts.recency_window_days : 365
    );
    if (computed === null) {
      fallbacksOut.push('recency=0（缺少 valid_from / now，契约未给数值，采用默认）');
      recency = 0;
    } else {
      fallbacksOut.push('recency=按 valid_from 计算（§4.2）');
      recency = computed;
    }
  }

  if (similarity === undefined) fallbacksOut.push('similarity=0（§4.2）');
  if (importance === undefined) fallbacksOut.push('importance=0.5（§4.2）');
  if (decayValue === undefined) fallbacksOut.push('decay_score=1.0（§4.2）');
  if (affect === undefined) fallbacksOut.push('affect_consistency=0.5（§4.2）');
  if (relationship === undefined) fallbacksOut.push('relationship_weight=0.5（§4.2）');
  if (reliability === undefined) fallbacksOut.push('source_reliability=0.5（§4.2）');

  return {
    similarity: clamp(similarity === undefined ? 0 : similarity, 0, 1),
    importance: clamp(importance === undefined ? 0.5 : importance, 0, 1),
    recency,
    decay_score: clamp(decayValue === undefined ? 1.0 : decayValue, 0, 1),
    affect_consistency: clamp(affect === undefined ? 0.5 : affect, 0, 1),
    relationship_weight: clamp(relationship === undefined ? 0.5 : relationship, 0, 1),
    source_reliability: clamp(reliability === undefined ? 0.5 : reliability, 0, 1),
  };
}

/**
 * 融合评分（§4.2）。
 * 归一化顺序严格按契约：
 *   先算六维加权和，再加一次 route_bonus_norm * w_bonus，最后 clamp(0,1)。
 *   权重不做二次归一化；route_bonus 只在此处加一次。
 * @param {object} input 六维原始分 + routes/route_bonus_norm
 * @param {string|object} [scenario='default'] 场景档位或自定义权重对象
 * @param {{now?:string|number|Date, recency_window_days?:number}} [opts]
 * @returns {{final_score:number, raw_score:number, scenario:string, weights:object,
 *            dimensions:object, route_bonus:object, weight_sum:number, fallbacks:string[]}}
 */
function fuseScore(input = {}, scenario = 'default', opts = {}) {
  const weights = resolveWeights(scenario);
  const fallbacks = [];
  const dimensions = resolveScoreDimensions(input, opts, fallbacks);
  const routeBonus = resolveRouteBonus(input);

  const rawScore =
    dimensions.similarity * weights.w_sim +
    dimensions.importance * weights.w_imp +
    dimensions.recency * weights.w_rec +
    dimensions.decay_score * weights.w_decay +
    dimensions.affect_consistency * weights.w_aff +
    dimensions.relationship_weight * weights.w_rel +
    dimensions.source_reliability * weights.w_relia;

  // §4.1/§4.2：route_bonus_norm 只在融合末端加一次。
  const finalScore = clamp(rawScore + routeBonus.route_bonus_norm * weights.w_bonus, 0, 1);

  const weightSum =
    weights.w_sim + weights.w_imp + weights.w_rec + weights.w_decay +
    weights.w_aff + weights.w_rel + weights.w_relia + weights.w_bonus;

  return {
    final_score: finalScore,
    raw_score: rawScore,
    scenario: typeof scenario === 'string' ? scenario.toLowerCase() : 'custom',
    weights,
    dimensions,
    route_bonus: routeBonus,
    weight_sum: weightSum,
    fallbacks,
  };
}

/**
 * 时效衰减 decay_score（§4.3）。
 * decay_score = clamp(0.35*recency + 0.20*min(access_count/10,1)
 *                    + 0.30*importance - 0.15*min(age_days/365,1), 0, 1)
 * age_days 基准：created_at；recency 基准：valid_from（缺失用 created_at）。
 * 契约未给这些系数单独的常量，此处按 §4.3 正文实现并允许 opts 覆盖。
 * @param {{recency?:number, access_count?:number, importance?:number,
 *          created_at?:string|number|Date, valid_from?:string|number|Date,
 *          now?:string|number|Date}} [input]
 * @param {{w_recency?:number,w_access?:number,w_importance?:number,w_age?:number}} [opts]
 * @returns {{decay_score:number, recency:number, access_factor:number, importance:number,
 *            age_days:number|null, age_factor:number, components:object}}
 */
function decayScore(input = {}, opts = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const wRecency = isFiniteNumber(opts.w_recency) ? opts.w_recency : 0.35;
  const wAccess = isFiniteNumber(opts.w_access) ? opts.w_access : 0.2;
  const wImportance = isFiniteNumber(opts.w_importance) ? opts.w_importance : 0.3;
  const wAge = isFiniteNumber(opts.w_age) ? opts.w_age : 0.15;

  const createdAt = readPath(source, 'created_at') ?? readPath(source, 'evidence.created_at');
  const validFrom = readPath(source, 'temporal.valid_from') ?? source.valid_from;

  const explicitRecency = firstFinite(source, ['recency', 'quality.recency']);
  let recency;
  if (explicitRecency !== undefined) {
    recency = clamp(explicitRecency, 0, 1);
  } else {
    const computed = computeRecencyFromTimestamp(validFrom ?? createdAt, source.now ?? opts.now, 365);
    recency = computed === null ? 0 : computed;
  }

  const accessCount = firstFinite(source, ['access_count', 'quality.access_count']);
  const accessFactor = Math.min((accessCount === undefined ? 0 : Math.max(0, accessCount)) / 10, 1);

  const importance = clamp(
    firstFinite(source, ['importance', 'quality.importance']) ?? 0.5,
    0,
    1
  );

  const createdMs = toTimestamp(createdAt);
  const nowMs = toTimestamp(source.now ?? opts.now);
  const ageDays = createdMs === null || nowMs === null
    ? null
    : Math.max(0, (nowMs - createdMs) / 86400000);
  const ageFactor = ageDays === null ? 0 : Math.min(ageDays / 365, 1);

  const value = clamp(
    wRecency * recency + wAccess * accessFactor + wImportance * importance - wAge * ageFactor,
    0,
    1
  );

  return {
    decay_score: value,
    recency,
    access_factor: accessFactor,
    importance,
    age_days: ageDays,
    age_factor: ageFactor,
    components: {
      w_recency: wRecency,
      w_access: wAccess,
      w_importance: wImportance,
      w_age: wAge,
    },
  };
}

// 压缩梯度中的位置（越大越压缩）。
function formRank(form) {
  const index = DOWNGRADE_ORDER.indexOf(form);
  if (index === -1) throw new RangeError(`未知渲染形态: ${form}（见附录 G downgrade_order）`);
  return index;
}

/**
 * 压缩梯度顺序（附录 G）。
 * @param {string} form
 * @returns {string} 下一级（drop 的下一级仍是 drop）
 */
function nextDowngrade(form) {
  const index = formRank(form);
  return DOWNGRADE_ORDER[Math.min(index + 1, DOWNGRADE_ORDER.length - 1)];
}

/**
 * min_form（§5.3）：返回压缩梯度中更靠后（更压缩）的那个。
 * null/undefined 视为“无额外约束”。
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {string}
 */
function minForm(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return formRank(a) >= formRank(b) ? a : b;
}

/**
 * 分档 target_form（§4.4）。
 * >=0.90 summary_long；>=0.75 summary_short；>=0.55 structured（无 structured 则 tags）；
 * >=0.35 pointer；<0.35 drop。
 * @param {number} finalScore
 * @param {{has_structured?:boolean}} [opts]
 * @returns {string}
 */
function targetForm(finalScore, opts = {}) {
  const score = clamp(Number(finalScore), 0, 1);
  if (score >= TIER_THRESHOLDS.SUMMARY_LONG) return 'summary_long';
  if (score >= TIER_THRESHOLDS.SUMMARY_SHORT) return 'summary_short';
  if (score >= TIER_THRESHOLDS.STRUCTURED) {
    return opts.has_structured === false ? 'tags' : 'structured';
  }
  if (score >= TIER_THRESHOLDS.POINTER) return 'pointer';
  return 'drop';
}

/**
 * form_cap（§5.2）：
 *   quality_flag=degraded      -> 最高 tags
 *   lifecycle_state=cold_archived -> 最高 pointer
 *   quality_flag=needs_review  -> 最高 structured
 *   其他                       -> 无额外 cap（返回梯度最高级 summary_long）
 * 同时兼容扁平字段与 MemoryItem 嵌套字段。
 * @param {object} item
 * @returns {string}
 */
function formCap(item) {
  const source = item && typeof item === 'object' ? item : {};
  const quality = readPath(source, 'quality.quality_flag') ?? source.quality_flag;
  const lifecycle = source.lifecycle_state ?? readPath(source, 'lifecycle.state');

  let cap = 'summary_long';
  if (quality === QUALITY_FLAG.DEGRADED) cap = minForm(cap, 'tags');
  if (lifecycle === LIFECYCLE_STATE.COLD_ARCHIVED) cap = minForm(cap, 'pointer');
  if (quality === QUALITY_FLAG.NEEDS_REVIEW) cap = minForm(cap, 'structured');
  return cap;
}

/**
 * target_form = min_form(分档目标, form_cap)（§5.2）。
 * @param {number} finalScore
 * @param {object} item
 * @param {{has_structured?:boolean}} [opts]
 * @returns {string}
 */
function applyFormCap(finalScore, item, opts = {}) {
  return minForm(targetForm(finalScore, opts), formCap(item));
}

function entryRelevance(candidate) {
  const value = firstFinite(candidate, ['relevance', 'final_score', 'route_score', 'similarity']);
  return clamp(value === undefined ? 0 : value, 0, 1);
}

function memIdOf(candidate) {
  return candidate && candidate.mem_id !== null && candidate.mem_id !== undefined
    ? String(candidate.mem_id)
    : '';
}

function embeddingOf(candidate) {
  const embedding = candidate && (candidate.embedding ?? candidate.vector);
  return Array.isArray(embedding) ? embedding : null;
}

function similarityOf(a, b) {
  const va = embeddingOf(a);
  const vb = embeddingOf(b);
  if (!va || !vb || va.length !== vb.length || va.length === 0) return 0;
  return cosine(va, vb);
}

function relationKey(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const structured = candidate.structured && typeof candidate.structured === 'object'
    ? candidate.structured
    : (candidate.content && candidate.content.structured) || {};
  const entity = candidate.entity_key ?? candidate.entity ?? structured.entity ?? structured.subject;
  const predicate = candidate.predicate_key ?? candidate.predicate ?? structured.predicate ?? structured.attribute;
  if (entity === null || entity === undefined || predicate === null || predicate === undefined) {
    return null;
  }
  return `${String(entity)}\u0000${String(predicate)}`;
}

function versionChainSet(candidate) {
  const chain = (candidate && candidate.version_chain)
    ?? (candidate && candidate.temporal && candidate.temporal.version_chain);
  const ids = new Set([memIdOf(candidate)]);
  if (Array.isArray(chain)) {
    for (const id of chain) ids.add(String(id));
  }
  return ids;
}

function sameVersionChain(a, b) {
  const setA = versionChainSet(a);
  const setB = versionChainSet(b);
  for (const id of setA) {
    if (setB.has(id)) return true;
  }
  return false;
}

/**
 * MMR 去冗余（§4.5）。
 *   MMR = argmax[ lambda*relevance - (1-lambda)*max_sim_to_selected ]
 *   lambda=0.72；候选 top_n=30；duplicate_threshold=0.88；tie-breaker=mem_id 字典序。
 * 同一实体同一谓词最多 1 条，除非版本链（entity_key/predicate_key 或 structured 可解析时生效）。
 * 不使用随机数，同输入同 k 必同输出。候选不足 k 时返回实际可选数量。
 *
 * @param {Array<object>} candidates 需含 mem_id / relevance(或 final_score) / embedding
 * @param {number} [k=MMR.TOP_K_DEFAULT]
 * @param {{lambda?:number, top_n?:number, duplicate_threshold?:number}} [opts]
 * @returns {Array<object>} 按 MMR 选择顺序排列的原始候选引用
 */
function mmrSelect(candidates, k = MMR.TOP_K_DEFAULT, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const targetK = Math.max(0, Math.floor(Number(k)));
  if (!Number.isFinite(targetK) || targetK === 0) return [];

  const lambda = clamp(isFiniteNumber(opts.lambda) ? opts.lambda : MMR.LAMBDA, 0, 1);
  const topN = Math.max(1, Math.floor(isFiniteNumber(opts.top_n) ? opts.top_n : MMR.TOP_N));
  const threshold = isFiniteNumber(opts.duplicate_threshold)
    ? opts.duplicate_threshold
    : MMR.DUPLICATE_THRESHOLD;

  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      mem_id: memIdOf(candidate),
      relevance: entryRelevance(candidate),
    }))
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      if (a.mem_id !== b.mem_id) return a.mem_id < b.mem_id ? -1 : 1;
      return a.index - b.index;
    })
    .slice(0, topN);

  // 向量近重复预过滤（§4.5 duplicate_threshold）：保留排名更高者。
  const pool = [];
  for (const entry of ranked) {
    const nearDuplicate = pool.some((kept) => similarityOf(kept.candidate, entry.candidate) >= threshold);
    if (!nearDuplicate) pool.push(entry);
  }
  if (pool.length === 0) return [];

  const selected = [];
  selected.push(pool[0]);

  while (selected.length < targetK) {
    let best = null;
    let bestScore = -Infinity;

    for (const entry of pool) {
      if (selected.some((chosen) => memIdOf(chosen.candidate) === entry.mem_id)) continue;

      // 同一实体同一谓词最多 1 条，除非版本链。
      const key = relationKey(entry.candidate);
      if (key !== null) {
        const blocked = selected.some((chosen) => {
          const chosenKey = relationKey(chosen.candidate);
          return chosenKey === key && !sameVersionChain(chosen.candidate, entry.candidate);
        });
        if (blocked) continue;
      }

      let maxSimilarity = 0;
      for (const chosen of selected) {
        const similarity = similarityOf(chosen.candidate, entry.candidate);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }

      const score = lambda * entry.relevance - (1 - lambda) * maxSimilarity;
      const better =
        score > bestScore ||
        (score === bestScore &&
          best !== null &&
          (entry.mem_id < best.mem_id ||
            (entry.mem_id === best.mem_id && entry.index < best.index)));

      if (best === null || better) {
        best = entry;
        bestScore = score;
      }
    }

    if (best === null) break;
    selected.push(best);
  }

  return selected.map((entry) => entry.candidate);
}

/**
 * 重复注入率（§12）。
 * duplicate_injection_rate = 同一请求内同一 mem_id 重复注入条目数 / 注入条目数
 * 实现取「注入条目数 - 去重 mem_id 数」作为重复条目数。
 * 阈值：硬上限取 constants.TOKEN_BUDGET.GUARDRAILS.duplicate_injection_max（附录 G 0.05）；
 * 告警线取 §12 duplicate_injection_rate > 0.10。两者分属硬上限与告警线（契约原文已注明）。
 * @param {Array<string|object>} entries
 * @param {{max?:number, warn_threshold?:number}} [opts]
 * @returns {{injected_count:number, unique_count:number, duplicate_count:number, rate:number,
 *            hard_limit:number, warn_threshold:number, exceeds_hard_limit:boolean, warn:boolean}}
 */
function duplicateInjectionRate(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const injectedCount = list.length;
  const counts = new Map();

  for (const entry of list) {
    const memId = typeof entry === 'string'
      ? entry
      : (entry && entry.mem_id !== null && entry.mem_id !== undefined ? String(entry.mem_id) : '');
    counts.set(memId, (counts.get(memId) || 0) + 1);
  }

  const uniqueCount = counts.size;
  const duplicateCount = injectedCount - uniqueCount;
  const rate = injectedCount === 0 ? 0 : duplicateCount / injectedCount;

  const hardLimit = isFiniteNumber(opts.max)
    ? opts.max
    : TOKEN_BUDGET.GUARDRAILS.duplicate_injection_max;
  // §12 告警阈值：契约未在 constants 中单列，此处取契约正文 0.10 并允许覆盖。
  const warnThreshold = isFiniteNumber(opts.warn_threshold) ? opts.warn_threshold : 0.1;

  return {
    injected_count: injectedCount,
    unique_count: uniqueCount,
    duplicate_count: duplicateCount,
    rate,
    hard_limit: hardLimit,
    warn_threshold: warnThreshold,
    exceeds_hard_limit: rate > hardLimit,
    warn: rate > warnThreshold,
  };
}

module.exports = {
  resolveWeights,
  computeRouteBonus,
  resolveRouteBonus,
  computeRecencyFromTimestamp,
  resolveScoreDimensions,
  fuseScore,
  decayScore,
  nextDowngrade,
  minForm,
  targetForm,
  formCap,
  applyFormCap,
  mmrSelect,
  duplicateInjectionRate,
};
