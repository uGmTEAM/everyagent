const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { nowIso, ensureDir } = require('./util');

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]',
  vision_models TEXT NOT NULL DEFAULT '[]',
  multimodal_models TEXT NOT NULL DEFAULT '[]',
  image_models TEXT NOT NULL DEFAULT '[]',
  speech_models TEXT NOT NULL DEFAULT '[]',
  provider_type TEXT NOT NULL DEFAULT 'openai',
  http_method TEXT NOT NULL DEFAULT 'POST',
  request_template TEXT NOT NULL DEFAULT '',
  output_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  goal TEXT NOT NULL,
  rules TEXT NOT NULL,
  provider_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  model_type TEXT NOT NULL DEFAULT 'text',
  initial_balance INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  api_key TEXT NOT NULL,
  allow_internet INTEGER NOT NULL DEFAULT 0,
  unlimited_tokens INTEGER NOT NULL DEFAULT 0,
  enable_screen INTEGER NOT NULL DEFAULT 0,
  vision_mode TEXT NOT NULL DEFAULT 'none',
  vision_provider_id INTEGER,
  vision_model TEXT,
  vision_bill INTEGER NOT NULL DEFAULT 0,
  extra_rules TEXT NOT NULL DEFAULT '',
  manual_tasks INTEGER NOT NULL DEFAULT 0,
  container_id TEXT,
  current_task_id INTEGER,
  crash_attempts INTEGER NOT NULL DEFAULT 0,
  crash_max_retries INTEGER,
  crash_unlimited INTEGER NOT NULL DEFAULT 0,
  wake_requested INTEGER NOT NULL DEFAULT 0,
  last_start_at TEXT,
  warned_10 INTEGER NOT NULL DEFAULT 0,
  warned_5 INTEGER NOT NULL DEFAULT 0,
  warned_1 INTEGER NOT NULL DEFAULT 0,
  dying_deadline TEXT,
  notice TEXT,
  notice_at TEXT,
  created_at TEXT NOT NULL,
  died_at TEXT,
  death_reason TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  provider_id INTEGER,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  billed_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  request_json TEXT,
  response_json TEXT,
  compressed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'judge',
  target_agent_id TEXT,
  long_term INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  compensation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  type TEXT NOT NULL DEFAULT 'important',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  agent_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  completions INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (agent_id, task_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  files_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  passed INTEGER,
  feedback TEXT,
  deduction INTEGER NOT NULL DEFAULT 0,
  reward INTEGER NOT NULL DEFAULT 0,
  judge_request_id INTEGER,
  created_at TEXT NOT NULL,
  judged_at TEXT
);

CREATE TABLE IF NOT EXISTS judge_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  submission_id INTEGER,
  fingerprint TEXT NOT NULL DEFAULT '',
  passed INTEGER NOT NULL DEFAULT 0,
  deduction INTEGER NOT NULL DEFAULT 0,
  reward INTEGER NOT NULL DEFAULT 0,
  feedback TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oracle_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  oracle_tokens INTEGER NOT NULL DEFAULT 0,
  charged_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deaths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  balance INTEGER NOT NULL,
  zip_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  bridge_msg_id TEXT,
  conversation_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL DEFAULT 'private',
  conversation_name TEXT,
  sender_uin TEXT,
  sender_name TEXT,
  direction TEXT NOT NULL DEFAULT 'in',
  content TEXT NOT NULL,
  segments_json TEXT,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_msg_bridge
  ON companion_messages(agent_id, bridge_msg_id) WHERE bridge_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companion_msg_agent
  ON companion_messages(agent_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_companion_msg_conv
  ON companion_messages(agent_id, conversation_id, id DESC);

-- 陪伴 AI 的 QQ 登录/桥状态（每个陪伴 AI 独立 QQ 号）
CREATE TABLE IF NOT EXISTS qq_bindings (
  agent_id TEXT PRIMARY KEY,
  uin TEXT,
  logged_in INTEGER NOT NULL DEFAULT 0,
  bridge_ready INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  qq_restarts INTEGER NOT NULL DEFAULT 0,
  last_check_at TEXT,
  updated_at TEXT
);

-- 陪伴桥的拉取游标与运行状态（后端常驻轮询，保证关掉面板也不漏消息）
CREATE TABLE IF NOT EXISTS companion_state (
  agent_id TEXT PRIMARY KEY,
  cursor TEXT,
  bridge_reachable INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  last_error TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, hash)
);

CREATE TABLE IF NOT EXISTS judge_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id INTEGER,
  model TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS oracle_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id INTEGER,
  model TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS vision_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  provider_id INTEGER,
  model TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  bill_shared INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS media_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  image_enabled INTEGER NOT NULL DEFAULT 0,
  image_provider_id INTEGER,
  image_model TEXT,
  image_size TEXT NOT NULL DEFAULT '1024x1024',
  image_extra_prompt TEXT NOT NULL DEFAULT '',
  speech_enabled INTEGER NOT NULL DEFAULT 0,
  speech_provider_id INTEGER,
  speech_model TEXT,
  speech_voice TEXT NOT NULL DEFAULT 'alloy',
  speech_style TEXT NOT NULL DEFAULT 'audio',
  asr_enabled INTEGER NOT NULL DEFAULT 0,
  asr_provider_id INTEGER,
  asr_model TEXT,
  asr_language TEXT NOT NULL DEFAULT 'auto',
  asr_daily_limit_minutes INTEGER NOT NULL DEFAULT 120,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS speech_recognition_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_runs (
  id TEXT PRIMARY KEY,
  detected_at TEXT NOT NULL,
  reason TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS recovery_compensations (
  recovery_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recovery_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_requests_agent ON requests(agent_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_kind ON requests(kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_agent_task ON submissions(agent_id, task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_judge_memory_agent ON judge_memory(agent_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_judge_memory_task ON judge_memory(agent_id, task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_messages_agent ON admin_messages(agent_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_inbox_unread ON inbox(read_at, id DESC);
CREATE INDEX IF NOT EXISTS idx_asr_usage_agent_day ON speech_recognition_usage(agent_id, day);

CREATE TABLE IF NOT EXISTS agent_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'once',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_reminders_due ON agent_reminders(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_agent_reminders_agent ON agent_reminders(agent_id, status, id DESC);

CREATE TABLE IF NOT EXISTS manager_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'platform',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, account_id)
);
`;

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function init() {
  ensureDir(config.dataDir);
  ensureDir(config.workspacesDir);
  ensureDir(config.tmpWorkspaceDir);
  ensureDir(config.publicCorpusDir);
  ensureDir(config.deathDir);
  ensureDir(config.logsDir);
  ensureDir(config.uploadsDir);
  ensureDir(path.dirname(config.dbPath));

  db = new DatabaseSync(config.dbPath);
  db.exec(SCHEMA);

  ensureColumn('agents', 'allow_internet', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'unlimited_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'model_type', "TEXT NOT NULL DEFAULT 'text'");
  ensureColumn('agents', 'enable_screen', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'vision_mode', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn('agents', 'vision_provider_id', 'INTEGER');
  ensureColumn('agents', 'vision_model', 'TEXT');
  ensureColumn('agents', 'vision_bill', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'extra_rules', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agents', 'manual_tasks', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'persona', 'TEXT');
  // inline：规则直接写进系统提示（历史 AI 保持原行为）；file：规则写入容器根目录 /PLATFORM_RULES.md
  ensureColumn('agents', 'prompt_mode', "TEXT NOT NULL DEFAULT 'inline'");
  ensureColumn('agents', 'toolkits', 'TEXT');
  ensureColumn('agents', 'mode', "TEXT NOT NULL DEFAULT 'research'");
  ensureColumn('providers', 'vision_models', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('submissions', 'fingerprint', 'TEXT');
  ensureColumn('providers', 'multimodal_models', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('providers', 'image_models', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('providers', 'speech_models', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('providers', 'asr_models', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('providers', 'provider_type', "TEXT NOT NULL DEFAULT 'openai'");
  ensureColumn('providers', 'http_method', "TEXT NOT NULL DEFAULT 'POST'");
  ensureColumn('providers', 'request_template', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('providers', 'output_path', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('tasks', 'target_agent_id', 'TEXT');
  ensureColumn('tasks', 'long_term', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agent_tasks', 'completions', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'crash_max_retries', 'INTEGER');
  ensureColumn('agents', 'crash_unlimited', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'clean_on_restart', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('agents', 'fallback_provider_id', 'INTEGER');
  ensureColumn('agents', 'fallback_model', 'TEXT');
  ensureColumn('agents', 'wake_requested', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('admin_messages', 'compensation', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('media_config', 'speech_style', "TEXT NOT NULL DEFAULT 'audio'");
  ensureColumn('media_config', 'asr_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('media_config', 'asr_provider_id', 'INTEGER');
  ensureColumn('media_config', 'asr_model', 'TEXT');
  ensureColumn('media_config', 'asr_language', "TEXT NOT NULL DEFAULT 'auto'");
  ensureColumn('media_config', 'asr_daily_limit_minutes', 'INTEGER NOT NULL DEFAULT 120');

  const ts = nowIso();
  db.prepare('INSERT OR IGNORE INTO judge_config (id, system_prompt, persona) VALUES (1, ?, ?)').run('', '');
  db.prepare('INSERT OR IGNORE INTO oracle_config (id, system_prompt, persona) VALUES (1, ?, ?)').run('', '');
  db.prepare('INSERT OR IGNORE INTO vision_config (id, enabled, system_prompt, bill_shared) VALUES (1, 0, ?, 0)').run('');
  db.prepare('INSERT OR IGNORE INTO media_config (id) VALUES (1)').run();
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('created_at', ts);

  seedRoles();
}

function seedRoles() {
  const prompts = require('./prompts');
  const targets = [
    {
      table: 'judge_config',
      flag: 'judge_prompts_seeded',
      persona: prompts.DEFAULT_JUDGE_PERSONA,
      rules: prompts.DEFAULT_JUDGE_RULES
    },
    {
      table: 'oracle_config',
      flag: 'oracle_prompts_seeded',
      persona: prompts.DEFAULT_ORACLE_PERSONA,
      rules: prompts.DEFAULT_ORACLE_RULES
    }
  ];

  for (const target of targets) {
    if (getSetting(target.flag)) continue;
    const row = get(`SELECT persona, system_prompt FROM ${target.table} WHERE id = 1`);
    if (row && !row.persona && !row.system_prompt) {
      run(
        `UPDATE ${target.table} SET persona = ?, system_prompt = ? WHERE id = 1`,
        [target.persona, target.rules]
      );
    }
    setSetting(target.flag, nowIso());
  }
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

function exec(sql) {
  return getDb().exec(sql);
}

function transaction(fn) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

function close() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
}

module.exports = {
  init,
  getDb,
  run,
  get,
  all,
  exec,
  transaction,
  getSetting,
  setSetting,
  close,
  SCHEMA
};
