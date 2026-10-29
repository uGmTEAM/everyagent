const { BACKEND_URL, AGENT_KEY } = require('./api');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersToObject(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) result[key.toLowerCase()] = value;
  return result;
}

async function callModel({ config, messages, tools = null, toolMode = 'text' }) {
  const body = {
    model: config.model,
    messages,
    stream: false,
    temperature: 0.7,
    max_tokens: Number(config.maxOutputTokens || 8192)
  };
  if (tools && toolMode !== 'text') {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BACKEND_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AGENT_KEY}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(900000)
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (response.status === 401 || response.status === 410 || response.status === 402) {
        return {
          ok: false,
          fatal: true,
          status: response.status,
          error: data?.error?.message || `HTTP ${response.status}`,
          headers: headersToObject(response.headers)
        };
      }

      if (!response.ok) {
        const message = data?.error?.message || `HTTP ${response.status}`;
        const historyBroken = /must be a response to|preceding message|role ['"]?tool['"]?/i.test(message);
        const toolUnsupported =
          toolMode === 'native' &&
          !historyBroken &&
          /tool|function|tool_choice/i.test(message) &&
          response.status >= 400 &&
          response.status < 500;
        if (toolUnsupported) {
          return { ok: false, retryText: true, error: message };
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = message;
          await sleep(5000 * (attempt + 1));
          continue;
        }
        return { ok: false, status: response.status, error: message };
      }

      if (!data) {
        lastError = '响应不是合法 JSON';
        await sleep(3000);
        continue;
      }

      const message = data.choices?.[0]?.message || {};
      return {
        ok: true,
        message: {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : '',
          reasoning_content: message.reasoning_content || '',
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : null
        },
        usage: data.usage || null,
        headers: headersToObject(response.headers),
        raw: data
      };
    } catch (error) {
      lastError = error.message;
      await sleep(5000 * (attempt + 1));
    }
  }

  return { ok: false, error: lastError || '模型请求失败' };
}

module.exports = {
  callModel,
  sleep
};
