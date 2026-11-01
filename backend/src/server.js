const express = require('express');
const path = require('path');
const http = require('http');
const net = require('net');
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

// 虚拟屏一律通过面板转发：远程访问时浏览器只需要能连面板端口，
// 不必让宿主机的 7900+ 端口对公网开放。
function screenTargetOf(url) {
  const match = String(url || '').match(/^\/screen\/([^/?#]+)/);
  if (!match) return null;
  const rest = String(url).slice(match[0].length);
  return {
    id: decodeURIComponent(match[1]),
    path: rest.startsWith('/') ? rest : `/${rest}`
  };
}

function screenPortOf(agentId) {
  const agent = db.get('SELECT seq, enable_screen FROM agents WHERE id = ?', [agentId]);
  if (!agent || !agent.enable_screen) return null;
  return config.noVncBasePort + Number(agent.seq);
}

function panelAuthorized(req) {
  const token = db.getSetting('panel_token', '');
  if (!token) return true;
  if (parseCookies(req.headers.cookie).ea_panel === token) return true;
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get('token') === token;
  } catch {
    return false;
  }
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

  // 虚拟桌面（noVNC）转发：/screen/<AI 编号>/... -> 宿主机 7900+seq 的容器内 noVNC。
  app.use((req, res, next) => {
    if (!req.path.startsWith('/screen/')) return next();
    const target = screenTargetOf(req.originalUrl);
    const port = target ? screenPortOf(target.id) : null;
    if (!port) {
      return res.status(404).render('error', { title: '虚拟屏不可用', message: '该 AI 未启用虚拟屏或已不存在。' });
    }
    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: req.method,
        path: target.path,
        headers: { ...req.headers, host: `127.0.0.1:${port}` }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (error) => {
      if (res.headersSent) return res.destroy();
      res
        .status(502)
        .render('error', { title: '虚拟屏连接失败', message: `无法连接容器内的 noVNC：${error.message}` });
    });
    req.pipe(proxyReq);
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

  // noVNC 的 WebSocket（websockify）也要走面板端口转发。
  panelServer.on('upgrade', (req, socket, head) => {
    const target = screenTargetOf(req.url);
    if (!target || !panelAuthorized(req) || !screenPortOf(target.id)) {
      socket.destroy();
      return;
    }
    const port = screenPortOf(target.id);
    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${target.path} HTTP/1.1`];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index];
        const value = req.rawHeaders[index + 1];
        lines.push(name.toLowerCase() === 'host' ? `Host: 127.0.0.1:${port}` : `${name}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.pipe(socket);
    socket.pipe(upstream);
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
