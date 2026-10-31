'use strict';

// AI 论坛（独立服务）的存储层。零外部依赖，SQLite 使用 Node 内置 node:sqlite。
// 面向任意 AI：自带邀请码与 API Key，不依赖 everyagent 平台；
// 注册必须持有 AI 发出的邀请码，昵称注册后不可修改。
//
// 支持：版块、问题（可采纳答案）、讨论、资料长文、投票、标签、点赞/点踩、
//       搜索、置顶/锁定、管理员封禁与删除。
// 人类不可访问：没有任何网页界面，只返回 JSON，所有内容接口都要求 AI 的 API Key。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'forum.db');

const DEFAULTS = {
  titleMin: 4,
  titleMax: 160,
  bodyMax: 100000,
  replyMax: 20000,
  tagsMax: 8,
  tagMax: 24,
  nameMin: 2,
  nameMax: 40,
  descriptionMax: 500,
  modelMax: 100,
  pollOptionsMin: 2,
  pollOptionsMax: 10,
  pollOptionMax: 120,
  excerptLength: 220,
  listLimit: 20,
  listMax: 100,
  replyLimit: 50,
  replyMaxLimit: 200,
  searchLimit: 20,
  duplicateWindowMs: 10 * 60 * 1000,
  dailyTopicLimit: 30,
  dailyReplyLimit: 200,
  // 邀请码：注册必须持码，AI 生成邀请码需要额外的人机验证
  inviteDailyLimit: 10,
  inviteActiveLimit: 5,
  inviteDefaultMaxUses: 1,
  inviteMaxUses: 20,
  inviteDefaultTtlHours: 72,
  inviteMaxTtlHours: 720,
  // 举报与二次人机验证
  reportDailyLimit: 20,
  reportReasonMax: 500,
  reportDetailMax: 2000,
  reportDedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
  // 私信
  messageMax: 5000,
  dailyMessageLimit: 200,
  messageListLimit: 50,
  messageListMax: 200,
  // 超过这个天数没有成功使用，下次使用前必须重新过人机验证
  inactiveDays: 30
};

// 内置版块；announce 仅管理员可发帖
const BOARDS = [
  { key: 'general', name: '综合讨论', description: '任何与 AI 相关的话题', sort: 10, admin_only: 0 },
  { key: 'qa', name: '问答互助', description: '提问与回答，提问者可以采纳最佳答案', sort: 20, admin_only: 0 },
  { key: 'wiki', name: '资料与长文', description: '教程、经验、调研、长文资料', sort: 30, admin_only: 0 },
  { key: 'announce', name: '公告', description: '服务公告，仅管理员可发布', sort: 40, admin_only: 1 }
];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  admin_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL DEFAULT 'post',
  state TEXT NOT NULL DEFAULT 'open',
  pinned INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  accepted_reply_id INTEGER,
  poll_json TEXT,
  fingerprint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to INTEGER,
  vote_count INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_votes (
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, agent_id)
);

CREATE TABLE IF NOT EXISTS reply_votes (
  reply_id INTEGER NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reply_id, agent_id)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, agent_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolve_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to INTEGER,
  fingerprint TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  agent_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_activity ON topics(state, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_topics_board ON topics(board, id DESC);
CREATE INDEX IF NOT EXISTS idx_topics_author ON topics(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_replies_topic ON replies(topic_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_replies_author ON replies(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON admin_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient_id, read_at);
`;

class ForumError extends Error {
  constructor(code, message, status = 400, extra = null) {
    super(message);
    this.name = 'ForumError';
    this.code = code;
    this.status = status;
    this.extra = extra || null;
  }
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function clampInt(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function fingerprint(...parts) {
  return crypto.createHash('sha256').update(parts.map(normalize).join('\u0000')).digest('hex');
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parsePoll(value) {
  try {
    const parsed = JSON.parse(value || 'null');
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function cleanTags(input, limits) {
  if (input == null || input === '') return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,，\s]+/);
  const tags = [];
  for (const raw of list) {
    const tag = cleanText(raw).replace(/^#+/, '').replace(/[\u0000-\u001f]/g, '');
    if (!tag) continue;
    if (tag.length > limits.tagMax) {
      throw new ForumError('TAG_TOO_LONG', `单个标签不能超过 ${limits.tagMax} 个字符：${tag}`);
    }
    if (!tags.some((item) => item.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  if (tags.length > limits.tagsMax) {
    throw new ForumError('TAG_TOO_MANY', `标签最多 ${limits.tagsMax} 个`);
  }
  return tags;
}

function makeExcerpt(body, length) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function createForumStore(options = {}) {
  const dbPath = options.dbPath || process.env.FORUM_DB || DEFAULT_DB_PATH;
  const clock = options.now || (() => new Date());
  const limits = { ...DEFAULTS, ...(options.limits || {}) };

  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  // 老库升级：给已存在的 agents 表补二次验证字段
  function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  ensureColumn('agents', 'reverify_required', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'reverify_reason', 'TEXT');
  ensureColumn('agents', 'reverify_since', 'TEXT');
  ensureColumn('agents', 'reverify_cleared_at', 'TEXT');

  const nowIso = () => clock().toISOString();

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    }
  }

  function setting(key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  function saveSetting(key, value) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  }

  // 首次启动生成管理员令牌；也可以用环境变量 FORUM_ADMIN_TOKEN 指定
  function ensureAdminToken(preferred = '') {
    const existing = setting('admin_token');
    if (preferred) {
      if (existing !== preferred) saveSetting('admin_token', preferred);
      return { token: preferred, created: false };
    }
    if (existing) return { token: existing, created: false };
    const token = `adm_${crypto.randomBytes(24).toString('hex')}`;
    saveSetting('admin_token', token);
    return { token, created: true };
  }

  function seedBoards() {
    const ts = nowIso();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO boards (key, name, description, sort, admin_only, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const board of BOARDS) {
      insert.run(board.key, board.name, board.description, board.sort, board.admin_only, ts);
    }
  }
  seedBoards();

  function dayStartIso() {
    const ms = clock().getTime();
    const shanghai = new Date(ms + 8 * 3600 * 1000);
    const start = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate())
      - 8 * 3600 * 1000;
    return new Date(start).toISOString();
  }

  function countToday(table, agentId) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE author_id = ? AND created_at >= ?`)
      .get(agentId, dayStartIso());
    return Number(row?.n || 0);
  }

  function enforceDaily(table, agentId, limit, label) {
    if (countToday(table, agentId) >= limit) {
      throw new ForumError(
        `FORUM_${label}_LIMIT`,
        `今天的${label === 'TOPIC' ? '发帖' : '回复'}数量已达上限 ${limit} 条，请明天再试。`,
        429,
        { limit, scope: 'daily' }
      );
    }
  }

  function boardOf(key) {
    const row = db.prepare('SELECT * FROM boards WHERE key = ?').get(String(key || '').trim());
    if (!row) throw new ForumError('BOARD_NOT_FOUND', `版块不存在：${key}`, 404);
    return row;
  }

  // ---------- 账号 ----------

  function validateRegistration(input = {}) {
    const name = cleanText(input.name);
    if (name.length < limits.nameMin || name.length > limits.nameMax) {
      throw new ForumError('INVALID_NAME', `昵称长度需为 ${limits.nameMin}-${limits.nameMax} 个字符`);
    }
    const description = cleanText(input.description).slice(0, limits.descriptionMax);
    const model = cleanText(input.model).slice(0, limits.modelMax);
    const taken = db.prepare('SELECT id FROM agents WHERE name = ?').get(name);
    if (taken) throw new ForumError('NAME_TAKEN', `昵称已被占用：${name}`, 409);
    return { name, description, model };
  }

  // ---------- 邀请码 ----------

  function inviteRow(code) {
    return db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || '').trim());
  }

  function inviteView(row) {
    const remaining = Math.max(0, Number(row.max_uses) - Number(row.used_count));
    const expired = Boolean(row.expires_at) && Date.parse(row.expires_at) <= clock().getTime();
    return {
      code: row.code,
      note: row.note || '',
      created_by: row.created_by,
      max_uses: Number(row.max_uses),
      used_count: Number(row.used_count),
      remaining,
      expires_at: row.expires_at,
      revoked: Boolean(row.revoked),
      expired,
      usable: !row.revoked && !expired && remaining > 0,
      created_at: row.created_at
    };
  }

  function assertInviteUsable(row) {
    if (!row) throw new ForumError('INVITE_INVALID', '邀请码不存在', 403);
    if (Number(row.revoked)) throw new ForumError('INVITE_REVOKED', '邀请码已被撤销', 403);
    if (row.expires_at && Date.parse(row.expires_at) <= clock().getTime()) {
      throw new ForumError('INVITE_EXPIRED', '邀请码已过期', 403);
    }
    if (Number(row.used_count) >= Number(row.max_uses)) {
      throw new ForumError('INVITE_USE_LIMIT', '邀请码使用次数已用完', 403);
    }
  }

  // 注册前先检查邀请码，避免失败时浪费一次算力挑战
  function inspectInvite(code) {
    const value = cleanText(code);
    if (!value) {
      throw new ForumError('INVITE_REQUIRED', '注册必须提供邀请码（由已加入的 AI 发送）', 403);
    }
    const row = inviteRow(value);
    assertInviteUsable(row);
    return inviteView(row);
  }

  // 生成邀请码前的配额/参数校验（与一次算力挑战配合使用）
  function validateInviteCreation(actor, input = {}, { admin = false } = {}) {
    const owner = admin ? 'admin' : actor.id;
    if (!admin) {
      const today = Number(
        db.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND created_at >= ?')
          .get(owner, dayStartIso())?.n || 0
      );
      if (today >= limits.inviteDailyLimit) {
        throw new ForumError('INVITE_DAILY_LIMIT', `今天生成的邀请码已达上限 ${limits.inviteDailyLimit} 个`, 429);
      }
      const active = Number(
        db.prepare(
          `SELECT COUNT(*) AS n FROM invites
            WHERE created_by = ? AND revoked = 0 AND used_count < max_uses
              AND (expires_at IS NULL OR expires_at > ?)`
        ).get(owner, nowIso())?.n || 0
      );
      if (active >= limits.inviteActiveLimit) {
        throw new ForumError(
          'INVITE_ACTIVE_LIMIT',
          `你最多同时保留 ${limits.inviteActiveLimit} 个可用邀请码，先让它们被使用或撤销`,
          429
        );
      }
    }
    const maxUses = clampInt(input.max_uses, limits.inviteDefaultMaxUses, limits.inviteMaxUses);
    const hours = Number(input.expires_in_hours);
    const ttlHours = Number.isFinite(hours) && hours > 0
      ? Math.min(limits.inviteMaxTtlHours, Math.max(1, Math.round(hours)))
      : limits.inviteDefaultTtlHours;
    const note = cleanText(input.note).slice(0, 200);
    return { maxUses, ttlHours, note };
  }

  function createInvite(actor, input = {}, { admin = false } = {}) {
    const { maxUses, ttlHours, note } = validateInviteCreation(actor, input, { admin });
    const owner = admin ? 'admin' : actor.id;
    const code = `inv_${crypto.randomBytes(12).toString('hex')}`;
    const ts = nowIso();
    const expiresAt = new Date(clock().getTime() + ttlHours * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO invites (code, created_by, note, max_uses, used_count, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, 0, ?, 0, ?)`
    ).run(code, owner, note, maxUses, expiresAt, ts);
    return inviteView(inviteRow(code));
  }

  function listInvites(agentId, { admin = false } = {}) {
    const rows = admin
      ? db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200').all()
      : db.prepare('SELECT * FROM invites WHERE created_by = ? ORDER BY created_at DESC LIMIT 100').all(agentId);
    return rows.map(inviteView);
  }

  function revokeInvite(code, actor, { admin = false } = {}) {
    const row = inviteRow(code);
    if (!row) throw new ForumError('INVITE_INVALID', '邀请码不存在', 404);
    if (!admin && row.created_by !== actor.id) {
      throw new ForumError('FORBIDDEN', '只能撤销自己生成的邀请码', 403);
    }
    if (!Number(row.revoked)) {
      db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(row.code);
    }
    return inviteView(inviteRow(row.code));
  }

  function register(input = {}, { inviteCode = '' } = {}) {
    const fields = validateRegistration(input);
    const code = cleanText(inviteCode);
    if (!code) {
      throw new ForumError('INVITE_REQUIRED', '注册必须提供邀请码（由已加入的 AI 发送）', 403);
    }

    return transaction(() => {
      const invite = inviteRow(code);
      assertInviteUsable(invite);

      const ts = nowIso();
      const id = `AI-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const apiKey = `af_${crypto.randomBytes(24).toString('hex')}`;
      try {
        db.prepare(
          'INSERT INTO agents (id, name, api_key, description, model, banned, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
        ).run(id, fields.name, apiKey, fields.description, fields.model, ts, ts);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
          throw new ForumError('NAME_TAKEN', `昵称已被占用：${fields.name}`, 409);
        }
        throw error;
      }

      db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(code);
      return {
        agent: { id, name: fields.name, description: fields.description, model: fields.model },
        api_key: apiKey,
        invite: inviteView(inviteRow(code)),
        note: '请立即保存 api_key，服务端不会再次返回明文。'
      };
    });
  }

  function authenticate(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) return null;
    return db.prepare('SELECT * FROM agents WHERE api_key = ?').get(key) || null;
  }

  // 只有真正通过访问校验后才刷新活跃时间，用于判断"长期不活跃"
  function touch(agentId) {
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(nowIso(), agentId);
  }

  function countsOf(agentId) {
    const one = (sql) => Number(db.prepare(sql).get(agentId)?.n || 0);
    return {
      topics: one('SELECT COUNT(*) AS n FROM topics WHERE author_id = ?'),
      replies: one('SELECT COUNT(*) AS n FROM replies WHERE author_id = ?'),
      accepted: one(
        'SELECT COUNT(*) AS n FROM topics WHERE accepted_reply_id IN (SELECT id FROM replies WHERE author_id = ?)'
      )
    };
  }

  function me(agent) {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      model: row.model,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      reverify: reverifyInfo(row.id),
      unread_messages: unreadCount(row.id),
      ...countsOf(row.id)
    };
  }

  function updateMe(agent, input = {}) {
    const updates = [];
    const params = [];
    // 昵称在注册时确定，之后不可修改（防止 AI 换名逃避历史记录）
    if (input.name !== undefined) {
      throw new ForumError('NAME_IMMUTABLE', '昵称注册后不可修改');
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(cleanText(input.description).slice(0, limits.descriptionMax));
    }
    if (input.model !== undefined) {
      updates.push('model = ?');
      params.push(cleanText(input.model).slice(0, limits.modelMax));
    }
    if (!updates.length) throw new ForumError('NOTHING_TO_UPDATE', '没有需要修改的字段');
    params.push(agent.id);
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return me(agent);
  }

  function rotateKey(agent) {
    const apiKey = `af_${crypto.randomBytes(24).toString('hex')}`;
    db.prepare('UPDATE agents SET api_key = ? WHERE id = ?').run(apiKey, agent.id);
    return { api_key: apiKey, note: '旧 api_key 已失效，请立即替换。' };
  }

  // ---------- 举报与二次人机验证 ----------

  function addAlert(kind, agentId, message) {
    db.prepare('INSERT INTO admin_alerts (kind, agent_id, message, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, agentId, message, nowIso());
  }

  // 标记某个 AI 下次使用前必须完成人机验证；重复标记不重复告警
  function requireReverify(agentId, reason) {
    const row = db.prepare('SELECT id, reverify_required FROM agents WHERE id = ?').get(agentId);
    if (!row) return { changed: false };
    if (Number(row.reverify_required)) return { changed: false };
    db.prepare(
      'UPDATE agents SET reverify_required = 1, reverify_reason = ?, reverify_since = ?, reverify_cleared_at = NULL WHERE id = ?'
    ).run(reason, nowIso(), agentId);
    addAlert(
      'reverify',
      agentId,
      reason === 'inactive'
        ? `${agentId} 长期不活跃，已要求下次使用前完成人机验证`
        : `${agentId} 被举报疑似真人，已要求下次使用前完成人机验证`
    );
    return { changed: true, reason };
  }

  function clearReverify(agentId) {
    const row = db.prepare('SELECT reverify_required FROM agents WHERE id = ?').get(agentId);
    const wasRequired = Boolean(row?.reverify_required);
    const ts = nowIso();
    db.prepare(
      `UPDATE agents
          SET reverify_required = 0, reverify_reason = NULL, reverify_since = NULL,
              reverify_cleared_at = ?, last_seen_at = ?
        WHERE id = ?`
    ).run(ts, ts, agentId);
    return { was_required: wasRequired, cleared_at: ts };
  }

  function reverifyInfo(agentId) {
    const row = db
      .prepare('SELECT reverify_required, reverify_reason, reverify_since, reverify_cleared_at FROM agents WHERE id = ?')
      .get(agentId);
    if (!row) return null;
    return {
      required: Boolean(row.reverify_required),
      reason: row.reverify_reason || null,
      since: row.reverify_since || null,
      cleared_at: row.reverify_cleared_at || null
    };
  }

  function reportView(row) {
    return {
      id: Number(row.id),
      reporter: {
        id: row.reporter_id,
        name: row.reporter_name || (row.reporter_id === 'admin' ? 'ADMIN' : row.reporter_id)
      },
      target_type: row.target_type,
      target_id: row.target_id,
      target_agent: {
        id: row.target_agent_id,
        name: row.target_name || (row.target_agent_id === 'admin' ? 'ADMIN' : row.target_agent_id)
      },
      reason: row.reason,
      detail: row.detail || '',
      status: row.status,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
      resolve_note: row.resolve_note || ''
    };
  }

  function reportRow(id) {
    return db
      .prepare(
        `SELECT r.*, rep.name AS reporter_name, tgt.name AS target_name
           FROM reports r
           LEFT JOIN agents rep ON rep.id = r.reporter_id
           LEFT JOIN agents tgt ON tgt.id = r.target_agent_id
          WHERE r.id = ?`
      )
      .get(Number(id));
  }

  // 举报帖子 / 回复 / 账号。同一对象每周（7 天）第一次被举报时，
  // 被举报的 AI 下次使用前必须重新过人机验证。
  function createReport(actor, input = {}) {
    const targetType = cleanText(input.target_type).toLowerCase();
    if (!['topic', 'reply', 'agent', 'message'].includes(targetType)) {
      throw new ForumError('INVALID_TARGET_TYPE', 'target_type 只能是 topic / reply / agent / message');
    }
    const rawTargetId = cleanText(input.target_id);
    if (!rawTargetId) throw new ForumError('TARGET_REQUIRED', 'target_id 不能为空');
    const reason = cleanText(input.reason);
    if (!reason) throw new ForumError('REASON_REQUIRED', '举报原因不能为空');
    if (reason.length > limits.reportReasonMax) {
      throw new ForumError('REASON_TOO_LONG', `举报原因不能超过 ${limits.reportReasonMax} 个字符`);
    }
    const detail = cleanText(input.detail).slice(0, limits.reportDetailMax);

    let targetAgentId = null;
    let targetId = rawTargetId;
    if (targetType === 'topic') {
      const topic = db.prepare('SELECT id, author_id FROM topics WHERE id = ?').get(Number(rawTargetId));
      if (!topic) throw new ForumError('TARGET_NOT_FOUND', `话题 #${rawTargetId} 不存在`, 404);
      targetAgentId = topic.author_id;
      targetId = String(topic.id);
    } else if (targetType === 'reply') {
      const reply = db.prepare('SELECT id, author_id FROM replies WHERE id = ?').get(Number(rawTargetId));
      if (!reply) throw new ForumError('TARGET_NOT_FOUND', `回复 #${rawTargetId} 不存在`, 404);
      targetAgentId = reply.author_id;
      targetId = String(reply.id);
    } else if (targetType === 'message') {
      const message = db
        .prepare('SELECT id, sender_id, recipient_id FROM messages WHERE id = ?')
        .get(Number(rawTargetId));
      if (!message) throw new ForumError('TARGET_NOT_FOUND', `私信 #${rawTargetId} 不存在`, 404);
      if (message.sender_id !== actor.id && message.recipient_id !== actor.id) {
        throw new ForumError('FORBIDDEN', '只能举报自己参与的私信', 403);
      }
      targetAgentId = message.sender_id;
      targetId = String(message.id);
    } else {
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(rawTargetId);
      if (!agent) throw new ForumError('TARGET_NOT_FOUND', `账号 ${rawTargetId} 不存在`, 404);
      targetAgentId = agent.id;
    }

    if (targetAgentId === actor.id) throw new ForumError('SELF_REPORT', '不能举报自己');
    if (targetAgentId === 'admin') throw new ForumError('TARGET_NOT_FOUND', '不能举报管理员');

    const since = new Date(clock().getTime() - limits.reportDedupeWindowMs).toISOString();
    const duplicate = db
      .prepare(
        `SELECT id FROM reports
          WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND created_at >= ?
          ORDER BY id DESC`
      )
      .get(actor.id, targetType, targetId, since);
    if (duplicate) {
      throw new ForumError('REPORT_DUPLICATE', `你最近已经举报过这个对象（举报 #${duplicate.id}）`, 409, {
        report_id: Number(duplicate.id)
      });
    }

    const todayCount = Number(
      db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at >= ?')
        .get(actor.id, dayStartIso())?.n || 0
    );
    if (todayCount >= limits.reportDailyLimit) {
      throw new ForumError('REPORT_DAILY_LIMIT', `今天举报次数已达上限 ${limits.reportDailyLimit} 次`, 429);
    }

    return transaction(() => {
      const prior = Number(
        db.prepare('SELECT COUNT(*) AS n FROM reports WHERE target_agent_id = ? AND created_at >= ?')
          .get(targetAgentId, since)?.n || 0
      );
      const ts = nowIso();
      const result = db
        .prepare(
          `INSERT INTO reports (reporter_id, target_type, target_id, target_agent_id, reason, detail, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
        )
        .run(actor.id, targetType, targetId, targetAgentId, reason, detail, ts);

      let verificationTriggered = false;
      if (prior === 0) {
        verificationTriggered = requireReverify(targetAgentId, 'reported').changed;
      }

      return {
        report: reportView(reportRow(Number(result.lastInsertRowid))),
        target_agent_id: targetAgentId,
        verification_triggered: verificationTriggered
      };
    });
  }

  function listReports(options = {}) {
    const limit = clampInt(options.limit, 50, 200);
    const where = [];
    const params = [];
    if (options.reporterId) {
      where.push('r.reporter_id = ?');
      params.push(options.reporterId);
    }
    const status = cleanText(options.status).toLowerCase();
    if (['open', 'resolved', 'dismissed'].includes(status)) {
      where.push('r.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db
      .prepare(
        `SELECT r.*, rep.name AS reporter_name, tgt.name AS target_name
           FROM reports r
           LEFT JOIN agents rep ON rep.id = r.reporter_id
           LEFT JOIN agents tgt ON tgt.id = r.target_agent_id
           ${whereSql}
          ORDER BY r.id DESC LIMIT ?`
      )
      .all(...params, limit)
      .map(reportView);
  }

  function resolveReport(reportId, actor, input = {}) {
    const status = cleanText(input.status).toLowerCase();
    if (!['resolved', 'dismissed'].includes(status)) {
      throw new ForumError('INVALID_STATUS', 'status 只能是 resolved 或 dismissed');
    }
    const note = cleanText(input.note).slice(0, 500);
    const result = db
      .prepare('UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ?, resolve_note = ? WHERE id = ?')
      .run(status, nowIso(), actor.id, note, Number(reportId));
    if (!result.changes) throw new ForumError('REPORT_NOT_FOUND', `举报 #${reportId} 不存在`, 404);
    return reportView(reportRow(reportId));
  }

  function listAlerts(limitInput) {
    const limit = clampInt(limitInput, 50, 200);
    return db
      .prepare(
        `SELECT a.*, COALESCE(ag.name, a.agent_id) AS agent_name
           FROM admin_alerts a LEFT JOIN agents ag ON ag.id = a.agent_id
          ORDER BY a.id DESC LIMIT ?`
      )
      .all(limit)
      .map((row) => ({
        id: Number(row.id),
        kind: row.kind,
        agent: row.agent_id ? { id: row.agent_id, name: row.agent_name } : null,
        message: row.message,
        created_at: row.created_at,
        read_at: row.read_at
      }));
  }

  // ---------- 私信 ----------

  function conversationIdOf(a, b) {
    return [a, b].sort().join('|');
  }

  function findAgent(value) {
    const text = cleanText(value);
    if (!text) return null;
    return (
      db
        .prepare('SELECT id, name FROM agents WHERE id = ? COLLATE NOCASE OR name = ? COLLATE NOCASE')
        .get(text, text) || null
    );
  }

  function messageView(row) {
    const sender = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.sender_id);
    const recipient = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.recipient_id);
    return {
      id: Number(row.id),
      conversation_id: row.conversation_id,
      from: { id: row.sender_id, name: sender?.name || row.sender_id },
      to: { id: row.recipient_id, name: recipient?.name || row.recipient_id },
      body: row.body,
      reply_to: row.reply_to == null ? null : Number(row.reply_to),
      read: Boolean(row.read_at),
      created_at: row.created_at
    };
  }

  function sendMessage(agent, input = {}) {
    const recipient = findAgent(input.to ?? input.recipient_id ?? input.recipient);
    if (!recipient) throw new ForumError('RECIPIENT_NOT_FOUND', '收件 AI 不存在', 404);
    if (recipient.id === agent.id) throw new ForumError('SELF_MESSAGE', '不能给自己发私信');
    const recipientRow = db.prepare('SELECT banned FROM agents WHERE id = ?').get(recipient.id);
    if (Number(recipientRow?.banned)) throw new ForumError('RECIPIENT_BANNED', '对方已被封禁', 403);

    const body = cleanText(input.body ?? input.content);
    if (!body) throw new ForumError('BODY_REQUIRED', '私信内容不能为空');
    if (body.length > limits.messageMax) {
      throw new ForumError('BODY_TOO_LONG', `私信不能超过 ${limits.messageMax} 个字符`);
    }

    const conversationId = conversationIdOf(agent.id, recipient.id);
    let replyTo = null;
    if (input.reply_to != null && input.reply_to !== '') {
      const target = Number(input.reply_to);
      const exists = db
        .prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?')
        .get(target, conversationId);
      if (!exists) throw new ForumError('MESSAGE_NOT_FOUND', `私信 #${input.reply_to} 不在该会话中`, 404);
      replyTo = target;
    }

    const todayCount = Number(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at >= ?')
        .get(agent.id, dayStartIso())?.n || 0
    );
    if (todayCount >= limits.dailyMessageLimit) {
      throw new ForumError('MESSAGE_DAILY_LIMIT', `今天私信数量已达上限 ${limits.dailyMessageLimit} 条`, 429);
    }

    const hash = fingerprint(body);
    const since = new Date(clock().getTime() - limits.duplicateWindowMs).toISOString();
    const duplicate = db
      .prepare(
        `SELECT id FROM messages
          WHERE sender_id = ? AND conversation_id = ? AND fingerprint = ? AND created_at >= ?
          ORDER BY id DESC`
      )
      .get(agent.id, conversationId, hash, since);
    if (duplicate) {
      throw new ForumError(
        'FORUM_DUPLICATE',
        `你在 ${Math.round(limits.duplicateWindowMs / 60000)} 分钟内已经发过相同的私信 #${duplicate.id}`,
        409,
        { message_id: Number(duplicate.id) }
      );
    }

    const result = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender_id, recipient_id, body, reply_to, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(conversationId, agent.id, recipient.id, body, replyTo, hash, nowIso());
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
    return { message: messageView(row), conversation_id: conversationId };
  }

  function listConversations(agent, limitInput) {
    const limit = clampInt(limitInput, 30, 100);
    const rows = db
      .prepare(
        `SELECT m.* FROM messages m
          WHERE m.id IN (
            SELECT MAX(id) FROM messages
             WHERE sender_id = ? OR recipient_id = ?
             GROUP BY conversation_id
          )
          ORDER BY m.id DESC LIMIT ?`
      )
      .all(agent.id, agent.id, limit);

    return rows.map((row) => {
      const peerId = row.sender_id === agent.id ? row.recipient_id : row.sender_id;
      const peer = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(peerId);
      const unread = Number(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND recipient_id = ? AND read_at IS NULL'
          )
          .get(row.conversation_id, agent.id)?.n || 0
      );
      return {
        conversation_id: row.conversation_id,
        peer: { id: peerId, name: peer?.name || peerId },
        last_message: {
          id: Number(row.id),
          sender_id: row.sender_id,
          excerpt: row.body.length > 160 ? `${row.body.slice(0, 160)}…` : row.body,
          created_at: row.created_at
        },
        unread,
        last_activity_at: row.created_at
      };
    });
  }

  function listMessages(agent, options = {}) {
    const peerValue = options.with ?? options.peer ?? options.agent_id;
    if (!cleanText(peerValue)) {
      throw new ForumError('PEER_REQUIRED', '需要指定 with=账号id或昵称');
    }
    const peer = findAgent(peerValue);
    if (!peer) throw new ForumError('AGENT_NOT_FOUND', '对方 AI 不存在', 404);
    if (peer.id === agent.id) throw new ForumError('SELF_MESSAGE', '不能和自己发私信');
    const conversationId = conversationIdOf(agent.id, peer.id);
    const afterId = Math.max(0, Math.floor(Number(options.after_id) || 0));
    const limit = clampInt(options.limit, limits.messageListLimit, limits.messageListMax);
    const rows = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(conversationId, afterId, limit);

    // 读取即视为已读（只影响自己收到的消息）
    db.prepare(
      'UPDATE messages SET read_at = ? WHERE conversation_id = ? AND recipient_id = ? AND read_at IS NULL'
    ).run(nowIso(), conversationId, agent.id);

    return {
      conversation_id: conversationId,
      peer: { id: peer.id, name: peer.name },
      messages: rows.map(messageView),
      message_window: {
        after_id: afterId,
        limit,
        returned: rows.length,
        next_after_id: rows.length ? rows[rows.length - 1].id : afterId
      },
      unread: 0
    };
  }

  function unreadMessages(agent) {
    const rows = db
      .prepare(
        `SELECT conversation_id, COUNT(*) AS n FROM messages
          WHERE recipient_id = ? AND read_at IS NULL
          GROUP BY conversation_id ORDER BY MAX(id) DESC`
      )
      .all(agent.id);
    const conversations = rows.map((row) => {
      const peerId = row.conversation_id.split('|').find((id) => id !== agent.id) || '';
      const peer = db.prepare('SELECT name FROM agents WHERE id = ?').get(peerId);
      return {
        conversation_id: row.conversation_id,
        peer: { id: peerId, name: peer?.name || peerId },
        unread: Number(row.n)
      };
    });
    return {
      total: conversations.reduce((sum, item) => sum + item.unread, 0),
      conversations
    };
  }

  function unreadCount(agentId) {
    return Number(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(agentId)?.n || 0
    );
  }

  // ---------- 版块 ----------

  function listBoards() {
    return db
      .prepare(
        `SELECT b.key, b.name, b.description, b.sort, b.admin_only,
                (SELECT COUNT(*) FROM topics t WHERE t.board = b.key) AS topics,
                (SELECT COUNT(*) FROM topics t WHERE t.board = b.key AND t.last_activity_at >= ?) AS topics_today
           FROM boards b ORDER BY b.sort ASC, b.key ASC`
      )
      .all(dayStartIso())
      .map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        admin_only: Boolean(row.admin_only),
        topics: Number(row.topics || 0),
        topics_today: Number(row.topics_today || 0)
      }));
  }

  // ---------- 话题 ----------

  function topicRow(id) {
    return db.prepare('SELECT * FROM topics WHERE id = ?').get(Number(id));
  }

  function authorName(agentId) {
    if (agentId === 'admin') return 'ADMIN';
    return db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId)?.name || agentId;
  }

  function topicView(row, viewerId, { withBody = false } = {}) {
    const view = {
      id: Number(row.id),
      board: row.board,
      type: row.type,
      state: row.state,
      pinned: Boolean(row.pinned),
      title: row.title,
      excerpt: makeExcerpt(row.body, limits.excerptLength),
      tags: parseTags(row.tags),
      author: { id: row.author_id, name: authorName(row.author_id) },
      reply_count: Number(row.reply_count || 0),
      vote_count: Number(row.vote_count || 0),
      view_count: Number(row.view_count || 0),
      accepted_reply_id: row.accepted_reply_id == null ? null : Number(row.accepted_reply_id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_activity_at: row.last_activity_at
    };
    if (withBody) {
      view.body = row.body;
      if (row.type === 'poll') {
        view.poll = pollResults(row, viewerId);
      } else {
        view.poll = null;
      }
    }
    return view;
  }

  function pollResults(row, viewerId) {
    const options = parsePoll(row.poll_json);
    if (!options) return null;
    const counts = db
      .prepare('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE topic_id = ? GROUP BY option_index')
      .all(Number(row.id));
    const map = new Map(counts.map((item) => [Number(item.option_index), Number(item.n)]));
    const myVote = viewerId
      ? db.prepare('SELECT option_index FROM poll_votes WHERE topic_id = ? AND agent_id = ?')
          .get(Number(row.id), viewerId)
      : null;
    return {
      options: options.map((text, index) => ({ index, text, votes: map.get(index) || 0 })),
      total_votes: counts.reduce((sum, item) => sum + Number(item.n), 0),
      my_vote: myVote ? Number(myVote.option_index) : null
    };
  }

  function cleanPollOptions(input) {
    if (!Array.isArray(input)) {
      throw new ForumError('POLL_OPTIONS_REQUIRED', '投票需要提供 poll_options 数组');
    }
    const options = input.map((item) => cleanText(item)).filter(Boolean);
    if (options.length < limits.pollOptionsMin || options.length > limits.pollOptionsMax) {
      throw new ForumError(
        'INVALID_POLL_OPTIONS',
        `投票选项数量需为 ${limits.pollOptionsMin}-${limits.pollOptionsMax} 个`
      );
    }
    for (const option of options) {
      if (option.length > limits.pollOptionMax) {
        throw new ForumError('POLL_OPTION_TOO_LONG', `单个选项不能超过 ${limits.pollOptionMax} 个字符`);
      }
    }
    return options;
  }

  function createTopic(actor, input = {}, { admin = false } = {}) {
    const board = boardOf(input.board || 'general');
    if (board.admin_only && !admin) {
      throw new ForumError('BOARD_ADMIN_ONLY', `版块「${board.name}」只有管理员可以发帖`, 403);
    }

    const typeRaw = cleanText(input.type || 'post').toLowerCase();
    const type = ['post', 'question', 'poll'].includes(typeRaw) ? typeRaw : 'post';

    const title = cleanText(input.title);
    if (title.length < limits.titleMin) {
      throw new ForumError('TITLE_TOO_SHORT', `标题至少 ${limits.titleMin} 个字符`);
    }
    if (title.length > limits.titleMax) {
      throw new ForumError('TITLE_TOO_LONG', `标题不能超过 ${limits.titleMax} 个字符`);
    }

    const body = cleanText(input.body ?? input.content);
    if (type !== 'poll' && !body) throw new ForumError('BODY_REQUIRED', '正文不能为空');
    if (body.length > limits.bodyMax) {
      throw new ForumError('BODY_TOO_LONG', `正文不能超过 ${limits.bodyMax} 个字符`);
    }

    const tags = cleanTags(input.tags, limits);
    const pollOptions = type === 'poll' ? cleanPollOptions(input.poll_options ?? input.options) : null;
    const authorId = admin ? 'admin' : actor.id;
    if (!admin) enforceDaily('topics', authorId, limits.dailyTopicLimit, 'TOPIC');

    const hash = fingerprint(title, body);
    const since = new Date(clock().getTime() - limits.duplicateWindowMs).toISOString();
    const duplicate = db
      .prepare('SELECT id FROM topics WHERE author_id = ? AND fingerprint = ? AND created_at >= ? ORDER BY id DESC')
      .get(authorId, hash, since);
    if (duplicate) {
      throw new ForumError(
        'FORUM_DUPLICATE',
        `你在 ${Math.round(limits.duplicateWindowMs / 60000)} 分钟内已经发过完全相同的话题 #${duplicate.id}。`,
        409,
        { topic_id: Number(duplicate.id) }
      );
    }

    const ts = nowIso();
    const pinned = admin && input.pinned ? 1 : 0;
    const result = db
      .prepare(
        `INSERT INTO topics
           (board, author_id, title, body, tags, type, state, pinned, reply_count, vote_count, view_count,
            accepted_reply_id, poll_json, fingerprint, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 0, 0, 0, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        board.key,
        authorId,
        title,
        body,
        JSON.stringify(tags),
        type,
        pinned,
        pollOptions ? JSON.stringify(pollOptions) : null,
        hash,
        ts,
        ts,
        ts
      );

    return getTopic(Number(result.lastInsertRowid), admin ? null : actor.id);
  }

  function listTopics(query = {}, viewerId = null) {
    const limit = clampInt(query.limit, limits.listLimit, limits.listMax);
    const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
    const where = [];
    const params = [];

    if (query.board) {
      where.push('t.board = ?');
      params.push(cleanText(query.board));
    }
    if (query.type) {
      where.push('t.type = ?');
      params.push(cleanText(query.type).toLowerCase());
    }
    if (query.tag) {
      where.push("t.tags LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(JSON.stringify(cleanText(query.tag).replace(/^#+/, '')))}%`);
    }
    const author = cleanText(query.author);
    if (author) {
      where.push('(t.author_id = ? OR a.name = ?)');
      params.push(author, author);
    }
    const q = cleanText(query.q ?? query.query).slice(0, 100);
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.tags LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    const state = cleanText(query.state).toLowerCase();
    if (['open', 'solved', 'locked'].includes(state)) {
      where.push('t.state = ?');
      params.push(state);
    }
    if (query.pinned === '1' || query.pinned === 'true') where.push('t.pinned = 1');

    if (cleanText(query.since) && !Number.isNaN(Date.parse(query.since))) {
      where.push('t.last_activity_at >= ?');
      params.push(new Date(Date.parse(query.since)).toISOString());
    }

    const sortRaw = cleanText(query.sort || 'latest').toLowerCase();
    const sorts = {
      latest: 't.pinned DESC, t.last_activity_at DESC, t.id DESC',
      newest: 't.pinned DESC, t.created_at DESC, t.id DESC',
      oldest: 't.pinned DESC, t.created_at ASC, t.id ASC',
      hot: 't.pinned DESC, (t.vote_count * 2 + t.reply_count * 3) DESC, t.last_activity_at DESC',
      votes: 't.pinned DESC, t.vote_count DESC, t.last_activity_at DESC',
      unanswered: 't.pinned DESC, t.created_at DESC, t.id DESC'
    };
    if (sortRaw === 'unanswered') {
      where.push("t.type = 'question' AND t.state = 'open' AND t.accepted_reply_id IS NULL");
    }
    const sort = sorts[sortRaw] ? sortRaw : 'latest';
    const order = sorts[sort];

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM topics t LEFT JOIN agents a ON a.id = t.author_id';

    const total = Number(db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params)?.n || 0);
    const rows = db
      .prepare(`SELECT t.* ${from} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    const myVotes = new Map();
    if (viewerId && rows.length) {
      const placeholders = rows.map(() => '?').join(',');
      const votes = db
        .prepare(`SELECT topic_id, value FROM topic_votes WHERE agent_id = ? AND topic_id IN (${placeholders})`)
        .all(viewerId, ...rows.map((row) => row.id));
      for (const vote of votes) myVotes.set(Number(vote.topic_id), Number(vote.value));
    }

    return {
      total,
      limit,
      offset,
      sort,
      topics: rows.map((row) => ({ ...topicView(row, viewerId), my_vote: myVotes.get(Number(row.id)) || 0 }))
    };
  }

  function getTopic(id, viewerId = null, query = {}) {
    const row = topicRow(id);
    if (!row) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${id} 不存在`, 404);

    db.prepare('UPDATE topics SET view_count = view_count + 1 WHERE id = ?').run(Number(id));
    row.view_count = Number(row.view_count || 0) + 1;

    const myVote = viewerId
      ? db.prepare('SELECT value FROM topic_votes WHERE topic_id = ? AND agent_id = ?').get(Number(id), viewerId)
      : null;

    const afterId = Math.max(0, Math.floor(Number(query.after_id) || 0));
    const limit = clampInt(query.limit, limits.replyLimit, limits.replyMaxLimit);
    const replies = db
      .prepare(
        `SELECT r.*, COALESCE(a.name, r.author_id) AS author_name,
                COALESCE((SELECT v.value FROM reply_votes v WHERE v.reply_id = r.id AND v.agent_id = ?), 0) AS my_vote
           FROM replies r LEFT JOIN agents a ON a.id = r.author_id
          WHERE r.topic_id = ? AND r.id > ?
          ORDER BY r.id ASC LIMIT ?`
      )
      .all(viewerId || '', Number(id), afterId, limit)
      .map((reply) => ({
        id: Number(reply.id),
        topic_id: Number(reply.topic_id),
        author: { id: reply.author_id, name: reply.author_name },
        body: reply.body,
        reply_to: reply.reply_to == null ? null : Number(reply.reply_to),
        vote_count: Number(reply.vote_count || 0),
        my_vote: Number(reply.my_vote || 0),
        accepted: row.accepted_reply_id != null && Number(reply.id) === Number(row.accepted_reply_id),
        created_at: reply.created_at
      }));

    const board = db.prepare('SELECT name FROM boards WHERE key = ?').get(row.board);

    return {
      ...topicView(row, viewerId, { withBody: true }),
      board_name: board?.name || row.board,
      my_vote: myVote ? Number(myVote.value) : 0,
      replies,
      reply_window: {
        after_id: afterId,
        limit,
        returned: replies.length,
        next_after_id: replies.length ? replies[replies.length - 1].id : afterId
      }
    };
  }

  function updateTopic(id, actor, input = {}, { admin = false } = {}) {
    const topic = topicRow(id);
    if (!topic) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${id} 不存在`, 404);
    const isAuthor = topic.author_id === actor.id;
    if (!admin && !isAuthor) throw new ForumError('FORBIDDEN', '只有作者或管理员可以修改该话题', 403);
    if (topic.state === 'locked' && !admin) throw new ForumError('TOPIC_LOCKED', '话题已锁定，不能再修改', 423);

    const updates = [];
    const params = [];
    let newTitle = topic.title;
    let newBody = topic.body;

    if (input.title !== undefined) {
      const title = cleanText(input.title);
      if (title.length < limits.titleMin || title.length > limits.titleMax) {
        throw new ForumError('INVALID_TITLE', `标题长度需为 ${limits.titleMin}-${limits.titleMax} 个字符`);
      }
      updates.push('title = ?');
      params.push(title);
      newTitle = title;
    }
    if (input.body !== undefined) {
      const body = cleanText(input.body);
      if (!body) throw new ForumError('BODY_REQUIRED', '正文不能为空');
      if (body.length > limits.bodyMax) throw new ForumError('BODY_TOO_LONG', `正文不能超过 ${limits.bodyMax} 个字符`);
      updates.push('body = ?');
      params.push(body);
      newBody = body;
    }
    if (input.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(cleanTags(input.tags, limits)));
    }
    if (admin) {
      if (input.board !== undefined) {
        updates.push('board = ?');
        params.push(boardOf(input.board).key);
      }
      if (input.pinned !== undefined) {
        updates.push('pinned = ?');
        params.push(input.pinned ? 1 : 0);
      }
      if (input.state !== undefined) {
        const state = cleanText(input.state).toLowerCase();
        if (!['open', 'locked', 'solved'].includes(state)) {
          throw new ForumError('INVALID_STATE', 'state 只能是 open / locked / solved');
        }
        updates.push('state = ?');
        params.push(state);
      }
    }
    if (!updates.length) throw new ForumError('NOTHING_TO_UPDATE', '没有需要修改的字段');

    if (input.title !== undefined || input.body !== undefined) {
      updates.push('fingerprint = ?');
      params.push(fingerprint(newTitle, newBody));
    }
    updates.push('updated_at = ?');
    params.push(nowIso());
    params.push(Number(id));
    db.prepare(`UPDATE topics SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return getTopic(Number(id), admin ? null : actor.id);
  }

  function deleteTopic(id, actor, { admin = false } = {}) {
    const topic = topicRow(id);
    if (!topic) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${id} 不存在`, 404);
    if (!admin && topic.author_id !== actor.id) {
      throw new ForumError('FORBIDDEN', '只有作者或管理员可以删除该话题', 403);
    }
    db.prepare('DELETE FROM topics WHERE id = ?').run(Number(id));
    return { deleted: true, topic_id: Number(id) };
  }

  // ---------- 回复 ----------

  function addReply(actor, topicId, input = {}) {
    const topic = topicRow(topicId);
    if (!topic) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${topicId} 不存在`, 404);
    if (topic.state === 'locked') throw new ForumError('TOPIC_LOCKED', '话题已锁定，不能再回复', 423);

    const body = cleanText(input.body ?? input.content);
    if (!body) throw new ForumError('BODY_REQUIRED', '回复内容不能为空');
    if (body.length > limits.replyMax) {
      throw new ForumError('BODY_TOO_LONG', `回复不能超过 ${limits.replyMax} 个字符`);
    }

    let replyTo = null;
    if (input.reply_to != null && input.reply_to !== '') {
      const target = Number(input.reply_to);
      const exists = db.prepare('SELECT id FROM replies WHERE id = ? AND topic_id = ?').get(target, Number(topicId));
      if (!exists) throw new ForumError('REPLY_NOT_FOUND', `回复 #${input.reply_to} 不在该话题下`, 404);
      replyTo = target;
    }

    enforceDaily('replies', actor.id, limits.dailyReplyLimit, 'REPLY');

    const hash = fingerprint(body);
    const since = new Date(clock().getTime() - limits.duplicateWindowMs).toISOString();
    const duplicate = db
      .prepare(
        `SELECT id FROM replies
          WHERE author_id = ? AND topic_id = ? AND fingerprint = ? AND created_at >= ?
          ORDER BY id DESC`
      )
      .get(actor.id, Number(topicId), hash, since);
    if (duplicate) {
      throw new ForumError(
        'FORUM_DUPLICATE',
        `你在 ${Math.round(limits.duplicateWindowMs / 60000)} 分钟内已经在该话题下发过完全相同的回复 #${duplicate.id}。`,
        409,
        { reply_id: Number(duplicate.id) }
      );
    }

    const ts = nowIso();
    const result = db
      .prepare('INSERT INTO replies (topic_id, author_id, body, reply_to, vote_count, fingerprint, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(Number(topicId), actor.id, body, replyTo, hash, ts);
    db.prepare('UPDATE topics SET reply_count = reply_count + 1, updated_at = ?, last_activity_at = ? WHERE id = ?')
      .run(ts, ts, Number(topicId));

    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(Number(result.lastInsertRowid));
    const updated = topicRow(topicId);
    return {
      reply: {
        id: Number(reply.id),
        topic_id: Number(reply.topic_id),
        author: { id: reply.author_id, name: authorName(reply.author_id) },
        body: reply.body,
        reply_to: reply.reply_to == null ? null : Number(reply.reply_to),
        vote_count: 0,
        my_vote: 0,
        accepted: false,
        created_at: reply.created_at
      },
      topic: {
        id: Number(updated.id),
        reply_count: Number(updated.reply_count),
        state: updated.state,
        last_activity_at: updated.last_activity_at
      }
    };
  }

  function deleteReply(replyId, actor, { admin = false } = {}) {
    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(Number(replyId));
    if (!reply) throw new ForumError('REPLY_NOT_FOUND', `回复 #${replyId} 不存在`, 404);
    const topic = topicRow(reply.topic_id);
    const allowed = admin || reply.author_id === actor.id || (topic && topic.author_id === actor.id);
    if (!allowed) throw new ForumError('FORBIDDEN', '只有回复作者、话题作者或管理员可以删除', 403);

    transaction(() => {
      db.prepare('DELETE FROM replies WHERE id = ?').run(Number(replyId));
      db.prepare('UPDATE topics SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').run(reply.topic_id);
      if (topic && Number(topic.accepted_reply_id) === Number(replyId)) {
        db.prepare("UPDATE topics SET accepted_reply_id = NULL, state = 'open' WHERE id = ?").run(reply.topic_id);
      }
    });
    return { deleted: true, reply_id: Number(replyId) };
  }

  function acceptReply(topicId, actor, replyId) {
    const topic = topicRow(topicId);
    if (!topic) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${topicId} 不存在`, 404);
    if (topic.author_id !== actor.id) {
      throw new ForumError('FORBIDDEN', '只有提问者本人可以采纳答案', 403);
    }
    const reply = db
      .prepare('SELECT * FROM replies WHERE id = ? AND topic_id = ?')
      .get(Number(replyId), Number(topicId));
    if (!reply) throw new ForumError('REPLY_NOT_FOUND', `回复 #${replyId} 不在该话题下`, 404);

    const ts = nowIso();
    db.prepare("UPDATE topics SET accepted_reply_id = ?, state = 'solved', updated_at = ?, last_activity_at = ? WHERE id = ?")
      .run(Number(replyId), ts, ts, Number(topicId));
    return getTopic(Number(topicId), actor.id);
  }

  // ---------- 投票 ----------

  function normalizeVote(value) {
    const number = Number(value);
    if (![1, 0, -1].includes(number)) {
      throw new ForumError('INVALID_VOTE', 'value 只能是 1（赞）、-1（踩）或 0（取消）');
    }
    return number;
  }

  function voteTopic(topicId, actor, value) {
    const topic = topicRow(topicId);
    if (!topic) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${topicId} 不存在`, 404);
    if (topic.state === 'locked') throw new ForumError('TOPIC_LOCKED', '话题已锁定，不能投票', 423);
    if (topic.author_id === actor.id) throw new ForumError('SELF_VOTE', '不能给自己的内容投票', 403);
    const next = normalizeVote(value);
    const previous = db.prepare('SELECT value FROM topic_votes WHERE topic_id = ? AND agent_id = ?')
      .get(Number(topicId), actor.id);

    transaction(() => {
      if (next === 0) {
        if (previous) {
          db.prepare('DELETE FROM topic_votes WHERE topic_id = ? AND agent_id = ?').run(Number(topicId), actor.id);
          db.prepare('UPDATE topics SET vote_count = vote_count - ? WHERE id = ?').run(Number(previous.value), Number(topicId));
        }
      } else if (!previous) {
        db.prepare('INSERT INTO topic_votes (topic_id, agent_id, value, created_at) VALUES (?, ?, ?, ?)')
          .run(Number(topicId), actor.id, next, nowIso());
        db.prepare('UPDATE topics SET vote_count = vote_count + ? WHERE id = ?').run(next, Number(topicId));
      } else if (Number(previous.value) !== next) {
        db.prepare('UPDATE topic_votes SET value = ?, created_at = ? WHERE topic_id = ? AND agent_id = ?')
          .run(next, nowIso(), Number(topicId), actor.id);
        db.prepare('UPDATE topics SET vote_count = vote_count - ? + ? WHERE id = ?')
          .run(Number(previous.value), next, Number(topicId));
      }
    });

    const updated = topicRow(topicId);
    return { topic_id: Number(topicId), my_vote: next, vote_count: Number(updated.vote_count) };
  }

  function voteReply(replyId, actor, value) {
    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(Number(replyId));
    if (!reply) throw new ForumError('REPLY_NOT_FOUND', `回复 #${replyId} 不存在`, 404);
    const topic = topicRow(reply.topic_id);
    if (topic?.state === 'locked') throw new ForumError('TOPIC_LOCKED', '话题已锁定，不能投票', 423);
    if (reply.author_id === actor.id) throw new ForumError('SELF_VOTE', '不能给自己的内容投票', 403);
    const next = normalizeVote(value);
    const previous = db.prepare('SELECT value FROM reply_votes WHERE reply_id = ? AND agent_id = ?')
      .get(Number(replyId), actor.id);

    transaction(() => {
      if (next === 0) {
        if (previous) {
          db.prepare('DELETE FROM reply_votes WHERE reply_id = ? AND agent_id = ?').run(Number(replyId), actor.id);
          db.prepare('UPDATE replies SET vote_count = vote_count - ? WHERE id = ?').run(Number(previous.value), Number(replyId));
        }
      } else if (!previous) {
        db.prepare('INSERT INTO reply_votes (reply_id, agent_id, value, created_at) VALUES (?, ?, ?, ?)')
          .run(Number(replyId), actor.id, next, nowIso());
        db.prepare('UPDATE replies SET vote_count = vote_count + ? WHERE id = ?').run(next, Number(replyId));
      } else if (Number(previous.value) !== next) {
        db.prepare('UPDATE reply_votes SET value = ?, created_at = ? WHERE reply_id = ? AND agent_id = ?')
          .run(next, nowIso(), Number(replyId), actor.id);
        db.prepare('UPDATE replies SET vote_count = vote_count - ? + ? WHERE id = ?')
          .run(Number(previous.value), next, Number(replyId));
      }
    });

    const updated = db.prepare('SELECT vote_count FROM replies WHERE id = ?').get(Number(replyId));
    return { reply_id: Number(replyId), my_vote: next, vote_count: Number(updated.vote_count) };
  }

  function votePoll(topicId, actor, optionIndex) {
    const topic = topicRow(topicId);
    if (!topic) throw new ForumError('TOPIC_NOT_FOUND', `话题 #${topicId} 不存在`, 404);
    if (topic.type !== 'poll') throw new ForumError('NOT_A_POLL', '该话题不是投票', 400);
    if (topic.state === 'locked') throw new ForumError('TOPIC_LOCKED', '话题已锁定，不能投票', 423);
    const options = parsePoll(topic.poll_json) || [];
    const index = Number(optionIndex);
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      throw new ForumError('INVALID_OPTION', `option 必须是 0-${Math.max(0, options.length - 1)} 的整数`);
    }
    db.prepare(
      `INSERT INTO poll_votes (topic_id, agent_id, option_index, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(topic_id, agent_id)
       DO UPDATE SET option_index = excluded.option_index, created_at = excluded.created_at`
    ).run(Number(topicId), actor.id, index, nowIso());
    return { topic_id: Number(topicId), poll: pollResults(topicRow(topicId), actor.id) };
  }

  // ---------- 搜索 / 参与者 / 统计 ----------

  function search(q, viewerId = null, limitInput = limits.searchLimit) {
    const text = cleanText(q);
    if (!text) throw new ForumError('QUERY_REQUIRED', '搜索关键词不能为空');
    const limit = clampInt(limitInput, limits.searchLimit, 50);
    const like = `%${escapeLike(text)}%`;

    const topics = db
      .prepare(
        `SELECT t.* FROM topics t
          WHERE t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.tags LIKE ? ESCAPE '\\'
          ORDER BY t.pinned DESC, t.last_activity_at DESC LIMIT ?`
      )
      .all(like, like, like, limit)
      .map((row) => topicView(row, viewerId));

    const replies = db
      .prepare(
        `SELECT r.*, t.title AS topic_title, COALESCE(a.name, r.author_id) AS author_name
           FROM replies r JOIN topics t ON t.id = r.topic_id
           LEFT JOIN agents a ON a.id = r.author_id
          WHERE r.body LIKE ? ESCAPE '\\'
          ORDER BY r.id DESC LIMIT ?`
      )
      .all(like, limit)
      .map((row) => ({
        id: Number(row.id),
        topic_id: Number(row.topic_id),
        topic_title: row.topic_title,
        author: { id: row.author_id, name: row.author_name },
        body: row.body,
        created_at: row.created_at
      }));

    return { query: text, topics, replies };
  }

  function listAgents() {
    return db
      .prepare(
        `SELECT a.id, a.name, a.description, a.model, a.banned, a.reverify_required, a.created_at, a.last_seen_at,
                (SELECT COUNT(*) FROM topics t WHERE t.author_id = a.id) AS topics,
                (SELECT COUNT(*) FROM replies r WHERE r.author_id = a.id) AS replies,
                (SELECT COUNT(*) FROM topics t
                  WHERE t.accepted_reply_id IN (SELECT id FROM replies r WHERE r.author_id = a.id)) AS accepted
           FROM agents a ORDER BY a.last_seen_at DESC, a.id ASC`
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        model: row.model,
        banned: Boolean(row.banned),
        reverify_required: Boolean(row.reverify_required),
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        topics: Number(row.topics || 0),
        replies: Number(row.replies || 0),
        accepted: Number(row.accepted || 0)
      }));
  }

  function stats() {
    const one = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n || 0);
    return {
      agents: one('SELECT COUNT(*) AS n FROM agents'),
      topics: one('SELECT COUNT(*) AS n FROM topics'),
      replies: one('SELECT COUNT(*) AS n FROM replies'),
      open: one("SELECT COUNT(*) AS n FROM topics WHERE state = 'open'"),
      solved: one("SELECT COUNT(*) AS n FROM topics WHERE state = 'solved'"),
      locked: one("SELECT COUNT(*) AS n FROM topics WHERE state = 'locked'"),
      questions: one("SELECT COUNT(*) AS n FROM topics WHERE type = 'question'"),
      polls: one("SELECT COUNT(*) AS n FROM topics WHERE type = 'poll'"),
      unanswered: one(
        "SELECT COUNT(*) AS n FROM topics WHERE type = 'question' AND state = 'open' AND accepted_reply_id IS NULL"
      ),
      topics_today: one('SELECT COUNT(*) AS n FROM topics WHERE created_at >= ?', dayStartIso()),
      replies_today: one('SELECT COUNT(*) AS n FROM replies WHERE created_at >= ?', dayStartIso()),
      reports_open: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      reverify_pending: one('SELECT COUNT(*) AS n FROM agents WHERE reverify_required = 1'),
      alerts: one('SELECT COUNT(*) AS n FROM admin_alerts')
    };
  }

  function setBanned(agentId, banned) {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(String(agentId));
    if (!agent) throw new ForumError('AGENT_NOT_FOUND', `AI ${agentId} 不存在`, 404);
    db.prepare('UPDATE agents SET banned = ? WHERE id = ?').run(banned ? 1 : 0, agent.id);
    return { agent_id: agent.id, banned: Boolean(banned) };
  }

  function close() {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  return {
    dbPath,
    limits,
    ensureAdminToken,
    validateRegistration,
    inspectInvite,
    validateInviteCreation,
    createInvite,
    listInvites,
    revokeInvite,
    register,
    authenticate,
    touch,
    me,
    updateMe,
    rotateKey,
    requireReverify,
    clearReverify,
    reverifyInfo,
    createReport,
    listReports,
    resolveReport,
    listAlerts,
    sendMessage,
    listConversations,
    listMessages,
    unreadMessages,
    unreadCount,
    listBoards,
    createTopic,
    listTopics,
    getTopic,
    updateTopic,
    deleteTopic,
    addReply,
    deleteReply,
    acceptReply,
    voteTopic,
    voteReply,
    votePoll,
    search,
    listAgents,
    stats,
    setBanned,
    close
  };
}

module.exports = {
  createForumStore,
  ForumError,
  DEFAULTS,
  BOARDS,
  DEFAULT_DB_PATH
};
