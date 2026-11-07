const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const agents = require('./agents');
const plugins = require('./plugins');
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

// ---------- 拟人化：开关、分段、发送延迟队列 ----------
const DEFAULT_HUMANIZE = {
  style: true,            // B 口语化提示词（禁列表/Markdown）
  fillers: true,          // C 语气词
  selfCorrect: true,      // E 偶尔补一句/自我更正
  routine: true,          // F 作息感 + 记住称呼
  brief: true,            // G 偶发短句
  readingDelay: true,     // H1 看手机延迟
  merge: true,            // H2 连发多条合并后再回
  catchphrases: [],       // H3 口头禅库
  catchphraseChance: 0.08,
  followUp: false,        // H4 对方久不回再补一句（默认关）
  followUpMinutes: 20,
  quietNight: true,       // H6 深夜少话
  delayBaseMs: 500,
  delayPerCharMs: 50,
  delayMaxMs: 5000,
  dayMinMs: 3000,
  dayMaxMs: 20000,
  nightMinMs: 30000,
  nightMaxMs: 90000,
  nightStart: 23,
  nightEnd: 8,
  mergeQuietMs: 2500
};

function humanizeConfig(agent = {}) {
  let stored = {};
  try {
    stored = JSON.parse(agent.humanize_config || '{}') || {};
  } catch {
    stored = {};
  }
  const cfg = { ...DEFAULT_HUMANIZE, ...stored };
  cfg.catchphrases = Array.isArray(cfg.catchphrases)
    ? cfg.catchphrases.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  cfg.enabled = Boolean(Number(agent.humanize));
  return cfg;
}

// 修改拟人化配置（面板与 AI 工具共用）：只接受白名单字段，其余忽略
function setHumanize(agentId, patch = {}) {
  const agent = db.get('SELECT id, humanize, humanize_config FROM agents WHERE id = ?', [agentId]);
  if (!agent) throw new Error('AI 不存在');
  const cfg = humanizeConfig(agent);
  if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
  for (const key of ['style', 'fillers', 'selfCorrect', 'routine', 'brief', 'readingDelay', 'merge', 'followUp', 'quietNight']) {
    if (patch[key] !== undefined) cfg[key] = Boolean(patch[key]);
  }
  if (patch.catchphrases !== undefined) {
    const list = Array.isArray(patch.catchphrases)
      ? patch.catchphrases
      : String(patch.catchphrases).split(/[,，、\n]/);
    cfg.catchphrases = list.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20);
  }
  const numeric = {
    catchphraseChance: [0, 1],
    delayBaseMs: [0, 60000],
    delayPerCharMs: [0, 2000],
    delayMaxMs: [0, 120000],
    dayMinMs: [0, 300000],
    dayMaxMs: [0, 300000],
    nightMinMs: [0, 600000],
    nightMaxMs: [0, 600000],
    followUpMinutes: [1, 1440],
    nightStart: [0, 23],
    nightEnd: [0, 23],
    mergeQuietMs: [0, 60000]
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (Number.isFinite(value)) cfg[key] = Math.max(min, Math.min(max, value));
  }
  if (cfg.dayMinMs > cfg.dayMaxMs) cfg.dayMaxMs = cfg.dayMinMs;
  if (cfg.nightMinMs > cfg.nightMaxMs) cfg.nightMaxMs = cfg.nightMinMs;
  const { enabled, ...rest } = cfg;
  db.run('UPDATE agents SET humanize = ?, humanize_config = ? WHERE id = ?', [
    enabled ? 1 : 0,
    JSON.stringify(rest),
    agentId
  ]);
  return cfg;
}

function isNight(cfg, date = new Date()) {
  const hour = date.getHours();
  const start = Number(cfg.nightStart);
  const end = Number(cfg.nightEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// 只去掉段尾单个「。」；「。。」及以上（省略号写法）保留
function stripEndPeriod(line) {
  const text = String(line || '').trim();
  if (!text.endsWith('。')) return text;
  if (text.endsWith('。。')) return text;
  return text.slice(0, -1).trim();
}

// 按换行分段，不设上限；可选追加一条口头禅作为单独一段
function humanizeSegments(text, cfg = DEFAULT_HUMANIZE) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const segments = lines.map(stripEndPeriod).filter(Boolean);
  const words = Array.isArray(cfg.catchphrases) ? cfg.catchphrases : [];
  if (words.length && Math.random() < Number(cfg.catchphraseChance || 0)) {
    segments.push(words[Math.floor(Math.random() * words.length)]);
  }
  if (!segments.length) {
    const fallback = stripEndPeriod(text);
    return fallback ? [fallback] : [];
  }
  return segments;
}

function segmentDelayMs(segment, cfg) {
  const len = Array.from(String(segment || '')).length;
  const raw = Number(cfg.delayBaseMs || 0) + len * Number(cfg.delayPerCharMs || 0);
  const max = Number(cfg.delayMaxMs || 0);
  return max > 0 ? Math.min(raw, max) : raw;
}

function readingDelayMs(cfg) {
  if (!cfg.readingDelay) return 0;
  const night = isNight(cfg);
  const min = Number(night ? cfg.nightMinMs : cfg.dayMinMs) || 0;
  const max = Math.max(min, Number(night ? cfg.nightMaxMs : cfg.dayMaxMs) || 0);
  return min + Math.random() * (max - min);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// 同一 AI 的出站消息串行排队，避免多条回复交叉发送
const outboundQueues = new Map();

function enqueueOutbound(agentId, task) {
  const previous = outboundQueues.get(agentId) || Promise.resolve();
  const next = previous.then(task, task).catch((error) => {
    addEvent(agentId, 'companion_send_error', `拟人化分段发送失败：${error.message}`);
  });
  outboundQueues.set(agentId, next);
  return next;
}

async function postSegments(agent, { conversationId, kind = 'private', content, segments }) {
  const payload = {
    target: { type: kind === 'group' ? 'group' : 'private', id: String(conversationId) },
    segments
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
    segments
  });
  return result;
}

// 对方久不回再补一句：只提醒 AI 一次，内容由 AI 自己写，且有冷却与记录
function maybeFollowUp(agent) {
  const cfg = humanizeConfig(agent);
  if (!cfg.enabled || !cfg.followUp) return;
  if (cfg.quietNight && isNight(cfg)) return;
  const minutes = Math.max(1, Number(cfg.followUpMinutes) || 20);
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const rows = db.all(
    `SELECT conversation_id, MAX(id) AS last_id, MAX(created_at) AS last_at
       FROM companion_messages
      WHERE agent_id = ? AND conversation_id <> '__reminder__'
      GROUP BY conversation_id`,
    [agent.id]
  );
  for (const row of rows) {
    if (!row.last_id || String(row.last_at || '') >= since) continue;
    const last = db.get('SELECT id, direction FROM companion_messages WHERE id = ?', [row.last_id]);
    if (!last || last.direction !== 'out') continue;
    const seen = db.get(
      'SELECT id FROM companion_followups WHERE agent_id = ? AND conversation_id = ? AND covered_message_id = ?',
      [agent.id, row.conversation_id, last.id]
    );
    if (seen) continue;
    db.run(
      'INSERT OR IGNORE INTO companion_followups (agent_id, conversation_id, covered_message_id, created_at) VALUES (?, ?, ?, ?)',
      [agent.id, row.conversation_id, last.id, nowIso()]
    );
    addEvent(agent.id, 'humanize_followup', `会话 ${row.conversation_id} 已 ${minutes} 分钟没有新消息，提醒 AI 补一句。`, {
      conversation_id: row.conversation_id
    });
    notifyAgent(agent.id, `[拟人化] 会话 ${row.conversation_id} 已经 ${minutes} 分钟没有新消息了。可以主动补一句自然的话（本轮最多一次，对方还不回就不要再催）。`);
  }
}

function insertInbound(agent, message, selfUin) {
  const bridgeId = String(message.id || '');
  if (!bridgeId) return null;
  // 自身消息兜底：桥在登录早期 selfInfo 可能还没就绪，这里按发送人再比对一次，避免把自己的发言当成对方消息
  const senderUin = String(message?.sender?.uin || '');
  const selfId = String(selfUin || '');
  if (message?.self === true || (selfId && senderUin === selfId)) {
    return null;
  }
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
  const cfg = humanizeConfig(agent);
  if (!cfg.enabled) {
    return postSegments(agent, {
      conversationId,
      kind,
      content,
      segments: buildSegments({ kind, text: content, replyTo, senderUin, senderName })
    });
  }
  // 拟人化：按换行分段逐条发送，先“看手机”延迟，再按字数排队发送
  const segments = humanizeSegments(content, cfg);
  if (!segments.length) throw new Error('消息内容不能为空');
  enqueueOutbound(agent.id, async () => {
    const readDelay = readingDelayMs(cfg);
    if (readDelay > 0) await sleep(readDelay);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const delay = segmentDelayMs(segment, cfg);
      if (delay > 0) await sleep(delay);
      const segs = buildSegments({
        kind,
        text: segment,
        replyTo: index === 0 ? replyTo : null,
        senderUin: index === 0 ? senderUin : null,
        senderName
      });
      await postSegments(agent, { conversationId, kind, content: segment, segments: segs });
    }
  });
  return { queued: true, segments: segments.length };
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
    // 插件可改写/丢弃入站消息（inbound.transform）；失败时按原消息处理
    try {
      const transformed = await plugins.runHook('inbound.transform', {
        agent: { id: agent.id, seq: agent.seq, mode: agent.mode },
        message
      });
      if (transformed?.message) Object.assign(message, transformed.message);
    } catch {
      // 插件异常不影响收消息
    }
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
      maybeFollowUp(agent);
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

// 联系人昵称缓存：桥在私聊消息里拿不到昵称（sender_name 为空），用好友列表补齐
const contactSyncAt = new Map();
const CONTACT_SYNC_TTL_MS = 30 * 60 * 1000;

function contactNames(agentId, accountIds = []) {
  const ids = accountIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = db.all(
    `SELECT account_id, name FROM companion_contacts
      WHERE agent_id = ? AND account_id IN (${ids.map(() => '?').join(',')})`,
    [agentId, ...ids]
  );
  const map = new Map();
  for (const row of rows) {
    if (row.name) map.set(String(row.account_id), row.name);
  }
  return map;
}

function saveContacts(agentId, entries = []) {
  const stamp = nowIso();
  for (const entry of entries) {
    const accountId = String(entry.account_id || '').trim();
    const name = String(entry.name || '').trim();
    if (!accountId || !name) continue;
    db.run(
      `INSERT INTO companion_contacts (agent_id, account_id, name, source, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, account_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      [agentId, accountId, truncate(name, 200), entry.source || 'friend', stamp]
    );
  }
}

// 从桥的好友列表拉一次昵称并缓存；30 分钟节流，失败静默（不影响收消息）
async function syncContacts(agent) {
  const agentId = agent.id;
  const last = Number(contactSyncAt.get(agentId) || 0);
  if (Date.now() - last < CONTACT_SYNC_TTL_MS) return false;
  contactSyncAt.set(agentId, Date.now());
  try {
    const data = await bridgeFetch(agent, '/v1/friends', { timeoutMs: 30000 });
    const friends = Array.isArray(data?.friends) ? data.friends : [];
    const entries = [];
    for (const friend of friends) {
      const name = String(friend.name || friend.remark || '').trim();
      if (!name) continue;
      if (friend.uin) entries.push({ account_id: String(friend.uin), name, source: 'friend' });
      if (friend.uid) entries.push({ account_id: String(friend.uid), name, source: 'friend' });
    }
    saveContacts(agentId, entries);
    return entries.length > 0;
  } catch {
    // 桥未就绪或好友列表不可用时跳过，下次再补
    return false;
  }
}

// 给 inbox / 历史上下文补发送人昵称；sender_name 已有值时不动
async function enrichSenders(agent, rows = []) {
  const missing = [];
  for (const row of rows) {
    if (String(row.direction || 'in') !== 'in') continue;
    if (String(row.sender_name || '').trim()) continue;
    if (row.sender_uin) missing.push(String(row.sender_uin));
  }
  if (!missing.length) return rows;
  let names = contactNames(agent.id, missing);
  if (!names.size) {
    await syncContacts(agent);
    names = contactNames(agent.id, missing);
  }
  for (const row of rows) {
    if (String(row.direction || 'in') !== 'in') continue;
    const key = String(row.sender_uin || '');
    if (!String(row.sender_name || '').trim() && names.has(key)) {
      row.sender_name = names.get(key);
    }
  }
  return rows;
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

// 同一条消息在 5 秒内不会被重复返回，避免容器忙轮询时把同一批消息来回抛
const FETCH_COOLDOWN_MS = 5000;
// 最多重投 3 次：回合失败不 ack 时靠重投兜底，超过上限就停手，避免死循环刷模型
const MAX_FETCH_TIMES = 3;

function pendingForAgent(agentId, limit = 10) {
  const rows = db.all(
    `SELECT * FROM companion_messages
      WHERE agent_id = ? AND direction = 'in' AND needs_reply = 1 AND delivered_at IS NULL
        AND COALESCE(fetch_count, 0) < ${MAX_FETCH_TIMES}
      ORDER BY id ASC LIMIT ?`,
    [agentId, limit]
  );
  const now = Date.now();
  const ready = rows.filter((row) => {
    const fetchedAt = row.last_fetched_at ? Date.parse(row.last_fetched_at) : 0;
    return !fetchedAt || now - fetchedAt >= FETCH_COOLDOWN_MS;
  });
  const agent = db.get('SELECT id, humanize, humanize_config FROM agents WHERE id = ?', [agentId]);
  const cfg = humanizeConfig(agent || {});
  // H2：对方连发多条时先攒一会儿再交给 AI，像真人读完再回
  if (cfg.enabled && cfg.merge) {
    const quiet = Math.max(0, Number(cfg.mergeQuietMs) || 0);
    if (quiet > 0) {
      const cutoff = Date.now() - quiet;
      return ready.filter((row) => {
        const at = Date.parse(row.created_at);
        return Number.isNaN(at) || at <= cutoff;
      });
    }
  }
  return ready;
}

// 拉取只记次数与时间，不算送达；容器回合结束后由 /companion/ack 显式确认
function markFetched(ids = []) {
  const stamp = nowIso();
  for (const id of ids) {
    db.run(
      `UPDATE companion_messages
          SET fetch_count = COALESCE(fetch_count, 0) + 1, last_fetched_at = ?
        WHERE id = ? AND delivered_at IS NULL`,
      [stamp, id]
    );
  }
}

// 只允许 AI 确认自己的消息，避免跨 AI 误标送达
function ackMessages(agentId, ids = []) {
  const stamp = nowIso();
  let acked = 0;
  for (const id of ids) {
    const result = db.run(
      'UPDATE companion_messages SET delivered_at = ? WHERE agent_id = ? AND id = ? AND delivered_at IS NULL',
      [stamp, agentId, id]
    );
    acked += Number(result?.changes || 0);
  }
  return acked;
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
  markFetched,
  ackMessages,
  enrichSenders,
  saveContacts,
  contactNames,
  syncContacts,
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
  humanizeConfig,
  setHumanize,
  humanizeSegments,
  listKeywords,
  addKeyword,
  removeKeyword,
  insertInbound
};
