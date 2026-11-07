// 干净重启：先排空在途请求并标记「干净退出」，再重新拉起自身进程。
// 与直接杀进程的区别：不会触发异常恢复（recovery），因此不补偿 tokens、不重启 AI 容器。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let handler = null;
let restarting = false;

function register(fn) {
  handler = fn;
}

function isRestarting() {
  return restarting;
}

async function trigger(reason = 'manual') {
  if (restarting) return { ok: false, reason: 'already_restarting' };
  if (!handler) throw new Error('重启处理器尚未就绪');
  restarting = true;
  try {
    await handler(reason);
    return { ok: true };
  } catch (error) {
    restarting = false;
    throw error;
  }
}

// 重新拉起自身：脱离父进程存活，输出追加到服务日志
function spawnSelf() {
  let fd = null;
  const stdio = ['ignore', 'ignore', 'ignore'];
  try {
    fs.mkdirSync(config.logsDir, { recursive: true });
    fd = fs.openSync(path.join(config.logsDir, 'server.log'), 'a');
    stdio[1] = fd;
    stdio[2] = fd;
  } catch {
    // 日志不可写时退回丢弃输出，保证进程能起来
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio
  });
  child.unref();
  return child.pid;
}

module.exports = {
  register,
  trigger,
  isRestarting,
  spawnSelf
};
