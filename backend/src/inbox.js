const db = require('./db');
const { nowIso } = require('./util');

function add({ agentId = null, type = 'important', title, message, meta = null }) {
  const result = db.run(
    `INSERT INTO inbox (agent_id, type, title, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      type,
      String(title || '').slice(0, 200),
      String(message || ''),
      meta ? JSON.stringify(meta) : null,
      nowIso()
    ]
  );
  return Number(result.lastInsertRowid);
}

// AI 主动给管理员留言：统一标记为「信息」
function addAiMessage(agentId, content) {
  return add({
    agentId,
    type: 'ai_message',
    title: `${agentId} 的留言`,
    message: content
  });
}

// 平台重要讯息：死亡、临终、磁盘暂停、恢复等
function addImportant(agentId, title, message, meta = null) {
  return add({ agentId, type: 'important', title, message, meta });
}

function list({ limit = 200, type = null } = {}) {
  const params = [];
  let where = '';
  if (type) {
    where = 'WHERE i.type = ?';
    params.push(type);
  }
  params.push(limit);
  return db.all(
    `SELECT i.*, a.seq AS agent_seq
       FROM inbox i
       LEFT JOIN agents a ON a.id = i.agent_id
       ${where}
      ORDER BY i.id DESC
      LIMIT ?`,
    params
  );
}

function unreadCount(type = null) {
  if (type) {
    return Number(
      db.get('SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL AND type = ?', [type])?.n || 0
    );
  }
  return Number(db.get('SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL')?.n || 0);
}

function markRead(id) {
  db.run('UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL', [nowIso(), Number(id)]);
}

function markAllRead() {
  db.run('UPDATE inbox SET read_at = ? WHERE read_at IS NULL', [nowIso()]);
}

module.exports = {
  add,
  addAiMessage,
  addImportant,
  list,
  unreadCount,
  markRead,
  markAllRead
};
