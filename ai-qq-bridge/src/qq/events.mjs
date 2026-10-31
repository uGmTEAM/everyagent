import { parseRawMessage } from './msg-parse.mjs';

export function startIngest (ctx) {
  const enqueueRaw = async (raw, options = {}) => {
    if (!raw?.msgId) return false;
    if (String(raw.senderUin || '') === String(ctx.selfInfo.uin || '')) return false;
    if (ctx.queue.hasSeen(String(raw.msgId))) return false;
    const message = await parseRawMessage(raw, ctx, options);
    if (!message) return false;
    ctx.queue.append(message);
    ctx.queue.markReceiveTime(Math.max(message.time, ctx.queue.getLastReceiveAt()));
    ctx.emitMessage?.(message);
    return true;
  };

  ctx.bus.on('NodeIKernelMsgListener/onRecvMsg', list => {
    (async () => {
      for (const raw of list || []) {
        try {
          await enqueueRaw(raw, { downloadImages: true });
        } catch (error) {
          ctx.logger?.error('[ingest] 处理消息失败', error);
        }
      }
    })();
  });

  ctx.bus.on('NodeIKernelMsgListener/onKickedOffLine', info => {
    ctx.logger?.warn('[ingest] 账号被踢下线', info);
    ctx.onOffline?.('kicked');
  });

  ctx.bus.on('NodeIKernelMsgListener/onSelfStatusChanged', info => {
    if (Number(info?.status) === 20) {
      ctx.logger?.warn('[ingest] 检测到静默离线');
      ctx.onOffline?.('silent_offline');
    }
  });

  return { enqueueRaw };
}

/**
 * 掉线补拉：重新登录后，用最近消息接口把离线期间的消息补进队列。
 * 仅在存在历史接收时间时执行，避免首次启动把全部历史灌入。
 */
export async function backfillRecent (ctx) {
  const since = ctx.queue.getLastReceiveAt();
  if (!ctx.config.backfill?.enabled || !since) return { peers: 0, messages: 0 };

  let groups = [];
  let friends = [];
  try {
    groups = await ctx.api.getGroups();
  } catch (error) {
    ctx.logger?.warn('[backfill] 获取群列表失败', error?.message || error);
  }
  try {
    friends = await ctx.api.getFriends();
  } catch (error) {
    ctx.logger?.warn('[backfill] 获取好友列表失败', error?.message || error);
  }

  const peers = [
    ...groups.map(group => ({ chatType: 2, peerUid: group.id, guildId: '', label: group.name || group.id })),
    ...friends.map(friend => ({ chatType: 1, peerUid: friend.uid, guildId: '', label: friend.name || friend.uin }))
  ].slice(0, Number(ctx.config.backfill.maxPeers || 100));

  let messages = 0;
  let index = 0;
  for (const peer of peers) {
    index++;
    try {
      const res = await ctx.session.getMsgService().getAioFirstViewLatestMsgs(peer, Number(ctx.config.backfill.perPeer || 20));
      for (const raw of res?.msgList || []) {
        if (Number(raw.msgTime || 0) <= since) continue;
        if (String(raw.senderUin || '') === String(ctx.selfInfo.uin || '')) continue;
        if (ctx.queue.hasSeen(String(raw.msgId))) continue;
        const message = await parseRawMessage(raw, ctx, { downloadImages: false });
        if (!message) continue;
        ctx.queue.append(message);
        ctx.emitMessage?.(message);
        messages++;
      }
      ctx.queue.markReceiveTime(Math.floor(Date.now() / 1000));
    } catch (error) {
      ctx.logger?.debug(`[backfill] ${peer.label} 补拉失败`, error?.message || error);
    }
    if (index % 20 === 0) ctx.logger?.info(`[backfill] 进度 ${index}/${peers.length}`);
  }
  ctx.logger?.info(`[backfill] 完成，扫描 ${peers.length} 个会话，补入 ${messages} 条消息`);
  return { peers: peers.length, messages };
}
