'use strict';

/**
 * 多模态记忆（File Entity + D0-D3 Dossier + 媒体检索）
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §13   parse_status：success | partial_success | failed | skipped；
 *           degraded_reasons 枚举；D0-D3 四层粒度与生成规则；File Entity / Dossier meta 字段；
 *           schema_version=dossier.v4.1。
 *   - §16.2 search_raw 的权限、redact_level、不缓存；
 *   - §16.3 S3 默认拒绝（recall/fetch/search_raw），所有 S3 访问写审计；
 *   - §17.11 MediaSearchResult（命中片段 / 时间戳 / evidence_refs / why_recalled_code）；
 *   - §17.1 EvidenceSpan（D3 复用 memory_evidence_span.span_id）；
 *   - §17.2 DerivedEdge（D0 -> D1 -> D2 -> D3 证据闭环）。
 *
 * 设计约束：
 *   - 本机不跑本地模型：ASR/OCR/VLM 全部通过依赖注入的适配器调用，本文件不 require 后端路由、
 *     不发起任何网络请求。
 *   - 适配器签名（均为 async 函数，入参是文件描述符）：
 *       asr(input) -> { text, segments:[{start,end,text,speaker}], language, duration, model }
 *       ocr(input) -> { text, regions:[{bbox,text,page_no}], language, model }
 *       vlm(input) -> { caption, description, entities[], emotion{}, frames:[{t_start,t_end,caption,description,entities,emotion}], regions[], model }
 *     input = { file_id, file_name, path, container_path, mime, media_type, size, virtual_path, prompt }
 *     其中 path/container_path 只来自本进程 registerFile 的登记，绝不写库、绝不进入返回结果。
 *   - 任一适配器失败都不抛错：parse_status 降级为 partial_success / failed，并返回 degraded_reasons。
 *
 * 契约歧义与取舍：
 *   1) parse_status 只有 success|partial_success|failed|skipped，没有 pending/parsing/ready；
 *      登记后未解析记 skipped（契约外状态不写入库）。
 *   2) file_entity 无 path 列；宿主机路径只保存在服务实例内存中，用于调用适配器，
 *      对外一律输出相对虚拟路径 media/<basename>（§16.2 脱敏要求）。
 *   3) search 返回 { hits:[MediaSearchResult...], blocked_count, ... }；
 *      每个 hit 严格满足 §17.11 MediaSearchResult 字段，另附脱敏后的 virtual media_ref。
 *   4) D3 证据同时写 dossier_d3 与 memory_evidence_span，两表共用 span_id（§13/附录 A）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  SCHEMA_VERSION,
  SENSITIVITY,
  PARSE_STATUS,
  QUALITY_FLAG,
  AUDIT_ACTION,
} = require('./constants');
const { parseJson, toJson } = require('./store');
const embeddingLib = require('./embedding');
const audit = require('./audit');
const write = require('./write');
const retrieval = require('./retrieval');

// §13：Dossier schema_version
const DOSSIER_SCHEMA_VERSION = 'dossier.v4.1';
// §17.1 EvidenceSpan schema_version
const EVIDENCE_SPAN_SCHEMA_VERSION = 'evidence_span.v4.1';
// §17.2 DerivedEdge schema_version
const DERIVED_EDGE_SCHEMA_VERSION = 'derived_edge.v4.1';
// §17.11 MediaSearchResult schema_version
const MEDIA_SEARCH_SCHEMA_VERSION = 'media_search_result.v4.1';

// §13 degraded_reasons 契约枚举（不得自创）
const DEGRADED_REASON = Object.freeze({
  ASR_FAILED: 'asr_failed',
  OCR_FAILED: 'ocr_failed',
  VISION_FAILED: 'vision_failed',
  DIARIZATION_FAILED: 'diarization_failed',
  AFFECT_FAILED: 'affect_failed',
  D0_FAILED: 'd0_failed',
  DOCUMENT_PARSE_FAILED: 'document_parse_failed',
  MEDIA_CORRUPT: 'media_corrupt',
});
const DEGRADED_REASON_SET = new Set(Object.values(DEGRADED_REASON));
const PARSE_STATUS_SET = new Set(Object.values(PARSE_STATUS));

const DEFAULT_SENSITIVITY = SENSITIVITY.S1;
// §16.2/§16.3：调用者默认最高敏感级为 S2，S3 默认拒绝
const DEFAULT_SENSITIVITY_MAX = SENSITIVITY.S2;
const DEFAULT_TOP_K = 5;
const DEFAULT_VECTOR_DIM = 1024;
// §13：D1 章节由相邻 3-12 个 D2 片段聚合；此处取 6 作为默认窗口
const SECTION_SIZE = 6;

const MEDIA_TYPE = Object.freeze({
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  DOCUMENT: 'document',
  OTHER: 'other',
});

const VLM_PROMPT = [
  '请分析这份媒体内容，输出 JSON：',
  '{"caption":"一句话概括","description":"视觉细节","entities":["实体"],',
  '"emotion":{"valence":0,"arousal":0,"label":"","intensity":0},',
  '"frames":[{"t_start":0,"t_end":10,"caption":"","description":"","entities":[]}]}。',
  '视频请按 5-15 秒窗口给出关键帧描述与时间戳；图片忽略 frames。不要编造不存在的内容。',
].join('\n');

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function hashRef(prefix, parts) {
  return `${prefix}${sha256Hex(parts.join('|')).slice(0, 24)}`;
}

function nowIso(value) {
  if (value === null || value === undefined || value === '') return new Date().toISOString();
  return String(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined);
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values)) {
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truncate(value, max) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function baseName(name) {
  const raw = String(name ?? '').trim();
  if (raw === '') return 'media';
  return path.basename(raw.replace(/\\/g, '/'));
}

function fileStem(name) {
  const base = baseName(name);
  const ext = path.extname(base);
  return ext ? base.slice(0, base.length - ext.length) : base;
}

/**
 * §16.2：只输出相对/虚拟路径，绝不泄露宿主机路径或绝对位置。
 * 统一口径：media/<basename>。
 */
function virtualPathOf(fileName) {
  return `media/${baseName(fileName)}`;
}

function normalizeSensitivity(value, fallback = DEFAULT_SENSITIVITY) {
  const text = String(value ?? '').trim().toUpperCase();
  return Object.values(SENSITIVITY).includes(text) ? text : fallback;
}

function sensitivityRank(value) {
  const text = String(value ?? '').trim().toUpperCase();
  const index = [SENSITIVITY.S0, SENSITIVITY.S1, SENSITIVITY.S2, SENSITIVITY.S3].indexOf(text);
  return index >= 0 ? index : 1;
}

function normalizeSensitivityMax(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return Object.values(SENSITIVITY).includes(text) ? text : DEFAULT_SENSITIVITY_MAX;
}

function insertRow(store, table, row) {
  const keys = Object.keys(row);
  const values = keys.map((key) => (row[key] === undefined ? null : row[key]));
  store.run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...values
  );
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function deleteWhereIn(store, table, column, ids) {
  const list = uniqueStrings(ids);
  for (let index = 0; index < list.length; index += 400) {
    const chunk = list.slice(index, index + 400);
    store.run(
      `DELETE FROM ${table} WHERE ${column} IN (${placeholders(chunk.length)})`,
      ...chunk
    );
  }
}

function safeAudit(store, params) {
  try {
    return audit.append(store, params);
  } catch (error) {
    // 审计失败不影响主流程；也不向调用方抛错
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// 时间与坐标
// ---------------------------------------------------------------------------

/** 支持秒数、"03:15"、"00:03:15"；无法解析返回 null。 */
function parseClock(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    if (match[3] === undefined) {
      return Number(match[1]) * 60 + Number(match[2]);
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

/** 秒数 -> 契约示例风格 HH:MM:SS；null 保持 null。 */
function formatClock(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  const total = Math.floor(value);
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const secs = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${secs}`;
}

function normalizeBbox(value) {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, width, height] = value.map(Number);
    if ([x, y, width, height].every(Number.isFinite)) return { x, y, width, height };
    return null;
  }
  if (!isPlainObject(value)) return null;
  const x = Number(value.x ?? value.left ?? 0);
  const y = Number(value.y ?? value.top ?? 0);
  const width = Number(value.width ?? value.w ?? (Number(value.x2) - x));
  const height = Number(value.height ?? value.h ?? (Number(value.y2) - y));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function normalizeEmotion(value) {
  if (!isPlainObject(value)) return null;
  const emotion = {
    valence: clamp(value.valence, -1, 1),
    arousal: clamp(value.arousal, 0, 1),
    dominance: clamp(value.dominance, 0, 1),
    label: value.label === undefined || value.label === null ? null : String(value.label),
    intensity: clamp(value.intensity, 0, 1),
  };
  const hasNumber = [emotion.valence, emotion.arousal, emotion.dominance, emotion.intensity]
    .some((entry) => entry !== null);
  if (!hasNumber && !emotion.label) return null;
  return emotion;
}

function mergeEmotion(list) {
  const items = list.filter(Boolean);
  if (items.length === 0) return null;
  const average = (key) => {
    const numbers = items.map((item) => item[key]).filter((entry) => typeof entry === 'number');
    if (numbers.length === 0) return null;
    return numbers.reduce((sum, entry) => sum + entry, 0) / numbers.length;
  };
  const labels = items.map((item) => item.label).filter(Boolean);
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let label = null;
  let best = 0;
  for (const [key, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > best) {
      best = count;
      label = key;
    }
  }
  return {
    valence: average('valence'),
    arousal: average('arousal'),
    dominance: average('dominance'),
    label,
    intensity: average('intensity'),
  };
}

function entityNames(value) {
  return uniqueStrings(asArray(value).map((entry) => {
    if (isPlainObject(entry)) return entry.name ?? entry.label ?? entry.id ?? null;
    return entry;
  }));
}

// ---------------------------------------------------------------------------
// 媒体类型与登记
// ---------------------------------------------------------------------------

const EXT_TYPE = Object.freeze({
  '.png': MEDIA_TYPE.IMAGE,
  '.jpg': MEDIA_TYPE.IMAGE,
  '.jpeg': MEDIA_TYPE.IMAGE,
  '.gif': MEDIA_TYPE.IMAGE,
  '.webp': MEDIA_TYPE.IMAGE,
  '.bmp': MEDIA_TYPE.IMAGE,
  '.mp3': MEDIA_TYPE.AUDIO,
  '.wav': MEDIA_TYPE.AUDIO,
  '.m4a': MEDIA_TYPE.AUDIO,
  '.aac': MEDIA_TYPE.AUDIO,
  '.flac': MEDIA_TYPE.AUDIO,
  '.ogg': MEDIA_TYPE.AUDIO,
  '.mp4': MEDIA_TYPE.VIDEO,
  '.mov': MEDIA_TYPE.VIDEO,
  '.mkv': MEDIA_TYPE.VIDEO,
  '.webm': MEDIA_TYPE.VIDEO,
  '.avi': MEDIA_TYPE.VIDEO,
  '.pdf': MEDIA_TYPE.DOCUMENT,
  '.doc': MEDIA_TYPE.DOCUMENT,
  '.docx': MEDIA_TYPE.DOCUMENT,
  '.txt': MEDIA_TYPE.DOCUMENT,
  '.md': MEDIA_TYPE.DOCUMENT,
});

/** 由 MIME 与扩展名推断 media_type。 */
function inferMediaType(mime, fileName) {
  const declared = String(mime ?? '').trim().toLowerCase();
  if (declared.startsWith('image/')) return MEDIA_TYPE.IMAGE;
  if (declared.startsWith('audio/')) return MEDIA_TYPE.AUDIO;
  if (declared.startsWith('video/')) return MEDIA_TYPE.VIDEO;
  if (
    declared.startsWith('text/')
    || declared.includes('pdf')
    || declared.includes('word')
    || declared.includes('officedocument')
    || declared.includes('json')
    || declared.includes('xml')
  ) {
    return MEDIA_TYPE.DOCUMENT;
  }
  const ext = path.extname(baseName(fileName)).toLowerCase();
  return EXT_TYPE[ext] ?? MEDIA_TYPE.OTHER;
}

function hashFileDescriptor(file, now) {
  const explicit = String(file?.hash ?? '').trim();
  if (explicit !== '') return explicit.startsWith('sha256:') ? explicit : `sha256:${explicit}`;
  const hostPath = String(file?.path ?? '').trim();
  if (hostPath !== '') {
    try {
      const stat = fs.statSync(hostPath);
      return `sha256:${sha256Hex([hostPath, stat.size, stat.mtimeMs, baseName(hostPath)].join('|'))}`;
    } catch {
      // 落到下面的元信息哈希
    }
  }
  return `sha256:${sha256Hex([
    baseName(file?.file_name ?? file?.name),
    String(file?.mime ?? ''),
    String(file?.size ?? ''),
    now,
  ].join('|'))}`;
}

function sizeOfFile(file) {
  const declared = Number(file?.size);
  if (Number.isFinite(declared) && declared >= 0) return Math.floor(declared);
  const hostPath = String(file?.path ?? '').trim();
  if (hostPath !== '') {
    try {
      return fs.statSync(hostPath).size;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 适配器调用（失败不抛错）
// ---------------------------------------------------------------------------

async function callAdapter(adapter, input) {
  if (typeof adapter !== 'function') {
    return { attempted: false, ok: false, data: null, reason: 'adapter_missing' };
  }
  try {
    const data = await adapter(input);
    if (!isPlainObject(data)) {
      return { attempted: true, ok: false, data: null, reason: 'empty_result' };
    }
    return { attempted: true, ok: true, data, reason: null };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      data: null,
      reason: String(error?.code ?? error?.message ?? 'adapter_failed'),
    };
  }
}

// ---------------------------------------------------------------------------
// D2 片段构建（§13 生成规则）
// ---------------------------------------------------------------------------

function splitSentences(text) {
  const normalized = String(text ?? '').trim();
  if (normalized === '') return [];
  const parts = normalized
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [normalized];
}

/** ASR 结果归一化为带时间窗的片段；无 segments 时按句/字符比例切 5-15 秒窗口。 */
function asrSegments(asr, duration) {
  if (!asr) return [];
  const provided = asArray(asr.segments)
    .map((segment, index) => {
      if (!isPlainObject(segment)) return null;
      const start = parseClock(segment.start ?? segment.t_start ?? segment.begin);
      const end = parseClock(segment.end ?? segment.t_end ?? segment.stop);
      const text = String(segment.text ?? segment.asr_text ?? '').trim();
      if (text === '') return null;
      return {
        index,
        tStart: start === null ? null : Math.max(0, start),
        tEnd: end === null ? null : Math.max(0, end),
        text,
        speaker: segment.speaker === undefined ? null : String(segment.speaker),
        emotion: normalizeEmotion(segment.emotion),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.tStart ?? 0) - (b.tStart ?? 0) || a.index - b.index);

  if (provided.length > 0) {
    return provided.map((segment, index) => {
      const next = provided[index + 1];
      const start = segment.tStart ?? 0;
      let end = segment.tEnd;
      if (end === null || end <= start) {
        end = next?.tStart !== null && next?.tStart !== undefined && next.tStart > start
          ? next.tStart
          : start + 10;
      }
      return {
        t_start_sec: start,
        t_end_sec: Math.max(start + 1, end),
        asr_text: segment.text,
        speaker: segment.speaker,
        emotion: segment.emotion || null,
      };
    });
  }

  const text = String(asr.text ?? '').trim();
  if (text === '') return [];
  const sentences = splitSentences(text);
  const totalDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
    ? Number(duration)
    : Math.max(10, sentences.length * 10);
  const totalChars = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
  let cursor = 0;
  return sentences.map((sentence, index) => {
    const span = Math.max(1, (sentence.length / totalChars) * totalDuration);
    const start = cursor;
    cursor += span;
    // §13：视频 5-15 秒窗口；音频按句（VAD），此处统一按时间比例近似
    const end = index === sentences.length - 1 ? totalDuration : cursor;
    return {
      t_start_sec: Math.round(start * 100) / 100,
      t_end_sec: Math.round(Math.max(start + 1, end) * 100) / 100,
      asr_text: sentence,
      speaker: null,
      emotion: null,
    };
  });
}

function vlmFramesOf(vlm) {
  if (!vlm) return [];
  const raw = asArray(vlm.frames).length > 0 ? asArray(vlm.frames) : asArray(vlm.scenes);
  return raw
    .map((frame, index) => {
      if (!isPlainObject(frame)) return null;
      const start = parseClock(frame.t_start ?? frame.start ?? frame.time);
      const end = parseClock(frame.t_end ?? frame.end);
      const caption = String(frame.caption ?? '').trim();
      const description = String(frame.description ?? frame.visual_desc ?? '').trim();
      if (caption === '' && description === '') return null;
      return {
        index,
        tStart: start === null ? index * 10 : Math.max(0, start),
        tEnd: end === null ? null : Math.max(0, end),
        caption,
        visual_desc: description,
        entities: entityNames(frame.entities),
        emotion: normalizeEmotion(frame.emotion),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.tStart - b.tStart || a.index - b.index);
}

function buildTimeBasedSegments({ asr, vlm, duration }) {
  const spoken = asrSegments(asr, duration);
  const frames = vlmFramesOf(vlm);
  const segments = [];
  const usedFrames = new Set();

  for (const item of spoken) {
    segments.push({
      t_start_sec: item.t_start_sec,
      t_end_sec: item.t_end_sec,
      asr_text: item.asr_text,
      speaker: item.speaker,
      emotion: item.emotion,
      caption: '',
      visual_desc: '',
      entities: [],
      bbox: null,
      page_no: null,
      region: false,
    });
  }

  for (const frame of frames) {
    // §13：按真实重叠长度选择归属片段（避免相邻边界 8s 处同时命中前一段）
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const overlapStart = Math.max(frame.tStart, segment.t_start_sec);
      const overlapEnd = Math.min(
        frame.tEnd === null || frame.tEnd === undefined ? segment.t_end_sec : frame.tEnd,
        segment.t_end_sec
      );
      const overlap = overlapEnd - overlapStart;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      const segment = segments[bestIndex];
      segment.caption = segment.caption || frame.caption;
      segment.visual_desc = segment.visual_desc || frame.visual_desc;
      segment.entities = uniqueStrings([...segment.entities, ...frame.entities]);
      segment.emotion = segment.emotion || frame.emotion;
      usedFrames.add(frame.index);
    }
  }

  for (const frame of frames) {
    if (usedFrames.has(frame.index)) continue;
    segments.push({
      t_start_sec: frame.tStart,
      t_end_sec: frame.tEnd ?? frame.tStart + 10,
      asr_text: '',
      speaker: null,
      emotion: frame.emotion,
      caption: frame.caption,
      visual_desc: frame.visual_desc,
      entities: frame.entities,
      bbox: null,
      page_no: null,
      region: false,
    });
  }

  // VLM 只有整体描述（无关键帧）时，挂到第一条片段或单独成段
  const globalCaption = String(vlm?.caption ?? '').trim();
  const globalDescription = String(vlm?.description ?? vlm?.visual_desc ?? '').trim();
  if (frames.length === 0 && (globalCaption !== '' || globalDescription !== '')) {
    if (segments.length > 0) {
      segments[0].caption = segments[0].caption || globalCaption;
      segments[0].visual_desc = segments[0].visual_desc || globalDescription;
      segments[0].entities = uniqueStrings([...segments[0].entities, ...entityNames(vlm?.entities)]);
      segments[0].emotion = segments[0].emotion || normalizeEmotion(vlm?.emotion);
    } else {
      segments.push({
        t_start_sec: 0,
        t_end_sec: Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : 15,
        asr_text: '',
        speaker: null,
        emotion: normalizeEmotion(vlm?.emotion),
        caption: globalCaption,
        visual_desc: globalDescription,
        entities: entityNames(vlm?.entities),
        bbox: null,
        page_no: null,
        region: false,
      });
    }
  }

  return segments;
}

function buildRegionSegments(regions, text) {
  const normalized = asArray(regions)
    .map((region, index) => {
      if (!isPlainObject(region)) return null;
      const content = String(region.text ?? region.content ?? '').trim();
      const caption = String(region.caption ?? '').trim();
      const description = String(region.description ?? '').trim();
      if (content === '' && caption === '' && description === '') return null;
      return {
        index,
        ocr_text: content,
        caption,
        visual_desc: description,
        entities: entityNames(region.entities),
        emotion: normalizeEmotion(region.emotion),
        bbox: normalizeBbox(region.bbox ?? region.box ?? region.rect),
        page_no: Number.isFinite(Number(region.page_no)) ? Number(region.page_no) : 1,
        region: true,
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) return normalized;
  const plain = String(text ?? '').trim();
  if (plain === '') return [];
  return [{
    index: 0,
    ocr_text: plain,
    caption: '',
    visual_desc: '',
    entities: [],
    emotion: null,
    bbox: null,
    page_no: 1,
    region: false,
  }];
}

function buildImageSegments({ ocr, vlm }) {
  const segments = [];
  const ocrRegions = buildRegionSegments(ocr?.regions, ocr?.text);
  for (const region of ocrRegions) {
    segments.push({
      t_start_sec: 0,
      t_end_sec: 0,
      asr_text: '',
      speaker: null,
      emotion: region.emotion,
      caption: region.caption,
      visual_desc: region.visual_desc,
      ocr_text: region.ocr_text,
      entities: region.entities,
      bbox: region.bbox,
      page_no: region.page_no,
      region: region.region,
    });
  }

  if (vlm) {
    const visionRegions = buildRegionSegments(vlm.regions, '');
    if (visionRegions.length > 0) {
      for (const region of visionRegions) {
        segments.push({
          t_start_sec: 0,
          t_end_sec: 0,
          asr_text: '',
          speaker: null,
          emotion: region.emotion,
          caption: region.caption,
          visual_desc: region.visual_desc,
          ocr_text: region.ocr_text,
          entities: region.entities,
          bbox: region.bbox,
          page_no: region.page_no,
          region: region.region,
        });
      }
    } else {
      const caption = String(vlm.caption ?? '').trim();
      const description = String(vlm.description ?? vlm.visual_desc ?? '').trim();
      if (caption !== '' || description !== '') {
        segments.push({
          t_start_sec: 0,
          t_end_sec: 0,
          asr_text: '',
          speaker: null,
          emotion: normalizeEmotion(vlm.emotion),
          caption,
          visual_desc: description,
          ocr_text: '',
          entities: entityNames(vlm.entities),
          bbox: null,
          page_no: 1,
          region: false,
        });
      }
    }
  }

  return segments;
}

function buildDocumentSegments({ ocr, vlm }) {
  const segments = [];
  const regions = buildRegionSegments(ocr?.regions, ocr?.text);
  for (const region of regions) {
    segments.push({
      t_start_sec: 0,
      t_end_sec: 0,
      asr_text: '',
      speaker: null,
      emotion: region.emotion,
      caption: region.caption,
      visual_desc: region.visual_desc,
      ocr_text: region.ocr_text,
      entities: region.entities,
      bbox: region.bbox,
      page_no: region.page_no,
      region: region.region,
    });
  }
  if (segments.length === 0 && vlm) {
    const caption = String(vlm.caption ?? '').trim();
    const description = String(vlm.description ?? '').trim();
    if (caption !== '' || description !== '') {
      segments.push({
        t_start_sec: 0,
        t_end_sec: 0,
        asr_text: '',
        speaker: null,
        emotion: normalizeEmotion(vlm.emotion),
        caption,
        visual_desc: description,
        ocr_text: '',
        entities: entityNames(vlm.entities),
        bbox: null,
        page_no: 1,
        region: false,
      });
    }
  }
  return segments;
}

function buildSegments({ mediaType, asr, ocr, vlm, duration }) {
  if (mediaType === MEDIA_TYPE.AUDIO || mediaType === MEDIA_TYPE.VIDEO) {
    return buildTimeBasedSegments({ asr, vlm: mediaType === MEDIA_TYPE.VIDEO ? vlm : null, duration });
  }
  if (mediaType === MEDIA_TYPE.IMAGE) return buildImageSegments({ ocr, vlm });
  if (mediaType === MEDIA_TYPE.DOCUMENT) return buildDocumentSegments({ ocr, vlm: null });
  return buildRegionSegments(ocr?.regions, ocr?.text);
}

// ---------------------------------------------------------------------------
// D1 / D0 聚合（§13）
// ---------------------------------------------------------------------------

function segmentDisplayText(segment) {
  return truncate(
    [segment.caption, segment.visual_desc, segment.asr_text, segment.ocr_text]
      .filter((entry) => entry && String(entry).trim() !== '')
      .join('；'),
    400
  );
}

function buildSections(segments, fileId, now) {
  const sections = [];
  for (let start = 0; start < segments.length; start += SECTION_SIZE) {
    const group = segments.slice(start, start + SECTION_SIZE);
    const index = sections.length;
    const secId = hashRef('sec_', ['media_sec', fileId, index]);
    const texts = group.map(segmentDisplayText).filter(Boolean);
    const first = texts[0] ?? '';
    const title = truncate(first, 40) || `第 ${index + 1} 章节`;
    const summary = truncate(texts.join('；'), 500);
    const keyPoints = uniqueStrings(group.map((segment) => truncate(
      segment.caption || segment.asr_text || segment.ocr_text || segment.visual_desc,
      80
    ))).slice(0, 3);
    const speakers = uniqueStrings(group.map((segment) => segment.speaker).filter(Boolean));
    const entities = uniqueStrings(group.flatMap((segment) => segment.entities));
    const affectTag = mergeEmotion(group.map((segment) => segment.emotion));
    sections.push({
      sec_id: secId,
      index,
      title,
      summary,
      key_points: keyPoints,
      speakers,
      entities,
      affect_tag: affectTag,
      seg_refs: group.map((segment) => segment.seg_id),
      segments: group,
      created_at: now,
    });
  }
  return sections;
}

function buildD0({ file, title, sections, degradedReasons, parseStatus }) {
  const sectionTexts = sections.map((section) => section.summary).filter(Boolean);
  const firstText = sectionTexts[0] ?? '';
  const entities = uniqueStrings(sections.flatMap((section) => section.entities));
  const speakers = uniqueStrings(sections.flatMap((section) => section.speakers));
  const topics = uniqueStrings([...entities.slice(0, 8), file.media_type]);
  const keyEntities = uniqueStrings([...entities, ...speakers]).slice(0, 20);

  if (sectionTexts.length === 0) {
    const reasonText = degradedReasons.length > 0 ? `（降级原因：${degradedReasons.join(', ')}）` : '';
    return {
      title,
      summary_1line: truncate(`${title}：未解析到可用媒体内容${reasonText}`, 120),
      summary_para: truncate(
        `文件 ${virtualPathOf(file.file_name)}（${file.media_type}）未能解析出片段${reasonText}；仅保留文件级元信息。`,
        700
      ),
      topics,
      key_entities: keyEntities,
    };
  }

  return {
    title,
    summary_1line: truncate(`${title}：${firstText}`, 120),
    summary_para: truncate(sectionTexts.join('；'), 1200),
    topics,
    key_entities: keyEntities,
  };
}

// ---------------------------------------------------------------------------
// 证据 Span / D3（§17.1 + §13）
// ---------------------------------------------------------------------------

function spanForSegment({ file, segment, sourceType, text, virtualPath, sensitivity, now, memId, index }) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const spanId = hashRef('span_', [
    'media_span',
    file.file_id,
    segment.seg_id,
    sourceType,
    index,
  ]);
  const tStamp = segment.t_start_sec === null || segment.t_start_sec === undefined
    ? null
    : formatClock(segment.t_start_sec);
  return {
    span_id: spanId,
    user_id: String(file.user_id),
    agent_id: file.agent_id ?? null,
    mem_id: memId,
    source_type: sourceType,
    source_id: String(file.file_id),
    source_turn_id: null,
    raw_text: raw,
    text_excerpt: truncate(raw, 200),
    start_offset: null,
    end_offset: null,
    media_ref: virtualPath,
    t_stamp: tStamp,
    page_no: segment.page_no ?? null,
    bbox_json: segment.bbox ? toJson(segment.bbox) : null,
    language: null,
    sensitivity,
    content_hash: `sha256:${sha256Hex(raw)}`,
    ref_count: 0,
    deletion_state: 'active',
    audit_ref: null,
    schema_version: EVIDENCE_SPAN_SCHEMA_VERSION,
    created_at: now,
  };
}

function buildSegmentSpans({ file, segment, virtualPath, sensitivity, now, memId }) {
  const spans = [];
  if (segment.asr_text) {
    const span = spanForSegment({
      file,
      segment,
      sourceType: 'file_asr',
      text: segment.asr_text,
      virtualPath,
      sensitivity,
      now,
      memId,
      index: 0,
    });
    if (span) spans.push(span);
  }
  if (segment.ocr_text) {
    const span = spanForSegment({
      file,
      segment,
      sourceType: segment.bbox ? 'file_region' : 'file_ocr',
      text: segment.ocr_text,
      virtualPath,
      sensitivity,
      now,
      memId,
      index: 1,
    });
    if (span) spans.push(span);
  }
  if (segment.caption || segment.visual_desc) {
    const span = spanForSegment({
      file,
      segment,
      sourceType: segment.bbox ? 'file_region' : 'file_frame',
      text: [segment.caption, segment.visual_desc].filter(Boolean).join('；'),
      virtualPath,
      sensitivity,
      now,
      memId,
      index: 2,
    });
    if (span) spans.push(span);
  }
  return spans;
}

function insertEvidenceSpan(store, span) {
  insertRow(store, 'memory_evidence_span', span);
}

// ---------------------------------------------------------------------------
// 索引同步（§17 三级向量 + 全文）
// ---------------------------------------------------------------------------

function vectorRowForSegment({ vecId, segId, fileId, userId, tenantId, orgId, text, now }) {
  const vector = embeddingLib.hashEmbedding(text, DEFAULT_VECTOR_DIM);
  return {
    vec_id: vecId,
    seg_id: segId,
    mem_id: null,
    file_id: fileId,
    user_id: String(userId),
    tenant_id: tenantId ?? null,
    org_id: orgId ?? null,
    vector_json: toJson(vector),
    dim: DEFAULT_VECTOR_DIM,
    model: 'hashEmbedding',
    vector_ns: String(userId),
    acl_version: 1,
    created_at: now,
  };
}

function insertFulltext(store, {
  userId,
  tenantId,
  orgId,
  objectType,
  objectId,
  sourceType,
  text,
  now,
}) {
  const content = String(text ?? '').trim();
  if (content === '') return;
  insertRow(store, 'memory_fulltext_index', {
    index_id: `ft_media_${sha256Hex([objectType, objectId, content.slice(0, 32)].join('|')).slice(0, 24)}`,
    user_id: String(userId),
    tenant_id: tenantId ?? null,
    org_id: orgId ?? null,
    object_type: objectType,
    object_id: String(objectId),
    source_type: sourceType ?? null,
    text_content: content,
    language: null,
    created_at: now,
  });
}

function insertDerivedEdge(store, {
  userId,
  fromType,
  fromId,
  toType,
  toId,
  relation,
  now,
  runId,
}) {
  insertRow(store, 'memory_derived_edge', {
    edge_id: hashRef('edge_', ['media_edge', fromType, fromId, toType, toId, relation]),
    user_id: String(userId),
    from_type: fromType,
    from_id: String(fromId),
    to_type: toType,
    to_id: String(toId),
    relation,
    provenance_json: toJson({ pipeline: 'media_dossier', run_id: runId }),
    deletion_state: 'active',
    schema_version: DERIVED_EDGE_SCHEMA_VERSION,
    created_at: now,
  });
}

// ---------------------------------------------------------------------------
// 清理旧派生数据（重建 Dossier 用）
// ---------------------------------------------------------------------------

function clearDerived(store, { fileId, memId }) {
  const oldSpans = store.all(
    'SELECT span_id FROM memory_evidence_span WHERE mem_id = ? AND source_id = ?',
    memId,
    fileId
  ).map((row) => row.span_id);
  const oldSections = store.all('SELECT sec_id FROM dossier_d1 WHERE file_id = ?', fileId)
    .map((row) => row.sec_id);
  const oldSegments = store.all('SELECT seg_id FROM dossier_d2 WHERE file_id = ?', fileId)
    .map((row) => row.seg_id);

  store.run('DELETE FROM dossier_d3 WHERE file_id = ?', fileId);
  store.run('DELETE FROM dossier_d2 WHERE file_id = ?', fileId);
  store.run('DELETE FROM dossier_d1 WHERE file_id = ?', fileId);
  store.run('DELETE FROM dossier_d0 WHERE file_id = ?', fileId);

  for (const table of [
    'memory_vector_index_item',
    'memory_vector_index_segment',
    'memory_vector_index_fragment',
  ]) {
    store.run(`DELETE FROM ${table} WHERE mem_id = ?`, memId);
  }

  store.run(
    'DELETE FROM memory_evidence_span WHERE mem_id = ? AND source_id = ?',
    memId,
    fileId
  );
  store.run('DELETE FROM memory_item WHERE mem_id = ?', memId);
  store.run('DELETE FROM memory_version_chain WHERE mem_id = ?', memId);

  store.run(
    `DELETE FROM memory_fulltext_index
      WHERE (object_type = 'memory_item' AND object_id = ?)
         OR (object_type = 'evidence_span' AND object_id IN (${placeholders(Math.max(1, oldSpans.length))}))`,
    memId,
    ...(oldSpans.length > 0 ? oldSpans : [''])
  );
  deleteWhereIn(store, 'memory_fulltext_index', 'object_id', oldSections);
  deleteWhereIn(store, 'memory_fulltext_index', 'object_id', oldSegments);

  deleteWhereIn(store, 'memory_derived_edge', 'from_id', [memId, fileId, ...oldSections, ...oldSegments]);
  deleteWhereIn(store, 'memory_derived_edge', 'to_id', [...oldSections, ...oldSegments, ...oldSpans]);
}

// ---------------------------------------------------------------------------
// 服务实现
// ---------------------------------------------------------------------------

// 宿主机路径只在本进程内用于调用适配器，绝不落库、绝不返回。
// 必须是进程级共享：登记与建档是两次 HTTP 请求，各自创建的服务实例若各持一份映射，
// 建档时就找不到登记时记录的真实路径（表现为“文件不存在”降级）。
const hostFiles = new Map();

function createMediaService(deps = {}) {
  const adapters = {
    asr: deps.asr,
    ocr: deps.ocr,
    vlm: deps.vlm,
  };
  const buildSeq = new Map();
  const defaultStore = deps.store ?? null;

  function resolveStore(store) {
    const target = store ?? defaultStore;
    if (!target) throw new TypeError('media: store 必填（getStore() 返回值）');
    return target;
  }

  /**
   * §13 file_entity 登记。
   * @returns {{ok:boolean, file:object|null, error?:string}}
   */
  function registerFile(store, options = {}) {
    const target = resolveStore(store);
    const file = isPlainObject(options.file) ? options.file : null;
    if (!file) return { ok: false, file: null, error: 'file_required' };
    const userId = options.user_id ?? file.user_id;
    if (!userId) return { ok: false, file: null, error: 'user_id_required' };

    const now = nowIso(options.now);
    const agentId = options.agent_id ?? file.agent_id ?? null;
    const fileName = baseName(file.file_name ?? file.name ?? file.path);
    const mime = String(file.mime ?? file.mime_type ?? '') || null;
    const mediaType = inferMediaType(mime, fileName);
    const hash = hashFileDescriptor(file, now);
    const size = sizeOfFile(file);
    const sensitivity = normalizeSensitivity(file.sensitivity ?? file.sensitivity_flag, DEFAULT_SENSITIVITY);
    const fileId = String(file.file_id ?? hashRef('file_', [
      'media_file', userId, agentId ?? '', hash, fileName,
    ]));
    const virtualPath = virtualPathOf(fileName);
    const language = uniqueStrings(file.language);

    const row = {
      file_id: fileId,
      user_id: String(userId),
      tenant_id: options.tenant_id ?? file.tenant_id ?? null,
      org_id: options.org_id ?? file.org_id ?? null,
      agent_id: agentId === null ? null : String(agentId),
      scope: options.scope ?? file.scope ?? 'user',
      source: String(file.source ?? 'upload'),
      media_type: mediaType,
      file_name: fileName,
      mime,
      size,
      duration: Number.isFinite(Number(file.duration)) ? Math.floor(Number(file.duration)) : null,
      upload_time: String(file.upload_time ?? now),
      language_json: language.length > 0 ? toJson(language) : null,
      hash,
      sensitivity_flag: sensitivity,
      parse_status: PARSE_STATUS.SKIPPED,
      degraded_reasons_json: toJson([]),
      lifecycle_state: 'active',
      deletion_state: 'active',
      schema_version: DOSSIER_SCHEMA_VERSION,
      created_at: now,
    };

    target.run(
      `INSERT INTO file_entity (
         file_id, user_id, tenant_id, org_id, agent_id, scope, source, media_type, file_name,
         mime, size, duration, upload_time, language_json, hash, sensitivity_flag, parse_status,
         degraded_reasons_json, lifecycle_state, deletion_state, schema_version, created_at
       ) VALUES (${placeholders(22)})
       ON CONFLICT(file_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         org_id = excluded.org_id,
         agent_id = excluded.agent_id,
         scope = excluded.scope,
         source = excluded.source,
         media_type = excluded.media_type,
         file_name = excluded.file_name,
         mime = excluded.mime,
         size = excluded.size,
         duration = excluded.duration,
         upload_time = excluded.upload_time,
         language_json = excluded.language_json,
         hash = excluded.hash,
         sensitivity_flag = excluded.sensitivity_flag,
         parse_status = excluded.parse_status,
         degraded_reasons_json = excluded.degraded_reasons_json,
         lifecycle_state = excluded.lifecycle_state,
         deletion_state = excluded.deletion_state`,
      ...Object.values(row)
    );

    hostFiles.set(fileId, {
      path: String(file.path ?? '').trim() || null,
      container_path: String(file.container_path ?? file.containerPath ?? '').trim() || null,
      base64: file.base64 ?? null,
    });

    return {
      ok: true,
      file: {
        ...row,
        size,
        virtual_path: virtualPath,
        sensitivity_flag: sensitivity,
        // 只回传虚拟路径
      },
    };
  }

  /**
   * §13 D0-D3 生成/更新。
   * 解析失败不抛错；降级写 parse_status + degraded_reasons。
   */
  async function buildDossier(store, options = {}) {
    const target = resolveStore(store);
    const fileId = options.file_id ?? options.fileId;
    if (!fileId) return { ok: false, error: 'file_id_required', parse_status: PARSE_STATUS.FAILED };
    const now = nowIso(options.now);

    const file = target.get('SELECT * FROM file_entity WHERE file_id = ?', String(fileId));
    if (!file) {
      return {
        ok: false,
        error: 'file_not_found',
        file_id: String(fileId),
        parse_status: PARSE_STATUS.FAILED,
        degraded_reasons: [DEGRADED_REASON.MEDIA_CORRUPT],
      };
    }

    // 进程重启后共享映射会丢，此时用调用方传入的 path（容器路径/宿主路径）兜底
    const registered = hostFiles.get(String(fileId)) ?? {
      path: options.host_path ?? null,
      container_path: options.file_path ?? options.container_path ?? null,
      base64: options.base64 ?? null,
    };
    const mediaType = file.media_type || MEDIA_TYPE.OTHER;
    const virtualPath = virtualPathOf(file.file_name);
    const sensitivity = normalizeSensitivity(file.sensitivity_flag, DEFAULT_SENSITIVITY);
    const memId = hashRef('mem_media_', ['media_mem', file.file_id]);
    const runSeq = (buildSeq.get(String(fileId)) ?? 0) + 1;
    buildSeq.set(String(fileId), runSeq);
    const runId = hashRef('run_media_', ['media_run', file.file_id, String(runSeq), now]);

    const hostPath = registered.path;
    const corrupt = hostPath !== null && hostPath !== undefined && !fs.existsSync(hostPath);
    const description = {
      file_id: String(file.file_id),
      file_name: file.file_name,
      path: hostPath,
      container_path: registered.container_path ?? null,
      base64: registered.base64 ?? null,
      mime: file.mime,
      media_type: mediaType,
      size: file.size,
      virtual_path: virtualPath,
      prompt: VLM_PROMPT,
    };

    // §13：按媒体类型选择适配器；未注入视为“不支持该能力”，不计失败
    const wantsAsr = !corrupt && (mediaType === MEDIA_TYPE.AUDIO || mediaType === MEDIA_TYPE.VIDEO);
    const wantsOcr = !corrupt && (mediaType === MEDIA_TYPE.IMAGE || mediaType === MEDIA_TYPE.DOCUMENT);
    const wantsVlm = !corrupt && (mediaType === MEDIA_TYPE.IMAGE || mediaType === MEDIA_TYPE.VIDEO);

    const [asrCall, ocrCall, vlmCall] = await Promise.all([
      wantsAsr ? callAdapter(adapters.asr, description) : Promise.resolve({ attempted: false, ok: false, data: null }),
      wantsOcr ? callAdapter(adapters.ocr, description) : Promise.resolve({ attempted: false, ok: false, data: null }),
      wantsVlm ? callAdapter(adapters.vlm, description) : Promise.resolve({ attempted: false, ok: false, data: null }),
    ]);

    const degradedReasons = [];
    if (asrCall.attempted && !asrCall.ok) degradedReasons.push(DEGRADED_REASON.ASR_FAILED);
    if (ocrCall.attempted && !ocrCall.ok) {
      degradedReasons.push(
        mediaType === MEDIA_TYPE.DOCUMENT
          ? DEGRADED_REASON.DOCUMENT_PARSE_FAILED
          : DEGRADED_REASON.OCR_FAILED
      );
    }
    if (vlmCall.attempted && !vlmCall.ok) degradedReasons.push(DEGRADED_REASON.VISION_FAILED);
    if (corrupt) degradedReasons.push(DEGRADED_REASON.MEDIA_CORRUPT);

    const asr = asrCall.ok ? asrCall.data : null;
    const ocr = ocrCall.ok ? ocrCall.data : null;
    const vlm = vlmCall.ok ? vlmCall.data : null;
    const duration = Number.isFinite(Number(file.duration))
      ? Number(file.duration)
      : (Number.isFinite(Number(asr?.duration)) ? Number(asr.duration) : 0);

    const rawSegments = corrupt ? [] : buildSegments({ mediaType, asr, ocr, vlm, duration });
    const segments = rawSegments.map((segment, index) => ({
      ...segment,
      index,
      seg_id: hashRef('seg_', ['media_seg', file.file_id, index, segment.t_start_sec ?? 0]),
      entities: uniqueStrings(segment.entities),
    }));

    const attemptedCount = [asrCall, ocrCall, vlmCall].filter((entry) => entry.attempted).length;
    const successCount = [asrCall, ocrCall, vlmCall].filter((entry) => entry.ok).length;
    let parseStatus;
    if (corrupt) {
      parseStatus = PARSE_STATUS.FAILED;
    } else if (attemptedCount === 0) {
      parseStatus = PARSE_STATUS.SKIPPED;
    } else if (successCount === 0) {
      // §13 传播：D2 全失败 -> D0 回退元信息 + partial_success
      parseStatus = PARSE_STATUS.PARTIAL_SUCCESS;
    } else if (degradedReasons.length > 0) {
      parseStatus = PARSE_STATUS.PARTIAL_SUCCESS;
    } else {
      parseStatus = PARSE_STATUS.SUCCESS;
    }
    if (!PARSE_STATUS_SET.has(parseStatus)) parseStatus = PARSE_STATUS.FAILED;

    const title = fileStem(file.file_name);
    const sections = buildSections(segments, file.file_id, now);
    const d0 = buildD0({ file, title, sections, degradedReasons, parseStatus });

    // 向量 id（条目级由 write.writeOne 写入；D1/D2 段级由本文件写入）
    const itemVecId = hashRef('vec_media_', ['media_item', memId]);
    const secVecIds = new Map(sections.map((section) => [
      section.sec_id,
      hashRef('vec_media_', ['media_sec', memId, section.sec_id]),
    ]));
    const segVecIds = new Map(segments.map((segment) => [
      segment.seg_id,
      hashRef('vec_media_', ['media_seg', memId, segment.seg_id]),
    ]));

    const recallable = parseStatus !== PARSE_STATUS.FAILED;
    const qualityFlag = parseStatus === PARSE_STATUS.SUCCESS
      ? QUALITY_FLAG.NORMAL
      : (parseStatus === PARSE_STATUS.SKIPPED ? QUALITY_FLAG.NEEDS_REVIEW : QUALITY_FLAG.DEGRADED);
    const qualityReasons = qualityFlag === QUALITY_FLAG.NORMAL
      ? []
      : (degradedReasons.length > 0 ? degradedReasons : ['parse_skipped']);

    // ---- 落库（事务内：Dossier + 证据 + 索引；memory_item 由 write.writeOne 单独事务写入）----
    const spanIds = [];
    try {
      target.tx(() => {
        clearDerived(target, { fileId: file.file_id, memId });

        target.run(
          `UPDATE file_entity
              SET parse_status = ?, degraded_reasons_json = ?, media_type = ?
            WHERE file_id = ?`,
          parseStatus,
          toJson(degradedReasons),
          mediaType,
          file.file_id
        );

        const segmentSpans = new Map();
        for (const segment of segments) {
          const spans = buildSegmentSpans({
            file,
            segment,
            virtualPath,
            sensitivity,
            now,
            memId,
          });
          segmentSpans.set(segment.seg_id, spans);
          for (const span of spans) {
            insertEvidenceSpan(target, span);
            spanIds.push(span.span_id);
            insertRow(target, 'dossier_d3', {
              span_id: span.span_id,
              file_id: String(file.file_id),
              seg_id: segment.seg_id,
              user_id: String(file.user_id),
              source_type: span.source_type,
              t_stamp: span.t_stamp,
              page_no: span.page_no,
              bbox_json: span.bbox_json,
              frame_ref: span.source_type === 'file_frame' || span.source_type === 'file_region'
                ? virtualPath
                : null,
              asr_ref: span.source_type === 'file_asr' ? span.span_id : null,
              ocr_ref: (span.source_type === 'file_ocr' || span.source_type === 'file_region')
                ? span.span_id
                : null,
              deletion_state: 'active',
              schema_version: DOSSIER_SCHEMA_VERSION,
              created_at: now,
            });
          }
        }

        // 若完全没有媒体证据，回退一条元信息 span，保证 D0 级记忆可被追溯（§13 D0 回退）
        if (spanIds.length === 0 && recallable) {
          const metaSpanId = hashRef('span_', ['media_meta', file.file_id]);
          insertEvidenceSpan(target, {
            span_id: metaSpanId,
            user_id: String(file.user_id),
            agent_id: file.agent_id ?? null,
            mem_id: memId,
            source_type: 'system_event',
            source_id: String(file.file_id),
            source_turn_id: null,
            raw_text: `${title}（${file.mime ?? mediaType}）`,
            text_excerpt: truncate(title, 200),
            start_offset: null,
            end_offset: null,
            media_ref: virtualPath,
            t_stamp: file.upload_time ?? null,
            page_no: null,
            bbox_json: null,
            language: null,
            sensitivity,
            content_hash: `sha256:${sha256Hex(title)}`,
            ref_count: 0,
            deletion_state: 'active',
            audit_ref: null,
            schema_version: EVIDENCE_SPAN_SCHEMA_VERSION,
            created_at: now,
          });
          spanIds.push(metaSpanId);
        }

        // D2 片段（每段写 D3 证据引用 + 段级向量 + 全文）
        for (const segment of segments) {
          const spans = segmentSpans.get(segment.seg_id) ?? [];
          const evidenceRefs = spans.map((span) => span.span_id);
          const segVecId = segVecIds.get(segment.seg_id);
          insertRow(target, 'dossier_d2', {
            seg_id: segment.seg_id,
            file_id: String(file.file_id),
            sec_id: null, // 下面 D1 聚合后回填
            user_id: String(file.user_id),
            t_start: segment.t_start_sec === 0 ? '00:00:00' : formatClock(segment.t_start_sec),
            t_end: segment.t_end_sec === 0 ? '00:00:00' : formatClock(segment.t_end_sec),
            caption: segment.caption || null,
            visual_desc: segment.visual_desc || null,
            asr_text: segment.asr_text || null,
            ocr_text: segment.ocr_text || null,
            speaker: segment.speaker || null,
            emotion_json: segment.emotion ? toJson(segment.emotion) : null,
            entities_json: toJson(segment.entities),
            embedding_seg: segVecId,
            evidence_refs_json: toJson(evidenceRefs),
            deletion_state: 'active',
            schema_version: DOSSIER_SCHEMA_VERSION,
            created_at: now,
          });

          const vectorText = segmentDisplayText(segment);
          if (vectorText !== '') {
            insertRow(target, 'memory_vector_index_segment', {
              ...vectorRowForSegment({
                vecId: segVecId,
                segId: segment.seg_id,
                fileId: String(file.file_id),
                userId: file.user_id,
                tenantId: file.tenant_id,
                orgId: file.org_id,
                text: vectorText,
                now,
              }),
              mem_id: memId,
              acl_version: 1,
            });
          }

          insertFulltext(target, {
            userId: file.user_id,
            tenantId: file.tenant_id,
            orgId: file.org_id,
            objectType: 'dossier_d2',
            objectId: segment.seg_id,
            sourceType: 'file_asr',
            text: [
              segment.caption,
              segment.visual_desc,
              segment.asr_text,
              segment.ocr_text,
              segment.speaker,
            ].filter(Boolean).join('\n'),
            now,
          });

          for (const span of spans) {
            // 证据 span 的真实文本进入全文索引（ASR/OCR/caption），供 search_raw / raw_bm25 使用
            insertFulltext(target, {
              userId: file.user_id,
              tenantId: file.tenant_id,
              orgId: file.org_id,
              objectType: 'evidence_span',
              objectId: span.span_id,
              sourceType: span.source_type,
              text: span.raw_text,
              now,
            });
          }
        }

        // D1 章节 + D0 文件级
        for (const section of sections) {
          const secVecId = secVecIds.get(section.sec_id);
          insertRow(target, 'dossier_d1', {
            sec_id: section.sec_id,
            file_id: String(file.file_id),
            user_id: String(file.user_id),
            title: section.title,
            summary: section.summary,
            key_points_json: toJson(section.key_points),
            speakers_json: toJson(section.speakers),
            entities_json: toJson(section.entities),
            affect_tag_json: section.affect_tag ? toJson(section.affect_tag) : null,
            embedding_sec: secVecId,
            seg_refs_json: toJson(section.seg_refs),
            deletion_state: 'active',
            schema_version: DOSSIER_SCHEMA_VERSION,
            created_at: now,
          });
          for (const segId of section.seg_refs) {
            target.run(
              'UPDATE dossier_d2 SET sec_id = ? WHERE seg_id = ?',
              section.sec_id,
              segId
            );
          }

          const vectorText = [section.title, section.summary, section.key_points.join(' ')]
            .filter(Boolean)
            .join('\n');
          if (vectorText !== '') {
            insertRow(target, 'memory_vector_index_segment', {
              ...vectorRowForSegment({
                vecId: secVecId,
                segId: section.sec_id,
                fileId: String(file.file_id),
                userId: file.user_id,
                tenantId: file.tenant_id,
                orgId: file.org_id,
                text: vectorText,
                now,
              }),
              mem_id: memId,
              acl_version: 1,
            });
          }

          insertFulltext(target, {
            userId: file.user_id,
            tenantId: file.tenant_id,
            orgId: file.org_id,
            objectType: 'dossier_d1',
            objectId: section.sec_id,
            sourceType: null,
            text: vectorText,
            now,
          });

          // §13 证据闭环：D15 -> D2
          for (const segId of section.seg_refs) {
            insertDerivedEdge(target, {
              userId: file.user_id,
              fromType: 'dossier_d1',
              fromId: section.sec_id,
              toType: 'dossier_d2',
              toId: segId,
              relation: 'aggregated_from',
              now,
              runId,
            });
          }
        }

        for (const segment of segments) {
          const spans = segmentSpans.get(segment.seg_id) ?? [];
          for (const span of spans) {
            insertDerivedEdge(target, {
              userId: file.user_id,
              fromType: 'dossier_d2',
              fromId: segment.seg_id,
              toType: 'evidence_span',
              toId: span.span_id,
              relation: 'derived_from',
              now,
              runId,
            });
          }
        }

        insertRow(target, 'dossier_d0', {
          file_id: String(file.file_id),
          user_id: String(file.user_id),
          title: d0.title,
          summary_1line: d0.summary_1line,
          summary_para: d0.summary_para,
          topics_json: toJson(d0.topics),
          key_entities_json: toJson(d0.key_entities),
          outline_refs_json: toJson(sections.map((section) => section.sec_id)),
          embedding_file: recallable ? itemVecId : null,
          parse_status: parseStatus,
          lifecycle_state: 'active',
          deletion_state: 'active',
          schema_version: DOSSIER_SCHEMA_VERSION,
          created_at: now,
        });

        for (const section of sections) {
          insertDerivedEdge(target, {
            userId: file.user_id,
            fromType: 'dossier_d0',
            fromId: String(file.file_id),
            toType: 'dossier_d1',
            toId: section.sec_id,
            relation: 'aggregated_from',
            now,
            runId,
          });
        }
      });
    } catch (error) {
      // 落库失败同样不抛错，返回降级结果
      safeAudit(target, {
        user_id: file.user_id,
        agent_id: file.agent_id,
        action: AUDIT_ACTION.MEDIA_PARSE_DEGRADED,
        object_type: 'file_entity',
        object_id: file.file_id,
        reason: 'storage_failed',
        sensitivity,
        now,
        after: { parse_status: PARSE_STATUS.FAILED, reasons: [DEGRADED_REASON.MEDIA_CORRUPT] },
      });
      return {
        ok: false,
        file_id: String(file.file_id),
        mem_id: null,
        parse_status: PARSE_STATUS.FAILED,
        degraded_reasons: uniqueStrings([...degradedReasons, DEGRADED_REASON.MEDIA_CORRUPT]),
        error: 'storage_failed',
        detail: String(error?.message ?? error),
      };
    }

    // ---- memory_item（type=media_dossier）写入，使 retrieval.recall 能命中 ----
    let itemWritten = false;
    let memIdWritten = null;
    let itemError = null;
    if (recallable) {
      const primarySpan = spanIds[0] ?? null;
      const itemInput = {
        item_index: 0,
        source_turn_id: `file:${file.file_id}:${runSeq}`,
        mem_id: memId,
        source_span: primarySpan,
        evidence_refs: spanIds,
        // §17.2：write.js 会为 evidence_refs 生成 memory_item->evidence_span 的 derived_from 边；
        // 若 derived_from 再传同一批 span，同一 edge_id 会被重复 INSERT 触发 UNIQUE 冲突。
        // D0->D1->D2->D3 的证据闭环由本文件显式写入，无需在此重复。
        derived_from: [],
        user_id: String(file.user_id),
        agent_id: file.agent_id ?? (target.agentId ?? 'agent_default'),
        scope: 'user',
        layer: 'M3',
        type: 'media_dossier',
        summary_short: truncate(d0.summary_1line, 300),
        summary_long: d0.summary_para,
        structured: {
          file_id: String(file.file_id),
          media_type: mediaType,
          media_ref: virtualPath,
          parse_status: parseStatus,
          degraded_reasons: degradedReasons,
          d0: { title: d0.title, topics: d0.topics, outline_refs: sections.map((s) => s.sec_id) },
          d1_refs: sections.map((section) => section.sec_id),
          d2_refs: segments.map((segment) => segment.seg_id),
          d3_refs: spanIds,
        },
        tags: d0.topics,
        entities: d0.key_entities,
        embedding_refs: { item: itemVecId, segment: [], fragment: [] },
        media_ref: virtualPath,
        importance: 0.65,
        confidence: parseStatus === PARSE_STATUS.SUCCESS ? 0.9 : 0.6,
        source_reliability: 0.85,
        quality_flag: qualityFlag,
        quality_reasons: qualityReasons,
        sensitivity,
        retention_policy: null,
        share_scope: [],
        lifecycle_state: 'active',
        version: 1,
        schema_version: SCHEMA_VERSION,
      };

      try {
        const written = write.writeOne(target, itemInput, {
          context: {
            user_id: String(file.user_id),
            agent_id: file.agent_id ?? (target.agentId ?? 'agent_default'),
          },
          now,
          source_turn_id: itemInput.source_turn_id,
          request_id: `media_${file.file_id}`,
        });
        itemWritten = written && written.ok === true;
        memIdWritten = written?.mem_id ?? null;
        if (!itemWritten) {
          itemError = {
            code: written?.error_code ?? written?.code ?? null,
            message: written?.message ?? null,
            status: written?.status ?? null,
          };
        }
      } catch (error) {
        itemWritten = false;
        itemError = { code: error?.code ?? null, message: String(error?.message ?? error) };
      }

      if (!itemWritten) {
        // §13：D0 写入失败 -> partial_success + d0_failed
        if (!degradedReasons.includes(DEGRADED_REASON.D0_FAILED)) {
          degradedReasons.push(DEGRADED_REASON.D0_FAILED);
        }
        if (parseStatus === PARSE_STATUS.SUCCESS) parseStatus = PARSE_STATUS.PARTIAL_SUCCESS;
        target.run(
          'UPDATE file_entity SET parse_status = ?, degraded_reasons_json = ? WHERE file_id = ?',
          parseStatus,
          toJson(degradedReasons),
          file.file_id
        );
        target.run(
          'UPDATE dossier_d0 SET parse_status = ? WHERE file_id = ?',
          parseStatus,
          file.file_id
        );
      } else if (primarySpan) {
        target.run(
          'UPDATE memory_evidence_span SET ref_count = ref_count + 1 WHERE span_id = ?',
          primarySpan
        );
      }

      // memory_item -> dossier_d0 的证据闭环
      try {
        insertDerivedEdge(target, {
          userId: file.user_id,
          fromType: 'memory_item',
          fromId: memId,
          toType: 'dossier_d0',
          toId: String(file.file_id),
          relation: 'summarized_from',
          now,
          runId,
        });
      } catch {
        // 边写失败不影响主流程
      }
    }

    // 审计：file.parse / media.parse_degraded
    safeAudit(target, {
      user_id: file.user_id,
      agent_id: file.agent_id,
      action: AUDIT_ACTION.FILE_PARSE,
      object_type: 'file_entity',
      object_id: file.file_id,
      reason: 'media_dossier',
      sensitivity,
      now,
      after: {
        parse_status: parseStatus,
        degraded_reasons: degradedReasons,
        d0: 1,
        d1: sections.length,
        d2: segments.length,
        d3: spanIds.length,
      },
    });
    if (parseStatus !== PARSE_STATUS.SUCCESS) {
      safeAudit(target, {
        user_id: file.user_id,
        agent_id: file.agent_id,
        action: AUDIT_ACTION.MEDIA_PARSE_DEGRADED,
        object_type: 'file_entity',
        object_id: file.file_id,
        reason: degradedReasons.join(',') || 'partial_parse',
        sensitivity,
        now,
        after: { parse_status: parseStatus, degraded_reasons: degradedReasons },
      });
    }

    return {
      ok: true,
      file_id: String(file.file_id),
      mem_id: itemWritten ? (memIdWritten ?? memId) : null,
      parse_status: parseStatus,
      degraded_reasons: degradedReasons,
      recallable: itemWritten,
      // §13 降级诊断：memory_item 写入失败时给出底层错误码/信息（成功时为 null）
      item_error: itemError,
      counts: {
        d0: 1,
        d1: sections.length,
        d2: segments.length,
        d3: spanIds.length,
      },
      dossier: {
        schema_version: DOSSIER_SCHEMA_VERSION,
        file_id: String(file.file_id),
        user_id: String(file.user_id),
        agent_id: file.agent_id ?? null,
        scope: file.scope ?? 'user',
        source: file.source ?? 'upload',
        media_type: mediaType,
        meta: {
          file_name: file.file_name,
          mime: file.mime,
          size: file.size,
          duration: file.duration,
          upload_time: file.upload_time,
          language: parseJson(file.language_json, []),
          hash: file.hash,
          sensitivity_flag: sensitivity,
          media_ref: virtualPath,
        },
        D0: {
          title: d0.title,
          summary_1line: d0.summary_1line,
          topics: d0.topics,
          key_entities: d0.key_entities,
          outline_refs: sections.map((section) => section.sec_id),
          embedding_file: recallable ? itemVecId : null,
        },
        D1_refs: sections.map((section) => section.sec_id),
        D2_refs: segments.map((segment) => segment.seg_id),
        D3_refs: spanIds,
        parse_status: parseStatus,
        degraded_reasons: degradedReasons,
        lifecycle_state: 'active',
        deletion_state: 'active',
      },
    };
  }

  /**
   * §16.2/§16.3/§17.11 媒体检索。
   * 权限：S3 默认拒绝；不缓存（cache.js FORBIDDEN_SCENARIOS 含 search_raw）。
   */
  function search(store, options = {}) {
    const target = resolveStore(store);
    const userId = options.user_id;
    if (!userId) {
      return {
        schema_version: MEDIA_SEARCH_SCHEMA_VERSION,
        query: String(options.query ?? ''),
        hits: [],
        total: 0,
        blocked_count: 0,
        redacted_fields: ['host_path'],
        cacheable: false,
        warnings: [{ code: 'missing_user_id', message: '§3.1 user_id 必填' }],
      };
    }

    const query = String(options.query ?? '');
    const terms = retrieval.tokenizeTerms(query);
    const normalizedQuery = String(query).normalize('NFKC').toLowerCase().trim();
    const maxSensitivity = normalizeSensitivityMax(options.sensitivity_max);
    const purpose = options.purpose ?? null;
    const authorized = options.authorized === true;
    const fileIds = uniqueStrings(options.file_ids ?? options.fileId);
    const topK = Number.isInteger(Number(options.top_k)) && Number(options.top_k) > 0
      ? Number(options.top_k)
      : DEFAULT_TOP_K;
    const now = options.now === undefined ? undefined : String(options.now);

    let sql = `SELECT * FROM file_entity
      WHERE user_id = ?
        AND (lifecycle_state IS NULL OR lifecycle_state = 'active')
        AND (deletion_state IS NULL OR deletion_state = 'active')`;
    const params = [String(userId)];
    if (options.agent_id) {
      sql += ' AND (agent_id = ? OR agent_id IS NULL)';
      params.push(String(options.agent_id));
    }
    if (fileIds.length > 0) {
      sql += ` AND file_id IN (${placeholders(fileIds.length)})`;
      params.push(...fileIds);
    }
    sql += ' ORDER BY file_id';

    let files = [];
    try {
      files = target.all(sql, ...params);
    } catch (error) {
      return {
        schema_version: MEDIA_SEARCH_SCHEMA_VERSION,
        query,
        hits: [],
        total: 0,
        blocked_count: 0,
        redacted_fields: ['host_path'],
        cacheable: false,
        warnings: [{ code: 'file_query_failed', message: String(error?.message ?? error) }],
      };
    }

    let blockedCount = 0;
    const warnings = [];
    const hits = [];

    for (const file of files) {
      const fileSensitivity = normalizeSensitivity(file.sensitivity_flag, DEFAULT_SENSITIVITY);
      const rank = sensitivityRank(fileSensitivity);
      const s3Authorized = rank === 3
        && authorized
        && (purpose === 'safety' || purpose === 'audit');
      if (rank > sensitivityRank(maxSensitivity) || (rank === 3 && !s3Authorized)) {
        blockedCount += 1;
        safeAudit(target, {
          user_id: userId,
          agent_id: file.agent_id,
          action: AUDIT_ACTION.AUTHZ_DENIED,
          object_type: 'file_entity',
          object_id: file.file_id,
          reason: 'media_search_sensitivity_blocked',
          sensitivity: fileSensitivity,
          now,
          after: { purpose, sensitivity_max: maxSensitivity },
        });
        continue;
      }

      if (file.parse_status === PARSE_STATUS.FAILED && options.include_failed !== true) {
        warnings.push({ code: 'file_parse_failed', file_id: file.file_id });
        continue;
      }

      const d0 = target.get('SELECT * FROM dossier_d0 WHERE file_id = ?', file.file_id);
      if (!d0) {
        warnings.push({ code: 'dossier_not_built', file_id: file.file_id });
        continue;
      }
      const d1Rows = target.all(
        'SELECT * FROM dossier_d1 WHERE file_id = ? ORDER BY sec_id',
        file.file_id
      );
      const d2Rows = target.all(
        'SELECT * FROM dossier_d2 WHERE file_id = ? ORDER BY t_start, seg_id',
        file.file_id
      );

      const memId = hashRef('mem_media_', ['media_mem', file.file_id]);
      let allSpans = target.all(
        'SELECT span_id FROM memory_evidence_span WHERE mem_id = ? AND source_id = ? ORDER BY span_id',
        memId,
        file.file_id
      ).map((row) => row.span_id);
      if (allSpans.length === 0) {
        allSpans = target.all(
          'SELECT span_id FROM dossier_d3 WHERE file_id = ? ORDER BY span_id',
          file.file_id
        ).map((row) => row.span_id);
      }

      const virtualPath = virtualPathOf(file.file_name);
      const emptyFileResult = {
        schema_version: MEDIA_SEARCH_SCHEMA_VERSION,
        query,
        file_id: String(file.file_id),
        level: 'D0',
        seg_id: null,
        t_start: null,
        t_end: null,
        caption: d0.summary_1line ?? null,
        visual_desc: null,
        asr_text: null,
        ocr_text: null,
        speaker: null,
        emotion: null,
        entities: parseJson(d0.key_entities_json, []),
        evidence_refs: allSpans.slice(0, Math.max(1, allSpans.length)),
        why_recalled_code: `V:${file.file_id}|S:1.00`,
        media_ref: virtualPath,
      };

      if (terms.length === 0) {
        if (emptyFileResult.evidence_refs.length > 0) {
          hits.push({ ...emptyFileResult, score: 1 });
        }
        continue;
      }

      const scoreText = (haystack) => {
        const text = String(haystack ?? '').normalize('NFKC').toLowerCase();
        if (text === '') return 0;
        let matched = 0;
        for (const term of terms) if (text.includes(term.toLowerCase())) matched += 1;
        const base = matched / terms.length;
        const bonus = normalizedQuery !== '' && text.includes(normalizedQuery) ? 0.2 : 0;
        return Math.min(1, base + bonus);
      };

      let levelHits = [];
      // ---- D2 片段级 ----
      for (const row of d2Rows) {
        const haystack = [
          row.caption,
          row.visual_desc,
          row.asr_text,
          row.ocr_text,
          row.speaker,
          ...(parseJson(row.entities_json, []) ?? []),
        ].filter(Boolean).join(' ');
        const score = scoreText(haystack);
        if (score <= 0) continue;
        const evidenceRefs = parseJson(row.evidence_refs_json, [])
          .filter((spanId) => allSpans.includes(spanId));
        if (evidenceRefs.length === 0) continue;
        const emotion = parseJson(row.emotion_json, null);
        const intensity = Number(emotion?.intensity);
        const why = [
          `V:${row.seg_id}`,
          `S:${score.toFixed(2)}`,
          ...(Number.isFinite(intensity) ? [`A:${intensity.toFixed(2)}`] : []),
        ].join('|');
        levelHits.push({
          schema_version: MEDIA_SEARCH_SCHEMA_VERSION,
          query,
          file_id: String(file.file_id),
          level: 'D2',
          seg_id: row.seg_id,
          t_start: row.t_start ?? null,
          t_end: row.t_end ?? null,
          caption: row.caption ?? null,
          visual_desc: row.visual_desc ?? null,
          asr_text: row.asr_text ?? null,
          ocr_text: row.ocr_text ?? null,
          speaker: row.speaker ?? null,
          emotion: emotion ?? null,
          entities: parseJson(row.entities_json, []),
          evidence_refs: evidenceRefs,
          why_recalled_code: why,
          media_ref: virtualPath,
          score,
        });
      }

      // ---- D1 章节级兜底 ----
      if (levelHits.length === 0) {
        for (const row of d1Rows) {
          const keyPoints = parseJson(row.key_points_json, []);
          const score = scoreText([row.title, row.summary, ...keyPoints].filter(Boolean).join(' '));
          if (score <= 0) continue;
          const segRefs = parseJson(row.seg_refs_json, []);
          const evidenceRefs = uniqueStrings(
            d2Rows
              .filter((segment) => segRefs.includes(segment.seg_id))
              .flatMap((segment) => parseJson(segment.evidence_refs_json, []))
          ).filter((spanId) => allSpans.includes(spanId));
          if (evidenceRefs.length === 0) continue;
          const first = d2Rows.find((segment) => segRefs.includes(segment.seg_id)) ?? null;
          levelHits.push({
            schema_version: MEDIA_SEARCH_SCHEMA_VERSION,
            query,
            file_id: String(file.file_id),
            level: 'D1',
            seg_id: null,
            t_start: first?.t_start ?? null,
            t_end: (d2Rows.filter((segment) => segRefs.includes(segment.seg_id)).pop())?.t_end ?? null,
            caption: row.summary ?? null,
            visual_desc: null,
            asr_text: null,
            ocr_text: null,
            speaker: parseJson(row.speakers_json, [])[0] ?? null,
            emotion: parseJson(row.affect_tag_json, null),
            entities: parseJson(row.entities_json, []),
            evidence_refs: evidenceRefs,
            why_recalled_code: `V:${file.file_id}|S:${score.toFixed(2)}`,
            media_ref: virtualPath,
            score,
          });
        }
      }

      // ---- D0 文件级兜底 ----
      if (levelHits.length === 0) {
        const score = scoreText([
          d0.title,
          d0.summary_1line,
          d0.summary_para,
          ...(parseJson(d0.topics_json, []) ?? []),
          ...(parseJson(d0.key_entities_json, []) ?? []),
        ].filter(Boolean).join(' '));
        if (score <= 0) continue;
        if (allSpans.length === 0) continue;
        levelHits.push({
          ...emptyFileResult,
          caption: d0.summary_1line ?? null,
          evidence_refs: allSpans,
          why_recalled_code: `V:${file.file_id}|S:${score.toFixed(2)}`,
          score,
        });
      }

      hits.push(...levelHits);
    }

    hits.sort((a, b) => (
      b.score - a.score
      || String(a.file_id).localeCompare(String(b.file_id))
      || String(a.seg_id ?? '').localeCompare(String(b.seg_id ?? ''))
    ));
    const limited = hits.slice(0, topK).map((hit) => {
      const { score, ...rest } = hit;
      return rest;
    });

    // §16.2：search_raw 不缓存；这里显式标记，且不调用 cache.put
    safeAudit(target, {
      user_id: userId,
      action: AUDIT_ACTION.MEMORY_SEARCH_RAW,
      object_type: 'media_search',
      object_id: `media_search_${sha256Hex([userId, query].join('|')).slice(0, 24)}`,
      reason: 'media_search',
      sensitivity: SENSITIVITY.S2,
      now,
      after: { query, top_k: topK, blocked_count: blockedCount },
    });

    return {
      schema_version: MEDIA_SEARCH_SCHEMA_VERSION,
      query,
      hits: limited,
      total: hits.length,
      blocked_count: blockedCount,
      redacted_fields: ['host_path'],
      cacheable: false,
      warnings,
    };
  }

  /**
   * 时间轴查询（§13 时间戳 / 关键帧；适配器不支持时降级）。
   */
  function timeline(store, options = {}) {
    const target = resolveStore(store);
    const fileId = options.file_id;
    if (!fileId) return { ok: false, error: 'file_id_required' };
    const file = target.get('SELECT * FROM file_entity WHERE file_id = ?', String(fileId));
    if (!file) return { ok: false, error: 'file_not_found' };

    const userId = options.user_id ?? file.user_id;
    if (options.user_id && String(options.user_id) !== String(file.user_id)) {
      return { ok: false, error: 'user_scope_mismatch' };
    }
    const fileSensitivity = normalizeSensitivity(file.sensitivity_flag, DEFAULT_SENSITIVITY);
    const rank = sensitivityRank(fileSensitivity);
    const maxSensitivity = normalizeSensitivityMax(options.sensitivity_max);
    const s3Authorized = rank === 3
      && options.authorized === true
      && (options.purpose === 'safety' || options.purpose === 'audit');
    if (rank > sensitivityRank(maxSensitivity) || (rank === 3 && !s3Authorized)) {
      safeAudit(target, {
        user_id: userId,
        agent_id: file.agent_id,
        action: AUDIT_ACTION.AUTHZ_DENIED,
        object_type: 'file_entity',
        object_id: file.file_id,
        reason: 'media_timeline_sensitivity_blocked',
        sensitivity: fileSensitivity,
        now: options.now,
      });
      return { ok: false, error: 'sensitivity_blocked', file_id: String(fileId) };
    }

    const from = parseClock(options.from);
    const to = parseClock(options.to);
    const rows = target.all(
      'SELECT * FROM dossier_d2 WHERE file_id = ? ORDER BY t_start, seg_id',
      file.file_id
    );
    const segments = rows
      .map((row) => {
        const start = parseClock(row.t_start);
        const end = parseClock(row.t_end);
        if (from !== null && end !== null && end < from) return null;
        if (to !== null && start !== null && start > to) return null;
        return {
          seg_id: row.seg_id,
          sec_id: row.sec_id,
          t_start: row.t_start,
          t_end: row.t_end,
          caption: row.caption,
          visual_desc: row.visual_desc,
          asr_text: row.asr_text,
          ocr_text: row.ocr_text,
          speaker: row.speaker,
          emotion: parseJson(row.emotion_json, null),
          entities: parseJson(row.entities_json, []),
          evidence_refs: parseJson(row.evidence_refs_json, []),
        };
      })
      .filter(Boolean);

    // 关键帧：D3 中的 file_frame / file_region（frame_ref 已脱敏为虚拟路径）
    const keyFrames = target.all(
      `SELECT span_id, seg_id, source_type, t_stamp, page_no, bbox_json, frame_ref
         FROM dossier_d3
        WHERE file_id = ? AND source_type IN ('file_frame', 'file_region')
        ORDER BY t_stamp, span_id`,
      file.file_id
    ).map((row) => ({
      span_id: row.span_id,
      seg_id: row.seg_id,
      source_type: row.source_type,
      t_stamp: row.t_stamp,
      page_no: row.page_no,
      bbox: parseJson(row.bbox_json, null),
      frame_ref: row.frame_ref,
    }));

    const degraded = [];
    if (segments.length === 0) degraded.push('timeline_unavailable');
    if (keyFrames.length === 0) degraded.push('keyframe_unavailable');

    return {
      ok: true,
      file_id: String(file.file_id),
      media_type: file.media_type,
      media_ref: virtualPathOf(file.file_name),
      from: options.from ?? null,
      to: options.to ?? null,
      segments,
      key_frames: keyFrames,
      degraded,
    };
  }

  return {
    adapters,
    registerFile,
    buildDossier,
    search,
    timeline,
    // 供调用方排查：查看已登记的宿主机路径（不会进入任何导出结果）
    debugHostFiles: () => new Map(hostFiles),
  };
}

// ---------------------------------------------------------------------------
// 模块级默认服务（不注入适配器时 buildDossier 会以 skipped/partial 降级）
// ---------------------------------------------------------------------------

let defaultService = null;
function getDefaultService() {
  if (!defaultService) defaultService = createMediaService({});
  return defaultService;
}

function registerFile(store, options) {
  return getDefaultService().registerFile(store, options);
}
async function buildDossier(store, options) {
  return getDefaultService().buildDossier(store, options);
}
function search(store, options) {
  return getDefaultService().search(store, options);
}
function timeline(store, options) {
  return getDefaultService().timeline(store, options);
}

module.exports = {
  create: createMediaService,
  createMediaService,
  registerFile,
  buildDossier,
  search,
  timeline,
  inferMediaType,
  formatClock,
  parseClock,
  virtualPathOf,
  DOSSIER_SCHEMA_VERSION,
  MEDIA_SEARCH_SCHEMA_VERSION,
  DEGRADED_REASON,
  PARSE_STATUS,
  MEDIA_TYPE,
};
