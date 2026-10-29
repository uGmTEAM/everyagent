const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const { addEvent } = require('./events');
const inbox = require('./inbox');
const { nowIso, formatBytes, sleep, dirSize } = require('./util');

const finalizing = new Set();

function deathZipPath(agentId) {
  return path.join(config.deathDir, `${agentId}.death.zip`);
}

function buildDbDump(agentId) {
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
  const agentTasks = db.all(
    `SELECT at.*, t.seq, t.title, t.description, t.acceptance
       FROM agent_tasks at JOIN tasks t ON t.id = at.task_id
      WHERE at.agent_id = ? ORDER BY t.seq`,
    [agentId]
  );
  const submissions = db.all('SELECT * FROM submissions WHERE agent_id = ? ORDER BY id', [agentId]);
  const requests = db.all('SELECT * FROM requests WHERE agent_id = ? ORDER BY id', [agentId]);
  const events = db.all('SELECT * FROM events WHERE agent_id = ? ORDER BY id', [agentId]);
  const oracleCalls = db.all('SELECT * FROM oracle_calls WHERE agent_id = ? ORDER BY id', [agentId]);
  return {
    exported_at: nowIso(),
    agent,
    agent_tasks: agentTasks,
    submissions,
    requests,
    events,
    oracle_calls: oracleCalls
  };
}

async function zipAgent(agent, reason) {
  const workspace = path.join(config.workspacesDir, agent.id, 'workspace');
  const zipPath = deathZipPath(agent.id);
  fs.mkdirSync(config.deathDir, { recursive: true });

  const dump = buildDbDump(agent.id);
  const workspaceSize = await dirSize(workspace).catch(() => 0);
  const meta = {
    agent_id: agent.id,
    seq: agent.seq,
    reason,
    balance: agent.balance,
    initial_balance: agent.initial_balance,
    model: agent.model,
    goal: agent.goal,
    rules: agent.rules,
    created_at: agent.created_at,
    died_at: nowIso(),
    workspace_size: workspaceSize,
    workspace_size_text: formatBytes(workspaceSize)
  };

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(workspace)) {
      archive.directory(workspace, 'workspace');
    }
    archive.append(JSON.stringify(dump, null, 2), { name: 'db/agent.json' });
    archive.append(JSON.stringify(meta, null, 2), { name: 'meta.json' });
    archive.finalize();
  });

  return { zipPath, size: fs.statSync(zipPath).size, meta };
}

async function finalizeAgent(agentId, reason = 'quota') {
  if (finalizing.has(agentId)) return null;
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent || agent.status === 'dead') return null;

  finalizing.add(agentId);
  try {
    db.run("UPDATE agents SET status = 'finalizing' WHERE id = ?", [agentId]);
    addEvent(agentId, 'finalizing', `开始死亡流程（原因：${reason}）。`);

    if (agent.container_id) {
      await docker.stopContainer(agent.container_id, 10).catch(() => {});
      await docker.removeContainer(agent.container_id, true).catch(() => {});
    }

    let zipResult = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        zipResult = await zipAgent(agent, reason);
        break;
      } catch (error) {
        lastError = error;
        addEvent(agentId, 'death_error', `打包失败（第 ${attempt} 次）：${error.message}`);
        await sleep(2000);
      }
    }

    const diedAt = nowIso();
    db.transaction(() => {
      db.run(
        "UPDATE agents SET status = 'dead', died_at = ?, death_reason = ?, container_id = NULL WHERE id = ?",
        [diedAt, reason, agentId]
      );
      db.run(
        'INSERT INTO deaths (agent_id, reason, balance, zip_path, created_at) VALUES (?, ?, ?, ?, ?)',
        [agentId, reason, Number(agent.balance || 0), zipResult?.zipPath || null, diedAt]
      );
    });

    addEvent(
      agentId,
      'dead',
      zipResult
        ? `AI 已死亡，归档 ${path.basename(zipResult.zipPath)}（${formatBytes(zipResult.size)}）。`
        : `AI 已死亡，但归档失败：${lastError?.message || '未知错误'}`
    );
    inbox.addImportant(
      agentId,
      'AI 死亡',
      `${
        zipResult
          ? `AI 已死亡（原因：${reason}），归档 ${path.basename(zipResult.zipPath)}（${formatBytes(zipResult.size)}）。`
          : `AI 已死亡（原因：${reason}），但归档失败：${lastError?.message || '未知错误'}`
      }`
    );

    await docker.removeAgentNetwork(agent.seq).catch(() => {});
    return zipResult;
  } finally {
    finalizing.delete(agentId);
  }
}

async function retryPendingFinalizations() {
  const rows = db.all("SELECT id FROM agents WHERE status = 'finalizing'");
  for (const row of rows) {
    const agent = db.get('SELECT * FROM agents WHERE id = ?', [row.id]);
    await finalizeAgent(agent.id, agent.death_reason || 'quota');
  }
}

function listDeaths() {
  return db.all(
    `SELECT d.*, a.goal, a.model, a.seq, a.died_at
       FROM deaths d LEFT JOIN agents a ON a.id = d.agent_id
      ORDER BY d.id DESC`
  );
}

function getDeathFile(agentId) {
  const zipPath = deathZipPath(agentId);
  if (!fs.existsSync(zipPath)) return null;
  return zipPath;
}

module.exports = {
  finalizeAgent,
  retryPendingFinalizations,
  listDeaths,
  getDeathFile,
  deathZipPath,
  zipAgent
};
