'use strict';

/**
 * 治理层 · 召回缓存键 / ACL / TTL / page_token
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §8.1  recall_cache_key 与 acl_hash / resource_acl_versions_hash；
 *   - §8.2  命中校验（schema_version / caller_acl_version / 资源 ACL / acl_hash_at_write）；
 *   - §8.3  TTL（S1 300s/高频 60s/上限 600s；S2 默认不缓存；S3 禁止）；
 *   - §16.2 page_token TTL=300s。
 *
 * 物理落点取舍：
 *   ddl.js 的附录 A 未单列缓存表（ddl.TABLES 共 26 张，无 cache 表）。
 *   因此本文件不新建表：缓存值放进程内 LRU（上限可配），命中/未命中事件写入
 *   既有 recall_log（recall_cache_key / cache_hit / acl_hash_at_write /
 *   resource_acl_versions_hash / cache_expires_at 字段正好覆盖 §8.2）。
 *   多进程场景下缓存不共享，属于契约允许的“隔离存储”取舍。
 */

const crypto = require('node:crypto');
const {
  CACHE_TTL,
  SENSITIVITY,
  PAGE_TOKEN_TTL_SECONDS,
  AUDIT_ACTION,
} = require('./constants');

const DEFAULT_MAX_ENTRIES = 500;
const KEY_PREFIX = 'recall_cache.v4.1:';
const QUERY_NORMALIZER_VERSION = 'query_norm_v1';

// §8.3：仅 recall 允许缓存；S2 默认关闭，S3 与这些场景禁止
const CACHEABLE_SCENARIOS = new Set(['recall', 's1']);
const FORBIDDEN_SCENARIOS = new Set(['search_raw', 'audit', 'export']);

const SENSITIVITY_SET = new Set(Object.values(SENSITIVITY));

// ---------------------------------------------------------------------------
// 进程内 LRU（不新建表）
// ---------------------------------------------------------------------------

let maxEntries = DEFAULT_MAX_ENTRIES;
const lru = new Map(); // key -> entry（Map 插入序即 LRU 序）
const keyMeta = new Map(); // key -> buildKey 的归一化输入（供 put 判断 scenario）
const stats = { hits: 0, misses: 0, evictions: 0, skipped: 0 };
let eventSeq = 0;

function configure({ max_entries } = {}) {
  const next = Number(max_entries);
  if (Number.isFinite(next) && next > 0) {
    maxEntries = Math.floor(next);
    evictIfNeeded();
  }
  return { max_entries: maxEntries };
}

function evictIfNeeded() {
  while (lru.size > maxEntries) {
    const oldest = lru.keys().next().value;
    lru.delete(oldest);
    stats.evictions += 1;
  }
  const metaLimit = maxEntries * 2;
  while (keyMeta.size > metaLimit) {
    keyMeta.delete(keyMeta.keys().next().value);
  }
}

function clear() {
  lru.clear();
  keyMeta.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.evictions = 0;
  stats.skipped = 0;
}

function cacheStats() {
  return { ...stats, size: lru.size, max_entries: maxEntries };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** §8.1：NFKC + lower + 去首尾空白 + 连续空白折叠。 */
function normalizeQuery(query) {
  return String(query ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function toEpochSeconds(now) {
  if (now === null || now === undefined) return Math.floor(Date.now() / 1000);
  if (now instanceof Date) return Math.floor(now.getTime() / 1000);
  if (typeof now === 'number') return Math.floor(now > 1e12 ? now / 1000 : now);
  const parsed = Date.parse(String(now));
  if (Number.isNaN(parsed)) throw new TypeError(`非法时间: ${now}`);
  return Math.floor(parsed / 1000);
}

function isoFromSeconds(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSensitivity(value, fallback = SENSITIVITY.S2) {
  if (value === null || value === undefined || value === '') return fallback;
  if (!SENSITIVITY_SET.has(value)) throw new TypeError(`非法敏感分级: ${value}`);
  return value;
}

// ---------------------------------------------------------------------------
// ACL 哈希（§8.1）
// ---------------------------------------------------------------------------

function extractAclVersion(resource) {
  if (resource === null || resource === undefined) return 0;
  if (typeof resource === 'number') return resource;
  if (typeof resource === 'string' && resource.trim() !== '' && Number.isFinite(Number(resource))) {
    return Number(resource);
  }
  if (isPlainObject(resource)) {
    const version = resource?.governance?.acl_version ?? resource.acl_version;
    if (version !== undefined && version !== null && Number.isFinite(Number(version))) {
      return Number(version);
    }
  }
  return 0;
}

/** §8.1 resource_acl_versions_hash = sha256(sorted([acl_version...])) */
function resourceVersionsHash(resources = []) {
  const versions = (Array.isArray(resources) ? resources : [resources])
    .map(extractAclVersion)
    .sort((a, b) => a - b);
  return `sha256:${sha256Hex(versions.join(','))}`;
}

/** §8.1 acl_hash（caller 侧） */
function callerAclHash(callerAcl = {}) {
  const roles = uniqueSorted(callerAcl.roles);
  const scopes = uniqueSorted(callerAcl.scope_allow_list ?? callerAcl.scope_allow);
  const parts = [
    callerAcl.user_id ?? '',
    callerAcl.tenant_id ?? '',
    callerAcl.org_id ?? '',
    roles.join(','),
    String(callerAcl.sensitivity_max ?? 'S1'),
    callerAcl.purpose ?? '',
    scopes.join(','),
    String(callerAcl.caller_acl_version ?? 1),
  ];
  return `sha256:${sha256Hex(parts.join('|'))}`;
}

function uniqueSorted(list) {
  return [...new Set((Array.isArray(list) ? list : (list === undefined || list === null ? [] : [list]))
    .map((entry) => String(entry)))].sort();
}

/**
 * 稳定 ACL 哈希。
 *   - 传数组（资源列表/ACL 版本列表）→ §8.1 resource_acl_versions_hash；
 *   - 传调用者 ACL 对象 → §8.1 acl_hash（即缓存值里的 acl_hash_at_write）。
 */
function aclHashAtWrite(resourceAcl) {
  if (Array.isArray(resourceAcl)) return resourceVersionsHash(resourceAcl);
  if (isPlainObject(resourceAcl)) return callerAclHash(resourceAcl);
  return resourceVersionsHash([]);
}

// ---------------------------------------------------------------------------
// 缓存键（§8.1 + 任务要求 caller/resource ACL 分离）
// ---------------------------------------------------------------------------

/**
 * 生成可复现的 recall_cache_key。
 *
 * 必含：user_id / agent_id / 归一化 query / scenario / top_k / budget /
 *       sensitivity_max / caller_acl_version / resource_acl_versions_hash /
 *       schema_version。
 *
 * 说明：§8.1 原文只把 caller_acl_version 放进 key，把 resource ACL 版本放在缓存值里
 * 命中时重算；任务要求 key 同时包含两者并“分离”，因此这里额外把
 * resource_acl_versions_hash 放进 key（更严格：资源 ACL 变化直接换 key）。
 */
function buildKey(parts = {}) {
  if (!isPlainObject(parts)) throw new TypeError('buildKey: parts 必须是对象');
  if (!parts.user_id) throw new TypeError('buildKey: user_id 必填');
  if (!parts.agent_id) throw new TypeError('buildKey: agent_id 必填');

  const resourceAcl = parts.resource_acl_versions ?? parts.resource_acl;
  const resourceHash = parts.resource_acl_versions_hash
    ?? (resourceAcl !== undefined ? resourceVersionsHash(resourceAcl) : '');

  const meta = {
    user_id: String(parts.user_id),
    agent_id: String(parts.agent_id),
    tenant_id: parts.tenant_id == null ? '' : String(parts.tenant_id),
    org_id: parts.org_id == null ? '' : String(parts.org_id),
    session_id: parts.session_id == null ? '' : String(parts.session_id),
    query: normalizeQuery(parts.query ?? parts.normalized_query),
    query_normalizer_version: QUERY_NORMALIZER_VERSION,
    scenario: normalizeScenario(parts.scenario ?? parts.injection_mode ?? 'recall'),
    top_k: Number.isFinite(Number(parts.top_k)) ? Number(parts.top_k) : null,
    budget: parts.budget ?? parts.token_budget ?? null,
    sensitivity_max: String(parts.sensitivity_max ?? 'S1'),
    purpose: parts.purpose == null ? '' : String(parts.purpose),
    caller_acl_version: Number.isFinite(Number(parts.caller_acl_version))
      ? Number(parts.caller_acl_version)
      : 1,
    resource_acl_versions_hash: String(resourceHash),
    schema_version: String(parts.schema_version ?? CACHE_TTL.CACHE_SCHEMA_VERSION),
  };

  const key = `${KEY_PREFIX}${sha256Hex(stableStringify(meta))}`;
  keyMeta.set(key, meta);
  evictIfNeeded();
  return key;
}

function normalizeScenario(scenario) {
  return String(scenario ?? 'recall').toLowerCase();
}

// ---------------------------------------------------------------------------
// recall_log 事件（不新建缓存表）
// ---------------------------------------------------------------------------

function recordCacheEvent(store, {
  key,
  user_id,
  agent_id,
  hit,
  reason,
  caller_acl_version,
  acl_hash_at_write,
  resource_acl_versions_hash,
  expires_at,
  now,
  request_id,
}) {
  if (!store || typeof store.run !== 'function') return null;
  const requestId = request_id
    ?? `cache_${key.slice(-12)}_${toEpochSeconds(now)}_${eventSeq++}`;
  try {
    store.run(
      `INSERT INTO recall_log
        (request_id, mem_id, user_id, agent_id, recall_cache_key,
         caller_acl_version, acl_hash_at_write, resource_acl_versions_hash,
         cache_expires_at, cache_hit, created_at)
       VALUES (?, '__cache__', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requestId,
      String(user_id),
      agent_id === null || agent_id === undefined ? null : String(agent_id),
      key,
      caller_acl_version === undefined ? null : Number(caller_acl_version),
      acl_hash_at_write ?? null,
      resource_acl_versions_hash ?? null,
      expires_at ?? null,
      hit ? 1 : 0,
      now ?? new Date().toISOString()
    );
    return requestId;
  } catch {
    // recall_log 是观测表：写入失败不得影响缓存判定
    return null;
  }
}

function recordAclMismatch(store, { key, callerAcl, reason, now }) {
  if (!store || typeof store.run !== 'function') return null;
  try {
    // 延迟 require，避免 audit.js 与 cache.js 形成硬耦合
    const audit = require('./audit');
    return audit.append(store, {
      user_id: callerAcl?.user_id,
      agent_id: callerAcl?.agent_id,
      action: AUDIT_ACTION.CACHE_ACL_MISMATCH,
      target_type: 'recall_cache',
      target_id: key,
      reason,
      sensitivity: callerAcl?.sensitivity_max ?? SENSITIVITY.S2,
      actor: { type: 'system', id: 'cache' },
      now,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// get / put（§8.2 / §8.3）
// ---------------------------------------------------------------------------

function resolveTtlSeconds(sensitivity, { ttl_seconds, high_freq } = {}) {
  if (sensitivity === SENSITIVITY.S2) return CACHE_TTL.S2_TTL_SECONDS;
  if (high_freq) return CACHE_TTL.S1_SESSION_HIGH_FREQ_SECONDS;
  const requested = Number(ttl_seconds);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(1, Math.min(Math.floor(requested), CACHE_TTL.S1_MAX_SECONDS));
  }
  return CACHE_TTL.S1_DEFAULT_SECONDS;
}

function isExpired(entry, now) {
  const nowSec = toEpochSeconds(now);
  const expiresSec = Date.parse(entry.expires_at) / 1000;
  return Number.isFinite(expiresSec) && nowSec >= expiresSec;
}

/**
 * 按 §8.2 校验资源 ACL：mem_ids 必须仍存在且非 tombstone，ACL 版本哈希一致。
 * 返回 {ok:true} 或 {ok:false, reason}。
 */
function validateResources(store, entry) {
  const memIds = entry?.value?.mem_ids;
  if (!Array.isArray(memIds) || memIds.length === 0) return { ok: true };
  if (!store || typeof store.all !== 'function') return { ok: true };

  const placeholders = memIds.map(() => '?').join(',');
  let rows = [];
  try {
    rows = store.all(
      `SELECT mem_id, acl_version, lifecycle_state FROM memory_item
        WHERE mem_id IN (${placeholders}) ORDER BY mem_id`,
      ...memIds
    );
  } catch {
    return { ok: false, reason: 'resource_lookup_failed' };
  }
  if (rows.length !== memIds.length) return { ok: false, reason: 'resource_missing' };

  const versions = [];
  for (const row of rows) {
    if (['deleted_tombstone', 'deleted_pending', 'superseded'].includes(row.lifecycle_state)) {
      return { ok: false, reason: 'resource_not_recallable' };
    }
    versions.push(Number(row.acl_version ?? 0));
  }
  const currentHash = `sha256:${sha256Hex(versions.sort((a, b) => a - b).join(','))}`;
  if (entry.resource_acl_versions_hash && entry.resource_acl_versions_hash !== currentHash) {
    return { ok: false, reason: 'resource_acl_versions' };
  }
  return { ok: true };
}

/**
 * 命中读取。
 * 新契约：get({store, key, callerAcl, now, request_id})
 * 兼容 retrieval.js 的旧调用：get(key) → 返回缓存值或 null（§8.2 校验由 retrieval 自己完成）。
 */
function get(input) {
  if (typeof input === 'string') return legacyGet(input);
  if (!isPlainObject(input)) throw new TypeError('cache.get: 参数必须是对象或 key 字符串');

  const {
    store,
    key,
    callerAcl,
    now = new Date().toISOString(),
    request_id,
  } = input;
  if (!key) throw new TypeError('cache.get: key 必填');
  if (!isPlainObject(callerAcl)) throw new TypeError('cache.get: callerAcl 必填（§8.2 命中校验）');

  const meta = keyMeta.get(key) ?? null;
  const entry = lru.get(key);
  const userId = callerAcl.user_id ?? meta?.user_id;
  const agentId = callerAcl.agent_id ?? meta?.agent_id ?? store?.agentId;

  const miss = (reason) => {
    stats.misses += 1;
    recordCacheEvent(store, {
      key,
      user_id: userId,
      agent_id: agentId,
      hit: false,
      reason,
      caller_acl_version: callerAcl.caller_acl_version,
      acl_hash_at_write: entry?.acl_hash_at_write,
      resource_acl_versions_hash: entry?.resource_acl_versions_hash,
      expires_at: entry?.expires_at,
      now,
      request_id,
    });
    return { hit: false, key, reason };
  };

  if (!entry) return miss('not_found');
  if (isExpired(entry, now)) {
    lru.delete(key);
    return miss('expired');
  }

  const cacheSchema = entry.value?.cache_schema_version ?? entry.schema_version;
  if (cacheSchema !== CACHE_TTL.CACHE_SCHEMA_VERSION) return miss('schema_version');

  if (Number(entry.caller_acl_version ?? 1) !== Number(callerAcl.caller_acl_version ?? 1)) {
    recordAclMismatch(store, { key, callerAcl, reason: 'caller_acl_version', now });
    return miss('acl_mismatch');
  }

  const currentAclHash = callerAclHash(callerAcl);
  if (!entry.acl_hash_at_write || entry.acl_hash_at_write !== currentAclHash) {
    recordAclMismatch(store, { key, callerAcl, reason: 'acl_hash', now });
    return miss('acl_mismatch');
  }

  const resourceCheck = validateResources(store, entry);
  if (!resourceCheck.ok) {
    recordAclMismatch(store, { key, callerAcl, reason: resourceCheck.reason, now });
    return miss('acl_mismatch');
  }

  // 命中后刷新 LRU 顺序
  lru.delete(key);
  lru.set(key, entry);
  stats.hits += 1;
  recordCacheEvent(store, {
    key,
    user_id: userId,
    agent_id: agentId,
    hit: true,
    reason: 'hit',
    caller_acl_version: callerAcl.caller_acl_version,
    acl_hash_at_write: entry.acl_hash_at_write,
    resource_acl_versions_hash: entry.resource_acl_versions_hash,
    expires_at: entry.expires_at,
    now,
    request_id,
  });

  return {
    hit: true,
    key,
    value: entry.value,
    expires_at: entry.expires_at,
    created_at: entry.created_at,
    acl_hash_at_write: entry.acl_hash_at_write,
    resource_acl_versions_hash: entry.resource_acl_versions_hash,
    sensitivity: entry.sensitivity,
  };
}

/**
 * 写入缓存。
 *
 * §8.3 门禁：
 *   - S3 禁止缓存；
 *   - S2 默认不缓存（allow_s2=true 时才允许，TTL 60s）；
 *   - search_raw / audit / export 禁止缓存；
 *   - 仅 recall 类型可缓存。
 */
function put({
  store,
  key,
  value,
  callerAcl,
  now = new Date().toISOString(),
  sensitivity,
  scenario,
  request_id,
  ttl_seconds,
  high_freq,
  allow_s2 = false,
  resource_acl_versions,
} = {}) {
  if (!key) throw new TypeError('cache.put: key 必填');
  if (value === null || value === undefined) {
    stats.skipped += 1;
    return { ok: false, cached: false, code: 'EMPTY_VALUE', reason: 'value 为空' };
  }
  if (!isPlainObject(callerAcl)) throw new TypeError('cache.put: callerAcl 必填');

  const meta = keyMeta.get(key) ?? null;
  const effectiveScenario = normalizeScenario(scenario ?? meta?.scenario ?? 'recall');
  const level = normalizeSensitivity(
    sensitivity ?? value?.cache_sensitivity ?? value?.sensitivity ?? callerAcl.sensitivity_max,
    SENSITIVITY.S2
  );

  const skipped = (code, reason) => {
    stats.skipped += 1;
    if (store) {
      recordCacheEvent(store, {
        key,
        user_id: callerAcl.user_id ?? meta?.user_id,
        agent_id: callerAcl.agent_id ?? meta?.agent_id ?? store.agentId,
        hit: false,
        reason: code,
        caller_acl_version: callerAcl.caller_acl_version,
        acl_hash_at_write: null,
        resource_acl_versions_hash: null,
        expires_at: null,
        now,
        request_id,
      });
    }
    return { ok: false, cached: false, code, reason };
  };

  if (FORBIDDEN_SCENARIOS.has(effectiveScenario)) {
    return skipped('SCENARIO_FORBIDDEN', `§8.3 ${effectiveScenario} 禁止缓存`);
  }
  if (!CACHEABLE_SCENARIOS.has(effectiveScenario)) {
    return skipped('SCENARIO_NOT_CACHEABLE', `§8.3 场景 ${effectiveScenario} 不在允许缓存列表`);
  }
  if (level === SENSITIVITY.S3) {
    return skipped('S3_FORBIDDEN', '§8.3 S3 禁止缓存');
  }
  if (level === SENSITIVITY.S2 && allow_s2 !== true) {
    return skipped('S2_DEFAULT_DISABLED', '§8.3 S2 默认不缓存（需显式 allow_s2）');
  }

  const ttlSeconds = resolveTtlSeconds(level, { ttl_seconds, high_freq });
  const createdAt = now;
  const expiresAt = isoFromSeconds(toEpochSeconds(now) + ttlSeconds);

  const aclHash = callerAclHash(callerAcl);
  const resourceHash = value?.resource_acl_versions_hash
    ?? (resource_acl_versions !== undefined ? resourceVersionsHash(resource_acl_versions) : '');

  const entry = {
    value,
    created_at: createdAt,
    expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    sensitivity: level,
    scenario: effectiveScenario,
    acl_hash_at_write: aclHash,
    caller_acl_version: Number(callerAcl.caller_acl_version ?? 1),
    resource_acl_versions_hash: resourceHash,
    user_id: callerAcl.user_id ?? meta?.user_id ?? null,
    agent_id: callerAcl.agent_id ?? meta?.agent_id ?? store?.agentId ?? null,
    schema_version: value?.cache_schema_version ?? CACHE_TTL.CACHE_SCHEMA_VERSION,
  };

  lru.delete(key);
  lru.set(key, entry);
  evictIfNeeded();

  return {
    ok: true,
    cached: true,
    key,
    expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    sensitivity: level,
  };
}

// ---------------------------------------------------------------------------
// retrieval.js 兼容层（只读既有接口假定：get(key) / set(key,value,ttl)）
//
// 【取舍：旧接口显式 no-op，不参与实际缓存】
//   retrieval.js 的 computeCacheKey 只接收 query/filters/top_k 等字段，无法拿到
//   token_budget 与 now；而缓存命中分支是 `{...cached.cached, request_id}`，会把
//   写入时的 budget / used_tokens 直接回放给预算不同的请求（§5.4 要求
//   used_tokens <= budget），并把 mem_ids / acl_hash_at_write 等内部字段泄漏进
//   §6 响应体，破坏 §5.1 逐字节确定性。由于约束禁止修改 retrieval.js，
//   这里让旧接口退化为“始终回源”，行为等价于 cache.js 不存在时；
//   需要缓存能力的调用方必须使用契约接口
//   get({store,key,callerAcl,now}) / put({store,key,value,callerAcl,now})。
// ---------------------------------------------------------------------------

const LEGACY_SHIM_DISABLED_REASON =
  'retrieval.js 旧接口缓存键不含 token_budget/now，命中会回放错误预算并泄漏缓存内部字段（§5.1/§5.4/§6）';

function legacyGet() {
  return null;
}

function set() {
  return false;
}

function legacyStatus() {
  return { enabled: false, reason: LEGACY_SHIM_DISABLED_REASON };
}

// ---------------------------------------------------------------------------
// page_token（§16.2，TTL=300s，防重放）
// ---------------------------------------------------------------------------

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function digest(secret, body) {
  return crypto.createHmac('sha256', String(secret)).update(body).digest();
}

// nonce -> 过期秒；仅进程内。多进程/重启后防重放能力有限，契约未要求持久化。
const usedNonces = new Map();

function purgeNonces(nowSec) {
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt <= nowSec) usedNonces.delete(nonce);
  }
  // 防御性上限：避免长期运行内存无界
  while (usedNonces.size > 10000) {
    usedNonces.delete(usedNonces.keys().next().value);
  }
}

/**
 * 签发 page_token。
 * @param {object} payload 分页载荷（不许含原文以外的限制由调用方负责）
 * @param {string} secret 签名密钥
 * @param {string|number|Date} [now] 冻结时间
 * @returns {string} token
 */
function signPageToken(payload, secret, now) {
  if (!isPlainObject(payload)) throw new TypeError('signPageToken: payload 必须是对象');
  if (!secret || typeof secret !== 'string') throw new TypeError('signPageToken: secret 必填');
  const iat = toEpochSeconds(now);
  const exp = iat + PAGE_TOKEN_TTL_SECONDS;
  const body = base64url(stableStringify({
    ...payload,
    iat,
    exp,
    nonce: crypto.randomBytes(12).toString('hex'),
  }));
  const signature = base64url(digest(secret, body));
  return `${body}.${signature}`;
}

/**
 * 校验 page_token：签名 / 过期 / 重放。
 * @returns {{ok:true,payload:object}|{ok:false,code:string,message:string}}
 */
function verifyPageToken(token, secret, now) {
  if (!secret || typeof secret !== 'string') throw new TypeError('verifyPageToken: secret 必填');
  if (!token || typeof token !== 'string') {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: 'token 为空' };
  }
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: 'token 结构非法' };
  }

  const [body, signature] = pieces;
  const expected = digest(secret, body);
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: '签名编码非法' };
  }
  // base64url 末尾字符存在未使用的填充位：末位字符被改动后仍可能解码出同一字节串。
  // 因此要求签名必须是规范编码，否则视为篡改（MALFORMED），避免“改末位仍通过”。
  if (base64url(actual) !== signature) {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: '签名不是规范 base64url 编码' };
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, code: 'PAGE_TOKEN_INVALID_SIGNATURE', message: '签名不匹配' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: '载荷不是合法 JSON' };
  }
  if (!isPlainObject(payload) || !Number.isFinite(payload.iat)
      || !Number.isFinite(payload.exp) || typeof payload.nonce !== 'string') {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: '载荷缺少 iat/exp/nonce' };
  }
  if (payload.exp - payload.iat > PAGE_TOKEN_TTL_SECONDS) {
    return { ok: false, code: 'PAGE_TOKEN_MALFORMED', message: 'TTL 超过 300s' };
  }

  const nowSec = toEpochSeconds(now);
  purgeNonces(nowSec);
  if (nowSec > payload.exp) {
    return { ok: false, code: 'PAGE_TOKEN_EXPIRED', message: '§16.2 page_token 已过期' };
  }
  if (usedNonces.has(payload.nonce)) {
    return { ok: false, code: 'PAGE_TOKEN_REPLAY', message: '防重放：nonce 已使用' };
  }
  usedNonces.set(payload.nonce, payload.exp);
  return { ok: true, payload };
}

function clearPageTokenNonces() {
  usedNonces.clear();
}

module.exports = {
  buildKey,
  aclHashAtWrite,
  callerAclHash,
  resourceVersionsHash,
  normalizeQuery,
  get,
  put,
  set, // retrieval.js 兼容（显式 no-op，见上方取舍说明）
  legacyStatus,
  configure,
  stats: cacheStats,
  clear,
  signPageToken,
  verifyPageToken,
  clearPageTokenNonces,
  PAGE_TOKEN_TTL_SECONDS,
};
