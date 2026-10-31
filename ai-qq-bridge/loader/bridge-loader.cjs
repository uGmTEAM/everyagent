const path = require('path');
const { pathToFileURL } = require('url');

// 安装时会把 __BRIDGE_HOME__ 替换为实际安装目录，避免必须通过 aiqq-run 启动
const injectedHome = '__BRIDGE_HOME__';
const home = process.env.BRIDGE_HOME ||
  (injectedHome.startsWith('/') ? injectedHome : path.resolve(__dirname, '..'));
const entry = process.env.BRIDGE_ENTRY || path.join(home, 'src', 'index.mjs');

console.log('[bridge] loading', entry);
import(pathToFileURL(entry).href).catch(error => {
  console.error('[bridge] 启动失败', error);
  process.exit(1);
});
