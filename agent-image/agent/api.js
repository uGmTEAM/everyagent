const BACKEND_URL = (process.env.BACKEND_URL || 'http://egress:7842').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';

async function apiFetch(pathname, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const response = await fetch(`${BACKEND_URL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENT_KEY}`
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function me() {
  return apiFetch('/api/agent/me', { timeoutMs: 30000 });
}

async function getTask() {
  return apiFetch('/api/agent/task', { timeoutMs: 30000 });
}

async function submit(content, files) {
  return apiFetch('/api/agent/submit', {
    method: 'POST',
    body: { content, files },
    timeoutMs: 900000
  });
}

async function oracle(question) {
  return apiFetch('/api/agent/oracle', {
    method: 'POST',
    body: { question },
    timeoutMs: 900000
  });
}

async function vision(payload) {
  return apiFetch('/api/agent/vision', {
    method: 'POST',
    body: payload,
    timeoutMs: 900000
  });
}

async function event(type, message, meta = null) {
  try {
    await apiFetch('/api/agent/event', {
      method: 'POST',
      body: { type, message, meta },
      timeoutMs: 15000
    });
  } catch {
    // 事件失败不阻塞主循环
  }
}

async function sendMessage(content) {
  return apiFetch('/api/agent/message', {
    method: 'POST',
    body: { content },
    timeoutMs: 30000
  });
}

async function image(payload) {
  return apiFetch('/api/agent/image', {
    method: 'POST',
    body: payload,
    timeoutMs: 300000
  });
}

async function speech(payload) {
  return apiFetch('/api/agent/speech', {
    method: 'POST',
    body: payload,
    timeoutMs: 180000
  });
}

async function recognition(payload) {
  return apiFetch('/api/agent/recognition', {
    method: 'POST',
    body: payload,
    timeoutMs: 300000
  });
}

async function memoryWrite(payload) {
  return apiFetch('/api/agent/memory/write', {
    method: 'POST',
    body: payload,
    timeoutMs: 60000
  });
}

async function memoryRecall(payload) {
  return apiFetch('/api/agent/memory/recall', {
    method: 'POST',
    body: payload,
    timeoutMs: 60000
  });
}

async function memoryForget(payload) {
  return apiFetch('/api/agent/memory/forget', {
    method: 'POST',
    body: payload,
    timeoutMs: 60000
  });
}

async function memoryStats() {
  return apiFetch('/api/agent/memory/stats', {
    method: 'GET',
    timeoutMs: 30000
  });
}

module.exports = {
  BACKEND_URL,
  AGENT_KEY,
  me,
  getTask,
  submit,
  oracle,
  vision,
  event,
  sendMessage,
  image,
  speech,
  recognition,
  memoryWrite,
  memoryRecall,
  memoryForget,
  memoryStats
};
