import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.mjs';
import { Logger } from './logger.mjs';
import { MessageQueue } from './store/queue.mjs';
import { MediaStore } from './store/media.mjs';
import { detectQQ, describeWrapper, loadWrapper } from './qq/wrapper.mjs';
import { initializeEngine, createSession } from './qq/session.mjs';
import { EventBus } from './qq/event-bus.mjs';
import { LoginManager } from './qq/login.mjs';

import { QQApi } from './qq/api.mjs';
import { startIngest, backfillRecent } from './qq/events.mjs';
import { startHttpServer } from './http/server.mjs';
import { loadAccountState, markAccountOnline, resolveActiveAccount, saveAccountState, switchAccount, EXIT_SWITCH_ACCOUNT } from './accounts.mjs';

const app = new EventEmitter();
app.startedAt = Date.now();
app.config = loadConfig();
app.logger = new Logger({
  dir: path.join(app.config._dataDir, 'logs'),
  level: app.config.log.level,
  buffer: app.config.log.buffer
});

app.activeAccount = resolveActiveAccount(app.config);
if (app.activeAccount.dataDir) app.config.qq.dataDir = app.activeAccount.dataDir;

app.queue = new MessageQueue({
  dir: app.config.storage.dir,
  logger: app.logger
});
app.media = new MediaStore({
  dir: path.join(app.config._dataDir, 'media'),
  logger: app.logger
});

app.emitMessage = message => app.emit('message', message);

function inspectCapabilities (session) {
  const missing = [];
  const checks = [
    ['getMsgService', ['sendMsg', 'getAioFirstViewLatestMsgs', 'getMsgsByMsgId', 'downloadRichMedia', 'forwardMsg', 'generateMsgUniqueId']],
    ['getGroupService', ['getGroupList']],
    ['getBuddyService', ['getBuddyListV2']],
    ['getProfileService', ['getCoreAndBaseInfo']],
    ['getUixConvertService', ['getUid']],
    ['getRichMediaService', ['downloadFile']]
  ];
  for (const [getter, methods] of checks) {
    let service;
    try {
      service = session?.[getter]?.();
    } catch {
      service = null;
    }
    if (!service) {
      missing.push(`${getter}()`);
      continue;
    }
    for (const method of methods) {
      if (typeof service[method] !== 'function') missing.push(`${getter}.${method}`);
    }
  }
  return { missing };
}

async function onOnline ({ uin, uid }) {
  if (app.session) return;
  try {
    const selfInfo = {
      uin: String(uin || app.login.publicState().uin),
      uid: String(uid || app.login.publicState().uid),
      nick: '',
      online: true
    };
    app.logger.info(`[core] 登录成功，开始初始化 Session self=${selfInfo.uin}`);

    app.session = await createSession({
      wrapper: app.wrapper,
      info: app.info,
      dataPath: app.dataPath,
      selfInfo,
      dataDir: app.config._dataDir,
      logger: app.logger
    });
    app.selfInfo = selfInfo;
    app.bus = new EventBus({ session: app.session, logger: app.logger });
    app.api = new QQApi(app);
    app.capabilities = inspectCapabilities(app.session);
    if (app.capabilities.missing.length > 0) {
      app.logger.warn('[core] 能力探测发现缺失项：' + app.capabilities.missing.join(', '));
    }

    startIngest(app);
    markAccountOnline(app.config, selfInfo.uin);
    saveAccountState(app.config, { ...loadAccountState(app.config), pendingSwitch: false, reason: '', uin: selfInfo.uin });

    backfillRecent(app).catch(error => app.logger.warn('[core] 补拉失败', error));

    if (app.config.onebot?.enabled) {
      try {
        const { startOneBot } = await import('./onebot/index.mjs');
        app.onebot = await startOneBot(app);
      } catch (error) {
        app.logger.error('[onebot] 启动失败', error);
      }
    }

    app.logger.info('[core] 初始化完成，AI 可以开始拉取消息');
    app.fatal = '';
  } catch (error) {
    app.fatal = error.message || String(error);
    app.logger.error('[core] Session 初始化失败', error);
  }
}

function onOffline (reason) {
  app.logger.warn(`[core] 离线：${reason}`);
  try {
    app.login?.setOfflineSilently(reason);
  } catch {
    // ignore
  }
  try {
    app.bus?.closeAll();
  } catch {
    // ignore
  }
  app.bus = null;
  app.session = null;
  app.api = null;
  app.capabilities = { missing: ['offline'] };
  if (app.config.qq.switchOnKick && ['kicked', 'silent_offline', 'logout'].includes(reason)) {
    const switched = switchAccount(app.config, app.logger, reason);
    if (!switched) app.logger.warn('[core] 无备用账号，保持离线状态，等待重新登录或人工切换');
  }
}

app.requestAccountSwitch = (index, uin) => {
  const accounts = app.config.accounts || [];
  if (accounts.length === 0) return false;
  let target = Number.isInteger(index) ? index : -1;
  if (target < 0 && uin) target = accounts.findIndex(item => item.uin === String(uin));
  if (target < 0 || target >= accounts.length) return false;
  const state = loadAccountState(app.config);
  saveAccountState(app.config, { ...state, index: target, pendingSwitch: true, reason: 'manual' });
  app.logger.warn(`[account] 手动切换账号 -> ${accounts[target].uin}`);
  setTimeout(() => process.exit(EXIT_SWITCH_ACCOUNT), 300);
  return true;
};

process.on('uncaughtException', error => {
  app.logger?.error('[process] uncaughtException', error);
});
process.on('unhandledRejection', error => {
  app.logger?.error('[process] unhandledRejection', error);
});

async function main () {
  app.logger.info(`[boot] 数据目录 ${app.config._dataDir}`);
  app.logger.info(`[boot] 当前账号索引 ${app.activeAccount.index}，uin=${app.activeAccount.uin || '(扫码)'}，备用数=${app.activeAccount.total}`);
  if (!app.config.http.token) {
    app.logger.warn('[boot] HTTP 未设置 token：按单容器方案默认免鉴权，请勿把端口暴露到公网');
  }

  await app.queue.init();

  app.httpServer = startHttpServer(app);

  try {
    app.info = detectQQ(app.config, app.logger);
    app.wrapper = loadWrapper(app.info);
    app.capabilities = describeWrapper(app.wrapper);
    app.logger.info(`[boot] QQ ${app.info.version}，appid=${app.info.appid}，appDir=${app.info.appDir}`);
  } catch (error) {
    app.fatal = error.message || String(error);
    app.logger.error('[boot] QQ 内核加载失败', error);
    app.logger.error('[boot] 服务继续运行，可通过 /health 查看错误；修复后重启容器即可');
    return;
  }

  try {
    const engineInfo = initializeEngine({
      wrapper: app.wrapper,
      info: app.info,
      config: app.config,
      logger: app.logger
    });
    app.dataPath = engineInfo.dataPath;
    app.dataPathGlobal = engineInfo.dataPathGlobal;
    app.loginService = engineInfo.loginService;

    app.login = new LoginManager({
      loginService: engineInfo.loginService,
      logger: app.logger,
      config: app.config
    });
    app.login.on('online', payload => {
      onOnline(payload).catch(error => app.logger.error('[core] onOnline 异常', error));
    });
    app.login.on('offline', reason => onOffline(reason));

    app.login.start({ account: app.activeAccount.uin }).catch(error => {
      app.logger.error('[login] 启动失败', error);
    });
  } catch (error) {
    app.fatal = error.message || String(error);
    app.logger.error('[boot] 登录服务初始化失败', error);
  }
}

function shutdown (signal) {
  app.logger?.warn(`[process] 收到 ${signal}，正在退出`);
  try {
    app.httpServer?.close();
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(error => {
  app.logger?.error('[boot] 启动失败', error);
  process.exitCode = 1;
});
