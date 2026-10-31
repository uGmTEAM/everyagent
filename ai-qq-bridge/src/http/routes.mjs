import fs from 'node:fs';
import path from 'node:path';
import {
  clampInt,
  contentTypeFor,
  httpGetBuffer,
  isPrivateAddress,
  nowSec,
  readJsonBody,
  sendJson,
  sendText
} from '../util.mjs';

function fail (res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function capabilitySnapshot (app) {
  const base = app.capabilities || {};
  const hasApi = !!app.api;
  return {
    ...base,
    media: hasApi,
    members: hasApi && typeof app.api.getGroupMembers === 'function',
    profile: hasApi && typeof app.api.getFriendProfile === 'function',
    revoke: hasApi && typeof app.api.revoke === 'function',
    channel: false,
    poke: false,
    announcements: false,
    social: app.api?.socialCapabilities?.() || { add_friend: false, join_group: false, experimental: false }
  };
}

function authorized (app, req, url) {
  const token = app.config.http?.token || '';
  if (!token) return true;
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ') && header.slice(7) === token) return true;
  if (url.searchParams.get('access_token') === token) return true;
  if (header.startsWith('Basic ')) {
    try {
      const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
      if (raw.endsWith(`:${token}`)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function parseTargetFromQuery (url) {
  const type = url.searchParams.get('type') || url.searchParams.get('chat_type') || '';
  const id = url.searchParams.get('id') || url.searchParams.get('group_id') || url.searchParams.get('user_id') || '';
  return { type, id };
}

export async function handleRequest (app, req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end();
    return;
  }

  if (pathname === '/health' || pathname === '/v1/health') {
    sendJson(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - app.startedAt) / 1000),
      qq: {
        phase: app.login?.publicState().phase || 'starting',
        online: !!app.login?.publicState().online,
        uin: app.login?.publicState().uin || '',
        version: app.info?.version || '',
        supported: app.info?.supported ?? null,
        appid: app.info?.appid || '',
        qua: app.info?.qua || '',
        hint: app.info?.hint || ''
      },
      queue: {
        pending: app.queue?.pendingCount() ?? 0,
        cursor: app.queue?.cursor() ?? '0',
        last_receive_at: app.queue?.getLastReceiveAt() ?? 0
      },
      capabilities: capabilitySnapshot(app),
      fatal: app.fatal || '',
      onebot: {
        enabled: !!app.config.onebot?.enabled,
        running: !!app.onebot?.running
      }
    });
    return;
  }

  if (pathname === '/v1/status') {
    sendJson(res, 200, {
      ok: true,
      started_at: app.startedAt,
      account: app.activeAccount || null,
      login: app.login?.publicState() || null,
      qq: {
        version: app.info?.version || '',
        supported: app.info?.supported ?? null,
        appid: app.info?.appid || '',
        qua: app.info?.qua || '',
        app_dir: app.info?.appDir || ''
      },
      queue: {
        pending: app.queue?.pendingCount() ?? 0,
        cursor: app.queue?.cursor() ?? '0',
        last_receive_at: app.queue?.getLastReceiveAt() ?? 0
      },
      capabilities: capabilitySnapshot(app),
      onebot: {
        enabled: !!app.config.onebot?.enabled,
        running: !!app.onebot?.running
      }
    });
    return;
  }

  if (!authorized(app, req, url)) {
    fail(res, 401, 'unauthorized', '缺少或错误的访问令牌');
    return;
  }

  if (pathname === '/v1/login/qrcode' && req.method === 'GET') {
    const state = app.login?.publicState();
    if (!state?.online && !state?.qr_base64) {
      app.login?.requestQR();
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    const latest = app.login?.publicState();
    sendJson(res, 200, {
      phase: latest?.phase || 'starting',
      online: !!latest?.online,
      uin: latest?.uin || '',
      qr_url: latest?.qr_url || '',
      qr_base64: latest?.qr_base64 || '',
      qr_updated_at: latest?.qr_updated_at || 0,
      error: latest?.error || ''
    });
    return;
  }

  if (pathname === '/v1/login/refresh' && req.method === 'POST') {
    app.login?.requestQR();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/v1/login/quick' && req.method === 'POST') {
    const body = await readJsonBody(req, 1024 * 1024);
    const uin = String(body.uin || app.config.qq.account || '');
    if (!uin) {
      fail(res, 400, 'bad_request', '缺少 uin');
      return;
    }
    const ok = await app.login.quickLogin(uin);
    sendJson(res, 200, { ok, state: app.login.publicState() });
    return;
  }

  if (pathname === '/v1/accounts' && req.method === 'GET') {
    sendJson(res, 200, {
      active: app.activeAccount || null,
      accounts: (app.config.accounts || []).map((item, index) => ({
        index,
        uin: item.uin,
        note: item.note,
        active: index === app.activeAccount?.index
      })),
      switch_on_kick: !!app.config.qq.switchOnKick
    });
    return;
  }

  if (pathname === '/v1/accounts/switch' && req.method === 'POST') {
    if (!app.requestAccountSwitch) {
      fail(res, 503, 'not_ready', '账号切换未就绪');
      return;
    }
    const body = await readJsonBody(req, 1024 * 1024);
    if (!app.requestAccountSwitch(body.index, body.uin)) {
      fail(res, 400, 'switch_unavailable', '没有可切换的备用账号');
      return;
    }
    sendJson(res, 202, { ok: true, message: '正在切换账号，服务会短暂重启' });
    return;
  }

  if (pathname === '/v1/messages' && req.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20);
    const wait = clampInt(url.searchParams.get('wait'), 0, 30, 0);
    const provided = url.searchParams.get('cursor');
    if (wait > 0 && app.queue) await app.queue.waitForMessage(wait * 1000);
    const messages = app.queue ? await app.queue.pull(limit) : [];
    sendJson(res, 200, {
      messages,
      next_cursor: app.queue?.cursor() || '0',
      pending: app.queue?.pendingCount() || 0,
      cursor_matched: provided === null ? null : String(provided) === String(app.queue?.cursor() || '0')
    });
    return;
  }

  if (pathname === '/v1/messages' && req.method === 'POST') {
    if (!app.api || !app.session || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成，暂时无法发送');
      return;
    }
    const body = await readJsonBody(req, app.config.media.maxUploadBytes || 209715200);
    const target = body.target || {};
    let segments = Array.isArray(body.segments) ? body.segments : [];
    if (segments.length === 0 && typeof body.text === 'string') {
      segments = [{ type: 'text', text: body.text }];
    }
    if (!target.type || !target.id) {
      fail(res, 400, 'bad_request', '缺少 target.type / target.id');
      return;
    }
    if (segments.length === 0) {
      fail(res, 400, 'bad_request', '缺少消息内容');
      return;
    }
    try {
      const result = await app.api.send(target, segments);
      sendJson(res, 200, result);
    } catch (error) {
      fail(res, 400, 'send_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/messages/history' && req.method === 'GET') {
    if (!app.api || !app.session || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    const target = parseTargetFromQuery(url);
    if (!target.type || !target.id) {
      fail(res, 400, 'bad_request', '缺少 type / id');
      return;
    }
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20);
    try {
      sendJson(res, 200, { messages: await app.api.history(target, limit) });
    } catch (error) {
      fail(res, 400, 'history_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/groups' && req.method === 'GET') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    try {
      sendJson(res, 200, { groups: await app.api.getGroups() });
    } catch (error) {
      fail(res, 500, 'groups_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/friends' && req.method === 'GET') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    try {
      sendJson(res, 200, { friends: await app.api.getFriends() });
    } catch (error) {
      fail(res, 500, 'friends_failed', error.message || String(error));
    }
    return;
  }

  const membersMatch = pathname.match(/^\/v1\/groups\/([^/]+)\/members$/);
  if (membersMatch && req.method === 'GET') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    try {
      const groupId = decodeURIComponent(membersMatch[1]);
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);
      const offset = clampInt(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);
      sendJson(res, 200, { ok: true, ...(await app.api.getGroupMembers(groupId, limit, offset)) });
    } catch (error) {
      fail(res, 400, 'members_failed', error.message || String(error));
    }
    return;
  }

  const groupInfoMatch = pathname.match(/^\/v1\/groups\/([^/]+)\/info$/);
  if (groupInfoMatch && req.method === 'GET') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    try {
      const groupId = decodeURIComponent(groupInfoMatch[1]);
      sendJson(res, 200, { ok: true, ...(await app.api.getGroupInfo(groupId)) });
    } catch (error) {
      fail(res, 400, 'group_info_failed', error.message || String(error));
    }
    return;
  }

  const friendProfileMatch = pathname.match(/^\/v1\/friends\/([^/]+)\/profile$/);
  if (friendProfileMatch && req.method === 'GET') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    try {
      const uin = decodeURIComponent(friendProfileMatch[1]);
      sendJson(res, 200, { ok: true, ...(await app.api.getFriendProfile(uin)) });
    } catch (error) {
      fail(res, 400, 'friend_profile_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/self/profile' && req.method === 'GET') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await app.api.getSelfProfile()) });
    } catch (error) {
      fail(res, 400, 'self_profile_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/messages/revoke' && req.method === 'POST') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    const body = await readJsonBody(req, 1024 * 1024);
    if (!body.conversation_id || !body.message_id) {
      fail(res, 400, 'bad_request', '缺少 conversation_id / message_id');
      return;
    }
    try {
      const result = await app.api.revoke(
        { type: body.chat_type === 'group' ? 'group' : 'private', id: body.conversation_id },
        body.message_id
      );
      sendJson(res, 200, result);
    } catch (error) {
      fail(res, 400, 'revoke_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/social/probe' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      social: app.api?.socialCapabilities?.() || { add_friend: false, join_group: false, experimental: false },
      note: '加好友/加群为实验性能力，需设置 features.experimentalSocial=true'
    });
    return;
  }

  if (pathname === '/v1/friends/add' && req.method === 'POST') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    const body = await readJsonBody(req, 1024 * 1024);
    try {
      sendJson(res, 200, await app.api.addFriend(body));
    } catch (error) {
      fail(res, 400, 'add_friend_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/groups/join' && req.method === 'POST') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    const body = await readJsonBody(req, 1024 * 1024);
    try {
      sendJson(res, 200, await app.api.joinGroup(body));
    } catch (error) {
      fail(res, 400, 'join_group_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/media/fetch' && req.method === 'POST') {
    if (!app.api || !app.login?.publicState().online) {
      fail(res, 503, 'not_ready', 'QQ 尚未登录完成');
      return;
    }
    const body = await readJsonBody(req, 1024 * 1024);
    if (!body.message_id || !body.element_id || !body.conversation_id) {
      fail(res, 400, 'bad_request', '缺少 message_id / element_id / conversation_id');
      return;
    }
    try {
      const saved = await app.api.fetchMedia(
        { chat_type: body.chat_type || 'private', id: body.conversation_id },
        body.message_id,
        body.element_id
      );
      sendJson(res, 200, saved);
    } catch (error) {
      fail(res, 400, 'fetch_failed', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/media' && req.method === 'POST') {
    const body = await readJsonBody(req, app.config.media.maxUploadBytes || 209715200);
    try {
      let buffer;
      let name = String(body.name || 'file');
      if (body.base64) {
        buffer = Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      } else if (body.path) {
        buffer = fs.readFileSync(String(body.path));
        name = name === 'file' ? path.basename(body.path) : name;
      } else if (body.url) {
        buffer = await httpGetBuffer(String(body.url), {
          timeout: 30000,
          maxBytes: Number(app.config.media.maxUploadBytes || 0)
        });
        name = name === 'file' ? path.basename(new URL(body.url).pathname) : name;
      } else {
        fail(res, 400, 'bad_request', '需要 base64 / path / url 之一');
        return;
      }
      if (buffer.length > Number(app.config.media.maxUploadBytes || 0)) {
        fail(res, 413, 'too_large', '文件超过最大上传限制');
        return;
      }
      const ext = path.extname(name) || '.bin';
      const saved = app.media.saveBuffer(buffer, ext);
      sendJson(res, 200, { ...saved, name });
    } catch (error) {
      fail(res, 400, 'upload_failed', error.message || String(error));
    }
    return;
  }

  if (pathname.startsWith('/v1/media/') && req.method === 'GET') {
    const rel = decodeURIComponent(pathname.slice('/v1/media/'.length));
    try {
      const file = app.media.resolve(rel);
      if (!fs.existsSync(file)) {
        fail(res, 404, 'not_found', '文件不存在');
        return;
      }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': contentTypeFor(file),
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      fail(res, 400, 'invalid_path', error.message || String(error));
    }
    return;
  }

  if (pathname === '/v1/logs' && req.method === 'GET') {
    const tail = clampInt(url.searchParams.get('tail'), 1, app.config.log.buffer || 500, 200);
    sendJson(res, 200, { logs: app.logger.tail(tail) });
    return;
  }

  if (pathname === '/v1/events' && req.method === 'GET') {
    const wait = clampInt(url.searchParams.get('wait'), 0, 30, 0);
    if (wait > 0 && app.queue) await app.queue.waitForMessage(wait * 1000);
    sendJson(res, 200, { pending: app.queue?.pendingCount() || 0, cursor: app.queue?.cursor() || '0' });
    return;
  }

  if (pathname === '/') {
    sendText(res, 200, `ai-qq-bridge\n当前时间: ${new Date(nowSec() * 1000).toISOString()}\n`);
    return;
  }

  fail(res, 404, 'not_found', '接口不存在');
}

export function shouldTrustLocal (req) {
  return isPrivateAddress(req.socket?.remoteAddress || '');
}
