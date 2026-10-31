#!/usr/bin/env node
/**
 * 零依赖自检：不连接 QQ，只验证存储、解析、HTTP 接口与事件队列。
 * 产物输出到 test-output/<时间戳>/。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MessageQueue } from '../src/store/queue.mjs';
import { MediaStore } from '../src/store/media.mjs';
import { imageSize } from '../src/image-size.mjs';
import { parseRawMessage } from '../src/qq/msg-parse.mjs';
import { EventBus } from '../src/qq/event-bus.mjs';
import { LoginManager } from '../src/qq/login.mjs';
import { QQApi } from '../src/qq/api.mjs';
import { startHttpServer } from '../src/http/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(path.resolve(here, '..'), 'test-output', stamp);
fs.mkdirSync(outDir, { recursive: true });

const results = [];
function check (name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message || String(error) });
    console.error(`FAIL ${name} - ${error.message || error}`);
  }
}

async function checkAsync (name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message || String(error) });
    console.error(`FAIL ${name} - ${error.message || error}`);
  }
}

function httpGetJson (port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  tail: () => []
};

const dataDir = path.join(outDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const queue = new MessageQueue({ dir: path.join(dataDir, 'messages'), logger });

await checkAsync('queue 初始化', async () => {
  await queue.init();
  return 'ok';
});

check('queue 追加与去重', () => {
  queue.append({ id: 'm1', time: 1700000000, chat_type: 'group', segments: [{ type: 'text', text: 'a' }] });
  queue.append({ id: 'm2', time: 1700000001, chat_type: 'private', segments: [] });
  if (!queue.hasSeen('m1')) throw new Error('去重集合未记录 m1');
  if (queue.pendingCount() !== 2) throw new Error('pending 应为 2');
  return '2 条';
});

await checkAsync('queue 拉取出队', async () => {
  const batch = await queue.pull(1);
  if (batch.length !== 1 || batch[0].id !== 'm1') throw new Error('出队顺序错误');
  if (queue.cursor() !== '1') throw new Error('游标未推进');
  return `cursor=${queue.cursor()}`;
});

await checkAsync('queue 重启后未读保留', async () => {
  const queue2 = new MessageQueue({ dir: path.join(dataDir, 'messages'), logger });
  await queue2.init();
  const batch = await queue2.pull(10);
  if (batch.length !== 1 || batch[0].id !== 'm2') throw new Error(`重启后应剩 1 条，实际 ${batch.length}`);
  return '恢复成功';
});

check('media 存储与路径校验', () => {
  const store = new MediaStore({ dir: path.join(dataDir, 'media'), logger });
  const saved = store.saveBuffer(Buffer.from('hello'), '.txt');
  if (!fs.existsSync(saved.path)) throw new Error('文件未落盘');
  let blocked = false;
  try { store.resolve('../../etc/passwd'); } catch { blocked = true; }
  if (!blocked) throw new Error('路径穿越未被拦截');
  return saved.rel;
});

check('图片尺寸解析 PNG', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const file = path.join(dataDir, '1x1.png');
  fs.writeFileSync(file, png);
  const size = imageSize(file);
  if (size.width !== 1 || size.height !== 1) throw new Error(`尺寸错误 ${JSON.stringify(size)}`);
  return '1x1';
});

await checkAsync('消息解析（文本/at/图片）', async () => {
  const ctx = {
    selfInfo: { uin: '10000' },
    config: { media: { autoDownloadImages: false, maxDownloadBytes: 0 }, _dataDir: dataDir },
    logger
  };
  const raw = {
    msgId: '9001',
    msgTime: '1700000002',
    msgSeq: '12',
    chatType: 2,
    peerUid: '123456',
    peerUin: '123456',
    peerName: '测试群',
    senderUin: '20000',
    senderUid: 'u_abc',
    sendNickName: '测试用户',
    elements: [
      { elementType: 1, elementId: 'e1', textElement: { content: 'hi', atType: 0 } },
      { elementType: 1, elementId: 'e2', textElement: { content: '@小明', atType: 2, atUid: '20001' } },
      { elementType: 2, elementId: 'e3', picElement: { fileName: 'a.png', fileSize: 12, picWidth: 10, picHeight: 10 } }
    ]
  };
  const msg = await parseRawMessage(raw, ctx, { downloadImages: false });
  if (msg.chat_type !== 'group') throw new Error('chat_type 错误');
  if (msg.segments.length !== 3) throw new Error('段数量错误');
  if (msg.segments[1].type !== 'at') throw new Error('at 未识别');
  return JSON.stringify(msg.segments.map(item => item.type));
});

await checkAsync('HTTP /health 与拉取接口', async () => {
  const app = {
    config: { http: { host: '127.0.0.1', port: 0, token: '' }, log: { buffer: 100 }, media: { maxUploadBytes: 1024 }, onebot: { enabled: false } },
    logger,
    queue,
    media: new MediaStore({ dir: path.join(dataDir, 'media2'), logger }),
    login: { publicState: () => ({ phase: 'online', online: true, uin: '10000' }) },
    info: { version: 'test', supported: true, appid: '1', qua: 'q' },
    capabilities: {},
    activeAccount: null,
    startedAt: Date.now()
  };
  const server = startHttpServer(app);
  await new Promise(resolve => setTimeout(resolve, 300));
  const port = server.address().port;
  const health = await httpGetJson(port, '/health');
  if (!health.ok) throw new Error('health 返回异常');
  const pull = await httpGetJson(port, '/v1/messages?limit=5');
  if (!Array.isArray(pull.messages)) throw new Error('拉取接口返回异常');
  await new Promise(resolve => server.close(resolve));
  return `port=${port}`;
});

await checkAsync('内核调用与发送封装', async () => {
  let listener = null;
  const session = {
    getMsgService: () => ({
      addKernelMsgListener: proxy => { listener = proxy; },
      generateMsgUniqueId: () => 'g1',
      getMsgsByMsgId: async (_peer, ids) => ({
        msgList: [{ msgId: ids[0], msgSeq: '9', senderUin: '20001', clientSeq: '1' }]
      }),
      recallMsg: async () => ({ result: 0 }),
      sendMsg: async (_id, peer) => {
        setTimeout(() => listener.onMsgInfoListUpdate([{
          guildId: peer.guildId,
          msgId: 'm-sent',
          msgSeq: '77',
          msgTime: '1700000100',
          sendStatus: 2
        }]), 10);
        return { result: 0 };
      },
      forwardMsg: async () => ({ result: 0 })
    }),
    getMSFService: () => ({ getServerTime: () => 1700000000 }),
    getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map([['20001', 'u_20001']]) }) }),
    getGroupService: () => ({
      getAllMemberList: async () => ({
        result: { infos: [{ uin: '20001', uid: 'u_20001', nick: '成员A', cardName: 'A', role: 2, joinTime: '1' }] }
      }),
      reqToJoinGroup: async () => ({ result: 0 })
    }),
    getProfileService: () => ({
      getCoreAndBaseInfo: async () => new Map([['u_20001', { uin: '20001', uid: 'u_20001', nick: '成员A' }]])
    }),
    getAddBuddyService: () => ({ addBuddy: async () => ({ result: 0 }) })
  };
  const ctx = {
    session,
    bus: new EventBus({ session, logger }),
    config: { _dataDir: dataDir, media: {}, features: { experimentalSocial: true } },
    media: new MediaStore({ dir: path.join(dataDir, 'media3'), logger }),
    selfInfo: { uin: '10000' },
    logger
  };
  const api = new QQApi(ctx);
  const sent = await api.send({ type: 'group', id: '123456' }, [{ type: 'text', text: 'hi' }]);
  if (sent.message_id !== 'm-sent') throw new Error('发送结果未匹配回调');
  const forward = await api.send({ type: 'group', id: '123456' }, [{ type: 'forward', message_ids: ['1', '2'] }]);
  if (forward.forwarded !== 2) throw new Error('合并转发参数错误');
  const members = await api.getGroupMembers('123456');
  if (members.members.length !== 1 || members.members[0].role !== 'member') throw new Error('群成员归一化错误');
  const profile = await api.getFriendProfile('20001');
  if (profile.friend.uin !== '20001' || profile.friend.name !== '成员A') throw new Error('资料归一化错误');
  await api.revoke({ type: 'group', id: '123456' }, 'm-sent');
  const caps = api.socialCapabilities();
  if (!caps.add_friend || !caps.join_group) throw new Error('社交能力探测错误');
  await api.addFriend({ uin: '20001', message: 'hi' });
  await api.joinGroup({ group_id: '123456' });
  return `message_id=${sent.message_id}`;
});

await checkAsync('登录管理：快速登录回退', async () => {
  let listener = null;
  const service = {
    addKernelLoginListener: value => { listener = value; },
    connect: () => setTimeout(() => listener.onLoginConnected(), 10),
    getMsfStatus: () => 0,
    getLoginList: async () => ({ LocalLoginInfoList: [{ uin: 10001, uid: 'u_10001', nickName: 'A', isQuickLogin: true }] }),
    quickLoginWithUin: async () => ({ result: '0' })
  };
  const config = {
    _dataDir: path.join(dataDir, 'login1'),
    qq: { account: '10001', quickLoginTimeoutMs: 1000, qrTimeoutSec: 60 }
  };
  fs.mkdirSync(config._dataDir, { recursive: true });
  const manager = new LoginManager({ loginService: service, logger, config });
  const online = manager.waitForOnline(8000);
  await manager.start({ account: '10001' });
  await online;
  if (!manager.publicState().online) throw new Error('快速登录未进入 online');
  manager.stop();
  return manager.publicState().uin;
});

await checkAsync('登录管理：扫码与二维码清理', async () => {
  let listener = null;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const service = {
    addKernelLoginListener: value => { listener = value; },
    connect: () => setTimeout(() => listener.onLoginConnected(), 10),
    getMsfStatus: () => 0,
    getLoginList: async () => ({ LocalLoginInfoList: [] }),
    getQRCodePicture: () => {
      setTimeout(() => listener.onQRCodeGetPicture({ pngBase64QrcodeData: `data:image/png;base64,${png}`, qrcodeUrl: 'https://qrcode' }), 10);
      return true;
    }
  };
  const config = {
    _dataDir: path.join(dataDir, 'login2'),
    qq: { account: '', quickLoginTimeoutMs: 1000, qrTimeoutSec: 60 }
  };
  fs.mkdirSync(config._dataDir, { recursive: true });
  const manager = new LoginManager({ loginService: service, logger, config });
  const waiting = manager.waitForOnline(5000);
  manager.start({ account: '' });
  await new Promise(resolve => setTimeout(resolve, 200));
  if (!manager.publicState().qr_base64) throw new Error('二维码未生成');
  if (!fs.existsSync(path.join(config._dataDir, 'qrcode.png'))) throw new Error('二维码文件未落盘');
  listener.onQRCodeLoginSucceed({ uin: '10002', uid: 'u_10002' });
  await waiting;
  if (!manager.publicState().online) throw new Error('扫码登录未进入 online');
  if (fs.existsSync(path.join(config._dataDir, 'qrcode.png'))) throw new Error('登录后二维码未清理');
  manager.stop();
  return 'qr ok';
});

await checkAsync('QQ 入口注入与还原', async () => {
  const run = promisify(execFile);
  const appDir = path.join(dataDir, 'fakeqq', 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const pkgPath = path.join(appDir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ name: 'qq-chat', version: '3.2.34', main: './app_launcher/index.js' }, null, 2));
  fs.writeFileSync(path.join(appDir, 'wrapper.node'), '');
  const script = path.join(here, 'patch-qq.mjs');

  await run(process.execPath, [script, '--app-dir', appDir], { env: { ...process.env, BRIDGE_HOME: path.resolve(here, '..') } });
  const patched = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (patched.main !== './bridge-loader.cjs') throw new Error('main 未被替换');
  if (!fs.existsSync(path.join(appDir, 'bridge-loader.cjs'))) throw new Error('loader 未复制');
  if (!fs.existsSync(path.join(appDir, '.bridge-original.json'))) throw new Error('未记录原始入口');

  await run(process.execPath, [script, '--app-dir', appDir, '--restore'], { env: { ...process.env, BRIDGE_HOME: path.resolve(here, '..') } });
  const restored = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (restored.main !== './app_launcher/index.js') throw new Error('入口未还原');
  return 'patch/restore ok';
});

const summary = {
  time: new Date().toISOString(),
  total: results.length,
  passed: results.filter(item => item.ok).length,
  failed: results.filter(item => !item.ok).length,
  results
};
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过，结果目录：${outDir}`);
process.exitCode = summary.failed === 0 ? 0 : 1;
