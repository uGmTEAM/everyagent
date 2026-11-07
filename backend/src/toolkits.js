const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const CONTAINER_ROOT = '/opt/toolkits';
const ARCHIVE_PATTERN = /\.(zip|tar\.gz|tgz|tar)$/i;

function rootDir() {
  return config.toolkitsDir;
}

// 官方工具随发行包提供（仓库根目录 toolkits/），data/toolkits/ 用于用户自行上传的工具集。
function bundledRootDir() {
  return path.join(__dirname, '..', '..', 'toolkits');
}

// 同名时优先使用 data/toolkits/，其次回退到内置官方工具。
function resolveDir(name) {
  const clean = assertName(name);
  for (const root of [rootDir(), bundledRootDir()]) {
    const dir = path.join(root, clean);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function ensureRoot() {
  if (!fs.existsSync(rootDir())) fs.mkdirSync(rootDir(), { recursive: true });
  return rootDir();
}

function assertName(name) {
  const clean = String(name || '').trim();
  if (!NAME_PATTERN.test(clean)) {
    throw new Error('工具集名称只能包含字母、数字、点、下划线和中划线，且不超过 48 个字符');
  }
  return clean;
}

function nameFromArchive(originalName) {
  return String(originalName || '')
    .replace(ARCHIVE_PATTERN, '')
    .replace(/[^A-Za-z0-9._-]/g, '-');
}

function readMeta(dir, name) {
  const metaPath = path.join(dir, 'toolkit.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = {};
  }
  return {
    name,
    version: String(meta.version || ''),
    description: String(meta.description || ''),
    official: Boolean(meta.official),
    repo: String(meta.repo || ''),
    bin: Array.isArray(meta.bin) && meta.bin.length ? meta.bin.map(String) : ['bin'],
    commands: Array.isArray(meta.commands) ? meta.commands.map(String) : []
  };
}

function collectCommands(dir, meta) {
  if (meta.commands.length) return meta.commands;
  const names = [];
  for (const sub of meta.bin) {
    const binDir = path.join(dir, sub);
    let entries = [];
    try {
      entries = fs.readdirSync(binDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) names.push(entry.name);
    }
  }
  return names.sort();
}

function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

function describe(name) {
  const dir = resolveDir(name);
  if (!dir) return null;
  const meta = readMeta(dir, name);
  const bundled = path.join(bundledRootDir(), name);
  const official = fs.existsSync(bundled) && readMeta(bundled, name).official;
  return {
    ...meta,
    official,
    commands: collectCommands(dir, meta),
    bytes: dirBytes(dir),
    path: dir,
    containerPath: `${CONTAINER_ROOT}/${name}`
  };
}

function list() {
  const names = new Set();
  for (const root of [rootDir(), bundledRootDir()]) {
    if (!fs.existsSync(root)) continue;
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && NAME_PATTERN.test(entry.name));
    for (const entry of entries) names.add(entry.name);
  }
  return [...names]
    .map((name) => describe(name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 官方工具（toolkit.json 中 official: true）在创建 AI 时自动提供，无需勾选。
function officialNames() {
  return list().filter((item) => item.official).map((item) => item.name);
}

function get(name) {
  try {
    return describe(assertName(name));
  } catch {
    return null;
  }
}

function extract(archivePath, originalName, destDir) {
  const target = String(originalName || archivePath);
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.zip$/i.test(target)) {
    // Windows/macOS 自带 bsdtar 可直接解 zip；Linux 回退到 unzip
    try {
      execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'ignore' });
      return;
    } catch {
      execFileSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'ignore' });
      return;
    }
  }
  const flag = /\.tar$/i.test(target) ? '-xf' : '-xzf';
  execFileSync('tar', [flag, archivePath, '-C', destDir], { stdio: 'ignore' });
}

// GitHub release 包里通常带一层 `<name>-<version>/`，安装时把它展开成扁平结构
function flatten(destDir) {
  const entries = fs.readdirSync(destDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = path.join(destDir, entries[0].name);
  if (fs.existsSync(path.join(destDir, 'toolkit.json')) || fs.existsSync(path.join(destDir, 'bin'))) return;
  for (const entry of fs.readdirSync(inner, { withFileTypes: true })) {
    fs.renameSync(path.join(inner, entry.name), path.join(destDir, entry.name));
  }
  fs.rmdirSync(inner);
}

function writeMetaIfMissing(dir, name) {
  const metaPath = path.join(dir, 'toolkit.json');
  if (fs.existsSync(metaPath)) return;
  const text = JSON.stringify({ name, version: '', description: '' }, null, 2);
  fs.writeFileSync(metaPath, `${text}\n`, 'utf8');
}

function install({ archivePath, originalName, name }) {
  const finalName = assertName(name || nameFromArchive(originalName));
  ensureRoot();
  const dest = path.join(rootDir(), finalName);
  if (fs.existsSync(dest)) throw new Error(`工具集 ${finalName} 已存在，请先删除或换一个名称`);
  const tmp = path.join(rootDir(), `.tmp-${finalName}-${Date.now()}`);
  try {
    extract(archivePath, originalName, tmp);
    flatten(tmp);
    writeMetaIfMissing(tmp, finalName);
    fs.renameSync(tmp, dest);
  } catch (error) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw error;
  }
  return describe(finalName);
}

function remove(name) {
  const clean = assertName(name);
  const dir = path.join(rootDir(), clean);
  if (!fs.existsSync(dir)) {
    if (fs.existsSync(path.join(bundledRootDir(), clean))) {
      throw new Error('官方内置工具集不能删除');
    }
    throw new Error('工具集不存在');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return clean;
}

// 每个工具集以只读方式挂载到容器 /opt/toolkits/<name>。
// 官方工具始终挂载（含早期创建的 AI），保证自动提供。
function binds(names = []) {
  const result = [];
  const merged = [...new Set([...officialNames(), ...(names || [])])];
  for (const name of merged) {
    let clean;
    try {
      clean = assertName(name);
    } catch {
      continue;
    }
    const dir = resolveDir(clean);
    if (!dir) continue;
    result.push({ host: dir, target: `${CONTAINER_ROOT}/${clean}` });
  }
  return result;
}

function linkScript() {
  return [
    'mkdir -p /usr/local/bin',
    `for d in ${CONTAINER_ROOT}/*/bin; do`,
    '  [ -d "$d" ] || continue',
    '  for f in "$d"/*; do',
    '    [ -f "$f" ] || continue',
    '    b=$(basename "$f")',
    '    case "$b" in *.txt|*.md|*.json|*.yml|*.yaml) continue;; esac',
    '    cp -f "$f" "/usr/local/bin/$b" 2>/dev/null || continue',
    '    chmod 755 "/usr/local/bin/$b" 2>/dev/null || true',
    '  done',
    'done'
  ].join('\n');
}

// 容器启动后把工具集 bin 下的可执行文件装进 PATH（复制到 /usr/local/bin 并 chmod）
async function link(containerId) {
  if (!containerId) return;
  const docker = require('./docker');
  const container = docker.client().getContainer(containerId);
  const exec = await container.exec({
    Cmd: ['sh', '-c', linkScript()],
    AttachStdout: false,
    AttachStderr: false
  });
  await exec.start({ Detach: true });
}

function parseAgentToolkits(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 创建时把工具集名称转成快照（名称、版本、说明、命令），写入 agents.toolkits。
// 官方工具始终自动包含，无需在创建页勾选。
function snapshot(names = []) {
  const merged = [...new Set([...officialNames(), ...(names || [])])];
  const result = [];
  for (const name of merged) {
    const info = get(name);
    if (!info) continue;
    if (result.some((item) => item.name === info.name)) continue;
    result.push({
      name: info.name,
      version: info.version,
      description: info.description,
      commands: collectCommands(path.join(rootDir(), info.name), info),
      path: info.containerPath
    });
  }
  return result;
}

module.exports = {
  rootDir,
  bundledRootDir,
  CONTAINER_ROOT,
  list,
  officialNames,
  get,
  install,
  remove,
  binds,
  link,
  snapshot,
  parseAgentToolkits
};
