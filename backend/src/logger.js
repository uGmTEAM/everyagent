const fs = require('fs');
const path = require('path');
const config = require('./config');
const events = require('./events');
const { ensureDir, nowIso } = require('./util');

const SERVER_LOG = path.join(config.logsDir, 'server.log');
const buffers = { stdout: '', stderr: '' };
let initialized = false;

function writeLine(stream, line) {
  const at = nowIso();
  const text = `[${at}] [${stream}] ${line}`;
  try {
    fs.appendFileSync(SERVER_LOG, `${text}\n`, 'utf8');
  } catch {
    // 日志文件写入失败不应影响主进程
  }
  try {
    events.emitServerLog({ line: text, stream, at });
  } catch {
    // ignore
  }
}

function consume(stream, chunk) {
  if (chunk === null || chunk === undefined) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  buffers[stream] += text;

  let index = buffers[stream].indexOf('\n');
  while (index >= 0) {
    let line = buffers[stream].slice(0, index).replace(/\r$/, '');
    buffers[stream] = buffers[stream].slice(index + 1);
    if (line.length > 20000) line = `${line.slice(0, 20000)} ...[截断]`;
    if (line.length) writeLine(stream, line);
    index = buffers[stream].indexOf('\n');
  }

  if (buffers[stream].length > 200000) {
    writeLine(stream, `${buffers[stream].slice(0, 20000)} ...[截断]`);
    buffers[stream] = '';
  }
}

function init() {
  if (initialized) return;
  initialized = true;
  ensureDir(config.logsDir);
  try {
    fs.appendFileSync(SERVER_LOG, `\n=== 服务端日志启动 ${nowIso()} ===\n`, 'utf8');
  } catch {
    // ignore
  }

  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = function patchedStdout(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    consume('stdout', chunk);
    return originalOut(chunk, encoding, callback);
  };

  process.stderr.write = function patchedStderr(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    consume('stderr', chunk);
    return originalErr(chunk, encoding, callback);
  };

  process.on('exit', () => {
    for (const [stream, buffer] of Object.entries(buffers)) {
      if (buffer.trim()) writeLine(stream, buffer.trim());
    }
  });
}

function serverLogPath() {
  return SERVER_LOG;
}

function tailServerLines(maxLines = 500) {
  try {
    const stat = fs.statSync(SERVER_LOG);
    const maxBytes = 512 * 1024;
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const fd = fs.openSync(SERVER_LOG, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    let lines = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) lines = lines.slice(1);
    return lines.filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

module.exports = {
  init,
  serverLogPath,
  tailServerLines,
  SERVER_LOG
};
