import type { CustomMessageV2 } from '@48tools-api/48';

/**
 * 一条房间消息里能搜到的文字（纯函数）：文字消息的内容、回复的内容和被回复的那句话、翻牌的提问和回答、直播标题、礼物。
 * 语音没有文字，转过文字的把转出来的文字（transcript）传进来。搜索消息内容（./RoomSearch）用它判断匹配、显示摘要。
 */
function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
