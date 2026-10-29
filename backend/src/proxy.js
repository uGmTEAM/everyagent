const db = require('./db');
const config = require('./config');
const billing = require('./billing');
const compression = require('./compression');
const llm = require('./llm');
const { estimateMessagesTokens, estimateTokens, safeJsonParse, truncate } = require('./util');

function authAgent(req) {
  const header = req.headers.authorization || '';
  const key = header.replace(/^Bearer\s+/i, '').trim();
  if (!key) return null;
  return db.get('SELECT * FROM agents WHERE api_key = ?', [key]);
}

function stripReasoning(messages) {
  return (messages || []).map((message) => {
    if (!message || typeof message !== 'object') return message;
    const { reasoning_content, ...rest } = message;
    return rest;
  });
}

function mergeToolCallDelta(accumulator, deltaToolCalls) {
  for (const delta of deltaToolCalls) {
    const index = Number(delta.index || 0);
    if (!accumulator[index]) {
      accumulator[index] = {
        id: delta.id || '',
        type: delta.type || 'function',
        function: { name: '', arguments: '' }
      };
    }
    const target = accumulator[index];
    if (delta.id) target.id = delta.id;
    if (delta.type) target.type = delta.type;
    if (delta.function?.name) target.function.name += delta.function.name;
    if (delta.function?.arguments) target.function.arguments += delta.function.arguments;
  }
}

function parseStream(raw) {
  let content = '';
  let reasoning = '';
  let usage = null;
  const toolCalls = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const chunk = safeJsonParse(payload, null);
    if (!chunk) continue;
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) mergeToolCallDelta(toolCalls, delta.tool_calls);
  }

  const normalizedUsage = {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    reasoning_tokens: Number(
      usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0
    ),
    total_tokens: Number(usage?.total_tokens || 0)
  };

  return {
    content,
    reasoning,
    tool_calls: toolCalls.length ? toolCalls : null,
    usage: normalizedUsage,
    hasUsage: Boolean(usage)
  };
}

async function handleChat(req, res) {
  const agent = authAgent(req);
  if (!agent) {
    return res.status(401).json({ error: { message: '无效的 AGENT_KEY' } });
  }
  if (agent.status === 'dead' || agent.status === 'finalizing') {
    return res.status(410).json({ error: { message: '该 AI 已死亡' } });
  }

  const now = Date.now();
  if (agent.status === 'dying' && agent.dying_deadline) {
    if (now > Date.parse(agent.dying_deadline)) {
      return res.status(402).json({ error: { message: '临终期已结束，操作被拒绝' } });
    }
  }

  const provider = billing.getProvider(agent.provider_id);
  if (!provider || (!provider.api_key && provider.provider_type !== 'custom')) {
    return res.status(503).json({ error: { message: '供应商未配置或缺少 API Key' } });
  }

  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: { message: 'messages 不能为空' } });
  }
  if (body.model && body.model !== agent.model) {
    return res.status(400).json({
      error: { message: `模型固定为 ${agent.model}，创建后不可更改` }
    });
  }

  let fresh = billing.getAgent(agent.id);
  if (Number(fresh.balance || 0) <= 0 && fresh.status !== 'dying') {
    billing.enterDying(fresh.id, 'quota');
    fresh = billing.getAgent(agent.id);
  }
  const free = fresh.status === 'dying' || Number(fresh.balance || 0) <= 0;

  const originalMessages = stripReasoning(body.messages);
  const originalEstimate = estimateMessagesTokens(originalMessages);
  if (originalEstimate > 600000) {
    return res.status(413).json({
      error: {
        message: `请求上下文过大（约 ${originalEstimate.toLocaleString('en-US')} tokens），请先压缩历史。`
      }
    });
  }

  let compressed;
  try {
    compressed = await compression.compressMessages(fresh, provider, originalMessages);
  } catch (error) {
    const fitted = compression.fitMessages(originalMessages);
    compressed = {
      messages: fitted,
      compressed: false,
      summary: null,
      keepRecent: null,
      originalTokens: estimateMessagesTokens(originalMessages),
      compressedTokens: estimateMessagesTokens(fitted)
    };
  }

  const maxTokens = Math.min(
    Math.max(1, Number(body.max_tokens || config.maxOutputTokens)),
    config.maxOutputTokens
  );

  const forwardBody = {
    ...body,
    model: agent.model,
    messages: compressed.messages,
    stream: Boolean(body.stream),
    max_tokens: maxTokens,
    n: 1
  };
  delete forwardBody.reasoning_content;
  if (forwardBody.stream) {
    forwardBody.stream_options = {
      ...(forwardBody.stream_options || {}),
      include_usage: true
    };
  }

  const warnings = billing.activeWarnings(fresh);
  res.setHeader('X-EA-Agent', agent.id);
  res.setHeader('X-EA-Status', fresh.status);
  res.setHeader('X-EA-Balance', String(fresh.balance));
  res.setHeader('X-EA-Free', free ? '1' : '0');
  if (warnings.length) res.setHeader('X-EA-Warnings', warnings.join(','));
  if (compressed.compressed) {
    res.setHeader('X-EA-Compressed', '1');
    res.setHeader('X-EA-Keep', String(compressed.keepRecent || 0));
    res.setHeader('X-EA-Summary', Buffer.from(compressed.summary || '', 'utf8').toString('base64'));
  }

  const isCustom = (provider.provider_type || 'openai') === 'custom';
  const requestLog = {
    model: agent.model,
    stream: isCustom ? false : forwardBody.stream,
    messages: originalMessages,
    forwarded_messages: compressed.messages,
    tools: body.tools || null,
    temperature: forwardBody.temperature,
    max_tokens: maxTokens
  };

  if (isCustom) {
    let request;
    try {
      request = llm.buildRequest(provider, {
        model: agent.model,
        messages: compressed.messages,
        temperature: Number(forwardBody.temperature ?? 0.7),
        max_tokens: maxTokens,
        tools: body.tools || null,
        tool_choice: forwardBody.tool_choice || 'auto'
      });
    } catch (error) {
      return res.status(400).json({ error: { message: `自定义请求格式无效：${error.message}` } });
    }

    const startedAt = Date.now();
    let upstream;
    try {
      upstream = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body || undefined,
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
    } catch (error) {
      billing.recordRequest({
        agentId: agent.id,
        kind: 'agent_chat',
        providerId: provider.id,
        model: agent.model,
        latency: Date.now() - startedAt,
        status: 'error',
        error: error.message,
        request: requestLog,
        compressed: compressed.compressed,
        billed: 0
      });
      return res.status(502).json({ error: { message: `上游请求失败：${error.message}` } });
    }

    const text = await upstream.text().catch(() => '');
    const data = safeJsonParse(text, null);

    if (!upstream.ok) {
      const message =
        data?.error?.message || data?.message || truncate(text || `上游 HTTP ${upstream.status}`, 2000);
      billing.recordRequest({
        agentId: agent.id,
        kind: 'agent_chat',
        providerId: provider.id,
        model: agent.model,
        latency: Date.now() - startedAt,
        status: 'error',
        error: message,
        request: requestLog,
        response: data,
        compressed: compressed.compressed,
        billed: 0
      });
      return res.status(upstream.status).json({
        error: { message, upstream_status: upstream.status }
      });
    }

    if (!data) {
      return res.status(502).json({ error: { message: '上游返回了无法解析的 JSON' } });
    }

    const message = llm.extractAssistantMessage(data, provider);
    const usage = llm.extractUsage(data);
    if (!usage.total_tokens) {
      usage.prompt_tokens = estimateMessagesTokens(compressed.messages);
      usage.completion_tokens = estimateTokens(message.content);
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    const bill = billing.applyBilling(agent.id, usage, { free });
    billing.recordRequest({
      agentId: agent.id,
      kind: 'agent_chat',
      providerId: provider.id,
      model: agent.model,
      usage,
      latency: Date.now() - startedAt,
      status: 'ok',
      request: requestLog,
      response: data,
      compressed: compressed.compressed,
      billed: bill.billed
    });
    res.setHeader('X-EA-Balance', String(bill.balance));
    res.setHeader('X-EA-Status', bill.dying ? 'dying' : (billing.getAgent(agent.id)?.status || fresh.status));
    return res.status(200).json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: agent.model,
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage
    });
  }

  const callUpstream = async (p, m) => {
    const url = llm.normalizeBaseUrl(p.base_url, p.provider_type || 'openai');
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.api_key}`
      },
      body: JSON.stringify({ ...forwardBody, model: m }),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
  };

  let usedProvider = provider;
  let usedModel = agent.model;
  let startedAt = Date.now();
  let upstream = null;
  let firstError = null;

  try {
    upstream = await callUpstream(provider, agent.model);
  } catch (error) {
    firstError = error;
  }

  const fallbackProvider = agent.fallback_provider_id
    ? billing.getProvider(agent.fallback_provider_id)
    : null;
  if (fallbackProvider && agent.fallback_model && (!upstream || !upstream.ok)) {
    if (upstream) {
      try {
        await upstream.body?.cancel();
      } catch {
        // ignore
      }
    }
    usedProvider = fallbackProvider;
    usedModel = agent.fallback_model;
    startedAt = Date.now();
    firstError = null;
    try {
      upstream = await callUpstream(fallbackProvider, agent.fallback_model);
    } catch (error) {
      firstError = error;
      upstream = null;
    }
  }

  requestLog.model = usedModel;
  requestLog.fallback = usedProvider.id !== provider.id;

  if (!upstream) {
    billing.recordRequest({
      agentId: agent.id,
      kind: 'agent_chat',
      providerId: usedProvider.id,
      model: usedModel,
      latency: Date.now() - startedAt,
      status: 'error',
      error: firstError?.message || '上游请求失败',
      request: requestLog,
      compressed: compressed.compressed,
      billed: 0
    });
    return res.status(502).json({ error: { message: `上游请求失败：${firstError?.message || '未知错误'}` } });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const data = safeJsonParse(text, null);
    const message =
      data?.error?.message || truncate(text || `上游 HTTP ${upstream.status}`, 2000);
    billing.recordRequest({
      agentId: agent.id,
      kind: 'agent_chat',
      providerId: usedProvider.id,
      model: usedModel,
      latency: Date.now() - startedAt,
      status: 'error',
      error: message,
      request: requestLog,
      response: data,
      compressed: compressed.compressed,
      billed: 0
    });
    return res.status(upstream.status).json({
      error: { message, upstream_status: upstream.status }
    });
  }

  if (!forwardBody.stream) {
    const text = await upstream.text();
    const data = safeJsonParse(text, null);
    if (!data) {
      return res.status(502).json({ error: { message: '上游返回了无法解析的 JSON' } });
    }
    const usage = llm.extractUsage(data);
    if (!usage.total_tokens) {
      const message = llm.extractAssistantMessage(data);
      usage.prompt_tokens = estimateMessagesTokens(compressed.messages);
      usage.completion_tokens = estimateTokens(message.content);
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    const bill = billing.applyBilling(agent.id, usage, { free });
    billing.recordRequest({
      agentId: agent.id,
      kind: 'agent_chat',
      providerId: usedProvider.id,
      model: usedModel,
      usage,
      latency: Date.now() - startedAt,
      status: 'ok',
      request: requestLog,
      response: data,
      compressed: compressed.compressed,
      billed: bill.billed
    });
    res.setHeader('X-EA-Balance', String(bill.balance));
    res.setHeader('X-EA-Status', bill.dying ? 'dying' : (billing.getAgent(agent.id)?.status || fresh.status));
    return res.status(200).json(data);
  }

  // 流式转发
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  let raw = '';
  let ended = false;

  const finish = (errorMessage = null) => {
    if (ended) return;
    ended = true;
    const parsed = parseStream(raw);
    const usage = parsed.usage;
    if (!usage.total_tokens) {
      usage.prompt_tokens = estimateMessagesTokens(compressed.messages);
      usage.completion_tokens = estimateTokens(parsed.content + parsed.reasoning);
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    const bill = billing.applyBilling(agent.id, usage, { free });
    billing.recordRequest({
      agentId: agent.id,
      kind: 'agent_chat',
      providerId: usedProvider.id,
      model: usedModel,
      usage,
      latency: Date.now() - startedAt,
      status: errorMessage ? 'error' : 'ok',
      error: errorMessage,
      request: requestLog,
      response: {
        content: parsed.content,
        reasoning_content: parsed.reasoning,
        tool_calls: parsed.tool_calls,
        usage,
        raw_tail: raw.slice(-20000)
      },
      compressed: compressed.compressed,
      billed: bill.billed
    });
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // ignore
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += Buffer.from(value).toString('utf8');
      if (!res.writableEnded) res.write(Buffer.from(value));
    }
    finish();
  } catch (error) {
    finish(error.message);
  }
}

module.exports = {
  handleChat,
  authAgent
};
