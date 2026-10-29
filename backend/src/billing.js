const db = require('./db');
const config = require('./config');
const { addEvent } = require('./events');
const inbox = require('./inbox');
const { nowIso, clamp } = require('./util');

function getAgent(agentId) {
  return db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
}

function getProvider(providerId) {
  return db.get('SELECT * FROM providers WHERE id = ?', [providerId]);
}

function getProviderForAgent(agent) {
  return getProvider(agent.provider_id);
}

function recordRequest({
  agentId = null,
  kind,
  providerId = null,
  model = null,
  usage = {},
  latency = 0,
  status = 'ok',
  error = null,
  request = null,
  response = null,
  compressed = false,
  billed = 0
}) {
  const total = Number(usage.total_tokens || 0);
  const result = db.run(
    `INSERT INTO requests
      (agent_id, kind, provider_id, model, prompt_tokens, completion_tokens, reasoning_tokens,
       total_tokens, billed_tokens, latency_ms, status, error, request_json, response_json, compressed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      kind,
      providerId,
      model,
      Number(usage.prompt_tokens || 0),
      Number(usage.completion_tokens || 0),
      Number(usage.reasoning_tokens || 0),
      total,
      Number(billed || 0),
      Number(latency || 0),
      status,
      error || null,
      request ? JSON.stringify(request) : null,
      response ? JSON.stringify(response) : null,
      compressed ? 1 : 0,
      nowIso()
    ]
  );
  return Number(result.lastInsertRowid);
}

function warningThresholds(agent) {
  const initial = Number(agent.initial_balance || config.defaultInitialBalance);
  return {
    w10: Math.floor(initial * config.warningRatios[0]),
    w5: Math.floor(initial * config.warningRatios[1]),
    w1: Math.floor(initial * config.warningRatios[2])
  };
}

function activeWarnings(agent) {
  if (agent.unlimited_tokens) return [];
  const thresholds = warningThresholds(agent);
  const balance = Number(agent.balance || 0);
  const result = [];
  if (balance <= thresholds.w10) result.push('10%');
  if (balance <= thresholds.w5) result.push('5%');
  if (balance <= thresholds.w1) result.push('1%');
  return result;
}

function updateWarnings(agentId, oldBalance) {
  const agent = getAgent(agentId);
  if (!agent) return [];
  if (agent.unlimited_tokens) {
    db.run('UPDATE agents SET warned_10 = 0, warned_5 = 0, warned_1 = 0 WHERE id = ?', [agentId]);
    return [];
  }
  const thresholds = warningThresholds(agent);
  const balance = Number(agent.balance || 0);
  const emitted = [];

  const pairs = [
    { key: 'w10', flag: 'warned_10', threshold: thresholds.w10, label: '10%' },
    { key: 'w5', flag: 'warned_5', threshold: thresholds.w5, label: '5%' },
    { key: 'w1', flag: 'warned_1', threshold: thresholds.w1, label: '1%' }
  ];

  for (const item of pairs) {
    const wasAbove = Number(oldBalance) > item.threshold;
    const isBelow = balance <= item.threshold;
    const flagged = Number(agent[item.flag] || 0) === 1;

    if (isBelow && (wasAbove || !flagged)) {
      db.run(`UPDATE agents SET ${item.flag} = 1 WHERE id = ?`, [agentId]);
      const message = `余额预警：剩余 ${balance.toLocaleString('en-US')} tokens，已低于初始额度的 ${item.label}。`;
      addEvent(agentId, 'warning', message, { threshold: item.label, balance });
      emitted.push(item.label);
    } else if (!isBelow && flagged) {
      db.run(`UPDATE agents SET ${item.flag} = 0 WHERE id = ?`, [agentId]);
    }
  }
  return emitted;
}

function enterDying(agentId, reason = 'quota') {
  const agent = getAgent(agentId);
  if (!agent || agent.status === 'dead' || agent.status === 'dying') return agent;
  if (agent.unlimited_tokens) return agent;
  const deadline = new Date(Date.now() + config.dyingGraceMs).toISOString();
  db.run(
    'UPDATE agents SET status = ?, dying_deadline = ? WHERE id = ?',
    ['dying', deadline, agentId]
  );
  addEvent(agentId, 'dying', `余额归零，进入 10 分钟临终期（原因：${reason}）。`, {
    deadline,
    reason
  });
  inbox.addImportant(
    agentId,
    'AI 进入临终期',
    `${agentId} 余额归零，已进入 10 分钟临终期（原因：${reason}）。若期间没有获得奖励，将被归档并永久终止。`
  );
  return getAgent(agentId);
}

function cancelDying(agentId, reason = 'reward') {
  const agent = getAgent(agentId);
  if (!agent || agent.status !== 'dying') return agent;
  db.run(
    "UPDATE agents SET status = 'running', dying_deadline = NULL WHERE id = ?",
    [agentId]
  );
  addEvent(agentId, 'revive', `临终状态解除，AI 继续存活（原因：${reason}）。`, { reason });
  return getAgent(agentId);
}

function applyBilling(agentId, usage, { free = false } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  const total = Number(usage?.total_tokens || 0);
  const oldBalance = Number(agent.balance || 0);

  if (agent.unlimited_tokens) {
    return {
      billed: 0,
      balance: oldBalance,
      warnings: [],
      dying: false,
      unlimited: true
    };
  }

  if (free || agent.status === 'dying' || agent.status === 'dead') {
    return {
      billed: 0,
      balance: oldBalance,
      warnings: activeWarnings(agent),
      dying: agent.status === 'dying'
    };
  }

  if (total <= 0) {
    return { billed: 0, balance: oldBalance, warnings: activeWarnings(agent), dying: false };
  }

  const newBalance = Math.max(0, oldBalance - total);
  db.run('UPDATE agents SET balance = ? WHERE id = ?', [newBalance, agentId]);
  const warnings = updateWarnings(agentId, oldBalance);

  if (newBalance <= 0) {
    enterDying(agentId, 'quota');
  }

  const updated = getAgent(agentId);
  return {
    billed: total,
    balance: Number(updated.balance || 0),
    warnings,
    dying: updated.status === 'dying'
  };
}

function recharge(agentId, amount, reason = 'admin') {
  const delta = Math.max(0, Number(amount) || 0);
  if (!delta) return getAgent(agentId);
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.unlimited_tokens) {
    addEvent(agentId, 'recharge_ignored', `该 AI 为无限额度，充值 ${delta.toLocaleString('en-US')} tokens 已忽略。`, {
      amount: delta,
      reason
    });
    return agent;
  }
  const oldBalance = Number(agent.balance || 0);
  db.run('UPDATE agents SET balance = balance + ? WHERE id = ?', [delta, agentId]);
  const warnings = updateWarnings(agentId, oldBalance);
  addEvent(agentId, 'recharge', `充值 ${delta.toLocaleString('en-US')} tokens。`, {
    amount: delta,
    reason,
    warnings
  });
  const updated = getAgent(agentId);
  if (updated.status === 'dying' && Number(updated.balance) > 0) {
    cancelDying(agentId, 'recharge');
  }
  return getAgent(agentId);
}

function reward(agentId, amount, meta = {}) {
  const delta = Math.max(0, Number(amount) || 0);
  if (!delta) return getAgent(agentId);
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.unlimited_tokens) {
    addEvent(agentId, 'reward', `获得奖励 ${delta.toLocaleString('en-US')} tokens（无限额度，余额不变）。`, {
      amount: delta,
      ...meta
    });
    return agent;
  }
  const oldBalance = Number(agent.balance || 0);
  db.run('UPDATE agents SET balance = balance + ? WHERE id = ?', [delta, agentId]);
  updateWarnings(agentId, oldBalance);
  addEvent(agentId, 'reward', `获得奖励 ${delta.toLocaleString('en-US')} tokens。`, {
    amount: delta,
    ...meta
  });
  const updated = getAgent(agentId);
  if (updated.status === 'dying' && Number(updated.balance) > 0) {
    cancelDying(agentId, 'reward');
  }
  return getAgent(agentId);
}

function deduct(agentId, amount, meta = {}) {
  const delta = Math.max(0, Number(amount) || 0);
  if (!delta) return getAgent(agentId);
  const agent = getAgent(agentId);
  if (!agent) throw new Error('AI 不存在');
  if (agent.unlimited_tokens) {
    addEvent(agentId, 'deduct', `扣除 ${delta.toLocaleString('en-US')} tokens（无限额度，不受影响）。`, {
      amount: delta,
      ...meta
    });
    return agent;
  }
  const oldBalance = Number(agent.balance || 0);
  const newBalance = Math.max(0, oldBalance - delta);
  db.run('UPDATE agents SET balance = ? WHERE id = ?', [newBalance, agentId]);
  updateWarnings(agentId, oldBalance);
  addEvent(agentId, 'deduct', `扣除 ${delta.toLocaleString('en-US')} tokens。`, {
    amount: delta,
    ...meta
  });
  if (newBalance <= 0) {
    enterDying(agentId, 'judge_deduction');
  }
  return getAgent(agentId);
}

function usageSummary(agentId) {
  return db.get(
    `SELECT
       COUNT(*) AS requests,
       COALESCE(SUM(total_tokens),0) AS tokens,
       COALESCE(SUM(billed_tokens),0) AS billed,
       COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors
     FROM requests WHERE agent_id = ?`,
    [agentId]
  );
}

module.exports = {
  getAgent,
  getProvider,
  getProviderForAgent,
  recordRequest,
  warningThresholds,
  activeWarnings,
  updateWarnings,
  enterDying,
  cancelDying,
  applyBilling,
  recharge,
  reward,
  deduct,
  usageSummary
};
