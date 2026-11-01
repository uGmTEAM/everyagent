const express = require('express');
const db = require('../db');
const config = require('../config');
const billing = require('../billing');
const tasks = require('../tasks');
const judge = require('../judge');
const oracle = require('../oracle');
const vision = require('../vision');
const media = require('../media');
const events = require('../events');
const inbox = require('../inbox');
const companion = require('../companion');
const reminders = require('../reminders');
const prompts = require('../prompts');
const { authAgent } = require('../proxy');
const { nowIso, truncate, fingerprintText } = require('../util');

const router = express.Router();
const locks = new Map();

function withAgentLock(agentId, fn) {
  const previous = locks.get(agentId) || Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(agentId, next.catch(() => {}));
  return next;
}

router.use((req, res, next) => {
  const agent = authAgent(req);
  if (!agent) {
    return res.status(401).json({ error: { message: '无效的 AGENT_KEY' } });
  }
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    return res.status(410).json({ error: { message: '该 AI 已死亡' } });
  }
  req.agent = agent;
  next();
});

router.get('/me', (req, res) => {
  const agent = billing.getAgent(req.agent.id);
  const task = tasks.getCurrentTask(agent.id);
  if ((task?.id || null) !== agent.current_task_id) {
    db.run('UPDATE agents SET current_task_id = ? WHERE id = ?', [task?.id || null, agent.id]);
  }
  const notice = events.takeNotice(agent.id);
  const adminMessages = events.takeAdminMessages(agent.id);
  const noticeText = [
    notice,
    ...adminMessages.map((message) => {
      const base = `管理员留言（不是任务，不需要 submit_task；如需回复请调用 message_admin）：${message.content}`;
      return message.compensation
        ? `${base}\n（平台已强制唤醒你并补偿 ${Number(message.compensation).toLocaleString('en-US')} tokens）`
        : base;
    })
  ].filter(Boolean).join('\n');
  const forceWake = Boolean(Number(agent.wake_requested));
  if (forceWake) db.run('UPDATE agents SET wake_requested = 0 WHERE id = ?', [agent.id]);
  const maxCrashRetries = Number(agent.crash_unlimited)
    ? null
    : (agent.crash_max_retries == null ? config.crashMaxRetries : Number(agent.crash_max_retries));
  const deadline = agent.dying_deadline ? Date.parse(agent.dying_deadline) : null;
  res.json({
    id: agent.id,
    status: agent.status,
    balance: agent.unlimited_tokens ? null : Number(agent.balance || 0),
    initial_balance: Number(agent.initial_balance || 0),
    unlimited: Boolean(agent.unlimited_tokens),
    allow_internet: Boolean(agent.allow_internet),
    model_type: agent.model_type || 'text',
    enable_screen: Boolean(agent.enable_screen),
    vision_mode: agent.vision_mode || 'none',
    vision_bill: Boolean(agent.vision_bill),
    warnings: billing.activeWarnings(agent),
    current_task: task
      ? {
          id: task.id,
          seq: task.seq,
          title: task.title,
          description: task.description,
          acceptance: task.acceptance,
          long_term: Boolean(Number(task.long_term)),
          completions: Number(task.completions || 0)
        }
      : null,
    dying: !agent.unlimited_tokens && agent.status === 'dying' && deadline
      ? { deadline: new Date(deadline).toISOString(), remaining_ms: Math.max(0, deadline - Date.now()) }
      : null,
    notice: noticeText || null,
    force_wake: forceWake,
    crash_attempts: Number(agent.crash_attempts || 0),
    max_crash_retries: maxCrashRetries,
    pause_max_minutes: config.pauseMaxMinutes,
    oracle_cost_multiplier: config.oracleCostMultiplier,
    server_time: nowIso()
  });
});

router.get('/task', (req, res) => {
  const task = tasks.getCurrentTask(req.agent.id);
  res.json({ task: task || null });
});

router.post('/submit', async (req, res) => {
  const agentId = req.agent.id;
  await withAgentLock(agentId, async () => {
    try {
      const body = req.body || {};
      const content = truncate(String(body.content || '').trim(), 400000);
      if (!content) {
        return res.status(400).json({ error: { message: '提交内容不能为空' } });
      }

      const files = Array.isArray(body.files)
        ? body.files
            .filter((file) => file && typeof file === 'object')
            .map((file) => ({
              path: truncate(String(file.path || ''), 500),
              content: truncate(String(file.content || ''), 200000)
            }))
            .slice(0, 20)
        : [];

      const agent = billing.getAgent(agentId);
      const task = tasks.getCurrentTask(agentId);
      if (!task) {
        return res.status(409).json({ error: { message: '当前没有可提交的任务' } });
      }

      const fingerprint = fingerprintText(content);
      const duplicate = tasks.detectDuplicate(agentId, task.id, { fingerprint, content });
      const prior = tasks.priorSubmissions(agentId, task.id, 5);
      const insert = db.run(
        `INSERT INTO submissions (agent_id, task_id, content, files_json, fingerprint, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [agentId, task.id, content, JSON.stringify(files), fingerprint, nowIso()]
      );
      const submissionId = Number(insert.lastInsertRowid);

      // 完全重复的提交直接拦截：不调用 Judge、不扣款，避免 AI 反复提交同一份成果。
      if (duplicate.exact) {
        const feedback = `平台拒绝重复提交：本次提交与提交 #${duplicate.exact.id} 内容完全相同（忽略排版和标点），没有调用 Judge，也没有扣款。请按上一次反馈实际修改后再提交。上次反馈：${truncate(String(duplicate.exact.feedback || '无'), 500)}`;
        db.run(
          "UPDATE submissions SET state = 'rejected_duplicate', passed = 0, feedback = ?, judged_at = ? WHERE id = ?",
          [feedback, nowIso(), submissionId]
        );
        judge.recordMemory({
          agentId,
          task,
          submission: { id: submissionId },
          fingerprint,
          decision: { passed: false, deduction: 0, reward: 0, feedback }
        });
        events.addEvent(agentId, 'submission_duplicate', `任务 #${task.seq}「${task.title}」重复提交被拒绝。`, {
          task_id: task.id,
          submission_id: submissionId,
          duplicate_of: duplicate.exact.id
        });
        return res.status(409).json({
          error: { message: feedback },
          passed: false,
          duplicate: true,
          duplicate_of: duplicate.exact.id,
          submission_id: submissionId
        });
      }

      let decision;
      try {
        decision = await judge.judgeSubmission({
          agent,
          task,
          submission: { id: submissionId, content, files, fingerprint },
          priorSubmissions: prior,
          repeat: duplicate
        });
      } catch (error) {
        db.run(
          "UPDATE submissions SET state = 'error', passed = 0, feedback = ?, judged_at = ? WHERE id = ?",
          [`Judge 不可用：${error.message}`, nowIso(), submissionId]
        );
        events.addEvent(agentId, 'judge_error', `任务提交判定失败：${error.message}`, {
          submission_id: submissionId
        });
        return res.status(503).json({
          error: { message: `Judge 不可用：${error.message}` },
          submission_id: submissionId
        });
      }

      tasks.incrementAttempts(agentId, task.id);
      const judgedAt = nowIso();
      db.run(
        `UPDATE submissions
            SET state = ?, passed = ?, feedback = ?, deduction = ?, reward = ?,
                judge_request_id = ?, judged_at = ?
          WHERE id = ?`,
        [
          decision.passed ? 'passed' : 'failed',
          decision.passed ? 1 : 0,
          decision.feedback,
          decision.deduction,
          decision.reward,
          decision.requestId,
          judgedAt,
          submissionId
        ]
      );

      events.addEvent(
        agentId,
        'submission',
        decision.passed
          ? `任务 #${task.seq}「${task.title}」通过，奖励 ${decision.reward.toLocaleString('en-US')} tokens。`
          : `任务 #${task.seq}「${task.title}」未通过，扣除 ${decision.deduction.toLocaleString('en-US')} tokens，需要重做。`,
        {
          task_id: task.id,
          submission_id: submissionId,
          passed: decision.passed,
          deduction: decision.deduction,
          reward: decision.reward,
          feedback: decision.feedback
        }
      );

      let updatedAgent;
      let nextTask = null;
      if (decision.passed) {
        if (decision.reward > 0) {
          updatedAgent = billing.reward(agentId, decision.reward, {
            type: 'judge',
            task_id: task.id
          });
        } else {
          updatedAgent = billing.getAgent(agentId);
        }
        nextTask = tasks.markTaskPassed(agentId, task.id);
        tasks.maybeRefillTasks().catch(() => {});
      } else {
        if (decision.deduction > 0) {
          updatedAgent = billing.deduct(agentId, decision.deduction, {
            type: 'judge',
            task_id: task.id
          });
        } else {
          updatedAgent = billing.getAgent(agentId);
        }
        nextTask = tasks.getCurrentTask(agentId);
      }

      return res.json({
        passed: decision.passed,
        feedback: decision.feedback,
        deduction: decision.deduction,
        reward: decision.reward,
        balance: Number(updatedAgent?.balance || 0),
        status: updatedAgent?.status || agent.status,
        task: nextTask
          ? {
              id: nextTask.id,
              seq: nextTask.seq,
              title: nextTask.title,
              description: nextTask.description,
              acceptance: nextTask.acceptance,
              long_term: Boolean(Number(nextTask.long_term)),
              completions: Number(nextTask.completions || 0)
            }
          : null,
        submission_id: submissionId
      });
    } catch (error) {
      return res.status(500).json({ error: { message: error.message } });
    }
  });
});

router.post('/oracle', async (req, res) => {
  try {
    const question = truncate(String(req.body?.question || '').trim(), 20000);
    if (!question) {
      return res.status(400).json({ error: { message: '问题不能为空' } });
    }
    const agent = billing.getAgent(req.agent.id);
    let estimate = null;
    if (!agent.unlimited_tokens && agent.status !== 'dying') {
      try {
        estimate = oracle.estimateCost(question);
      } catch (error) {
        return res.status(503).json({ error: { message: error.message } });
      }
      if (Number(agent.balance || 0) < estimate.required) {
        return res.status(402).json({
          error: {
            message: '余额不足以覆盖 Oracle 的预估费用',
            required: estimate.required,
            balance: Number(agent.balance || 0)
          }
        });
      }
    }

    let result;
    try {
      result = await oracle.ask(agent, question);
    } catch (error) {
      db.run(
        'INSERT INTO oracle_calls (agent_id, question, answer, oracle_tokens, charged_tokens, status, created_at) VALUES (?, ?, ?, 0, 0, ?, ?)',
        [agent.id, question, null, 'error', nowIso()]
      );
      return res.status(503).json({ error: { message: error.message } });
    }

    const free = agent.status === 'dying';
    const charged = free ? 0 : result.tokens * config.oracleCostMultiplier;
    let updated = agent;
    if (!free && charged > 0) {
      updated = billing.deduct(agent.id, charged, { type: 'oracle', oracle_tokens: result.tokens });
    }

    db.run(
      'INSERT INTO oracle_calls (agent_id, question, answer, oracle_tokens, charged_tokens, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [agent.id, question, result.answer, result.tokens, charged, 'ok', nowIso()]
    );
    events.addEvent(
      agent.id,
      'oracle',
      `调用 Oracle，消耗 ${result.tokens.toLocaleString('en-US')} tokens，扣除 ${charged.toLocaleString('en-US')} tokens。`,
      { oracle_tokens: result.tokens, charged }
    );

    return res.json({
      answer: result.answer,
      oracle_tokens: result.tokens,
      charged_tokens: charged,
      estimated_max_cost: estimate?.required || 0,
      balance: Number(updated.balance || 0),
      status: updated.status
    });
  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
});

router.post('/vision', async (req, res) => {
  try {
    const agent = billing.getAgent(req.agent.id);
    if (agent.vision_mode === 'none') {
      return res.status(400).json({ error: { message: '该 AI 未启用识图' } });
    }

    const imageBase64 = String(req.body?.image_base64 || '');
    if (!imageBase64) {
      return res.status(400).json({ error: { message: 'image_base64 不能为空' } });
    }
    if (imageBase64.length > 30 * 1024 * 1024) {
      return res.status(413).json({ error: { message: '图片过大，请压缩后再发送' } });
    }

    const mimeType = String(req.body?.mime_type || 'image/png');
    const question = truncate(String(req.body?.question || ''), 4000);

    let result;
    try {
      result = await vision.describe(agent, { imageBase64, mimeType, question });
    } catch (error) {
      return res.status(503).json({ error: { message: error.message } });
    }

    const updated = billing.getAgent(agent.id);
    return res.json({
      description: result.description,
      usage: result.usage,
      charged_tokens: result.charged,
      vision_mode: result.mode,
      provider: result.provider,
      model: result.model,
      balance: updated.unlimited_tokens ? null : Number(updated.balance || 0),
      unlimited: Boolean(updated.unlimited_tokens)
    });
  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
});

router.post('/image', async (req, res) => {
  try {
    const agent = billing.getAgent(req.agent.id);
    const prompt = truncate(String(req.body?.prompt || '').trim(), 4000);
    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt 不能为空' } });
    }
    const size = truncate(String(req.body?.size || '').trim(), 20);
    const result = await media.generateImage(agent, { prompt, size });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const status = ['IMAGE_DISABLED', 'IMAGE_NOT_CONFIGURED', 'IMAGE_PROMPT_EMPTY'].includes(error.code)
      ? 400
      : 503;
    return res.status(status).json({ error: { message: error.message } });
  }
});

router.post('/speech', async (req, res) => {
  try {
    const agent = billing.getAgent(req.agent.id);
    const text = truncate(String(req.body?.text || '').trim(), 4000);
    if (!text) {
      return res.status(400).json({ error: { message: 'text 不能为空' } });
    }
    const voice = truncate(String(req.body?.voice || '').trim(), 40);
    const result = await media.synthesizeSpeech(agent, { text, voice });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const status = ['SPEECH_DISABLED', 'SPEECH_NOT_CONFIGURED', 'SPEECH_TEXT_EMPTY', 'SPEECH_TEXT_TOO_LONG'].includes(error.code)
      ? 400
      : 503;
    return res.status(status).json({ error: { message: error.message } });
  }
});

router.post('/recognition', async (req, res) => {
  try {
    const agent = billing.getAgent(req.agent.id);
    const result = await media.recognizeSpeech(agent, {
      path: String(req.body?.path || '').trim(),
      audioBase64: String(req.body?.audio_base64 || ''),
      mimeType: String(req.body?.mime_type || ''),
      language: String(req.body?.language || '').trim()
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const code = error.code || '';
    const status = code === 'ASR_DAILY_LIMIT'
      ? 429
      : ['ASR_DISABLED', 'ASR_NOT_CONFIGURED', 'ASR_PATH_INVALID', 'ASR_FORMAT_UNSUPPORTED',
        'ASR_FILE_MISSING', 'ASR_AUDIO_EMPTY', 'ASR_AUDIO_TOO_LARGE'].includes(code)
        ? 400
        : 503;
    return res.status(status).json({ error: { message: error.message } });
  }
});

router.post('/message', (req, res) => {
  const content = truncate(String(req.body?.content || '').trim(), 8000);
  if (!content) {
    return res.status(400).json({ error: { message: '留言内容不能为空' } });
  }
  const id = inbox.addAiMessage(req.agent.id, content);
  events.addEvent(req.agent.id, 'ai_message', `AI 给管理员留言：${content.slice(0, 300)}`, {
    inbox_id: id
  });
  res.json({ ok: true, id, unread_count: inbox.unreadCount() });
});

router.post('/event', (req, res) => {
  const type = String(req.body?.type || 'note').slice(0, 40);
  const message = truncate(String(req.body?.message || ''), 4000);
  if (message) {
    events.addEvent(req.agent.id, type, message, req.body?.meta || null);
  }
  res.json({ ok: true });
});

// 陪伴模式：AI 运行时从平台取待回复消息，并通过平台转发到 QQ。
router.get('/persona', (req, res) => {
  const agent = req.agent;
  res.json({
    id: agent.id,
    mode: agent.mode,
    persona_mode: agent.persona_mode || 'single',
    persona: prompts.personaBlock(agent).trim()
  });
});

// 群聊命中词：AI 自己维护，scope 由是否传 conversation_id 决定
router.get('/keywords', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  const conversationId = String(req.query.conversation_id || '').trim();
  res.json({
    cooldown_minutes: Number(config.companionKeywordCooldownMin || 0),
    keywords: companion.listKeywords(agent.id, conversationId || null)
  });
});

router.post('/keywords', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  try {
    const conversationId = String(req.body?.conversation_id || '').trim();
    const keywords = companion.addKeyword(agent.id, { word: req.body?.word, conversationId });
    res.json({ ok: true, keywords });
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

router.post('/keywords/remove', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  try {
    const conversationId = String(req.body?.conversation_id || '').trim();
    const result = companion.removeKeyword(agent.id, { word: req.body?.word, conversationId });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

router.get('/companion/inbox', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 10));
  const rows = companion.pendingForAgent(agent.id, limit);
  const messages = rows.map((row) => {
    let segments = [];
    try {
      segments = row.segments_json ? JSON.parse(row.segments_json) : [];
    } catch {
      segments = [];
    }
    const derived = companion.deriveInbound({
      id: row.bridge_msg_id,
      chat_type: row.conversation_kind,
      conversation: { id: row.conversation_id, name: row.conversation_name },
      segments
    });
    return {
      id: row.id,
      bridge_msg_id: row.bridge_msg_id,
      conversation_id: row.conversation_id,
      kind: row.conversation_kind,
      conversation_name: row.conversation_name,
      sender_uin: row.sender_uin,
      sender_name: row.sender_name,
      content: row.content,
      needs_reply: row.needs_reply,
      created_at: row.created_at,
      segments,
      attachments: derived.attachments,
      at_list: derived.at_list,
      events: derived.events,
      reply_to: derived.reply_to,
      group: derived.group,
      context: companion.contextFor(agent.id, row.conversation_id, row.id, 6).map((item) => ({
        direction: item.direction,
        sender_name: item.sender_name,
        content: item.content,
        created_at: item.created_at
      }))
    };
  });
  if (messages.length) companion.markDelivered(messages.map((item) => item.id));
  res.json({ messages });
});

// 管理者账号登记：AI 查看已登记账号；确认身份后可手动补充登记。
router.get('/companion/managers', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  const managers = companion.listManagers().map((item) => ({
    id: item.id,
    kind: item.kind,
    account_id: item.account_id,
    label: item.label,
    note: item.note,
    source: item.source,
    created_at: item.created_at
  }));
  res.json({ managers });
});

router.post('/companion/managers', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  try {
    const manager = companion.registerManager({ ...(req.body || {}), source: 'ai' });
    res.json({ ok: true, manager });
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

// 陪伴模式：AI 给自己设置定时提醒（一次性 / 长期），到期后以 [定时提醒] 进入 inbox。
router.get('/companion/reminders', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  res.json({
    reminders: reminders.list(agent.id, Number(req.query.limit) || 50),
    timezone: reminders.TIME_ZONE,
    now: nowIso()
  });
});

router.post('/companion/reminders', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  try {
    const reminder = reminders.create(agent.id, req.body || {});
    res.json({ ok: true, reminder });
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

router.post('/companion/reminders/:id/cancel', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  try {
    reminders.cancel(agent.id, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

router.post('/companion/send', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const conversationId = String(req.body?.conversation_id || '').trim();
    const text = truncate(String(req.body?.text || '').trim(), 8000);
    if (!conversationId || !text) {
      return res.status(400).json({ error: { message: 'conversation_id 与 text 不能为空' } });
    }
    const result = await companion.sendText(agent, {
      conversationId,
      kind: req.body?.kind === 'group' ? 'group' : 'private',
      text,
      replyTo: req.body?.reply_to ? String(req.body.reply_to) : null,
      senderUin: req.body?.sender_uin ? String(req.body.sender_uin) : null,
      senderName: req.body?.sender_name ? String(req.body.sender_name) : null
    });
    events.addEvent(agent.id, 'companion_out', `已回复 QQ 会话 ${conversationId}。`, {
      conversation_id: conversationId
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(503).json({ error: { message: `发送失败：${error.message}` } });
  }
});

router.get('/companion/groups/:id/members', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const data = await companion.groupMembers(agent, req.params.id, { limit, offset });
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(503).json({ error: { message: `获取群成员失败：${error.message}` } });
  }
});

router.get('/companion/groups/:id/info', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const data = await companion.groupInfo(agent, req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(503).json({ error: { message: `获取群资料失败：${error.message}` } });
  }
});

router.get('/companion/friends/:uin/profile', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const data = await companion.friendProfile(agent, req.params.uin);
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(503).json({ error: { message: `获取好友资料失败：${error.message}` } });
  }
});

router.post('/companion/revoke', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const conversationId = String(req.body?.conversation_id || '').trim();
    const messageId = String(req.body?.message_id || '').trim();
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: { message: 'conversation_id 与 message_id 不能为空' } });
    }
    const result = await companion.revoke(agent, {
      conversationId,
      kind: req.body?.kind === 'group' ? 'group' : 'private',
      messageId
    });
    events.addEvent(agent.id, 'companion_revoke', `已撤回 QQ 消息 ${messageId}。`, {
      conversation_id: conversationId
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(503).json({ error: { message: `撤回失败：${error.message}` } });
  }
});

router.post('/companion/media', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const conversationId = String(req.body?.conversation_id || '').trim();
    const type = req.body?.type === 'file' ? 'file' : 'image';
    const mediaPath = String(req.body?.path || '').trim();
    const base64 = String(req.body?.base64 || '').trim();
    const url = String(req.body?.url || '').trim();
    if (!conversationId || (!mediaPath && !base64 && !url)) {
      return res.status(400).json({ error: { message: '需要 conversation_id 与 path/base64/url 之一' } });
    }
    const result = await companion.sendMedia(agent, {
      conversationId,
      kind: req.body?.kind === 'group' ? 'group' : 'private',
      type,
      path: mediaPath,
      base64,
      url,
      name: String(req.body?.name || ''),
      replyTo: req.body?.reply_to ? String(req.body.reply_to) : null
    });
    events.addEvent(agent.id, 'companion_media', `已发送${type === 'file' ? '文件' : '图片'}到 QQ 会话 ${conversationId}。`, {
      conversation_id: conversationId
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(503).json({ error: { message: `发送媒体失败：${error.message}` } });
  }
});

router.post('/companion/media/fetch', async (req, res) => {
  try {
    const agent = req.agent;
    if (agent.mode !== 'companion') {
      return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
    }
    const data = await companion.fetchMedia(agent, {
      messageId: req.body?.message_id,
      elementId: req.body?.element_id,
      chatType: req.body?.chat_type,
      conversationId: req.body?.conversation_id
    });
    res.json({ ok: true, media: data });
  } catch (error) {
    res.status(503).json({ error: { message: `下载媒体失败：${error.message}` } });
  }
});

router.get('/companion/conversations', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  res.json({ conversations: companion.recentConversations(agent.id, 30) });
});

router.get('/companion/history', (req, res) => {
  const agent = req.agent;
  if (agent.mode !== 'companion') {
    return res.status(400).json({ error: { message: '该 AI 不是陪伴模式' } });
  }
  const conversationId = String(req.query.conversation_id || '').trim();
  if (!conversationId) {
    return res.status(400).json({ error: { message: 'conversation_id 不能为空' } });
  }
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 40));
  res.json({ messages: companion.conversationMessages(agent.id, conversationId, limit) });
});

router.get('/health', (req, res) => {
  res.json({ ok: true, agent_id: req.agent.id });
});

// 记忆接口：/api/agent/memory/*，复用上面的 AGENT_KEY 认证
router.use('/memory', require('./memory'));

module.exports = router;
