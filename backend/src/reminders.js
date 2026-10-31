// 陪伴 AI 的自我定时提醒：一次性 / 长期（间隔或每日固定时刻）。
// 到期后写入 companion_messages（标记为 [定时提醒]），由 AI 的 inbox 正常拉取。
const db = require('./db');
const { nowIso, truncate } = require('./util');
const { addEvent } = require('./events');

const TIME_ZONE = 'Asia/Shanghai';
const TICK_MS = 30000;
const MAX_PENDING = 50;
let timer = null;

function pad(value) {
  return String(value).padStart(2, '0');
}

function shanghaiNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(now).reduce((acc, item) => {
    if (item.type !== 'literal') acc[item.type] = item.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

// 把 Asia/Shanghai 的墙钟时间换算成 UTC 时刻。
function nextDailyAt(hhmm, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!match) throw new Error('daily_at 需为 HH:MM，例如 09:30');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('daily_at 时间不合法');
  const local = shanghaiNow(now);
  let target = Date.UTC(local.year, local.month - 1, local.day, hour, minute);
  const localNow = Date.UTC(
    local.year, local.month - 1, local.day, local.hour, local.minute,
    now.getUTCSeconds(), now.getUTCMilliseconds()
  );
  if (target <= localNow) target += 86400000;
  return new Date(target - 8 * 3600 * 1000);
}

function computeFirstRun(input, now = new Date()) {
  const when = String(input.when || '').trim();
  const every = input.every_minutes == null || input.every_minutes === '' ? null : Number(input.every_minutes);
  const daily = String(input.daily_at || '').trim();
  const given = (when ? 1 : 0) + (every ? 1 : 0) + (daily ? 1 : 0);
  if (given !== 1) throw new Error('when / every_minutes / daily_at 必须且只能提供一个');

  if (when) {
    const date = new Date(when);
    if (Number.isNaN(date.getTime())) {
      throw new Error('when 不合法，请用 ISO 8601，例如 2026-11-01T09:00:00+08:00');
    }
    if (date.getTime() - now.getTime() < 30000) throw new Error('when 至少要比当前时间晚 30 秒');
    return {
      kind: 'once',
      schedule: { when: date.toISOString() },
      nextRunAt: date.toISOString()
    };
  }

  if (every) {
    const minutes = Math.floor(every);
    if (!(minutes >= 5 && minutes <= 10080)) throw new Error('every_minutes 需在 5 ~ 10080（7 天）之间');
    return {
      kind: 'recurring',
      schedule: { every_minutes: minutes },
      nextRunAt: new Date(now.getTime() + minutes * 60000).toISOString()
    };
  }

  const next = nextDailyAt(daily, now);
  return {
    kind: 'recurring',
    schedule: { daily_at: `${pad(daily.split(':')[0])}:${daily.split(':')[1]}` },
    nextRunAt: next.toISOString()
  };
}

function serialize(reminder) {
  if (!reminder) return null;
  let schedule = {};
  try {
    schedule = JSON.parse(reminder.schedule_json || '{}');
  } catch {
    schedule = {};
  }
  return {
    id: reminder.id,
    title: reminder.title,
    message: reminder.message,
    kind: reminder.kind,
    schedule,
    next_run_at: reminder.next_run_at,
    last_run_at: reminder.last_run_at,
    run_count: reminder.run_count,
    status: reminder.status,
    created_at: reminder.created_at
  };
}

function list(agentId, limit = 50) {
  return db.all(
    'SELECT * FROM agent_reminders WHERE agent_id = ? ORDER BY id DESC LIMIT ?',
    [agentId, Math.max(1, Math.min(100, Number(limit) || 50))]
  ).map(serialize);
}

function pendingCount(agentId) {
  const row = db.get(
    "SELECT COUNT(*) AS count FROM agent_reminders WHERE agent_id = ? AND status = 'pending'",
    [agentId]
  );
  return Number(row?.count || 0);
}

function create(agentId, input = {}, now = new Date()) {
  const message = truncate(String(input.message || '').trim(), 2000);
  if (!message) throw new Error('message 不能为空');
  if (pendingCount(agentId) >= MAX_PENDING) throw new Error(`待提醒数量已达上限 ${MAX_PENDING}，请先取消一些`);
  const title = truncate(String(input.title || '').trim(), 60);
  const plan = computeFirstRun({ ...input, when: input.when, every_minutes: input.every_minutes, daily_at: input.daily_at }, now);
  const stamp = nowIso();
  const result = db.run(
    `INSERT INTO agent_reminders
      (agent_id, title, message, kind, schedule_json, next_run_at, run_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
    [agentId, title, message, plan.kind, JSON.stringify(plan.schedule), plan.nextRunAt, stamp, stamp]
  );
  const reminder = db.get('SELECT * FROM agent_reminders WHERE id = ?', [Number(result.lastInsertRowid)]);
  addEvent(agentId, 'reminder_created', `设置${plan.kind === 'once' ? '一次性' : '长期'}提醒：${truncate(message, 200)}`, {
    reminder_id: reminder.id,
    next_run_at: plan.nextRunAt
  });
  return serialize(reminder);
}

function cancel(agentId, id) {
  const result = db.run(
    "UPDATE agent_reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND agent_id = ? AND status = 'pending'",
    [nowIso(), Number(id), agentId]
  );
  if (!Number(result.changes || 0)) throw new Error('未找到可取消的提醒');
  return true;
}

function dueReminders(now = new Date()) {
  return db.all(
    "SELECT * FROM agent_reminders WHERE status = 'pending' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50",
    [now.toISOString()]
  );
}

function inject(reminder, nowIsoValue) {
  const agent = db.get('SELECT id, mode FROM agents WHERE id = ?', [reminder.agent_id]);
  if (!agent || agent.mode !== 'companion') return false;
  const runNo = Number(reminder.run_count || 0) + 1;
  const bridgeId = `reminder:${reminder.id}:${runNo}`;
  const exists = db.get(
    'SELECT id FROM companion_messages WHERE agent_id = ? AND bridge_msg_id = ?',
    [reminder.agent_id, bridgeId]
  );
  if (exists) return false;
  const heading = reminder.title ? `${reminder.title}：` : '';
  const content = `[定时提醒] ${heading}${reminder.message}`;
  db.run(
    `INSERT INTO companion_messages
      (agent_id, bridge_msg_id, conversation_id, conversation_kind, conversation_name,
       sender_uin, sender_name, direction, content, segments_json, needs_reply, created_at)
     VALUES (?, ?, '__reminder__', 'system', '平台定时提醒', '', '平台定时提醒', 'in', ?, ?, 1, ?)`,
    [
      reminder.agent_id,
      bridgeId,
      truncate(content, 20000),
      JSON.stringify([{ type: 'reminder', reminder_id: reminder.id, kind: reminder.kind, title: reminder.title || '' }]),
      nowIsoValue
    ]
  );
  addEvent(reminder.agent_id, 'reminder_fired', `定时提醒已触发：${truncate(reminder.message, 200)}`, {
    reminder_id: reminder.id,
    bridge_msg_id: bridgeId
  });
  return true;
}

function advance(reminder, now, stamp) {
  let nextRunAt = null;
  try {
    let schedule = {};
    try {
      schedule = JSON.parse(reminder.schedule_json || '{}');
    } catch {
      schedule = {};
    }
    if (reminder.kind === 'recurring' && schedule.every_minutes) {
      nextRunAt = new Date(now.getTime() + Number(schedule.every_minutes) * 60000).toISOString();
    } else if (reminder.kind === 'recurring' && schedule.daily_at) {
      nextRunAt = nextDailyAt(schedule.daily_at, now).toISOString();
    }
  } catch {
    nextRunAt = null;
  }
  if (!nextRunAt) {
    db.run(
      "UPDATE agent_reminders SET status = 'done', last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?",
      [stamp, stamp, reminder.id]
    );
    return;
  }
  db.run(
    `UPDATE agent_reminders
        SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1, updated_at = ?
      WHERE id = ?`,
    [nextRunAt, stamp, stamp, reminder.id]
  );
}

function tick(now = new Date()) {
  const rows = dueReminders(now);
  for (const reminder of rows) {
    const stamp = now.toISOString();
    try {
      inject(reminder, stamp);
    } catch (error) {
      addEvent(reminder.agent_id, 'reminder_error', `定时提醒触发失败：${error.message}`, { reminder_id: reminder.id });
    }
    try {
      advance(reminder, now, stamp);
    } catch (error) {
      addEvent(reminder.agent_id, 'reminder_error', `定时提醒排期失败：${error.message}`, { reminder_id: reminder.id });
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tick();
    } catch (error) {
      console.error('[reminders] tick 失败', error.message);
    }
  }, TICK_MS);
  setTimeout(() => {
    tick();
  }, 2000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  TIME_ZONE,
  nextDailyAt,
  computeFirstRun,
  list,
  create,
  cancel,
  tick,
  start,
  stop
};
