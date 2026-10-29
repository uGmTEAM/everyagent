'use strict';

// AI 侧记忆接口。挂载在 /api/agent/memory 下，复用 agentApi 的 AGENT_KEY 认证。
// 每个 AI 一个独立记忆库：<AI 工作区>/.memory/memory.db（容器内 /workspace/.memory/memory.db）
// 契约依据：§1 接口层、§3 作用域隔离、§18 API 契约。

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const agents = require('../agents');
const media = require('../media');
const vision = require('../vision');
const memoryService = require('../../../memory-service/index.js');
const { nowIso } = require('../util');

const router = express.Router();

function contextFor(req) {
  const agentId = req.agent.id;
  return memoryService.forAgent({
    agentId,
    workspaceDir: agents.workspaceDir(agentId),
    userId: req.body?.user_id || memoryService.DEFAULT_USER_ID
  });
}

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

// 把容器内的 /workspace/... 路径映射到宿主机工作区，用于多模态适配器读取文件。
function hostPathOf(agentId, containerPath) {
  const ws = agents.workspaceDir(agentId);
  const rel = String(containerPath || '').replace(/^\/workspace\/?/, '');
  const resolved = path.resolve(ws, rel);
  if (!resolved.startsWith(path.resolve(ws))) return null;
  return resolved;
}

function mimeOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function logged(name, fn) {
  return async (description) => {
    try {
      return await fn(description);
    } catch (error) {
      // 适配器失败只降级，不阻断档案；日志留痕便于排查
      console.warn(`[memory] ${name} 适配器失败：${error.message}`);
      throw error;
    }
  };
}

function adaptersFor(req) {
  const agent = req.agent;
  // media.js 调用适配器时传入的是 description（含 host path / container_path）。
  const fileOf = (description = {}) => {
    const candidate = String(description.container_path || description.path || '');
    const host = candidate.startsWith('/workspace')
      ? hostPathOf(agent.id, candidate)
      : (fs.existsSync(candidate) ? candidate : null);
    if (!host || !fs.existsSync(host)) throw new Error(`文件不存在：${candidate}`);
    return {
      base64: fs.readFileSync(host).toString('base64'),
      mime: description.mime || mimeOf(candidate)
    };
  };
  return {
    asr: logged('asr', async (description) => {
      const file = fileOf(description);
      return media.recognizeSpeech(agent, {
        audioBase64: file.base64,
        mimeType: file.mime,
        language: description.language
      });
    }),
    ocr: logged('ocr', async (description) => {
      const file = fileOf(description);
      // 记忆多模态直接走平台多模态模型（如 Agnes），不依赖「共用识图」开关
      return vision.describeMemory(agent, {
        imageBase64: file.base64,
        mimeType: file.mime,
        question: '请提取图中所有可见文字，按阅读顺序输出。'
      });
    }),
    vlm: logged('vlm', async (description) => {
      const file = fileOf(description);
      return vision.describeMemory(agent, {
        imageBase64: file.base64,
        mimeType: file.mime,
        question: description.prompt || description.question || '描述这张图片的关键内容、场景、人物与文字。'
      });
    })
  };
}

function stableSpanId(span) {
  const parts = [
    span.source_type || 'agent_note',
    span.source_id || '',
    span.text_excerpt || '',
    span.t_stamp || ''
  ].join('|');
  return `span_${crypto.createHash('sha1').update(parts).digest('hex').slice(0, 16)}`;
}

/**
 * 契约里 evidence_refs / source_span 是 span_id 字符串列表，
 * AI 侧更方便传对象，这里统一转成稳定的 span_id。
 */
function normalizeEvidencePayload(body) {
  const evidence = body.evidence && typeof body.evidence === 'object' ? { ...body.evidence } : {};
  const toId = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return stableSpanId(value);
    return String(value);
  };

  const spanId = toId(evidence.source_span ?? body.source_span);
  let refs = evidence.evidence_refs ?? body.evidence_refs;
  if (!Array.isArray(refs)) refs = refs ? [refs] : [];
  const refIds = refs.map(toId).filter(Boolean);

  const spanText = (evidence.source_span && typeof evidence.source_span === 'object' && evidence.source_span.text_excerpt)
    || body.text
    || '';
  if (spanId && !spanText && body.text) {
    // 没有显式 excerpt 时用正文兜底，保证证据可追溯
    evidence.source_span = { source_type: 'agent_note', source_id: body.source_id || 'agent', text_excerpt: String(body.text).slice(0, 500) };
  }

  if (spanId && !refIds.includes(spanId)) refIds.unshift(spanId);
  if (!spanId && refIds.length) {
    return { ...evidence, source_span: refIds[0], evidence_refs: refIds };
  }
  return { ...evidence, source_span: spanId, evidence_refs: refIds };
}

// 写入记忆。支持两种形态：{text, type} 或完整 MemoryItem。
router.post('/write', (req, res) => {
  try {
    const ctx = contextFor(req);
    const body = req.body || {};
    const item = { ...(body.item || body) };
    item.evidence = normalizeEvidencePayload(body);
    delete item.evidence_refs;
    delete item.source_span;
    const result = ctx.write({
      items: [item],
      source_turn_id: body.source_turn_id || null,
      user_id: body.user_id,
      scope: body.scope,
      layer: body.layer,
      now: body.now || nowIso()
    });
    const status = result.status || 500;
    res.status(status === 207 ? 207 : status === 422 ? 422 : 200).json(result);
  } catch (error) {
    fail(res, 500, 'MEMORY_WRITE_FAILED', error.message);
  }
});

// 召回记忆。返回可供直接注入上下文的 selected / pointers。
router.post('/recall', (req, res) => {
  try {
    const ctx = contextFor(req);
    const body = req.body || {};
    const result = ctx.recall({
      query: String(body.query || ''),
      token_budget: body.token_budget ?? body.budget,
      top_k: body.top_k,
      layer: body.layer,
      types: body.types,
      scenario: body.scenario,
      sensitivity_max: body.sensitivity_max,
      purpose: body.purpose,
      now: body.now || nowIso(),
      use_embedder: body.use_embedder
    });
    res.json(result);
  } catch (error) {
    fail(res, 500, 'MEMORY_RECALL_FAILED', error.message);
  }
});

// 遗忘（删除级联）。
router.post('/forget', (req, res) => {
  try {
    const ctx = contextFor(req);
    const body = req.body || {};
    const result = ctx.forget({
      mem_ids: body.mem_ids || (body.mem_id ? [body.mem_id] : []),
      reason: body.reason,
      now: body.now || nowIso()
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    fail(res, 500, 'MEMORY_FORGET_FAILED', error.message);
  }
});

// 库统计：条目数、按类型/层分布、配额、审计链状态。
router.get('/stats', (req, res) => {
  try {
    const ctx = contextFor(req);
    const total = ctx.store.get('SELECT COUNT(*) AS n FROM memory_item WHERE agent_id = ?', ctx.agentId);
    const byType = ctx.store.all(
      'SELECT type, COUNT(*) AS n FROM memory_item WHERE agent_id = ? GROUP BY type ORDER BY type',
      ctx.agentId
    );
    const byLayer = ctx.store.all(
      'SELECT layer, COUNT(*) AS n FROM memory_item WHERE agent_id = ? GROUP BY layer ORDER BY layer',
      ctx.agentId
    );
    res.json({
      ok: true,
      agent_id: ctx.agentId,
      db: ctx.store.file,
      total: total?.n || 0,
      by_type: byType,
      by_layer: byLayer,
      quota: ctx.quota(),
      audit_chain: ctx.audit.verify()
    });
  } catch (error) {
    fail(res, 500, 'MEMORY_STATS_FAILED', error.message);
  }
});

// 登记多模态文件（不解析）。
router.post('/media/register', (req, res) => {
  try {
    const ctx = contextFor(req);
    const body = req.body || {};
    if (!body.path) return fail(res, 400, 'INVALID_PAYLOAD', 'path 不能为空');
    const host = hostPathOf(ctx.agentId, body.path);
    if (!host || !fs.existsSync(host)) {
      return fail(res, 404, 'FILE_NOT_FOUND', `文件不存在：${body.path}`);
    }
    const stat = fs.statSync(host);
    const result = ctx.registerFile({
      file: {
        // 宿主机真实路径只在本进程内供适配器读取，不落库、不出现在返回里
        path: host,
        container_path: body.path,
        file_name: path.basename(body.path),
        mime_type: body.mime_type || mimeOf(body.path),
        size_bytes: stat.size,
        source: body.source || 'agent',
        sensitivity: body.sensitivity || 'S1'
      },
      now: body.now || nowIso()
    });
    res.json({ ok: true, result });
  } catch (error) {
    fail(res, 500, 'MEDIA_REGISTER_FAILED', error.message);
  }
});

// 构建档案（D0-D3），ASR/OCR/VLM 走平台接口。
router.post('/media/dossier', async (req, res) => {
  try {
    const ctx = contextFor(req);
    const body = req.body || {};
    const result = await ctx.buildDossier(
      {
        file_id: body.file_id,
        file_path: body.path,
        now: body.now || nowIso()
      },
      adaptersFor(req)
    );
    res.json({ ok: true, result });
  } catch (error) {
    fail(res, 500, 'MEDIA_DOSSIER_FAILED', error.message);
  }
});

// 多模态检索。
router.post('/media/search', async (req, res) => {
  try {
    const ctx = contextFor(req);
    const body = req.body || {};
    const result = await ctx.searchMedia(
      {
        query: String(body.query || ''),
        file_ids: body.file_ids,
        top_k: body.top_k,
        now: body.now || nowIso()
      },
      adaptersFor(req)
    );
    res.json(result);
  } catch (error) {
    fail(res, 500, 'MEDIA_SEARCH_FAILED', error.message);
  }
});

// 审计追溯。
router.get('/audit/trace', (req, res) => {
  try {
    const ctx = contextFor(req);
    res.json({
      ok: true,
      trace: ctx.audit.trace({ target_id: req.query.target_id, limit: Number(req.query.limit) || 50 }),
      chain: ctx.audit.verify()
    });
  } catch (error) {
    fail(res, 500, 'AUDIT_TRACE_FAILED', error.message);
  }
});

module.exports = router;
