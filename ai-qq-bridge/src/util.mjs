import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function nowSec () {
  return Math.floor(Date.now() / 1000);
}

export function monthKey (date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function md5Buffer (buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

export function md5File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function randomId (bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function clampInt (value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function safeStringify (value, space = 0) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, space);
  } catch {
    return String(value);
  }
}

export function readJson (filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic (filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, safeStringify(value, 2));
  fs.renameSync(tmp, filePath);
}

export function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeFileName (name, fallback = 'file') {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return base || fallback;
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

export function contentTypeFor (filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function extOf (filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ext.startsWith('.') ? ext : '';
}

export function isPrivateAddress (remote) {
  if (!remote) return false;
  const addr = remote.replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' ||
    /^10\./.test(addr) ||
    /^192\.168\./.test(addr) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr) ||
    /^fd[0-9a-f]{2}:/i.test(addr) ||
    /^fc[0-9a-f]{2}:/i.test(addr);
}

export function parseBasicAuth (header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

export async function readBody (req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`请求体超过限制 ${limitBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody (req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}

export function sendJson (res, status, value, extraHeaders = {}) {
  const body = Buffer.from(safeStringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

export function sendText (res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function parseCookies (header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * 不使用全局 fetch：QQ 内置 Node 可能是 16.x，没有 fetch。
 */
export function httpGetBuffer (url, { timeout = 30000, maxBytes = 0, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`非法 URL: ${url}`));
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.get(target, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        httpGetBuffer(next, { timeout, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (maxBytes && size > maxBytes) {
          req.destroy(new Error(`响应超过限制 ${maxBytes} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

export function httpPostJson (url, value, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`非法 URL: ${url}`));
      return;
    }
    const body = Buffer.from(safeStringify(value), 'utf8');
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

