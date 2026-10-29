const db = require('./db');
const config = require('./config');
const { addEvent } = require('./events');
const { nowIso, textSimilarity } = require('./util');

let refillLock = false;

const ALIVE_STATUSES = ['created', 'running', 'paused_disk', 'dying'];

function aliveAgents() {
  const placeholders = ALIVE_STATUSES.map(() => '?').join(',');
  return db.all(`SELECT * FROM agents WHERE status IN (${placeholders}) ORDER BY seq`, ALIVE_STATUSES);
}

function allAgents() {
  return db.all('SELECT * FROM agents ORDER BY seq');
}

function addTasks(taskList, source = 'judge', { targetAgentId = null } = {}) {
  if (!Array.isArray(taskList) || !taskList.length) return [];
  const createdAt = nowIso();
  const target = targetAgentId ? String(targetAgentId) : null;
  const created = [];
  const assigned = new Set();

  db.transaction(() => {
    const maxRow = db.get('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM tasks');
    let seq = Number(maxRow?.max_seq || 0);
    const insertTask = db.getDb().prepare(
      'INSERT INTO tasks (seq, title, description, acceptance, source, target_agent_id, long_term, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
    );
    for (const task of taskList) {
      seq += 1;
      const longTerm = Number(task.long_term) ? 1 : 0;
      const result = insertTask.run(
        seq,
        String(task.title || '').trim(),
        String(task.description || '').trim(),
        String(task.acceptance || '').trim(),
        source,
        target,
        longTerm,
        createdAt
      );
      created.push({
        id: Number(result.lastInsertRowid),
        seq,
        title: task.title,
        description: task.description,
        acceptance: task.acceptance,
        source,
        target_agent_id: target,
        long_term: longTerm
      });
    }

    const agents = db.all("SELECT id, manual_tasks FROM agents WHERE status != 'dead'");
    const insertAgentTask = db.getDb().prepare(
      'INSERT OR IGNORE INTO agent_tasks (agent_id, task_id, status, attempts, assigned_at) VALUES (?, ?, ?, 0, ?)'
    );
    for (const agent of agents) {
      if (source === 'judge' && Number(agent.manual_tasks)) continue;
      for (const task of created) {
        if (task.target_agent_id && task.target_agent_id !== agent.id) continue;
        const result = insertAgentTask.run(agent.id, task.id, 'pending', createdAt);
        if (result.changes) assigned.add(agent.id);
      }
    }
  });

  for (const agentId of assigned) {
    db.run('UPDATE agents SET wake_requested = 1 WHERE id = ?', [agentId]);
  }

  for (const agent of db.all("SELECT id FROM agents WHERE status != 'dead'")) {
    refreshCurrentTask(agent.id);
  }

  addEvent(null, 'tasks_added', `新增 ${created.length} 个任务（来源：${source}${target ? `，指定 ${target}` : ''}）。`, {
    tasks: created.map((t) => ({ id: t.id, seq: t.seq, title: t.title, target: t.target_agent_id }))
  });
  return created;
}

function ensureAgentTaskRows(agentId) {
  const agent = db.get('SELECT manual_tasks FROM agents WHERE id = ?', [agentId]);
  const conditions = ['active = 1', '(target_agent_id IS NULL OR target_agent_id = ?)'];
  const params = [agentId];
  if (agent && Number(agent.manual_tasks)) conditions.push("source != 'judge'");
  const tasks = db.all(`SELECT id FROM tasks WHERE ${conditions.join(' AND ')}`, params);
  const now = nowIso();
  const insert = db.getDb().prepare(
    'INSERT OR IGNORE INTO agent_tasks (agent_id, task_id, status, attempts, assigned_at) VALUES (?, ?, ?, 0, ?)'
  );
  for (const task of tasks) {
    insert.run(agentId, task.id, 'pending', now);
  }
  refreshCurrentTask(agentId);
}

function getCurrentTask(agentId) {
  return db.get(
    `SELECT t.*, at.completions
       FROM tasks t
       JOIN agent_tasks at ON at.task_id = t.id
      WHERE at.agent_id = ? AND at.status = 'pending' AND t.active = 1
        AND (t.target_agent_id IS NULL OR t.target_agent_id = ?)
      ORDER BY CASE WHEN at.completed_at IS NULL THEN 0 ELSE 1 END, at.completed_at ASC, t.seq ASC
      LIMIT 1`,
    [agentId, agentId]
  );
}

function refreshCurrentTask(agentId) {
  const task = getCurrentTask(agentId);
  db.run('UPDATE agents SET current_task_id = ? WHERE id = ?', [task ? task.id : null, agentId]);
  return task;
}

function remainingCount(agentId) {
  const row = db.get(
    `SELECT COUNT(*) AS n
       FROM tasks t
       JOIN agent_tasks at ON at.task_id = t.id
      WHERE at.agent_id = ? AND at.status = 'pending' AND t.active = 1
        AND (t.target_agent_id IS NULL OR t.target_agent_id = ?)`,
    [agentId, agentId]
  );
  return Number(row?.n || 0);
}

function minRemainingAmongAlive() {
  const agents = aliveAgents().filter((agent) => !Number(agent.manual_tasks));
  if (!agents.length) return null;
  let min = Infinity;
  for (const agent of agents) {
    min = Math.min(min, remainingCount(agent.id));
  }
  return min;
}

async function maybeRefillTasks({ initial = false } = {}) {
  if (refillLock) return null;
  refillLock = true;
  try {
    const taskCount = Number(db.get('SELECT COUNT(*) AS n FROM tasks WHERE active = 1')?.n || 0);
    const agents = aliveAgents().filter((agent) => !Number(agent.manual_tasks));
    const min = agents.length ? minRemainingAmongAlive() : null;

    const needInitial = taskCount === 0 && initial && agents.length > 0;
    const needRefill = agents.length > 0 && min !== null && min < config.taskRefillThreshold;
    if (!needInitial && !needRefill) return null;

    const judge = require('./judge');
    const tasks = await judge.generateTasks(config.taskBatchSize);
    if (!tasks.length) return null;
    const created = addTasks(tasks, 'judge');
    return created;
  } catch (error) {
    addEvent(null, 'judge_error', `任务生成失败：${error.message}`);
    return null;
  } finally {
    refillLock = false;
  }
}

function markTaskPassed(agentId, taskId) {
  const completedAt = nowIso();
  const task = db.get('SELECT long_term FROM tasks WHERE id = ?', [taskId]);
  if (task && Number(task.long_term)) {
    db.run(
      `UPDATE agent_tasks
          SET completions = completions + 1, completed_at = ?
        WHERE agent_id = ? AND task_id = ?`,
      [completedAt, agentId, taskId]
    );
    return refreshCurrentTask(agentId);
  }
  db.run(
    "UPDATE agent_tasks SET status = 'passed', completed_at = ? WHERE agent_id = ? AND task_id = ?",
    [completedAt, agentId, taskId]
  );
  return refreshCurrentTask(agentId);
}

function incrementAttempts(agentId, taskId) {
  db.run(
    'UPDATE agent_tasks SET attempts = attempts + 1 WHERE agent_id = ? AND task_id = ?',
    [agentId, taskId]
  );
}

function priorSubmissions(agentId, taskId, limit = 5) {
  return db.all(
    'SELECT * FROM submissions WHERE agent_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?',
    [agentId, taskId, limit]
  );
}

// 只把「被判不合格」的提交视为重复基准：通过过的内容（如长期任务）可以再次提交。
function failedSubmissions(agentId, taskId, limit = 20) {
  return db.all(
    `SELECT id, task_id, content, fingerprint, feedback, state, created_at
       FROM submissions
      WHERE agent_id = ? AND task_id = ? AND state IN ('failed', 'rejected_duplicate')
      ORDER BY id DESC LIMIT ?`,
    [agentId, taskId, limit]
  );
}

// 重复提交检测：完全重复直接拦截，高度相似和跨任务重复交给 Judge 判定。
function detectDuplicate(agentId, taskId, { fingerprint, content }) {
  const prior = failedSubmissions(agentId, taskId);
  const exact = prior.find((item) => item.fingerprint && item.fingerprint === fingerprint) || null;

  let similar = null;
  if (!exact) {
    for (const item of prior.slice(0, 5)) {
      const score = textSimilarity(content, item.content, { size: 6, sample: 800 });
      if (score >= 0.9 && (!similar || score > similar.score)) {
        similar = { submission_id: item.id, score };
      }
    }
  }

  let crossTask = null;
  if (!exact) {
    crossTask = db.get(
      `SELECT s.id AS submission_id, s.task_id, t.seq AS task_seq, t.title AS task_title
         FROM submissions s LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.agent_id = ? AND s.task_id != ? AND s.fingerprint = ? AND s.state = 'failed'
        ORDER BY s.id DESC LIMIT 1`,
      [agentId, taskId, fingerprint]
    ) || null;
  }

  return { exact, similar, crossTask };
}

function listTasks() {
  return db.all('SELECT * FROM tasks ORDER BY seq ASC');
}

function taskProgress(agentId) {
  return db.all(
    `SELECT t.*, at.status AS agent_status, at.attempts, at.completions,
            at.assigned_at, at.completed_at
       FROM tasks t
       JOIN agent_tasks at ON at.task_id = t.id
      WHERE at.agent_id = ? AND t.active = 1
      ORDER BY t.seq ASC`,
    [agentId]
  );
}

function adminAddTask({ title, description, acceptance, targetAgentId = null, longTerm = false }) {
  const created = addTasks(
    [{ title, description, acceptance, long_term: longTerm ? 1 : 0 }],
    'admin',
    { targetAgentId }
  );
  return created[0] || null;
}

function adminUpdateTask(taskId, { title, description, acceptance }) {
  db.run(
    'UPDATE tasks SET title = ?, description = ?, acceptance = ? WHERE id = ?',
    [title, description, acceptance, taskId]
  );
  return db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
}

function adminDeleteTask(taskId) {
  db.run('UPDATE tasks SET active = 0 WHERE id = ?', [taskId]);
  for (const agent of db.all("SELECT id FROM agents WHERE status != 'dead'")) {
    refreshCurrentTask(agent.id);
  }
  addEvent(null, 'task_deleted', `任务 #${taskId} 已停用。`);
}

function pendingSubmissions(agentId) {
  return db.all(
    "SELECT * FROM submissions WHERE agent_id = ? AND state = 'pending' ORDER BY id ASC",
    [agentId]
  );
}

module.exports = {
  ALIVE_STATUSES,
  aliveAgents,
  allAgents,
  addTasks,
  ensureAgentTaskRows,
  getCurrentTask,
  refreshCurrentTask,
  remainingCount,
  minRemainingAmongAlive,
  maybeRefillTasks,
  markTaskPassed,
  incrementAttempts,
  priorSubmissions,
  failedSubmissions,
  detectDuplicate,
  listTasks,
  taskProgress,
  adminAddTask,
  adminUpdateTask,
  adminDeleteTask,
  pendingSubmissions
};
