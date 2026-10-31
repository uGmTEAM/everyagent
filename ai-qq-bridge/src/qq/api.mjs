import { buildElements, resolvePeer, uinToUid } from './msg-elements.mjs';
import { downloadAttachment, parseRawMessage } from './msg-parse.mjs';
import { clampInt } from '../util.mjs';

const MEMBER_CACHE_TTL = 5 * 60 * 1000;
const ROLE_NAMES = { 1: 'stranger', 2: 'member', 3: 'admin', 4: 'owner' };

function pickArray (args) {
  for (let i = args.length - 1; i >= 0; i--) {
    if (Array.isArray(args[i])) return args[i];
  }
  return [];
}

export class QQApi {
  constructor (ctx) {
    this.ctx = ctx;
    this.memberCache = new Map();
  }

  async send (target, segments, options = {}) {
    const ctx = this.ctx;
    const peer = await resolvePeer(target, ctx);
    const msgService = ctx.session.getMsgService();

    const onlyForward = segments.length === 1 && String(segments[0]?.type || '').toLowerCase() === 'forward';
    if (onlyForward) {
      const ids = (segments[0].message_ids || segments[0].ids || []).map(String).filter(Boolean);
      if (ids.length === 0) throw new Error('forward 段缺少 message_ids');
      const source = segments[0].source ? await resolvePeer(segments[0].source, ctx) : peer;
      await msgService.forwardMsg(ids, source, [peer], new Map());
      return { ok: true, forwarded: ids.length, message_id: '', seq: '' };
    }

    const elements = await buildElements(segments, peer, ctx);
    if (elements.length === 0) throw new Error('没有可发送的消息段');

    const msgId = msgService.generateMsgUniqueId(peer.chatType, ctx.session.getMSFService().getServerTime());
    peer.guildId = msgId;

    const [, list] = await ctx.bus.call(
      'NodeIKernelMsgService/sendMsg',
      'NodeIKernelMsgListener/onMsgInfoListUpdate',
      ['0', peer, elements, new Map()],
      {
        dataCheck: records => Array.isArray(records) && records.some(item => item.guildId === msgId && item.sendStatus === 2),
        timeout: options.timeout || 20000
      }
    );

    const found = (list || []).find(item => item.guildId === msgId && item.sendStatus === 2) ||
      (list || []).find(item => item.guildId === msgId);
    return {
      ok: true,
      message_id: String(found?.msgId || ''),
      seq: String(found?.msgSeq || ''),
      time: Number(found?.msgTime || Math.floor(Date.now() / 1000))
    };
  }

  async getGroups () {
    const ctx = this.ctx;
    const args = await ctx.bus.call(
      'NodeIKernelGroupService/getGroupList',
      'NodeIKernelGroupListener/onGroupListUpdate',
      [true],
      { timeout: 20000, dataCheck: () => true }
    );
    const list = pickArray(args);
    return list.map(item => ({
      id: String(item.groupCode || item.groupUin || ''),
      name: String(item.groupName || ''),
      remark: String(item.remark || ''),
      owner_uin: String(item.groupOwnerId?.memberUin || ''),
      member_count: Number(item.memberCount || 0),
      max_member_count: Number(item.maxMemberCount || 0)
    })).filter(item => item.id);
  }

  async getFriends () {
    const ctx = this.ctx;
    const buddyService = ctx.session.getBuddyService();
    let entries = [];
    try {
      const res = await buddyService.getBuddyListV2('0', true, 0);
      entries = res?.data || [];
    } catch {
      const res = await buddyService.getBuddyListV2('0', 0);
      entries = res?.data || [];
    }
    const uids = entries.flatMap(item => item.buddyUids || []).filter(Boolean);
    if (uids.length === 0) return [];
    const map = await ctx.session.getProfileService().getCoreAndBaseInfo('nodeStore', uids);
    const out = [];
    const push = (uid, info) => {
      if (!info) return;
      out.push({
        uid: String(info.uid || uid),
        uin: String(info.uin || ''),
        name: String(info.nick || info.remark || ''),
        remark: String(info.remark || '')
      });
    };
    if (typeof map?.forEach === 'function') {
      if (map instanceof Map || typeof map.entries === 'function') {
        for (const [uid, info] of map.entries()) push(uid, info);
      } else {
        map.forEach((info, uid) => push(uid, info));
      }
    } else if (map && typeof map === 'object') {
      for (const [uid, info] of Object.entries(map)) push(uid, info);
    }
    return out.filter(item => item.uin);
  }

  async history (target, limit = 20) {
    const ctx = this.ctx;
    const peer = await resolvePeer(target, ctx);
    const count = clampInt(limit, 1, 100, 20);
    const res = await ctx.session.getMsgService().getAioFirstViewLatestMsgs(peer, count);
    const list = res?.msgList || [];
    const parsed = [];
    for (const raw of list) {
      const msg = await parseRawMessage(raw, ctx, { downloadImages: false });
      if (msg) parsed.push(msg);
    }
    parsed.sort((a, b) => a.time - b.time);
    return parsed;
  }

  async fetchMedia (conversation, msgId, elementId, options = {}) {
    const ctx = this.ctx;
    const chatType = conversation.chat_type === 'group' ? 2 : 1;
    const peer = {
      chatType,
      peerUid: String(conversation.id || ''),
      guildId: ''
    };
    const res = await ctx.session.getMsgService().getMsgsByMsgId(peer, [String(msgId)]);
    const raw = res?.msgList?.[0];
    if (!raw) throw new Error('消息不存在或已过期');
    const element = (raw.elements || []).find(item => String(item.elementId) === String(elementId));
    if (!element) throw new Error('消息元素不存在');
    const saved = await downloadAttachment(ctx, raw, element, { timeout: options.timeout || 60000 });
    if (!saved) throw new Error('下载失败');
    return saved;
  }

  async getGroupMembers (groupId, limit = 100, offset = 0) {
    const ctx = this.ctx;
    const gid = String(groupId || '');
    if (!gid) throw new Error('缺少群号');
    const now = Date.now();
    const cached = this.memberCache.get(gid);
    let members;
    if (cached && now - cached.at < MEMBER_CACHE_TTL) {
      members = cached.members;
    } else {
      const service = ctx.session.getGroupService();
      if (typeof service.getAllMemberList !== 'function') {
        throw new Error('当前 QQ 版本未暴露 getAllMemberList');
      }
      const res = await service.getAllMemberList(gid, true);
      const infos = res?.result?.infos || res?.infos || [];
      members = infos.map(item => ({
        uin: String(item.uin || ''),
        uid: String(item.uid || ''),
        name: String(item.nick || ''),
        card: String(item.cardName || ''),
        role: ROLE_NAMES[Number(item.role)] || String(item.role || ''),
        join_time: String(item.joinTime || '')
      })).filter(item => item.uin || item.uid);
      this.memberCache.set(gid, { at: now, members });
    }
    const start = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const count = clampInt(limit, 1, 200, 100);
    return {
      group_id: gid,
      total: members.length,
      members: members.slice(start, start + count)
    };
  }

  async getGroupInfo (groupId) {
    const gid = String(groupId || '');
    if (!gid) throw new Error('缺少群号');
    const list = await this.getGroups();
    const found = list.find(item => item.id === gid);
    if (found) return { group: found };
    return { group: { id: gid, name: '', remark: '', owner_uin: '', member_count: 0, max_member_count: 0 } };
  }

  async getFriendProfile (uin) {
    const ctx = this.ctx;
    const target = String(uin || '');
    if (!target) throw new Error('缺少 QQ 号');
    const uid = target.startsWith('u_') ? target : await uinToUid(target, ctx);
    if (!uid) throw new Error(`无法解析 UID: ${target}`);
    const map = await ctx.session.getProfileService().getCoreAndBaseInfo('nodeStore', [uid]);
    let info = null;
    if (map?.get) info = map.get(uid);
    else if (map && typeof map === 'object') info = map[uid];
    if (!info) {
      try {
        info = await ctx.session.getProfileService().getUserDetailInfo(uid);
      } catch {
        info = null;
      }
    }
    return {
      friend: {
        uin: String(info?.uin || target),
        uid: String(info?.uid || uid),
        name: String(info?.nick || info?.nickName || ''),
        remark: String(info?.remark || ''),
        signature: String(info?.signature || info?.longNick || '')
      }
    };
  }

  async getSelfProfile () {
    const ctx = this.ctx;
    const self = ctx.selfInfo || {};
    let name = '';
    try {
      const map = await ctx.session.getProfileService().getCoreAndBaseInfo('nodeStore', [String(self.uid || '')]);
      const info = map?.get?.(self.uid) || (map && map[self.uid]);
      name = String(info?.nick || info?.nickName || '');
    } catch {
      name = '';
    }
    return {
      self: {
        uin: String(self.uin || ''),
        uid: String(self.uid || ''),
        name
      }
    };
  }

  async revoke (target, messageId) {
    const ctx = this.ctx;
    const peer = await resolvePeer(target, ctx);
    const ids = [String(messageId || '')].filter(Boolean);
    if (ids.length === 0) throw new Error('缺少 message_id');
    const result = await ctx.session.getMsgService().recallMsg(peer, ids);
    const ok = result === undefined || result === true || Number(result?.result) === 0;
    if (!ok) throw new Error(`撤回失败：${result?.errMsg || result?.result || '未知错误'}`);
    return { ok: true, message_id: ids[0] };
  }

  socialCapabilities () {
    const ctx = this.ctx;
    let buddy = null;
    try {
      if (typeof ctx.session.getAddBuddyService === 'function') buddy = ctx.session.getAddBuddyService();
    } catch {
      buddy = null;
    }
    let group = null;
    try {
      group = ctx.session.getGroupService();
    } catch {
      group = null;
    }
    return {
      add_friend: typeof buddy?.addBuddy === 'function',
      join_group: typeof group?.reqToJoinGroup === 'function' || typeof group?.joinGroup === 'function',
      experimental: !!ctx.config.features?.experimentalSocial
    };
  }

  async addFriend (input = {}) {
    const ctx = this.ctx;
    if (!ctx.config.features?.experimentalSocial) {
      throw new Error('加好友为实验性能力，需在配置中开启 features.experimentalSocial');
    }
    if (typeof ctx.session.getAddBuddyService !== 'function') {
      throw new Error('当前 QQ 版本未暴露 AddBuddyService');
    }
    const service = ctx.session.getAddBuddyService();
    if (typeof service?.addBuddy !== 'function') {
      throw new Error('当前 QQ 版本未暴露 addBuddy');
    }
    const uin = String(input.uin || '');
    const uid = uin ? await uinToUid(uin, ctx) : '';
    const args = Array.isArray(input.args) && input.args.length > 0
      ? input.args
      : [uid || uin, { msg: String(input.message || ''), remark: String(input.remark || ''), source: 0 }, {}];
    const result = await service.addBuddy(...args);
    return { ok: true, experimental: true, uin, uid, result: result ?? null };
  }

  async joinGroup (input = {}) {
    const ctx = this.ctx;
    if (!ctx.config.features?.experimentalSocial) {
      throw new Error('加群为实验性能力，需在配置中开启 features.experimentalSocial');
    }
    const gid = String(input.group_id || input.group || '');
    if (!gid) throw new Error('缺少 group_id');
    const service = ctx.session.getGroupService();
    const arg = Array.isArray(input.args) && input.args.length > 0
      ? input.args[0]
      : { groupCode: gid, msg: String(input.message || ''), source: 0 };
    if (typeof service?.reqToJoinGroup === 'function') {
      const result = await service.reqToJoinGroup(gid, arg);
      return { ok: true, experimental: true, via: 'reqToJoinGroup', group_id: gid, result: result ?? null };
    }
    if (typeof service?.joinGroup === 'function') {
      const result = await service.joinGroup({ ...arg, groupCode: gid, group_id: gid });
      return { ok: true, experimental: true, via: 'joinGroup', group_id: gid, result: result ?? null };
    }
    throw new Error('当前 QQ 版本未暴露加群方法');
  }
}
