const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const docker = require('./docker');
const llm = require('./llm');
const prompts = require('./prompts');
const tasks = require('./tasks');
const billing = require('./billing');
const { addEvent, notifyAgent } = require('./events');
const {
  nowIso,
  ensureDir,
  randomKey,
  toInt,
  safeJoin,
  formatBytes
} = require('./util');

function agentRoot(agentId) {
  return path.join(config.workspacesDir, agentId);
}

function workspaceDir(agentId) {
  return path.join(agentRoot(agentId), 'workspace');
}

function stateDir(agentId) {
  return path.join(workspaceDir(agentId), '.agent');
}

function corpusDir(agentId) {
  return path.join(workspaceDir(agentId), 'corpus');
}

// 新 AI 的规则文件：宿主机路径，容器内挂载为 /PLATFORM_RULES.md
function rulesFile(agentId) {
  return path.join(agentRoot(agentId), 'platform_rules.md');
}

function listAgents() {
  return db.all(
    `SELECT a.*, p.name AS provider_name,
       (SELECT COUNT(*) FROM requests r WHERE r.agent_id = a.id) AS request_count,
       (SELECT COALESCE(SUM(r.total_tokens),0) FROM requests r WHERE r.agent_id = a.id) AS total_tokens,
       (SELECT t.title FROM tasks t WHERE t.id = a.current_task_id) AS task_title
     FROM agents a
     LEFT JOIN providers p ON p.id = a.provider_id
     ORDER BY a.seq ASC`
  );
}

function getAgent(agentId) {
  return db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
}

function getAgentWithProvider(agentId) {
  return db.get(
    `SELECT a.*, p.name AS provider_name, p.base_url AS provider_base_url, p.models AS provider_models
       FROM agents a LEFT JOIN providers p ON p.id = a.provider_id
      WHERE a.id = ?`,
    [agentId]
  );
}

function getProvider(providerId) {
  return db.get('SELECT * FROM providers WHERE id = ?', [providerId]);
}

function nextSeq() {
  const row = db.get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agents');
  return Number(row?.seq || 1);
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return base || 'file';
}

function uniqueFilePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function writeAgentConfig(agent) {
  const root = workspaceDir(agent.id);
  const state = stateDir(agent.id);
  ensureDir(root);
  ensureDir(state);
  ensureDir(corpusDir(agent.id));

  const agentConfig = {
    id: agent.id,
    seq: agent.seq,
    goal: agent.goal,
    rules: agent.rules,
    extraRules: agent.extra_rules || '',
    persona: agent.persona || '',
    promptMode: agent.prompt_mode || 'inline',
    rulesFile: agent.prompt_mode === 'file' ? prompts.RULES_FILE_PATH : null,
    manualTasks: Boolean(agent.manual_tasks),
    model: agent.model,
    modelType: agent.model_type || 'text',
    initialBalance: agent.initial_balance,
    allowInternet: Boolean(agent.allow_internet),
    unlimitedTokens: Boolean(agent.unlimited_tokens),
    enableScreen: Boolean(agent.enable_screen),
    visionMode: agent.vision_mode || 'none',
    visionBill: Boolean(agent.vision_bill),
    screen: agent.enable_screen
      ? { display: ':99', width: config.screenWidth, height: config.screenHeight }
      : null,
    backendUrl: `http://egress:${config.backendPort}`,
    pauseMaxMinutes: config.pauseMaxMinutes,
    crashMaxRetries: Number(agent.crash_unlimited)
      ? null
      : (agent.crash_max_retries == null ? config.crashMaxRetries : Number(agent.crash_max_retries)),
    crashUnlimited: Boolean(agent.crash_unlimited),
    oracleCostMultiplier: config.oracleCostMultiplier,
    contextKeepRecent: config.contextKeepRecent,
    maxOutputTokens: config.maxOutputTokens,
    paths: {
      workspace: '/workspace',
      tempWorkspace: '/tmp_workspace',
      state: '/workspace/.agent'
    },
    createdAt: agent.created_at
  };

  fs.writeFileSync(
    path.join(state, 'config.json'),
    JSON.stringify(agentConfig, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(state, 'system_prompt.md'),
    prompts.buildAgentSystemPrompt(agent),
    'utf8'
  );

  // 新 AI：规则写成容器根目录的规则文件，供 AI 在不清楚规则时随时查阅。
  if (agent.prompt_mode === 'file') {
    fs.writeFileSync(rulesFile(agent.id), prompts.buildAgentRulesFile(agent), 'utf8');
  }

  const stateFile = path.join(state, 'state.json');
  if (!fs.existsSync(stateFile)) {
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          messages: [],
          pauseUntil: null,
          toolMode: 'auto',
          taskId: null,
          createdAt: nowIso()
        },
        null,
        2
      ),
      'utf8'
    );
  }
}

function copyCorpusFiles(agentId, files = []) {
  if (!files.length) return [];
  const dir = corpusDir(agentId);
  ensureDir(dir);
  const saved = [];
  for (const file of files) {
    if (!file?.path) continue;
    const target = uniqueFilePath(dir, sanitizeFileName(file.originalname));
    fs.copyFileSync(file.path, target);
    saved.push(path.basename(target));
    try {
      fs.unlinkSync(file.path);
    } catch {
      // ignore
    }
  }
  if (saved.length) {
    addEvent(agentId, 'corpus', `追加语料 ${saved.length} 个文件。`, { files: saved });
  }
  return saved;
}

function writeCorpusNote(agentId, note, files = []) {
  const dir = corpusDir(agentId);
  ensureDir(dir);
  const text = [
    '# 上传说明',
    `- 时间：${nowIso()}`,
    `- 文件：${files.join(', ') || '无'}`,
    '',
    '## 注释',
    note || '无',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'README.md'), text, 'utf8');
  if (note) {
    const notice = `管理员在创建时上传了资料：${files.join(', ') || '无'}。说明：${note}`.slice(0, 8000);
    db.run('UPDATE agents SET notice = ?, notice_at = ? WHERE id = ?', [notice, nowIso(), agentId]);
  }
  addEvent(agentId, 'upload', `创建时上传 ${files.length} 个语料文件。`, { files, note });
}

function uploadDir(agentId) {
  return path.join(workspaceDir(agentId), 'uploads');
}

function addUploads(agentId, files = [], { note = '', extraRules = '' } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    throw new Error('该 AI 已死亡或正在归档，不能上传');
  }

  const cleanNote = String(note || '').trim();
  const cleanExtra = String(extraRules || '').trim();
  const stamp = nowIso().replace(/[:.]/g, '-');
  const dir = path.join(uploadDir(agentId), stamp);
  ensureDir(dir);

  const saved = [];
  for (const file of files) {
    if (!file?.path) continue;
    const target = uniqueFilePath(dir, sanitizeFileName(file.originalname));
    fs.copyFileSync(file.path, target);
    saved.push(path.basename(target));
    try {
      fs.unlinkSync(file.path);
    } catch {
      // ignore
    }
  }

  if (!saved.length && !cleanNote && !cleanExtra) {
    throw new Error('没有可上传的文件、注释或补充规则');
  }

  const noteLines = [
    '# 上传说明',
    `- 时间：${nowIso()}`,
    `- 文件数：${saved.length}`,
    `- 文件：${saved.join(', ') || '无'}`,
    '',
    '## 注释',
    cleanNote || '无',
    ''
  ];
  if (cleanExtra) noteLines.push('## 补充规则', cleanExtra, '');
  fs.writeFileSync(path.join(dir, 'README.md'), noteLines.join('\n'), 'utf8');

  if (cleanExtra) {
    const merged = [agent.extra_rules, cleanExtra].filter(Boolean).join('\n');
    db.run('UPDATE agents SET extra_rules = ? WHERE id = ?', [merged, agentId]);
    writeAgentConfig(getAgent(agentId));
  }

  const noticeParts = [];
  if (saved.length) {
    noticeParts.push(`管理员上传了 ${saved.length} 个文件到 /workspace/uploads/${stamp}/：${saved.join(', ')}。`);
  }
  if (cleanNote) noticeParts.push(`上传注释：${cleanNote}`);
  if (cleanExtra) noticeParts.push(`补充规则已加入平台规则并立即生效：${cleanExtra}`);
  const notice = noticeParts.join('\n').slice(0, 8000);
  db.run('UPDATE agents SET notice = ?, notice_at = ? WHERE id = ?', [notice, nowIso(), agentId]);
  addEvent(agentId, 'upload', noticeParts.join(' ') || `上传 ${saved.length} 个文件。`, {
    files: saved,
    note: cleanNote,
    extraRules: cleanExtra,
    dir: `/workspace/uploads/${stamp}`
  });

  return { files: saved, dir: `/workspace/uploads/${stamp}`, notice };
}

async function createAgent({
  goal,
  rules,
  extraRules = '',
  persona = '',
  providerId,
  model,
  initialBalance,
  allowInternet = false,
  unlimitedTokens = false,
  enableScreen = false,
  visionMode = 'none',
  visionProviderId = null,
  visionModel = null,
  visionBill = false,
  manualTasks = false,
  uploadNote = '',
  corpusFiles = []
}) {
  const cleanGoal = String(goal || '').trim();
  const cleanRules = String(rules || '').trim();
  const cleanExtraRules = String(extraRules || '').trim();
  const cleanPersona = String(persona || '').trim().slice(0, 4000);
  const cleanUploadNote = String(uploadNote || '').trim();
  if (!cleanGoal) throw new Error('研究目标不能为空');
  if (!cleanRules) throw new Error('平台规则不能为空');

  const provider = getProvider(providerId);
  if (!provider) throw new Error('供应商不存在');
  if (!provider.api_key) throw new Error('供应商尚未填写 API Key');
  if (!model) throw new Error('必须选择模型');

  const textModels = llm.parseModels(provider.models);
  const multimodalModels = llm.parseMultimodalModels(provider.multimodal_models);
  let modelType = 'text';
  if (multimodalModels.includes(model)) {
    modelType = 'multimodal';
  } else if (!textModels.includes(model)) {
    throw new Error('模型不在该供应商的文本或多模态模型列表中');
  }

  const mode = ['none', 'main', 'shared', 'private'].includes(visionMode)
    ? visionMode
    : 'none';
  let visionProvider = null;
  let visionModelName = null;
  let visionBillFlag = 0;

  if (mode === 'main') {
    if (modelType !== 'multimodal') {
      throw new Error('只有多模态主模型可以使用主模型识图');
    }
    visionProvider = provider.id;
    visionModelName = model;
    visionBillFlag = 1;
  } else if (mode === 'private') {
    const privateProvider = getProvider(visionProviderId);
    if (!privateProvider) throw new Error('私用识图供应商不存在');
    if (!privateProvider.api_key) throw new Error('私用识图供应商未填写 API Key');
    const visionModels = llm.parseVisionModels(privateProvider.vision_models);
    const privateMultimodal = llm.parseMultimodalModels(privateProvider.multimodal_models);
    if (!visionModels.includes(visionModel) && !privateMultimodal.includes(visionModel)) {
      throw new Error('识图模型不在该供应商的识图或多模态模型列表中');
    }
    visionProvider = privateProvider.id;
    visionModelName = visionModel;
    visionBillFlag = visionBill ? 1 : 0;
  }

  const balance = Math.max(1, toInt(initialBalance, config.defaultInitialBalance));
  const seq = nextSeq();
  const id = `AI-${String(seq).padStart(3, '0')}`;
  const apiKey = randomKey();
  const createdAt = nowIso();

  db.run(
    `INSERT INTO agents
      (id, seq, goal, rules, provider_id, model, model_type, initial_balance, balance, status, api_key,
       allow_internet, unlimited_tokens, enable_screen, vision_mode, vision_provider_id, vision_model,
       vision_bill, extra_rules, manual_tasks, persona, prompt_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file', ?)`,
    [
      id,
      seq,
      cleanGoal,
      cleanRules,
      provider.id,
      model,
      modelType,
      balance,
      balance,
      apiKey,
      allowInternet ? 1 : 0,
      unlimitedTokens ? 1 : 0,
      enableScreen ? 1 : 0,
      mode,
      visionProvider,
      visionModelName,
      visionBillFlag,
      cleanExtraRules,
      manualTasks ? 1 : 0,
      cleanPersona || null,
      createdAt
    ]
  );

  const agent = getAgent(id);
  writeAgentConfig(agent);
  const savedCorpus = copyCorpusFiles(id, corpusFiles);
  if (savedCorpus.length || cleanUploadNote) {
    writeCorpusNote(id, cleanUploadNote, savedCorpus);
  }
  tasks.ensureAgentTaskRows(id);
  addEvent(id, 'created', `AI ${id} 已创建，初始额度 ${unlimitedTokens ? '无限' : `${balance.toLocaleString('en-US')} tokens`}。`, {
    model,
    modelType,
    provider: provider.name,
    balance,
    allowInternet: Boolean(allowInternet),
    unlimitedTokens: Boolean(unlimitedTokens),
    enableScreen: Boolean(enableScreen),
    visionMode: mode,
    manualTasks: Boolean(manualTasks),
    extraRules: Boolean(cleanExtraRules)
  });

  let result = getAgent(id);
  try {
    result = await startAgent(id);
  } catch (error) {
    addEvent(id, 'docker_error', `容器创建失败：${error.message}`);
    db.run("UPDATE agents SET status = 'created' WHERE id = ?", [id]);
    result = getAgent(id);
  }

  try {
    if (!manualTasks) {
      await tasks.maybeRefillTasks({ initial: true });
    }
    tasks.refreshCurrentTask(id);
  } catch {
    // 任务生成失败不影响创建
  }

  return getAgent(id);
}

async function startAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.status === 'dead') throw new Error('AI 已死亡');

  // 每次启动都刷新容器内的 config.json 与 system_prompt.md，
  // 确保提示词（工具清单、记忆规范等）与后端代码保持一致。
  writeAgentConfig(agent);

  let containerId = agent.container_id;
  let info = containerId ? await docker.inspectContainer(containerId) : null;

  if (!info) {
    const created = await docker.createAgentContainer(agent, {
      hostWorkspace: workspaceDir(agent.id),
      hostRulesFile: agent.prompt_mode === 'file' ? rulesFile(agent.id) : null
    });
    containerId = created.containerId;
  } else if (!info.State?.Running) {
    await docker.startContainer(containerId);
  }

  try {
    await docker.fixGithubHosts(containerId);
  } catch {
    // 修复失败不影响启动
  }

  db.run(
    `UPDATE agents
        SET container_id = ?,
            status = CASE WHEN status = 'dying' THEN 'dying' ELSE 'running' END,
            last_start_at = ?,
            notice = NULL,
            notice_at = NULL
      WHERE id = ?`,
    [containerId, nowIso(), agentId]
  );

  try {
    require('./supervisor').attachLogs(agentId);
  } catch {
    // supervisor 尚未初始化时忽略
  }

  addEvent(agentId, 'started', `AI ${agentId} 容器已启动。`);
  return getAgent(agentId);
}

async function restartAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    throw new Error('AI 已死亡，不能重启');
  }
  if (agent.status === 'paused_disk') {
    throw new Error('AI 处于磁盘暂停，请先恢复');
  }

  const clean = Number(agent.clean_on_restart || 0) === 1;
  addEvent(
    agentId,
    'restart',
    clean ? '管理员重启：清理容器后重建（工作区保留）。' : '管理员重启：复用现有容器（保留容器内的改动）。'
  );

  // 先置为 created，避免 supervisor 把这次主动重启当作崩溃
  db.run("UPDATE agents SET status = 'created' WHERE id = ?", [agentId]);

  if (clean && agent.container_id) {
    try {
      await docker.removeContainer(agent.container_id, true);
    } catch (error) {
      addEvent(agentId, 'restart_error', `清理容器失败：${error.message}`);
    }
    db.run('UPDATE agents SET container_id = NULL WHERE id = ?', [agentId]);
  } else if (agent.container_id) {
    const info = await docker.inspectContainer(agent.container_id).catch(() => null);
    if (info?.State?.Running) {
      await docker.stopContainer(agent.container_id);
    }
  }

  return startAgent(agentId);
}

function setCleanOnRestart(agentId, enabled) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  const value = enabled ? 1 : 0;
  if (Number(agent.clean_on_restart || 0) === value) return agent;
  db.run('UPDATE agents SET clean_on_restart = ? WHERE id = ?', [value, agentId]);
  addEvent(
    agentId,
    'setting',
    value ? '已开启：重启/重建时清理容器（工作区保留）。' : '已关闭：重启/重建时保留容器内的改动。'
  );
  notifyAgent(
    agentId,
    value
      ? '管理员修改了容器重启策略：重启时会删除并重建容器，容器内（工作区以外）安装的软件与改动会丢失。'
      : '管理员修改了容器重启策略：重启时会复用现有容器，容器内安装的软件与改动会保留。'
  );
  return getAgent(agentId);
}

function setModels(agentId, { providerId, model, fallbackProviderId, fallbackModel }) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');

  const provider = getProvider(Number(providerId));
  if (!provider) throw new Error('主模型供应商不存在');
  const modelName = String(model || '').trim();
  if (!modelName) throw new Error('必须填写主模型');
  const models = llm.parseModels(provider.models);
  if (models.length && !models.includes(modelName)) {
    throw new Error(`供应商「${provider.name}」没有模型 ${modelName}`);
  }

  const fallbackId = fallbackProviderId ? Number(fallbackProviderId) : null;
  const fallbackName = String(fallbackModel || '').trim();
  let fallbackProvider = null;
  if (fallbackId) {
    fallbackProvider = getProvider(fallbackId);
    if (!fallbackProvider) throw new Error('副模型供应商不存在');
    if (!fallbackName) throw new Error('选择了副模型供应商时必须填写副模型');
    const fbModels = llm.parseModels(fallbackProvider.models);
    if (fbModels.length && !fbModels.includes(fallbackName)) {
      throw new Error(`供应商「${fallbackProvider.name}」没有模型 ${fallbackName}`);
    }
  }

  db.run(
    'UPDATE agents SET provider_id = ?, model = ?, fallback_provider_id = ?, fallback_model = ? WHERE id = ?',
    [provider.id, modelName, fallbackProvider ? fallbackProvider.id : null, fallbackProvider ? fallbackName : null, agentId]
  );

  const updated = getAgent(agentId);
  writeAgentConfig(updated);
  addEvent(
    agentId,
    'model',
    `主模型：${provider.name} / ${modelName}；副模型：${fallbackProvider ? `${fallbackProvider.name} / ${fallbackName}` : '未设置'}。`
  );
  return getAgentWithProvider(agentId);
}

async function resumeAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.status !== 'paused_disk') throw new Error('只有磁盘暂停的 AI 可以恢复');
  if (agent.container_id) {
    try {
      await docker.unpauseContainer(agent.container_id);
    } catch {
      await docker.startContainer(agent.container_id);
    }
  }
  db.run(
    "UPDATE agents SET status = 'running', last_start_at = ? WHERE id = ?",
    [nowIso(), agentId]
  );
  addEvent(agentId, 'resumed', `AI ${agentId} 已从磁盘暂停恢复。`);
  return getAgent(agentId);
}

function recharge(agentId, amount) {
  const delta = Math.max(0, Number(amount) || 0);
  const updated = billing.recharge(agentId, delta, 'admin');
  if (updated && delta > 0) {
    const text = updated.unlimited_tokens
      ? `管理员为你充值 ${delta.toLocaleString('en-US')} tokens，但你的额度为无限，余额不变。`
      : `管理员为你充值 ${delta.toLocaleString('en-US')} tokens，当前余额 ${Number(updated.balance || 0).toLocaleString('en-US')} tokens。`;
    notifyAgent(agentId, text);
  }
  return updated;
}

function effectiveCrashLimit(agent) {
  if (Number(agent.crash_unlimited)) return null;
  return agent.crash_max_retries == null ? config.crashMaxRetries : Number(agent.crash_max_retries);
}

function updateCrashLimit(agentId, { limit = null, unlimited = false } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    throw new Error('该 AI 已死亡或正在归档，不能修改');
  }
  const current = effectiveCrashLimit(agent);

  if (unlimited) {
    if (current === null) throw new Error('该 AI 已经是无限崩溃重启');
    db.run(
      'UPDATE agents SET crash_unlimited = 1, crash_max_retries = ? WHERE id = ?',
      [current, agentId]
    );
    writeAgentConfig(getAgent(agentId));
    notifyAgent(agentId, `管理员已将你的崩溃重启上限从 ${current} 次改为无限（不会因连续崩溃死亡）。`);
    addEvent(agentId, 'crash_limit', `崩溃重启上限：${current} → 无限。`);
    return getAgent(agentId);
  }

  const next = Number(limit);
  if (!Number.isInteger(next) || next < 1) throw new Error('崩溃重启上限必须是正整数');
  if (current === null) throw new Error('该 AI 已是无限重启，不能改回有限值');
  if (next < current) throw new Error(`崩溃重启上限只能增加，当前为 ${current} 次`);
  if (next === current) return agent;

  db.run(
    'UPDATE agents SET crash_max_retries = ?, crash_unlimited = 0 WHERE id = ?',
    [next, agentId]
  );
  writeAgentConfig(getAgent(agentId));
  notifyAgent(agentId, `管理员已将你的崩溃重启上限从 ${current} 次提高到 ${next} 次。`);
  addEvent(agentId, 'crash_limit', `崩溃重启上限：${current} → ${next}。`);
  return getAgent(agentId);
}

function resetCrashAttempts(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    throw new Error('该 AI 已死亡或正在归档，不能重置');
  }
  const before = Number(agent.crash_attempts || 0);
  if (!before) return agent;
  db.run('UPDATE agents SET crash_attempts = 0 WHERE id = ?', [agentId]);
  notifyAgent(agentId, `管理员已将你的崩溃计数从 ${before} 重置为 0。`);
  addEvent(agentId, 'crash_reset', `崩溃计数：${before} → 0。`);
  return getAgent(agentId);
}

function addCorpus(agentId, files) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  return copyCorpusFiles(agentId, files);
}

function listEvents(agentId, limit = 100) {
  return db.all(
    'SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?',
    [agentId, limit]
  );
}

function recentRequests(agentId, limit = 50) {
  return db.all(
    `SELECT id, agent_id, kind, provider_id, model, prompt_tokens, completion_tokens,
            reasoning_tokens, total_tokens, billed_tokens, latency_ms, status, error,
            compressed, created_at,
            substr(request_json, 1, 6000) AS request_preview,
            substr(response_json, 1, 6000) AS response_preview
       FROM requests
      WHERE agent_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [agentId, limit]
  );
}

function submissions(agentId, limit = 100) {
  return db.all(
    `SELECT s.*, t.title AS task_title, t.seq AS task_seq
       FROM submissions s LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.agent_id = ? ORDER BY s.id DESC LIMIT ?`,
    [agentId, limit]
  );
}

function taskProgress(agentId) {
  return tasks.taskProgress(agentId);
}

function usageSummary(agentId) {
  return billing.usageSummary(agentId);
}

function kbInfo(agentId) {
  const root = path.join(stateDir(agentId), 'kb');
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  const result = [];
  for (const entry of entries) {
    const metaPath = path.join(root, entry.name, 'meta.json');
    let meta = { name: entry.name, chunks: 0, sources: [], createdAt: null };
    try {
      meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
    } catch {
      // ignore
    }
    result.push(meta);
  }
  return result;
}

function fileRoots(agentId) {
  return {
    workspace: workspaceDir(agentId),
    shared: config.tmpWorkspaceDir
  };
}

function listFiles(agentId, rootName, relative = '') {
  const roots = fileRoots(agentId);
  const root = roots[rootName];
  if (!root) throw new Error('未知的文件根目录');
  const target = safeJoin(root, relative);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error('不是目录');
  const entries = fs.readdirSync(target, { withFileTypes: true });
  return entries
    .map((entry) => {
      const full = path.join(target, entry.name);
      let size = 0;
      try {
        size = entry.isFile() ? fs.statSync(full).size : 0;
      } catch {
        // ignore
      }
      return {
        name: entry.name,
        isDir: entry.isDirectory(),
        size
      };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
}

function resolveFile(agentId, rootName, relative) {
  const roots = fileRoots(agentId);
  const root = roots[rootName];
  if (!root) throw new Error('未知的文件根目录');
  return safeJoin(root, relative);
}

function diskUsage(agentId) {
  const ws = workspaceDir(agentId);
  let size = 0;
  try {
    const stack = [ws];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) size += fs.statSync(full).size;
      }
    }
  } catch {
    // ignore
  }
  return {
    bytes: size,
    limit: config.agentDiskLimitBytes,
    percent: config.agentDiskLimitBytes ? size / config.agentDiskLimitBytes : 0,
    text: formatBytes(size)
  };
}

module.exports = {
  agentRoot,
  workspaceDir,
  stateDir,
  corpusDir,
  rulesFile,
  uploadDir,
  listAgents,
  getAgent,
  getAgentWithProvider,
  getProvider,
  createAgent,
  startAgent,
  restartAgent,
  setCleanOnRestart,
  setModels,
  resumeAgent,
  recharge,
  effectiveCrashLimit,
  updateCrashLimit,
  resetCrashAttempts,
  addCorpus,
  addUploads,
  listEvents,
  recentRequests,
  submissions,
  taskProgress,
  usageSummary,
  kbInfo,
  listFiles,
  resolveFile,
  fileRoots,
  diskUsage,
  writeAgentConfig,
  copyCorpusFiles
};
