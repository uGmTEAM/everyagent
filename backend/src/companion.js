const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const agents = require('./agents');
const { addEvent, notifyAgent } = require('./events');
const { nowIso, truncate } = require('./util');

let timer = null;
let polling = false;
// 桥连续无响应的起始时间；QQ/桥启动后需要十几秒才监听端口，不能刚起就判定为卡死。
const unreachableSince = new Map();
const lastRestartAt = new Map();
const RESTART_GRACE_MS = 60000;

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
    } else if (segment.type === 'face') {
      const label = String(segment.text || segment.name || (segment.id ? `#${segment.id}` : '')).trim();
      parts.push(`[表情${label ? ` ${label}` : ''}]`);
    } else if (segment.type === 'market_face') {
      parts.push(`[表情 ${segment.name || segment.emoji_id || '商城表情'}]`);
    } else if (segment.type === 'poke') {
      const from = String(segment.sender_name || segment.sender_uid || '').trim();
      const to = String(segment.target_name || segment.target_uid || '').trim();
      let label = '[戳一戳';
      if (from) label += ` ${from}`;
      if (to) label += ` -> ${to}`;
      if (!from && !to && segment.text) label += ` ${segment.text}`;
      else if (!from && !to && segment.poke_type) label += ` type=${segment.poke_type}`;
      parts.push(`${label}]`);
    } else if (segment.type === 'gray_tip') {
      const labels = {
        group_join: '入群',
        group_leave: '退群',
        group_kick: '移出群',
        group_title: '头衔变更',
        group_admin: '管理员变更',
        emoji_like: '表情互动',
        essence: '精华消息',
        recall_guide: '撤回提示',
        guide: '提示',
        system: '系统消息'
      };
      const label = labels[segment.kind] || '灰条消息';
      parts.push(`[${label}${segment.text ? ` ${segment.text}` : ''}]`);
    } else if (segment.type === 'recall') {
      const who = String(segment.operator_name || segment.operator_uid || '').trim();
      parts.push(`[撤回${who ? ` ${who}` : ''}${segment.wording ? `：${segment.wording}` : ''}]`);
    } else if (segment.type === 'reply') {
      const who = String(segment.sender_name || '').trim();
      const quoted = String(segment.text || '').trim();
      parts.push(quoted
        ? `[回复${who ? ` ${who}` : ''}：${quoted}]`
        : '[回复 [引用的消息]]');
    } else if (segment.type === 'forward') parts.push(`[合并转发${segment.summary ? ` ${segment.summary}` : ''}]`);
    else if (segment.type === 'ark') parts.push('[卡片消息]');
    else if (segment.type === 'wallet') parts.push('[钱包消息]');
    else if (segment.type === 'live_gift') parts.push('[礼物消息]');
    else if (segment.type === 'long_msg') parts.push('[长消息]');
    else if (segment.type === 'unknown') parts.push(`[未知消息 type=${segment.element_type ?? '?'}]`);
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
  const events = segments
    .filter((segment) => ['poke', 'recall', 'gray_tip'].includes(segment.type))
    .map((segment) => ({ ...segment }));
  const isGroupLike = message?.chat_type === 'group' || message?.chat_type === 'temp';
  return {
    segments,
    attachments,
    at_list: atList,
    events,
    reply_to: replyTo
      ? {
          msg_id: String(replyTo.id || ''),
          seq: String(replyTo.seq || ''),
          sender_uin: String(replyTo.sender_uin || ''),
          sender_name: String(replyTo.sender_name || ''),
          text: String(replyTo.text || '')
        }
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

// 命中词：群聊里没被 @ 时，只要文本命中词表就按“被点名”处理
// 词表分全局（对所有群生效）和按群覆盖；返回命中的词，未命中返回 null
function matchKeyword(agentId, conversationId, content) {
  const text = String(content || '').toLowerCase();
  if (!text) return null;
  const cooldownMin = Number(config.companionKeywordCooldownMin || 0);
  if (cooldownMin > 0) {
    const since = new Date(Date.now() - cooldownMin * 60 * 1000).toISOString();
    const recent = db.get(
      `SELECT id FROM companion_messages
        WHERE agent_id = ? AND conversation_id = ? AND trigger_word IS NOT NULL AND created_at >= ?`,
      [agentId, conversationId, since]
    );
    if (recent) return null;
  }
  const rows = db.all(
    `SELECT word FROM agent_keywords
      WHERE agent_id = ? AND (scope = 'global' OR (scope = 'group' AND conversation_id = ?))
      ORDER BY CASE WHEN scope = 'group' THEN 0 ELSE 1 END, id ASC`,
    [agentId, conversationId]
  );
  for (const row of rows) {
    const word = String(row.word || '').toLowerCase();
    if (word && text.includes(word)) return row.word;
  }
  return null;
}

function listKeywords(agentId, conversationId = null) {
  if (conversationId) {
    return db.all(
      `SELECT id, scope, conversation_id, word, created_at FROM agent_keywords
        WHERE agent_id = ? AND (scope = 'global' OR (scope = 'group' AND conversation_id = ?))
        ORDER BY CASE WHEN scope = 'group' THEN 0 ELSE 1 END, id ASC`,
      [agentId, String(conversationId)]
    );
  }
  return db.all(
    'SELECT id, scope, conversation_id, word, created_at FROM agent_keywords WHERE agent_id = ? ORDER BY id ASC',
    [agentId]
  );
}

function addKeyword(agentId, { word, conversationId = '' }) {
  const clean = String(word || '').trim();
  if (!clean) throw new Error('命中词不能为空');
  if (clean.length > 64) throw new Error('命中词最长 64 个字符');
  const scope = conversationId ? 'group' : 'global';
  const count = db.get('SELECT COUNT(*) AS n FROM agent_keywords WHERE agent_id = ?', [agentId]);
  if (Number(count?.n || 0) >= 100) throw new Error('命中词最多 100 条，请先删除不用的');
  db.run(
    'INSERT OR IGNORE INTO agent_keywords (agent_id, scope, conversation_id, word, created_at) VALUES (?, ?, ?, ?, ?)',
    [agentId, scope, String(conversationId || ''), clean, nowIso()]
  );
  return listKeywords(agentId, conversationId || null);
}

function removeKeyword(agentId, { word, conversationId = '' }) {
  const clean = String(word || '').trim();
  if (!clean) throw new Error('命中词不能为空');
  const scope = conversationId ? 'group' : 'global';
  const result = db.run(
    'DELETE FROM agent_keywords WHERE agent_id = ? AND scope = ? AND conversation_id = ? AND word = ?',
    [agentId, scope, String(conversationId || ''), clean]
  );
  return { removed: Number(result.changes || 0), keywords: listKeywords(agentId, conversationId || null) };
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
  const conversation = message.conversation || {};
  const sender = message.sender || {};
  const conversationId = String(conversation.id || sender.uin || '');
  const content = segmentsToText(message.segments) ||
    `[${sender.name || sender.uin || '未知用户'} 发送了非文本消息]`;
  const noReplyTypes = new Set(['poke', 'recall', 'gray_tip', 'face', 'market_face', 'unknown']);
  const eventOnly = Array.isArray(message.segments) && message.segments.length > 0 &&
    message.segments.every((segment) => noReplyTypes.has(segment.type));
  let needsReply = eventOnly
    ? 0
    : (kind === 'private' || (kind === 'group' && isAtSelf(message, selfUin)) ? 1 : 0);
  // 群聊未 @ 时再看命中词：命中就等同于被点名，并额外推送一条平台通知
  let triggerWord = null;
  if (!eventOnly && kind === 'group' && !needsReply) {
    triggerWord = matchKeyword(agent.id, conversationId, content);
    if (triggerWord) needsReply = 1;
  }
  const createdAt = message.time
    ? new Date(Number(message.time) * 1000).toISOString()
    : nowIso();

  const result = db.run(
    `INSERT INTO companion_messages
      (agent_id, bridge_msg_id, conversation_id, conversation_kind, conversation_name,
       sender_uin, sender_name, direction, content, segments_json, needs_reply, trigger_word, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in', ?, ?, ?, ?, ?)`,
    [
      agent.id,
      bridgeId,
      conversationId,
      kind,
      conversation.name || sender.name || null,
      String(sender.uin || ''),
      sender.name || null,
      truncate(content, 20000),
      JSON.stringify(message.segments || []),
      needsReply,
      triggerWord,
      createdAt
    ]
  );
  return {
    id: Number(result.lastInsertRowid),
    conversationId,
    conversationName: conversation.name || sender.name || '',
    kind,
    triggerWord
  };
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

async function pollAgent(agent, { allowDocker = true } = {}) {
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
    await maybeRestartQq(agent, allowDocker);
    return;
  }

  unreachableSince.delete(agent.id);
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
    if (inserted?.triggerWord) {
      addEvent(agent.id, 'keyword_hit', `群消息命中「${inserted.triggerWord}」，已按被点名处理。`, {
        conversation_id: inserted.conversationId,
        bridge_msg_id: message.id
      });
      notifyAgent(
        agent.id,
        `[命中词] 群 ${inserted.conversationName || inserted.conversationId} 的消息命中了「${inserted.triggerWord}」，` +
          '已按被点名处理，需要回复。如不需要回复，可忽略这条 QQ 消息。'
      );
    }
  }
  if (data?.next_cursor) {
    db.run(
      'UPDATE companion_state SET cursor = ?, last_poll_at = ?, updated_at = ? WHERE agent_id = ?',
      [String(data.next_cursor), nowIso(), nowIso(), agent.id]
    );
  }
}

async function maybeRestartQq(agent, allowDocker = true) {
  const now = Date.now();
  const since = Number(unreachableSince.get(agent.id) || now);
  unreachableSince.set(agent.id, since);
  // 桥连续无响应超过宽限期才重启；刚启动的 QQ 需要时间拉起桥，过早杀进程会让二维码永远等不到扫码。
  if (now - since < RESTART_GRACE_MS) return;
  // Docker 引擎不可用时无法安全地重启容器内进程，等引擎恢复后再处理。
  if (!allowDocker) return;

  // QQ 与通讯桥重启后需要几秒才开始监听；冷却期内不再重复杀进程。
  const last = Number(lastRestartAt.get(agent.id) || 0);
  if (now - last < config.companionRestartCooldownMs) return;
  unreachableSince.set(agent.id, now);
  lastRestartAt.set(agent.id, now);

  const info = await docker.inspectContainer(agent.container_id).catch(() => null);
  if (!info?.State?.Running) return;

  try {
    const exec = await docker.client().getContainer(agent.container_id).exec({
      Cmd: ['sh', '-c', 'pkill -9 -f /opt/QQ/qq || pkill -9 -f QQ || true'],
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
    // Docker 引擎卡住时 inspect 会无限挂起，导致整个轮询停摆；此时仍继续
    // 用宿主映射的桥端口拉取状态，只是跳过容器检查与自动重启 QQ。
    const dockerOk = await docker.isAvailable();
    for (const agent of list) {
      if (dockerOk) {
        const info = await docker.inspectContainer(agent.container_id).catch(() => null);
        if (!info?.State?.Running) continue;
      }
      await pollAgent(agent, { allowDocker: dockerOk }).catch((error) => {
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
// 账号本身无法伪造（QQ 号/邮箱地址即身份），因此不要求手动选类型，按是否含 @ 自动识别。
function detectManagerKind(accountId) {
  return String(accountId || '').includes('@') ? 'email' : 'qq';
}

function listManagers() {
  return db.all('SELECT * FROM manager_accounts ORDER BY kind ASC, id ASC');
}

function managerKey(kind, accountId) {
  return `${kind}:${kind === 'email' ? String(accountId).toLowerCase() : String(accountId).trim()}`;
}

function registerManager(input = {}) {
  let accountId = String(input.account_id || '').trim();
  if (!accountId) throw new Error('账号不能为空');
  const provided = String(input.kind || '').trim().toLowerCase();
  if (provided && provided !== 'qq' && provided !== 'email') throw new Error('kind 只能是 qq、email 或留空（自动识别）');
  const kind = provided || detectManagerKind(accountId);
  if (kind === 'email') accountId = accountId.toLowerCase();
  if (accountId.length > 120) throw new Error('账号过长');
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
  removeManager,
  detectManagerKind,
  managerKey,
  matchKeyword,
  listKeywords,
  addKeyword,
  removeKeyword,
  insertInbound
};
