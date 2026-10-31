import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.mjs';

const EXIT_SWITCH_ACCOUNT = 75;
const EXIT_NO_ACCOUNT = 76;

function statePath (config) {
  return path.join(config._dataDir, 'account-state.json');
}

export function loadAccountState (config) {
  const state = readJson(statePath(config), {});
  return {
    index: Number.isInteger(state.index) ? state.index : 0,
    uin: String(state.uin || ''),
    pendingSwitch: !!state.pendingSwitch,
    reason: String(state.reason || ''),
    updatedAt: Number(state.updatedAt || 0)
  };
}

export function saveAccountState (config, state) {
  writeJsonAtomic(statePath(config), { ...state, updatedAt: Date.now() });
}

export function resolveActiveAccount (config) {
  const state = loadAccountState(config);
  const accounts = config.accounts || [];
  if (accounts.length > 0) {
    const index = Math.min(Math.max(state.index, 0), accounts.length - 1);
    const account = accounts[index];
    return {
      index,
      uin: String(config.qq.account || account.uin || ''),
      dataDir: account.dataDir || '',
      note: account.note || '',
      total: accounts.length,
      state
    };
  }
  return {
    index: 0,
    uin: String(config.qq.account || ''),
    dataDir: '',
    note: '',
    total: 0,
    state
  };
}

export function markAccountOnline (config, uin) {
  const state = loadAccountState(config);
  saveAccountState(config, { ...state, uin: String(uin || ''), pendingSwitch: false, reason: '' });
}

/**
 * 被踢 / 意外退登时调用。
 * 有备用账号：写入下一个账号索引并以 75 退出，由容器入口脚本重新拉起。
 * 无备用账号：以 76 退出，由容器策略决定是否重启；期间 API 保持离线。
 */
export function switchAccount (config, logger, reason) {
  const accounts = config.accounts || [];
  const state = loadAccountState(config);
  if (!config.qq.switchOnKick) {
    logger?.warn(`[account] 已关闭自动切换，保持离线（${reason}）`);
    return false;
  }
  if (accounts.length <= 1) {
    logger?.warn(`[account] 没有备用账号可切换（${reason}）`);
    return false;
  }
  const next = (state.index + 1) % accounts.length;
  saveAccountState(config, { ...state, index: next, pendingSwitch: true, reason });
  logger?.warn(`[account] 触发账号切换：${accounts[state.index]?.uin || '-'} -> ${accounts[next]?.uin}，进程退出码 ${EXIT_SWITCH_ACCOUNT}`);
  setTimeout(() => process.exit(EXIT_SWITCH_ACCOUNT), 200);
  return true;
}

export { EXIT_SWITCH_ACCOUNT, EXIT_NO_ACCOUNT };
