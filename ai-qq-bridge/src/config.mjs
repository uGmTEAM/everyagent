import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';

export const DEFAULT_CONFIG = {
  http: {
    host: '0.0.0.0',
    port: 3100,
    token: ''
  },
  qq: {
    account: '',
    password: '',
    autoLogin: true,
    switchOnKick: true,
    dataDir: '',
    appDir: '',
    quickLoginTimeoutMs: 20000,
    qrTimeoutSec: 180,
    deviceName: 'ai-qq-bridge'
  },
  accounts: [],
  storage: {
    dir: ''
  },
  media: {
    autoDownloadImages: true,
    imageTimeoutMs: 20000,
    maxDownloadBytes: 104857600,
    maxUploadBytes: 209715200
  },
  backfill: {
    enabled: true,
    maxPeers: 100,
    perPeer: 20
  },
  onebot: {
    enabled: false,
    host: '0.0.0.0',
    port: 3000,
    token: '',
    webhook: '',
    websocket: {
      enabled: true,
      port: 3001
    },
    reverseWebsocket: ''
  },
  log: {
    level: 'info',
    buffer: 500
  },
  features: {
    experimentalSocial: false
  }
};

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge (base, extra) {
  if (!isPlainObject(extra)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = merge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function envBool (name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off', ''].includes(value.toLowerCase());
}

export function loadConfig () {
  const dataDir = process.env.BRIDGE_DATA_DIR || '/data';
  fs.mkdirSync(dataDir, { recursive: true });

  const configPath = process.env.BRIDGE_CONFIG || path.join(dataDir, 'config.json');
  const fileConfig = readJson(configPath, {});
  const config = merge(DEFAULT_CONFIG, fileConfig);

  if (process.env.BRIDGE_HTTP_HOST) config.http.host = process.env.BRIDGE_HTTP_HOST;
  if (process.env.BRIDGE_HTTP_PORT) config.http.port = Number(process.env.BRIDGE_HTTP_PORT);
  if (process.env.BRIDGE_HTTP_TOKEN !== undefined) config.http.token = process.env.BRIDGE_HTTP_TOKEN;
  if (process.env.BRIDGE_ACCOUNT) config.qq.account = process.env.BRIDGE_ACCOUNT;
  if (process.env.BRIDGE_QQ_PASSWORD) config.qq.password = process.env.BRIDGE_QQ_PASSWORD;
  if (process.env.BRIDGE_QQ_APP_DIR) config.qq.appDir = process.env.BRIDGE_QQ_APP_DIR;
  if (process.env.BRIDGE_QQ_DATA_DIR) config.qq.dataDir = process.env.BRIDGE_QQ_DATA_DIR;
  if (process.env.BRIDGE_ONEBOT_ENABLED !== undefined) config.onebot.enabled = envBool('BRIDGE_ONEBOT_ENABLED', false);
  if (process.env.BRIDGE_LOG_LEVEL) config.log.level = process.env.BRIDGE_LOG_LEVEL;
  if (process.env.BRIDGE_EXPERIMENTAL_SOCIAL !== undefined) {
    config.features.experimentalSocial = envBool('BRIDGE_EXPERIMENTAL_SOCIAL', false);
  }

  config.storage.dir = config.storage.dir || path.join(dataDir, 'messages');
  config.qq.dataDir = config.qq.dataDir || path.join(dataDir, 'qq');
  config._dataDir = dataDir;
  config._configPath = configPath;

  fs.mkdirSync(config.storage.dir, { recursive: true });
  fs.mkdirSync(config.qq.dataDir, { recursive: true });

  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.accounts = config.accounts
    .map(item => ({
      uin: String(item?.uin || '').trim(),
      dataDir: String(item?.dataDir || '').trim(),
      password: String(item?.password || config.qq.password || ''),
      note: String(item?.note || '')
    }))
    .filter(item => /^\d+$/.test(item.uin));

  return config;
}
