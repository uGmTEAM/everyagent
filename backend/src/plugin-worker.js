// 插件 worker 入口：加载插件自己的 worker.js，提供受限上下文并处理主线程调用。
// 注意：页面渲染仍由主线程负责，这里只跑工具、钩子、定时任务等逻辑。
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

const { id, dir, entry, dataDir, logDir } = workerData;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 3;

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${id}.log`);

function rotateLog() {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < LOG_MAX_BYTES) return;
    for (let index = LOG_KEEP - 1; index >= 1; index -= 1) {
      const from = index === 1 ? logFile : `${logFile}.${index - 1}`;
      const to = `${logFile}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch {
    // 文件不存在时无需轮转
  }
}

function writeLog(level, message) {
  const text = `[${new Date().toISOString()}] [${level}] ${message}`;
  try {
    rotateLog();
    fs.appendFileSync(logFile, `${text}\n`, 'utf8');
  } catch {
    // 日志失败不影响插件运行
  }
  try {
    parentPort.postMessage({ type: 'log', level, line: text });
  } catch {
    // ignore
  }
}

const database = new DatabaseSync(path.join(dataDir, 'plugin.db'));
database.exec('PRAGMA journal_mode = WAL;');
database.exec('PRAGMA busy_timeout = 5000;');
database.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// worker 里 require('./db') 是另一份模块实例，默认处于未初始化状态；
// 插件第一次用平台模块时按需打开同一个库，否则 get/all 会直接抛「数据库尚未初始化」。
let platformDbReady = false;
function ensurePlatformDb() {
  if (platformDbReady) return;
  const platformDb = require('./db');
  try {
    platformDb.getDb();
  } catch {
    platformDb.init();
  }
  platformDbReady = true;
}

const ctx = {
  id,
  dir,
  dataDir,
  log: (message) => writeLog('info', message),
  warn: (message) => writeLog('warn', message),
  error: (message) => writeLog('error', message),
  // 插件代码自己的相对路径加载
  load: (relative) => require(path.resolve(dir, relative)),
  // 平台核心模块（不做权限隔离，按使用约定）：ctx.platform('db')
  platform: (name) => {
    ensurePlatformDb();
    return require(`./${name}`);
  },
  db: {
    run: (sql, params = []) => database.prepare(sql).run(...params),
    get: (sql, params = []) => database.prepare(sql).get(...params),
    all: (sql, params = []) => database.prepare(sql).all(...params)
  },
  config: {
    get(key, fallback = null) {
      const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },
    set(key, value) {
      database
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(String(key), JSON.stringify(value));
      return value;
    },
    all() {
      const rows = database.prepare('SELECT key, value FROM settings').all();
      const out = {};
      for (const row of rows) {
        try {
          out[row.key] = JSON.parse(row.value);
        } catch {
          out[row.key] = row.value;
        }
      }
      return out;
    }
  }
};

function resolveMethod(target, method) {
  const name = String(method || '');
  // 钩子名带点（如 inbound.transform），不能按点号拆路径
  if (name.startsWith('hooks.')) {
    const key = name.slice('hooks.'.length);
    const fn = target?.hooks?.[key];
    return typeof fn === 'function' ? fn : null;
  }
  if (name.startsWith('schedule.')) {
    const key = name.slice('schedule.'.length);
    const fn = target?.schedule?.[key] || target?.schedules?.[key];
    return typeof fn === 'function' ? fn : null;
  }
  if (name.startsWith('tools.')) {
    const key = name.slice('tools.'.length);
    const entry = target?.tools?.[key];
    if (typeof entry === 'function') return entry;
    if (entry && typeof entry.run === 'function') return (args, context) => entry.run(args, context);
    return null;
  }
  const parts = name.split('.').filter(Boolean);
  let current = target;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return typeof current === 'function' ? current : null;
}

function describeTools() {
  const source = pluginModule?.tools;
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).map(([name, definition]) => ({
    name,
    description: String(definition?.description || ''),
    parameters:
      definition?.parameters && typeof definition.parameters === 'object'
        ? definition.parameters
        : { type: 'object', properties: {} }
  }));
}

let pluginModule = null;
let ready = false;

function boot() {
  const absolute = path.resolve(dir, entry);
  if (!fs.existsSync(absolute)) throw new Error(`入口文件不存在：${entry}`);
  pluginModule = require(absolute);
  const init = pluginModule?.init || pluginModule?.default?.init;
  return Promise.resolve(init ? init(ctx) : null)
    .then((api) => {
      ready = true;
      parentPort.postMessage({
        type: 'ready',
        exports: Object.keys(pluginModule || {}),
        apiKeys: api && typeof api === 'object' ? Object.keys(api) : []
      });
    })
    .catch((error) => {
      writeLog('error', `初始化失败：${error.message}`);
      parentPort.postMessage({ type: 'boot_error', error: error?.message || String(error) });
      setTimeout(() => process.exit(1), 50);
    });
}

parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') {
    try {
      const shutdown = pluginModule?.shutdown || pluginModule?.default?.shutdown;
      if (typeof shutdown === 'function') await shutdown(ctx);
    } catch (error) {
      writeLog('warn', `退出钩子失败：${error.message}`);
    }
    process.exit(0);
    return;
  }
  if (message.type !== 'call') return;

  const callId = message.callId;
  if (!ready) {
    parentPort.postMessage({ type: 'result', callId, ok: false, error: '插件尚未就绪' });
    return;
  }
  if (message.method === '__describe') {
    parentPort.postMessage({ type: 'result', callId, ok: true, value: { tools: describeTools() } });
    return;
  }
  const fn = resolveMethod(pluginModule, message.method);
  if (!fn) {
    parentPort.postMessage({ type: 'result', callId, ok: false, error: `未找到方法：${message.method}` });
    return;
  }
  try {
    const value = await fn(message.args || {}, ctx);
    parentPort.postMessage({ type: 'result', callId, ok: true, value });
  } catch (error) {
    writeLog('warn', `调用 ${message.method} 失败：${error.message}`);
    parentPort.postMessage({
      type: 'result',
      callId,
      ok: false,
      error: error?.message || String(error)
    });
  }
});

process.on('uncaughtException', (error) => {
  writeLog('error', `未捕获异常：${error.stack || error.message}`);
  parentPort.postMessage({ type: 'crash', error: error?.message || String(error) });
  setTimeout(() => process.exit(1), 50);
});

process.on('unhandledRejection', (reason) => {
  writeLog('error', `未处理拒绝：${reason?.stack || reason}`);
  parentPort.postMessage({ type: 'crash', error: String(reason?.message || reason) });
  setTimeout(() => process.exit(1), 50);
});

boot();
