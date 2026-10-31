import fs from 'node:fs';
import path from 'node:path';
import { extOf, randomId } from '../util.mjs';

const CHAT_TYPE_GROUP = 2;
const CHAT_TYPE_C2C = 1;
const CHAT_TYPE_TEMP_GROUP = 100;

function chatTypeName (chatType) {
  if (chatType === CHAT_TYPE_GROUP) return 'group';
  if (chatType === CHAT_TYPE_C2C) return 'private';
  if (chatType === CHAT_TYPE_TEMP_GROUP) return 'temp';
  return 'other';
}

function attachmentKey (raw, element) {
  return `${raw.msgId}:${element.elementId}`;
}

export async function downloadAttachment (ctx, raw, element, options = {}) {
  const timeout = options.timeout || ctx.config.media.imageTimeoutMs || 20000;
  const tempPath = path.join(ctx.config._dataDir, 'tmp', `${randomId()}.bin`);
  fs.mkdirSync(path.dirname(tempPath), { recursive: true });

  const [, info] = await ctx.bus.call(
    'NodeIKernelMsgService/downloadRichMedia',
    'NodeIKernelMsgListener/onRichMediaDownloadComplete',
    [{
      fileModelId: '0',
      downSourceType: 0,
      downloadSourceType: 0,
      triggerType: 1,
      msgId: String(raw.msgId),
      chatType: raw.chatType,
      peerUid: String(raw.peerUid),
      elementId: String(element.elementId),
      thumbSize: 0,
      downloadType: 1,
      filePath: tempPath
    }],
    {
      dataCheck: arg => String(arg?.msgId) === String(raw.msgId) && String(arg?.msgElementId) === String(element.elementId),
      timeout
    }
  );

  const filePath = info?.filePath || tempPath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const name = element.fileElement?.fileName ||
    element.picElement?.fileName ||
    element.videoElement?.fileName ||
    element.pttElement?.fileName ||
    'file';
  return ctx.media.saveFile(filePath, name);
}

async function tryAutoDownload (ctx, raw, element, meta) {
  if (!ctx.config.media.autoDownloadImages) return meta;
  const size = Number(element.picElement?.fileSize || element.fileElement?.fileSize || 0);
  if (size > Number(ctx.config.media.maxDownloadBytes || 0)) return meta;
  try {
    const saved = await downloadAttachment(ctx, raw, element, { timeout: ctx.config.media.imageTimeoutMs });
    if (!saved) return meta;
    return {
      ...meta,
      size: saved.size || size,
      local_path: saved.path,
      media_url: saved.url,
      md5: element.picElement?.md5HexStr || saved.md5
    };
  } catch (error) {
    ctx.logger?.warn('[msg] 图片下载失败', error?.message || error);
    return meta;
  }
}

export async function parseRawMessage (raw, ctx, options = {}) {
  const chatType = chatTypeName(raw.chatType);
  if (!['group', 'private', 'temp'].includes(chatType)) return null;

  const isSelf = String(raw.senderUin || '') === String(ctx.selfInfo.uin || '');
  const segments = [];

  for (const element of raw.elements || []) {
    switch (element.elementType) {
      case 1: {
        const text = element.textElement;
        if (!text) break;
        if (Number(text.atType) > 0) {
          segments.push({
            type: 'at',
            qq: String(text.atUid || ''),
            name: String(text.content || '').replace(/^@/, '')
          });
        } else if (text.content) {
          segments.push({ type: 'text', text: String(text.content) });
        }
        break;
      }
      case 2: {
        const pic = element.picElement || {};
        let meta = {
          type: 'image',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          file: pic.fileName || '',
          size: Number(pic.fileSize || 0),
          width: Number(pic.picWidth || 0),
          height: Number(pic.picHeight || 0),
          md5: pic.md5HexStr || '',
          url: pic.originImageUrl || ''
        };
        if (options.downloadImages) meta = await tryAutoDownload(ctx, raw, element, meta);
        segments.push(meta);
        break;
      }
      case 3: {
        const file = element.fileElement || {};
        segments.push({
          type: 'file',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          name: file.fileName || '',
          size: Number(file.fileSize || 0),
          path: file.filePath || '',
          md5: file.fileMd5 || ''
        });
        break;
      }
      case 4: {
        const ptt = element.pttElement || {};
        segments.push({
          type: 'voice',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          name: ptt.fileName || '',
          size: Number(ptt.fileSize || 0),
          duration: Number(ptt.duration || 0),
          path: ptt.filePath || ''
        });
        break;
      }
      case 5: {
        const video = element.videoElement || {};
        segments.push({
          type: 'video',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          name: video.fileName || '',
          size: Number(video.fileSize || 0),
          duration: Number(video.fileTime || 0),
          width: Number(video.fileWidth || 0),
          height: Number(video.fileHeight || 0),
          path: video.filePath || ''
        });
        break;
      }
      case 6: {
        const face = element.faceElement || {};
        segments.push({
          type: 'face',
          id: Number(face.faceIndex || 0),
          text: face.faceText || ''
        });
        break;
      }
      case 7: {
        const reply = element.replyElement || {};
        segments.push({
          type: 'reply',
          id: String(reply.replayMsgId || ''),
          seq: String(reply.replayMsgSeq || ''),
          sender_uin: String(reply.senderUin || '')
        });
        break;
      }
      case 10:
        segments.push({ type: 'ark' });
        break;
      case 16:
        segments.push({
          type: 'forward',
          summary: element.multiForwardMsgElement?.resId ? '合并转发' : '',
          res_id: element.multiForwardMsgElement?.resId || ''
        });
        break;
      default:
        segments.push({ type: 'unknown', element_type: element.elementType });
    }
  }

  return {
    id: String(raw.msgId),
    time: Number(raw.msgTime || 0),
    seq_qq: String(raw.msgSeq || ''),
    chat_type: chatType,
    conversation: {
      id: chatType === 'group' ? String(raw.peerUin || raw.peerUid) : String(raw.peerUid),
      qq: String(raw.peerUin || ''),
      name: String(raw.peerName || '')
    },
    sender: {
      uin: String(raw.senderUin || ''),
      uid: String(raw.senderUid || ''),
      name: String(raw.sendMemberName || raw.sendNickName || raw.sendRemarkName || '')
    },
    self: isSelf,
    segments
  };
}
