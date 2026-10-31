import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { ensureDir, monthKey, readJson, writeJsonAtomic } from '../util.mjs';

const MAX_PENDING = 20000;
const DEDUPE_LIMIT = 5000;

/**
 * 未读消息队列：
 * - 按月落盘为 JSONL，永不自动清理
 * - 游标语义：pull 即出队
 * - 重启后从游标处重新装载未读，保证不丢
 */
export class MessageQueue extends EventEmitter {
  constructor ({ dir, logger }) {
    super();
    this.dir = ensureDir(dir);
    this.logger = logger;
    this.statePath = path.join(this.dir, 'state.json');
    this.state = { cursor: '0', month: '', lastSeq: 0, lastReceiveAt: 0 };
    this.pending = [];
    this.seen = new Set();
    this.seenOrder = [];
    this.ready = false;
  }

  async init () {
    this.state = {
      cursor: '0',
      month: '',
      lastSeq: 0,
      lastReceiveAt: 0,
      ...readJson(this.statePath, {})
    };
    this.state.cursor = String(this.state.cursor || '0');
    this.state.lastSeq = Number(this.state.lastSeq || 0);
    this.state.lastReceiveAt = Number(this.state.lastReceiveAt || 0);

    await this._scanPending(MAX_PENDING);
    await this._loadDedupe();
    this.ready = true;
    this.logger?.info(`[queue] 初始化完成，游标=${this.state.cursor}，未读=${this.pending.length}，lastSeq=${this.state.lastSeq}`);
  }

  _months () {
    try {
      return fs.readdirSync(this.dir)
        .filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  _fileOf (month) {
    return path.join(this.dir, `${month}.jsonl`);
  }

  async _scanPending (limit) {
    const months = this._months();
    if (months.length === 0) return;
    const cursorSeq = BigInt(this.state.cursor);
    const startMonth = this.state.month && months.includes(`${this.state.month}.jsonl`)
      ? this.state.month
      : months[0].slice(0, 7);

    for (const name of months) {
      const month = name.slice(0, 7);
      if (month < startMonth) continue;
      if (this.pending.length >= limit) break;
      const file = this._fileOf(month);
      const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (BigInt(msg.seq || 0) > cursorSeq) {
          this.pending.push(msg);
        }
        if (this.pending.length >= limit) {
          rl.close();
          break;
        }
      }
    }
    // 保持 seq 顺序（文件本身是按追加顺序写入的）
    this.pending.sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  async _loadDedupe () {
    const months = this._months();
    if (months.length === 0) return;
    const file = this._fileOf(months[months.length - 1].slice(0, 7));
    const lines = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > DEDUPE_LIMIT) lines.shift();
    }
    rl.close();
    for (const line of lines) {
      try {
        const id = JSON.parse(line).id;
        if (id) this._remember(id);
      } catch {
        // ignore
      }
    }
  }

  _remember (id) {
    if (!id || this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > DEDUPE_LIMIT * 2) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - DEDUPE_LIMIT);
      for (const old of drop) this.seen.delete(old);
    }
  }

  hasSeen (id) {
    return this.seen.has(String(id));
  }

  _saveState () {
    try {
      writeJsonAtomic(this.statePath, this.state);
    } catch (error) {
      this.logger?.error('[queue] 保存状态失败', error);
    }
  }

  append (message) {
    const seq = ++this.state.lastSeq;
    const time = Number(message.time || Math.floor(Date.now() / 1000));
    const month = monthKey(new Date(time * 1000));
    const record = { ...message, seq };
    const file = this._fileOf(month);
    ensureDir(path.dirname(file));
    try {
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
    } catch (error) {
      this.logger?.error('[queue] 写入消息失败', error);
      this.state.lastSeq = seq - 1;
      return null;
    }
    this._remember(record.id);
    this.pending.push(record);
    this.emit('message', record);
    return record;
  }

  async pull (limit = 20) {
    if (this.pending.length === 0) {
      await this._scanPending(Math.max(limit, 200));
    }
    const batch = this.pending.splice(0, limit);
    if (batch.length > 0) {
      const last = batch[batch.length - 1];
      this.state.cursor = String(last.seq);
      this.state.month = monthKey(new Date(Number(last.time || 0) * 1000));
      this._saveState();
    }
    return batch;
  }

  pendingCount () {
    return this.pending.length;
  }

  cursor () {
    return this.state.cursor;
  }

  getLastReceiveAt () {
    return this.state.lastReceiveAt;
  }

  markReceiveTime (timestamp) {
    if (Number(timestamp) > this.state.lastReceiveAt) {
      this.state.lastReceiveAt = Number(timestamp);
      this._saveState();
    }
  }

  waitForMessage (timeoutMs) {
    if (this.pending.length > 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.off('message', onMessage);
        resolve(false);
      }, timeoutMs);
      const onMessage = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
        resolve(true);
      };
      this.once('message', onMessage);
    });
  }
}
