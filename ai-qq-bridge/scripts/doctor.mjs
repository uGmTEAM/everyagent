#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { detectQQ } from '../src/qq/wrapper.mjs';

const logger = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
  debug: () => {}
};

const config = loadConfig();
console.log('=== ai-qq-bridge doctor ===');
console.log('数据目录:', config._dataDir);
console.log('HTTP:', `${config.http.host}:${config.http.port}`, 'token:', config.http.token ? '已设置' : '未设置（单容器默认免鉴权）');
console.log('账号:', config.qq.account || '(扫码登录)', '备用账号数:', config.accounts.length);

try {
  const info = detectQQ(config, logger);
  console.log('QQ 目录:', info.appDir);
  console.log('QQ 版本:', info.version, 'build:', info.build);
  console.log('AppID:', info.appid);
  console.log('QUA:', info.qua);
  console.log('版本验证:', info.supported ? '已验证' : '未验证');
  for (const [label, file] of [['wrapper.node', info.wrapperPath], ['major.node', info.majorPath], ['package.json', path.join(info.appDir, 'package.json')]]) {
    console.log(`${label}:`, fs.existsSync(file) ? 'OK' : '缺失', file);
  }
  const sidecar = path.join(info.appDir, '.bridge-original.json');
  if (fs.existsSync(sidecar)) {
    console.log('注入状态: 已注入（原始配置见 .bridge-original.json）');
  } else {
    console.log('注入状态: 未注入（容器启动时会自动执行 patch-qq）');
  }
} catch (error) {
  console.error('QQ 检测失败:', error.message);
}

if (!process.env.BRIDGE_DATA_DIR) {
  console.log('\n提示: 容器内默认 /data；本地检查可设置 BRIDGE_DATA_DIR=./data');
}
