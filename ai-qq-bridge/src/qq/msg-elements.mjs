import fs from 'node:fs';
import path from 'node:path';
import { extOf, httpGetBuffer, md5File, randomId, sanitizeFileName } from '../util.mjs';
import { imageSize } from '../image-size.mjs';

export const ElementType = {
  TEXT: 1,
  PIC: 2,
  FILE: 3,
  PTT: 4,
  VIDEO: 5,
  FACE: 6,
  REPLY: 7,
  ARK: 10,
  MULTIFORWARD: 16
};

export const ChatType = {
  C2C: 1,
  GROUP: 2,
  TEMP_FROM_GROUP: 100
};

const PIC_TYPES = {
  '.gif': 2000,
  '.png': 1001,
  '.webp': 1002,
  '.bmp': 1005,
  '.jpg': 1000,
  '.jpeg': 1000
};

export async function resolvePeer (target, ctx) {
  const type = String(target?.type || '').toLowerCase();
  const id = String(target?.id ?? target?.qq ?? target?.group ?? '').trim();
  if (!id) throw new Error('缺少 target.id');
  if (type === 'group' || type === 'group_id') {
    return { chatType: ChatType.GROUP, peerUid: id, guildId: '' };
  }
  if (type === 'private' || type === 'user' || type === 'friend') {
    const peerUid = id.startsWith('u_') ? id : await uinToUid(id, ctx);
    if (!peerUid) throw new Error(`无法把 QQ 号 ${id} 转换为 UID`);
    return { chatType: ChatType.C2C, peerUid, guildId: '' };
  }
  throw new Error(`不支持的 target.type: ${type}`);
}

export async function uinToUid (uin, ctx) {
  const value = String(uin);
  try {
    const map = await ctx.session.getUixConvertService().getUid([value]);
    const uid = map?.uidInfo?.get?.(value);
    if (uid) return uid;
  } catch {
    // continue
  }
  try {
    const map = ctx.session.getProfileService().getUidByUin('FriendsServiceImpl', [value]);
    const uid = map?.get?.(value);
    if (uid) return uid;
  } catch {
    // continue
  }
  return '';
}

async function prepareMediaPath (ctx, sourcePath, elementType, subType = 0) {
  const md5 = await md5File(sourcePath);
  const fileName = sanitizeFileName(path.basename(sourcePath));
  let target = sourcePath;
  try {
    target = ctx.session.getMsgService().getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType,
      elementSubType: subType,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: ''
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (path.resolve(target) !== path.resolve(sourcePath)) {
      fs.copyFileSync(sourcePath, target);
    }
  } catch (error) {
    ctx.logger?.warn('[msg] 准备媒体缓存失败，退回原路径', error?.message || error);
    target = sourcePath;
  }
  return { md5, fileName, target, size: fs.statSync(sourcePath).size };
}

async function materializeLocalFile (segment, ctx) {
  if (segment.path && fs.existsSync(segment.path)) return segment.path;
  if (segment.file && fs.existsSync(segment.file)) return segment.file;
  if (segment.base64) {
    const raw = String(segment.base64).replace(/^data:[^;]+;base64,/, '');
    const ext = extOf(segment.name || segment.file_name || '.bin') || '.bin';
    const file = path.join(ctx.config._dataDir, 'tmp', `${randomId()}${ext}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(raw, 'base64'));
    return file;
  }
  if (segment.url && /^https?:\/\//i.test(String(segment.url))) {
    const ext = extOf(new URL(String(segment.url)).pathname) || '.bin';
    const buffer = await httpGetBuffer(String(segment.url), {
      timeout: 30000,
      maxBytes: Number(ctx.config.media?.maxUploadBytes || 0)
    });
    const file = path.join(ctx.config._dataDir, 'tmp', `${randomId()}${ext}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    return file;
  }
  throw new Error('图片/文件需要提供 path、base64 或 url');
}

async function buildText (segment, ctx) {
  if (segment.type === 'at') {
    const qq = String(segment.qq ?? segment.id ?? '');
    if (!qq) throw new Error('at 段缺少 qq');
    if (qq === 'all') {
      return {
        elementType: ElementType.TEXT,
        elementId: '',
        textElement: { content: '@全体成员', atType: 1, atUid: 'all', atTinyId: '', atNtUid: 'all' }
      };
    }
    const uid = await uinToUid(qq, ctx);
    return {
      elementType: ElementType.TEXT,
      elementId: '',
      textElement: {
        content: `@${segment.name || qq}`,
        atType: 2,
        atUid: qq,
        atTinyId: '',
        atNtUid: uid
      }
    };
  }
  return {
    elementType: ElementType.TEXT,
    elementId: '',
    textElement: {
      content: String(segment.text ?? ''),
      atType: 0,
      atUid: '',
      atTinyId: '',
      atNtUid: ''
    }
  };
}

async function buildReply (segment, peer, ctx) {
  const id = String(segment.id ?? segment.message_id ?? '');
  if (!id) throw new Error('reply 段缺少 id');
  const res = await ctx.session.getMsgService().getMsgsByMsgId(peer, [id]);
  const raw = res?.msgList?.[0];
  if (!raw) throw new Error(`找不到被引用的消息 ${id}`);
  return {
    elementType: ElementType.REPLY,
    elementId: '',
    replyElement: {
      replayMsgSeq: String(raw.msgSeq || ''),
      replayMsgId: String(raw.msgId || id),
      senderUin: String(raw.senderUin || ''),
      senderUinStr: String(raw.senderUin || ''),
      replyMsgClientSeq: String(raw.clientSeq || ''),
      _replyMsgPeer: peer
    }
  };
}

async function buildImage (segment, peer, ctx) {
  const source = await materializeLocalFile(segment, ctx);
  const { md5, fileName, target, size } = await prepareMediaPath(ctx, source, ElementType.PIC, 0);
  const { width, height } = imageSize(source);
  const ext = extOf(fileName);
  return {
    elementType: ElementType.PIC,
    elementId: '',
    picElement: {
      md5HexStr: md5,
      fileSize: String(size),
      picWidth: width,
      picHeight: height,
      fileName,
      sourcePath: target,
      original: true,
      picType: PIC_TYPES[ext] ?? 1000,
      picSubType: 0,
      fileUuid: '',
      fileSubId: '',
      thumbFileSize: 0,
      summary: String(segment.summary || '')
    }
  };
}

async function buildFile (segment, peer, ctx) {
  const source = await materializeLocalFile(segment, ctx);
  if (peer.chatType === ChatType.GROUP) {
    const { md5, fileName, target, size } = await prepareMediaPath(ctx, source, ElementType.FILE, 0);
    return {
      elementType: ElementType.FILE,
      elementId: '',
      fileElement: {
        fileMd5: md5,
        fileName: sanitizeFileName(segment.name || fileName),
        filePath: target,
        fileSize: String(size),
        folderId: String(segment.folder_id || '')
      }
    };
  }
  const md5 = await md5File(source);
  return {
    elementType: ElementType.FILE,
    elementId: '',
    fileElement: {
      fileMd5: md5,
      fileName: sanitizeFileName(segment.name || path.basename(source)),
      filePath: source,
      fileSize: String(fs.statSync(source).size),
      folderId: ''
    }
  };
}

export async function buildElements (segments, peer, ctx) {
  const elements = [];
  for (const segment of segments) {
    const type = String(segment?.type || '').toLowerCase();
    switch (type) {
      case 'text':
      case 'at':
        elements.push(await buildText(segment, ctx));
        break;
      case 'reply':
        elements.push(await buildReply(segment, peer, ctx));
        break;
      case 'image':
      case 'pic':
        elements.push(await buildImage(segment, peer, ctx));
        break;
      case 'file':
        elements.push(await buildFile(segment, peer, ctx));
        break;
      case 'face':
        elements.push({
          elementType: ElementType.FACE,
          elementId: '',
          faceElement: {
            faceIndex: Number(segment.id || segment.face_id || 0),
            faceType: 1,
            faceText: String(segment.text || '[表情]'),
            sourceType: 1
          }
        });
        break;
      case 'forward':
        throw new Error('forward 段必须单独发送，不能与其他段混用');
      default:
        throw new Error(`不支持的段类型: ${type}`);
    }
  }
  return elements;
}
