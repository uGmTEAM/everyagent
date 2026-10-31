const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const agents = require('./agents');
const billing = require('./billing');
const tasks = require('./tasks');
const death = require('./death');
const { addEvent, emitLog } = require('./events');
const { nowIso, formatDate } = require('./util');

const logStreams = new Map();
const reattachTimers = new Map();
let timer = null;
let ticking = false;

function logFile(agentId) {
  return path.join(config.logsDir, `${agentId}.log`);
}

function appendLog(agentId, line) {
  try {
    fs.appendFileSync(logFile(agentId), `[${formatDate(nowIso())}] ${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function attachLogs(agentId, info = null) {
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent || !agent.container_id || agent.status === 'dead') return;
  const startedAt = info?.State?.StartedAt || null;
  const existing = logStreams.get(agentId);
  if (
    existing
    && existing.containerId === agent.container_id
    && (!startedAt || !existing.startedAt || existing.startedAt === startedAt)
  ) {
    return;
  }

  if (existing?.stop) {
    try {
      existing.stop();
    } catch {
      // ignore
    }
  }

  const stop = docker.streamLogs(agent, (line, stream, meta = {}) => {
    if (meta.closed) {
      logStreams.delete(agentId);
      scheduleReattach(agentId);
      return;
    }
    if (!line) return;
    appendLog(agentId, line);
    emitLog(agentId, stream, line);
  });

  logStreams.set(agentId, { containerId: agent.container_id, startedAt, stop });
}

function scheduleReattach(agentId) {
  if (reattachTimers.has(agentId)) return;
  const handle = setTimeout(async () => {
    reattachTimers.delete(agentId);
    const agent = db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.status === 'dead' || agent.status === 'finalizing') return;
    const info = await docker.inspectContainer(agent.container_id).catch(() => null);
    if (info?.State?.Running) attachLogs(agentId, info);
  }, 2000);
  reattachTimers.set(agentId, handle);
}

async function handleCrash(agent) {
  if (agent.status === 'dead' || agent.status === 'finalizing') return;
  const current = db.get('SELECT * FROM agents WHERE id = ?', [agent.id]);
  if (!current || current.status === 'dead' || current.status === 'finalizing') return;

  const attempts = Number(current.crash_attempts || 0) + 1;
  db.run('UPDATE agents SET crash_attempts = ? WHERE id = ?', [attempts, agent.id]);
  addEvent(agent.id, 'crash', `检测到容器退出，第 ${attempts} 次尝试重启。`, { attempts });

  const limit = agents.effectiveCrashLimit(current);
  if (limit !== null && attempts > limit) {
    addEvent(agent.id, 'crash_death', `连续 ${limit} 次重启失败，判定死亡。`);
    await death.finalizeAgent(agent.id, 'crash').catch((error) => {
      addEvent(agent.id, 'death_error', `崩溃死亡处理失败：${error.message}`);
    });
    return;
  }
  if (limit === null) {
    addEvent(agent.id, 'crash_retry', `该 AI 配置为无限崩溃重启，继续尝试。`, { attempts });
  }

  try {
    await agents.startAgent(agent.id);
  } catch (error) {
    addEvent(agent.id, 'restart_error', `重启失败：${error.message}`);
  }
}

async function finalizeDyingIfNeeded(agent) {
  if (agent.status !== 'dying') return;
  if (agent.unlimited_tokens) {
    billing.cancelDying(agent.id, 'unlimited_tokens');
    return;
  }
  const deadline = agent.dying_deadline ? Date.parse(agent.dying_deadline) : 0;
  if (!deadline || Date.now() < deadline) return;

  const fresh = db.get('SELECT * FROM agents WHERE id = ?', [agent.id]);
  if (!fresh || fresh.status !== 'dying') return;
  if (Number(fresh.balance || 0) > 0) {
    billing.cancelDying(agent.id, 'balance_restored');
    return;
  }

  const pending = tasks.pendingSubmissions(agent.id);
  if (pending.length) {
    let stillPending = false;
    for (const submission of pending) {
      const age = Date.now() - Date.parse(submission.created_at);
      if (age > config.judgePendingTimeoutMs) {
        db.run(
          "UPDATE submissions SET state = 'error', passed = 0, feedback = ?, judged_at = ? WHERE id = ?",
          ['Judge 判定超时，未扣款。', nowIso(), submission.id]
        );
        addEvent(agent.id, 'judge_timeout', `提交 #${submission.id} 判定超时。`);
      } else {
        stillPending = true;
      }
    }
    if (stillPending) return;
  }

  await death.finalizeAgent(agent.id, 'quota').catch((error) => {
    addEvent(agent.id, 'death_error', `死亡处理失败：${error.message}`);
  });
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const dockerOk = await docker.isAvailable();
    const list = db.all("SELECT * FROM agents WHERE status IN ('created','running','paused_disk','dying') ORDER BY seq");
    for (const agent of list) {
      if (agent.status === 'paused_disk') continue;

      if (dockerOk) {
        const info = await docker.inspectContainer(agent.container_id).catch(() => null);
        const running = Boolean(info?.State?.Running);

        if (running) {
          attachLogs(agent.id, info);
          if (agent.crash_attempts > 0 && agent.last_start_at) {
            const stableFor = Date.now() - Date.parse(agent.last_start_at);
            if (stableFor >= config.crashStableMs) {
              db.run('UPDATE agents SET crash_attempts = 0 WHERE id = ?', [agent.id]);
              addEvent(agent.id, 'stable', '容器已稳定运行，崩溃计数清零。');
            }
          }
        } else if (agent.status === 'running' || agent.status === 'dying') {
          await handleCrash(agent);
        }
      }

      const fresh = db.get('SELECT * FROM agents WHERE id = ?', [agent.id]);
      if (fresh?.status === 'dying') {
        await finalizeDyingIfNeeded(fresh);
      }
    }
  } catch (error) {
    console.error('[supervisor] tick 失败', error.message);
  } finally {
    ticking = false;
  }
}

async function reconcile() {
  await death.retryPendingFinalizations().catch(() => {});
  if (!(await docker.isAvailable())) return;
  const list = db.all("SELECT * FROM agents WHERE status IN ('running','dying') ORDER BY seq");
  for (const agent of list) {
    const info = await docker.inspectContainer(agent.container_id).catch(() => null);
    if (info?.State?.Running) {
      attachLogs(agent.id);
    } else {
      await handleCrash(agent).catch(() => {});
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick();
  }, 5000);
  setTimeout(() => {
    reconcile();
  }, 1500);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const timerHandle of reattachTimers.values()) clearTimeout(timerHandle);
  reattachTimers.clear();
  for (const item of logStreams.values()) {
    try {
      item.stop?.();
    } catch {
      // ignore
    }
  }
  logStreams.clear();
}

module.exports = {
  start,
  stop,
  tick,
  reconcile,
  attachLogs
};
