const http = require('http');

const PORT = Number(process.env.PORT || 7850);

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function tasks() {
  const stamp = Date.now();
  return [
    {
      title: `Mock 研究任务 A-${stamp}`,
      description: '阅读工作区文件，整理一份 300 字摘要。',
      acceptance: '摘要写入 /workspace/mock-a.md，包含至少 3 个要点。'
    },
    {
      title: `Mock 研究任务 B-${stamp}`,
      description: '用 Python 生成 20 个随机数并统计均值。',
      acceptance: '脚本与运行结果保存在 /workspace/mock-b/。'
    },
    {
      title: `Mock 研究任务 C-${stamp}`,
      description: '检查临时工作区中的文件，记录目录结构。',
      acceptance: '输出目录树到 /workspace/mock-c.txt。'
    },
    {
      title: `Mock 研究任务 D-${stamp}`,
      description: '设计一个小实验并说明可复现步骤。',
      acceptance: '实验设计文档包含假设、步骤和验证指标。'
    },
    {
      title: `Mock 研究任务 E-${stamp}`,
      description: '总结当前工作并列出下一步计划。',
      acceptance: '总结写入 /workspace/mock-e.md。'
    }
  ];
}

const server = http.createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions') || req.method !== 'POST') {
    send(res, 404, { error: { message: 'not found' } });
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      send(res, 400, { error: { message: 'invalid json' } });
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content || ''))
      .join('\n');
    const user = messages
      .filter((m) => m.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n');

    if (user.includes('MOCK_ERROR')) {
      send(res, 500, { error: { message: 'mock upstream error' } });
      return;
    }

    let content = 'Mock model response.';
    const isAgentChat =
      !system.includes('任务生成器') &&
      !system.includes('独立的后端 Oracle AI') &&
      !system.includes('上下文压缩器') &&
      !system.includes('你是这个 AI 研究平台的 Judge');

    if (isAgentChat && user.includes('MOCK_PAUSE')) {
      content = '<action>{"tool":"pause","args":{"minutes":1}}</action>';
    } else if (isAgentChat && user.includes('MOCK_TOOL')) {
      content = '<action>{"tool":"get_balance","args":{}}</action>';
    } else if (isAgentChat && user.includes('MOCK_SUBMIT')) {
      content = '<action>{"tool":"submit_task","args":{"content":"MOCK_PASS 自动提交"}}</action>';
    } else if (system.includes('任务生成器')) {
      content = JSON.stringify(tasks());
    } else if (system.includes('独立的后端 Oracle AI')) {
      content = 'Mock Oracle：建议先明确验收标准，再拆分为可验证的小步骤。';
    } else if (system.includes('上下文压缩器')) {
      content = 'Mock 摘要：此前已完成部分探索，关键文件在 /workspace，当前任务保持进行中。';
    } else if (system.includes('你是这个 AI 研究平台的 Judge')) {
      const current = user.split('## 本次提交')[1]?.split('## 该 AI 对同一任务的历史提交')[0] || user;
      if (current.includes('MOCK_FAIL')) {
        content = JSON.stringify({
          passed: false,
          feedback: 'Mock 判定：缺少可验证结果，请补充实验与文件。',
          deduction: 2000000,
          reward: 0
        });
      } else {
        content = JSON.stringify({
          passed: true,
          feedback: 'Mock 判定：通过。',
          deduction: 0,
          reward: 1000
        });
      }
    }

    const usage = {
      prompt_tokens: 120,
      completion_tokens: 60,
      total_tokens: 180,
      completion_tokens_details: { reasoning_tokens: 20 }
    };

    console.log(`[mock] model=${body.model} tools=${body.tools ? 'yes' : 'no'}`);
    send(res, 200, {
      id: `mock-${Date.now()}`,
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop'
        }
      ],
      usage
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}`);
});
