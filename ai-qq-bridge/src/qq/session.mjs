import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSessionListener, NodeIDependsAdapter, NodeIDispatcherAdapter, NodeIGlobalAdapter } from './adapters.mjs';
import { ensureDir } from '../util.mjs';

export const PlatformType = {
  KUNKNOWN: 0,
  KANDROID: 1,
  KIOS: 2,
  KWINDOWS: 3,
  KMAC: 4,
  KLINUX: 5
};

export const VendorType = { KNOSETONIOS: 0 };

function platformType () {
  if (process.platform === 'linux') return PlatformType.KLINUX;
  if (process.platform === 'darwin') return PlatformType.KMAC;
  return PlatformType.KWINDOWS;
}

function systemVersion () {
  try {
    return `${os.type()} ${os.release()}`;
  } catch {
    return 'Linux';
  }
}

export function getMachineGuid (dataDir) {
  const file = path.join(dataDir, 'machine-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/i.test(existing)) return existing;
  } catch {
    // fallthrough
  }
  const guid = crypto.randomBytes(16).toString('hex');
  ensureDir(dataDir);
  fs.writeFileSync(file, guid);
  return guid;
}

export function initializeEngine ({ wrapper, info, config, logger }) {
  const engine = wrapper.NodeIQQNTWrapperEngine?.get?.();
  if (!engine) throw new Error('QQ 内核未暴露 NodeIQQNTWrapperEngine');

  let dataPath = '';
  try {
    dataPath = wrapper.NodeQQNTWrapperUtil?.getNTUserDataInfoConfig?.() || '';
  } catch {
    dataPath = '';
  }
  if (!dataPath) dataPath = config.qq.dataDir || path.join(os.homedir(), '.config', 'QQ');
  ensureDir(dataPath);

  const dataPathGlobal = process.platform === 'linux'
    ? path.join(dataPath, 'global')
    : path.join(dataPath, 'nt_qq', 'global');
  ensureDir(dataPathGlobal);

  const cfg = {
    base_path_prefix: '',
    platform_type: platformType(),
    app_type: 4,
    app_version: info.version,
    os_version: systemVersion(),
    use_xlog: false,
    qua: info.qua,
    global_path_config: {
      desktopGlobalPath: dataPathGlobal
    },
    thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
  };
  logger?.info(`[session] engine.init  app_version=${info.version} qua=${info.qua} global=${dataPathGlobal}`);
  engine.initWithDeskTopConfig(cfg, new NodeIGlobalAdapter());

  const loginService = wrapper.NodeIKernelLoginService?.get?.();
  if (!loginService) throw new Error('QQ 内核未暴露 NodeIKernelLoginService');

  loginService.initConfig({
    machineId: '',
    appid: info.appid,
    platVer: systemVersion(),
    commonPath: dataPathGlobal,
    clientVer: info.version,
    hostName: info.hostname,
    externalVersion: false
  });

  return { engine, loginService, dataPath, dataPathGlobal };
}

export function generateSessionConfig ({ info, dataPath, selfInfo, guid }) {
  const downloadPath = path.join(dataPath, 'bridge', 'temp');
  ensureDir(downloadPath);
  return {
    selfUin: String(selfInfo.uin),
    selfUid: String(selfInfo.uid),
    desktopPathConfig: {
      account_path: dataPath
    },
    clientVer: info.version,
    a2: '',
    d2: '',
    d2Key: '',
    machineId: '',
    platform: platformType(),
    platVer: systemVersion(),
    appid: info.appid,
    rdeliveryConfig: {
      appKey: '',
      systemId: 0,
      appId: '',
      logicEnvironment: '',
      platform: platformType(),
      language: '',
      sdkVersion: '',
      userId: '',
      appVersion: '',
      osVersion: '',
      bundleId: '',
      serverUrl: '',
      fixedAfterHitKeys: ['']
    },
    defaultFileDownloadPath: downloadPath,
    deviceInfo: {
      guid,
      buildVer: info.version,
      localId: 2052,
      devName: info.hostname,
      devType: 'Linux',
      vendorName: '',
      osVer: systemVersion(),
      vendorOsName: 'Linux',
      setMute: false,
      vendorType: VendorType.KNOSETONIOS
    },
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}'
  };
}

export async function createSession ({ wrapper, info, dataPath, selfInfo, dataDir, logger, timeoutMs = 20000 }) {
  let session;
  let startupSession = null;
  try {
    startupSession = wrapper.NodeIQQNTStartupSessionWrapper?.create?.();
  } catch {
    startupSession = null;
  }
  try {
    session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession?.('nt_1');
  } catch {
    session = wrapper.NodeIQQNTWrapperSession.create();
  }
  if (!session) throw new Error('创建 QQ Session 失败');

  const guid = getMachineGuid(dataDir);
  const sessionConfig = generateSessionConfig({ info, dataPath, selfInfo, guid });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Session 初始化超时')), timeoutMs);

    const listener = createSessionListener(error => finish(error));
    session.init(sessionConfig, new NodeIDependsAdapter(), new NodeIDispatcherAdapter(), listener);

    try {
      if (startupSession) startupSession.start();
      else {
        try {
          session.startNT(0);
        } catch {
          session.startNT();
        }
      }
    } catch (error) {
      finish(error);
    }
  });

  logger?.info(`[session] Session 已就绪，self=${selfInfo.uin}`);
  return session;
}
