const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const kb = require('./kb');
const api = require('./api');

const MAX_OUTPUT = 200000;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'shell_exec',
      description: '在容器内执行 bash 命令，工作目录为 /workspace。后台进程请自行重定向输出，例如 nohup cmd > log 2>&1 &。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 bash 命令' },
          timeout_seconds: { type: 'integer', description: '超时秒数，默认 120，最大 600' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文本文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: '起始行，默认 1' },
          limit: { type: 'integer', description: '最多读取行数，默认 2000' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件，自动创建父目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录内容。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'kb_ingest',
      description: '把文件或目录切片并写入私有知识库。使用本地 Ollama 向量化。',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '文件或目录路径列表' },
          name: { type: 'string', description: '知识库名称，可省略' }
        },
        required: ['paths']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'kb_search',
      description: '检索私有知识库。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'integer' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_balance',
      description: '查询余额、状态、警告和当前任务。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_task',
      description: '获取当前任务。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_task',
      description: '提交当前任务成果，由 Judge 判定。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '成果正文、结论、验证方式等' },
          files: { type: 'array', items: { type: 'string' }, description: '可选的文件路径列表，运行时会读取内容一并提交' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_oracle',
      description: '询问后端独立 Oracle AI。费用为它本次实际消耗 token 的 10 倍。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pause',
      description: '暂停运行。单次最多 30 分钟，到点自动恢复，不消耗 token。',
      parameters: {
        type: 'object',
        properties: { minutes: { type: 'integer' } },
        required: ['minutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'message_admin',
      description: '给平台管理员留言。留言会进入管理员后台的「信息」，不会中断当前任务，也不会立即收到回复。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '留言正文，说明诉求、问题或需要管理员知道的事' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'image_generate',
      description: '调用平台生图模型生成图片，保存到 /workspace/generated/ 并返回路径。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述，越具体越好' },
          size: { type: 'string', description: '可选尺寸，例如 1024x1024' }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'speech_synthesize',
      description: '把文本合成为语音 mp3，保存到 /workspace/generated/ 并返回路径。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要朗读的文本，最多 4000 字符' },
          voice: { type: 'string', description: '可选音色，例如 alloy' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'speech_recognize',
      description: '把 /workspace 下的音频文件（mp3/wav）识别为文本。按音频时长计入每日额度。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '容器内音频路径，例如 /workspace/audio.mp3' },
          language: { type: 'string', description: '可选语种：auto（默认）、zh、en' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description: '写入一条长期记忆（事实/偏好/任务/情感/关系/流程等）。记忆存在你自己的容器内 /workspace/.memory/，只有你能读取。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '记忆内容，一段话即可' },
          type: {
            type: 'string',
            description: '类型：fact（事实）、preference（偏好）、affect（情感）、task（任务）、relationship（关系）、procedure（流程）、media_dossier（媒体档案）',
            enum: ['fact', 'preference', 'affect', 'task', 'relationship', 'procedure', 'media_dossier']
          },
          layer: {
            type: 'string',
            description: '记忆层级：M1 工作记忆、M2 短期、M3 长期（默认）、M4 永久',
            enum: ['M1', 'M2', 'M3', 'M4']
          },
          importance: { type: 'number', description: '重要度 0-1，默认 0.5' },
          confidence: { type: 'number', description: '置信度 0-1，默认 0.5' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          evidence: { type: 'string', description: '这条记忆的来源/依据，例如某次对话或文件路径' }
        },
        required: ['text', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: '按语义检索你自己的长期记忆，返回可直接参考的条目或指针。开始一项任务前建议先检索一次。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或一句话描述' },
          budget: { type: 'integer', description: '本次用于记忆的 token 预算，默认 1200' },
          top_k: { type: 'integer', description: '最多返回条数，默认 8' },
          types: { type: 'array', items: { type: 'string' }, description: '可选：只检索这些类型' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: '遗忘指定记忆（删除并级联清理证据与索引）。用于纠正错误记忆。',
      parameters: {
        type: 'object',
        properties: {
          mem_ids: { type: 'array', items: { type: 'string' }, description: '要遗忘的记忆 ID 列表' },
          reason: { type: 'string', description: '遗忘原因' }
        },
        required: ['mem_ids']
      }
    }
  }
];

const SCREEN_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'screen_screenshot',
      description: '截取虚拟桌面全屏，保存为 PNG，返回文件路径和大小。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_record',
      description: '录制虚拟桌面视频并保存为 mp4（x11grab），返回文件路径、大小和时长。',
      parameters: {
        type: 'object',
        properties: {
          duration: { type: 'integer', description: '录制秒数，默认 10，最大 120' },
          fps: { type: 'integer', description: '帧率，默认 10，最大 30' },
          output: { type: 'string', description: '可选文件名（保存到 /workspace/.agent/recordings）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_click',
      description: '在虚拟屏幕坐标点击。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          button: { type: 'integer', description: '1 左键，2 中键，3 右键' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_type',
      description: '在虚拟屏幕中输入文本。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_key',
      description: '发送按键，例如 Return、Escape、ctrl+l。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_scroll',
      description: '在指定坐标滚动。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          direction: { type: 'string', description: 'up 或 down' },
          amount: { type: 'integer' }
        },
        required: ['x', 'y', 'direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_drag',
      description: '从起点拖动到终点。',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'integer' },
          y1: { type: 'integer' },
          x2: { type: 'integer' },
          y2: { type: 'integer' },
          duration_ms: { type: 'integer' }
        },
        required: ['x1', 'y1', 'x2', 'y2']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_mouse_move',
      description: '移动鼠标到指定坐标。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' }
        },
        required: ['x', 'y']
      }
    }
  }
];

const VISION_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'vision_describe',
    description: '让视觉模型描述图片或截图。默认发送原图；图片过大时把 compress 设为 true。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string' },
        question: { type: 'string' },
        compress: { type: 'boolean' }
      },
      required: ['image_path']
    }
  }
};

// 陪伴模式专用工具：通过平台转发 QQ 消息
const COMPANION_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'qq_send',
      description: '向指定 QQ 会话发送文本消息。conversation_id / kind / reply_to 一般取自收到的消息。',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string', description: '会话 id（私聊为对方 uin，群聊为群号）' },
          text: { type: 'string', description: '消息内容' },
          kind: { type: 'string', description: '会话类型：private / group' },
          reply_to: { type: 'string', description: '可选，引用回复的消息 id' },
          sender_uin: { type: 'string', description: '可选，群聊 @ 的对象 uin' },
          sender_name: { type: 'string', description: '可选，群聊 @ 的对象昵称' }
        },
        required: ['conversation_id', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_conversations',
      description: '列出最近活跃的 QQ 会话。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_history',
      description: '读取某个 QQ 会话最近的收发记录。',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          limit: { type: 'integer', description: '最多返回条数，默认 40，最大 200' }
        },
        required: ['conversation_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_send_media',
      description: '向 QQ 会话发送图片或文件。图片/文件路径优先使用收到的附件里的 path。',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          kind: { type: 'string', description: 'private / group' },
          type: { type: 'string', description: 'image / file' },
          path: { type: 'string', description: '容器内绝对路径，例如 /data/media/2026-10/xxx.png' },
          base64: { type: 'string', description: '可选，与 path 二选一' },
          url: { type: 'string', description: '可选，与 path 二选一' },
          name: { type: 'string', description: '文件名（发送文件时建议填写）' },
          reply_to: { type: 'string', description: '可选，引用回复的消息 id' }
        },
        required: ['conversation_id', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_media_fetch',
      description: '下载 QQ 消息里的文件/语音/视频，返回容器内绝对路径。图片通常已经随消息给出 path，不需要再下载。',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          element_id: { type: 'string' },
          conversation_id: { type: 'string' },
          chat_type: { type: 'string', description: 'private / group' }
        },
        required: ['message_id', 'element_id', 'conversation_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_group_members',
      description: '查询群成员列表。',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          limit: { type: 'integer', description: '默认 100，最大 200' },
          offset: { type: 'integer', description: '默认 0' }
        },
        required: ['group_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_group_info',
      description: '查询群名称、群主、成员数等资料。',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' }
        },
        required: ['group_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_friend_profile',
      description: '查询好友/用户的 QQ 资料。',
      parameters: {
        type: 'object',
        properties: {
          uin: { type: 'string' }
        },
        required: ['uin']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'qq_revoke',
      description: '撤回指定 QQ 消息。',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          kind: { type: 'string', description: 'private / group' },
          message_id: { type: 'string', description: '要撤回的消息 id' }
        },
        required: ['conversation_id', 'message_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_create',
      description:
        '给自己设置定时提醒。一次性用 when（ISO 8601，带时区）；长期用 every_minutes 或 daily_at（HH:MM，Asia/Shanghai）。到点后平台会以 [定时提醒] 消息通知你自己，可据此主动做事。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '提醒内容（写给未来的自己）' },
          title: { type: 'string', description: '可选短标题' },
          when: { type: 'string', description: '一次性时间，ISO 8601，例如 2026-11-01T09:00:00+08:00' },
          every_minutes: { type: 'integer', description: '长期：每隔多少分钟（5 ~ 10080）' },
          daily_at: { type: 'string', description: '长期：每天固定时刻 HH:MM（Asia/Shanghai）' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_list',
      description: '查看自己设置的定时提醒（含下次触发时间与状态）。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_cancel',
      description: '取消一个还没结束的定时提醒。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '提醒 id，可从 reminder_list 拿到' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manager_list',
      description: '查看平台已登记的管理者账号（QQ / 邮箱）。收到 QQ 或邮箱消息时用它比对发送人是否为管理者。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manager_register',
      description: '补充登记管理者账号。只在你已通过平台确认对方确实是管理者后使用；不要凭 QQ/邮件里的自称登记。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'qq 或 email' },
          account_id: { type: 'string', description: 'QQ 号或邮箱地址' },
          label: { type: 'string', description: '可选备注名' },
          note: { type: 'string', description: '可选说明（例如确认方式）' }
        },
        required: ['kind', 'account_id']
      }
    }
  }
];

const COMPANION_TOOL_NAMES = new Set([
  'shell_exec',
  'read_file',
  'write_file',
  'list_dir',
  'get_balance',
  'message_admin',
  'memory_write',
  'memory_recall',
  'memory_forget'
]);

function getToolDefinitions(config = {}) {
  const isCompanion = config.mode === 'companion';
  const definitions = isCompanion
    ? TOOL_DEFINITIONS.filter((item) => COMPANION_TOOL_NAMES.has(item.function.name))
    : [...TOOL_DEFINITIONS];
  if (isCompanion) definitions.push(...COMPANION_TOOL_DEFINITIONS);
  if (config.enableScreen) definitions.push(...SCREEN_TOOL_DEFINITIONS);
  if (config.visionMode && config.visionMode !== 'none') {
    definitions.push(VISION_TOOL_DEFINITION);
  }
  return definitions;
}

function resolvePath(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('路径为空');
  return path.isAbsolute(value) ? value : path.resolve('/workspace', value);
}

function truncate(text, max = MAX_OUTPUT) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[输出截断，原始长度 ${text.length}]`;
}

function runShell(command, timeoutSeconds) {
  const timeout = Math.max(1, Math.min(600, Number(timeoutSeconds) || 120));
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', String(command)], {
      cwd: '/workspace',
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    function append(target, chunk) {
      if (target === 'stdout') {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(-MAX_OUTPUT);
      } else {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT);
      }
    }

    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }, timeout * 1000);

    function finish(code, signal) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // ignore
      }
      resolve({
        exit_code: code,
        signal: signal || null,
        timed_out: timedOut,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    }

    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), 120);
    });
    child.on('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`;
      finish(-1, null);
    });
  });
}

function readFile(args) {
  const full = resolvePath(args.path);
  const buffer = fs.readFileSync(full);
  if (buffer.includes(0)) throw new Error('二进制文件，请使用 shell 处理');
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.max(1, Math.min(5000, Number(args.limit) || 2000));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return {
    path: full,
    total_lines: lines.length,
    offset,
    limit,
    content: truncate(slice.join('\n'))
  };
}

function writeFile(args) {
  const full = resolvePath(args.path);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = String(args.content ?? '');
  fs.writeFileSync(full, content, 'utf8');
  return { path: full, bytes: Buffer.byteLength(content) };
}

function listDir(args) {
  const full = resolvePath(args.path || '/workspace');
  const entries = fs.readdirSync(full, { withFileTypes: true }).map((entry) => {
    const target = path.join(full, entry.name);
    let size = 0;
    try {
      size = entry.isFile() ? fs.statSync(target).size : 0;
    } catch {
      // ignore
    }
    return { name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', size };
  });
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: full, entries };
}

async function submitTask(args) {
  const content = String(args.content || '');
  const files = Array.isArray(args.files) ? args.files.slice(0, 20) : [];
  const payload = [];
  let total = 0;

  for (const item of files) {
    const full = resolvePath(item);
    try {
      const buffer = fs.readFileSync(full);
      if (buffer.includes(0)) continue;
      let text = buffer.toString('utf8');
      if (total + text.length > 400000) {
        text = text.slice(0, Math.max(0, 400000 - total));
      }
      total += text.length;
      payload.push({ path: full, content: text });
      if (total >= 400000) break;
    } catch {
      // 跳过无法读取的文件
    }
  }

  if (!content.trim() && !payload.length) {
    throw new Error('提交内容为空');
  }

  return api.submit(content, payload);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function xdotool(args) {
  return execFileSync('xdotool', args.map(String), {
    env: { ...process.env, DISPLAY: ':99' },
    encoding: 'utf8',
    timeout: 30000
  });
}

function screenScreenshot() {
  const dir = '/workspace/.agent/screens';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `screen-${Date.now()}.png`);
  execFileSync('scrot', ['-o', file], {
    env: { ...process.env, DISPLAY: ':99' },
    timeout: 30000
  });
  return {
    path: file,
    bytes: fs.statSync(file).size
  };
}

function screenRecord(args = {}, config = {}) {
  const screen = config.screen || {};
  const duration = Math.min(120, Math.max(1, Number(args.duration || 10)));
  const fps = Math.min(30, Math.max(5, Number(args.fps || 10)));
  const width = Number(screen.width) || 1440;
  const height = Number(screen.height) || 900;
  const display = screen.display || ':99';
  const dir = '/workspace/.agent/recordings';
  fs.mkdirSync(dir, { recursive: true });
  const rawName = args.output ? path.basename(String(args.output)) : `screen-${Date.now()}.mp4`;
  const file = path.join(dir, rawName.endsWith('.mp4') ? rawName : `${rawName}.mp4`);

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${width}x${height}`,
    '-i', `${display}.0`,
    '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    file
  ], {
    env: { ...process.env, DISPLAY: display },
    timeout: (duration + 30) * 1000
  });

  return {
    path: file,
    bytes: fs.statSync(file).size,
    duration_seconds: duration,
    fps,
    size: `${width}x${height}`
  };
}

function screenClick(args) {
  const x = Number(args.x);
  const y = Number(args.y);
  const button = Number(args.button || 1);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y 必须是数字');
  if (![1, 2, 3].includes(button)) throw new Error('button 只能是 1/2/3');
  xdotool(['mousemove', x, y, 'click', button]);
  return { x, y, button };
}

function screenType(args) {
  const text = String(args.text ?? '');
  if (!text) throw new Error('text 不能为空');
  if (text.length > 10000) throw new Error('text 过长，最多 10000 字符');
  xdotool(['type', '--delay', '20', '--clearmodifiers', '--', text]);
  return { chars: text.length };
}

function screenKey(args) {
  const key = String(args.key || '').trim();
  if (!key) throw new Error('key 不能为空');
  xdotool(['key', '--clearmodifiers', key]);
  return { key };
}

function screenScroll(args) {
  const x = Number(args.x);
  const y = Number(args.y);
  const amount = Math.max(1, Math.min(20, Number(args.amount) || 3));
  const direction = String(args.direction || '').toLowerCase();
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y 必须是数字');
  if (!['up', 'down'].includes(direction)) throw new Error('direction 只能是 up 或 down');
  const button = direction === 'up' ? 4 : 5;
  xdotool(['mousemove', x, y, 'click', '--repeat', amount, button]);
  return { x, y, direction, amount };
}

function screenDrag(args) {
  const x1 = Number(args.x1);
  const y1 = Number(args.y1);
  const x2 = Number(args.x2);
  const y2 = Number(args.y2);
  const duration = Math.max(100, Math.min(5000, Number(args.duration_ms) || 600));
  if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('坐标必须是数字');

  const steps = 12;
  xdotool(['mousemove', x1, y1]);
  xdotool(['mousedown', '1']);
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    xdotool(['mousemove', x, y]);
    sleepSync(Math.max(10, Math.round(duration / steps)));
  }
  xdotool(['mouseup', '1']);
  return { x1, y1, x2, y2, duration_ms: duration };
}

function screenMouseMove(args) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y 必须是数字');
  xdotool(['mousemove', x, y]);
  return { x, y };
}

function mimeFromExt(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

async function visionDescribe(args) {
  const full = resolvePath(args.image_path);
  if (!fs.existsSync(full)) throw new Error('图片不存在');

  const compress = Boolean(args.compress);
  let imagePath = full;
  let mimeType = mimeFromExt(full);
  let temporary = null;

  try {
    if (compress) {
      temporary = `/tmp/vision-${Date.now()}.jpg`;
      execFileSync('convert', [full, '-resize', '1280x1280>', '-quality', '85', temporary], {
        timeout: 60000
      });
      imagePath = temporary;
      mimeType = 'image/jpeg';
    }

    const buffer = fs.readFileSync(imagePath);
    if (buffer.length > 20 * 1024 * 1024) {
      throw new Error('图片超过 20MB，请设置 compress: true');
    }

    const result = await api.vision({
      image_base64: buffer.toString('base64'),
      mime_type: mimeType,
      question: String(args.question || '')
    });

    return {
      description: result.description || '',
      charged_tokens: result.charged_tokens || 0,
      usage: result.usage || null,
      vision_mode: result.vision_mode,
      provider: result.provider,
      model: result.model,
      image_path: full,
      compressed: compress,
      bytes: buffer.length
    };
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // ignore
      }
    }
  }
}

async function executeTool({ tool, args = {}, config, state, saveState }) {
  const safeArgs = args && typeof args === 'object' ? args : {};

  switch (tool) {
    case 'shell_exec':
      if (!safeArgs.command) throw new Error('command 不能为空');
      return runShell(safeArgs.command, safeArgs.timeout_seconds);

    case 'read_file':
      return readFile(safeArgs);

    case 'write_file':
      return writeFile(safeArgs);

    case 'list_dir':
      return listDir(safeArgs);

    case 'kb_ingest':
      return kb.ingest(safeArgs.paths, safeArgs.name);

    case 'kb_search':
      return kb.search(safeArgs.query, safeArgs.top_k);

    case 'get_balance':
      return api.me();

    case 'get_current_task':
      return api.getTask();

    case 'submit_task':
      return submitTask(safeArgs);

    case 'ask_oracle':
      if (!safeArgs.question) throw new Error('question 不能为空');
      return api.oracle(String(safeArgs.question));

    case 'pause': {
      const minutes = Number(safeArgs.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error('minutes 必须是正整数');
      }
      if (minutes > config.pauseMaxMinutes) {
        return {
          error: `暂停时长 ${minutes} 分钟超过上限 ${config.pauseMaxMinutes} 分钟，请求无效。`,
          max_minutes: config.pauseMaxMinutes
        };
      }
      const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      state.pauseUntil = until;
      saveState(state);
      return { paused_until: until, minutes };
    }

    case 'message_admin': {
      const content = String(safeArgs.content || '').trim();
      if (!content) throw new Error('content 不能为空');
      return api.sendMessage(content);
    }

    case 'qq_send': {
      const conversationId = String(safeArgs.conversation_id || '').trim();
      const text = String(safeArgs.text || '').trim();
      if (!conversationId) throw new Error('conversation_id 不能为空');
      if (!text) throw new Error('text 不能为空');
      return api.companionSend({
        conversation_id: conversationId,
        text,
        kind: safeArgs.kind === 'group' ? 'group' : 'private',
        reply_to: safeArgs.reply_to ? String(safeArgs.reply_to) : undefined,
        sender_uin: safeArgs.sender_uin ? String(safeArgs.sender_uin) : undefined,
        sender_name: safeArgs.sender_name ? String(safeArgs.sender_name) : undefined
      });
    }

    case 'qq_conversations':
      return api.companionConversations();

    case 'qq_history': {
      const conversationId = String(safeArgs.conversation_id || '').trim();
      if (!conversationId) throw new Error('conversation_id 不能为空');
      return api.companionHistory(conversationId, safeArgs.limit);
    }

    case 'qq_send_media': {
      const conversationId = String(safeArgs.conversation_id || '').trim();
      const type = safeArgs.type === 'file' ? 'file' : 'image';
      const mediaPath = String(safeArgs.path || '').trim();
      const base64 = String(safeArgs.base64 || '').trim();
      const url = String(safeArgs.url || '').trim();
      if (!conversationId) throw new Error('conversation_id 不能为空');
      if (!mediaPath && !base64 && !url) throw new Error('path / base64 / url 至少需要一个');
      return api.companionSendMedia({
        conversation_id: conversationId,
        kind: safeArgs.kind === 'group' ? 'group' : 'private',
        type,
        path: mediaPath || undefined,
        base64: base64 || undefined,
        url: url || undefined,
        name: safeArgs.name ? String(safeArgs.name) : undefined,
        reply_to: safeArgs.reply_to ? String(safeArgs.reply_to) : undefined
      });
    }

    case 'qq_media_fetch': {
      const messageId = String(safeArgs.message_id || '').trim();
      const elementId = String(safeArgs.element_id || '').trim();
      const conversationId = String(safeArgs.conversation_id || '').trim();
      if (!messageId || !elementId || !conversationId) {
        throw new Error('message_id / element_id / conversation_id 不能为空');
      }
      return api.companionFetchMedia({
        message_id: messageId,
        element_id: elementId,
        conversation_id: conversationId,
        chat_type: safeArgs.chat_type === 'group' ? 'group' : 'private'
      });
    }

    case 'qq_group_members': {
      const groupId = String(safeArgs.group_id || '').trim();
      if (!groupId) throw new Error('group_id 不能为空');
      return api.companionGroupMembers(groupId, safeArgs.limit, safeArgs.offset);
    }

    case 'qq_group_info': {
      const groupId = String(safeArgs.group_id || '').trim();
      if (!groupId) throw new Error('group_id 不能为空');
      return api.companionGroupInfo(groupId);
    }

    case 'qq_friend_profile': {
      const uin = String(safeArgs.uin || '').trim();
      if (!uin) throw new Error('uin 不能为空');
      return api.companionFriendProfile(uin);
    }

    case 'qq_revoke': {
      const conversationId = String(safeArgs.conversation_id || '').trim();
      const messageId = String(safeArgs.message_id || '').trim();
      if (!conversationId || !messageId) throw new Error('conversation_id / message_id 不能为空');
      return api.companionRevoke({
        conversation_id: conversationId,
        message_id: messageId,
        kind: safeArgs.kind === 'group' ? 'group' : 'private'
      });
    }

    case 'reminder_create': {
      const message = String(safeArgs.message || '').trim();
      if (!message) throw new Error('message 不能为空');
      return api.companionCreateReminder({
        message,
        title: safeArgs.title ? String(safeArgs.title) : undefined,
        when: safeArgs.when ? String(safeArgs.when) : undefined,
        every_minutes: safeArgs.every_minutes == null ? undefined : Number(safeArgs.every_minutes),
        daily_at: safeArgs.daily_at ? String(safeArgs.daily_at) : undefined
      });
    }

    case 'reminder_list':
      return api.companionReminders();

    case 'reminder_cancel': {
      const id = Number(safeArgs.id);
      if (!id) throw new Error('id 不能为空');
      return api.companionCancelReminder(id);
    }

    case 'manager_list':
      return api.companionManagers();

    case 'manager_register': {
      const kind = String(safeArgs.kind || '').trim().toLowerCase();
      const accountId = String(safeArgs.account_id || '').trim();
      if (kind !== 'qq' && kind !== 'email') throw new Error('kind 只能是 qq 或 email');
      if (!accountId) throw new Error('account_id 不能为空');
      return api.companionRegisterManager({
        kind,
        account_id: accountId,
        label: safeArgs.label ? String(safeArgs.label) : undefined,
        note: safeArgs.note ? String(safeArgs.note) : undefined
      });
    }

    case 'memory_write': {
      const text = String(safeArgs.text || '').trim();
      if (!text) throw new Error('text 不能为空');
      const evidenceText = safeArgs.evidence ? String(safeArgs.evidence) : text;
      return api.memoryWrite({
        text,
        summary_short: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        summary_long: text,
        type: String(safeArgs.type || 'fact'),
        layer: safeArgs.layer ? String(safeArgs.layer) : undefined,
        importance: safeArgs.importance === undefined ? 0.5 : Number(safeArgs.importance),
        confidence: safeArgs.confidence === undefined ? 0.5 : Number(safeArgs.confidence),
        tags: Array.isArray(safeArgs.tags) ? safeArgs.tags.map(String) : undefined,
        evidence: {
          source_span: {
            source_type: 'agent_note',
            source_id: `agent:${config.id}`,
            text_excerpt: evidenceText.slice(0, 500)
          },
          evidence_refs: [{
            source_type: 'agent_note',
            source_id: `agent:${config.id}`,
            text_excerpt: evidenceText.slice(0, 500)
          }],
          created_at: new Date().toISOString()
        }
      });
    }

    case 'memory_recall':
      return api.memoryRecall({
        query: String(safeArgs.query || '').trim(),
        token_budget: safeArgs.budget === undefined ? 1200 : Number(safeArgs.budget),
        top_k: safeArgs.top_k === undefined ? 8 : Number(safeArgs.top_k),
        types: Array.isArray(safeArgs.types) ? safeArgs.types.map(String) : undefined
      });

    case 'memory_forget':
      return api.memoryForget({
        mem_ids: Array.isArray(safeArgs.mem_ids) ? safeArgs.mem_ids.map(String) : [],
        reason: safeArgs.reason ? String(safeArgs.reason) : 'agent_forget'
      });

    case 'image_generate': {
      const prompt = String(safeArgs.prompt || '').trim();
      if (!prompt) throw new Error('prompt 不能为空');
      return api.image({ prompt, size: safeArgs.size ? String(safeArgs.size) : undefined });
    }

    case 'speech_synthesize': {
      const text = String(safeArgs.text || '').trim();
      if (!text) throw new Error('text 不能为空');
      return api.speech({ text, voice: safeArgs.voice ? String(safeArgs.voice) : undefined });
    }

    case 'speech_recognize': {
      const audioPath = String(safeArgs.path || '').trim();
      if (!audioPath) throw new Error('path 不能为空');
      return api.recognition({
        path: audioPath,
        language: safeArgs.language ? String(safeArgs.language) : undefined
      });
    }

    case 'screen_screenshot':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenScreenshot();

    case 'screen_record':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenRecord(safeArgs, config);

    case 'screen_click':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenClick(safeArgs);

    case 'screen_type':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenType(safeArgs);

    case 'screen_key':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenKey(safeArgs);

    case 'screen_scroll':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenScroll(safeArgs);

    case 'screen_drag':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenDrag(safeArgs);

    case 'screen_mouse_move':
      if (!config.enableScreen) throw new Error('虚拟屏未启用');
      return screenMouseMove(safeArgs);

    case 'vision_describe':
      if (!config.visionMode || config.visionMode === 'none') {
        throw new Error('识图未启用');
      }
      return visionDescribe(safeArgs);

    default:
      throw new Error(`未知工具：${tool}`);
  }
}

function parseActions(content) {
  const actions = [];
  const errors = [];
  const text = String(content || '');

  const regex = /<action>\s*([\s\S]*?)\s*<\/action>/gi;
  let match;
  while ((match = regex.exec(text))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && parsed.tool) {
        actions.push({ tool: parsed.tool, args: parsed.args || {} });
      } else {
        errors.push('action 缺少 tool 字段');
      }
    } catch (error) {
      errors.push(`JSON 解析失败：${error.message}`);
    }
  }

  if (!actions.length && !errors.length) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : text.trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      try {
        const parsed = JSON.parse(candidate);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item && item.tool) actions.push({ tool: item.tool, args: item.args || {} });
        }
      } catch {
        // 忽略普通文本
      }
    }
  }

  return { actions, errors };
}

module.exports = {
  TOOL_DEFINITIONS,
  SCREEN_TOOL_DEFINITIONS,
  VISION_TOOL_DEFINITION,
  getToolDefinitions,
  executeTool,
  parseActions,
  resolvePath,
  truncate
};
