const db = require('./db');
const config = require('./config');
const llm = require('./llm');
const billing = require('./billing');
const prompts = require('./prompts');
const { estimateMessagesTokens, sha256, nowIso } = require('./util');

function splitMessages(messages) {
  const leadingSystem = [];
  let index = 0;
  while (index < messages.length && messages[index]?.role === 'system') {
    leadingSystem.push(messages[index]);
    index++;
  }
  const rest = messages.slice(index);
  const keepLast = Math.max(2, config.contextKeepRecent);
  if (rest.length <= keepLast) {
    return { leadingSystem, older: [], recent: rest };
  }
  const older = rest.slice(0, rest.length - keepLast);
  const recent = rest.slice(rest.length - keepLast);

  // 避免把 tool 结果与触发它的 assistant 消息拆开
  while (recent.length && recent[0]?.role === 'tool' && older.length) {
    recent.unshift(older.pop());
  }
  return { leadingSystem, older, recent };
}

function getCachedSummary(agentId, hash) {
  return db.get('SELECT summary FROM summaries WHERE agent_id = ? AND hash = ?', [agentId, hash]);
}

function saveSummary(agentId, hash, summary) {
  db.run(
    'INSERT OR REPLACE INTO summaries (agent_id, hash, summary, created_at) VALUES (?, ?, ?, ?)',
    [agentId, hash, summary, nowIso()]
  );
}

function fitMessages(messages, maxTokens = 100000, maxCharsPerMessage = 60000) {
  const result = (messages || []).map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (typeof message.content === 'string' && message.content.length > maxCharsPerMessage) {
      return {
        ...message,
        content: `${message.content.slice(0, maxCharsPerMessage)}\n...[内容因上下文限制被截断]`
      };
    }
    return message;
  });

  while (estimateMessagesTokens(result) > maxTokens && result.length > 3) {
    let index = 0;
    while (index < result.length && result[index]?.role === 'system') index += 1;
    if (index >= result.length - 1) break;
    result.splice(index, 1);
  }

  if (estimateMessagesTokens(result) > maxTokens) {
    const last = result[result.length - 1];
    if (last && typeof last.content === 'string') {
      const excess = estimateMessagesTokens(result) - maxTokens;
      const keep = Math.max(2000, last.content.length - excess * 3);
      result[result.length - 1] = {
        ...last,
        content: `${last.content.slice(0, keep)}\n...[内容因上下文限制被截断]`
      };
    }
  }

  // 清理被拆分后产生的孤立 tool 消息，避免供应商拒绝请求
  const toolIds = new Set();
  const sanitized = [];
  for (const message of result) {
    if (message?.role === 'tool') {
      let hasCall = false;
      for (let i = sanitized.length - 1; i >= 0; i -= 1) {
        const previous = sanitized[i];
        if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
          if (previous.tool_calls.some((call) => call.id === message.tool_call_id)) {
            hasCall = true;
          }
          break;
        }
      }
      if (hasCall) {
        toolIds.add(message.tool_call_id);
        sanitized.push(message);
      }
      continue;
    }
    sanitized.push(message);
  }

  return sanitized.map((message) => {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const filtered = message.tool_calls.filter((call) => toolIds.has(call.id));
      if (!filtered.length) {
        return { role: 'assistant', content: message.content || '' };
      }
      return { ...message, tool_calls: filtered };
    }
    return message;
  });
}

function pickCompressionModel(provider, fallbackModel) {
  const models = llm.parseModels(provider?.models);
  if (models.includes('deepseek-chat')) return 'deepseek-chat';
  return fallbackModel;
}

async function compressMessages(agent, provider, messages) {
  const originalTokens = estimateMessagesTokens(messages);
  if (originalTokens <= config.contextCompressionThreshold) {
    return {
      messages,
      compressed: false,
      summary: null,
      keepRecent: null,
      originalTokens,
      compressedTokens: originalTokens
    };
  }

  const { leadingSystem, older, recent } = splitMessages(messages);
  if (!older.length) {
    const fitted = fitMessages(messages);
    return {
      messages: fitted,
      compressed: false,
      summary: null,
      keepRecent: null,
      originalTokens,
      compressedTokens: estimateMessagesTokens(fitted)
    };
  }

  const hash = sha256(JSON.stringify(older));
  let summary = null;
  const cached = getCachedSummary(agent.id, hash);
  if (cached) {
    summary = cached.summary;
  } else {
    const model = pickCompressionModel(provider, agent.model);
    const llmMessages = [
      { role: 'system', content: prompts.buildCompressionSystemPrompt() },
      { role: 'user', content: prompts.buildCompressionUserPrompt(older) }
    ];
    const result = await llm.callChat({
      provider,
      model,
      messages: llmMessages,
      temperature: 0.2,
      max_tokens: 1600
    });

    billing.recordRequest({
      agentId: agent.id,
      kind: 'memory_summary',
      providerId: provider?.id,
      model,
      usage: result.usage,
      latency: result.latency,
      status: result.ok ? 'ok' : 'error',
      error: result.error,
      request: { hash, olderCount: older.length },
      response: result.ok ? { summary: result.message?.content || '' } : null,
      compressed: true,
      billed: 0
    });

    if (!result.ok) {
      const fitted = fitMessages(messages);
      return {
        messages: fitted,
        compressed: false,
        summary: null,
        keepRecent: null,
        originalTokens,
        compressedTokens: estimateMessagesTokens(fitted),
        error: result.error
      };
    }
    summary = (result.message?.content || '').trim();
    if (!summary) {
      const fitted = fitMessages(messages);
      return {
        messages: fitted,
        compressed: false,
        summary: null,
        keepRecent: null,
        originalTokens,
        compressedTokens: estimateMessagesTokens(fitted)
      };
    }
    saveSummary(agent.id, hash, summary);
  }

  const compressedMessages = fitMessages([
    ...leadingSystem,
    { role: 'system', content: `[历史摘要]\n${summary}` },
    ...recent
  ]);

  return {
    messages: compressedMessages,
    compressed: true,
    summary,
    keepRecent: Math.max(1, compressedMessages.length - leadingSystem.length - 1),
    originalTokens,
    compressedTokens: estimateMessagesTokens(compressedMessages)
  };
}

module.exports = {
  compressMessages,
  splitMessages,
  fitMessages
};
