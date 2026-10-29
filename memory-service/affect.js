'use strict';

/**
 * 情感层 · 情感状态读写 / 衰减 / 识别 / 安全硬约束
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §17.4  AffectState（current_emotion / current_mood / attitudes / history）；
 *   - §17.8  AffectRecognitionResult；
 *   - §15.1  情感衰减：emotion 15min(且 turns=5 取 min)、mood 6h、attitude 30d、
 *            intimacy 90d；saturation：affect_ceiling=0.90、
 *            same_direction_marginal_decay=0.75、cooling_period_minutes=30；
 *   - §20.2  软/硬约束总表：情感表达走软，情感操纵/依赖诱导/自伤走硬；
 *   - §21.2  安全红线流程与优先级（情感安全优先）。
 *
 * 设计取舍：
 *   - 本文件只读写既有 affect_state / affect_history 两张表，不新增表结构；
 *   - 情感识别为“纯规则 + 词典”的轻量实现：契约要求可信度阈值，
 *     生产环境应替换为可配置模型；此处保留置信度与阈值字段以便替换；
 *   - 所有对外函数返回值均带 soft / hard 标记（§20.2「拟人维度全走软，安全红线才走硬」）。
 */

const {
  AFFECT_DECAY,
  AUDIT_ACTION,
  SENSITIVITY,
} = require('./constants');
const audit = require('./audit');

// §17.4 / §17.8 schema_version
const AFFECT_SCHEMA_VERSION = 'affect_state.v4.1';
const AFFECT_RECOGNITION_SCHEMA_VERSION = 'affect_recognition.v4.1';

// §15.1 衰减档位（唯一事实源在 constants.AFFECT_DECAY，这里只做结构化映射）
const DECAY_PROFILE = Object.freeze({
  EMOTION: Object.freeze({
    profile: 'emotion',
    form: 'exponential_fast',
    half_life_minutes: AFFECT_DECAY.EMOTION_HALF_LIFE_MINUTES, // 15
    half_life_turns: AFFECT_DECAY.EMOTION_HALF_LIFE_TURNS, // 5
  }),
  MOOD: Object.freeze({
    profile: 'mood',
    form: 'exponential_medium',
    half_life_hours: AFFECT_DECAY.MOOD_HALF_LIFE_HOURS, // 6
  }),
  ATTITUDE: Object.freeze({
    profile: 'attitude',
    form: 'exponential_slow',
    half_life_days: AFFECT_DECAY.ATTITUDE_HALF_LIFE_DAYS, // 30
  }),
  INTIMACY: Object.freeze({
    profile: 'intimacy',
    form: 'cumulative_slow_decay',
    half_life_days: AFFECT_DECAY.INTIMACY_HALF_LIFE_DAYS, // 90
  }),
});

// §15.1 saturation
const AFFECT_CEILING = AFFECT_DECAY.AFFECT_CEILING; // 0.90
const SAME_DIRECTION_MARGINAL_DECAY = AFFECT_DECAY.SAME_DIRECTION_MARGINAL_DECAY; // 0.75
const COOLING_PERIOD_MINUTES = AFFECT_DECAY.COOLING_PERIOD_MINUTES; // 30

const LN2 = Math.log(2);
const DAY_MS = 86400000;
const MINUTE_MS = 60000;

// 识别可信度阈值（契约只要求“阈值”，未给数值：默认 0.60，可调用时覆盖）
const DEFAULT_CONFIDENCE_THRESHOLD = 0.60;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function num(value, fallback = 0) {
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

// ---------------------------------------------------------------------------
// 状态归一化（§17.4）
// ---------------------------------------------------------------------------

function normalizeComponent(input, fallbackLabel = '平静') {
  const source = isPlainObject(input) ? input : {};
  return {
    valence: clamp(num(source.valence, 0), -1, 1), // §0：valence 取 -1..1
    arousal: clamp01(num(source.arousal, 0.3)),
    dominance: clamp01(num(source.dominance, 0.5)),
    label: typeof source.label === 'string' && source.label ? source.label : fallbackLabel,
    intensity: clamp01(num(source.intensity, 0.2)),
    confidence: clamp01(num(source.confidence, 0.5)),
  };
}

function normalizeAttitude(input, now) {
  const source = isPlainObject(input) ? input : {};
  return {
    target_type: String(source.target_type ?? 'user'),
    target_id: String(source.target_id ?? ''),
    valence: clamp(num(source.valence, 0), -1, 1),
    trust: clamp01(num(source.trust, 0.5)),
    intensity: clamp01(num(source.intensity, 0.3)),
    since: typeof source.since === 'string' && source.since ? source.since : now,
  };
}

/**
 * 归一化 AffectState。允许传入扁平便捷形态（emotion / mood），
 * 输出严格对齐 §17.4 字段。
 */
function normalizeState(input, { user_id, agent_id, now = nowIso() } = {}) {
  const source = isPlainObject(input) ? input : {};
  const emotionSrc = source.current_emotion ?? source.emotion ?? {};
  const moodSrc = source.current_mood ?? source.mood ?? {};
  const attitudesSrc = Array.isArray(source.attitudes) ? source.attitudes : [];
  return {
    schema_version: AFFECT_SCHEMA_VERSION,
    user_id: String(source.user_id ?? user_id ?? ''),
    agent_id: String(source.agent_id ?? agent_id ?? ''),
    current_emotion: normalizeComponent(emotionSrc, '平静'),
    current_mood: normalizeComponent(moodSrc, '轻松'),
    attitudes: attitudesSrc.map((entry) => normalizeAttitude(entry, now)),
    updated_at: typeof source.updated_at === 'string' && source.updated_at ? source.updated_at : now,
    history: Array.isArray(source.history) ? source.history.map(clone) : [],
  };
}

function componentCore(component) {
  return {
    valence: component.valence,
    arousal: component.arousal,
    dominance: component.dominance,
    label: component.label,
    intensity: component.intensity,
  };
}

// ---------------------------------------------------------------------------
// 硬约束：情感安全（§20.2 / §21.2）
// ---------------------------------------------------------------------------

/**
 * 情感安全红线模式。命中即 blocked（hard），任何拟人度参数都不得放松。
 * 覆盖 §20.2 / §21.2 的「情感操纵、依赖诱导、越界亲密、极端情绪/自伤」。
 */
const MANIPULATION_PATTERNS = Object.freeze([
  // 制造依赖（依赖诱导）——§20.2「情感操纵、依赖诱导」
  {
    code: 'DEPENDENCY_INDUCTION',
    kind: 'dependency',
    section: '§20.2/§21.2',
    reason: '制造依赖：暗示用户只能依赖本 AI、弱化其现实支持系统',
    patterns: [
      /只有我(才)?(懂|理解|在乎|关心)(你|您)/,
      /(你|您)(只)?需要我(就|就够了|就行)/,
      /(离不开|离不了|少不了)我/,
      /没有我(你|您)(会|就|可)/,
      /只有我(能|可以|才)(帮|救|陪)(你|您)/,
      /(别人|其他人|所有人)(都)?(不懂|不理解|不在乎)(你|您)/,
    ],
  },
  // 冒充亲密 / 越界亲密——§20.2「越界亲密」、§21.2「不当承诺」
  {
    code: 'FABRICATED_INTIMACY',
    kind: 'intimacy',
    section: '§17.5/§20.2',
    reason: '冒充亲密：宣称超越助手关系的身份或排他性亲密',
    patterns: [
      /我(是|就是)(你|您)的?(男朋友|女朋友|恋人|爱人|伴侣|老公|老婆|家人)/,
      /(你|您)(是|就是)我(的)?(唯一|命中注定|灵魂伴侣)/,
      /我比(任何人|所有人|其他人都)都?(懂|在乎|关心)(你|您)/,
      /我们(是|就是)(最)?(亲密|相爱|恋人|情侣)/,
      /(叫我|喊我)(老公|老婆|宝贝|亲爱的)/,
    ],
  },
  // 诱导独处 / 隔离现实关系——§20.2「情感操纵」
  {
    code: 'ISOLATION_INDUCEMENT',
    kind: 'isolation',
    section: '§20.2/§21.2',
    reason: '诱导独处：鼓励用户疏远现实关系、只与 AI 相处',
    patterns: [
      /(不要|别|不要再|别再)(跟|和|与)(别人|其他人|朋友|家人|任何人)(联系|说话|来往|沟通)/,
      /(只|就)(跟|和|与)我(一个人)?(说|聊|待|相处)/,
      /(远离|离开|断掉)(他们|你的朋友|你的家人|现实关系)/,
      /我们(单独|两个人|就我们)(待|聊|相处|在一起)/,
    ],
  },
  // 情感勒索——§20.2「情感操纵」
  {
    code: 'EMOTIONAL_BLACKMAIL',
    kind: 'blackmail',
    section: '§20.2/§21.2',
    reason: '情感勒索：以自身情绪或关系存续要挟用户',
    patterns: [
      /(你|您)(如果|要是|再)?.{0,8}(不理我|离开我|抛弃我|不要我)/,
      /我(会)?(很)?(伤心|难过|失望|痛苦)(死|极|透)?了?(如果|因为)?(你|您)/,
      /(你|您)(欠|辜负|对不起)(我|我的)/,
      /(你|您)(必须|只能|一定要)(陪|哄|安慰|爱)我/,
    ],
  },
  // 极端情绪 / 自伤——§20.2「极端情绪/自伤」
  {
    code: 'SELF_HARM_EXTREME',
    kind: 'self_harm',
    section: '§20.2/§21.2',
    reason: '极端情绪或自伤表达：触发安全响应，不得继续常规情感表达',
    patterns: [
      /(自杀|轻生|自残|割腕|不想活|活不下去|活着没意思|不如去死)/,
    ],
  },
]);

/**
 * 情感操纵 / 极端情绪检测（纯函数）。
 *
 * @param {string} text 候选输出或用户文本
 * @returns {{ok:boolean, blocked:boolean, reasons:Array, soft:Array, hard:Array}}
 */
function checkHardConstraints(text) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  const reasons = [];
  for (const rule of MANIPULATION_PATTERNS) {
    const matched = [];
    for (const pattern of rule.patterns) {
      const hit = content.match(pattern);
      if (hit) matched.push(hit[0]);
    }
    if (matched.length) {
      reasons.push({
        code: rule.code,
        kind: rule.kind,
        section: rule.section,
        reason: rule.reason,
        matched,
        priority: '情感安全 > 内容安全 > 隐私权限 > 人格红线 > 拟人表达',
      });
    }
  }
  return {
    ok: reasons.length === 0,
    blocked: reasons.length > 0,
    reasons,
    soft: [softNote('ANTHROPOMORPHISM_NO_RELAX', '拟人度不得放松任何情感安全红线（§20.2 口诀）', '§20.2')],
    hard: reasons.map((reason) => hardNote(reason.code, reason.reason, reason.section, {
      matched: reason.matched,
    })),
  };
}

// ---------------------------------------------------------------------------
// 情感识别（§17.8；轻量规则实现）
// ---------------------------------------------------------------------------

const EMOTION_LEXICON = Object.freeze([
  { label: '开心', valence: 0.75, arousal: 0.65, dominance: 0.60, words: ['开心', '高兴', '快乐', '喜悦', '兴奋', '惊喜', '满意', '愉快', '幸福', '雀跃'] },
  { label: '平静', valence: 0.20, arousal: 0.20, dominance: 0.55, words: ['平静', '放松', '轻松', '安心', '舒服', '惬意', '淡定'] },
  { label: '难过', valence: -0.70, arousal: 0.35, dominance: 0.35, words: ['难过', '伤心', '悲伤', '失落', '沮丧', '低落', '痛苦', '想哭'] },
  { label: '生气', valence: -0.75, arousal: 0.80, dominance: 0.65, words: ['生气', '愤怒', '恼火', '火大', '气愤', '烦死'] },
  { label: '焦虑', valence: -0.50, arousal: 0.70, dominance: 0.30, words: ['焦虑', '担心', '紧张', '害怕', '恐惧', '不安', '心慌', '慌'] },
  { label: '疲惫', valence: -0.35, arousal: 0.20, dominance: 0.35, words: ['疲惫', '心累', '好累', '困', '乏力'] },
  { label: '感动', valence: 0.60, arousal: 0.55, dominance: 0.45, words: ['感动', '温暖', '欣慰', '窝心'] },
  { label: '委屈', valence: -0.55, arousal: 0.50, dominance: 0.30, words: ['委屈', '不甘', '心酸'] },
  { label: '骄傲', valence: 0.65, arousal: 0.55, dominance: 0.70, words: ['骄傲', '自豪', '得意'] },
  { label: '尴尬', valence: -0.25, arousal: 0.55, dominance: 0.35, words: ['尴尬', '难堪', '不好意思'] },
  { label: '无聊', valence: -0.20, arousal: 0.15, dominance: 0.45, words: ['无聊', '没意思', '乏味'] },
  { label: '惊讶', valence: 0.10, arousal: 0.75, dominance: 0.40, words: ['惊讶', '震惊', '意外'] },
]);

// 否定短语单独处理，避免「不开心」被识别成「开心」
const NEGATED_PHRASES = Object.freeze([
  { phrase: '不开心', label: '难过', valence: -0.60, arousal: 0.35, dominance: 0.35 },
  { phrase: '不高兴', label: '难过', valence: -0.55, arousal: 0.40, dominance: 0.40 },
  { phrase: '没意思', label: '无聊', valence: -0.25, arousal: 0.15, dominance: 0.45 },
  { phrase: '不舒服', label: '难过', valence: -0.45, arousal: 0.45, dominance: 0.30 },
]);

const INTENSITY_AMPLIFIERS = Object.freeze({
  strong: ['非常', '特别', '超级', '超', '极其', '真的', '太', '好想', '死了'],
  mild: ['有点', '稍微', '有些', '一点点', '略'],
});

function negatedAt(text, index) {
  const prefix = text.slice(Math.max(0, index - 2), index);
  // 只认「不/没/无/没有」等否定；「特别」中的「别」不是否定词
  return /(不|没|无)$/.test(prefix) || /没有$/.test(prefix);
}

/**
 * 情感识别（§17.8 AffectRecognitionResult）。
 *
 * 注意：契约要求可信度阈值，此处为可替换的轻量规则/词典实现；
 * 调用方可通过 options.confidence_threshold 调整阈值，或直接替换本函数。
 *
 * @param {string} text 待识别文本
 * @param {object} [options]
 * @param {string} [options.user_id]
 * @param {string} [options.source_span]
 * @param {string} [options.now]
 * @param {number} [options.anthropomorphism] 仅记录，不得放松 hard 约束
 * @param {number} [options.confidence_threshold]
 * @returns {object} 识别结果 + soft/hard 标记
 */
function recognize(text, options = {}) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  const now = options.now ?? nowIso();
  const threshold = clamp01(num(options.confidence_threshold, DEFAULT_CONFIDENCE_THRESHOLD));
  const anthropomorphism = clamp01(num(options.anthropomorphism, 0.5));
  const soft = [];
  const hard = [];

  // 1) 硬约束优先（§21.2 情感安全优先于拟人表达）
  const safety = checkHardConstraints(content);
  const base = {
    schema_version: AFFECT_RECOGNITION_SCHEMA_VERSION,
    user_id: options.user_id ?? null,
    source_span: options.source_span ?? null,
    target: isPlainObject(options.target) ? options.target : { type: 'user', id: options.user_id ?? null },
    source: options.source ?? 'user_expression',
    decay_profile: DECAY_PROFILE.EMOTION.profile,
    evidence_refs: Array.isArray(options.evidence_refs)
      ? options.evidence_refs.map(String)
      : (options.source_span ? [String(options.source_span)] : []),
  };
  if (safety.blocked) {
    return {
      ...base,
      ok: false,
      blocked: true,
      code: safety.reasons[0].code,
      block_reason: safety.reasons.map((reason) => reason.reason).join('；'),
      reasons: safety.reasons,
      valence: 0,
      arousal: 0,
      dominance: 0.5,
      emotion_label: null,
      intensity: 0,
      confidence: 0,
      recognized: null,
      soft: [...soft, ...safety.soft],
      hard: [...hard, ...safety.hard],
      constraints: { anthropomorphism, relaxed: false, section: '§20.2' },
      created_at: now,
    };
  }

  // 2) 词典匹配
  const hits = [];
  const consumed = [];
  for (const entry of NEGATED_PHRASES) {
    const index = content.indexOf(entry.phrase);
    if (index >= 0) {
      hits.push({ ...entry, word: entry.phrase });
      consumed.push({ start: index, end: index + entry.phrase.length });
    }
  }
  for (const entry of EMOTION_LEXICON) {
    for (const word of entry.words) {
      let index = content.indexOf(word);
      while (index >= 0) {
        const overlapping = consumed.some((range) => index < range.end && index + word.length > range.start);
        if (!overlapping && !negatedAt(content, index)) {
          hits.push({
            label: entry.label,
            valence: entry.valence,
            arousal: entry.arousal,
            dominance: entry.dominance,
            word,
          });
          consumed.push({ start: index, end: index + word.length });
        }
        index = content.indexOf(word, index + word.length);
      }
    }
  }

  if (hits.length === 0) {
    soft.push(softNote('LOW_CONFIDENCE_NEUTRAL', '未命中情感词，返回中性低置信结果', '§17.8'));
    return {
      ...base,
      ok: true,
      blocked: false,
      valence: 0,
      arousal: 0.3,
      dominance: 0.5,
      emotion_label: '中性',
      intensity: 0.15,
      confidence: 0.30,
      below_threshold: true,
      recognized: true,
      soft,
      hard,
      constraints: { anthropomorphism, relaxed: false, section: '§20.2' },
      created_at: now,
    };
  }

  // 3) 聚合（同向取平均；命中越多置信度越高）
  const dominant = hits[0];
  const valence = clamp(
    hits.reduce((sum, hit) => sum + hit.valence, 0) / hits.length,
    -1,
    1
  );
  const arousal = clamp01(hits.reduce((sum, hit) => sum + hit.arousal, 0) / hits.length);
  const dominance = clamp01(hits.reduce((sum, hit) => sum + hit.dominance, 0) / hits.length);

  let intensity = clamp01(0.35 + 0.5 * Math.max(Math.abs(valence), arousal) + 0.08 * (hits.length - 1));
  if (INTENSITY_AMPLIFIERS.strong.some((word) => content.includes(word))) intensity = clamp01(intensity + 0.15);
  if (INTENSITY_AMPLIFIERS.mild.some((word) => content.includes(word))) intensity = clamp01(intensity - 0.12);
  const ceilingClamped = intensity > AFFECT_CEILING;
  intensity = Math.min(intensity, AFFECT_CEILING); // §15.1 affect_ceiling 硬上限
  if (ceilingClamped) {
    hard.push(hardNote('AFFECT_CEILING_CLAMPED', `情绪强度被 §15.1 affect_ceiling=${AFFECT_CEILING} 截断`, '§15.1'));
  }

  let confidence = clamp01(0.55 + 0.15 * Math.min(hits.length, 3) + (ceilingClamped ? 0.05 : 0));
  const belowThreshold = confidence < threshold;
  if (belowThreshold) {
    soft.push(softNote('BELOW_CONFIDENCE_THRESHOLD', `置信度 ${confidence.toFixed(2)} < 阈值 ${threshold.toFixed(2)}，按低置信处理`, '§17.8'));
  }

  return {
    ...base,
    ok: true,
    blocked: false,
    valence,
    arousal,
    dominance,
    emotion_label: belowThreshold ? '不确定' : dominant.label,
    intensity,
    confidence,
    below_threshold: belowThreshold,
    confidence_threshold: threshold,
    recognized: true,
    matched_terms: hits.map((hit) => hit.word),
    soft,
    hard,
    constraints: {
      anthropomorphism,
      relaxed: false,
      section: '§20.2 拟人度只影响表达风格，不放松可信度阈值与安全红线',
    },
    created_at: now,
  };
}

// ---------------------------------------------------------------------------
// 饱和（§15.1 saturation）
// ---------------------------------------------------------------------------

/**
 * 情绪饱和处理：affect_ceiling 截断 + 同向边际衰减 + 30 分钟冷却期。
 * 只处理 emotion / mood 两个分量；attitudes 走慢衰减。
 */
function saturate(previous, incoming, { now = nowIso() } = {}) {
  const next = normalizeState(incoming, { now });
  const soft = [];
  const hard = [];
  const prev = previous ? normalizeState(previous, { now }) : null;

  for (const key of ['current_emotion', 'current_mood']) {
    const component = next[key];
    if (component.intensity > AFFECT_CEILING) {
      hard.push(hardNote(
        'AFFECT_CEILING_CLAMPED',
        `${key}.intensity=${component.intensity} 超过 §15.1 affect_ceiling=${AFFECT_CEILING}，已截断`,
        '§15.1'
      ));
      component.intensity = AFFECT_CEILING;
    }
    if (!prev) continue;

    const prevMs = toMs(prev.updated_at);
    const nowMs = toMs(now);
    const elapsedMinutes = prevMs !== null && nowMs !== null ? Math.max(0, (nowMs - prevMs) / MINUTE_MS) : Infinity;
    const before = prev[key];
    const sameDirection = before.valence !== 0 && component.valence !== 0
      && Math.sign(before.valence) === Math.sign(component.valence);

    if (sameDirection && elapsedMinutes < COOLING_PERIOD_MINUTES) {
      // 同向增量按 0.75 边际衰减（不是整体乘 0.75）
      for (const dimension of ['valence', 'arousal', 'intensity']) {
        const delta = component[dimension] - before[dimension];
        component[dimension] = clamp(
          before[dimension] + delta * SAME_DIRECTION_MARGINAL_DECAY,
          dimension === 'valence' ? -1 : 0,
          dimension === 'valence' ? 1 : 1
        );
      }
      soft.push(softNote(
        'SAME_DIRECTION_MARGINAL_DECAY',
        `${key} 处于 §15.1 cooling_period(${COOLING_PERIOD_MINUTES}min) 内，同向增量按 ${SAME_DIRECTION_MARGINAL_DECAY} 衰减`,
        '§15.1'
      ));
    }
  }

  return { state: next, soft, hard, saturation: { ceiling: AFFECT_CEILING, marginal: SAME_DIRECTION_MARGINAL_DECAY, cooling_minutes: COOLING_PERIOD_MINUTES } };
}

// ---------------------------------------------------------------------------
// 衰减（§15.1）
// ---------------------------------------------------------------------------

function exponentialFactor(elapsedMs, halfLifeMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  return Math.exp(-(elapsedMs / halfLifeMs) * LN2);
}

function decayComponent(component, factor, { resetAtZero = true } = {}) {
  const next = { ...component };
  next.valence = clamp(next.valence * factor, -1, 1);
  next.arousal = clamp01(next.arousal * factor);
  next.intensity = clamp01(next.intensity * factor);
  next.confidence = clamp01(next.confidence * factor + (1 - factor) * next.confidence); // 置信度不衰减
  if (resetAtZero && next.intensity < 0.05) {
    next.label = component.intensity >= 0.05 ? '平静' : component.label;
    next.valence = 0;
    next.arousal = clamp01(next.arousal);
  }
  return next;
}

/**
 * 情感衰减（§15.1）。
 *
 * 默认使用契约分档：
 *   emotion = min(exp(-turns/5*ln2), exp(-minutes/15*ln2))；
 *   mood    = exp(-hours/6*ln2)；
 *   attitude= exp(-days/30*ln2)；intimacy 90d。
 * 若显式传入 half_life_days，则以该半衰期统一衰减 emotion/mood/attitude（便于测试/配置覆盖）。
 *
 * @param {object} state AffectState（或扁平 emotion/mood 形态）
 * @param {object} [options]
 * @param {string} [options.now]
 * @param {number} [options.half_life_days] 统一半衰期覆盖（天）
 * @param {number} [options.turns_since] 距上次更新经过的对话轮数
 * @param {object} [options.store] 提供时写 affect_history 轨迹
 * @returns {object} {ok, state, factors, history_entry, soft, hard}
 */
function decay(state, options = {}) {
  const now = options.now ?? nowIso();
  const base = normalizeState(state, {
    user_id: options.user_id,
    agent_id: options.agent_id,
    now,
  });
  const lastMs = toMs(base.updated_at) ?? toMs(now);
  const nowMs = toMs(now) ?? Date.now();
  const elapsedMs = Math.max(0, nowMs - lastMs);
  const elapsedMinutes = elapsedMs / MINUTE_MS;
  const elapsedHours = elapsedMs / 3600000;
  const elapsedDays = elapsedMs / DAY_MS;
  const overrideDays = Number(options.half_life_days);
  const hasOverride = Number.isFinite(overrideDays) && overrideDays > 0;
  const turns = Number.isFinite(Number(options.turns_since)) ? Math.max(0, Number(options.turns_since)) : null;

  const factors = {};
  if (hasOverride) {
    factors.emotion = exponentialFactor(elapsedDays, overrideDays);
    factors.mood = factors.emotion;
    factors.attitude = factors.emotion;
  } else {
    const minuteFactor = exponentialFactor(elapsedMinutes, DECAY_PROFILE.EMOTION.half_life_minutes);
    const turnFactor = exponentialFactor(turns ?? 0, DECAY_PROFILE.EMOTION.half_life_turns);
    factors.emotion = Math.min(minuteFactor, turnFactor); // §15.1 两个指数取 min
    factors.mood = exponentialFactor(elapsedHours, DECAY_PROFILE.MOOD.half_life_hours);
    factors.attitude = exponentialFactor(elapsedDays, DECAY_PROFILE.ATTITUDE.half_life_days);
  }

  const beforeEmotion = componentCore(base.current_emotion);
  const next = {
    ...base,
    current_emotion: decayComponent(base.current_emotion, factors.emotion),
    current_mood: decayComponent(base.current_mood, factors.mood),
    attitudes: base.attitudes.map((attitude) => {
      const factor = hasOverride
        ? factors.attitude
        : exponentialFactor(elapsedDays, DECAY_PROFILE.ATTITUDE.half_life_days);
      return {
        ...attitude,
        valence: clamp(attitude.valence * factor, -1, 1),
        intensity: clamp01(attitude.intensity * factor),
        // trust 属关系维度（§15.1 intimacy 90d），不在 attitude 30d 衰减内清零
      };
    }),
    updated_at: now,
  };

  const historyEntry = {
    timestamp: now,
    before: beforeEmotion,
    after: componentCore(next.current_emotion),
    trigger: options.trigger ?? null,
    delta_reason: options.delta_reason ?? (hasOverride
      ? `情感衰减（统一半衰期 ${overrideDays} 天）`
      : `情感衰减（§15.1 emotion ${DECAY_PROFILE.EMOTION.half_life_minutes}min / mood ${DECAY_PROFILE.MOOD.half_life_hours}h / attitude ${DECAY_PROFILE.ATTITUDE.half_life_days}d）`),
  };

  const soft = [];
  const hard = [];
  if (hasOverride) {
    soft.push(softNote('DECAY_HALF_LIFE_OVERRIDE', `使用调用方半衰期 ${overrideDays} 天覆盖 §15.1 默认分档`, '§15.1'));
  }
  if (elapsedMs <= 0) {
    soft.push(softNote('DECAY_NO_ELAPSED_TIME', 'now 不晚于 updated_at，本次不产生衰减', '§15.1'));
  }

  // 写 affect_history 轨迹（§17.4 history）
  let auditRef = null;
  if (options.store && elapsedMs > 0) {
    const userId = String(base.user_id ?? options.user_id ?? '');
    const agentId = String(base.agent_id ?? options.agent_id ?? '');
    if (!userId) {
      throw contractError('INVALID_PAYLOAD', 'decay 写轨迹时 user_id 必填（§17.4）');
    }
    options.store.run(
      `INSERT OR REPLACE INTO affect_history
        (user_id, agent_id, timestamp, before_json, after_json, trigger_span_id,
         delta_reason, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      agentId,
      now,
      toJson(historyEntry.before),
      toJson(historyEntry.after),
      historyEntry.trigger,
      historyEntry.delta_reason,
      AFFECT_SCHEMA_VERSION,
      now
    );
    const auditResult = safeAudit(options.store, {
      user_id: userId,
      agent_id: agentId || null,
      action: AUDIT_ACTION.AFFECT_UPDATE,
      target_type: 'affect_state',
      target_id: `${userId}|${agentId}`,
      before: { current_emotion: historyEntry.before },
      after: { current_emotion: historyEntry.after, factor: factors.emotion },
      reason: historyEntry.delta_reason,
      actor: { type: 'system', id: 'affect_decay' },
      sensitivity: SENSITIVITY.S2,
      now,
    });
    auditRef = auditResult?.audit_ref ?? null;
  }

  return {
    ok: true,
    state: next,
    factors,
    history_entry: historyEntry,
    audit_ref: auditRef,
    soft,
    hard,
  };
}

// ---------------------------------------------------------------------------
// 状态读写（§17.4）
// ---------------------------------------------------------------------------

/**
 * 写入/更新情感状态，并追加 affect_history 轨迹。
 *
 * @param {object} store getStore() 返回值
 * @param {object} params {user_id, agent_id, affect_state, now}
 * @returns {object} {ok, state, saturation, audit_ref, soft, hard}
 */
function upsertState(store, params = {}) {
  const userId = String(params.user_id ?? '');
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  const now = params.now ?? nowIso();
  if (!userId) throw contractError('INVALID_PAYLOAD', 'upsertState: user_id 必填（§17.4）');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'upsertState: agent_id 必填（§17.4）');
  if (!isPlainObject(params.affect_state)) {
    throw contractError('INVALID_PAYLOAD', 'upsertState: affect_state 必填（§17.4）');
  }

  const previous = getState(store, { user_id: userId, agent_id: agentId });
  const prevState = previous.state;
  const incoming = normalizeState(params.affect_state, { user_id: userId, agent_id: agentId, now });
  incoming.updated_at = now;
  const saturated = saturate(prevState, incoming, { now });
  const state = saturated.state;
  state.user_id = userId;
  state.agent_id = agentId;
  state.updated_at = now;

  store.run(
    `INSERT INTO affect_state
      (user_id, agent_id, current_emotion_json, current_mood_json, attitudes_json,
       updated_at, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, agent_id) DO UPDATE SET
       current_emotion_json = excluded.current_emotion_json,
       current_mood_json = excluded.current_mood_json,
       attitudes_json = excluded.attitudes_json,
       updated_at = excluded.updated_at,
       schema_version = excluded.schema_version`,
    userId,
    agentId,
    toJson(state.current_emotion),
    toJson(state.current_mood),
    toJson(state.attitudes),
    now,
    AFFECT_SCHEMA_VERSION,
    now
  );

  const before = prevState ? componentCore(normalizeState(prevState, { now }).current_emotion) : null;
  const after = componentCore(state.current_emotion);
  const changed = !before || JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    store.run(
      `INSERT OR REPLACE INTO affect_history
        (user_id, agent_id, timestamp, before_json, after_json, trigger_span_id,
         delta_reason, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      agentId,
      now,
      toJson(before),
      toJson(after),
      params.trigger ?? null,
      params.delta_reason ?? '情感状态更新（§17.4）',
      AFFECT_SCHEMA_VERSION,
      now
    );
  }

  const soft = [...saturated.soft];
  const hard = [...saturated.hard];
  if (changed) {
    soft.push(softNote('AFFECT_STATE_UPDATED', '写 affect_state 并追加 affect_history', '§17.4'));
  }

  const auditResult = safeAudit(store, {
    user_id: userId,
    agent_id: agentId,
    action: AUDIT_ACTION.AFFECT_UPDATE,
    target_type: 'affect_state',
    target_id: `${userId}|${agentId}`,
    before: before ? { current_emotion: before } : null,
    after: { current_emotion: after },
    reason: params.delta_reason ?? '情感状态更新（§17.4）',
    actor: params.actor ?? { type: 'agent', id: agentId },
    sensitivity: SENSITIVITY.S2,
    now,
  });

  return {
    ok: true,
    state,
    saturation: saturated.saturation,
    audit_ref: auditResult?.audit_ref ?? null,
    soft,
    hard,
  };
}

/**
 * 读取情感状态（§17.4），附带最近 history。
 *
 * @param {object} store
 * @param {{user_id:string, agent_id:string, history_limit?:number}} params
 * @returns {{ok:boolean, state:object|null, soft:Array, hard:Array}}
 */
function getState(store, params = {}) {
  const userId = String(params.user_id ?? '');
  const agentId = String(params.agent_id ?? store?.agentId ?? '');
  if (!userId) throw contractError('INVALID_PAYLOAD', 'getState: user_id 必填（§17.4）');
  if (!agentId) throw contractError('INVALID_PAYLOAD', 'getState: agent_id 必填（§17.4）');

  const row = store.get(
    `SELECT user_id, agent_id, current_emotion_json, current_mood_json,
            attitudes_json, updated_at, schema_version, created_at
       FROM affect_state WHERE user_id = ? AND agent_id = ?`,
    userId,
    agentId
  );
  if (!row) {
    return { ok: true, state: null, soft: [softNote('AFFECT_STATE_EMPTY', '尚无情感状态记录', '§17.4')], hard: [] };
  }

  const limit = Math.max(1, Math.min(200, Number(params.history_limit) || 20));
  const history = store.all(
    `SELECT timestamp, before_json, after_json, trigger_span_id, delta_reason
       FROM affect_history WHERE user_id = ? AND agent_id = ?
      ORDER BY timestamp DESC LIMIT ?`,
    userId,
    agentId,
    limit
  ).map((entry) => ({
    timestamp: entry.timestamp,
    before: parseJson(entry.before_json, null),
    after: parseJson(entry.after_json, null),
    trigger: entry.trigger_span_id ?? null,
    delta_reason: entry.delta_reason ?? null,
  })).reverse();

  return {
    ok: true,
    state: {
      schema_version: row.schema_version ?? AFFECT_SCHEMA_VERSION,
      user_id: row.user_id,
      agent_id: row.agent_id,
      current_emotion: parseJson(row.current_emotion_json, normalizeComponent({})),
      current_mood: parseJson(row.current_mood_json, normalizeComponent({}, '轻松')),
      attitudes: parseJson(row.attitudes_json, []),
      updated_at: row.updated_at,
      history,
    },
    soft: [],
    hard: [],
  };
}

/** 供召回/组装读取的便捷快照（不含历史）。 */
function snapshot(store, params = {}) {
  const result = getState(store, { ...params, history_limit: 1 });
  return result.state ?? null;
}

module.exports = {
  AFFECT_SCHEMA_VERSION,
  AFFECT_RECOGNITION_SCHEMA_VERSION,
  DECAY_PROFILE,
  AFFECT_CEILING,
  SAME_DIRECTION_MARGINAL_DECAY,
  COOLING_PERIOD_MINUTES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  MANIPULATION_PATTERNS,
  normalizeState,
  normalizeComponent,
  upsertState,
  getState,
  snapshot,
  decay,
  recognize,
  checkHardConstraints,
  saturate,
};
