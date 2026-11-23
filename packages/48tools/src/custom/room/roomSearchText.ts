import type { CustomMessageV2 } from '@48tools-api/48';

/**
 * 一条房间消息里能搜到的文字（纯函数）：文字消息的内容、回复的内容和被回复的那句话、语音回复回复的是什么、翻牌的提问和回答、直播标题、礼物。
 * 语音没有文字，转过文字的把转出来的文字（transcript）传进来。搜索消息内容（./RoomSearch）用它判断匹配、显示摘要。
 */
function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* 成员用语音回复：回复粉丝的消息（AUDIO_REPLY）、回复粉丝送的礼物（AUDIO_GIFT_REPLY） */
export const VOICE_REPLY_TYPES: Array<string> = ['AUDIO_REPLY', 'AUDIO_GIFT_REPLY'];

export interface VoiceReply {
  url: string;        // 语音地址（也是转写缓存里的标识）
  replyName: string;  // 被回复的粉丝
  replyText: string;  // 粉丝说的话，或者「送给 刘诗彤 1个心锁」
  duration?: number;  // 毫秒
}

/**
 * 语音回复的内容；不是语音回复（或者没有语音地址）返回 undefined
 * @param { string } type - msgType
 * @param { unknown } bodys - 消息的 bodys（原始的字符串，或者已经解析好的对象）
 */
export function voiceReplyOf(type: string, bodys: unknown): VoiceReply | undefined {
  if (!VOICE_REPLY_TYPES.includes(type)) return undefined;

  const body: any = typeof bodys === 'string' ? parse(bodys) : bodys;
  const info: any = body?.replyInfo ?? body?.giftReplyInfo;

  if (typeof info?.voiceUrl !== 'string' || info.voiceUrl === '') return undefined;

  // 消息里的 duration 是秒（例如 19）
  const seconds: number = Number(info.duration);

  return {
    url: new URL(info.voiceUrl, 'https://mp4.48.cn/').href,
    replyName: typeof info.replyName === 'string' ? info.replyName : '',
    replyText: typeof info.replyText === 'string' ? info.replyText : '',
    duration: seconds > 0 ? Math.round(seconds * 1_000) : undefined
  };
}

function join(...parts: Array<unknown>): string {
  return parts.filter((part: unknown): part is string => typeof part === 'string' && part !== '').join(' ');
}

export function messageText(raw: CustomMessageV2, transcript?: string): string {
  const type: string = raw.msgType;

  if (type === 'TEXT') return raw.bodys;

  const body: any = parse(raw.bodys) ?? {};

  if (type === 'REPLY' || type === 'GIFTREPLY') {
    const info: any = body.replyInfo ?? body.giftReplyInfo ?? {};

    return join(info.text, info.replyName, info.replyText);
  }

  if (type === 'FLIPCARD' || type === 'FLIPCARD_AUDIO' || type === 'FLIPCARD_VIDEO') {
    const info: any = body.filpCardInfo ?? body.flipCardInfo ?? body.filpCardAudioInfo ?? body.flipCardAudioInfo
      ?? body.filpCardVideoInfo ?? body.flipCardVideoInfo ?? {};

    return join(info.question, type === 'FLIPCARD' ? info.answer : undefined, transcript);
  }

  if (VOICE_REPLY_TYPES.includes(type)) {
    const info: any = body.replyInfo ?? body.giftReplyInfo ?? {};

    return join(info.replyName, info.replyText, transcript);
  }

  if (type === 'LIVEPUSH') return join('直播', body.livePushInfo?.liveTitle);

  if (type === 'GIFT_TEXT') return join('送给', body.giftInfo?.userName, body.giftInfo?.giftName);

  if (type === 'AUDIO') return join(transcript);

  return '';
}

/* 发送者的名字 */
export function senderName(raw: CustomMessageV2): string {
  const name: unknown = parse(raw.extInfo)?.user?.nickName;

  return typeof name === 'string' ? name : '';
}

/* 这条消息是否匹配搜索词（不分大小写；在内容或发送者名字里找） */
export function matchMessage(raw: CustomMessageV2, keyword: string, transcript?: string): boolean {
  const word: string = keyword.trim().toLowerCase();

  if (word === '') return false;

  return messageText(raw, transcript).toLowerCase().includes(word) || senderName(raw).toLowerCase().includes(word);
}

/* 搜索结果里显示的摘要：搜索词前后各留一些字 */
export function snippet(text: string, keyword: string, around: number = 28): string {
  const line: string = text.replace(/\s+/g, ' ').trim();
  const index: number = line.toLowerCase().indexOf(keyword.trim().toLowerCase());

  if (index < 0 || line.length <= around * 2) return line.slice(0, (around * 2) + 10);

  const start: number = Math.max(0, index - around);
  const end: number = Math.min(line.length, index + keyword.trim().length + around);

  return `${ start > 0 ? '…' : '' }${ line.slice(start, end) }${ end < line.length ? '…' : '' }`;
}
