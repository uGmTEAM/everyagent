const { EventEmitter } = require('events');
const db = require('./db');
const { nowIso } = require('./util');

const bus = new EventEmitter();
bus.setMaxListeners(2000);

function addEvent(agentId, type, message, meta = null) {
  const createdAt = nowIso();
  let result;
  try {
    result = db.run(
      'INSERT INTO events (agent_id, type, message, meta_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [agentId || null, type, message, meta ? JSON.stringify(meta) : null, createdAt]
    );
  } catch (error) {
    console.error('[event] 写入失败', error.message);
    return null;
  }
  const event = {
    id: Number(result.lastInsertRowid),
    agent_id: agentId || null,
    type,
    message,
    meta,
    created_at: createdAt
  };
  bus.emit('app-event', event);
  return event;
}

function emitLog(agentId, stream, line) {
  const event = {
    agent_id: agentId,
    stream: stream || 'stdout',
    line,
    at: nowIso()
  };
  bus.emit('agent-log', event);
}

function emitServerLog(event) {
  bus.emit('server-log', event);
}

function notifyAgent(agentId, message) {
  db.run('UPDATE agents SET notice = ?, notice_at = ? WHERE id = ?', [message, nowIso(), agentId]);
  bus.emit('agent-notice', { agent_id: agentId, message });
}

function takeNotice(agentId) {
  const row = db.get('SELECT notice FROM agents WHERE id = ?', [agentId]);
  if (!row || !row.notice) return null;
  db.run('UPDATE agents SET notice = NULL, notice_at = NULL WHERE id = ?', [agentId]);
  return row.notice;
}

function addAdminMessage(agentId, content, compensation = 0) {
  const createdAt = nowIso();
  const amount = Math.max(0, Number(compensation) || 0);
  const result = db.run(
    'INSERT INTO admin_messages (agent_id, content, compensation, created_at) VALUES (?, ?, ?, ?)',
    [agentId, content, amount, createdAt]
  );
  return {
    id: Number(result.lastInsertRowid),
    agent_id: agentId,
    content,
    compensation: amount,
    created_at: createdAt,
    delivered_at: null
  };
}

function takeAdminMessages(agentId, limit = 10) {
  const rows = db.all(
    `SELECT id, content, compensation, created_at
       FROM admin_messages
      WHERE agent_id = ? AND delivered_at IS NULL
      ORDER BY id ASC
      LIMIT ?`,
    [agentId, limit]
  );
  if (!rows.length) return [];
  const deliveredAt = nowIso();
  for (const row of rows) {
    db.run('UPDATE admin_messages SET delivered_at = ? WHERE id = ?', [deliveredAt, row.id]);
  }
  return rows;
}

function listAdminMessages(agentId, limit = 20) {
  return db.all(
    'SELECT * FROM admin_messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?',
    [agentId, limit]
  );
}

function on(eventName, handler) {
  bus.on(eventName, handler);
  return () => bus.off(eventName, handler);
}

module.exports = {
  bus,
  addEvent,
  emitLog,
  emitServerLog,
  notifyAgent,
  takeNotice,
  addAdminMessage,
  takeAdminMessages,
  listAdminMessages,
  on
};
