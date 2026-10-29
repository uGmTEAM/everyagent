'use strict';

/**
 * 治理层 · 配额（§12 quota_usage_ratio / §9.2 step6 quota_release_done）
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §12   quota_usage_ratio 分项：storage_ratio / item_count_ratio /
 *           parse_ratio / index_ratio / token_ratio（契约未给数值上限）；
 *   - §9.2  step6 quota_release_done 释放配额；
 *   - § 19/附录 A  quota_usage 物理表。
 *
 * DDL 取舍（不修改 ddl.js）：
 *   附录 A 的 quota_usage 只有 storage_bytes/item_count/parse_count/index_count/token_count，
 *   而本任务要求 recall_calls / write_calls 两个维度。这里在首次使用时用
 *   ALTER TABLE ADD COLUMN 惰性补齐两列（幂等、不新建表），其余维度映射既有列。
 *   契约未给任何维度数值上限，故默认上限为 Infinity，由部署配置经 configureLimits 覆盖；
 *   consume 也允许单次传 limit 覆盖（§12 只定义了 ratio 指标口径）。
 */

const DEFAULT_NOW = () => new Date().toISOString();

// 维度 → quota_usage 列（列名来自白名单，禁止调用方拼接 SQL）
const DIMENSION_COLUMNS = Object.freeze({
  memory_items: 'item_count',
  storage_bytes: 'storage_bytes',
  recall_calls: 'recall_calls', // 惰性补列
  write_calls: 'write_calls', // 惰性补列
  parse_calls: 'parse_count',
  index_calls: 'index_count',
  tokens: 'token_count',
});

// §12 只给 ratio 分项，未给阈值；默认不设限，等待部署配置
const limits = {
  memory_items: Infinity,
  storage_bytes: Infinity,
  recall_calls: Infinity,
  write_calls: Infinity,
  parse_calls: Infinity,
  index_calls: Infinity,
  tokens: Infinity,
};

const readyStores = new WeakSet();

function ensureColumns(store) {
  if (readyStores.has(store)) return;
  const columns = new Set(
    store.all('PRAGMA table_info(quota_usage)').map((column) => column.name)
  );
  if (!columns.has('recall_calls')) {
    store.run('ALTER TABLE quota_usage ADD COLUMN recall_calls INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('write_calls')) {
    store.run('ALTER TABLE quota_usage ADD COLUMN write_calls INTEGER NOT NULL DEFAULT 0');
  }
  readyStores.add(store);
}

function columnFor(dimension) {
  const column = DIMENSION_COLUMNS[dimension];
  if (!column) {
    return {
      ok: false,
      code: 'INVALID_DIMENSION',
      message: `未知配额维度: ${dimension}（支持: ${Object.keys(DIMENSION_COLUMNS).join(', ')}）`,
    };
  }
  return { ok: true, column };
}

function checkAgent(store, agentId) {
  if (agentId && store?.agentId && String(agentId) !== String(store.agentId)) {
    return {
      ok: false,
      code: 'AGENT_SCOPE_MISMATCH',
      message: '配额库按 agent 隔离；agent_id 与 store.agentId 不一致',
    };
  }
  return { ok: true };
}

function ensureRow(store, userId, now) {
  store.run(
    'INSERT OR IGNORE INTO quota_usage (user_id, created_at) VALUES (?, ?)',
    userId,
    now
  );
}

function readUsed(store, userId, column) {
  return Number(store.get(
    `SELECT COALESCE(${column}, 0) AS used FROM quota_usage WHERE user_id = ?`,
    userId
  )?.used ?? 0);
}

function resolveLimit(dimension, override) {
  if (override === Infinity) return Infinity;
  const value = Number(override);
  if (Number.isFinite(value) && value >= 0) return value;
  return limits[dimension] ?? Infinity;
}

function snapshot(dimension, used, limit) {
  const finite = Number.isFinite(limit);
  return {
    dimension,
    used,
    limit: finite ? limit : null,
    remaining: finite ? Math.max(0, limit - used) : null,
    ratio: finite && limit > 0 ? used / limit : 0,
  };
}

/**
 * 原子累加配额。
 * @returns {{ok:true,dimension,used,limit,remaining,ratio}|{ok:false,code:string,...}}
 */
function consume(store, {
  user_id,
  agent_id,
  dimension,
  amount,
  now = DEFAULT_NOW(),
  limit,
} = {}) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('consume: store 必须由 getStore() 返回');
  }
  if (!user_id) return { ok: false, code: 'INVALID_PAYLOAD', message: '§3.1 user_id 必填' };

  const agentCheck = checkAgent(store, agent_id);
  if (!agentCheck.ok) return agentCheck;

  const dimensionCheck = columnFor(dimension);
  if (!dimensionCheck.ok) return dimensionCheck;
  const column = dimensionCheck.column;

  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta < 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'consume amount 必须是 >= 0 的有限数' };
  }

  const effectiveLimit = resolveLimit(dimension, limit);
  ensureColumns(store);
  ensureRow(store, user_id, now);

  if (Number.isFinite(effectiveLimit)) {
    // 条件更新：used + amount <= limit 才成功，失败即超限（SQLite 单语句原子）
    const result = store.run(
      `UPDATE quota_usage
          SET ${column} = COALESCE(${column}, 0) + ?, updated_at = ?
        WHERE user_id = ?
          AND COALESCE(${column}, 0) + ? <= ?`,
      delta,
      now,
      user_id,
      delta,
      effectiveLimit
    );
    if (Number(result.changes ?? 0) === 0) {
      const used = readUsed(store, user_id, column);
      return {
        ok: false,
        code: 'QUOTA_EXCEEDED',
        dimension,
        used,
        limit: effectiveLimit,
        requested: delta,
        ...snapshot(dimension, used, effectiveLimit),
      };
    }
  } else {
    store.run(
      `UPDATE quota_usage
          SET ${column} = COALESCE(${column}, 0) + ?, updated_at = ?
        WHERE user_id = ?`,
      delta,
      now,
      user_id
    );
  }

  const used = readUsed(store, user_id, column);
  return { ok: true, ...snapshot(dimension, used, effectiveLimit) };
}

/**
 * 查询当前用量与上限（不累加）。
 * 不传 dimension 时返回全部维度快照。
 */
function usage(store, { user_id, agent_id, dimension, limit } = {}) {
  if (!store || typeof store.get !== 'function') {
    throw new TypeError('usage: store 必须由 getStore() 返回');
  }
  if (!user_id) return { ok: false, code: 'INVALID_PAYLOAD', message: '§3.1 user_id 必填' };

  const agentCheck = checkAgent(store, agent_id);
  if (!agentCheck.ok) return agentCheck;

  ensureColumns(store);
  const row = store.get('SELECT * FROM quota_usage WHERE user_id = ?', user_id);

  if (dimension) {
    const dimensionCheck = columnFor(dimension);
    if (!dimensionCheck.ok) return dimensionCheck;
    const column = dimensionCheck.column;
    const used = Number(row?.[column] ?? 0);
    const effectiveLimit = resolveLimit(dimension, limit);
    return {
      ok: true,
      user_id,
      ...snapshot(dimension, used, effectiveLimit),
    };
  }

  const dimensions = {};
  for (const [name, column] of Object.entries(DIMENSION_COLUMNS)) {
    dimensions[name] = snapshot(name, Number(row?.[column] ?? 0), resolveLimit(name, undefined));
  }
  return { ok: true, user_id, dimensions };
}

/**
 * 释放配额（§9.2 step6）：原子减量并夹紧到 0，不做超限校验。
 */
function release(store, {
  user_id,
  agent_id,
  dimension,
  amount,
  now = DEFAULT_NOW(),
} = {}) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('release: store 必须由 getStore() 返回');
  }
  if (!user_id) return { ok: false, code: 'INVALID_PAYLOAD', message: '§3.1 user_id 必填' };

  const agentCheck = checkAgent(store, agent_id);
  if (!agentCheck.ok) return agentCheck;

  const dimensionCheck = columnFor(dimension);
  if (!dimensionCheck.ok) return dimensionCheck;
  const column = dimensionCheck.column;

  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta < 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'release amount 必须是 >= 0 的有限数' };
  }

  ensureColumns(store);
  ensureRow(store, user_id, now);
  store.run(
    `UPDATE quota_usage
        SET ${column} = MAX(0, COALESCE(${column}, 0) - ?), updated_at = ?
      WHERE user_id = ?`,
    delta,
    now,
    user_id
  );
  const used = readUsed(store, user_id, column);
  return { ok: true, ...snapshot(dimension, used, resolveLimit(dimension, undefined)) };
}

/** 部署级上限配置（合并覆盖）。 */
function configureLimits(overrides = {}) {
  for (const [dimension, value] of Object.entries(overrides)) {
    if (!DIMENSION_COLUMNS[dimension]) continue;
    if (value === Infinity) {
      limits[dimension] = Infinity;
      continue;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) limits[dimension] = numeric;
  }
  return { ...limits };
}

function getLimits() {
  return { ...limits };
}

function resetLimits() {
  for (const dimension of Object.keys(limits)) limits[dimension] = Infinity;
  return { ...limits };
}

module.exports = {
  DIMENSIONS: Object.freeze(Object.keys(DIMENSION_COLUMNS)),
  consume,
  usage,
  release,
  configureLimits,
  getLimits,
  resetLimits,
};
