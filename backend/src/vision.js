const db = require('./db');
const config = require('./config');
const llm = require('./llm');
const billing = require('./billing');

const DEFAULT_PROMPT = `你是一个屏幕视觉助手。请准确描述截图中的界面、文字、按钮、窗口和当前状态；如果用户提出具体问题，优先回答该问题。不要编造截图中不存在的内容。`;

function getConfig() {
  const row = db.get('SELECT * FROM vision_config WHERE id = 1');
  let provider = null;
  if (row?.provider_id) {
    provider = db.get('SELECT * FROM providers WHERE id = ?', [row.provider_id]);
  }
  return { config: row, provider };
}

function saveConfig({ enabled, provider_id, model, system_prompt, bill_shared }) {
  db.run(
    `UPDATE vision_config
        SET enabled = ?, provider_id = ?, model = ?, system_prompt = ?, bill_shared = ?, updated_at = ?
      WHERE id = 1`,
    [
      enabled ? 1 : 0,
      provider_id ? Number(provider_id) : null,
      model || null,
      system_prompt || '',
      bill_shared ? 1 : 0,
      new Date().toISOString()
    ]
  );
  return getConfig();
}

function resolveTarget(agent) {
  const mode = agent.vision_mode || 'none';
  if (mode === 'none') {
    const error = new Error('该 AI 未启用识图');
    error.code = 'VISION_DISABLED';
    throw error;
  }

  if (mode === 'main') {
    if (agent.model_type !== 'multimodal') {
      const error = new Error('主模型不是多模态模型，不能使用主模型识图');
      error.code = 'VISION_NOT_MULTIMODAL';
      throw error;
    }
    const provider = db.get('SELECT * FROM providers WHERE id = ?', [agent.provider_id]);
    if (!provider?.api_key) throw new Error('主模型供应商未配置 API Key');
    return { mode, provider, model: agent.model, bill: true };
  }

  if (mode === 'shared') {
    const { config: visionConfig, provider } = getConfig();
    if (!visionConfig?.enabled || !provider || !visionConfig.model) {
      const error = new Error('共用识图尚未配置或未启用');
      error.code = 'VISION_NOT_CONFIGURED';
      throw error;
    }
    if (!provider.api_key) throw new Error('共用识图供应商未配置 API Key');
    return {
      mode,
      provider,
      model: visionConfig.model,
      bill: Boolean(visionConfig.bill_shared)
    };
  }

  if (mode === 'private') {
    const provider = db.get('SELECT * FROM providers WHERE id = ?', [agent.vision_provider_id]);
    if (!provider || !agent.vision_model) {
      const error = new Error('私用识图尚未配置供应商或模型');
      error.code = 'VISION_NOT_CONFIGURED';
      throw error;
    }
    if (!provider.api_key) throw new Error('私用识图供应商未配置 API Key');
    return {
      mode,
      provider,
      model: agent.vision_model,
      bill: Boolean(agent.vision_bill)
    };
  }

  throw new Error(`未知识图模式：${mode}`);
}

/**
 * 记忆多模态专用目标解析：不受 AI 的 vision_mode 开关限制，也不要求先启用「共用识图」。
 * 顺序：AI 自己绑定的识图供应商/模型 -> AI 主模型本身是多模态 -> 任一配置了 vision_models 的供应商
 * -> 共用识图配置。只要平台存在多模态供应商，记忆的 OCR/VLM 就能用。
 */
function resolveMemoryTarget(agent) {
  if (agent?.vision_provider_id && agent?.vision_model) {
    const provider = db.get('SELECT * FROM providers WHERE id = ?', [agent.vision_provider_id]);
    if (provider?.api_key) {
      return {
        mode: 'memory_bound',
        provider,
        model: agent.vision_model,
        bill: Boolean(agent.vision_bill)
      };
    }
  }

  if (agent?.model_type === 'multimodal' && agent?.provider_id && agent?.model) {
    const provider = db.get('SELECT * FROM providers WHERE id = ?', [agent.provider_id]);
    if (provider?.api_key) {
      return { mode: 'memory_main', provider, model: agent.model, bill: true };
    }
  }

  for (const provider of db.all('SELECT * FROM providers')) {
    if (!provider.api_key) continue;
    let visionModels = [];
    try {
      visionModels = JSON.parse(provider.vision_models || '[]');
    } catch {
      visionModels = [];
    }
    if (Array.isArray(visionModels) && visionModels.length > 0) {
      return {
        mode: 'memory_shared',
        provider,
        model: visionModels[0],
        bill: Boolean(getConfig().config?.bill_shared)
      };
    }
  }

  const { config: visionConfig, provider } = getConfig();
  if (visionConfig?.enabled && provider?.api_key && visionConfig.model) {
    return { mode: 'shared', provider, model: visionConfig.model, bill: Boolean(visionConfig.bill_shared) };
  }
  return null;
}

/**
 * 记忆多模态入口：没有任何多模态供应商时明确失败，由上层降级为 D0，不阻断登记。
 */
async function describeMemory(agent, payload) {
  const target = resolveMemoryTarget(agent);
  if (!target) {
    const error = new Error('平台没有可用的多模态供应商（需在供应商配置里填写 vision_models）');
    error.code = 'VISION_NOT_CONFIGURED';
    throw error;
  }
  return describeWith(target, agent, payload);
}

async function describeWith(target, agent, { imageBase64, mimeType = 'image/png', question = '' }) {
  const { config: visionConfig } = getConfig();
  const prompt = visionConfig?.system_prompt || DEFAULT_PROMPT;
  const userText = String(question || '').trim() || '请描述这张图片，重点说明界面、文字、按钮和当前状态。';

  const messages = [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${imageBase64}` }
        }
      ]
    }
  ];

  const result = await llm.callChat({
    provider: target.provider,
    model: target.model,
    messages,
    temperature: 0.2,
    max_tokens: 1200
  });

  const usage = result.usage || {};
  let billed = 0;
  if (result.ok && target.bill) {
    const billResult = billing.applyBilling(agent.id, usage);
    billed = billResult.billed;
  }

  billing.recordRequest({
    agentId: agent.id,
    kind: 'vision',
    providerId: target.provider.id,
    model: target.model,
    usage,
    latency: result.latency,
    status: result.ok ? 'ok' : 'error',
    error: result.error,
    request: { mode: target.mode, question: userText, mime_type: mimeType },
    response: result.ok ? result.data : null,
    billed
  });

  if (!result.ok) {
    throw new Error(`识图请求失败：${result.error}`);
  }

  return {
    description: result.message?.content || '',
    usage,
    charged: billed,
    mode: target.mode,
    provider: target.provider.name,
    model: target.model
  };
}

async function describe(agent, payload) {
  return describeWith(resolveTarget(agent), agent, payload);
}

module.exports = {
  DEFAULT_PROMPT,
  getConfig,
  saveConfig,
  resolveTarget,
  resolveMemoryTarget,
  describe,
  describeMemory
};
