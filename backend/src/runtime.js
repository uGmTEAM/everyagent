const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { ensureDir, nowIso } = require('./util');

const RUNTIME_FILE = path.join(config.dataDir, 'runtime.json');
let state = null;
let heartbeatTimer = null;

function readPrevious() {
  try {
    const raw = fs.readFileSync(RUNTIME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function write() {
  if (!state) return;
  const temp = `${RUNTIME_FILE}.tmp`;
  const body = JSON.stringify(state, null, 2);
  try {
    fs.writeFileSync(temp, body, 'utf8');
    try {
      fs.renameSync(temp, RUNTIME_FILE);
    } catch {
      fs.writeFileSync(RUNTIME_FILE, body, 'utf8');
      try {
        fs.unlinkSync(temp);
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error(`[runtime] 写入运行状态失败：${error.message}`);
  }
}

function init() {
  ensureDir(config.dataDir);
  const previous = readPrevious();
  const now = Date.now();
  const currentUptime = Math.floor(os.uptime());
  const previousUptime = Number(previous?.host_uptime || 0);
  const heartbeatAge = previous?.heartbeat_at
    ? now - Date.parse(previous.heartbeat_at)
    : Number.POSITIVE_INFINITY;

  const wasRunning = Boolean(previous?.running);
  const pending = previous?.recovery_pending || null;
  const hostRebooted = wasRunning
    && previousUptime > 0
    && currentUptime + 5 < previousUptime;
  const longGap = wasRunning
    && (!Number.isFinite(heartbeatAge) || heartbeatAge > config.recoveryHeartbeatGapMs);
  const abnormalExit = wasRunning && !previous?.clean;
  const needsRecovery = Boolean(pending) || abnormalExit;

  let recoveryId = pending?.id || null;
  if (needsRecovery && !recoveryId) {
    recoveryId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const reason = pending?.reason
    || (hostRebooted ? 'host_reboot' : longGap ? 'heartbeat_gap' : 'unexpected_stop');

  state = {
    running: true,
    clean: false,
    run_id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    started_at: nowIso(),
    heartbeat_at: nowIso(),
    host_uptime: currentUptime,
    recovery_pending: recoveryId
      ? {
          id: recoveryId,
          detected_at: pending?.detected_at || nowIso(),
          reason,
          previous_run_id: previous?.run_id || null
        }
      : null
  };
  write();

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!state) return;
    state.heartbeat_at = nowIso();
    state.host_uptime = Math.floor(os.uptime());
    write();
  }, 10 * 1000);
  heartbeatTimer.unref();

  if (wasRunning && !needsRecovery) {
    console.log('[runtime] 上次为干净停止，跳过恢复补偿。');
  }
  if (needsRecovery) {
    console.log(`[runtime] 主服务非正常退出，触发恢复：${reason}，恢复编号 ${recoveryId}`);
  }

  return {
    previous,
    wasRunning,
    pending,
    hostRebooted,
    longGap,
    heartbeatAge,
    needsRecovery,
    recoveryId,
    reason,
    currentUptime,
    previousUptime
  };
}

function completeRecovery() {
  if (!state) return;
  state.recovery_pending = null;
  state.heartbeat_at = nowIso();
  write();
}

function markCleanShutdown() {
  if (!state) return;
  state.running = false;
  state.clean = true;
  state.stopped_at = nowIso();
  state.heartbeat_at = nowIso();
  state.host_uptime = Math.floor(os.uptime());
  write();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function getState() {
  return state;
}

module.exports = {
  RUNTIME_FILE,
  init,
  completeRecovery,
  markCleanShutdown,
  getState
};
