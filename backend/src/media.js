const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const billing = require('./billing');
const { nowIso, truncate } = require('./util');

function getConfig() {
  return db.get('SELECT * FROM media_config WHERE id = 1');
}

function getProvider(providerId) {
  if (!providerId) return null;
  return db.get('SELECT * FROM providers WHERE id = ?', [providerId]);
}

function apiBase(provider) {
  return String(provider.base_url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
}

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function targetDir(agentId) {
  const dir = path.join(config.workspacesDir, agentId, 'workspace', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileName(prefix, ext) {
  return `${prefix}-${nowIso().replace(/[:.]/g, '-')}.${ext}`;
}

function resolveTarget(cfg, kind) {
  if (kind === 'image') {
    if (!cfg?.image_enabled) throw failure('平台未启用生图', 'IMAGE_DISABLED');
    const provider = getProvider(cfg.image_provider_id);
    if (!provider || !cfg.image_model) throw failure('生图未配置供应商或模型', 'IMAGE_NOT_CONFIGURED');
    if (!provider.api_key) throw failure('生图供应商未配置 API Key', 'IMAGE_NOT_CONFIGURED');
    return { provider, model: cfg.image_model };
  }
  if (kind === 'asr') {
    if (!cfg?.asr_enabled) throw failure('平台未启用语音识别', 'ASR_DISABLED');
    const provider = getProvider(cfg.asr_provider_id);
    if (!provider || !cfg.asr_model) throw failure('语音识别未配置供应商或模型', 'ASR_NOT_CONFIGURED');
    if (!provider.api_key) throw failure('语音识别供应商未配置 API Key', 'ASR_NOT_CONFIGURED');
    return { provider, model: cfg.asr_model };
  }
  if (!cfg?.speech_enabled) throw failure('平台未启用语音合成', 'SPEECH_DISABLED');
  const provider = getProvider(cfg.speech_provider_id);
  if (!provider || !cfg.speech_model) throw failure('语音合成未配置供应商或模型', 'SPEECH_NOT_CONFIGURED');
  if (!provider.api_key) throw failure('语音供应商未配置 API Key', 'SPEECH_NOT_CONFIGURED');
  return { provider, model: cfg.speech_model };
}

function today() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function usedSecondsToday(agentId, day = today()) {
  const row = db.get(
    'SELECT COALESCE(SUM(seconds), 0) AS total FROM speech_recognition_usage WHERE agent_id = ? AND day = ?',
    [agentId, day]
  );
  return Number(row?.total || 0);
}


function record({ agent, kind, provider, model, startedAt, ok, error, request, response }) {
  try {
    billing.recordRequest({
      agentId: agent?.id || null,
      kind,
      providerId: provider?.id || null,
      model,
      usage: {},
      latency: Date.now() - startedAt,
      status: ok ? 'ok' : 'error',
      error: error || null,
      request,
      response,
      billed: 0
    });
  } catch {
    // 统计失败不影响主流程
  }
}

async function generateImage(agent, { prompt, size } = {}) {
  const cfg = getConfig();
  const { provider, model } = resolveTarget(cfg, 'image');
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw failure('prompt 不能为空', 'IMAGE_PROMPT_EMPTY');

  const extra = String(cfg.image_extra_prompt || '').trim();
  const finalPrompt = extra ? `${cleanPrompt}\n\n${extra}` : cleanPrompt;
  const imageSize = String(size || cfg.image_size || '1024x1024').trim() || '1024x1024';
  const body = { model, prompt: finalPrompt, n: 1, size: imageSize };
  const startedAt = Date.now();

  let data;
  try {
    const response = await fetch(`${apiBase(provider)}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.api_key}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000)
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new Error(parsed?.error?.message || parsed?.message || truncate(text, 1000) || `HTTP ${response.status}`);
    }
    if (!parsed) throw new Error('生图接口返回了无法解析的 JSON');
    data = parsed;
  } catch (error) {
    record({
      agent,
      kind: 'image',
      provider,
      model,
      startedAt,
      ok: false,
      error: error.message,
      request: { prompt: truncate(cleanPrompt, 2000), size: imageSize },
      response: null
    });
    throw failure(`生图失败：${error.message}`, 'IMAGE_FAILED');
  }

  const item = data?.data?.[0] || data?.images?.[0] || data || {};
  let buffer = null;
  let ext = 'png';
  let sourceUrl = item.url || null;

  if (item.b64_json) {
    buffer = Buffer.from(String(item.b64_json), 'base64');
  } else if (sourceUrl) {
    try {
      const download = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) });
      if (!download.ok) throw new Error(`HTTP ${download.status}`);
      const type = download.headers.get('content-type') || '';
      if (type.includes('jpeg')) ext = 'jpg';
      else if (type.includes('webp')) ext = 'webp';
      buffer = Buffer.from(await download.arrayBuffer());
    } catch (error) {
      throw failure(`图片下载失败：${error.message}`, 'IMAGE_FAILED');
    }
  }

  if (!buffer || !buffer.length) {
    throw failure('生图接口没有返回图片数据', 'IMAGE_EMPTY');
  }

  const file = path.join(targetDir(agent.id), fileName('image', ext));
  fs.writeFileSync(file, buffer);
  const containerPath = `/workspace/generated/${path.basename(file)}`;

  record({
    agent,
    kind: 'image',
    provider,
    model,
    startedAt,
    ok: true,
    request: { prompt: truncate(cleanPrompt, 2000), size: imageSize },
    response: { url: sourceUrl, path: containerPath, bytes: buffer.length }
  });

  return {
    path: containerPath,
    host_path: file,
    bytes: buffer.length,
    model,
    provider: provider.name,
    size: imageSize,
    url: sourceUrl,
    revised_prompt: item.revised_prompt || null
  };
}

async function synthesizeSpeech(agent, { text, voice } = {}) {
  const cfg = getConfig();
  const { provider, model } = resolveTarget(cfg, 'speech');
  const cleanText = String(text || '').trim();
  if (!cleanText) throw failure('text 不能为空', 'SPEECH_TEXT_EMPTY');
  if (cleanText.length > 4000) throw failure('text 过长，最多 4000 字符', 'SPEECH_TEXT_TOO_LONG');

  const style = cfg.speech_style === 'chat' ? 'chat' : 'audio';
  const voiceName = String(voice || cfg.speech_voice || (style === 'chat' ? 'mimo_default' : 'alloy')).trim()
    || (style === 'chat' ? 'mimo_default' : 'alloy');
  const startedAt = Date.now();

  let buffer;
  try {
    if (style === 'chat') {
      const response = await fetch(`${apiBase(provider)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.api_key}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: '请用自然、清晰、平稳的语气朗读下面这段文字。' },
            { role: 'assistant', content: cleanText }
          ],
          audio: { format: 'mp3', voice: voiceName }
        }),
        signal: AbortSignal.timeout(180000)
      });
      const textBody = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(textBody);
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        throw new Error(parsed?.error?.message || parsed?.message || truncate(textBody, 1000) || `HTTP ${response.status}`);
      }
      const data = parsed?.choices?.[0]?.message?.audio?.data;
      if (!data) throw new Error('语音接口没有返回音频数据');
      buffer = Buffer.from(String(data), 'base64');
    } else {
      const response = await fetch(`${apiBase(provider)}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.api_key}`
        },
        body: JSON.stringify({ model, input: cleanText, voice: voiceName, response_format: 'mp3' }),
        signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) {
        const textBody = await response.text();
        let message = truncate(textBody, 1000);
        try {
          const parsed = JSON.parse(textBody);
          message = parsed?.error?.message || parsed?.message || message;
        } catch {
          // ignore
        }
        throw new Error(message || `HTTP ${response.status}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }
  } catch (error) {
    record({
      agent,
      kind: 'speech',
      provider,
      model,
      startedAt,
      ok: false,
      error: error.message,
      request: { text: truncate(cleanText, 1000), voice: voiceName },
      response: null
    });
    throw failure(`语音合成失败：${error.message}`, 'SPEECH_FAILED');
  }

  if (!buffer.length) throw failure('语音接口没有返回音频数据', 'SPEECH_EMPTY');

  const file = path.join(targetDir(agent.id), fileName('speech', 'mp3'));
  fs.writeFileSync(file, buffer);
  const containerPath = `/workspace/generated/${path.basename(file)}`;

  record({
    agent,
    kind: 'speech',
    provider,
    model,
    startedAt,
    ok: true,
    request: { text: truncate(cleanText, 1000), voice: voiceName },
    response: { path: containerPath, bytes: buffer.length }
  });

  return {
    path: containerPath,
    host_path: file,
    bytes: buffer.length,
    model,
    provider: provider.name,
    voice: voiceName
  };
}

function resolveWorkspaceFile(agentId, containerPath) {
  const raw = String(containerPath || '').trim();
  if (!raw.startsWith('/workspace/')) {
    throw failure('只能识别 /workspace 下的音频文件', 'ASR_PATH_INVALID');
  }
  const rel = raw.slice('/workspace/'.length);
  if (!rel || rel.includes('..')) {
    throw failure('音频路径不合法', 'ASR_PATH_INVALID');
  }
  const root = path.join(config.workspacesDir, agentId, 'workspace');
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) {
    throw failure('音频路径不合法', 'ASR_PATH_INVALID');
  }
  return file;
}

function audioFormatOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.mp3') return { format: 'mp3', mime: 'audio/mpeg' };
  if (ext === '.wav') return { format: 'wav', mime: 'audio/wav' };
  return null;
}

async function recognizeSpeech(agent, { path: containerPath, audioBase64, mimeType, language } = {}) {
  const cfg = getConfig();
  const { provider, model } = resolveTarget(cfg, 'asr');
  const limitSeconds = Math.max(1, Number(cfg.asr_daily_limit_minutes || 120)) * 60;
  const used = usedSecondsToday(agent.id);
  if (used >= limitSeconds) {
    throw failure(
      `今日语音识别额度已用尽（上限 ${Math.round(limitSeconds / 60)} 分钟），明天自动恢复`,
      'ASR_DAILY_LIMIT'
    );
  }

  let buffer = null;
  let format = null;
  let mime = null;
  let sourcePath = null;

  if (audioBase64) {
    const raw = String(audioBase64);
    if (raw.length > 40 * 1024 * 1024) {
      throw failure('音频过大，请压缩后再识别', 'ASR_AUDIO_TOO_LARGE');
    }
    buffer = Buffer.from(raw, 'base64');
    const declared = String(mimeType || '').toLowerCase();
    if (declared.includes('mpeg') || declared.includes('mp3')) {
      format = 'mp3';
      mime = 'audio/mpeg';
    } else if (declared.includes('wav')) {
      format = 'wav';
      mime = 'audio/wav';
    } else {
      throw failure('仅支持 mp3 或 wav 音频', 'ASR_FORMAT_UNSUPPORTED');
    }
  } else {
    sourcePath = resolveWorkspaceFile(agent.id, containerPath);
    const info = audioFormatOf(sourcePath);
    if (!info) throw failure('仅支持 mp3 或 wav 音频（可先用 ffmpeg 转换）', 'ASR_FORMAT_UNSUPPORTED');
    format = info.format;
    mime = info.mime;
    if (!fs.existsSync(sourcePath)) throw failure('音频文件不存在', 'ASR_FILE_MISSING');
    const size = fs.statSync(sourcePath).size;
    if (size > 30 * 1024 * 1024) throw failure('音频过大，请压缩后再识别', 'ASR_AUDIO_TOO_LARGE');
    buffer = fs.readFileSync(sourcePath);
  }

  if (!buffer || !buffer.length) throw failure('音频内容为空', 'ASR_AUDIO_EMPTY');

  const lang = ['auto', 'zh', 'en'].includes(String(language || cfg.asr_language || 'auto'))
    ? String(language || cfg.asr_language || 'auto')
    : 'auto';
  const startedAt = Date.now();
  const containerRef = containerPath || null;

  let data;
  try {
    const response = await fetch(`${apiBase(provider)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.api_key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: `data:${mime};base64,${buffer.toString('base64')}` }
              }
            ]
          }
        ],
        asr_options: { language: lang }
      }),
      signal: AbortSignal.timeout(300000)
    });
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || truncate(text, 1000) || `HTTP ${response.status}`);
    }
    if (!data) throw new Error('语音识别接口返回了无法解析的 JSON');
  } catch (error) {
    record({
      agent,
      kind: 'asr',
      provider,
      model,
      startedAt,
      ok: false,
      error: error.message,
      request: { path: containerRef, format, language: lang, bytes: buffer.length },
      response: null
    });
    throw failure(`语音识别失败：${error.message}`, 'ASR_FAILED');
  }

  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  const seconds = Math.max(0, Math.round(Number(data?.usage?.seconds || 0)));
  const now = nowIso();
  db.run(
    'INSERT INTO speech_recognition_usage (agent_id, day, seconds, created_at) VALUES (?, ?, ?, ?)',
    [agent.id, today(), seconds, now]
  );
  const usedNow = used + seconds;

  record({
    agent,
    kind: 'asr',
    provider,
    model,
    startedAt,
    ok: true,
    request: { path: containerRef, format, language: lang, bytes: buffer.length },
    response: { text: truncate(text, 2000), seconds }
  });

  return {
    text,
    seconds,
    format,
    language: lang,
    model,
    provider: provider.name,
    path: containerRef,
    used_seconds: usedNow,
    limit_seconds: limitSeconds,
    remaining_seconds: Math.max(0, limitSeconds - usedNow),
    remaining_minutes: Math.max(0, Math.round((limitSeconds - usedNow) / 60))
  };
}

function usageToday(agentId) {
  const used = usedSecondsToday(agentId);
  return { used_seconds: used, used_minutes: Math.round(used / 60) };
}

module.exports = {
  getConfig,
  generateImage,
  synthesizeSpeech,
  recognizeSpeech,
  usedSecondsToday,
  usageToday
};
