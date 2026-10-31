import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPID_FALLBACK_LINUX = '537246140';
const SUPPORTED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supported-versions.json');

function readJsonSafe (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findAppDir (hint) {
  const candidates = [];
  if (hint) candidates.push(hint);
  if (process.env.BRIDGE_QQ_APP_DIR) candidates.push(process.env.BRIDGE_QQ_APP_DIR);
  if (process.execPath) {
    candidates.push(path.resolve(path.dirname(process.execPath), 'resources/app'));
    candidates.push(path.resolve(path.dirname(process.execPath), '../Resources/app'));
  }
  candidates.push('/opt/QQ/resources/app');
  candidates.push('/usr/share/qq/resources/app');

  for (const dir of candidates) {
    if (!dir) continue;
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg) && fs.existsSync(path.join(dir, 'wrapper.node'))) {
      return dir;
    }
  }
  for (const dir of candidates) {
    if (!dir) continue;
    const versions = path.join(dir, 'versions');
    if (fs.existsSync(versions)) {
      for (const name of fs.readdirSync(versions)) {
        const sub = path.join(versions, name);
        if (fs.existsSync(path.join(sub, 'wrapper.node'))) return sub;
      }
    }
  }
  return null;
}

function scanAppidFromMajor (majorPath) {
  if (!majorPath || !fs.existsSync(majorPath)) return '';
  try {
    const buf = fs.readFileSync(majorPath);
    const marker = Buffer.from('QQAppId/', 'utf8');
    let from = 0;
    while (from < buf.length) {
      const index = buf.indexOf(marker, from);
      if (index === -1) break;
      const start = index + marker.length;
      const end = buf.indexOf(0, start);
      if (end === -1) break;
      const value = buf.subarray(start, end).toString('utf8');
      if (/^\d{5,}$/.test(value)) return value;
      from = end + 1;
    }
  } catch {
    // ignore
  }
  return '';
}

export function detectQQ (config, logger) {
  const appDir = findAppDir(config.qq?.appDir);
  if (!appDir) {
    throw new Error('未找到 QQ 安装目录（resources/app/wrapper.node）。请设置 BRIDGE_QQ_APP_DIR。');
  }
  const packageInfo = readJsonSafe(path.join(appDir, 'package.json')) || {};
  const version = String(packageInfo.version || '');
  const build = String(packageInfo.buildVersion || version.split('-')[1] || '');
  const majorPath = path.join(appDir, 'major.node');
  const appid = scanAppidFromMajor(majorPath) || APPID_FALLBACK_LINUX;
  const platform = process.platform === 'linux' ? 'V1_LNX' : process.platform === 'darwin' ? 'V1_MAC' : 'V1_WIN';
  const qua = `${platform}_${version}_${build}_GW_B`;

  const supported = readJsonSafe(SUPPORTED_FILE) || { tested: [] };
  const matched = supported.tested.some(item => version.startsWith(item));
  if (!matched) {
    logger?.warn(`[qq] 当前 QQ 版本 ${version} 不在已验证列表内（${supported.tested.join(', ') || '空'}）。`);
    logger?.warn(`[qq] 操作指引：1) 备份 ${config._dataDir}；2) 查看 /health 中的 capabilities；3) 若 missing 非空，参照 README「版本适配」章节更新接口探测。`);
  }

  return {
    appDir,
    wrapperPath: path.join(appDir, 'wrapper.node'),
    majorPath,
    packageInfo,
    version,
    build,
    appid,
    qua,
    supported: matched,
    testedVersions: supported.tested,
    hint: matched ? '' : '当前版本未验证，请先检查 /health 的 capabilities.missing',
    hostname: os.hostname()
  };
}

export function loadWrapper (info) {
  const module = { exports: {} };
  process.dlopen(module, info.wrapperPath);
  return module.exports;
}

export function describeWrapper (wrapper) {
  const required = [
    'NodeIQQNTWrapperEngine',
    'NodeIKernelLoginService',
    'NodeIQQNTWrapperSession'
  ];
  const missing = required.filter(name => !wrapper?.[name]);
  const services = [
    ['getMsgService', 'MsgService'],
    ['getGroupService', 'GroupService'],
    ['getBuddyService', 'BuddyService'],
    ['getRichMediaService', 'RichMediaService'],
    ['getProfileService', 'ProfileService'],
    ['getUixConvertService', 'UixConvertService']
  ];
  return { missing, services };
}
