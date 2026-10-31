const express = require('express');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const runtime = require('./runtime');
const recovery = require('./recovery');
const proxy = require('./proxy');
const adminRoutes = require('./routes/admin');
const agentApi = require('./routes/agentApi');
const supervisor = require('./supervisor');
const monitor = require('./monitor');
const companion = require('./companion');
const reminders = require('./reminders');
const docker = require('./docker');
const tasks = require('./tasks');
const events = require('./events');
const inbox = require('./inbox');
const {
  formatInt,
  formatDate,
  formatBytes,
  formatDuration
} = require('./util');

const STATUS_TEXT = {
  created: '待启动',
  running: '运行中',
  paused_disk: '磁盘暂停',
  dying: '临终',
  finalizing: '归档中',
  dead: '已死亡',
  suspended: '已暂停（崩溃超限）'
};

function statusText(status) {
  return STATUS_TEXT[status] || status || '';
}

function statusClass(status) {
  return `status-${String(status || 'unknown').replace(/_/g, '-')}`;
}

function modelsOf(provider) {
  try {
    const parsed = JSON.parse(provider?.models || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function createPanelApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));
  app.use(express.json({ limit: '100mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 面板鉴权可选：设置 panel_token 后才要求登录；不设置则完全开放。
  app.use((req, res, next) => {
    const token = db.getSetting('panel_token', '');
    if (!token) return next();
    const open = ['/login', '/setup', '/style.css'];
    if (open.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.ea_panel === token || req.query.token === token) {
      if (req.query.token === token) {
        res.setHeader('Set-Cookie', `ea_panel=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
      }
      return next();
    }
    return res.redirect('/login');
  });

  // 首次初始化向导：未完成时把总览跳到 /setup（其他页面放行，避免打断正在做的事）。
  app.use((req, res, next) => {
    if (req.path === '/' && db.getSetting('setup_completed', '0') !== '1') {
      return res.redirect('/setup');
    }
    next();
  });

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const defaultMode = db.getSetting('default_mode', 'research');
    const queryMode = req.query.mode === 'companion' || req.query.mode === 'research' ? req.query.mode : null;
    let mode = queryMode || cookies.ea_mode || defaultMode;
    if (req.path.startsWith('/companion')) mode = 'companion';
    if (mode !== 'companion') mode = 'research';
    if (queryMode) {
      res.setHeader('Set-Cookie', `ea_mode=${queryMode}; Path=/; Max-Age=31536000; SameSite=Lax`);
    }
    res.locals.panelMode = mode;
    next();
  });

  app.use((req, res, next) => {
    res.locals.fmtInt = formatInt;
    res.locals.fmtDate = formatDate;
    res.locals.fmtBytes = formatBytes;
    res.locals.fmtDuration = formatDuration;
    res.locals.statusText = statusText;
    res.locals.statusClass = statusClass;
    res.locals.modelsOf = modelsOf;
    res.locals.unreadCount = inbox.unreadCount();
    res.locals.now = new Date().toISOString();
    if (res.locals.active === undefined) res.locals.active = '';
    if (res.locals.title === undefined) res.locals.title = '';
    next();
  });

  app.use('/', adminRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { title: '未找到', message: '页面不存在' });
  });

  app.use((error, req, res, next) => {
    console.error('[panel]', error);
    if (res.headersSent) return next(error);
    res.status(500).render('error', { title: '错误', message: error.message });
  });

  return app;
}

function createProxyApp() {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.post('/v1/chat/completions', proxy.handleChat);
  app.use('/api/agent', agentApi);
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => {
    console.error('[proxy]', error);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: { message: error.message } });
  });
  return app;
}

async function main() {
  logger.init();
  const startup = runtime.init();
  db.init();
  // 老库升级：已经有 AI 的环境不强制走初始化向导，避免打开面板就被跳转到 /setup。
  if (db.getSetting('setup_completed', '0') !== '1') {
    const existing = db.get('SELECT COUNT(*) AS n FROM agents');
    if (existing && existing.n > 0) db.setSetting('setup_completed', '1');
  }
  events.addEvent(
    null,
    'system',
    startup.needsRecovery
      ? `平台后端启动。检测到上次非正常停止，准备恢复 ${startup.recoveryId}（${startup.reason}）。`
      : '平台后端启动。'
  );

  const panelApp = createPanelApp();
  const proxyApp = createProxyApp();

  const panelServer = panelApp.listen(config.panelPort, config.panelBind, () => {
    console.log(`[panel] http://${config.panelBind}:${config.panelPort}`);
  });
  const proxyServer = proxyApp.listen(config.backendPort, config.backendBind, () => {
    console.log(`[proxy] http://${config.backendBind}:${config.backendPort}`);
  });

  supervisor.start();
  monitor.start();
  companion.start();
  reminders.start();

  recovery.run(startup).catch((error) => {
    console.error('[recovery]', error);
  });

  setTimeout(async () => {
    try {
      await docker.ensureEgress();
      console.log('[docker] 出网代理已就绪');
    } catch (error) {
      console.warn('[docker]', error.message);
    }
  }, 3000);

  setTimeout(async () => {
    try {
      await tasks.maybeRefillTasks({ initial: true });
    } catch (error) {
      console.warn('[tasks]', error.message);
    }
  }, 5000);

  const shutdown = () => {
    console.log('正在关闭...');
    runtime.markCleanShutdown();
    supervisor.stop();
    monitor.stop();
    companion.stop();
    reminders.stop();
    panelServer.close();
    proxyServer.close();
    db.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);

  process.on('uncaughtException', (error) => {
    console.error('[uncaught]', error);
    events.addEvent(null, 'error', `未捕获异常：${error.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandled]', reason);
    events.addEvent(null, 'error', `未处理的 Promise 拒绝：${reason?.message || reason}`);
  });
}

main().catch((error) => {
  console.error('启动失败', error);
  process.exit(1);
});
