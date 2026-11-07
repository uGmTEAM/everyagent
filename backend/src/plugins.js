// 插件管理：安装、更新、启用/禁用、卸载、数据清理与 worker 生命周期。
// 设计约定：插件代码在 worker 线程运行（死循环可 terminate），页面渲染后续由主线程负责。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');
const config = require('./config');
const events = require('./events');
const inbox = require('./inbox');
const { ensureDir, nowIso, truncate, tailFileLines } = require('./util');

const PLUGIN_ROOT = path.join(config.dataDir, 'plugins');
const DATA_ROOT = path.join(config.dataDir, 'plugin-data');
const LOG_ROOT = path.join(config.dataDir, 'plugin-logs');
const BACKUP_ROOT = path.join(config.dataDir, 'plugin-backups');
const WORKER_ENTRY = path.join(__dirname, 'plugin-worker.js');

const API_VERSION = 1;
const BOOT_TIMEOUT_MS = 10000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const MAX_PLUGINS = 32;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;

const runners = new Map();
let callSeq = 0;
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[plugin] ${message}`);
}

function ensureDirs() {
  ensureDir(PLUGIN_ROOT);
  ensureDir(DATA_ROOT);
  ensureDir(LOG_ROOT);
  ensureDir(BACKUP_ROOT);
}

function pluginDir(id) {
  return path.join(PLUGIN_ROOT, id);
}

// 插件 ID 会进入文件路径，所有对外入口都必须先过这一层
function isValidId(id) {
  return ID_PATTERN.test(String(id || ''));
}

function assertValidId(id) {
  if (!isValidId(id)) throw new Error('插件 ID 无效');
  return String(id);
}

function dataDir(id) {
  return path.join(DATA_ROOT, id);
}

function logDir(id) {
  return LOG_ROOT;
}

function logFile(id) {
  return path.join(LOG_ROOT, `${id}.log`);
}

function row(id) {
  return db.get('SELECT * FROM plugins WHERE id = ?', [id]);
}

function allRows() {
  return db.all('SELECT * FROM plugins ORDER BY installed_at ASC');
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('缺少 manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`manifest.json 不是合法 JSON：${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest.json 内容无效');
  return manifest;
}

function platformVersion() {
  try {
    return require('../package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function compareVersion(a, b) {
  const left = String(a || '').split('.').map((item) => Number(item) || 0);
  const right = String(b || '').split('.').map((item) => Number(item) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// 校验只做结构检查；版本不匹配按约定「警告并允许」
function validateManifest(manifest) {
  const warnings = [];
  const id = String(manifest.id || '').trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error('manifest.id 只能是 2-40 位小写字母、数字、下划线或连字符');
  }
  if (!String(manifest.name || '').trim()) throw new Error('manifest.name 不能为空');
  if (!String(manifest.version || '').trim()) throw new Error('manifest.version 不能为空');
  const apiVersion = Number(manifest.api_version || API_VERSION);
  if (apiVersion !== API_VERSION) {
    warnings.push(`插件声明 api_version=${apiVersion}，当前平台为 ${API_VERSION}，可能不兼容`);
  }
  const min = String(manifest.min_platform_version || '').trim();
  if (min && compareVersion(platformVersion(), min) < 0) {
    warnings.push(`插件要求平台 ≥ ${min}，当前为 ${platformVersion()}`);
  }
  return { id, warnings, apiVersion };
}

function manifestOf(id) {
  try {
    return readManifest(pluginDir(id));
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  } catch {
    // 目录不存在按 0 计
  }
  return total;
}

function describe(id) {
  if (!isValidId(id)) {
    return {
      id: String(id || ''),
      record: null,
      manifest: null,
      status: 'invalid',
      enabled: false,
      missing: true,
      disk_bytes: 0,
      log_file: null
    };
  }
  const record = row(id);
  const manifest = manifestOf(id);
  const running = runners.get(id);
  return {
    id,
    record,
    manifest,
    status: running?.ready ? 'running' : record?.status || 'unknown',
    enabled: Boolean(record?.enabled),
    missing: !manifest,
    disk_bytes: dirSize(pluginDir(id)) + dirSize(dataDir(id)),
    log_file: logFile(id)
  };
}

function listPlugins() {
  ensureDirs();
  const ids = new Set(allRows().map((item) => item.id));
  // 手动放进目录的插件自动登记为「未启用」，避免必须用上传入口
  for (const entry of fs.readdirSync(PLUGIN_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isValidId(entry.name)) continue;
    if (!fs.existsSync(path.join(PLUGIN_ROOT, entry.name, 'manifest.json'))) continue;
    if (ids.has(entry.name)) continue;
    const stamp = nowIso();
    db.run(
      `INSERT OR IGNORE INTO plugins (id, enabled, status, source_type, source, installed_at, updated_at)
       VALUES (?, 0, 'stopped', 'manual', ?, ?, ?)`,
      [entry.name, 'manual', stamp, stamp]
    );
    ids.add(entry.name);
  }
  return allRows().map((item) => describe(item.id));
}

function assertIdFree(id, updating = false) {
  const exists = Boolean(row(id));
  if (!updating && exists) throw new Error(`插件 ${id} 已安装，请使用更新`);
  if (!exists && updating) throw new Error(`插件 ${id} 未安装`);
  if (!updating && allRows().length >= MAX_PLUGINS) throw new Error(`最多安装 ${MAX_PLUGINS} 个插件`);
}

function assertInside(root, target) {
  const realRoot = path.resolve(root);
  const realTarget = path.resolve(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error('压缩包内包含越界路径');
  }
}

function walkSafe(root, current = root) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    assertInside(root, target);
    if (entry.isDirectory()) walkSafe(root, target);
  }
}

function locateRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory());
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  throw new Error('压缩包内没有找到 manifest.json');
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function extractZip(zipPath) {
  const dir = tempDir('ea-plugin');
  const result = spawnSync('tar', ['-xf', zipPath, '-C', dir], {
    timeout: 180000,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`解压失败：${(result.stderr || '').trim() || '未知错误'}`);
  }
  walkSafe(dir);
  return locateRoot(dir);
}

function cloneGit(url, branch) {
  const target = String(url || '').trim();
  if (!/^(https?:\/\/|git@)/.test(target) || /\s/.test(target)) {
    throw new Error('只支持 https:// 或 git@ 形式的仓库地址');
  }
  const dir = tempDir('ea-plugin-git');
  const result = spawnSync(
    'git',
    ['clone', '--depth', '1', '--branch', String(branch || 'main'), '--', target, dir],
    { timeout: 180000, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`git clone 失败：${(result.stderr || '').trim() || '未知错误'}`);
  }
  const nested = path.join(dir, '.git');
  if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true, force: true });
  return locateRoot(dir);
}

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function backupCode(id) {
  const dir = pluginDir(id);
  if (!fs.existsSync(dir)) return null;
  const stamp = String(Date.now());
  const target = path.join(BACKUP_ROOT, id, stamp);
  ensureDir(target);
  fs.cpSync(dir, target, { recursive: true });
  // 每个插件只保留最近一份可回滚代码
  const parent = path.join(BACKUP_ROOT, id);
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== stamp) {
      fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
    }
  }
  return target;
}

function latestBackup(id) {
  const parent = path.join(BACKUP_ROOT, id);
  if (!fs.existsSync(parent)) return null;
  const dirs = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!dirs.length) return null;
  return path.join(parent, dirs[dirs.length - 1]);
}

function installFrom(root, { sourceType, source, updating = false }) {
  ensureDirs();
  const manifest = readManifest(root);
  const { id, warnings } = validateManifest(manifest);
  assertIdFree(id, updating);
  ensureDir(dataDir(id));

  if (updating) {
    const backup = backupCode(id);
    try {
      copyTree(root, pluginDir(id));
      ensureDir(dataDir(id));
      db.run('UPDATE plugins SET updated_at = ?, status = ?, last_error = NULL WHERE id = ?', [
        nowIso(),
        'stopped',
        id
      ]);
    } catch (error) {
      if (backup) copyTree(backup, pluginDir(id));
      throw error;
    }
  } else {
    copyTree(root, pluginDir(id));
    const stamp = nowIso();
    db.run(
      `INSERT INTO plugins (id, enabled, status, source_type, source, installed_at, updated_at)
       VALUES (?, 1, 'stopped', ?, ?, ?, ?)`,
      [id, sourceType, truncate(source || '', 500), stamp, stamp]
    );
  }

  events.addEvent(
    null,
    updating ? 'plugin_updated' : 'plugin_installed',
    `插件 ${manifest.name || id} v${manifest.version || '?'} 已${updating ? '更新' : '安装'}，重启后端后生效。`,
    { plugin_id: id, warnings }
  );
  return { id, manifest, warnings };
}

function installFromZip(zipPath, { sourceName } = {}) {
  if (Number(allRows().length) >= MAX_PLUGINS) throw new Error(`最多安装 ${MAX_PLUGINS} 个插件`);
  const root = extractZip(zipPath);
  return installFrom(root, { sourceType: 'upload', source: sourceName || 'upload.zip' });
}

function installFromGit(url, branch) {
  if (Number(allRows().length) >= MAX_PLUGINS) throw new Error(`最多安装 ${MAX_PLUGINS} 个插件`);
  const root = cloneGit(url, branch);
  return installFrom(root, {
    sourceType: 'git',
    source: `${url}${branch ? `#${branch}` : ''}`
  });
}

function updatePlugin(id, { zipPath, branch } = {}) {
  assertValidId(id);
  const record = row(id);
  if (!record) throw new Error(`插件 ${id} 未安装`);
  let root;
  if (zipPath) {
    root = extractZip(zipPath);
  } else if (record.source_type === 'git') {
    const [url, ref] = String(record.source || '').split('#');
    root = cloneGit(url, branch || ref || 'main');
  } else {
    throw new Error('该插件是上传安装的，请上传新的压缩包');
  }
  stopPlugin(id);
  const result = installFrom(root, {
    sourceType: zipPath ? record.source_type : 'git',
    source: zipPath ? record.source : record.source,
    updating: true
  });
  return result;
}

function setEnabled(id, enabled) {
  assertValidId(id);
  const record = row(id);
  if (!record) throw new Error(`插件 ${id} 未安装`);
  if (!enabled) stopPlugin(id);
  db.run('UPDATE plugins SET enabled = ?, status = ?, updated_at = ? WHERE id = ?', [
    enabled ? 1 : 0,
    enabled ? 'stopped' : 'disabled',
    nowIso(),
    id
  ]);
  events.addEvent(null, 'plugin_toggle', `插件 ${id} 已${enabled ? '启用（重启后生效）' : '禁用'}。`, {
    plugin_id: id
  });
  return describe(id);
}

function clearData(id) {
  assertValidId(id);
  if (!row(id)) throw new Error(`插件 ${id} 未安装`);
  stopPlugin(id);
  fs.rmSync(dataDir(id), { recursive: true, force: true });
  ensureDir(dataDir(id));
  try {
    fs.rmSync(logFile(id), { force: true });
  } catch {
    // ignore
  }
  events.addEvent(null, 'plugin_data_cleared', `插件 ${id} 的数据已清除。`, { plugin_id: id });
  return describe(id);
}

function uninstall(id, { deleteData = false } = {}) {
  assertValidId(id);
  if (!row(id)) throw new Error(`插件 ${id} 未安装`);
  stopPlugin(id);
  fs.rmSync(pluginDir(id), { recursive: true, force: true });
  if (deleteData) {
    fs.rmSync(dataDir(id), { recursive: true, force: true });
    try {
      fs.rmSync(logFile(id), { force: true });
    } catch {
      // ignore
    }
  }
  db.run('DELETE FROM plugins WHERE id = ?', [id]);
  events.addEvent(null, 'plugin_uninstalled', `插件 ${id} 已卸载${deleteData ? '（含数据）' : '（保留数据）'}。`, {
    plugin_id: id
  });
  return { ok: true };
}

function tailLog(id, lines = 300) {
  return tailFileLines(logFile(id), lines);
}

function crashPlugin(id, reason) {
  const runner = runners.get(id);
  if (runner) {
    runner.stopping = true;
    try {
      runner.worker.terminate();
    } catch {
      // ignore
    }
    runners.delete(id);
  }
  db.run(
    "UPDATE plugins SET enabled = 0, status = 'crashed', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
    [truncate(String(reason || '未知错误'), 1000), nowIso(), nowIso(), id]
  );
  try {
    events.addEvent(null, 'plugin_crashed', `插件 ${id} 已自动禁用：${truncate(String(reason), 300)}`, {
      plugin_id: id
    });
    inbox.addImportant(null, '插件已自动禁用', `插件 ${id} 因异常被禁用：${truncate(String(reason), 300)}。修复后可在「插件」页手动启用并重启后端。`);
  } catch {
    // 关停阶段数据库可能已关闭
  }
}

function startSchedules(id, manifest, runner) {
  const list = Array.isArray(manifest.schedule) ? manifest.schedule : [];
  runner.timers = runner.timers || [];
  for (const item of list) {
    if (!item || item.enabled === false) continue;
    const every = Math.max(1000, Number(item.every_ms || item.everyMs || 60000));
    const timer = setInterval(() => {
      safeCall(id, `schedule.${item.name}`, {}, Math.min(every, 30000)).then((outcome) => {
        if (!outcome.ok) recordPluginError(id, `定时任务 ${item.name} 失败：${outcome.error}`);
      });
    }, every);
    timer.unref?.();
    runner.timers.push(timer);
  }
}

function startPlugin(id) {
  assertValidId(id);
  const record = row(id);
  if (!record) return Promise.reject(new Error(`插件 ${id} 未安装`));
  if (runners.has(id)) return Promise.resolve({ status: 'running' });
  const manifest = manifestOf(id);
  if (!manifest) return Promise.reject(new Error('manifest 读取失败'));
  const entry = String(manifest.worker || 'worker.js');
  if (!fs.existsSync(path.join(pluginDir(id), entry))) {
    db.run("UPDATE plugins SET status = 'ui_only', started_at = ? WHERE id = ?", [nowIso(), id]);
    return Promise.resolve({ status: 'ui_only' });
  }

  ensureDirs();
  const worker = new Worker(WORKER_ENTRY, {
    workerData: {
      id,
      dir: pluginDir(id),
      entry,
      dataDir: dataDir(id),
      logDir: logDir(id)
    }
  });
  const runner = { worker, ready: false, stopping: false, pending: new Map(), bootTimer: null, timers: [], meta: null };
  runners.set(id, runner);

  return new Promise((resolve, reject) => {
    runner.bootTimer = setTimeout(() => {
      crashPlugin(id, `启动超时（${BOOT_TIMEOUT_MS}ms 未就绪）`);
      reject(new Error('插件启动超时'));
    }, BOOT_TIMEOUT_MS);

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        runner.ready = true;
        clearTimeout(runner.bootTimer);
        runner.meta = {
          exports: Array.isArray(message.exports) ? message.exports : [],
          apiKeys: Array.isArray(message.apiKeys) ? message.apiKeys : [],
          tools: []
        };
        db.run(
          "UPDATE plugins SET status = 'running', started_at = ?, last_error = NULL WHERE id = ?",
          [nowIso(), id]
        );
        events.addEvent(null, 'plugin_started', `插件 ${id} 已启动。`, { plugin_id: id });
        // 启动后补一次工具元信息与定时任务，失败不影响插件本身
        safeCall(id, '__describe', {}, 5000).then((outcome) => {
          if (outcome.ok && Array.isArray(outcome.value?.tools)) runner.meta.tools = outcome.value.tools;
        });
        startSchedules(id, manifest, runner);
        resolve({ status: 'running' });
        return;
      }
      if (message.type === 'boot_error') {
        clearTimeout(runner.bootTimer);
        crashPlugin(id, `初始化失败：${message.error || '未知错误'}`);
        reject(new Error(message.error || '插件初始化失败'));
        return;
      }
      if (message.type === 'crash') {
        crashPlugin(id, `运行异常：${message.error || '未知错误'}`);
        return;
      }
      if (message.type === 'result') {
        const pending = runner.pending.get(message.callId);
        if (!pending) return;
        runner.pending.delete(message.callId);
        clearTimeout(pending.timer);
        if (message.ok) {
          pending.resolve(message.value);
        } else {
          // 调用失败只记录，不禁用插件
          db.run('UPDATE plugins SET last_error = ?, last_error_at = ? WHERE id = ?', [
            truncate(String(message.error || '调用失败'), 1000),
            nowIso(),
            id
          ]);
          pending.reject(new Error(message.error || '插件调用失败'));
        }
      }
    });

    worker.on('error', (error) => {
      if (runner.stopping) return;
      clearTimeout(runner.bootTimer);
      crashPlugin(id, `进程异常：${error.message}`);
      reject(error);
    });

    worker.on('exit', (code) => {
      clearTimeout(runner.bootTimer);
      if (runner.stopping) return;
      if (code !== 0) crashPlugin(id, `进程退出，code=${code}`);
    });
  });
}

function stopPlugin(id) {
  const runner = runners.get(id);
  if (!runner) return;
  runner.stopping = true;
  for (const timer of runner.timers || []) clearInterval(timer);
  runner.timers = [];
  try {
    runner.worker.postMessage({ type: 'shutdown' });
  } catch {
    // ignore
  }
  const timer = setTimeout(() => {
    try {
      runner.worker.terminate();
    } catch {
      // ignore
    }
  }, 2000);
  timer.unref?.();
  for (const [, pending] of runner.pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('插件已停止'));
  }
  runner.pending.clear();
  runners.delete(id);
  const record = row(id);
  if (record && record.status === 'running') {
    db.run("UPDATE plugins SET status = 'stopped' WHERE id = ?", [id]);
  }
}

// 单次调用超时只说明 worker 可能被阻塞：重启 worker 并保持启用。
// 按约定，调用失败只告警，不自动禁用插件。
function restartRunner(id, reason) {
  const runner = runners.get(id);
  if (!runner) return;
  runner.stopping = true;
  clearTimeout(runner.bootTimer);
  for (const timer of runner.timers || []) clearInterval(timer);
  runner.timers = [];
  for (const [, pending] of runner.pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('插件调用超时，worker 已重启'));
  }
  runner.pending.clear();
  try {
    runner.worker.terminate();
  } catch {
    // ignore
  }
  runners.delete(id);
  const message = truncate(String(reason || '插件调用超时'), 1000);
  db.run("UPDATE plugins SET status = 'starting', last_error = ?, last_error_at = ? WHERE id = ?", [
    message,
    nowIso(),
    id
  ]);
  console.warn(`[plugin] ${id} ${message}`);
  startPlugin(id).catch((error) => {
    db.run("UPDATE plugins SET status = 'error', last_error = ?, last_error_at = ? WHERE id = ?", [
      truncate(`worker 重启失败：${error.message}`, 1000),
      nowIso(),
      id
    ]);
  });
}

function callPlugin(id, method, args, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
  if (!isValidId(id)) return Promise.reject(new Error('插件 ID 无效'));
  const runner = runners.get(id);
  if (!runner || !runner.ready) return Promise.reject(new Error(`插件 ${id} 未运行`));
  const callId = (callSeq += 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runner.pending.delete(callId);
      restartRunner(id, `调用 ${method} 超时（${timeoutMs}ms），已重启 worker`);
      reject(new Error(`插件 ${id} 调用超时`));
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS));
    runner.pending.set(callId, { resolve, reject, timer });
    try {
      runner.worker.postMessage({ type: 'call', callId, method, args: args || {} });
    } catch (error) {
      clearTimeout(timer);
      runner.pending.delete(callId);
      reject(error);
    }
  });
}

async function safeCall(id, method, args, timeoutMs) {
  try {
    return { ok: true, value: await callPlugin(id, method, args, timeoutMs) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function startAll() {
  const rows = allRows();
  const results = [];
  for (const record of rows) {
    if (!record.enabled) continue;
    if (!manifestOf(record.id)) {
      db.run("UPDATE plugins SET status = 'error', last_error = ?, last_error_at = ? WHERE id = ?", [
        '目录或 manifest.json 缺失',
        nowIso(),
        record.id
      ]);
      continue;
    }
    startPlugin(record.id).catch((error) => {
      console.warn(`[plugin] ${record.id} 启动失败：${error.message}`);
    });
    results.push(record.id);
  }
  return results;
}

function stopAll() {
  for (const id of Array.from(runners.keys())) stopPlugin(id);
}

function enabledManifests() {
  return allRows()
    .filter((item) => item.enabled)
    .map((item) => ({ id: item.id, manifest: manifestOf(item.id) }))
    .filter((item) => item.manifest);
}

// 主线程读写插件配置：直接打开插件库（WAL，短连接）
function openPluginDb(id) {
  ensureDir(dataDir(id));
  const handle = new DatabaseSync(path.join(dataDir(id), 'plugin.db'));
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA busy_timeout = 5000;');
  handle.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return handle;
}

function getConfig(id) {
  if (!isValidId(id)) return {};
  let handle;
  try {
    handle = openPluginDb(id);
    const rows = handle.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return out;
  } catch {
    return {};
  } finally {
    try {
      handle?.close();
    } catch {
      // ignore
    }
  }
}

function setConfig(id, values = {}) {
  assertValidId(id);
  const handle = openPluginDb(id);
  try {
    const statement = handle.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const [key, value] of Object.entries(values)) {
      statement.run(String(key), JSON.stringify(value));
    }
  } finally {
    try {
      handle.close();
    } catch {
      // ignore
    }
  }
  return getConfig(id);
}

function recordPluginError(id, message) {
  if (!isValidId(id)) return;
  try {
    db.run('UPDATE plugins SET last_error = ?, last_error_at = ? WHERE id = ?', [
      truncate(String(message || ''), 1000),
      nowIso(),
      id
    ]);
  } catch {
    // ignore
  }
}

// 钩子：priority 大者先执行；前两名同优先级时告警并回退核心行为
async function runHook(name, payload = {}) {
  const list = [];
  for (const entry of enabledManifests()) {
    if (!Array.isArray(entry.manifest.hooks) || !entry.manifest.hooks.includes(name)) continue;
    const runner = runners.get(entry.id);
    if (!runner?.ready) continue;
    list.push({ id: entry.id, priority: Number(entry.manifest.priority ?? 100) });
  }
  if (!list.length) return null;
  list.sort((a, b) => b.priority - a.priority);
  if (list.length > 1 && list[0].priority === list[1].priority) {
    warnOnce(`hook:${name}:${list[0].priority}`, `钩子 ${name} 优先级冲突（${list[0].priority}）：${list[0].id} 与 ${list[1].id}，回退核心行为`);
    return null;
  }

  let extra = [];
  let result = null;
  for (const item of list) {
    const outcome = await safeCall(item.id, `hooks.${name}`, payload, 15000);
    if (!outcome.ok) {
      recordPluginError(item.id, `钩子 ${name} 失败：${outcome.error}`);
      continue;
    }
    const value = outcome.value;
    if (name.endsWith('.extra')) {
      if (typeof value === 'string' && value.trim()) extra.push(value.trim());
      continue;
    }
    if (name === 'inbound.transform' && value && typeof value === 'object') {
      if (value.message && typeof value.message === 'object') payload.message = value.message;
      result = value;
      continue;
    }
    if (name === 'outbound.transform' && value && typeof value === 'object') {
      if (typeof value.text === 'string') payload.text = value.text;
      result = value;
      continue;
    }
    result = value;
  }
  if (name.endsWith('.extra')) {
    const text = extra.join('\n\n');
    return text ? { text } : null;
  }
  return result;
}

function toolDefinitions() {
  const out = [];
  for (const entry of enabledManifests()) {
    const runner = runners.get(entry.id);
    if (!runner?.ready) continue;
    const declared = Array.isArray(entry.manifest.tools) ? entry.manifest.tools : [];
    const reported = Array.isArray(runner.meta?.tools) ? runner.meta.tools : [];
    const source = declared.length ? declared : reported;
    for (const tool of source) {
      const name = String(tool.name || '').trim();
      if (!name) continue;
      out.push({
        plugin_id: entry.id,
        name,
        description: String(tool.description || ''),
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
        // manifest 里声明了时限就透传，避免慢工具（如群成员同步）被默认 30s 掐断
        timeout_ms: Number(tool.timeout_ms) || null
      });
    }
  }
  return out;
}

async function callTool(pluginId, toolName, args = {}) {
  const tool = toolDefinitions().find(
    (item) => item.plugin_id === pluginId && item.name === toolName
  );
  if (!tool) throw new Error(`插件工具不存在：${pluginId}/${toolName}`);
  return callPlugin(pluginId, `tools.${toolName}`, args, Number(tool.timeout_ms) || DEFAULT_CALL_TIMEOUT_MS);
}

function init() {
  ensureDirs();
  const started = startAll();
  if (started.length) console.log(`[plugin] 已启动 ${started.length} 个插件：${started.join(', ')}`);
}

module.exports = {
  PLUGIN_ROOT,
  DATA_ROOT,
  LOG_ROOT,
  API_VERSION,
  init,
  listPlugins,
  describe,
  readManifest,
  validateManifest,
  installFromZip,
  installFromGit,
  updatePlugin,
  setEnabled,
  clearData,
  uninstall,
  startPlugin,
  stopPlugin,
  startAll,
  stopAll,
  callPlugin,
  safeCall,
  tailLog,
  logFile,
  crashPlugin,
  pluginDir,
  isValidId,
  enabledManifests,
  getConfig,
  setConfig,
  recordPluginError,
  runHook,
  toolDefinitions,
  callTool
};
