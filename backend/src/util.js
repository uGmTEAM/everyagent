const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  // 中英文混合的保守估算：约 2.5 字符/token
  return Math.ceil(s.length / 2.5);
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m) continue;
    total += 8;
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (m.content) total += estimateTokens(JSON.stringify(m.content));
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

function randomKey() {
  return crypto.randomBytes(32).toString('hex');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 归一化：去掉空白、大小写和标点差异，只保留可比较的字面内容。
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .trim();
}

// 提交指纹：忽略排版、标点和大小写后取 sha256，用于识别完全重复的提交。
function fingerprintText(text) {
  return sha256(normalizeText(text).replace(/\s+/g, ''));
}

function shingles(text, size, sample) {
  const set = new Set();
  const n = text.length;
  if (n <= size) {
    if (n) set.add(text);
    return set;
  }
  const step = Math.max(1, Math.floor((n - size) / sample));
  for (let i = 0; i + size <= n; i += step) set.add(text.slice(i, i + size));
  return set;
}

// 字符级 shingle 相似度（0~1），用于提示 Judge「高度相似」，不做强判定。
function textSimilarity(a, b, { size = 6, sample = 1200 } = {}) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const setA = shingles(left, size, sample);
  const setB = shingles(right, size, sample);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed !== null) return parsed;
  }
  const direct = safeJsonParse(text.trim());
  if (direct !== null) return direct;

  for (const pair of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(pair[0]);
    const end = text.lastIndexOf(pair[1]);
    if (start >= 0 && end > start) {
      const parsed = safeJsonParse(text.slice(start, end + 1));
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function truncate(text, max = 100000) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[已截断，原始长度 ${text.length}]`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeJoin(root, relative) {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative || '.');
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    throw new Error('非法路径');
  }
  return target;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d);
}

function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '0 秒';
  const totalSec = Math.floor(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
    } catch {
      // 忽略无法读取的文件
    }
  }
  return total;
}

function tailFileLines(file, maxLines = 300, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return [];
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    let lines = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) lines = lines.slice(1);
    return lines.filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

module.exports = {
  nowIso,
  sleep,
  clamp,
  toInt,
  estimateTokens,
  estimateMessagesTokens,
  randomKey,
  sha256,
  normalizeText,
  fingerprintText,
  textSimilarity,
  safeJsonParse,
  extractJson,
  truncate,
  ensureDir,
  safeJoin,
  formatBytes,
  formatInt,
  formatDate,
  formatDuration,
  dirSize,
  tailFileLines
};
