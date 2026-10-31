#!/usr/bin/env node
/**
 * 把 QQ 的 Electron 入口替换为 bridge-loader.cjs。
 * 仅在容器内使用：不修改 asar，只改 resources/app/package.json 的 main 字段。
 *
 * 用法：
 *   node scripts/patch-qq.mjs [--app-dir /opt/QQ/resources/app]
 *   node scripts/patch-qq.mjs --restore
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeHome = process.env.BRIDGE_HOME || path.resolve(here, '..');

function parseArgs (argv) {
  const out = { appDir: '', restore: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app-dir') out.appDir = argv[++i] || '';
    else if (arg === '--restore') out.restore = true;
    else if (!out.appDir && !arg.startsWith('--')) out.appDir = arg;
  }
  return out;
}

function findAppDir (hint) {
  const candidates = [
    hint,
    process.env.BRIDGE_QQ_APP_DIR,
    '/opt/QQ/resources/app',
    '/usr/share/qq/resources/app',
    process.execPath ? path.resolve(path.dirname(process.execPath), 'resources/app') : ''
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return '';
}

const args = parseArgs(process.argv);
const appDir = findAppDir(args.appDir);
if (!appDir) {
  console.error('[patch] 未找到 QQ resources/app，请用 --app-dir 指定');
  process.exit(1);
}

const packagePath = path.join(appDir, 'package.json');
const sidecarPath = path.join(appDir, '.bridge-original.json');
const loaderPath = path.join(appDir, 'bridge-loader.cjs');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

if (args.restore) {
  const sidecar = fs.existsSync(sidecarPath)
    ? JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
    : null;
  if (sidecar?.main) pkg.main = sidecar.main;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  if (fs.existsSync(loaderPath)) fs.unlinkSync(loaderPath);
  console.log(`[patch] 已还原 ${packagePath} main=${pkg.main}`);
  process.exit(0);
}

if (!fs.existsSync(sidecarPath)) {
  fs.writeFileSync(sidecarPath, JSON.stringify({
    main: pkg.main,
    version: pkg.version,
    patchedAt: new Date().toISOString()
  }, null, 2));
}

if (!fs.existsSync(path.join(appDir, 'wrapper.node')) && !fs.existsSync(path.join(appDir, 'versions'))) {
  console.error('[patch] 未在 app 目录找到 wrapper.node，确认 QQ 安装是否完整');
  process.exit(1);
}

pkg.main = './bridge-loader.cjs';
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));

const loaderSource = fs.readFileSync(path.join(bridgeHome, 'loader', 'bridge-loader.cjs'), 'utf8');
const escapedHome = bridgeHome.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
fs.writeFileSync(loaderPath, loaderSource.replace('__BRIDGE_HOME__', escapedHome));

console.log(`[patch] 已注入 ${packagePath}`);
console.log(`[patch] main -> ./bridge-loader.cjs，入口 ${path.join(bridgeHome, 'src', 'index.mjs')}`);
