const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const agents = require('./agents');
const { addEvent } = require('./events');
const { nowIso, truncate } = require('./util');

let timer = null;
let polling = false;
const unreachableCount = new Map();

function bridgePort(seq) {
  return config.bridgeBasePort + Number(seq);
}

function bridgeBase(agent) {
  return `http://127.0.0.1:${bridgePort(agent.seq)}`;
}

async function bridgeFetch(agent, pathname, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  const response = await fetch(`${bridgeBase(agent)}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function stateOf(agentId) {
  return db.get('SELECT * FROM companion_state WHERE agent_id = ?', [agentId]);
}

function ensureState(agentId) {
  db.run(
    `INSERT INTO companion_state (agent_id, updated_at) VALUES (?, ?)
     ON CONFLICT(agent_id) DO NOTHING`,
    [agentId, nowIso()]
  );
}

function bindingOf(agentId) {
  return db.get('SELECT * FROM qq_bindings WHERE agent_id = ?', [agentId]);
}

function ensureBinding(agentId) {
  db.run(
    `INSERT INTO qq_bindings (agent_id, updated_at) VALUES (?, ?)
     ON CONFLICT(agent_id) DO NOTHING`,
    [agentId, nowIso()]
  );
}

function segmentsToText(segments) {
  const parts = [];
  for (const segment of segments || []) {
    if (segment.type === 'text') parts.push(String(segment.text || ''));
    else if (segment.type === 'at') parts.push(`@${segment.name || segment.qq || ''}`);
    else if (segment.type === 'image') {
      const path = segment.local_path || '';
      parts.push(path ? `[图片 path=${path}]` : `[图片${segment.media_url ? ` url=${segment.media_url}` : ''}]`);
    } else if (segment.type === 'file') {
      parts.push(`[文件 ${segment.name || ''}${segment.size ? ` ${segment.size}B` : ''}]`);
    } else if (segment.type === 'voice') {
      parts.push(`[语音${segment.duration ? ` ${segment.duration}s` : ''}]`);
    } else if (segment.type === 'video') {
      parts.push(`[视频${segment.duration ? ` ${segment.duration}s` : ''}]`);
    } else if (segment.type === 'face') parts.push('[表情]');
    else if (segment.type === 'reply') parts.push(`[回复 msg_id=${segment.id || ''}]`);
    else if (segment.type === 'reminder') parts.push('[定时提醒]');
  }
  return parts.join('').trim();
}

function deriveInbound(message) {
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  const attachments = segments
    .filter((segment) => ['image', 'file', 'voice', 'video'].includes(segment.type))
    .map((segment) => ({
      kind: segment.type,
      path: segment.local_path || '',
      url: segment.media_url || segment.url || '',
      name: segment.name || segment.file || '',
      size: Number(segment.size || 0),
      width: Number(segment.width || 0),
      height: Number(segment.height || 0),
      duration: Number(segment.duration || 0),
      message_id: String(message?.id || ''),
      element_id: String(segment.element_id || ''),
      needs_fetch: !segment.local_path
    }));
  const atList = segments
    .filter((segment) => segment.type === 'at')
    .map((segment) => ({ uin: String(segment.qq || ''), name: segment.name || '' }));
  const replyTo = segments.find((segment) => segment.type === 'reply') || null;
  const isGroupLike = message?.chat_type === 'group' || message?.chat_type === 'temp';
  return {
    segments,
    attachments,
    at_list: atList,
    reply_to: replyTo
      ? { msg_id: String(replyTo.id || ''), seq: String(replyTo.seq || ''), sender_uin: String(replyTo.sender_uin || '') }
      : null,
    group: isGroupLike
      ? { id: String(message?.conversation?.id || ''), name: message?.conversation?.name || '' }
      : null
  };
}

function isAtSelf(message, selfUin) {
  if (!selfUin) return false;
  return (message.segments || []).some(
    (segment) => segment.type === 'at' && String(segment.qq || '') === String(selfUin)
  );
}

function conversationKind(message) {
  const chatType = String(message.chat_type || 'private');
  if (chatType === 'group' || chatType === 'channel') return chatType;
  return 'private';
}

function insertInbound(agent, message, selfUin) {
  const bridgeId = String(message.id || '');
  if (!bridgeId) return null;
  const existing = db.get(
    'SELECT id FROM companion_messages WHERE agent_id = ? AND bridge_msg_id = ?',
    [agent.id, bridgeId]
  );
  if (existing) return null;

  const kind = conversationKind(message);
  const content = segmentsToText(message.segments) || '[非文本消息]';
  const needsReply = kind === 'private' || (kind === 'group' && isAtSelf(message, selfUin)) ? 1 : 0;
  const conversation = message.conversation || {};
  const sender = message.sender || {};
  const createdAt = message.time
    ? new Date(Number(message.time) * 1000).toISOString()
    : nowIso();

  const result = db.run(
    `INSERT INTO companion_messages
      (agent_id, bridge_msg_id, conversation_id, conversation_kind, conversation_name,
       sender_uin, sender_name, direction, content, segments_json, needs_reply, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in', ?, ?, ?, ?)`,
    [
      agent.id,
      bridgeId,
      String(conversation.id || sender.uin || ''),
      kind,
      conversation.name || sender.name || null,
      String(sender.uin || ''),
      sender.name || null,
      truncate(content, 20000),
      JSON.stringify(message.segments || []),
      needsReply,
      createdAt
    ]
  );
  return Number(result.lastInsertRowid);
}

function buildSegments({ kind, text, replyTo, senderUin, senderName }) {
  const segments = [];
  if (replyTo) segments.push({ type: 'reply', id: String(replyTo) });
  if (kind === 'group' && senderUin) {
    segments.push({ type: 'at', qq: String(senderUin), name: senderName || '' });
  }
  segments.push({ type: 'text', text: ` ${text}`.trim() });
  return segments;
}

function recordOutbound(agent, { bridgeMsgId = null, conversationId, kind = 'private', conversationName = null, content, segments = [] }) {
  db.run(
    `INSERT INTO companion_messages
      (agent_id, bridge_msg_id, conversation_id, conversation_kind, conversation_name,
       sender_uin, sender_name, direction, content, segments_json, needs_reply, delivered_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'out', ?, ?, 0, ?, ?)`,
    [
      agent.id,
      bridgeMsgId ? String(bridgeMsgId) : null,
      String(conversationId),
      kind === 'group' ? 'group' : 'private',
      conversationName,
      content,
      JSON.stringify(segments),
      nowIso(),
      nowIso()
    ]
  );
}

async function sendText(agent, { conversationId, kind = 'private', text, replyTo = null, senderUin = null, senderName = null }) {
  const content = String(text || '').trim();
  if (!content) throw new Error('消息内容不能为空');
  const targetType = kind === 'group' ? 'group' : 'private';
  const payload = {
    target: { type: targetType, id: String(conversationId) },
    segments: buildSegments({ kind, text: content, replyTo, senderUin, senderName })
  };
  const result = await bridgeFetch(agent, '/v1/messages', {
    method: 'POST',
    body: payload,
    timeoutMs: 30000
  });

  recordOutbound(agent, {
    bridgeMsgId: result?.message_id || null,
    conversationId,
    kind,
    content,
    segments: payload.segments
  });
  return result;
}

async function sendMedia(agent, { conversationId, kind = 'private', type = 'image', path = '', base64 = '', url = '', name = '', replyTo = null }) {
  const mediaType = type === 'file' ? 'file' : 'image';
  if (!path && !base64 && !url) throw new Error('需要 path / base64 / url 之一');
  const segment = { type: mediaType };
  if (path) segment.path = String(path);
  if (base64) segment.base64 = String(base64);
  if (url) segment.url = String(url);
  if (name) segment.name = String(name);
  const segments = replyTo ? [{ type: 'reply', id: String(replyTo) }, segment] : [segment];
  const payload = {
    target: { type: kind === 'group' ? 'group' : 'private', id: String(conversationId) },
    segments
  };
  const result = await bridgeFetch(agent, '/v1/messages', {
    method: 'POST',
    body: payload,
    timeoutMs: 60000
  });
  const content = mediaType === 'file' ? `[文件 ${name || ''}]` : '[图片]';
  recordOutbound(agent, {
    bridgeMsgId: result?.message_id || null,
    conversationId,
    kind,
    content,
    segments
  });
  return result;
}

async function fetchMedia(agent, { messageId, elementId, chatType = 'private', conversationId }) {
  if (!messageId || !elementId || !conversationId) {
    throw new Error('缺少 message_id / element_id / conversation_id');
  }
  return bridgeFetch(agent, '/v1/media/fetch', {
    method: 'POST',
    body: {
      message_id: String(messageId),
      element_id: String(elementId),
      chat_type: chatType === 'group' ? 'group' : 'private',
      conversation_id: String(conversationId)
    },
    timeoutMs: 90000
  });
}

async function groupMembers(agent, groupId, { limit = 100, offset = 0 } = {}) {
  return bridgeFetch(
    agent,
    `/v1/groups/${encodeURIComponent(String(groupId))}/members?limit=${Number(limit) || 100}&offset=${Number(offset) || 0}`,
    { timeoutMs: 30000 }
  );
}

async function groupInfo(agent, groupId) {
  return bridgeFetch(agent, `/v1/groups/${encodeURIComponent(String(groupId))}/info`, { timeoutMs: 20000 });
}

async function friendProfile(agent, uin) {
  return bridgeFetch(agent, `/v1/friends/${encodeURIComponent(String(uin))}/profile`, { timeoutMs: 20000 });
}

async function revoke(agent, { conversationId, kind = 'private', messageId }) {
  if (!conversationId || !messageId) throw new Error('缺少 conversation_id / message_id');
  return bridgeFetch(agent, '/v1/messages/revoke', {
    method: 'POST',
    body: {
      chat_type: kind === 'group' ? 'group' : 'private',
      conversation_id: String(conversationId),
      message_id: String(messageId)
    },
    timeoutMs: 20000
  });
}

async function pollAgent(agent) {
  ensureState(agent.id);
  ensureBinding(agent.id);

  let health = null;
  try {
    health = await bridgeFetch(agent, '/health', { timeoutMs: 8000 });
  } catch (error) {
    db.run(
      'UPDATE companion_state SET bridge_reachable = 0, last_error = ?, last_poll_at = ?, updated_at = ? WHERE agent_id = ?',
      [truncate(error.message, 500), nowIso(), nowIso(), agent.id]
    );
    db.run(
      'UPDATE qq_bindings SET bridge_ready = 0, last_error = ?, last_check_at = ?, updated_at = ? WHERE agent_id = ?',
      [truncate(error.message, 500), nowIso(), nowIso(), agent.id]
    );
    await maybeRestartQq(agent);
    return;
  }

  unreachableCount.delete(agent.id);
  const uin = String(health?.qq?.uin || '');
  const online = Boolean(health?.qq?.online);
  db.run(
    'UPDATE companion_state SET bridge_reachable = 1, last_error = NULL, last_poll_at = ?, updated_at = ? WHERE agent_id = ?',
    [nowIso(), nowIso(), agent.id]
  );
  db.run(
    `UPDATE qq_bindings
        SET uin = ?, logged_in = ?, bridge_ready = 1, last_error = ?, last_check_at = ?, updated_at = ?
      WHERE agent_id = ?`,
    [
      uin || null,
      online ? 1 : 0,
      online ? null : `QQ 未登录（${health?.qq?.phase || 'unknown'}）`,
      nowIso(),
      nowIso(),
      agent.id
    ]
  );

  if (!online) return;

  const state = stateOf(agent.id);
  const cursor = state?.cursor || '';
  let data = null;
  try {
    const query = `limit=20&wait=${config.companionPollWaitSec}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    data = await bridgeFetch(agent, `/v1/messages?${query}`, { timeoutMs: (config.companionPollWaitSec + 3) * 1000 });
  } catch (error) {
    if (Number(error.status) === 503) return;
    db.run(
      'UPDATE companion_state SET last_error = ?, last_poll_at = ?, updated_at = ? WHERE agent_id = ?',
      [truncate(error.message, 500), nowIso(), nowIso(), agent.id]
    );
    return;
  }

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  for (const message of messages) {
    const inserted = insertInbound(agent, message, uin);
    if (inserted) {
      addEvent(agent.id, 'companion_in', `收到 ${message.chat_type === 'group' ? '群' : '私聊'}消息。`, {
        conversation_id: message.conversation?.id,
        bridge_msg_id: message.id
      });
    }
  }
  if (data?.next_cursor) {
    db.run(
      'UPDATE companion_state SET cursor = ?, last_poll_at = ?, updated_at = ? WHERE agent_id = ?',
      [String(data.next_cursor), nowIso(), nowIso(), agent.id]
    );
  }
}

async function maybeRestartQq(agent) {
  const count = Number(unreachableCount.get(agent.id) || 0) + 1;
  unreachableCount.set(agent.id, count);
  if (count < 5) return;
  unreachableCount.set(agent.id, 0);

  const info = await docker.inspectContainer(agent.container_id).catch(() => null);
  if (!info?.State?.Running) return;

  try {
    const exec = await docker.client().getContainer(agent.container_id).exec({
      Cmd: ['sh', '-c', 'pkill -f /opt/QQ/qq || pkill -f QQ || true'],
      AttachStdout: false,
      AttachStderr: false
    });
    await exec.start({ Detach: true });
    db.run(
      'UPDATE qq_bindings SET qq_restarts = qq_restarts + 1, updated_at = ? WHERE agent_id = ?',
      [nowIso(), agent.id]
    );
    addEvent(agent.id, 'qq_restart', 'QQ 通讯桥连续无响应，已请求容器内重启 QQ。');
  } catch (error) {
    addEvent(agent.id, 'qq_restart_error', `请求重启 QQ 失败：${error.message}`);
  }
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const list = db.all(
      "SELECT * FROM agents WHERE mode = 'companion' AND status NOT IN ('dead','finalizing','suspended','paused_disk') ORDER BY seq"
    );
    for (const agent of list) {
      if (!(await docker.isAvailable())) break;
      const info = await docker.inspectContainer(agent.container_id).catch(() => null);
      if (!info?.State?.Running) continue;
      await pollAgent(agent).catch((error) => {
        addEvent(agent.id, 'companion_error', `陪伴轮询失败：${error.message}`);
      });
    }
  } catch (error) {
    console.error('[companion] tick 失败', error.message);
  } finally {
    polling = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick();
  }, config.companionPollIntervalMs);
  setTimeout(() => {
    tick();
  }, 2000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function recentConversations(agentId, limit = 30) {
  return db.all(
    `SELECT conversation_id, conversation_kind,
            MAX(conversation_name) AS conversation_name,
            COUNT(*) AS message_count,
            MAX(created_at) AS last_at,
            MAX(id) AS last_id
       FROM companion_messages
      WHERE agent_id = ?
      GROUP BY conversation_id, conversation_kind
      ORDER BY last_id DESC
      LIMIT ?`,
    [agentId, limit]
  );
}

function conversationMessages(agentId, conversationId, limit = 200) {
  return db.all(
    `SELECT * FROM companion_messages
      WHERE agent_id = ? AND conversation_id = ?
      ORDER BY id DESC LIMIT ?`,
    [agentId, conversationId, limit]
  ).reverse();
}

function pendingForAgent(agentId, limit = 10) {
  return db.all(
    `SELECT * FROM companion_messages
      WHERE agent_id = ? AND direction = 'in' AND needs_reply = 1 AND delivered_at IS NULL
      ORDER BY id ASC LIMIT ?`,
    [agentId, limit]
  );
}

function markDelivered(ids = []) {
  const stamp = nowIso();
  for (const id of ids) {
    db.run('UPDATE companion_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL', [stamp, id]);
  }
}

function contextFor(agentId, conversationId, beforeId, limit = 8) {
  return db.all(
    `SELECT * FROM companion_messages
      WHERE agent_id = ? AND conversation_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?`,
    [agentId, conversationId, beforeId, limit]
  ).reverse();
}

function stats(agentId) {
  const row = db.get(
    `SELECT
       (SELECT COUNT(*) FROM companion_messages WHERE agent_id = ? AND direction = 'in') AS incoming,
       (SELECT COUNT(*) FROM companion_messages WHERE agent_id = ? AND direction = 'out') AS outgoing,
       (SELECT COUNT(DISTINCT conversation_id) FROM companion_messages WHERE agent_id = ?) AS conversations`,
    [agentId, agentId, agentId]
  );
  return {
    incoming: Number(row?.incoming || 0),
    outgoing: Number(row?.outgoing || 0),
    conversations: Number(row?.conversations || 0)
  };
}

async function qrcode(agent) {
  return bridgeFetch(agent, '/v1/login/qrcode', { timeoutMs: 30000 });
}

async function refreshQrcode(agent) {
  return bridgeFetch(agent, '/v1/login/refresh', { method: 'POST', body: {}, timeoutMs: 30000 });
}

async function switchAccount(agent, index) {
  return bridgeFetch(agent, '/v1/accounts/switch', { method: 'POST', body: { index }, timeoutMs: 30000 });
}

// 管理者账号登记：平台添加或 AI 确认身份后手动补充，QQ/邮箱消息需与登记账号一致才可信任。
function listManagers() {
  return db.all('SELECT * FROM manager_accounts ORDER BY kind ASC, id ASC');
}

function registerManager(input = {}) {
  const kind = String(input.kind || '').trim().toLowerCase();
  if (kind !== 'qq' && kind !== 'email') throw new Error('kind 只能是 qq 或 email');
  let accountId = String(input.account_id || '').trim();
  if (!accountId) throw new Error('account_id 不能为空');
  if (kind === 'email') accountId = accountId.toLowerCase();
  if (accountId.length > 120) throw new Error('account_id 过长');
  const label = truncate(String(input.label || '').trim(), 60);
  const note = truncate(String(input.note || '').trim(), 300);
  const source = input.source === 'ai' ? 'ai' : 'platform';
  const stamp = nowIso();
  const existing = db.get('SELECT * FROM manager_accounts WHERE kind = ? AND account_id = ?', [kind, accountId]);
  if (existing) {
    db.run(
      'UPDATE manager_accounts SET label = ?, note = ?, source = ?, updated_at = ? WHERE id = ?',
      [label || existing.label, note || existing.note, source, stamp, existing.id]
    );
    return db.get('SELECT * FROM manager_accounts WHERE id = ?', [existing.id]);
  }
  const result = db.run(
    'INSERT INTO manager_accounts (kind, account_id, label, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [kind, accountId, label, note, source, stamp, stamp]
  );
  return db.get('SELECT * FROM manager_accounts WHERE id = ?', [Number(result.lastInsertRowid)]);
}

function removeManager(id) {
  const result = db.run('DELETE FROM manager_accounts WHERE id = ?', [Number(id)]);
  if (!Number(result.changes || 0)) throw new Error('未找到该登记');
  return true;
}

module.exports = {
  start,
  stop,
  tick,
  bridgePort,
  bridgeBase,
  bridgeFetch,
  segmentsToText,
  deriveInbound,
  sendText,
  sendMedia,
  fetchMedia,
  groupMembers,
  groupInfo,
  friendProfile,
  revoke,
  recentConversations,
  conversationMessages,
  pendingForAgent,
  markDelivered,
  contextFor,
  stats,
  qrcode,
  refreshQrcode,
  switchAccount,
  bindingOf,
  ensureBinding,
  listManagers,
  registerManager,
  removeManager
};
