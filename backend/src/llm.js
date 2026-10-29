const config = require('./config');
const { estimateMessagesTokens, estimateTokens, truncate, safeJsonParse } = require('./util');

function normalizeBaseUrl(baseUrl, providerType = 'openai') {
  let base = String(baseUrl || '').trim();
  if (!base) throw new Error('供应商 base_url 为空');
  base = base.replace(/\/+$/, '');
  if (providerType === 'custom') return base;
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

const DEFAULT_POST_TEMPLATE = `{
  "model": {{model}},
  "messages": {{messages}},
  "temperature": {{temperature}},
  "max_tokens": {{max_tokens}}
}`;

const DEFAULT_GET_TEMPLATE = `{
  "model": {{model}},
  "messages": {{messages}}
}`;

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function renderTemplate(template, context) {
  let output = String(template || '');
  output = output.replace(/"\{\{\s*(\w+)\s*\}\}"/g, (match, key) => {
    if (!(key in context)) return match;
    const value = context[key];
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return JSON.stringify(String(value));
  });
  output = output.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    if (!(key in context)) return match;
    return JSON.stringify(context[key]);
  });
  return output;
}

function buildRequest(provider, payload) {
  const providerType = provider.provider_type || 'openai';
  const base = {
    model: payload.model,
    messages: payload.messages,
    temperature: payload.temperature,
    max_tokens: payload.max_tokens,
    stream: false,
    tools: payload.tools || [],
    tool_choice: payload.tool_choice || 'auto',
    prompt: lastUserText(payload.messages)
  };

  if (providerType === 'custom') {
    const method = String(provider.http_method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const template =
      String(provider.request_template || '').trim() ||
      (method === 'GET' ? DEFAULT_GET_TEMPLATE : DEFAULT_POST_TEMPLATE);
    const rendered = renderTemplate(template, base);
    let parsed;
    try {
      parsed = JSON.parse(rendered);
    } catch {
      throw new Error('自定义请求格式不是合法 JSON，请检查模板占位符');
    }
    const headers = {};
    if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

    if (method === 'GET') {
      const url = new URL(normalizeBaseUrl(provider.base_url, 'custom'));
      for (const [key, value] of Object.entries(parsed || {})) {
        url.searchParams.set(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      return { url: url.toString(), method, headers, body: null, requestBody: parsed };
    }

    headers['Content-Type'] = 'application/json';
    return {
      url: normalizeBaseUrl(provider.base_url, 'custom'),
      method,
      headers,
      body: JSON.stringify(parsed),
      requestBody: parsed
    };
  }

  const body = {
    model: payload.model,
    messages: payload.messages,
    stream: false,
    temperature: payload.temperature,
    max_tokens: payload.max_tokens
  };
  if (payload.tools && payload.tools.length) {
    body.tools = payload.tools;
    body.tool_choice = payload.tool_choice || 'auto';
  }
  return {
    url: normalizeBaseUrl(provider.base_url, providerType),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.api_key}`
    },
    body: JSON.stringify(body),
    requestBody: body
  };
}

function getByPath(value, pathStr) {
  if (!pathStr) return undefined;
  const parts = String(pathStr)
    .trim()
    .replace(/^\$\.?/, '')
    .split(/\.|\[|\]/)
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function parseModels(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

function parseVisionModels(value) {
  return parseModels(value);
}

function parseMultimodalModels(value) {
  return parseModels(value);
}

function extractUsage(data) {
  const usage = data?.usage || {};
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  const reasoning = Number(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens ??
      0
  );
  const total = Number(usage.total_tokens || prompt + completion || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    reasoning_tokens: reasoning,
    total_tokens: total
  };
}

function extractAssistantMessage(data, provider = null) {
  if (provider && provider.provider_type === 'custom') {
    let content = getByPath(data, provider.output_path);
    if (content === undefined || content === null) {
      const fallbacks = [
        'output',
        'response',
        'answer',
        'content',
        'result',
        'text',
        'reply',
        'data.output',
        'data.answer',
        'data.content',
        'data.text',
        'data.response',
        'data.result'
      ];
      for (const path of fallbacks) {
        const value = getByPath(data, path);
        if (value !== undefined && value !== null) {
          content = value;
          break;
        }
      }
    }
    if (content && typeof content === 'object') {
      content = typeof content.content === 'string' ? content.content : JSON.stringify(content);
    }
    return {
      role: 'assistant',
      content: content === undefined || content === null ? '' : String(content),
      reasoning_content: '',
      tool_calls: null
    };
  }

  const message = data?.choices?.[0]?.message || {};
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    reasoning_content: message.reasoning_content || '',
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : null
  };
}

async function callChat({
  provider,
  model,
  messages,
  temperature = 0.7,
  max_tokens = config.maxOutputTokens,
  tools = null,
  tool_choice = 'auto',
  timeoutMs = config.requestTimeoutMs
}) {
  if (!provider) throw new Error('未配置供应商');
  if (!model) throw new Error('未指定模型');

  let request;
  try {
    request = buildRequest(provider, { model, messages, temperature, max_tokens, tools, tool_choice });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: '',
      error: error.message,
      latency: 0,
      requestBody: null
    };
  }

  const startedAt = Date.now();
  let response;
  let text = '';
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body || undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: '',
      error: error.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : error.message,
      latency: Date.now() - startedAt,
      requestBody: request.requestBody
    };
  }

  const data = safeJsonParse(text, null);
  const latency = Date.now() - startedAt;

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      truncate(text || `HTTP ${response.status}`, 2000);
    return {
      ok: false,
      status: response.status,
      data,
      text,
      error: message,
      latency,
      requestBody: request.requestBody
    };
  }

  if (!data) {
    return {
      ok: false,
      status: response.status,
      data: null,
      text,
      error: '供应商返回了无法解析的 JSON',
      latency,
      requestBody: request.requestBody
    };
  }

  const usage = extractUsage(data);
  if (!usage.prompt_tokens && !usage.completion_tokens) {
    const message = extractAssistantMessage(data, provider);
    usage.prompt_tokens = estimateMessagesTokens(messages);
    usage.completion_tokens = estimateTokens(message.content);
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }

  return {
    ok: true,
    status: response.status,
    data,
    text,
    error: null,
    latency,
    requestBody: request.requestBody,
    usage,
    message: extractAssistantMessage(data, provider)
  };
}

module.exports = {
  callChat,
  normalizeBaseUrl,
  buildRequest,
  getByPath,
  parseModels,
  parseVisionModels,
  parseMultimodalModels,
  extractUsage,
  extractAssistantMessage
};
