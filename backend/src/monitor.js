const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const { addEvent, notifyAgent } = require('./events');
const inbox = require('./inbox');
const { nowIso, formatBytes, dirSize } = require('./util');

let timer = null;
let running = false;
let lastDeepScan = 0;
let cachedSharedSize = 0;
let cachedAgentSizes = new Map();

function shouldEmit(key, intervalMs) {
  const last = Number(db.getSetting(key, '0'));
  if (Date.now() - last < intervalMs) return false;
  db.setSetting(key, String(Date.now()));
  return true;
}

function diskFreeStats() {
  try {
    const stat = fs.statfsSync(config.root);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return {
      total,
      free,
      freePercent: total > 0 ? free / total : 1
    };
  } catch {
    return { total: 0, free: 0, freePercent: 1 };
  }
}

async function deepScan() {
  if (Date.now() - lastDeepScan < 5 * 60 * 1000) return;
  lastDeepScan = Date.now();
  cachedSharedSize = await dirSize(config.tmpWorkspaceDir).catch(() => 0);
  const list = db.all("SELECT id, container_id FROM agents WHERE status != 'dead'");
  const containerSizes = await docker.getContainerSizes().catch(() => new Map());
  const sizes = new Map();
  for (const agent of list) {
    const workspaceSize = await dirSize(
      path.join(config.workspacesDir, agent.id, 'workspace')
    ).catch(() => 0);
    const layerSize = agent.container_id ? Number(containerSizes.get(agent.container_id) || 0) : 0;
    sizes.set(agent.id, workspaceSize + layerSize);
  }
  cachedAgentSizes = sizes;
}

async function pauseAgent(agent, reason) {
  if (!agent.container_id) return;
  try {
    await docker.pauseContainer(agent.container_id);
  } catch {
    return;
  }
  db.run("UPDATE agents SET status = 'paused_disk' WHERE id = ? AND status != 'dead'", [agent.id]);
  addEvent(agent.id, 'disk_pause', `磁盘使用达到阈值，容器已暂停：${reason}`);
  inbox.addImportant(agent.id, 'AI 因磁盘暂停', `${agent.id} 的容器已被平台暂停（原因：${reason}）。清理空间后可在面板恢复。`);
  notifyAgent(agent.id, `磁盘使用达到阈值，你的容器已被平台暂停。清理空间后等待管理员恢复。原因：${reason}`);
}

async function check() {
  if (running) return;
  running = true;
  try {
    await deepScan();
    const drive = diskFreeStats();
    const driveUsedPercent = drive.total ? 1 - drive.freePercent : 0;
    const sharedPercent = config.sharedDiskLimitBytes
      ? cachedSharedSize / config.sharedDiskLimitBytes
      : 0;

    const warnings = [];
    if (drive.total && drive.freePercent <= config.diskFreeWarnPct) {
      warnings.push(
        `G 盘剩余 ${formatBytes(drive.free)}（${(drive.freePercent * 100).toFixed(1)}%），低于 ${(config.diskFreeWarnPct * 100).toFixed(0)}% 警戒线。`
      );
    }
    if (sharedPercent >= config.diskWarnPct) {
      warnings.push(
        `临时工作区占用 ${formatBytes(cachedSharedSize)}，达到上限的 ${(sharedPercent * 100).toFixed(1)}%。`
      );
    }
    for (const [agentId, size] of cachedAgentSizes.entries()) {
      const percent = size / config.agentDiskLimitBytes;
      if (percent >= config.diskWarnPct) {
        warnings.push(`${agentId} 工作区占用 ${formatBytes(size)}，达到上限的 ${(percent * 100).toFixed(1)}%。`);
      }
    }

    // 磁盘警告只告知管理员（事件 + 后台信息），每天最多一次，不发送给 AI
    if (warnings.length && shouldEmit('disk_warn_at', 24 * 60 * 60 * 1000)) {
      addEvent(null, 'disk_warning', warnings.join(' '));
      inbox.addImportant(null, '磁盘空间警告', warnings.join(' '));
    }

    const critical =
      (drive.total && driveUsedPercent >= config.diskPausePct) ||
      sharedPercent >= config.diskPausePct;
    const criticalAgents = [];
    for (const [agentId, size] of cachedAgentSizes.entries()) {
      if (size / config.agentDiskLimitBytes >= config.diskPausePct) {
        criticalAgents.push(agentId);
      }
    }

    if (critical || criticalAgents.length) {
      if (shouldEmit('disk_pause_at', 10 * 60 * 1000)) {
        if (critical) {
          const agents = db.all("SELECT * FROM agents WHERE status = 'running'");
          for (const agent of agents) {
            await pauseAgent(agent, '全局磁盘空间不足');
          }
        } else {
          for (const agentId of criticalAgents) {
            const agent = db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
            if (agent && agent.status === 'running') {
              await pauseAgent(agent, '工作区超过软上限');
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('[monitor] 检查失败', error.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    check();
  }, 60 * 1000);
  setTimeout(() => {
    check();
  }, 5000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  check
};
