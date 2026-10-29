const db = require('./db');
const config = require('./config');
const runtime = require('./runtime');
const billing = require('./billing');
const agents = require('./agents');
const docker = require('./docker');
const { addEvent } = require('./events');
const inbox = require('./inbox');
const { nowIso } = require('./util');

const LIVING_STATUSES = ['created', 'running', 'paused_disk'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDocker() {
  const deadline = Date.now() + config.recoveryDockerWaitMs;
  while (Date.now() < deadline) {
    try {
      if (await docker.isAvailable()) return true;
    } catch {
      // ignore
    }
    await sleep(config.recoveryRetryIntervalMs);
  }
  return false;
}

async function run(startup) {
  if (!startup?.needsRecovery || !startup.recoveryId) {
    return;
  }

  const recoveryId = startup.recoveryId;
  console.log(`[recovery] 开始恢复 ${recoveryId}，原因 ${startup.reason}`);
  db.run(
    'INSERT OR IGNORE INTO recovery_runs (id, detected_at, reason) VALUES (?, ?, ?)',
    [recoveryId, nowIso(), startup.reason || 'unexpected_stop']
  );

  const living = db.all(
    `SELECT * FROM agents WHERE status IN (${LIVING_STATUSES.map(() => '?').join(',')}) ORDER BY seq`,
    LIVING_STATUSES
  );

  console.log(`[recovery] 存活 AI ${living.length} 个`);

  for (const agent of living) {
    const inserted = db.run(
      `INSERT OR IGNORE INTO recovery_compensations
        (recovery_id, agent_id, amount, created_at)
       VALUES (?, ?, ?, ?)`,
      [recoveryId, agent.id, config.recoveryCompensation, nowIso()]
    );
    if (!inserted.changes) continue;

    try {
      billing.recharge(agent.id, config.recoveryCompensation, 'service_recovery');
      const amount = config.recoveryCompensation.toLocaleString('en-US');
      addEvent(
        agent.id,
        'recovery_compensation',
        agent.unlimited_tokens
          ? `主服务非正常退出恢复：补偿 ${amount} tokens（该 AI 为无限额度，余额不变）。`
          : `主服务非正常退出恢复：补偿 ${amount} tokens。`,
        { recovery_id: recoveryId, reason: startup.reason }
      );
      console.log(`[recovery] ${agent.id} 补偿 ${amount} tokens`);
    } catch (error) {
      console.error(`[recovery] ${agent.id} 补偿失败：${error.message}`);
      addEvent(agent.id, 'recovery_compensation_error', `恢复补偿失败：${error.message}`, {
        recovery_id: recoveryId
      });
    }
  }

  const ready = await waitForDocker();
  if (!ready) {
    console.error('[recovery] Docker 未在等待时间内就绪，保留恢复标记，下次启动继续。');
    inbox.addImportant(null, '异常恢复未完成', `恢复 ${recoveryId} 时 Docker 未就绪，恢复标记已保留，下次启动会继续。`);
    return;
  }

  let egressReady = false;
  let egressError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await docker.ensureEgress();
      egressReady = true;
      break;
    } catch (error) {
      egressError = error;
      await sleep(2000);
    }
  }
  if (!egressReady) {
    console.error(`[recovery] 出网代理未就绪，保留恢复标记：${egressError?.message || '未知错误'}`);
    inbox.addImportant(null, '异常恢复未完成', `恢复 ${recoveryId} 时出网代理未就绪：${egressError?.message || '未知错误'}。恢复标记已保留。`);
    return;
  }

  for (const agent of living) {
    const current = agents.getAgent(agent.id);
    if (!current || !LIVING_STATUSES.includes(current.status)) continue;
    try {
      await docker.ensureAgentNetwork(current.seq);
      if (current.allow_internet) {
        await docker.ensureOutboundNetwork(current.seq);
      }
      await agents.startAgent(agent.id);
      console.log(`[recovery] ${agent.id} 已自动启动`);
    } catch (error) {
      console.error(`[recovery] ${agent.id} 自动启动失败：${error.message}`);
      addEvent(agent.id, 'recovery_start_error', `恢复时自动启动失败：${error.message}`, {
        recovery_id: recoveryId
      });
    }
  }

  db.run('UPDATE recovery_runs SET completed_at = ? WHERE id = ?', [nowIso(), recoveryId]);
  runtime.completeRecovery();
  inbox.addImportant(
    null,
    '异常恢复完成',
    `恢复 ${recoveryId}（原因：${startup.reason}）完成，共处理存活 AI ${living.length} 个。`
  );
  console.log(`[recovery] 恢复完成 ${recoveryId}`);
}

module.exports = {
  LIVING_STATUSES,
  run
};
