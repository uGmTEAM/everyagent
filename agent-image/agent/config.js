const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.AGENT_CONFIG || '/workspace/.agent/config.json';
const BASE_DIR = path.dirname(CONFIG_PATH);
const STATE_PATH = path.join(BASE_DIR, 'state.json');
const PROMPT_PATH = path.join(BASE_DIR, 'system_prompt.md');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch {
    return '你是一个在隔离沙盒中自主运行的研究型 AI。';
  }
}

function defaultState() {
  return {
    messages: [],
    summary: '',
    pauseUntil: null,
    toolMode: 'auto',
    taskId: null,
    createdAt: new Date().toISOString()
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      ...defaultState(),
      ...parsed,
      messages: Array.isArray(parsed.messages) ? parsed.messages : []
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  PROMPT_PATH,
  BASE_DIR,
  loadConfig,
  loadPrompt,
  loadState,
  saveState
};
