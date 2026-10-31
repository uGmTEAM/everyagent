import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame (opcode, payload, mask) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const maskKey = crypto.randomBytes(4);
  header[1] |= 0x80;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

export class WsConnection extends EventEmitter {
  constructor (socket, { mask = false } = {}) {
    super();
    this.socket = socket;
    this.mask = mask;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });
    socket.on('error', error => this.emit('error', error));
  }

  _onData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = this._parseFrame();
      if (!frame) break;
      if (frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', full.toString('utf8'));
        }
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        this.fragments = [frame.payload];
        if (frame.fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', full.toString('utf8'));
        }
      } else if (frame.opcode === 0x8) {
        this.close();
        break;
      } else if (frame.opcode === 0x9) {
        this._write(0xA, frame.payload);
      }
    }
  }

  _parseFrame () {
    if (this.buffer.length < 2) return null;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const fin = !!(b0 & 0x80);
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      length = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + length) return null;
    let payload = this.buffer.subarray(offset, offset + length);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _write (opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(opcode, payload, this.mask));
    } catch {
      // ignore
    }
  }

  sendText (text) {
    this._write(0x1, Buffer.from(String(text), 'utf8'));
  }

  close () {
    if (this.closed) return;
    this._write(0x8, Buffer.alloc(0));
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      // ignore
    }
  }
}

export function attachWsServer (server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'));
    const conn = new WsConnection(socket, { mask: false });
    onConnection(conn, req);
  });
}

export function connectWsClient (url, { onOpen, onMessage, onClose, onError } = {}) {
  const target = new URL(url);
  const isSecure = target.protocol === 'wss:';
  const transport = isSecure ? https : http;
  const key = crypto.randomBytes(16).toString('base64');
  const req = transport.request({
    hostname: target.hostname,
    port: target.port || (isSecure ? 443 : 80),
    path: target.pathname + target.search,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13'
    }
  });

  req.on('upgrade', (res, socket) => {
    const conn = new WsConnection(socket, { mask: true });
    conn.on('message', text => onMessage?.(text));
    conn.on('close', () => onClose?.());
    conn.on('error', error => onError?.(error));
    onOpen?.(conn);
  });
  req.on('response', res => {
    onError?.(new Error(`WebSocket 握手失败 HTTP ${res.statusCode}`));
    res.resume();
  });
  req.on('error', error => onError?.(error));
  req.end();
  return req;
}
