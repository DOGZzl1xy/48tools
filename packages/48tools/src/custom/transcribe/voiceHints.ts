import type { CustomMessageV2 } from '@48tools-api/48';

/**
 * 语音转文字的「参考内容」：从语音前后的聊天里挑出能帮模型把名字写对的文字。
 * 成员用语音念感谢名单之前，通常会先发一条文字把送礼的人和礼物列出来；粉丝送礼物时房间里也有一条礼物消息。
 * 光听声音，模型只能把粉丝昵称、礼物名写成音近字，有了这些文字就能对上。
 * 挑两类：
 *   - 成员自己发的文字（包括回复别人的话），取语音前 TEXT_BEFORE 到后 AFTER 这段时间里离语音最近的几条
 *   - 粉丝送的礼物（谁送了什么），取语音前 GIFT_BEFORE 这段时间里的
 * 粉丝的普通发言不取（太多，而且和语音内容关系不大）。
 * 这个文件只管「挑哪些」，输入是接口返回的原始消息；从哪里读消息见 ./transcribeStore，怎么发给模型见 ./transcribeApi。
 */
export interface VoiceHintSource {
  time: number;                     // 语音消息的时间（毫秒）
  messages: Array<CustomMessageV2>; // 语音前后的消息（成员的、所有人的都可以混在一起，顺序不限，可以有重复）
  question?: string;                // 翻牌的语音回答：粉丝的提问
}

const TEXT_BEFORE: number = 10 * 60_000;
const GIFT_BEFORE: number = 15 * 60_000;
const AFTER: number = 2 * 60_000;
const MAX_TEXTS: number = 12;
const MAX_GIFTS: number = 40;
const MAX_TEXT_LENGTH: number = 1_000; // 一条文字最多取多少个字
const MAX_TOTAL_LENGTH: number = 3_000;
const MEMBER_ROLE: number = 3;

/* 语音前后多长时间里的消息有用（读缓存时用） */
export const hintWindow: { before: number; after: number } = { before: GIFT_BEFORE, after: AFTER };

function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* 整理成一行：换行变成「 / 」，去掉尖括号（免得和提示里的标记混在一起），太长的截断 */
function oneLine(text: unknown): string {
  if (typeof text !== 'string') return '';

  const line: string = text.replace(/\s*[\r\n]+\s*/g, ' / ').replace(/[<>]/g, ' ').trim();

  return line.length > MAX_TEXT_LENGTH ? `${ line.slice(0, MAX_TEXT_LENGTH) }…` : line;
}

/* 成员发的一条消息里的文字；不是文字类的消息返回空 */
function memberText(raw: CustomMessageV2): string {
  if (raw.msgType === 'TEXT') return oneLine(raw.bodys);

  if ((raw.msgType as string) === 'REPLY' || (raw.msgType as string) === 'GIFTREPLY') {
    const body: any = parse(raw.bodys);
    const info: any = body?.replyInfo ?? body?.giftReplyInfo;
    const text: string = oneLine(info?.text);
    const name: string = oneLine(info?.replyName);

    if (!text) return '';

    return name ? `回复「${ name }」：${ text }` : text;
  }

  return '';
}

/* 一条礼物消息：谁送了什么 */
function giftText(raw: CustomMessageV2): string {
  const gift: any = parse(raw.bodys)?.giftInfo;
  const sender: string = oneLine(parse(raw.extInfo)?.user?.nickName);
  const name: string = oneLine(gift?.giftName);

  return sender && name ? `${ sender } 送了 ${ name }` : '';
}

interface Hint {
  time: number;
  line: string;
}

function byTime(a: Hint, b: Hint): number {
  return a.time - b.time;
}

/* 离语音最近的 max 条（内容一样的只留一条：同一个人连着送同一种礼物） */
function nearest(list: Array<Hint>, time: number, max: number): Array<Hint> {
  const picked: Array<Hint> = [];
  const lines: Set<string> = new Set();

  for (const item of [...list].sort((a: Hint, b: Hint): number => Math.abs(a.time - time) - Math.abs(b.time - time))) {
    if (picked.length >= max) break;

    if (lines.has(item.line)) continue;

    lines.add(item.line);
    picked.push(item);
  }

  return picked;
}

/**
 * 挑出参考内容，每条一行。顺序：礼物在前，成员的文字在后（都是从早到晚）；没有可用的内容时返回空数组
 */
export function buildVoiceHints(source: VoiceHintSource): Array<string> {
  const { time }: VoiceHintSource = source;
  const seen: Set<string> = new Set();
  const texts: Array<Hint> = [];
  const gifts: Array<Hint> = [];

  for (const raw of source.messages) {
    const key: string = raw.msgIdClient || String(raw.msgIdServer);

    if (seen.has(key) || raw.msgTime > time + AFTER || raw.msgTime < time - GIFT_BEFORE) continue;

    seen.add(key);

    if ((raw.msgType as string) === 'GIFT_TEXT') {
      const line: string = raw.msgTime <= time ? giftText(raw) : '';

      line && gifts.push({ time: raw.msgTime, line });
    } else if (raw.msgTime >= time - TEXT_BEFORE && parse(raw.extInfo)?.user?.roleId === MEMBER_ROLE) {
      const line: string = memberText(raw);

      line && texts.push({ time: raw.msgTime, line });
    }
  }

  // 总长度有上限：先保证成员的文字，再放礼物（都是离语音近的优先）
  const question: string = oneLine(source.question);
  let budget: number = MAX_TOTAL_LENGTH - question.length;

  function fits(item: Hint): boolean {
    if (item.line.length > budget) return false;

    budget -= item.line.length;

    return true;
  }

  const keptTexts: Array<Hint> = nearest(texts, time, MAX_TEXTS).filter(fits);
  const keptGifts: Array<Hint> = nearest(gifts, time, MAX_GIFTS).filter(fits);

  return [
    ...keptGifts.sort(byTime).map((item: Hint): string => item.line),
    ...(question ? [`翻牌提问：${ question }`] : []),
    ...keptTexts.sort(byTime).map((item: Hint): string => item.line)
  ];
}
