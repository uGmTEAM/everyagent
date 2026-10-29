'use strict';

/**
 * 向量能力（§4.5 条目级向量余弦、§17.9 RecallCandidate 向量召回）。
 *
 * 提供两条路径：
 *   1) hashEmbedding：零依赖确定性哈希向量（本地兜底 / 单测用），同输入同输出；
 *   2) createRemoteEmbedder：通过内置 fetch 调用远程 embedding 服务，失败时整体回落到
 *      hashEmbedding，并在返回数组上标记 degraded=true（数组附加属性，仍满足 number[][] 形态）。
 *
 * 不引入任何第三方依赖。
 */

// FNV-1a 32 位哈希：用于把文本稳定映射为 PRNG 种子。
function fnv1a(str, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// xorshift32：确定性伪随机序列（无 Math.random）。
function nextXorShift32(state) {
  let x = state >>> 0;
  x ^= (x << 13) >>> 0;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}

/**
 * 确定性哈希向量 + L2 归一化。
 * @param {string} text
 * @param {number} [dim=1024]
 * @returns {number[]} 长度为 dim 的已归一化向量
 */
function hashEmbedding(text, dim = 1024) {
  const str = text === null || text === undefined ? '' : String(text);
  const size = Math.floor(Number(dim));
  if (!Number.isInteger(size) || size <= 0) {
    throw new TypeError('hashEmbedding: dim 必须为正整数');
  }

  // 双种子混合，降低不同文本碰撞概率；长度并入种子避免前缀冲突。
  let state = fnv1a(str, 0x811c9dc5) ^ fnv1a(`${str.length}\u0000${str}`, 0x9e3779b9);
  state >>>= 0;
  if (state === 0) state = 0x6d2b79f5;

  const vector = new Array(size);
  let sumSquares = 0;
  for (let i = 0; i < size; i += 1) {
    state = nextXorShift32(state);
    // 映射到 [-1, 1)
    const value = (state / 0xffffffff) * 2 - 1;
    vector[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    vector.fill(0);
    vector[0] = 1;
    return vector;
  }
  for (let i = 0; i < size; i += 1) {
    vector[i] /= norm;
  }
  return vector;
}

/**
 * 余弦相似度（§4.5 相似度用条目级向量余弦）。
 * 维度不一致或存在零向量时返回 0；结果被 clamp 到 [-1, 1]。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new TypeError('cosine: 入参必须是数组');
  }
  if (a.length !== b.length) {
    throw new RangeError(`cosine: 向量维度不一致 (${a.length} != ${b.length})`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, raw));
}

// 兼容常见远程响应结构：OpenAI data[].embedding / 自定义 embeddings / 裸 number[][]。
function extractVectors(payload) {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return [];
    if (payload.every((item) => Array.isArray(item))) {
      return payload.map((row) => row.map(Number));
    }
    // [{ embedding: [...] }]
    if (payload.every((item) => item && Array.isArray(item.embedding))) {
      return payload.map((item) => item.embedding.map(Number));
    }
    return null;
  }
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) return extractVectors(payload.data);
    if (Array.isArray(payload.embeddings)) return extractVectors(payload.embeddings);
    if (Array.isArray(payload.vectors)) return extractVectors(payload.vectors);
    if (Array.isArray(payload.vector)) return [payload.vector.map(Number)];
  }
  return null;
}

/**
 * 创建远程 embedder（内置 fetch）。远程失败/超时/响应非法时整体回落 hashEmbedding。
 *
 * 返回值 embed(texts) 语义上返回 number[][]，同时在数组上附加：
 *   - degraded: boolean（true 表示本次结果来自本地哈希兜底）
 *   - degraded_reason: string|null
 *   - model: string
 * 注意：往数组挂属性不影响下标访问，也不会改变 number[][] 的形态。
 *
 * @param {{endpoint?:string, apiKey?:string, model?:string, timeoutMs?:number,
 *          dim?:number, headers?:object, fetchImpl?:Function}} [config]
 * @returns {{model:string, embed:(texts:string[])=>Promise<number[][] & {degraded:boolean, degraded_reason:string|null}>}}
 */
function createRemoteEmbedder(config = {}) {
  const endpoint = config.endpoint;
  const apiKey = config.apiKey;
  const model = config.model || 'text-embedding-3-small';
  // 契约未给超时数值，采用默认并可配置。
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 10000;
  const dim = Number.isInteger(config.dim) && config.dim > 0 ? config.dim : 1024;
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch;
  const extraHeaders = config.headers && typeof config.headers === 'object' ? config.headers : {};

  function fallback(texts, reason) {
    const vectors = texts.map((text) => hashEmbedding(text, dim));
    vectors.degraded = true;
    vectors.degraded_reason = reason;
    vectors.model = 'hashEmbedding';
    return vectors;
  }

  return {
    model,
    async embed(texts) {
      const list = Array.isArray(texts)
        ? texts.map((text) => (text === null || text === undefined ? '' : String(text)))
        : [texts === null || texts === undefined ? '' : String(texts)];

      if (!endpoint || typeof fetchImpl !== 'function') {
        return fallback(list, 'endpoint_or_fetch_unavailable');
      }

      // Node 24 支持 AbortController；用定时器实现 timeout，保证远程不可用时快速回落。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { 'Content-Type': 'application/json', ...extraHeaders };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: list }),
          signal: controller.signal,
        });

        if (!response || !response.ok) {
          return fallback(list, `http_${response ? response.status : 'no_response'}`);
        }

        const payload = typeof response.json === 'function' ? await response.json() : response;
        const vectors = extractVectors(payload);
        if (!vectors || vectors.length !== list.length) {
          return fallback(list, 'invalid_response_length');
        }

        const normalized = [];
        for (const row of vectors) {
          if (!Array.isArray(row) || row.length === 0 || !row.every((value) => Number.isFinite(value))) {
            return fallback(list, 'invalid_vector_payload');
          }
          normalized.push(row);
        }

        normalized.degraded = false;
        normalized.degraded_reason = null;
        normalized.model = model;
        return normalized;
      } catch (error) {
        // 不泄露 endpoint/apiKey；只保留稳定的原因码。
        const reason = error && error.name === 'AbortError' ? 'timeout' : 'request_failed';
        return fallback(list, reason);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  hashEmbedding,
  cosine,
  createRemoteEmbedder,
};
