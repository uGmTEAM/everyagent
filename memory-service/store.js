'use strict';

// 记忆存储：每个 AI 一个独立的 SQLite 文件，放在该 AI 容器的工作区内。
// 宿主机路径：data/agents/<agent_id>/workspace/.memory/memory.db
// 容器内路径：/workspace/.memory/memory.db（同一个挂载卷，AI 可见）
// 契约依据：§3（作用域隔离，agent_id 独立库即天然隔离）、§17（物理表）、§28 附录 A

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ddl = require('./ddl');
const { SCHEMA_VERSION } = require('./constants');

const STORE_DIR_NAME = '.memory';
const DB_FILE_NAME = 'memory.db';
const USER_VERSION = 410; // 契约 v4.1

const cache = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveDbFile(workspaceDir) {
  return path.join(workspaceDir, STORE_DIR_NAME, DB_FILE_NAME);
}

function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

function runMigrations(db) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (current >= USER_VERSION) return { migrated: false, from: current, to: current };
  for (const sql of ddl.statements) {
    db.exec(sql);
  }
  db.exec(`PRAGMA user_version = ${USER_VERSION}`);
  return { migrated: true, from: current, to: USER_VERSION };
}

function createStore({ agentId, workspaceDir }) {
  if (!agentId) throw new Error('agentId 必填');
  if (!workspaceDir) throw new Error('workspaceDir 必填');

  const memoryDir = path.join(workspaceDir, STORE_DIR_NAME);
  ensureDir(memoryDir);
  const file = resolveDbFile(workspaceDir);
  const db = new DatabaseSync(file);
  applyPragmas(db);
  const migration = runMigrations(db);

  const store = {
    agentId,
    file,
    memoryDir,
    db,
    schemaVersion: SCHEMA_VERSION,
    migration,

    /**
     * 事务封装。契约 §7.3 批量写入的部分成功需要逐条提交，
     * 需要原子的地方（删除级联、版本链）用此方法。
     */
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // rollback 失败时保留原始错误
        }
        throw error;
      }
    },

    prepare(sql) {
      return db.prepare(sql);
    },

    get(sql, ...params) {
      return db.prepare(sql).get(...params);
    },

    all(sql, ...params) {
      return db.prepare(sql).all(...params);
    },

    run(sql, ...params) {
      return db.prepare(sql).run(...params);
    },

    close() {
      try {
        db.close();
      } catch {
        // 已关闭
      }
      cache.delete(agentId);
    }
  };

  return store;
}

/**
 * 获取（并缓存）某个 AI 的记忆库。同一 agentId 复用同一个连接，
 * 避免 WAL 频繁开关；调用方不要自行 close。
 */
function getStore({ agentId, workspaceDir }) {
  const existing = cache.get(agentId);
  if (existing) {
    const expected = resolveDbFile(workspaceDir);
    if (existing.file === expected) return existing;
    existing.close();
  }
  const store = createStore({ agentId, workspaceDir });
  cache.set(agentId, store);
  return store;
}

function closeAll() {
  for (const store of cache.values()) store.close();
  cache.clear();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  STORE_DIR_NAME,
  DB_FILE_NAME,
  USER_VERSION,
  resolveDbFile,
  createStore,
  getStore,
  closeAll,
  parseJson,
  toJson,
  nowIso
};
