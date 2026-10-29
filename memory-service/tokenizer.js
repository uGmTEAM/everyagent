'use strict';

/**
 * Token 估算与截断工具（§5.1 不硬截断、§5.3/§5.4 estimate_tokens、§12 compression_ratio）。
 *
 * 重要：契约要求 tiktoken cl100k_base。此处为零依赖近似实现，接口与契约一致，可替换：
 *   - CJK（中日韩文字与全角标点）按 1 字 ≈ 1 token；
 *   - 其他字符（ASCII/拉丁/符号）按 4 字符 ≈ 1 token；
 *   - 混合文本分段累计后向上取整。
 * 该实现无网络、无第三方依赖，同输入必同输出。
 */

/**
 * 判断单个字符（code point）是否属于 CJK 宽字符区。
 * 覆盖：CJK 部首/标点、假名、注音、韩文、CJK 统一表意文字（含扩展 A）、兼容表意文字。
 */
function isCjkChar(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x2e80 && code <= 0x2eff) || // CJK 部首补充
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点（全角）
    (code >= 0x3040 && code <= 0x30ff) || // 平假名/片假名
    (code >= 0x3100 && code <= 0x312f) || // 注音
    (code >= 0x31a0 && code <= 0x31bf) || // 注音扩展
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0xac00 && code <= 0xd7af) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
    (code >= 0xfe30 && code <= 0xfe4f) // CJK 兼容形式
  );
}

/**
 * 估算文本 token 数（§5.4 estimate_tokens 的零依赖近似）。
 * @param {string|number|null|undefined} text
 * @returns {number} 非负整数
 */
function estimateTokens(text) {
  if (text === null || text === undefined) return 0;
  const str = typeof text === 'string' ? text : String(text);
  if (str.length === 0) return 0;

  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    if (isCjkChar(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 估算 messages 的 token 数（用于上下文预算核对）。
 * 契约未给每条消息的固定开销数值，采用默认并可配置（默认 4 tokens/条）。
 * @param {Array<string|{role?:string, content?:string|Array}>} messages
 * @param {{perMessageOverhead?:number}} [opts]
 * @returns {number}
 */
function estimateMessagesTokens(messages, opts) {
  if (!Array.isArray(messages)) return 0;
  const overhead =
    opts && Number.isFinite(opts.perMessageOverhead) && opts.perMessageOverhead >= 0
      ? Math.floor(opts.perMessageOverhead)
      : 4;

  let total = 0;
  for (const message of messages) {
    total += overhead;
    if (typeof message === 'string') {
      total += estimateTokens(message);
      continue;
    }
    if (!message || typeof message !== 'object') continue;

    total += estimateTokens(message.role);
    const content = message.content;
    if (typeof content === 'string') {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') {
          total += estimateTokens(part);
        } else if (part && typeof part === 'object') {
          total += estimateTokens(part.text !== undefined ? part.text : part.content);
        }
      }
    } else if (content !== null && content !== undefined) {
      total += estimateTokens(content);
    }
  }
  return total;
}

/**
 * 按 token 上限截断文本（仅工具函数；组装器 §5.1 禁止硬截断 evidence_id）。
 * 截断点保证落在字符边界；同输入同输出。
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
function truncateToTokens(text, maxTokens) {
  if (text === null || text === undefined) return '';
  const str = typeof text === 'string' ? text : String(text);
  const max = Math.floor(Number(maxTokens));
  if (!Number.isFinite(max) || max <= 0) return '';
  if (estimateTokens(str) <= max) return str;

  let cjk = 0;
  let other = 0;
  let endIndex = 0;
  for (const ch of str) {
    const nextCjk = cjk + (isCjkChar(ch) ? 1 : 0);
    const nextOther = other + (isCjkChar(ch) ? 0 : 1);
    if (nextCjk + Math.ceil(nextOther / 4) > max) break;
    cjk = nextCjk;
    other = nextOther;
    endIndex += ch.length;
  }
  return str.slice(0, endIndex);
}

module.exports = {
  estimateTokens,
  estimateMessagesTokens,
  truncateToTokens,
};
