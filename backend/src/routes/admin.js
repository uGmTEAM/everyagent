const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const db = require('../db');
const config = require('../config');
const agents = require('../agents');
const tasks = require('../tasks');
const billing = require('../billing');
const judge = require('../judge');
const oracle = require('../oracle');
const media = require('../media');
const docker = require('../docker');
const death = require('../death');
const events = require('../events');
const inbox = require('../inbox');
const logger = require('../logger');
const llm = require('../llm');
const toolkits = require('../toolkits');
const companion = require('../companion');
const prompts = require('../prompts');
const { formatBytes, nowIso, formatDate, tailFileLines } = require('../util');

const router = express.Router();

const upload = multer({
  dest: config.uploadsDir,
  limits: { fileSize: 300 * 1024 * 1024, files: 50 }
});

// 预设工具集：GitHub release 压缩包（zip / tar.gz / tar）
const uploadToolkit = multer({
  dest: config.uploadsDir,
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 }
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function modelsOf(provider) {
  return llm.parseModels(provider?.models);
}

function providerList() {
  return db.all('SELECT * FROM providers ORDER BY id ASC').map((provider) => ({
    ...provider,
    model_list: modelsOf(provider),
    vision_model_list: llm.parseVisionModels(provider.vision_models),
    multimodal_model_list: llm.parseMultimodalModels(provider.multimodal_models),
    image_model_list: llm.parseModels(provider.image_models),
    speech_model_list: llm.parseModels(provider.speech_models),
    asr_model_list: llm.parseModels(provider.asr_models),
    api_key_masked: provider.api_key ? `${provider.api_key.slice(0, 4)}...${provider.api_key.slice(-4)}` : ''
  }));
}

function recentEvents(limit = 30) {
  return db.all(
    `SELECT e.*, a.seq AS agent_seq FROM events e LEFT JOIN agents a ON a.id = e.agent_id
      ORDER BY e.id DESC LIMIT ?`,
    [limit]
  );
}

// 给一个 AI 投递平台留言：补偿、唤醒、记录事件（Agent 页与「留言」页共用）。
async function deliverAdminMessage(agent, content) {
  const compensation = agent.unlimited_tokens ? 0 : config.adminMessageCompensation;
  const message = events.addAdminMessage(agent.id, content.slice(0, 8000), compensation);
  if (compensation > 0) {
    billing.recharge(agent.id, compensation, 'admin_message');
  }
  db.run('UPDATE agents SET wake_requested = 1 WHERE id = ?', [agent.id]);

  if (agent.status === 'paused_disk' && agent.container_id) {
    try {
      await docker.unpauseContainer(agent.container_id);
      db.run(
        "UPDATE agents SET status = 'running', last_start_at = ? WHERE id = ? AND status = 'paused_disk'",
        [nowIso(), agent.id]
      );
    } catch (error) {
      events.addEvent(agent.id, 'message_wake_error', `留言唤醒失败：${error.message}`);
    }
  }

  const amountText = compensation ? `补偿 ${compensation.toLocaleString('en-US')} tokens，` : '';
  events.addEvent(
    agent.id,
    'admin_message',
    `管理员留言（${amountText}强制唤醒）：${content.slice(0, 500)}`,
    { message_id: message.id, compensation }
  );
  return message;
}

function aliveAgents() {
  return agents.listAgents().filter((agent) => agent.status !== 'dead' && agent.status !== 'finalizing');
}

// 管理者账号：一行一个（也支持逗号/空格分隔），按是否含 @ 自动区分 QQ 与邮箱。
function parseManagerAccounts(text) {
  const accounts = [];
  const keys = new Set();
  for (const raw of String(text || '').split(/[\n,，;；、\s]+/)) {
    const accountId = raw.trim();
    if (!accountId) continue;
    const kind = companion.detectManagerKind(accountId);
    const key = companion.managerKey(kind, accountId);
    if (keys.has(key)) continue;
    keys.add(key);
    accounts.push({ kind, accountId });
  }
  return accounts;
}

// 设置页保存：以输入框为准同步「平台来源」的管理者；AI 自行登记的保留不动。
function syncPlatformManagers(text) {
  const wanted = parseManagerAccounts(text);
  for (const account of wanted) {
    companion.registerManager({ kind: account.kind, account_id: account.accountId, source: 'platform' });
  }
  const keep = new Set(wanted.map((account) => companion.managerKey(account.kind, account.accountId)));
  for (const item of companion.listManagers()) {
    if (item.source !== 'platform') continue;
    if (keep.has(companion.managerKey(item.kind, item.account_id))) continue;
    companion.removeManager(item.id);
  }
}

function managerAccountsText() {
  return companion.listManagers().map((item) => item.account_id).join('\n');
}

// ---------- 初始化向导与可选鉴权 ----------
router.get('/setup', (req, res) => {
  res.render('setup', {
    title: '初始化',
    active: 'setup',
    defaultMode: db.getSetting('default_mode', 'research'),
    panelToken: db.getSetting('panel_token', ''),
    completed: db.getSetting('setup_completed', '0') === '1',
    managerAccounts: managerAccountsText(),
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/setup', (req, res) => {
  const mode = req.body.default_mode === 'companion' ? 'companion' : 'research';
  const token = String(req.body.panel_token || '').trim();
  db.setSetting('default_mode', mode);
  db.setSetting('panel_token', token);
  db.setSetting('setup_completed', '1');
  try {
    syncPlatformManagers(req.body.manager_accounts);
  } catch (error) {
    return res.redirect(`/setup?error=${encodeURIComponent(`管理者账号保存失败：${error.message}`)}`);
  }
  events.addEvent(null, 'setup', `初始化完成：默认模式 ${mode === 'companion' ? '陪伴' : '研究'}，面板鉴权${token ? '已启用' : '未启用'}。`);
  if (token) {
    res.setHeader('Set-Cookie', `ea_panel=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
  }
  res.redirect('/');
});

router.get('/login', (req, res) => {
  res.render('login', {
    title: '登录',
    active: 'login',
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/login', (req, res) => {
  const token = db.getSetting('panel_token', '');
  const input = String(req.body.token || '').trim();
  if (!token || input === token) {
    res.setHeader('Set-Cookie', `ea_panel=${encodeURIComponent(token || input)}; Path=/; HttpOnly; SameSite=Lax`);
    return res.redirect('/');
  }
  return res.redirect(`/login?error=${encodeURIComponent('口令不正确')}`);
});

router.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ea_panel=; Path=/; Max-Age=0');
  res.redirect('/login');
});

// ---------- 陪伴面板 ----------
router.get('/companion', (req, res) => {
  const list = db.all(
    `SELECT a.*, p.name AS provider_name,
       (SELECT COUNT(*) FROM companion_messages m WHERE m.agent_id = a.id AND m.direction = 'in') AS incoming,
       (SELECT COUNT(*) FROM companion_messages m WHERE m.agent_id = a.id AND m.direction = 'out') AS outgoing,
       (SELECT COUNT(DISTINCT conversation_id) FROM companion_messages m WHERE m.agent_id = a.id) AS conversations,
       (SELECT MAX(created_at) FROM companion_messages m WHERE m.agent_id = a.id) AS last_message_at
     FROM agents a LEFT JOIN providers p ON p.id = a.provider_id
     WHERE a.mode = 'companion'
     ORDER BY a.seq ASC`
  );
  const bindings = {};
  for (const item of list) {
    bindings[item.id] = companion.bindingOf(item.id);
  }
  res.render('companion', {
    title: '陪伴',
    active: 'companion',
    list,
    bindings,
    managers: companion.listManagers(),
    mode: 'list',
    message: req.query.message ? String(req.query.message) : null,
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/managers', (req, res) => {
  try {
    companion.registerManager({
      account_id: req.body.account_id,
      label: req.body.label,
      note: req.body.note,
      source: 'platform'
    });
    res.redirect('/companion?message=' + encodeURIComponent('已登记管理者账号'));
  } catch (error) {
    res.redirect('/companion?error=' + encodeURIComponent(`登记失败：${error.message}`));
  }
});

router.post('/managers/:id/delete', (req, res) => {
  try {
    companion.removeManager(req.params.id);
    res.redirect('/companion?message=' + encodeURIComponent('已删除登记'));
  } catch (error) {
    res.redirect('/companion?error=' + encodeURIComponent(`删除失败：${error.message}`));
  }
});

router.get('/companion/:id', asyncHandler(async (req, res) => {
  const agent = agents.getAgentWithProvider(req.params.id);
  if (!agent || agent.mode !== 'companion') {
    return res.status(404).render('error', { title: '未找到', message: '陪伴 AI 不存在' });
  }
  const conversations = companion.recentConversations(agent.id, 40);
  const activeConversation = String(req.query.conversation || (conversations[0]?.conversation_id || ''));
  const messages = activeConversation
    ? companion.conversationMessages(agent.id, activeConversation, 300)
    : [];
  const binding = companion.bindingOf(agent.id);
  const stats = companion.stats(agent.id);
  res.render('companion', {
    title: agent.id,
    active: 'companion',
    list: null,
    agent,
    mode: 'chat',
    conversations,
    activeConversation,
    messages,
    binding,
    stats,
    crashLimit: agents.effectiveCrashLimit(agent),
    noVncUrl: `http://127.0.0.1:${config.noVncBasePort + agent.seq}/vnc.html?autoconnect=1&resize=scale`,
    message: req.query.message ? String(req.query.message) : null,
    error: req.query.error ? String(req.query.error) : null
  });
}));

router.post('/companion/:id/send', asyncHandler(async (req, res) => {
  const agent = agents.getAgent(req.params.id);
  if (!agent || agent.mode !== 'companion') {
    return res.redirect('/companion');
  }
  const conversationId = String(req.body.conversation_id || '').trim();
  const text = String(req.body.text || '').trim();
  const kind = req.body.kind === 'group' ? 'group' : 'private';
  if (!conversationId || !text) {
    return res.redirect(`/companion/${agent.id}?conversation=${encodeURIComponent(conversationId)}&error=${encodeURIComponent('会话和内容不能为空')}`);
  }
  try {
    await companion.sendText(agent, {
      conversationId,
      kind,
      text,
      replyTo: req.body.reply_to ? String(req.body.reply_to) : null,
      senderUin: req.body.sender_uin ? String(req.body.sender_uin) : null,
      senderName: req.body.sender_name ? String(req.body.sender_name) : null
    });
    res.redirect(`/companion/${agent.id}?conversation=${encodeURIComponent(conversationId)}&message=${encodeURIComponent('已发送')}`);
  } catch (error) {
    res.redirect(`/companion/${agent.id}?conversation=${encodeURIComponent(conversationId)}&error=${encodeURIComponent(`发送失败：${error.message}`)}`);
  }
}));

router.get('/companion/:id/qrcode', asyncHandler(async (req, res) => {
  const agent = agents.getAgent(req.params.id);
  if (!agent || agent.mode !== 'companion') {
    return res.status(404).json({ error: { message: '陪伴 AI 不存在' } });
  }
  try {
    const data = await companion.qrcode(agent);
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(503).json({ error: { message: error.message } });
  }
}));

router.post('/companion/:id/qq-restart', asyncHandler(async (req, res) => {
  const agent = agents.getAgent(req.params.id);
  if (!agent || agent.mode !== 'companion') return res.redirect('/companion');
  try {
    const exec = await docker.client().getContainer(agent.container_id).exec({
      Cmd: ['sh', '-c', 'pkill -f /opt/QQ/qq || pkill -f QQ || true'],
      AttachStdout: false,
      AttachStderr: false
    });
    await exec.start({ Detach: true });
    db.run('UPDATE qq_bindings SET qq_restarts = qq_restarts + 1, updated_at = ? WHERE agent_id = ?', [nowIso(), agent.id]);
    events.addEvent(agent.id, 'qq_restart_manual', '管理员手动重启 QQ。');
    res.redirect(`/companion/${agent.id}?message=${encodeURIComponent('已请求重启 QQ')}`);
  } catch (error) {
    res.redirect(`/companion/${agent.id}?error=${encodeURIComponent(`重启 QQ 失败：${error.message}`)}`);
  }
}));

router.get('/', asyncHandler(async (req, res) => {
  const list = agents.listAgents('research');
  const dockerOk = await docker.isAvailable();
  const totals = db.get(
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE mode = 'research') AS agents,
       (SELECT COUNT(*) FROM agents WHERE mode = 'research' AND status = 'dead') AS dead,
       (SELECT COUNT(*) FROM agents WHERE mode = 'research' AND status != 'dead') AS alive,
       (SELECT COUNT(*) FROM requests) AS requests,
       (SELECT COALESCE(SUM(total_tokens),0) FROM requests WHERE kind = 'agent_chat') AS chat_tokens,
       (SELECT COUNT(*) FROM tasks WHERE active = 1) AS tasks,
       (SELECT COUNT(*) FROM tasks WHERE active = 1) AS active_tasks`
  );
  res.render('overview', {
    title: '总览',
    active: 'overview',
    agents: list,
    dockerOk,
    totals,
    recentEvents: recentEvents(20)
  });
}));

router.get('/broadcast', (req, res) => {
  const list = aliveAgents();
  const recent = db.all(
    `SELECT m.*, a.seq AS agent_seq FROM admin_messages m LEFT JOIN agents a ON a.id = m.agent_id
      ORDER BY m.id DESC LIMIT 20`
  );
  res.render('broadcast', {
    title: '留言',
    active: 'broadcast',
    list,
    aliveCount: list.length,
    recent,
    compensation: config.adminMessageCompensation,
    message: req.query.message ? String(req.query.message) : null,
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/broadcast', asyncHandler(async (req, res) => {
  const content = String(req.body.content || '').trim();
  const target = String(req.body.target || 'all');
  if (!content) {
    return res.redirect('/broadcast?error=' + encodeURIComponent('留言内容不能为空'));
  }
  const selected = target === 'all' ? aliveAgents() : aliveAgents().filter((agent) => agent.id === target);
  if (!selected.length) {
    return res.redirect(
      '/broadcast?error=' + encodeURIComponent(target === 'all' ? '当前没有可以接收留言的存活 AI' : '该 AI 不存在、已死亡或正在归档')
    );
  }
  try {
    for (const agent of selected) {
      await deliverAdminMessage(agent, content);
    }
  } catch (error) {
    return res.redirect('/broadcast?error=' + encodeURIComponent(`发送失败：${error.message}`));
  }
  res.redirect('/broadcast?message=' + encodeURIComponent(`已发送给 ${selected.length} 个 AI`));
}));

router.get('/agents/new', (req, res) => {
  const providers = providerList();
  res.render('agent_new', {
    title: '创建 AI',
    active: 'new',
    providers,
    toolkits: toolkits.list(),
    defaultBalance: config.defaultInitialBalance,
    defaultMode: req.query.mode === 'companion'
      ? 'companion'
      : (req.query.mode === 'research' ? 'research' : db.getSetting('default_mode', 'research')),
    companionRules: prompts.DEFAULT_COMPANION_RULES,
    managerAccounts: managerAccountsText(),
    error: req.query.error || null
  });
});

router.post('/agents', upload.array('corpus', 50), asyncHandler(async (req, res) => {
  try {
    const agent = await agents.createAgent({
      goal: req.body.goal,
      rules: req.body.rules,
      extraRules: req.body.extra_rules,
      persona: req.body.persona,
      providerId: Number(req.body.provider_id),
      model: req.body.model,
      initialBalance: Number(req.body.initial_balance || config.defaultInitialBalance),
      allowInternet: req.body.allow_internet === '1',
      unlimitedTokens: req.body.unlimited_tokens === '1',
      enableScreen: req.body.enable_screen === '1',
      visionMode: req.body.vision_mode || 'none',
      visionProviderId: Number(req.body.vision_provider_id || 0) || null,
      visionModel: req.body.vision_model || null,
      visionBill: req.body.vision_bill === '1',
      manualTasks: req.body.manual_tasks === '1',
      mode: req.body.mode === 'companion' ? 'companion' : 'research',
      toolkits: Array.isArray(req.body.toolkits)
        ? req.body.toolkits
        : (req.body.toolkits ? [req.body.toolkits] : []),
      uploadNote: req.body.upload_note,
      corpusFiles: req.files || []
    });
    const existingKeys = new Set(
      companion.listManagers().map((item) => companion.managerKey(item.kind, item.account_id))
    );
    for (const account of parseManagerAccounts(req.body.manager_accounts)) {
      // 已有登记（含 AI 自行登记）不改来源，避免覆盖。
      if (existingKeys.has(companion.managerKey(account.kind, account.accountId))) continue;
      try {
        companion.registerManager({ kind: account.kind, account_id: account.accountId, source: 'platform' });
      } catch {
        // 单个账号格式不对不影响 AI 创建
      }
    }
    res.redirect(`/agents/${agent.id}`);
  } catch (error) {
    for (const file of req.files || []) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
    res.redirect(`/agents/new?error=${encodeURIComponent(error.message)}`);
  }
}));

router.get('/toolkits', (req, res) => {
  res.render('toolkits', {
    title: '预设工具',
    active: 'toolkits',
    list: toolkits.list(),
    message: req.query.message ? String(req.query.message) : null,
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/toolkits', uploadToolkit.single('archive'), asyncHandler(async (req, res) => {
  const file = req.file;
  try {
    if (!file) throw new Error('请选择要上传的压缩包');
    const info = toolkits.install({
      archivePath: file.path,
      originalName: file.originalname,
      name: req.body.name
    });
    res.redirect(`/toolkits?message=${encodeURIComponent(`工具集 ${info.name} 已安装`)}`);
  } catch (error) {
    res.redirect(`/toolkits?error=${encodeURIComponent(error.message)}`);
  } finally {
    if (file?.path) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
  }
}));

router.post('/toolkits/:name/delete', asyncHandler(async (req, res) => {
  try {
    const name = toolkits.remove(req.params.name);
    res.redirect(`/toolkits?message=${encodeURIComponent(`工具集 ${name} 已删除`)}`);
  } catch (error) {
    res.redirect(`/toolkits?error=${encodeURIComponent(error.message)}`);
  }
}));

router.get('/agents/:id', asyncHandler(async (req, res) => {
  const agent = agents.getAgentWithProvider(req.params.id);
  if (!agent) return res.status(404).render('error', { title: '未找到', message: 'AI 不存在' });
  const tab = String(req.query.tab || 'conversation');
  const currentTask = tasks.getCurrentTask(agent.id);
  const usage = agents.usageSummary(agent.id);
  const requests = agents.recentRequests(agent.id, 60);
  const progress = agents.taskProgress(agent.id);
  const submissions = agents.submissions(agent.id, 100);
  const eventList = agents.listEvents(agent.id, 100);
  const kb = agents.kbInfo(agent.id);
  const disk = agents.diskUsage(agent.id);
  const warnings = billing.activeWarnings(agent);

  const visionProvider = agent.vision_provider_id
    ? db.get('SELECT name FROM providers WHERE id = ?', [agent.vision_provider_id])
    : null;
  let visionText = '未启用';
  if (agent.vision_mode === 'main') {
    visionText = '主模型（多模态）';
  } else if (agent.vision_mode === 'shared') {
    visionText = '共用识图';
  } else if (agent.vision_mode === 'private') {
    visionText = `私用：${visionProvider?.name || '未知供应商'} / ${agent.vision_model || ''}（${agent.vision_bill ? '计费' : '免费'}）`;
  }

  const noVncUrl = agent.enable_screen
    ? `http://127.0.0.1:${config.noVncBasePort + agent.seq}/vnc.html?autoconnect=1&resize=scale`
    : null;

  const providerList = db.all('SELECT * FROM providers ORDER BY id ASC');
  const fallbackProvider = agent.fallback_provider_id
    ? db.get('SELECT name FROM providers WHERE id = ?', [agent.fallback_provider_id])
    : null;

  let fileRoot = req.query.root === 'shared' ? 'shared' : 'workspace';
  let filePath = String(req.query.path || '');
  let files = [];
  let fileError = null;
  const uploadError = req.query.upload_error ? String(req.query.upload_error) : null;
  try {
    files = agents.listFiles(agent.id, fileRoot, filePath);
  } catch (error) {
    fileError = error.message;
    filePath = '';
    files = [];
  }
  const parentPath = filePath
    ? filePath.split('/').slice(0, -1).join('/')
    : null;

  res.render('agent_detail', {
    title: agent.id,
    active: 'overview',
    agent,
    tab,
    agentToolkits: toolkits.parseAgentToolkits(agent.toolkits),
    currentTask,
    usage,
    requests,
    progress,
    submissions,
    eventList,
    kb,
    disk,
    warnings,
    visionText,
    noVncUrl,
    fileRoot,
    filePath,
    files,
    fileError,
    uploadError,
    parentPath,
    adminMessages: events.listAdminMessages(agent.id, 20),
    messageError: req.query.message_error ? String(req.query.message_error) : null,
    crashError: req.query.crash_error ? String(req.query.crash_error) : null,
    crashLimit: agents.effectiveCrashLimit(agent),
    messageCompensation: config.adminMessageCompensation,
    providerList,
    fallbackProviderName: fallbackProvider?.name || null,
    modelError: req.query.model_error ? String(req.query.model_error) : null
  });
}));

router.post('/agents/:id/message', asyncHandler(async (req, res) => {
  const agent = agents.getAgent(req.params.id);
  if (!agent) return res.status(404).render('error', { title: '未找到', message: 'AI 不存在' });
  const content = String(req.body.content || '').trim();
  if (!content) {
    return res.redirect(`/agents/${agent.id}?tab=message&message_error=${encodeURIComponent('留言内容不能为空')}`);
  }
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    return res.redirect(`/agents/${agent.id}?tab=message&message_error=${encodeURIComponent('该 AI 已死亡或正在归档，不能留言')}`);
  }

  await deliverAdminMessage(agent, content);
  res.redirect(`/agents/${agent.id}?tab=message`);
}));

router.post('/agents/:id/crash-limit', (req, res) => {
  try {
    agents.updateCrashLimit(req.params.id, {
      limit: Number(req.body.limit || 0) || null,
      unlimited: req.body.unlimited === '1'
    });
  } catch (error) {
    return res.redirect(`/agents/${req.params.id}?crash_error=${encodeURIComponent(error.message)}`);
  }
  res.redirect(`/agents/${req.params.id}`);
});

router.post('/agents/:id/crash-reset', (req, res) => {
  try {
    agents.resetCrashAttempts(req.params.id);
  } catch (error) {
    return res.redirect(`/agents/${req.params.id}?crash_error=${encodeURIComponent(error.message)}`);
  }
  res.redirect(`/agents/${req.params.id}`);
});

router.post('/agents/:id/recharge', (req, res) => {
  const amount = Number(req.body.amount || 0);
  if (amount > 0) agents.recharge(req.params.id, amount);
  res.redirect(`/agents/${req.params.id}?tab=usage`);
});

router.post('/agents/:id/start', asyncHandler(async (req, res) => {
  try {
    await agents.startAgent(req.params.id);
  } catch (error) {
    events.addEvent(req.params.id, 'start_error', `手动启动失败：${error.message}`);
  }
  res.redirect(`/agents/${req.params.id}`);
}));

router.post('/agents/:id/models', asyncHandler(async (req, res) => {
  let updated;
  try {
    updated = agents.setModels(req.params.id, {
      providerId: req.body.provider_id,
      model: req.body.model,
      fallbackProviderId: req.body.fallback_provider_id,
      fallbackModel: req.body.fallback_model
    });
    await agents.restartAgent(req.params.id);
  } catch (error) {
    return res.redirect(
      `/agents/${req.params.id}?tab=settings&model_error=${encodeURIComponent(error.message)}`
    );
  }
  const fallback = updated.fallback_model
    ? `，主模型不可用时自动切换副模型 ${updated.fallback_model}`
    : '，未设置副模型';
  events.notifyAgent(
    req.params.id,
    `管理员调整了你的模型：主模型 ${updated.provider_name || updated.provider_id} / ${updated.model}${fallback}。容器已重启，新模型即刻生效。`
  );
  res.redirect(`/agents/${req.params.id}?tab=settings`);
}));

router.post('/agents/:id/restart', asyncHandler(async (req, res) => {
  try {
    await agents.restartAgent(req.params.id);
  } catch (error) {
    events.addEvent(req.params.id, 'restart_error', `重启失败：${error.message}`);
  }
  res.redirect(`/agents/${req.params.id}`);
}));

router.post('/agents/:id/clean-on-restart', (req, res) => {
  agents.setCleanOnRestart(req.params.id, req.body.enabled === '1');
  res.redirect(`/agents/${req.params.id}`);
});

router.post('/agents/:id/resume', asyncHandler(async (req, res) => {
  try {
    await agents.resumeAgent(req.params.id);
  } catch (error) {
    events.addEvent(req.params.id, 'resume_error', `恢复失败：${error.message}`);
  }
  res.redirect(`/agents/${req.params.id}`);
}));

router.post('/agents/:id/corpus', upload.array('corpus', 50), asyncHandler(async (req, res) => {
  try {
    agents.addCorpus(req.params.id, req.files || []);
  } catch (error) {
    events.addEvent(req.params.id, 'corpus_error', `追加语料失败：${error.message}`);
  }
  res.redirect(`/agents/${req.params.id}?tab=kb`);
}));

router.post('/agents/:id/upload', upload.array('files', 20), asyncHandler(async (req, res) => {
  try {
    const result = await agents.addUploads(req.params.id, req.files || [], {
      note: req.body.note,
      extraRules: req.body.extra_rules
    });
    const relative = result.dir.replace(/^\/workspace\/?/, '');
    res.redirect(
      `/agents/${req.params.id}?tab=files&root=workspace&path=${encodeURIComponent(relative)}`
    );
  } catch (error) {
    for (const file of req.files || []) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
    events.addEvent(req.params.id, 'upload_error', `上传失败：${error.message}`);
    res.redirect(
      `/agents/${req.params.id}?tab=files&upload_error=${encodeURIComponent(error.message)}`
    );
  }
}));

router.get('/agents/:id/file', asyncHandler(async (req, res) => {
  const agent = agents.getAgent(req.params.id);
  if (!agent) return res.status(404).render('error', { title: '未找到', message: 'AI 不存在' });
  const root = req.query.root === 'shared' ? 'shared' : 'workspace';
  const relative = String(req.query.path || '');
  const full = agents.resolveFile(agent.id, root, relative);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return res.status(404).render('error', { title: '未找到', message: '文件不存在' });
  }
  if (req.query.download === '1') {
    return res.download(full);
  }
  const stat = fs.statSync(full);
  const isText = stat.size <= 1024 * 1024;
  let content = null;
  if (isText) {
    try {
      content = fs.readFileSync(full, 'utf8');
      if (content.includes('\u0000')) content = null;
    } catch {
      content = null;
    }
  }
  res.render('file_view', {
    title: path.basename(full),
    active: 'overview',
    agent,
    root,
    relative,
    size: formatBytes(stat.size),
    content
  });
}));

router.get('/agents/:id/stream', (req, res) => {
  const agentId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const logPath = path.join(config.logsDir, `${agentId}.log`);
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-300);
      for (const line of content) {
        if (line) res.write(`data: ${JSON.stringify({ line, stream: 'file' })}\n\n`);
      }
    }
  } catch {
    // ignore
  }

  const unsubscribe = events.on('agent-log', (event) => {
    if (event.agent_id !== agentId) return;
    res.write(`data: ${JSON.stringify({ line: event.line, stream: event.stream, at: event.at })}\n\n`);
  });

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // ignore
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    try {
      res.end();
    } catch {
      // ignore
    }
  });
});

router.get('/inbox', (req, res) => {
  const type = ['ai_message', 'important'].includes(req.query.type) ? req.query.type : null;
  res.render('inbox', {
    title: '信息',
    active: 'inbox',
    items: inbox.list({ limit: 300, type }),
    type,
    unreadCount: inbox.unreadCount()
  });
});

router.post('/inbox/read-all', (req, res) => {
  inbox.markAllRead();
  res.redirect('/inbox');
});

router.post('/inbox/:id/read', (req, res) => {
  inbox.markRead(Number(req.params.id));
  res.redirect(req.get('referer') || '/inbox');
});

router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const unsubscribe = events.on('app-event', (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // ignore
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.get('/providers', (req, res) => {
  res.render('providers', {
    title: '供应商',
    active: 'providers',
    providers: providerList(),
    error: req.query.error || null
  });
});

router.post('/providers', (req, res) => {
  const id = Number(req.body.id || 0);
  const name = String(req.body.name || '').trim();
  const baseUrl = String(req.body.base_url || '').trim();
  const apiKey = String(req.body.api_key || '').trim();
  const providerType = ['deepseek', 'openai', 'custom'].includes(req.body.provider_type)
    ? req.body.provider_type
    : 'openai';
  const httpMethod = String(req.body.http_method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const requestTemplate = String(req.body.request_template || '').trim();
  const outputPath = String(req.body.output_path || '').trim();
  const models = String(req.body.models || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const visionModels = String(req.body.vision_models || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const multimodalModels = String(req.body.multimodal_models || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const imageModels = String(req.body.image_models || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const speechModels = String(req.body.speech_models || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const asrModels = String(req.body.asr_models || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!name || !baseUrl) {
    return res.redirect('/providers?error=name');
  }

  const customFields =
    providerType === 'custom' ? [httpMethod, requestTemplate, outputPath] : ['POST', '', ''];
  if (providerType === 'custom' && requestTemplate) {
    try {
      JSON.parse(
        requestTemplate
          .replace(/"\{\{\s*\w+\s*\}\}"/g, '"x"')
          .replace(/\{\{\s*\w+\s*\}\}/g, 'null')
      );
    } catch {
      return res.redirect('/providers?error=template');
    }
  }

  if (id) {
    const existing = db.get('SELECT * FROM providers WHERE id = ?', [id]);
    if (!existing) return res.redirect('/providers');
    db.run(
      `UPDATE providers
          SET name = ?, base_url = ?, api_key = ?, models = ?,
              vision_models = ?, multimodal_models = ?,
              image_models = ?, speech_models = ?, asr_models = ?,
              provider_type = ?, http_method = ?, request_template = ?, output_path = ?
        WHERE id = ?`,
      [
        name,
        baseUrl,
        apiKey || existing.api_key,
        JSON.stringify(models),
        JSON.stringify(visionModels),
        JSON.stringify(multimodalModels),
        JSON.stringify(imageModels),
        JSON.stringify(speechModels),
        JSON.stringify(asrModels),
        providerType,
        ...customFields,
        id
      ]
    );
  } else {
    db.run(
      `INSERT INTO providers
        (name, base_url, api_key, models, vision_models, multimodal_models,
         image_models, speech_models, asr_models, provider_type, http_method,
         request_template, output_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        baseUrl,
        apiKey,
        JSON.stringify(models),
        JSON.stringify(visionModels),
        JSON.stringify(multimodalModels),
        JSON.stringify(imageModels),
        JSON.stringify(speechModels),
        JSON.stringify(asrModels),
        providerType,
        ...customFields,
        nowIso()
      ]
    );
  }
  res.redirect('/providers');
});

router.post('/providers/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = db.get('SELECT COUNT(*) AS n FROM agents WHERE provider_id = ?', [id])?.n || 0;
  const judgeUse = db.get('SELECT provider_id FROM judge_config WHERE id = 1')?.provider_id;
  const oracleUse = db.get('SELECT provider_id FROM oracle_config WHERE id = 1')?.provider_id;
  if (used > 0 || judgeUse === id || oracleUse === id) {
    return res.redirect('/providers?error=in_use');
  }
  db.run('DELETE FROM providers WHERE id = ?', [id]);
  res.redirect('/providers');
});

router.get('/judge', (req, res) => {
  const judgeConfig = db.get('SELECT * FROM judge_config WHERE id = 1');
  const calls = db.all(
    `SELECT r.id, r.agent_id, r.kind, r.model, r.prompt_tokens, r.completion_tokens,
            r.total_tokens, r.latency_ms, r.status, r.error, r.created_at,
            substr(r.request_json, 1, 4000) AS request_preview,
            substr(r.response_json, 1, 4000) AS response_preview,
            s.id AS submission_id, s.state AS submission_state, s.deduction, s.reward,
            s.feedback, t.seq AS task_seq, t.title AS task_title
       FROM requests r
       LEFT JOIN submissions s ON s.judge_request_id = r.id
       LEFT JOIN tasks t ON t.id = s.task_id
      WHERE r.kind IN ('judge', 'task_gen')
      ORDER BY r.id DESC
      LIMIT 100`
  );
  const memory = db.all(
    `SELECT m.id, m.agent_id, m.submission_id, m.passed, m.deduction, m.reward,
            m.feedback, m.created_at, t.seq AS task_seq, t.title AS task_title
       FROM judge_memory m
       LEFT JOIN tasks t ON t.id = m.task_id
      ORDER BY m.id DESC
      LIMIT 50`
  );
  res.render('judge', {
    title: 'Judge',
    active: 'judge',
    judgeConfig,
    providers: providerList(),
    calls,
    memory
  });
});

router.post('/judge', asyncHandler(async (req, res) => {
  judge.saveConfig({
    provider_id: Number(req.body.provider_id || 0) || null,
    model: String(req.body.model || '').trim(),
    system_prompt: String(req.body.system_prompt || ''),
    persona: String(req.body.persona || '')
  });
  try {
    await tasks.maybeRefillTasks({ initial: true });
  } catch {
    // ignore
  }
  res.redirect('/judge');
}));

router.get('/oracle', (req, res) => {
  const oracleConfig = db.get('SELECT * FROM oracle_config WHERE id = 1');
  res.render('oracle', {
    title: 'Oracle',
    active: 'oracle',
    oracleConfig,
    providers: providerList()
  });
});

router.post('/oracle', (req, res) => {
  oracle.saveConfig({
    provider_id: Number(req.body.provider_id || 0) || null,
    model: String(req.body.model || '').trim(),
    system_prompt: String(req.body.system_prompt || ''),
    persona: String(req.body.persona || '')
  });
  res.redirect('/oracle');
});

router.get('/vision', (req, res) => {
  const visionConfig = db.get('SELECT * FROM vision_config WHERE id = 1');
  res.render('vision', {
    title: '视觉配置',
    active: 'vision',
    visionConfig,
    providers: providerList()
  });
});

router.post('/vision', (req, res) => {
  db.run(
    `UPDATE vision_config
        SET enabled = ?, provider_id = ?, model = ?, system_prompt = ?, bill_shared = ?, updated_at = ?
      WHERE id = 1`,
    [
      req.body.enabled === '1' ? 1 : 0,
      Number(req.body.provider_id || 0) || null,
      String(req.body.model || '').trim() || null,
      String(req.body.system_prompt || ''),
      req.body.bill_shared === '1' ? 1 : 0,
      nowIso()
    ]
  );
  res.redirect('/vision');
});

router.get('/media', (req, res) => {
  const mediaConfig = media.getConfig();
  const limitSeconds = Math.max(1, Number(mediaConfig.asr_daily_limit_minutes || 120)) * 60;
  const agentRows = db.all('SELECT id, seq FROM agents ORDER BY seq ASC');
  const asrUsage = agentRows.map((agent) => {
    const used = media.usedSecondsToday(agent.id);
    return {
      ...agent,
      used_minutes: Math.round((used / 60) * 10) / 10,
      remaining_minutes: Math.max(0, Math.round(((limitSeconds - used) / 60) * 10) / 10),
      over: used >= limitSeconds
    };
  });
  res.render('media', {
    title: '生图与语音',
    active: 'media',
    mediaConfig,
    providers: providerList(),
    asrUsage
  });
});

router.post('/media', (req, res) => {
  const limitMinutes = Math.max(1, Math.min(1440, Number(req.body.asr_daily_limit_minutes) || 120));
  const language = ['auto', 'zh', 'en'].includes(req.body.asr_language) ? req.body.asr_language : 'auto';
  db.run(
    `UPDATE media_config
        SET image_enabled = ?, image_provider_id = ?, image_model = ?,
            image_size = ?, image_extra_prompt = ?,
            speech_enabled = ?, speech_provider_id = ?, speech_model = ?,
            speech_voice = ?, speech_style = ?,
            asr_enabled = ?, asr_provider_id = ?, asr_model = ?,
            asr_language = ?, asr_daily_limit_minutes = ?,
            updated_at = ?
      WHERE id = 1`,
    [
      req.body.image_enabled === '1' ? 1 : 0,
      Number(req.body.image_provider_id || 0) || null,
      String(req.body.image_model || '').trim() || null,
      String(req.body.image_size || '').trim() || '1024x1024',
      String(req.body.image_extra_prompt || ''),
      req.body.speech_enabled === '1' ? 1 : 0,
      Number(req.body.speech_provider_id || 0) || null,
      String(req.body.speech_model || '').trim() || null,
      String(req.body.speech_voice || '').trim() || 'alloy',
      req.body.speech_style === 'chat' ? 'chat' : 'audio',
      req.body.asr_enabled === '1' ? 1 : 0,
      Number(req.body.asr_provider_id || 0) || null,
      String(req.body.asr_model || '').trim() || null,
      language,
      limitMinutes,
      nowIso()
    ]
  );
  res.redirect('/media');
});

router.get('/tasks', (req, res) => {
  const list = tasks.listTasks();
  const agentList = agents.listAgents('research');
  const progressRows = db.all(
    `SELECT at.agent_id, at.task_id, at.status, at.attempts, at.completions
       FROM agent_tasks at`
  );
  const progressMap = new Map();
  for (const row of progressRows) {
    const key = `${row.agent_id}:${row.task_id}`;
    progressMap.set(key, row);
  }
  res.render('tasks', {
    title: '任务表',
    active: 'tasks',
    tasks: list,
    agents: agentList,
    progressMap,
    added: req.query.added ? String(req.query.added) : null,
    taskError: req.query.error ? String(req.query.error) : null
  });
});

router.post('/tasks', (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const acceptance = String(req.body.acceptance || '').trim();
  const targetAgentId = String(req.body.target_agent_id || '').trim() || null;
  const targetAgent = targetAgentId ? agents.getAgent(targetAgentId) : null;
  const validTarget = targetAgent && targetAgent.status !== 'dead' ? targetAgent.id : null;
  if (title && description && acceptance) {
    const created = tasks.adminAddTask({
      title,
      description,
      acceptance,
      targetAgentId: validTarget,
      longTerm: req.body.long_term === '1'
    });
    const targetText = validTarget ? `，已下发给 ${validTarget}` : '，已下发给所有 AI';
    return res.redirect(`/tasks?added=${encodeURIComponent(`#${created?.seq || ''} ${title}${targetText}`)}`);
  }
  res.redirect(`/tasks?error=${encodeURIComponent('标题、描述和验收标准都必须填写')}`);
});

router.post('/tasks/:id/update', (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const acceptance = String(req.body.acceptance || '').trim();
  if (title && description && acceptance) {
    tasks.adminUpdateTask(Number(req.params.id), { title, description, acceptance });
  }
  res.redirect('/tasks');
});

router.post('/tasks/:id/delete', (req, res) => {
  tasks.adminDeleteTask(Number(req.params.id));
  res.redirect('/tasks');
});

router.get('/deaths', (req, res) => {
  const list = death.listDeaths().map((row) => {
    const zipPath = row.zip_path || death.deathZipPath(row.agent_id);
    let size = 0;
    try {
      if (fs.existsSync(zipPath)) size = fs.statSync(zipPath).size;
    } catch {
      // ignore
    }
    return { ...row, zip_exists: fs.existsSync(zipPath), zip_size: size, zip_name: path.basename(zipPath) };
  });
  res.render('deaths', { title: '死亡档案', active: 'deaths', deaths: list });
});

router.get('/deaths/:agentId/download', (req, res) => {
  const zipPath = death.getDeathFile(req.params.agentId);
  if (!zipPath) return res.status(404).render('error', { title: '未找到', message: '归档不存在' });
  res.download(zipPath);
});

router.get('/stats', (req, res) => {
  const byKind = db.all(
    `SELECT kind, COUNT(*) AS count, COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(billed_tokens),0) AS billed,
            COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors
       FROM requests GROUP BY kind ORDER BY kind`
  );
  const perAgent = db.all(
    `SELECT a.id, a.status, a.balance, a.initial_balance,
            COUNT(r.id) AS requests,
            COALESCE(SUM(r.total_tokens),0) AS tokens,
            COALESCE(SUM(r.billed_tokens),0) AS billed,
            COALESCE(SUM(CASE WHEN r.status != 'ok' THEN 1 ELSE 0 END),0) AS errors
       FROM agents a LEFT JOIN requests r ON r.agent_id = a.id
      GROUP BY a.id ORDER BY a.seq`
  );
  const recent = db.all(
    `SELECT id, agent_id, kind, model, total_tokens, billed_tokens, latency_ms, status, error, created_at
       FROM requests ORDER BY id DESC LIMIT 100`
  );
  res.render('stats', {
    title: '统计',
    active: 'stats',
    byKind,
    perAgent,
    recent
  });
});

router.get('/corpus', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(config.publicCorpusDir, { withFileTypes: true }).map((entry) => {
      const full = path.join(config.publicCorpusDir, entry.name);
      const stat = fs.statSync(full);
      return { name: entry.name, isDir: entry.isDirectory(), size: stat.size };
    });
  } catch {
    files = [];
  }
  res.render('corpus', {
    title: '公共语料',
    active: 'corpus',
    files
  });
});

router.post('/corpus', upload.array('corpus', 50), asyncHandler(async (req, res) => {
  for (const file of req.files || []) {
    const target = path.join(config.publicCorpusDir, path.basename(file.originalname));
    try {
      fs.renameSync(file.path, target);
    } catch {
      try {
        fs.copyFileSync(file.path, target);
        fs.unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
  }
  res.redirect('/corpus');
}));

router.get('/api/status', asyncHandler(async (req, res) => {
  const dockerOk = await docker.isAvailable();
  const counts = db.get(
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE status != 'dead') AS alive,
       (SELECT COUNT(*) FROM agents WHERE status = 'dead') AS dead,
       (SELECT COUNT(*) FROM requests) AS requests
    `
  );
  res.json({ docker: dockerOk, ...counts, time: nowIso() });
}));

function beginSse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function keepAlive(res) {
  return setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // ignore
    }
  }, 20000);
}

router.get('/logs', (req, res) => {
  const tab = req.query.tab === 'ai' ? 'ai' : 'server';
  const list = agents.listAgents();
  const requested = String(req.query.agent || 'all');
  const agent = requested === 'all' || list.some((item) => item.id === requested)
    ? requested
    : 'all';
  res.render('logs', {
    title: '日志',
    active: 'logs',
    tab,
    agent,
    agents: list
  });
});

router.get('/logs/server/stream', (req, res) => {
  beginSse(res);
  for (const line of logger.tailServerLines(500)) {
    res.write(`data: ${JSON.stringify({ line, stream: 'file', agent: null })}\n\n`);
  }
  const unsubscribe = events.on('server-log', (event) => {
    res.write(`data: ${JSON.stringify({
      line: event.line,
      stream: event.stream,
      at: event.at,
      agent: null
    })}\n\n`);
  });
  const timer = keepAlive(res);
  req.on('close', () => {
    clearInterval(timer);
    unsubscribe();
  });
});

router.get('/logs/ai/stream', (req, res) => {
  const selected = String(req.query.agent || 'all');
  const list = agents.listAgents();
  const selectedAgents = selected === 'all'
    ? list
    : list.filter((item) => item.id === selected);
  const allowed = new Set(selectedAgents.map((item) => item.id));

  beginSse(res);
  for (const agent of selectedAgents) {
    const file = path.join(config.logsDir, `${agent.id}.log`);
    for (const line of tailFileLines(file, 300)) {
      res.write(`data: ${JSON.stringify({ line, stream: 'file', agent: agent.id })}\n\n`);
    }
  }

  const unsubscribe = events.on('agent-log', (event) => {
    if (!allowed.has(event.agent_id)) return;
    const line = `[${formatDate(event.at || nowIso())}] ${event.line}`;
    res.write(`data: ${JSON.stringify({
      line,
      stream: event.stream,
      at: event.at,
      agent: event.agent_id
    })}\n\n`);
  });
  const timer = keepAlive(res);
  req.on('close', () => {
    clearInterval(timer);
    unsubscribe();
  });
});

router.get('/logs/download', asyncHandler(async (req, res, next) => {
  const type = req.query.type === 'ai' ? 'ai' : 'server';

  if (type === 'server') {
    const file = logger.serverLogPath();
    if (!fs.existsSync(file)) {
      return res.status(404).render('error', { title: '未找到', message: '服务端日志不存在' });
    }
    return res.download(file, 'server.log');
  }

  const selected = String(req.query.agent || 'all');
  if (selected !== 'all') {
    const file = path.join(config.logsDir, `${selected}.log`);
    if (!fs.existsSync(file)) {
      return res.status(404).render('error', { title: '未找到', message: 'AI 日志不存在' });
    }
    return res.download(file, `${selected}.log`);
  }

  const files = agents.listAgents()
    .map((agent) => ({
      id: agent.id,
      file: path.join(config.logsDir, `${agent.id}.log`)
    }))
    .filter((item) => fs.existsSync(item.file));
  if (!files.length) {
    return res.status(404).render('error', { title: '未找到', message: '暂无 AI 日志' });
  }

  res.attachment('ai-logs.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (error) => {
    if (!res.headersSent) next(error);
    else res.destroy();
  });
  archive.pipe(res);
  for (const item of files) {
    archive.file(item.file, { name: `${item.id}.log` });
  }
  await archive.finalize();
}));

module.exports = router;
