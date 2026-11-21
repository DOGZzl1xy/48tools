import type { AudioWindow, DanmuLine, Highlight, HighlightCount } from './highlightTypes';

/**
 * 录播自动切片里和时间有关的计算：读弹幕文件、把录播分成几段交给模型、合并各段找到的爆点、决定做哪几个。
 * 都是和界面、文件无关的纯计算，方便测试。
 */
export const WINDOW_LENGTH: number = 1_800; // 一次交给模型的长度：半小时（再长时间就标不准了）
export const WINDOW_OVERLAP: number = 120;  // 相邻两段重叠两分钟，免得正好跨在交界处的爆点被截断
const MIN_LAST_WINDOW: number = 300;        // 最后剩下不到 5 分钟就并进前一段

// 「自动」时，分数不低于它的才做（设置页「录播切片」里可以改）。按现在的打分标准（见 highlightGemini 的 findRequest），
// 一场 93 分钟的直播里 19 个爆点：9 分以上 2 个，8.5 分以上 6 个，8 分以上 11 个
export const AUTO_SCORE: number = 8.5;
export const AUTO_SCORE_OPTIONS: Array<number> = [8, 8.5, 9, 9.5];
const AUTO_MIN_SCORE: number = 7;           // 一个够分的都没有时，最高的那个不低于它也做一个
const AUTO_MAX: number = 8;
const AUTO_SECONDS_PER_CLIP: number = 480;  // 「自动」时平均每 8 分钟最多一个

/* "MM:SS"、"HH:MM:SS"、数字 → 秒；看不懂的返回 NaN */
export function toSeconds(value: unknown): number {
  if (typeof value === 'number') return value;

  const texts: Array<string> = String(value ?? '').trim().split(':');

  // Number('') 是 0，所以空的部分要先挡掉
  if (texts.length > 3 || texts.some((text: string): boolean => text.trim() === '')) return NaN;

  const parts: Array<number> = texts.map(Number);

  if (parts.some((n: number): boolean => !Number.isFinite(n))) return NaN;

  return parts.reduce((sum: number, n: number): number => (sum * 60) + n, 0);
}

/* 秒 → "05:43" 或 "1:05:43" */
export function clock(seconds: number): string {
  const total: number = Math.max(0, Math.round(seconds));
  const hour: number = Math.floor(total / 3_600);
  const minute: string = String(Math.floor((total % 3_600) / 60)).padStart(2, '0');
  const second: string = String(total % 60).padStart(2, '0');

  return hour > 0 ? `${ hour }:${ minute }:${ second }` : `${ minute }:${ second }`;
}

/* 弹幕文件：每行是 [00:05:43.453]昵称\t内容 */
export function parseLrc(text: string): Array<DanmuLine> {
  const list: Array<DanmuLine> = [];

  for (const line of text.split('\n')) {
    const match: RegExpExecArray | null = /^\[(\d+):(\d+):(\d+)\.(\d+)\]([^\t]*)\t(.*)$/.exec(line.trim());

    if (!match) continue;

    const message: string = match[6].trim();

    if (!message) continue;

    list.push({
      time: (Number(match[1]) * 3_600) + (Number(match[2]) * 60) + Number(match[3]) + (Number(match[4]) / 1_000),
      nickname: match[5].trim(),
      message
    });
  }

  return list.sort((a: DanmuLine, b: DanmuLine): number => a.time - b.time);
}

/* 礼物消息（「送给 SNH48-某某 1个荧光棒」）：系统发的，不是粉丝说的话 */
export function isGiftDanmu(message: string): boolean {
  return /^送给.+?\d+\s*个/.test(message);
}

/* 粉丝的反应：爆、典、串、急、绷、草、笑死、哈哈哈、一串问号… 这类弹幕扎堆的地方多半有爆点 */
const REACTION: RegExp = /爆|典|串|急了|绷|蚌埠|草|笑死|哈{3,}|h{3,}|[?？]+$|^[?？]+$|乐了|6{3,}|麻了|赢麻|好家伙|救命|啊{3,}/i;
const HEAT_BUCKET: number = 30;   // 弹幕热度按 30 秒一格数
const HEAT_MAX: number = 10;      // 最多给模型这么多个时刻

export function isReactionDanmu(message: string): boolean {
  return REACTION.test(message);
}

/**
 * 弹幕突然变多、反应扎堆的时刻（模型不擅长从几百行弹幕里数密度，程序数好了告诉它）。
 * 返回几行文字，每行一个时刻（时间是弹幕出现的时间，相对于这一段的开头）；没有明显的高峰时返回空数组
 * @param { Array<DanmuLine> } danmu - 整场的弹幕
 * @param { AudioWindow } window - 录播的哪一段
 */
export function danmuHeat(danmu: Array<DanmuLine>, window: AudioWindow): Array<string> {
  const buckets: Map<number, { count: number; reactions: Array<string> }> = new Map();

  for (const item of danmu) {
    if (item.time < window.start || item.time >= window.start + window.length || isGiftDanmu(item.message)) continue;

    const key: number = Math.floor((item.time - window.start) / HEAT_BUCKET);
    const bucket: { count: number; reactions: Array<string> } = buckets.get(key) ?? { count: 0, reactions: [] };

    bucket.count++;
    isReactionDanmu(item.message) && bucket.reactions.push(item.message.slice(0, 8));
    buckets.set(key, bucket);
  }

  // 平时一格有多少条：所有格子（没有弹幕的也算）的中位数
  const total: number = Math.max(1, Math.ceil(window.length / HEAT_BUCKET));
  const counts: Array<number> = Array.from({ length: total }, (item: unknown, key: number): number => buckets.get(key)?.count ?? 0)
    .sort((a: number, b: number): number => a - b);
  const usual: number = counts[Math.floor(total / 2)];
  const hot: Array<[number, { count: number; reactions: Array<string> }]> = Array.from(buckets.entries())
    .filter(([, bucket]: [number, { count: number; reactions: Array<string> }]): boolean => (
      bucket.count >= Math.max(6, usual * 1.8) || bucket.reactions.length >= 4))
    .sort((a: [number, { count: number; reactions: Array<string> }], b: [number, { count: number; reactions: Array<string> }]): number => (
      (b[1].count + (b[1].reactions.length * 3)) - (a[1].count + (a[1].reactions.length * 3))))
    .slice(0, HEAT_MAX)
    .sort((a: [number, unknown], b: [number, unknown]): number => a[0] - b[0]);

  return hot.map(([key, bucket]: [number, { count: number; reactions: Array<string> }]): string => {
    const samples: Array<string> = Array.from(new Set(bucket.reactions)).slice(0, 3);

    return `${ clock(key * HEAT_BUCKET) } 起的 ${ HEAT_BUCKET } 秒：${ bucket.count } 条弹幕（平时约 ${ usual } 条）${
      bucket.reactions.length > 0 ? `，其中反应 ${ bucket.reactions.length } 条，例如「${ samples.join('」「') }」` : '' }`;
  });
}

// 走本机的 agy 时切短一点、重叠多一点：实测同一个半小时，整段给它时它说的时间中位数差 52 秒、找到 5 个爆点，
// 切成 15 分钟一段是差 16 秒、找到 9 个（最大误差仍有一两分钟，所以还是要按原话定位）。agy 用的是订阅额度，重叠多不多花钱
export const AGY_WINDOW_LENGTH: number = 1_200;
export const AGY_WINDOW_OVERLAP: number = 300;

/**
 * 把整场录播分成一段一段（相邻两段重叠一点）
 * @param { number } duration - 录播的长度（秒）
 * @param { number } [length] - 每段多长，默认半小时
 * @param { number } [shared] - 相邻两段重叠多少，默认两分钟
 */
export function planWindows(duration: number, length: number = WINDOW_LENGTH, shared: number = WINDOW_OVERLAP): Array<AudioWindow> {
  const windows: Array<AudioWindow> = [];
  const step: number = length - shared;
  let start: number = 0;

  while (start < duration) {
    const rest: number = duration - start;

    if (rest <= length + MIN_LAST_WINDOW) {
      windows.push({ start, length: rest });
      break;
    }

    windows.push({ start, length });
    start += step;
  }

  return windows;
}

function overlap(a: Highlight, b: Highlight): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * 合并各段找到的爆点：按分数从高到低排（同分的长的在前），和已经选中的重叠一半以上的不要
 * （相邻两段重叠的那两分钟里，同一个爆点会被找到两次）
 */
export function mergeHighlights(list: Array<Highlight>): Array<Highlight> {
  const sorted: Array<Highlight> = list
    .filter((item: Highlight): boolean => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a: Highlight, b: Highlight): number => (b.score - a.score) || ((b.end - b.start) - (a.end - a.start)));
  const picked: Array<Highlight> = [];

  for (const item of sorted) {
    const length: number = item.end - item.start;
    const repeated: boolean = picked.some((other: Highlight): boolean => {
      const shared: number = overlap(item, other);

      return shared > Math.min(length, other.end - other.start) * 0.5;
    });

    if (!repeated) picked.push(item);
  }

  return picked;
}

/**
 * 要做几个切片
 * @param { Array<Highlight> } sorted - 已经按分数排好的爆点
 * @param { HighlightCount } count - 用户选的数量，或者 'auto'
 * @param { number } duration - 录播的长度（秒）
 * @param { number } [autoScore] - 「自动」时的门槛
 */
export function targetCount(sorted: Array<Highlight>, count: HighlightCount, duration: number, autoScore: number = AUTO_SCORE): number {
  if (count !== 'auto') return Math.max(0, Math.min(sorted.length, Math.floor(count)));

  const limit: number = Math.max(1, Math.min(AUTO_MAX, Math.ceil(duration / AUTO_SECONDS_PER_CLIP)));
  const good: number = sorted.filter((item: Highlight): boolean => item.score >= autoScore).length;

  if (good > 0) return Math.min(good, limit);

  return sorted.length > 0 && sorted[0].score >= AUTO_MIN_SCORE ? 1 : 0;
}

/* 成员的名字，不带队伍：SNH48 沈馨、SNH48-沈馨 → 沈馨 */
export function shortName(member: string): string {
  return member.trim().split(/[\s-]+/).pop() ?? '';
}

/**
 * 发布时用的标题：【沈馨】忘切小号用大号自吹好萌 | 20261115 直播切片
 * @param { string } member - 成员名字，可以带队伍（SNH48 沈馨、SNH48-沈馨），只取最后的名字
 * @param { string } date - 直播日期，里面的数字连起来用（2026.11.15 → 20261115）
 * @param { string } title - 模型取的短标题
 * @param { Array<string> } [people] - 这个片段里的其他主角（连麦的人、被认真讨论的成员），写在主播后面：【沈馨&徐佳琳】
 * @param { Array<string> } [more] - 片段里另外的爆点的短标题，接在主标题后面：【徐佳琳】全队全是萝莉但你是奶奶 | 傻瓜也是瓜 | 20261121 直播切片
 */
export function postTitle(member: string, date: string, title: string, people: Array<string> = [], more: Array<string> = []): string {
  const names: Array<string> = [shortName(member), ...people].filter((name: string): boolean => name !== '');
  const day: string = date.replace(/\D/g, '');
  const titles: Array<string> = [title, ...more].map((item: string): string => item.trim()).filter((item: string): boolean => item !== '');

  return `${ names.length > 0 ? `【${ names.join('&') }】` : '' }${ titles.join(' | ') } | ${ day ? `${ day } ` : '' }直播切片`;
}

const MAX_PEOPLE: number = 3;

/**
 * 模型给的「其他主角」整理一下：去掉队伍名、空的、重复的、主播自己，最多留 3 个
 * @param { unknown } list - 模型返回的名字
 * @param { string } member - 主播
 */
export function cleanPeople(list: unknown, member: string): Array<string> {
  const host: string = shortName(member);
  const names: Array<string> = (Array.isArray(list) ? list : [])
    .map((item: unknown): string => shortName(String(item ?? '').replace(/[【】「」《》&|]/g, ' ')))
    .filter((name: string): boolean => name !== '' && name !== host && Array.from(name).length <= 12);

  return Array.from(new Set(names)).slice(0, MAX_PEOPLE);
}

/* 用在文件名里的文字：去掉 Windows 不允许的字符和结尾的点、空格，太长就截断 */
export function safeFileName(text: string, maxLength: number = 40): string {
  const cleaned: string = text.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');

  return Array.from(cleaned).slice(0, maxLength).join('').trim() || '未命名';
}
