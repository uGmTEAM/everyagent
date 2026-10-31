import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { httpGetBuffer, httpPostJson, readJsonBody, sendJson } from '../util.mjs';
import { attachWsServer, connectWsClient } from './ws.mjs';

function shortId (raw) {
  const hash = createHash('md5').update(String(raw)).digest();
  return hash.readUInt32BE(0) % 2147483647;
}

function toOb11Segments (msg) {
  const out = [];
  for (const segment of msg.segments || []) {
    switch (segment.type) {
      case 'text':
        out.push({ type: 'text', data: { text: segment.text } });
        break;
      case 'at':
        out.push({ type: 'at', data: { qq: segment.qq === 'all' ? 'all' : segment.qq } });
        break;
      case 'image':
        out.push({
          type: 'image',
          data: {
            file: segment.media_url || segment.file || segment.local_path || '',
            url: segment.url || '',
            path: segment.local_path || '',
            file_size: segment.size || 0
          }
        });
        break;
      case 'file':
        out.push({
          type: 'file',
          data: {
            file: segment.local_path || segment.path || segment.name || '',
            name: segment.name || '',
            file_size: segment.size || 0
          }
        });
        break;
      case 'voice':
        out.push({ type: 'record', data: { file: segment.local_path || segment.path || segment.name || '' } });
        break;
      case 'video':
        out.push({ type: 'video', data: { file: segment.local_path || segment.path || segment.name || '' } });
        break;
      case 'face':
        out.push({ type: 'face', data: { id: String(segment.id || '') } });
        break;
      case 'reply':
        out.push({ type: 'reply', data: { id: String(segment.id || '') } });
        break;
      case 'forward':
        out.push({ type: 'forward', data: { id: segment.res_id || '' } });
        break;
      default:
        break;
    }
  }
  return out;
}

function toOb11Message (msg, selfId) {
  const isGroup = msg.chat_type === 'group';
  const message = toOb11Segments(msg);
  const raw = message.map(item => {
    if (item.type === 'text') return item.data.text;
    if (item.type === 'at') return `[CQ:at,qq=${item.data.qq}]`;
    if (item.type === 'image') return '[图片]';
    if (item.type === 'face') return '[表情]';
    if (item.type === 'reply') return '[回复]';
    return `[${item.type}]`;
  }).join('');
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: 'normal',
    time: msg.time,
    self_id: Number(selfId),
    message_id: shortId(msg.id),
    raw_message_id: String(msg.id),
    user_id: Number(msg.sender?.uin || 0),
    group_id: isGroup ? Number(msg.conversation?.qq || msg.conversation?.id || 0) : undefined,
    message,
    raw_message: raw,
    font: 0,
    message_format: 'array',
    sender: {
      user_id: Number(msg.sender?.uin || 0),
      nickname: msg.sender?.name || '',
      card: msg.sender?.name || ''
    }
  };
}

async function materializeOneBotImage (seg, app) {
  const file = String(seg.path || seg.file || '');
  if (seg.base64) return { base64: String(seg.base64) };
  if (/^https?:\/\//i.test(file)) {
    const buffer = await httpGetBuffer(file, { timeout: 30000, maxBytes: 100 * 1024 * 1024 });
    const ext = path.extname(new URL(file).pathname) || '.png';
    const temp = path.join(app.config._dataDir, 'tmp', `onebot-${Date.now()}${ext}`);
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    fs.writeFileSync(temp, buffer);
    return { path: temp };
  }
  return { path: file };
}

async function toSendSegments (message, app) {
  if (typeof message === 'string') {
    return [{ type: 'text', text: message }];
  }
  if (!Array.isArray(message)) throw new Error('message 必须是字符串或数组');
  const out = [];
  for (const item of message) {
    const data = item?.data || {};
    switch (item?.type) {
      case 'text':
        out.push({ type: 'text', text: String(data.text || '') });
        break;
      case 'at':
        out.push({ type: 'at', qq: String(data.qq || ''), name: data.name });
        break;
      case 'image':
        out.push({ type: 'image', ...(await materializeOneBotImage(data, app)) });
        break;
      case 'file':
        out.push({ type: 'file', path: data.file || data.path, name: data.name || '' });
        break;
      case 'reply':
        out.push({ type: 'reply', id: String(data.id || '') });
        break;
      case 'face':
        out.push({ type: 'face', id: Number(data.id || 0), text: '[表情]' });
        break;
      case 'record':
        throw new Error('暂不支持发送语音');
      case 'video':
        throw new Error('暂不支持发送视频');
      default:
        throw new Error(`不支持的 OneBot 消息段: ${item?.type}`);
    }
  }
  return out;
}

export async function startOneBot (app) {
  const config = app.config.onebot;
  const clients = new Set();
  let reverseConn = null;
  let reverseTimer = null;
  let heartbeatTimer = null;

  const broadcast = event => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      try { client.sendText(payload); } catch { /* ignore */ }
    }
    if (config.webhook) {
      httpPostJson(config.webhook, event, { timeout: 8000 })
        .catch(error => app.logger?.debug('[onebot] webhook 推送失败', error?.message || error));
    }
  };

  const onMessage = msg => {
    if (!msg) return;
    broadcast(toOb11Message(msg, app.selfInfo?.uin || '0'));
  };
  app.on('message', onMessage);

  const actions = {
    get_login_info: async () => ({ user_id: Number(app.selfInfo?.uin || 0), nickname: app.selfInfo?.nick || '' }),
    get_status: async () => ({
      online: !!app.login?.publicState().online,
      good: true,
      stat: { packet_received: 0, packet_sent: 0 }
    }),
    get_version_info: async () => ({
      app_name: 'ai-qq-bridge',
      app_version: '0.1.0',
      protocol_version: 'v11'
    }),
    get_group_list: async () => (await app.api.getGroups()).map(item => ({
      group_id: Number(item.id),
      group_name: item.name,
      member_count: item.member_count,
      max_member_count: item.max_member_count
    })),
    get_friend_list: async () => (await app.api.getFriends()).map(item => ({
      user_id: Number(item.uin),
      nickname: item.name,
      remark: item.remark
    })),
    can_send_image: async () => ({ yes: true }),
    can_send_record: async () => ({ yes: false }),
    send_msg: async payload => {
      const target = payload.message_type === 'group'
        ? { type: 'group', id: String(payload.group_id) }
        : { type: 'private', id: String(payload.user_id) };
      const segments = await toSendSegments(payload.message, app);
      const result = await app.api.send(target, segments);
      return { message_id: shortId(result.message_id || Date.now()) };
    },
    send_private_msg: async payload => actions.send_msg({ ...payload, message_type: 'private' }),
    send_group_msg: async payload => actions.send_msg({ ...payload, message_type: 'group' })
  };

  const authorize = (req, url) => {
    if (!config.token) return true;
    const header = req.headers['authorization'] || '';
    if (header === `Bearer ${config.token}` || header === `Token ${config.token}`) return true;
    if (url.searchParams.get('access_token') === config.token) return true;
    return false;
  };

  const apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!authorize(req, url)) {
      sendJson(res, 401, { status: 'failed', retcode: 1403, data: null, message: 'token 校验失败' });
      return;
    }
    const action = url.pathname.replace(/^\//, '');
    const handler = actions[action];
    if (!handler) {
      sendJson(res, 200, { status: 'failed', retcode: 1404, data: null, message: `不支持的动作 ${action}` });
      return;
    }
    try {
      const payload = req.method === 'POST' ? await readJsonBody(req, 20 * 1024 * 1024) : Object.fromEntries(url.searchParams);
      const data = await handler(payload);
      sendJson(res, 200, { status: 'ok', retcode: 0, data });
    } catch (error) {
      sendJson(res, 200, { status: 'failed', retcode: 100, data: null, message: error.message || String(error) });
    }
  });
  apiServer.listen(config.port, config.host, () => {
    app.logger?.info(`[onebot] HTTP API 已启动 http://${config.host}:${config.port}`);
  });

  let wsServer = null;
  if (config.websocket?.enabled !== false) {
    wsServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachWsServer(wsServer, conn => {
      clients.add(conn);
      conn.on('close', () => clients.delete(conn));
      conn.on('error', () => clients.delete(conn));
      conn.sendText(JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        time: Math.floor(Date.now() / 1000),
        self_id: Number(app.selfInfo?.uin || 0)
      }));
    });
    wsServer.listen(config.websocket.port, config.host, () => {
      app.logger?.info(`[onebot] 正向 WebSocket 已启动 ws://${config.host}:${config.websocket.port}`);
    });
  }

  if (config.reverseWebsocket) {
    const connect = () => {
      reverseConn = connectWsClient(config.reverseWebsocket, {
        onOpen: conn => {
          clients.add(conn);
          conn.sendText(JSON.stringify({
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: 'connect',
            time: Math.floor(Date.now() / 1000),
            self_id: Number(app.selfInfo?.uin || 0)
          }));
          conn.on('close', () => clients.delete(conn));
          app.logger?.info('[onebot] 反向 WebSocket 已连接');
        },
        onMessage: async text => {
          try {
            const payload = JSON.parse(text);
            if (payload?.action && actions[payload.action]) {
              const data = await actions[payload.action](payload.params || {});
              reverseConn?.sendText(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo }));
            }
          } catch (error) {
            app.logger?.debug('[onebot] 反向 WS 动作处理失败', error?.message || error);
          }
        },
        onClose: () => {
          reverseTimer = setTimeout(connect, 5000);
        },
        onError: error => app.logger?.debug('[onebot] 反向 WS 错误', error?.message || error)
      });
    };
    connect();
  }

  heartbeatTimer = setInterval(() => {
    broadcast({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      time: Math.floor(Date.now() / 1000),
      self_id: Number(app.selfInfo?.uin || 0),
      interval: 30000,
      status: { online: !!app.login?.publicState().online, good: true }
    });
  }, 30000);

  app.logger?.info('[onebot] 兼容层已启用');

  return {
    running: true,
    stop () {
      app.off('message', onMessage);
      clearInterval(heartbeatTimer);
      if (reverseTimer) clearTimeout(reverseTimer);
      for (const client of clients) client.close();
      clients.clear();
      apiServer.close();
      wsServer?.close();
    }
  };
}
