// 官方工具同步：按 toolkits/official-tools.json 从 GitHub Release 下载工具集压缩包，
// 解压后保存到 data/toolkits/<name>（本地已存在且版本一致时跳过）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const tls = require('tls');

// 使用系统根证书（部分 Windows 环境通过系统证书链访问 GitHub，Node 内置 CA 会校验失败）。
try {
  if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
    tls.setDefaultCACertificates(tls.getCACertificates('system'));
  }
} catch {
  // Node 版本不支持时保持默认 CA
}

const execFileAsync = promisify(execFile);
const MANIFEST_PATH = path.join(__dirname, '..', '..', 'toolkits', 'official-tools.json');
const UA = 'EveryAgent-OfficialToolSync';

function readManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch {
    return [];
  }
}

function readVersion(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'toolkit.json'), 'utf8'));
    return String(meta.version || '');
  } catch {
    return '';
  }
}

function githubHeaders() {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchLatestRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(40000)
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}（${repo}）`);
  return response.json();
}

async function download(url, dest) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(300000)
  });
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer.length;
}

async function extract(archive, targetDir) {
  await execFileAsync('tar', ['-xzf', archive, '-C', targetDir], { timeout: 120000 });
}

// 压缩包内通常只有一层 <name>/ 目录；也兼容直接放 toolkit.json 的平铺结构。
function resolveRoot(tmpDir, name) {
  const named = path.join(tmpDir, name);
  if (fs.existsSync(path.join(named, 'toolkit.json')) || fs.existsSync(path.join(named, 'bin'))) return named;
  const entries = fs.readdirSync(tmpDir).filter((entry) => !entry.startsWith('.'));
  if (entries.length === 1) {
    const single = path.join(tmpDir, entries[0]);
    if (fs.statSync(single).isDirectory()) return single;
  }
  return tmpDir;
}

function stampMeta(root, tool) {
  const metaPath = path.join(root, 'toolkit.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = { name: tool.name, bin: ['bin'], commands: [tool.name] };
  }
  const next = {
    ...meta,
    name: tool.name,
    version: String(tool.version || meta.version || ''),
    official: true,
    repo: `https://github.com/${tool.repo}`
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function replaceDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  try {
    fs.renameSync(source, target);
  } catch {
    fs.cpSync(source, target, { recursive: true });
  }
}

async function syncOne(tool, targetRoot, { force }) {
  const target = path.join(targetRoot, tool.name);
  if (!force && fs.existsSync(target) && readVersion(target) === String(tool.version || '')) {
    return { name: tool.name, status: 'skipped' };
  }

  const release = await fetchLatestRelease(tool.repo);
  const pattern = new RegExp(tool.asset || `${tool.name}-toolkit-.*\\.tar\\.gz`);
  const asset = (release.assets || []).find((item) => pattern.test(item.name));
  if (!asset) throw new Error(`Release ${release.tag_name} 没有匹配的资产：${tool.asset}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `ea-tool-${tool.name}-`));
  try {
    const archive = path.join(work, asset.name);
    await download(asset.browser_download_url, archive);
    const extractDir = path.join(work, 'extract');
    fs.mkdirSync(extractDir);
    await extract(archive, extractDir);
    const root = resolveRoot(extractDir, tool.name);
    stampMeta(root, tool);
    fs.mkdirSync(targetRoot, { recursive: true });
    replaceDir(root, target);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { name: tool.name, status: 'ok' };
}

// 同步官方工具到 targetRoot（默认 data/toolkits）。单个失败不影响其它工具。
async function syncOfficial({ targetRoot, force = false, only = null } = {}) {
  const manifest = readManifest().filter((tool) => (only ? only.includes(tool.name) : true));
  const results = [];
  for (const tool of manifest) {
    try {
      results.push(await syncOne(tool, targetRoot, { force }));
    } catch (error) {
      results.push({ name: tool.name, status: 'failed', error: error.message });
    }
  }
  return results;
}

module.exports = { readManifest, syncOfficial };
