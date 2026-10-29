const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OLLAMA_URL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const KB_ROOT = '/workspace/.agent/kb';
const EMBED_MODEL = 'nomic-embed-text';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embed(text) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
        signal: AbortSignal.timeout(120000)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (!Array.isArray(data.embedding)) throw new Error('Ollama 未返回 embedding');
      return data.embedding;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Ollama embedding 失败：${lastError?.message || '未知错误'}`);
}

function chunkText(text, size = 1200, overlap = 200) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + size);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function isBinary(buffer) {
  const length = Math.min(buffer.length, 4096);
  for (let i = 0; i < length; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function readDocument(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return execFileSync('pdftotext', [file, '-'], {
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024
    });
  }
  const stat = fs.statSync(file);
  if (stat.size > 30 * 1024 * 1024) return '';
  const buffer = fs.readFileSync(file);
  if (isBinary(buffer)) return '';
  return buffer.toString('utf8');
}

function walk(target, files = []) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return files;
  if (stat.isDirectory()) {
    const base = path.basename(target);
    if (['.agent', 'node_modules', '.git', '__pycache__', '.cache'].includes(base)) return files;
    for (const entry of fs.readdirSync(target)) {
      walk(path.join(target, entry), files);
    }
  } else if (stat.isFile()) {
    files.push(target);
  }
  return files;
}

function resolvePath(input) {
  return path.isAbsolute(input) ? input : path.resolve('/workspace', input);
}

function safeName(name) {
  return String(name || '')
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
    .slice(0, 80);
}

async function ingest(paths, name) {
  const list = Array.isArray(paths) ? paths : [paths];
  const collectionName = safeName(name) || `kb-${Date.now()}`;
  const dir = path.join(KB_ROOT, collectionName);
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  for (const item of list) {
    if (!item) continue;
    const resolved = resolvePath(String(item));
    if (!fs.existsSync(resolved)) continue;
    walk(resolved, files);
  }

  const sources = new Set();
  const lines = [];
  let totalChunks = 0;

  for (const file of files) {
    let text = '';
    try {
      text = readDocument(file);
    } catch {
      continue;
    }
    if (!text || !text.trim()) continue;
    sources.add(file);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      if (totalChunks >= 8000) break;
      try {
        const vector = await embed(chunk);
        lines.push(JSON.stringify({
          source: file,
          chunk,
          embedding: vector
        }));
        totalChunks += 1;
      } catch {
        // 单个切片失败时跳过
      }
    }
    if (totalChunks >= 8000) break;
  }

  if (lines.length) {
    fs.appendFileSync(path.join(dir, 'index.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  }

  const metaPath = path.join(dir, 'meta.json');
  let meta = { name: collectionName, chunks: 0, sources: [], createdAt: new Date().toISOString(), model: EMBED_MODEL };
  try {
    meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
  } catch {
    // ignore
  }
  meta.name = collectionName;
  meta.chunks = Number(meta.chunks || 0) + lines.length;
  meta.sources = Array.from(new Set([...(meta.sources || []), ...Array.from(sources)]));
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  return {
    name: collectionName,
    files: sources.size,
    chunks: lines.length,
    total_chunks: meta.chunks
  };
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function search(query, topK = 5) {
  if (!fs.existsSync(KB_ROOT)) {
    return { results: [], message: '知识库为空，请先调用 kb_ingest。' };
  }
  const collections = fs.readdirSync(KB_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (!collections.length) {
    return { results: [], message: '知识库为空，请先调用 kb_ingest。' };
  }

  const queryVector = await embed(query);
  const scored = [];
  for (const collection of collections) {
    const indexPath = path.join(KB_ROOT, collection, 'index.jsonl');
    if (!fs.existsSync(indexPath)) continue;
    const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        const score = cosine(queryVector, item.embedding);
        scored.push({ collection, source: item.source, chunk: item.chunk, score });
      } catch {
        // ignore malformed line
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, Math.max(1, Math.min(20, Number(topK) || 5))).map((item) => ({
    collection: item.collection,
    source: item.source,
    score: Number(item.score.toFixed(4)),
    chunk: item.chunk.slice(0, 1600)
  }));
  return { results, total_indexed: scored.length };
}

module.exports = {
  ingest,
  search,
  chunkText,
  embed
};
