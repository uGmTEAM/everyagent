const configModule = require('./config');
const api = require('./api');
const provider = require('./provider');
const tools = require('./tools');

const config = configModule.loadConfig();
const prompt = configModule.loadPrompt();
let state = configModule.loadState();

function saveState() {
  configModule.saveState(state);
}

function log(message) {
  console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureInitialMessage() {
  if (!Array.isArray(state.messages) || state.messages.length === 0) {
    state.messages = [
      {
        role: 'user',
        content:
          '开始工作。先获取当前任务，制定计划并持续执行。你可以使用工具，不要停下来等待人类指令。'
      }
    ];
    saveState();
  }
}

function runtimeStatus(me) {
  const lines = ['[运行时状态]'];
  const balanceText = me.unlimited
    ? '无限'
    : `${Number(me.balance || 0).toLocaleString('en-US')} tokens`;
  lines.push(
    `状态：${me.status}；余额：${balanceText}；警告：${
      (me.warnings || []).join(' / ') || '无'
    }`
  );
  lines.push(`外网：${me.allow_internet ? '允许' : '禁止'}。`);
  if (me.enable_screen) lines.push('虚拟屏：已启用（DISPLAY=:99）。');
  if (me.vision_mode && me.vision_mode !== 'none') {
    lines.push(`识图：已启用（${me.vision_mode}）。`);
  }
  if (me.dying) {
    const seconds = Math.ceil(Number(me.dying.remaining_ms || 0) / 1000);
    lines.push(`临终期：剩余 ${seconds} 秒。此阶段操作免费且不限次数；获得奖励可取消死亡。`);
  }
  if (me.current_task) {
    lines.push(`当前任务 #${me.current_task.seq}：${me.current_task.title}`);
    lines.push(`描述：${me.current_task.description}`);
    lines.push(`验收标准：${me.current_task.acceptance}`);
    if (me.current_task.long_term) {
      lines.push(`该任务是长期任务：通过后仍会保留，平台只累计完成次数（你已完成 ${me.current_task.completions || 0} 次）。`);
    }
  } else {
    lines.push('当前没有任务。继续围绕研究目标自主工作，等待平台下发任务。');
  }
  lines.push(`崩溃计数：${me.crash_attempts}/${me.max_crash_retries == null ? '∞' : me.max_crash_retries}。`);
  return lines.join('\n');
}

function buildMessages(me) {
  const sanitized = sanitizeMessages(state.messages);
  if (sanitized.changed) {
    state.messages = sanitized.messages;
    saveState();
    log('[memory] 已修复对话历史中的工具消息序列');
  }
  const messages = [{ role: 'system', content: prompt }];
  if (state.summary) {
    messages.push({ role: 'system', content: `[历史摘要]\n${state.summary}` });
  }
  messages.push({ role: 'system', content: runtimeStatus(me) });
  messages.push(...state.messages);
  return messages;
}

function applyCompressionHeaders(headers) {
  if (!headers) return;
  const summary = headers['x-ea-summary'];
  if (!summary) return;
  try {
    state.summary = Buffer.from(summary, 'base64').toString('utf8');
  } catch {
    return;
  }
  const keep = Number(headers['x-ea-keep'] || 0);
  if (keep > 0 && state.messages.length > keep) {
    state.messages = trimTail(state.messages, keep);
  }
  saveState();
  log(`[memory] 上下文已压缩，保留最近 ${state.messages.length} 条消息。`);
}

// 从尾部保留 keep 条消息，并把起点对齐到 user 消息，避免切开 assistant/tool 轮次
function trimTail(list, keep) {
  let start = Math.max(0, list.length - keep);
  while (start < list.length && list[start].role !== 'user') start += 1;
  if (start >= list.length) {
    start = Math.max(0, list.length - keep);
    while (start < list.length && list[start].role === 'tool') start += 1;
  }
  return [{ role: 'user', content: '[较早消息已省略]' }, ...list.slice(start)];
}

// 修复对话历史中不完整的工具调用序列：
// - 丢弃没有对应 assistant tool_calls 的孤立 tool 消息
// - 为缺少响应的 tool_calls 补占位响应
function sanitizeMessages(list) {
  const out = [];
  let pending = [];
  let changed = false;

  const flushPending = () => {
    if (!pending.length) return;
    for (const id of pending) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        name: 'unknown',
        content: JSON.stringify({ ok: false, error: '工具调用被中断，没有返回结果' })
      });
    }
    pending = [];
    changed = true;
  };

  for (const message of list) {
    if (!message || typeof message !== 'object') {
      changed = true;
      continue;
    }
    if (message.role === 'tool') {
      const index = pending.indexOf(message.tool_call_id);
      if (index === -1) {
        changed = true;
        continue;
      }
      pending.splice(index, 1);
      out.push(message);
      continue;
    }

    flushPending();
    out.push(message);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      pending = message.tool_calls.map((call) => call.id).filter(Boolean);
    }
  }

  flushPending();
  return { messages: out, changed };
}

function trimState() {
  if (state.messages.length > 300) {
    state.messages = trimTail(state.messages, 250);
  }
  let size = JSON.stringify(state.messages).length;
  while (size > 3000000 && state.messages.length > 40) {
    state.messages = trimTail(state.messages, Math.max(20, state.messages.length - 20));
    size = JSON.stringify(state.messages).length;
  }
}

async function safeExecute(name, args) {
  try {
    const result = await tools.executeTool({
      tool: name,
      args,
      config,
      state,
      saveState
    });
    const serialized = JSON.stringify(result);
    log(`[tool] ${name} ok (${serialized.length} bytes)`);
    return result;
  } catch (error) {
    log(`[tool] ${name} error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function observation(name, result) {
  return `<observation tool="${name}">${tools.truncate(JSON.stringify(result), 30000)}</observation>`;
}

function nudge() {
  return (
    '继续。请自主决定下一步行动。' +
    '如果需要执行操作，使用工具调用；如果当前任务已经完成，调用 submit_task 提交。' +
    '不要停下来等待人类指令。'
  );
}

function noticeMessage(notice) {
  const text = String(notice || '');
  const lines = ['[平台通知]', text];
  if (text.includes('管理员留言')) {
    lines.push('');
    lines.push('这是管理员留言，不是任务，不要提交 Judge。需要回复时调用 message_admin。');
  }
  lines.push('');
  lines.push('请先处理这条通知，再继续当前工作。');
  return lines.join('\n');
}

async function run() {
  ensureInitialMessage();
  log(`[boot] ${config.id} model=${config.model} pause_max=${config.pauseMaxMinutes}min`);

  let toolMode = state.toolMode || 'auto';
  let textIdleRounds = 0;
  let nativeProbeAfter = 0;

  while (true) {
    let me;
    try {
      me = await api.me();
    } catch (error) {
      if (error.status === 410) {
        log('[exit] AI 已死亡');
        process.exit(0);
      }
      if (error.status === 401) {
        log('[fatal] AGENT_KEY 无效');
        process.exit(1);
      }
      log(`[api] /me 失败：${error.message}，10 秒后重试`);
      await sleep(10000);
      continue;
    }

    if (me.status === 'dead') {
      log('[exit] AI 已死亡');
      process.exit(0);
    }

    if (me.force_wake) {
      if (state.pauseUntil) log('[pause] 管理员留言强制唤醒，取消暂停');
      state.pauseUntil = null;
      saveState();
    }

    // 平台通知与任务变更写入对话历史，避免仅存在于本轮系统提示而丢失
    if (me.notice) {
      state.messages.push({ role: 'user', content: noticeMessage(me.notice) });
      saveState();
      log('[notice] 平台通知已写入对话');
    }

    const currentTaskId = me.current_task ? me.current_task.id : null;
    if (currentTaskId !== (state.taskId ?? null)) {
      state.taskId = currentTaskId;
      if (me.current_task) {
        state.messages.push({
          role: 'user',
          content:
            `[平台通知] 新的当前任务 #${me.current_task.seq}：${me.current_task.title}\n` +
            '请调用 get_current_task 查看描述和验收标准，然后开始执行。'
        });
        log(`[task] 当前任务切换为 #${me.current_task.seq}`);
      } else {
        log('[task] 当前没有任务');
      }
      saveState();
    }

    if (state.pauseUntil) {
      const until = Date.parse(state.pauseUntil);
      if (Number.isFinite(until) && Date.now() < until) {
        const wait = Math.min(until - Date.now(), 10000);
        log(`[pause] 暂停中，剩余 ${Math.ceil((until - Date.now()) / 1000)} 秒`);
        await sleep(wait);
        continue;
      }
      state.pauseUntil = null;
      saveState();
      log('[pause] 恢复运行');
    }

    const messages = buildMessages(me);
    const result = await provider.callModel({
      config,
      messages,
      tools: tools.getToolDefinitions(config),
      toolMode
    });

    if (result.retryText) {
      toolMode = 'text';
      state.toolMode = 'text';
      saveState();
      log(`[tool-mode] 原生工具调用不可用，切换到文本动作协议：${result.error}`);
      continue;
    }

    if (result.fatal) {
      log(`[fatal] 操作被拒绝：${result.error}`);
      if (result.status === 410) process.exit(0);
      await sleep(30000);
      continue;
    }

    if (!result.ok) {
      log(`[error] 操作失败：${result.error}`);
      await sleep(10000);
      continue;
    }

    applyCompressionHeaders(result.headers);
    if (toolMode === 'auto' && result.message.tool_calls) {
      toolMode = 'native';
      state.toolMode = 'native';
      saveState();
      log('[tool-mode] 原生工具调用可用');
    }

    const message = result.message;
    const assistantMessage = {
      role: 'assistant',
      content: message.content || ''
    };
    if (message.tool_calls) assistantMessage.tool_calls = message.tool_calls;
    state.messages.push(assistantMessage);

    if (message.content) {
      log(`[assistant] ${message.content.slice(0, 1500)}`);
    }
    if (message.reasoning_content) {
      log(`[reasoning] ${message.reasoning_content.slice(0, 800)}`);
    }

    if (message.tool_calls && toolMode !== 'text') {
      for (const call of message.tool_calls) {
        const name = call.function?.name || 'unknown';
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch (error) {
          state.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: JSON.stringify({ ok: false, error: `工具参数 JSON 解析失败：${error.message}` })
          });
          continue;
        }
        const toolResult = await safeExecute(name, args);
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: tools.truncate(JSON.stringify(toolResult), 30000)
        });
      }
    } else {
      const parsed = tools.parseActions(message.content || '');
      if (parsed.errors.length) {
        state.messages.push({
          role: 'user',
          content: `<observation>工具调用解析失败：${parsed.errors.join('；')}。请只输出合法的 JSON 动作。</observation>`
        });
      }

      for (const action of parsed.actions) {
        const toolResult = await safeExecute(action.tool, action.args);
        state.messages.push({
          role: 'user',
          content: observation(action.tool, toolResult)
        });
      }

      if (!parsed.actions.length && !parsed.errors.length) {
        state.messages.push({ role: 'user', content: nudge() });
        // 文本模式下连续拿不到可执行动作，尝试重新探测原生工具调用
        textIdleRounds += 1;
        if (textIdleRounds >= 3 && Date.now() > nativeProbeAfter) {
          toolMode = 'auto';
          state.toolMode = 'auto';
          nativeProbeAfter = Date.now() + 300000;
          textIdleRounds = 0;
          log('[tool-mode] 文本模式连续无动作，重新探测原生工具调用');
        }
      } else {
        textIdleRounds = 0;
      }
    }

    trimState();
    saveState();
    await sleep(300);
  }
}

process.on('SIGTERM', () => {
  log('[shutdown] 收到 SIGTERM');
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('[shutdown] 收到 SIGINT');
  saveState();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log(`[uncaught] ${error.stack || error.message}`);
  try {
    saveState();
  } catch {
    // ignore
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`[unhandled] ${reason?.stack || reason}`);
});

run().catch((error) => {
  log(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
