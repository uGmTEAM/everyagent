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

// WSL/QQ 崩溃时会在宿主写出 GB 级 .dmp（默认目录已用目录联接指向 G 盘，
// 不占 C 盘）。这里每分钟清理一次：超过 60 秒的转储直接删，总量超过
// 128MB 时从最旧的开始删，相当于崩溃转储不留存。
function cleanupCrashDumps() {
  const dir = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'wsl-crashes');
  if (!process.env.LOCALAPPDATA || !fs.existsSync(dir)) return 0;
  let removed = 0;
  const maxAgeMs = 60 * 1000;
  const maxTotalBytes = 128 * 1024 * 1024;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.dmp'))
      .map((name) => {
        const fullPath = path.join(dir, name);
        return { fullPath, stat: fs.statSync(fullPath) };
      });
    const now = Date.now();
    for (const file of files) {
      if (now - file.stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file.fullPath);
        file.stat.removed = true;
        removed += file.stat.size;
      }
    }
    let total = files
      .filter((file) => !file.stat.removed)
      .reduce((sum, file) => sum + file.stat.size, 0);
    const oldFirst = files
      .filter((file) => !file.stat.removed)
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    for (const file of oldFirst) {
      if (total <= maxTotalBytes) break;
      fs.unlinkSync(file.fullPath);
      total -= file.stat.size;
      removed += file.stat.size;
    }
    if (removed > 0) {
      console.log(`[monitor] 已清理 WSL 崩溃转储，释放 ${formatBytes(removed)}`);
    }
  } catch (error) {
    console.error('[monitor] 清理崩溃转储失败', error.message);
  }
  return removed;
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
    cleanupCrashDumps();
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
  check,
  cleanupCrashDumps
};
