const db = require('./db');
const config = require('./config');
const llm = require('./llm');
const prompts = require('./prompts');
const billing = require('./billing');
const { extractJson, clamp, truncate, nowIso } = require('./util');

function getConfig() {
  const row = db.get('SELECT * FROM judge_config WHERE id = 1');
  if (!row || !row.provider_id || !row.model) {
    const error = new Error('Judge 尚未配置');
    error.code = 'JUDGE_NOT_CONFIGURED';
    throw error;
  }
  const provider = db.get('SELECT * FROM providers WHERE id = ?', [row.provider_id]);
  if (!provider) {
    const error = new Error('Judge 的供应商不存在');
    error.code = 'JUDGE_NOT_CONFIGURED';
    throw error;
  }
  return { config: row, provider };
}

function saveConfig({ provider_id, model, system_prompt, persona }) {
  db.run(
    `UPDATE judge_config
        SET provider_id = ?, model = ?, system_prompt = ?, persona = ?, updated_at = ?
      WHERE id = 1`,
    [
      provider_id ? Number(provider_id) : null,
      model || null,
      system_prompt || '',
      persona || '',
      new Date().toISOString()
    ]
  );
  return db.get('SELECT * FROM judge_config WHERE id = 1');
}

function normalizeTasks(parsed) {
  let list = parsed;
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.tasks)) list = parsed.tasks;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      acceptance: String(item?.acceptance || '').trim()
    }))
    .filter((item) => item.title && item.description && item.acceptance);
}

async function generateTasks(count = config.taskBatchSize) {
  const { config: judgeConfig, provider } = getConfig();
  const existing = db.all('SELECT title FROM tasks WHERE active = 1 ORDER BY seq DESC LIMIT 80');
  const messages = [
    { role: 'system', content: prompts.buildTaskGenerationSystemPrompt(judgeConfig) },
    { role: 'user', content: prompts.buildTaskGenerationUserPrompt(existing) }
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await llm.callChat({
      provider,
      model: judgeConfig.model,
      messages,
      temperature: 0.8,
      max_tokens: 4096
    });

    billing.recordRequest({
      agentId: null,
      kind: 'task_gen',
      providerId: provider.id,
      model: judgeConfig.model,
      usage: result.usage,
      latency: result.latency,
      status: result.ok ? 'ok' : 'error',
      error: result.error,
      request: { messages, attempt },
      response: result.ok ? result.data : null,
      billed: 0
    });

    if (!result.ok) throw new Error(`任务生成请求失败：${result.error}`);
    const parsed = extractJson(result.message?.content || '');
    const tasks = normalizeTasks(parsed);
    if (tasks.length >= Math.min(count, 1)) {
      return tasks.slice(0, count);
    }
    messages.push({
      role: 'assistant',
      content: result.message?.content || ''
    });
    messages.push({
      role: 'user',
      content: `上次输出不符合要求。请严格只输出一个 JSON 数组，包含 ${count} 个任务，每个任务必须有 title、description、acceptance 三个非空字段。`
    });
  }

  throw new Error('Judge 未能生成合法任务');
}

// Judge 记忆：跨任务的判定摘要，用于识破 AI 反复提交同一份成果。
function recentMemory(agentId, limit = 12) {
  return db.all(
    `SELECT m.id, m.agent_id, m.task_id, m.submission_id, m.fingerprint,
            m.passed, m.deduction, m.reward, m.feedback, m.created_at,
            t.seq AS task_seq, t.title AS task_title
       FROM judge_memory m
       LEFT JOIN tasks t ON t.id = m.task_id
      WHERE m.agent_id = ?
      ORDER BY m.id DESC
      LIMIT ?`,
    [agentId, limit]
  );
}

function recordMemory({ agentId, task, submission, fingerprint, decision }) {
  db.run(
    `INSERT INTO judge_memory
       (agent_id, task_id, submission_id, fingerprint, passed, deduction, reward, feedback, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      task.id,
      submission?.id || null,
      fingerprint || '',
      decision.passed ? 1 : 0,
      Number(decision.deduction || 0),
      Number(decision.reward || 0),
      truncate(String(decision.feedback || ''), 1200),
      nowIso()
    ]
  );
}

async function judgeSubmission({ agent, task, submission, priorSubmissions = [], repeat = null }) {
  const { config: judgeConfig, provider } = getConfig();
  const messages = [
    { role: 'system', content: prompts.buildJudgeSystemPrompt(judgeConfig) },
    {
      role: 'user',
      content: prompts.buildJudgeUserPrompt({
        agent,
        task,
        submission,
        priorSubmissions,
        memory: recentMemory(agent.id),
        repeat
      })
    }
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await llm.callChat({
      provider,
      model: judgeConfig.model,
      messages,
      temperature: 0.2,
      max_tokens: 2048
    });

    const requestId = billing.recordRequest({
      agentId: agent.id,
      kind: 'judge',
      providerId: provider.id,
      model: judgeConfig.model,
      usage: result.usage,
      latency: result.latency,
      status: result.ok ? 'ok' : 'error',
      error: result.error,
      request: { messages, attempt },
      response: result.ok ? result.data : null,
      billed: 0
    });

    if (!result.ok) throw new Error(`Judge 请求失败：${result.error}`);

    const parsed = extractJson(result.message?.content || '');
    if (parsed && typeof parsed === 'object' && typeof parsed.passed === 'boolean') {
      const passed = parsed.passed;
      let deduction = Number(parsed.deduction || 0);
      let reward = Number(parsed.reward || 0);
      if (passed) {
        deduction = 0;
        reward = clamp(reward, 0, config.judgeRewardMax);
      } else {
        reward = 0;
        deduction = clamp(deduction, config.judgeDeductionMin, config.judgeDeductionMax);
      }
      const decision = {
        passed,
        feedback: truncate(String(parsed.feedback || ''), 4000),
        deduction,
        reward,
        requestId,
        usage: result.usage
      };
      recordMemory({
        agentId: agent.id,
        task,
        submission,
        fingerprint: submission?.fingerprint || '',
        decision
      });
      return decision;
    }

    messages.push({ role: 'assistant', content: result.message?.content || '' });
    messages.push({
      role: 'user',
      content: '输出不符合要求。请只输出 JSON：{"passed":true/false,"feedback":"...","deduction":0,"reward":0}'
    });
  }

  throw new Error('Judge 未返回合法判定');
}

module.exports = {
  getConfig,
  saveConfig,
  generateTasks,
  judgeSubmission,
  recentMemory,
  recordMemory
};
