const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

const config = {
  root: ROOT,
  dataDir: DATA,
  dbPath: path.join(DATA, 'platform.db'),
  workspacesDir: path.join(DATA, 'workspaces'),
  tmpWorkspaceDir: path.join(DATA, 'tmp_workspace'),
  publicCorpusDir: path.join(DATA, 'tmp_workspace', 'public_corpus'),
  deathDir: path.join(DATA, 'death_agents'),
  logsDir: path.join(DATA, 'logs'),
  uploadsDir: path.join(DATA, 'uploads'),
  // 预设工具集：每个子目录是一个 GitHub release（解压后），创建 AI 时可勾选挂载
  toolkitsDir: path.join(DATA, 'toolkits'),

  backendPort: Number(process.env.EA_PORT || 7842),
  panelPort: Number(process.env.EA_PANEL_PORT || 7843),
  backendBind: process.env.EA_BIND || '0.0.0.0',
  panelBind: process.env.EA_PANEL_BIND || '0.0.0.0',

  agentImage: process.env.EA_AGENT_IMAGE || 'ea-agent:latest',
  // 陪伴模式镜像：ea-agent + QQ NT + ai-qq-bridge，桥与 AI 同容器（Xvfb :99 → QQ → 桥 :3100）
  companionImage: process.env.EA_COMPANION_IMAGE || 'ea-companion:latest',
  // 面板把陪伴容器的 3100 映射到宿主机 127.0.0.1:<bridgeBasePort + seq>
  bridgeBasePort: Number(process.env.EA_BRIDGE_BASE_PORT || 7910),
  companionPollIntervalMs: Number(process.env.EA_COMPANION_POLL_MS || 1500),
  companionPollWaitSec: Number(process.env.EA_COMPANION_WAIT_SEC || 5),
  // 两次自动重启 QQ 之间的最短间隔：QQ 与通讯桥刚拉起时需要时间监听端口，
  // 没有冷却会变成“桥还没起来就被判无响应→再杀掉”的死循环。
  companionRestartCooldownMs: Number(process.env.EA_COMPANION_RESTART_COOLDOWN_MS || 60000),
  companionMaxGroupReplyChars: Number(process.env.EA_COMPANION_GROUP_MAX || 600),
  // 命中词触发节流：同一群 N 分钟内最多触发一次；0 表示不限制
  companionKeywordCooldownMin: Number(process.env.EA_COMPANION_KEYWORD_COOLDOWN_MIN || 0),
  egressImage: process.env.EA_EGRESS_IMAGE || 'ea-egress:latest',
  egressContainer: 'ea-egress',
  controlNetwork: 'ea-control',
  outboundNetworkPrefix: 'ea-out',
  dockerSocket:
    process.env.DOCKER_SOCKET ||
    (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),

  timezone: 'Asia/Shanghai',

  defaultInitialBalance: 10_000_000,
  warningRatios: [0.10, 0.05, 0.01],
  judgeDeductionMin: 1_000_000,
  judgeDeductionMax: 5_000_000,
  judgeRewardMax: 30_000_000,
  dyingGraceMs: 10 * 60 * 1000,
  pauseMaxMinutes: 30,
  crashMaxRetries: 3,
  // 陪伴 AI 默认崩溃重启上限（创建后不可改）
  companionCrashMaxRetries: 5,
  crashStableMs: 60 * 1000,
  taskBatchSize: 5,
  taskRefillThreshold: 5,

  contextCompressionThreshold: 60000,
  contextKeepRecent: 8,
  maxOutputTokens: 8192,
  requestTimeoutMs: 300000,

  diskWarnPct: 0.80,
  diskFreeWarnPct: 0.05,
  diskPausePct: 0.95,
  agentDiskLimitBytes: 60 * 1024 * 1024 * 1024,
  sharedDiskLimitBytes: 100 * 1024 * 1024 * 1024,

  agentCpuCores: 2,
  agentMemoryBytes: 4 * 1024 * 1024 * 1024,
  agentScreenMemoryBytes: 6 * 1024 * 1024 * 1024,
  agentPidsLimit: 4096,
  noVncBasePort: 7900,
  screenWidth: 1440,
  screenHeight: 900,

  oracleCostMultiplier: 10,
  judgePendingTimeoutMs: 10 * 60 * 1000,

  recoveryCompensation: 2_000_000,
  adminMessageCompensation: 50_000,
  recoveryHeartbeatGapMs: 30 * 1000,
  recoveryDockerWaitMs: Number(process.env.RECOVERY_DOCKER_WAIT_MS || 5 * 60 * 1000),
  recoveryRetryIntervalMs: Number(process.env.RECOVERY_RETRY_INTERVAL_MS || 20 * 1000),

  defaultProvider: {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    models: ['deepseek-reasoner', 'deepseek-chat']
  }
};

module.exports = config;
