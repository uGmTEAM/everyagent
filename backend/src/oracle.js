const db = require('./db');
const config = require('./config');
const llm = require('./llm');
const prompts = require('./prompts');
const billing = require('./billing');
const { truncate, estimateMessagesTokens } = require('./util');

function getConfig() {
  const row = db.get('SELECT * FROM oracle_config WHERE id = 1');
  if (!row || !row.provider_id || !row.model) {
    const error = new Error('Oracle 尚未配置');
    error.code = 'ORACLE_NOT_CONFIGURED';
    throw error;
  }
  const provider = db.get('SELECT * FROM providers WHERE id = ?', [row.provider_id]);
  if (!provider) {
    const error = new Error('Oracle 的供应商不存在');
    error.code = 'ORACLE_NOT_CONFIGURED';
    throw error;
  }
  return { config: row, provider };
}

function saveConfig({ provider_id, model, system_prompt, persona }) {
  db.run(
    `UPDATE oracle_config
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
  return db.get('SELECT * FROM oracle_config WHERE id = 1');
}

function estimateCost(question) {
  const { config: oracleConfig } = getConfig();
  const messages = [
    { role: 'system', content: prompts.buildOracleSystemPrompt(oracleConfig) },
    { role: 'user', content: String(question || '') }
  ];
  const promptTokens = estimateMessagesTokens(messages);
  const maxOutputTokens = 4096;
  return {
    promptTokens,
    maxOutputTokens,
    multiplier: config.oracleCostMultiplier,
    required: (promptTokens + maxOutputTokens) * config.oracleCostMultiplier
  };
}

async function ask(agent, question) {
  const { config: oracleConfig, provider } = getConfig();
  const messages = [
    { role: 'system', content: prompts.buildOracleSystemPrompt(oracleConfig) },
    { role: 'user', content: question }
  ];

  const result = await llm.callChat({
    provider,
    model: oracleConfig.model,
    messages,
    temperature: 0.7,
    max_tokens: 4096
  });

  billing.recordRequest({
    agentId: agent.id,
    kind: 'oracle',
    providerId: provider.id,
    model: oracleConfig.model,
    usage: result.usage,
    latency: result.latency,
    status: result.ok ? 'ok' : 'error',
    error: result.error,
    request: { messages },
    response: result.ok ? result.data : null,
    billed: 0
  });

  if (!result.ok) throw new Error(`Oracle 请求失败：${result.error}`);
  const answer = truncate(result.message?.content || '', 20000);
  return {
    answer,
    tokens: Number(result.usage?.total_tokens || 0),
    usage: result.usage
  };
}

module.exports = {
  getConfig,
  saveConfig,
  estimateCost,
  ask
};
