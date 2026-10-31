import fs from 'node:fs';
import path from 'node:path';
import { safeStringify } from './util.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor ({ dir, level = 'info', buffer = 500, name = 'bridge' }) {
    this.dir = dir;
    this.level = LEVELS[level] ? level : 'info';
    this.bufferSize = buffer;
    this.name = name;
    this.buffer = [];
    this.file = null;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      this.file = path.join(dir, `${name}-${day}.log`);
    }
  }

  _write (level, args) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const time = new Date().toISOString();
    const message = args.map(item => {
      if (typeof item === 'string') return item;
      if (item instanceof Error) return `${item.message}\n${item.stack || ''}`;
      return safeStringify(item);
    }).join(' ');
    const line = `${time} [${level.toUpperCase()}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.buffer.push({ time, level, message });
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    if (this.file) {
      try {
        fs.appendFileSync(this.file, line + '\n');
      } catch {
        // 日志落盘失败不影响主流程
      }
    }
  }

  debug (...args) { this._write('debug', args); }
  info (...args) { this._write('info', args); }
  log (...args) { this._write('info', args); }
  warn (...args) { this._write('warn', args); }
  error (...args) { this._write('error', args); }

  tail (count = 200) {
    return this.buffer.slice(-count);
  }
}
