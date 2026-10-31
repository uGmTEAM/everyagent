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

// 陪伴模式：从平台拉取待回复的 QQ 消息（拉取即标记已送达）
async function companionInbox(limit = 8) {
  return apiFetch(`/api/agent/companion/inbox?limit=${Number(limit) || 8}`, { timeoutMs: 30000 });
}

async function companionSend(payload) {
  return apiFetch('/api/agent/companion/send', {
    method: 'POST',
    body: payload,
    timeoutMs: 60000
  });
}

async function companionConversations() {
  return apiFetch('/api/agent/companion/conversations', { timeoutMs: 30000 });
}

async function companionHistory(conversationId, limit = 40) {
  return apiFetch(
    `/api/agent/companion/history?conversation_id=${encodeURIComponent(conversationId)}&limit=${Number(limit) || 40}`,
    { timeoutMs: 30000 }
  );
}

async function companionGroupMembers(groupId, limit = 100, offset = 0) {
  return apiFetch(
    `/api/agent/companion/groups/${encodeURIComponent(groupId)}/members?limit=${Number(limit) || 100}&offset=${Number(offset) || 0}`,
    { timeoutMs: 40000 }
  );
}

async function companionGroupInfo(groupId) {
  return apiFetch(
    `/api/agent/companion/groups/${encodeURIComponent(groupId)}/info`,
    { timeoutMs: 30000 }
  );
}

async function companionFriendProfile(uin) {
  return apiFetch(
    `/api/agent/companion/friends/${encodeURIComponent(uin)}/profile`,
    { timeoutMs: 30000 }
  );
}

async function companionRevoke(payload) {
  return apiFetch('/api/agent/companion/revoke', {
    method: 'POST',
    body: payload,
    timeoutMs: 30000
  });
}

async function companionSendMedia(payload) {
  return apiFetch('/api/agent/companion/media', {
    method: 'POST',
    body: payload,
    timeoutMs: 90000
  });
}

async function companionFetchMedia(payload) {
  return apiFetch('/api/agent/companion/media/fetch', {
    method: 'POST',
    body: payload,
    timeoutMs: 120000
  });
}

// 自我定时提醒
async function companionReminders(limit = 50) {
  return apiFetch(`/api/agent/companion/reminders?limit=${Number(limit) || 50}`, { timeoutMs: 30000 });
}

async function companionCreateReminder(payload) {
  return apiFetch('/api/agent/companion/reminders', {
    method: 'POST',
    body: payload,
    timeoutMs: 30000
  });
}

async function companionCancelReminder(id) {
  return apiFetch(`/api/agent/companion/reminders/${Number(id) || 0}/cancel`, {
    method: 'POST',
    body: {},
    timeoutMs: 30000
  });
}

// 管理者账号登记
async function companionManagers() {
  return apiFetch('/api/agent/companion/managers', { timeoutMs: 30000 });
}

async function companionRegisterManager(payload) {
  return apiFetch('/api/agent/companion/managers', {
    method: 'POST',
    body: payload,
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
  memoryStats,
  companionInbox,
  companionSend,
  companionConversations,
  companionHistory,
  companionGroupMembers,
  companionGroupInfo,
  companionFriendProfile,
  companionRevoke,
  companionSendMedia,
  companionFetchMedia,
  companionReminders,
  companionCreateReminder,
  companionCancelReminder,
  companionManagers,
  companionRegisterManager
};
