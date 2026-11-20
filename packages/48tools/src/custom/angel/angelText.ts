import type { CustomMessageV2 } from '@48tools-api/48';

/**
 * 把房间的原始消息变成推理用的一行文字（不依赖界面代码，测试和导出都用它）。
 * 语音、翻牌语音如果在本机转写过，用转写出来的文字（见 ../transcribe/transcriptCache 的 getAllTranscripts）。
 */
export interface AngelMessage {
  key: string;
  roomId: number;      // 哪个成员的房间
  senderId: number;    // 谁发的（房主本人，或者来串门的成员）
  senderNick: string;
  time: number;
  type: string;
  text: string;        // 显示用的文字（回复会带上粉丝的原话）
  own: string;         // 成员自己说的话（文字消息、回复里成员说的部分、转写过的语音）；没有时是空的。找线索只看这部分
}

interface Body {
  replyInfo?: { replyText?: string; text?: string; voiceUrl?: string };
  giftReplyInfo?: { replyText?: string; text?: string; voiceUrl?: string };
  filpCardInfo?: { question?: string; answer?: string };
  livePushInfo?: { liveTitle?: string };
  md5?: string;
  url?: string;
}

function parse<T>(text: string | undefined): T | undefined {
  try {
    return JSON.parse(text ?? '') as T;
  } catch {
    return undefined;
  }
}

/* 语音的标识，和语音转文字缓存用的一样：房间语音用 md5，没有的（翻牌语音、语音回复）用地址 */
export function voiceIdOf(raw: CustomMessageV2): string | undefined {
  const body: Body | undefined = parse<Body>(raw.bodys);
  const type: string = raw.msgType; // 类型定义里没有 AUDIO_REPLY 这些新类型

  if (type === 'AUDIO') return body?.md5 || body?.url;

  if (type === 'AUDIO_REPLY' || type === 'AUDIO_GIFT_REPLY') {
    return (body?.replyInfo ?? body?.giftReplyInfo)?.voiceUrl;
  }

  if (type === 'FLIPCARD_AUDIO') {
    return parse<{ url?: string }>(body?.filpCardInfo?.answer)?.url;
  }

  return undefined;
}

export function toAngelMessage(raw: CustomMessageV2, roomId: number, transcripts?: Map<string, string>): AngelMessage {
  const user: { userId?: number | string; nickName?: string } = parse<{ user?: object }>(raw.extInfo)?.user ?? {};
  const body: Body | undefined = parse<Body>(raw.bodys);
  const voiceId: string | undefined = voiceIdOf(raw);
  const voice: string | undefined = voiceId ? transcripts?.get(voiceId) : undefined;
  const reply: Body['replyInfo'] = body?.replyInfo ?? body?.giftReplyInfo;
  const type: string = raw.msgType;
  let text: string;
  let own: string = '';

  switch (type) {
    case 'TEXT':
      text = String(raw.bodys);
      own = text;
      break;

    case 'REPLY':
    case 'GIFTREPLY':
      text = `「${ reply?.replyText ?? '' }」→ ${ reply?.text ?? '' }`;
      own = type === 'REPLY' ? reply?.text ?? '' : '';
      break;

    case 'AUDIO_REPLY':
    case 'AUDIO_GIFT_REPLY':
      text = `「${ reply?.replyText ?? '' }」→ ${ voice ? `[语音] ${ voice }` : '[语音]' }`;
      own = voice ?? '';
      break;

    case 'FLIPCARD':
      text = `[翻牌] 问：${ body?.filpCardInfo?.question ?? '' } 答：${ body?.filpCardInfo?.answer ?? '' }`;
      own = body?.filpCardInfo?.answer ?? '';
      break;

    case 'FLIPCARD_AUDIO':
    case 'FLIPCARD_VIDEO':
      text = `[翻牌] 问：${ body?.filpCardInfo?.question ?? '' } 答：${ voice ? `[语音] ${ voice }` : '[语音/视频]' }`;
      own = voice ?? '';
      break;

    case 'AUDIO':
      text = voice ? `[语音] ${ voice }` : '[语音]';
      own = voice ?? '';
      break;

    case 'IMAGE': text = '[图片]'; break;
    case 'VIDEO': text = '[视频]'; break;
    case 'EXPRESSIMAGE': text = '[表情]'; break;
    case 'LIVEPUSH': text = `[开始直播] ${ body?.livePushInfo?.liveTitle ?? '' }`; break;
    default: text = `[${ type }]`;
  }

  return {
    key: raw.msgIdClient || String(raw.msgIdServer),
    roomId,
    senderId: Number(user.userId),
    senderNick: user.nickName ?? '',
    time: raw.msgTime,
    type,
    text: text.replace(/\s+/g, ' ').trim(),
    own: own.replace(/\s+/g, ' ').trim()
  };
}
