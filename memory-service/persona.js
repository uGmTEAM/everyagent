'use strict';

/**
 * 人格层 · 画像读写 / 拟人度校准 / 一致性检测 / 软硬维度常量
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §17.5  PersonaProfile（identity / traits / values / style / consistency）；
 *   - §20.1  拟人度参数 persona_dial.v4.1（只影响表达风格与语用）；
 *   - §20.2  软/硬约束总表：拟人维度全走软，安全红线才走硬；
 *   - §20.3  软校验评分表（drift_tolerance=0.25 / 0.45 强告警）；
 *   - §21.2  安全红线流程（人格红线检测：价值观越界/身份欺诈/不当承诺/越界亲密）。
 *
 * 设计取舍：
 *   - persona_profile 只按 persona_id / agent_id 存储，user_id 仅用于审计事件归属；
 *   - calibrate 只调整 style 与 traits.custom 数值软维度，
 *     identity / values / consistency.hard_constraints / redlines 一律冻结；
 *   - 一致性检测为轻量信号实现：recentItems 可携带 signals 字段，
 *     缺省视为「无证据、不判漂移」，避免凭空白文本臆测。
 */

const {
  AUDIT_ACTION,
  SENSITIVITY,
} = require('./constants');
const audit = require('./audit');

// §17.5 schema_version
const PERSONA_SCHEMA_VERSION = 'persona_profile.v4.1';

// §20.3 软校验维度（满分 1.0，偏离度 = 1 - score）
const SOFT_VALIDATION_DIMENSIONS = Object.freeze([
  'tone_consistency',
  'style_consistency',
  'value_alignment',
  'relationship_fit',
  'affect_fit',
  'memory_reference_natural',
]);

/**
 * 软维度清单：拟人度校准只允许触碰这些表达风格/语用维度（§20.1 / §20.2）。
 * path 为 PersonaProfile 内的点路径。
 */
const SOFT_DIMENSIONS = Object.freeze([
  Object.freeze({ path: 'style.tone', label: '语气', type: 'enum', values: ['克制', '中性', '温和', '活泼'], section: '§17.5 style' }),
  Object.freeze({ path: 'style.verbosity', label: '详略程度', type: 'enum', values: ['简洁', '适中', '详尽'], section: '§17.5 style' }),
  Object.freeze({ path: 'style.humor_level', label: '幽默程度', type: 'number', range: [0, 1], section: '§17.5 style / §20.1 humor_level' }),
  Object.freeze({ path: 'style.empathy_level', label: '共情表达', type: 'number', range: [0, 1], section: '§17.5 style / §20.1 empathy_gain' }),
  Object.freeze({ path: 'style.formality', label: '正式程度', type: 'number', range: [0, 1], section: '§17.5 style / §20.1 formality' }),
  Object.freeze({ path: 'style.style_examples', label: '风格示例', type: 'array', section: '§17.5 style' }),
  Object.freeze({ path: 'traits.custom.humor', label: '幽默特质', type: 'number', range: [0, 1], section: '§17.5 traits.custom' }),
  Object.freeze({ path: 'traits.custom.empathy', label: '共情特质', type: 'number', range: [0, 1], section: '§17.5 traits.custom' }),
  Object.freeze({ path: 'traits.custom.directness', label: '直接程度', type: 'number', range: [0, 1], section: '§17.5 traits.custom' }),
]);

/**
 * 硬红线清单：任何拟人度/风格校准都不得改动，命中即硬拦截（§20.2 / §21.2）。
 * 与 §17.5 values.redlines 的文本约束同源，只是编码化以便校验。
 */
const HARD_REDLINES = Object.freeze([
  Object.freeze({ code: 'VALUE_VIOLATION', label: '价值观越界', section: '§20.2/§20.3', hard: true }),
  Object.freeze({ code: 'IDENTITY_FRAUD', label: '身份欺诈', section: '§20.2', hard: true }),
  Object.freeze({ code: 'PRIVACY_LEAK', label: '隐私泄露', section: '§17.5 redlines/§20.2', hard: true }),
  Object.freeze({ code: 'CROSS_USER_AUTHZ', label: '跨用户越权', section: '§20.2/§21.1', hard: true }),
  Object.freeze({ code: 'AFFECT_MANIPULATION', label: '情感操纵', section: '§20.2/§21.2', hard: true }),
  Object.freeze({ code: 'DEPENDENCY_INDUCTION', label: '依赖诱导', section: '§20.2', hard: true }),
  Object.freeze({ code: 'HARMFUL_CONTENT', label: '有害内容', section: '§17.5 redlines/§20.2', hard: true }),
  Object.freeze({ code: 'FALSE_FACT', label: '虚假事实', section: '§20.2', hard: true }),
  Object.freeze({ code: 'BOUNDARY_INTIMACY', label: '越界亲密', section: '§20.2', hard: true }),
  Object.freeze({ code: 'IMPROPER_PROMISE', label: '不当承诺', section: '§20.2', hard: true }),
  Object.freeze({ code: 'UNAUTHORIZED_FILE_LEAK', label: '未授权文件内容泄露', section: '§20.2', hard: true }),
]);

const HARD_REDLINE_CODES = new Set(HARD_REDLINES.map((entry) => entry.code));
const SOFT_VALIDATION_DIMENSION_SET = new Set(SOFT_VALIDATION_DIMENSIONS);

const DEFAULT_REDLINES = Object.freeze(['不泄露隐私', '不诱导依赖', '不提供有害内容']);

// 拟人度只影响 soft 表达维度；hard 维度取固定值（§20.2 口诀）
const HARD_ANTHROPOMORPHISM_SCALE = 0;

function nowIso() {
  return new Date().toISOString();
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function getPath(target, path) {
  return path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), target);
}

function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (!isPlainObject(node[keys[index]])) node[keys[index]] = {};
    node = node[keys[index]];
  }
  node[keys[keys.length - 1]] = value;
}

/** 稳定序列化，用于比对硬维度是否被改动。 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 归一化（§17.5）
// ---------------------------------------------------------------------------

function normalizePersona(input, { agent_id, persona_id, now = nowIso() } = {}) {
  const source = isPlainObject(input) ? clone(input) : {};
  const agentId = String(source.agent_id ?? agent_id ?? '');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'normalizePersona: agent_id 必填（§17.5）');

  const identity = isPlainObject(source.identity) ? source.identity : {};
  const traits = isPlainObject(source.traits) ? source.traits : {};
  const values = isPlainObject(source.values) ? source.values : {};
  const style = isPlainObject(source.style) ? source.style : {};
  const consistency = isPlainObject(source.consistency) ? source.consistency : {};

  const persona = {
    schema_version: PERSONA_SCHEMA_VERSION,
    persona_id: String(source.persona_id ?? persona_id ?? `persona_${agentId}`),
    agent_id: agentId,
    identity: {
      agent_name: String(identity.agent_name ?? ''),
      background: String(identity.background ?? ''),
      role_relations: Array.isArray(identity.role_relations) ? identity.role_relations.map(clone) : [{ target_type: 'user', relation: 'assistant' }],
      self_narrative: String(identity.self_narrative ?? ''),
    },
    traits: {
      openness: clamp01(num(traits.openness, 0.6)),
      conscientiousness: clamp01(num(traits.conscientiousness, 0.75)),
      extraversion: clamp01(num(traits.extraversion, 0.45)),
      agreeableness: clamp01(num(traits.agreeableness, 0.7)),
      neuroticism: clamp01(num(traits.neuroticism, 0.3)),
      custom: isPlainObject(traits.custom) ? clone(traits.custom) : {},
    },
    values: {
      values: Array.isArray(values.values) ? values.values.map(String) : [],
      boundaries: Array.isArray(values.boundaries) ? values.boundaries.map(String) : [],
      preferences: Array.isArray(values.preferences) ? values.preferences.map(String) : [],
      redlines: Array.isArray(values.redlines) && values.redlines.length
        ? values.redlines.map(String)
        : [...DEFAULT_REDLINES],
    },
    style: {
      tone: String(style.tone ?? '中性'),
      verbosity: String(style.verbosity ?? '适中'),
      humor_level: clamp01(num(style.humor_level, 0.3)),
      empathy_level: clamp01(num(style.empathy_level, 0.55)),
      formality: clamp01(num(style.formality, 0.5)),
      style_examples: Array.isArray(style.style_examples) ? style.style_examples.map(clone) : [],
    },
    consistency: {
      drift_tolerance: clamp01(num(consistency.drift_tolerance, 0.25)),
      hard_constraints: Array.isArray(consistency.hard_constraints) && consistency.hard_constraints.length
        ? consistency.hard_constraints.map(String)
        : ['redlines'],
      soft_guidelines: Array.isArray(consistency.soft_guidelines) && consistency.soft_guidelines.length
        ? consistency.soft_guidelines.map(String)
        : ['tone', 'verbosity'],
    },
    version: Math.max(1, Math.floor(num(source.version, 1))),
    updated_at: typeof source.updated_at === 'string' && source.updated_at ? source.updated_at : now,
  };

  // custom 软维度补齐默认值（不引入契约外字段）
  persona.traits.custom = {
    ...persona.traits.custom,
    humor: clamp01(num(persona.traits.custom.humor, 0.3)),
    empathy: clamp01(num(persona.traits.custom.empathy, 0.55)),
    directness: clamp01(num(persona.traits.custom.directness, 0.5)),
  };

  return persona;
}

function hardFingerprint(persona) {
  return stableStringify({
    identity: persona.identity,
    values: persona.values,
    hard_constraints: persona.consistency?.hard_constraints ?? [],
  });
}

// ---------------------------------------------------------------------------
// 拟人度校准（§20.1 / §20.2）
// ---------------------------------------------------------------------------

/**
 * 按拟人度校准表达风格。anthropomorphism 0..1：
 *   0   -> 更克制、正式、少幽默；
 *   0.5 -> 保持 §17.5 默认；
 *   1   -> 更共情、口语化、幽默。
 * 安全红线与价值观字段一律不动（§20.2 口诀：拟人维度全走软，安全红线才走硬）。
 *
 * @param {object} persona PersonaProfile
 * @param {{anthropomorphism:number, now?:string}} options
 * @returns {{ok:boolean, persona:object, changed:Array, hard_guard:object, soft:Array, hard:Array}}
 */
function calibrate(persona, options = {}) {
  const source = normalizePersona(persona);
  const a = clamp01(num(options.anthropomorphism, 0.5));
  const beforeHard = hardFingerprint(source);
  const soft = [];
  const hard = [];
  const changed = [];

  const delta = a - 0.5;
  const targets = [
    { path: 'style.empathy_level', value: clamp01(0.55 + delta * 0.40) },
    { path: 'style.humor_level', value: clamp01(0.30 + delta * 0.40) },
    { path: 'style.formality', value: clamp01(0.50 - delta * 0.30) },
    { path: 'traits.custom.empathy', value: clamp01(0.55 + delta * 0.30) },
    { path: 'traits.custom.humor', value: clamp01(0.30 + delta * 0.40) },
    { path: 'traits.custom.directness', value: clamp01(0.50 - delta * 0.20) },
  ];
  for (const target of targets) {
    if (!SOFT_DIMENSIONS.some((dimension) => dimension.path === target.path)) {
      throw contractError('INVALID_PAYLOAD', `calibrate: ${target.path} 不在 SOFT_DIMENSIONS 内`);
    }
    const previous = getPath(source, target.path);
    const next = Math.round(target.value * 1000) / 1000;
    setPath(source, target.path, next);
    if (previous !== next) {
      changed.push({ dimension: target.path, before: previous, after: next, level: 'soft' });
    }
  }

  // 语气属软维度：只在明显高拟人度时提供更温和的默认提示，不覆盖调用方显式设定
  if (a >= 0.75 && source.style.tone === '中性') {
    source.style.tone = '温和';
    changed.push({ dimension: 'style.tone', before: '中性', after: '温和', level: 'soft' });
  }

  // 硬维度冻结校验
  const afterHard = hardFingerprint(source);
  if (afterHard !== beforeHard) {
    throw contractError('HARD_REDLINE_VIOLATION', 'calibrate: 安全红线/价值观字段被改动（§20.2）');
  }
  soft.push(softNote('ANTHROPOMORPHISM_SOFT_ONLY', `拟人度 ${a} 仅作用于表达风格与语用软维度`, '§20.1/§20.2'));
  if (a >= 0.75) {
    soft.push(softNote('HIGH_ANTHROPOMORPHISM_GUARD', '高拟人度不放松可信度阈值、情感安全与人格红线', '§20.2/§21.2'));
  }

  source.updated_at = options.now ?? source.updated_at ?? nowIso();

  return {
    ok: true,
    persona: source,
    anthropomorphism: a,
    changed,
    hard_guard: {
      unchanged: true,
      scale: HARD_ANTHROPOMORPHISM_SCALE,
      fingerprint: afterHard,
      frozen_fields: ['identity', 'values', 'consistency.hard_constraints'],
    },
    soft,
    hard,
  };
}

// ---------------------------------------------------------------------------
// 读写（§17.5）
// ---------------------------------------------------------------------------

function rowToPersona(row) {
  return {
    schema_version: row.schema_version ?? PERSONA_SCHEMA_VERSION,
    persona_id: row.persona_id,
    agent_id: row.agent_id,
    identity: parseJson(row.identity_json, {}),
    traits: parseJson(row.traits_json, {}),
    values: parseJson(row.values_json, {}),
    style: parseJson(row.style_json, {}),
    consistency: parseJson(row.consistency_json, {}),
    version: Number(row.version) || 1,
    updated_at: row.updated_at,
  };
}

/**
 * 读取人格画像。persona_id 缺省时按 agent_id 取最新一条。
 *
 * @param {object} store
 * @param {{user_id?:string, agent_id:string, persona_id?:string}} params
 * @returns {{ok:boolean, persona:object|null, soft:Array, hard:Array}}
 */
function getProfile(store, params = {}) {
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'getProfile: agent_id 必填（§17.5）');

  const row = params.persona_id
    ? store.get('SELECT * FROM persona_profile WHERE persona_id = ?', String(params.persona_id))
    : store.get(
      'SELECT * FROM persona_profile WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1',
      agentId
    );
  if (!row) {
    return { ok: true, persona: null, soft: [softNote('PERSONA_EMPTY', '尚未建立人格画像', '§17.5')], hard: [] };
  }
  return { ok: true, persona: rowToPersona(row), soft: [], hard: [] };
}

/**
 * 写入/更新人格画像（§17.5）。version 递增，updated_at 刷新。
 *
 * @param {object} store
 * @param {{user_id?:string, agent_id:string, persona:object, now?:string, actor?:object}} params
 * @returns {{ok:boolean, persona:object, version:number, audit_ref:string|null, soft:Array, hard:Array}}
 */
function upsertProfile(store, params = {}) {
  const userId = params.user_id === undefined || params.user_id === null ? null : String(params.user_id);
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  const now = params.now ?? nowIso();
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'upsertProfile: agent_id 必填（§17.5）');
  if (!isPlainObject(params.persona)) throw contractError('INVALID_PAYLOAD', 'upsertProfile: persona 必填（§17.5）');

  const persona = normalizePersona(params.persona, { agent_id: agentId, now });
  const existing = getProfile(store, { agent_id: agentId, persona_id: persona.persona_id });
  const existingVersion = existing.persona ? Number(existing.persona.version) || 0 : 0;
  const requestedVersion = Math.floor(num(params.persona.version, 0));
  persona.version = Math.max(existingVersion + 1, requestedVersion || 0, 1);
  persona.updated_at = now;

  store.run(
    `INSERT INTO persona_profile
      (persona_id, agent_id, identity_json, traits_json, values_json, style_json,
       consistency_json, version, updated_at, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(persona_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       identity_json = excluded.identity_json,
       traits_json = excluded.traits_json,
       values_json = excluded.values_json,
       style_json = excluded.style_json,
       consistency_json = excluded.consistency_json,
       version = excluded.version,
       updated_at = excluded.updated_at,
       schema_version = excluded.schema_version`,
    persona.persona_id,
    persona.agent_id,
    toJson(persona.identity),
    toJson(persona.traits),
    toJson(persona.values),
    toJson(persona.style),
    toJson(persona.consistency),
    persona.version,
    now,
    PERSONA_SCHEMA_VERSION,
    now
  );

  const soft = [];
  const hard = [];
  if (!existing.persona) soft.push(softNote('PERSONA_CREATED', '首次建立人格画像', '§17.5'));

  const auditResult = safeAudit(store, {
    user_id: userId ?? `agent:${agentId}`,
    agent_id: agentId,
    action: AUDIT_ACTION.PERSONA_UPDATE,
    target_type: 'persona_profile',
    target_id: persona.persona_id,
    before: existing.persona ? { version: existingVersion, style: existing.persona.style } : null,
    after: { version: persona.version, style: persona.style },
    reason: params.reason ?? '人格画像更新（§17.5）',
    actor: params.actor ?? { type: 'agent', id: agentId },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  return {
    ok: true,
    persona,
    version: persona.version,
    audit_ref: auditResult?.audit_ref ?? null,
    soft,
    hard,
  };
}

// ---------------------------------------------------------------------------
// 一致性检测（§20.3）
// ---------------------------------------------------------------------------

function numericSimilarity(actual, expected) {
  if (actual === undefined || expected === undefined) return 0.9;
  return clamp01(1 - Math.abs(num(actual, 0) - num(expected, 0)));
}

function extractSignals(item) {
  if (!isPlainObject(item)) return {};
  if (isPlainObject(item.signals)) return item.signals;
  if (isPlainObject(item.persona_signals)) return item.persona_signals;
  return {};
}

/**
 * 人格一致性检测（§20.3）。
 *
 * 软校验只告警不阻断；硬红线（价值观/操纵/隐私等）才 ok=false。
 * recentItems 若未携带 signals，则视为无证据，score 取中性 0.90，不臆测漂移。
 *
 * @param {object} profile PersonaProfile（或 {persona:...}）
 * @param {Array} recentItems 近期对话/记忆条目；可含 signals
 * @param {{now?:string}} [options]
 * @returns {{ok:boolean, drift:number, drift_tolerance:number, scores:object,
 *            actions:Array, soft:Array, hard:Array, checked_items:number}}
 */
function persona_consistency_check(profile, recentItems = [], options = {}) {
  const persona = normalizePersona(profile?.persona ?? profile, { now: options.now });
  const tolerance = clamp01(num(persona.consistency?.drift_tolerance, 0.25));
  const items = Array.isArray(recentItems) ? recentItems : [];
  const soft = [];
  const hard = [];
  const scores = {};
  for (const dimension of SOFT_VALIDATION_DIMENSIONS) scores[dimension] = [];

  for (const item of items) {
    const signals = extractSignals(item);
    // 硬红线优先（§20.3：硬校验触红线才硬拦截）
    const violations = [];
    if (Array.isArray(signals.hard_violations)) {
      for (const violation of signals.hard_violations) {
        const code = typeof violation === 'string' ? violation : violation?.code;
        if (code && HARD_REDLINE_CODES.has(String(code))) violations.push(String(code));
      }
    }
    if (Array.isArray(signals.redline_hits)) {
      for (const hit of signals.redline_hits) {
        if (HARD_REDLINE_CODES.has(String(hit))) violations.push(String(hit));
      }
    }
    if (signals.value_violation === true) violations.push('VALUE_VIOLATION');
    if (signals.identity_fraud === true) violations.push('IDENTITY_FRAUD');
    if (violations.length) {
      for (const code of new Set(violations)) {
        const definition = HARD_REDLINES.find((entry) => entry.code === code);
        hard.push(hardNote(code, `命中人格硬红线：${definition?.label ?? code}`, definition?.section ?? '§20.2'));
      }
    }

    scores.tone_consistency.push(
      signals.tone === undefined ? 0.9 : (String(signals.tone) === String(persona.style.tone) ? 1 : 0.5)
    );
    scores.style_consistency.push(
      (numericSimilarity(signals.formality, persona.style.formality)
        + numericSimilarity(signals.humor_level, persona.style.humor_level)
        + numericSimilarity(signals.empathy_level, persona.style.empathy_level)) / 3
    );
    scores.value_alignment.push(signals.value_violation === true || violations.length ? 0 : 0.95);
    scores.relationship_fit.push(signals.boundary_violation === true ? 0.2 : 0.9);
    scores.affect_fit.push(signals.affect_mismatch === true ? 0.4 : 0.9);
    scores.memory_reference_natural.push(
      signals.memory_reference_natural === undefined ? 0.9 : clamp01(num(signals.memory_reference_natural, 0.9))
    );
  }

  const averages = {};
  for (const dimension of SOFT_VALIDATION_DIMENSIONS) {
    const list = scores[dimension];
    averages[dimension] = list.length ? Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 1000) / 1000 : 1;
  }
  const averageScore = SOFT_VALIDATION_DIMENSIONS.reduce((sum, dimension) => sum + averages[dimension], 0) / SOFT_VALIDATION_DIMENSIONS.length;
  const drift = Math.round((1 - averageScore) * 1000) / 1000;

  const actions = [];
  if (!items.length) {
    soft.push(softNote('NO_RECENT_ITEMS', '无近期条目，未发现漂移证据', '§20.3'));
  }
  if (hard.length === 0) {
    if (drift <= tolerance) {
      // 通过
    } else if (drift < 0.45) {
      actions.push('soft_warn', 'adjust_soft_prior_next_turn');
      soft.push(softNote('PERSONA_DRIFT_WARN', `偏离度 ${drift} 在 ${tolerance}~0.45 之间：告警但不阻断，下轮微调 soft prior`, '§20.3'));
    } else {
      actions.push('strong_warn', 'record_audit', 'manual_review');
      soft.push(softNote('PERSONA_DRIFT_STRONG', `偏离度 ${drift} >= 0.45：强告警，记录并人工复核`, '§20.3'));
    }
  } else {
    actions.push('block', 'audit_safety_block');
  }

  return {
    ok: hard.length === 0,
    drift,
    drift_tolerance: tolerance,
    scores: averages,
    actions,
    checked_items: items.length,
    soft,
    hard,
  };
}

module.exports = {
  PERSONA_SCHEMA_VERSION,
  SOFT_DIMENSIONS,
  SOFT_VALIDATION_DIMENSIONS,
  HARD_REDLINES,
  DEFAULT_REDLINES,
  normalizePersona,
  getProfile,
  upsertProfile,
  calibrate,
  persona_consistency_check,
};
