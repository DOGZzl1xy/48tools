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

/* 把整场录播分成半小时一段（相邻两段重叠一点） */
export function planWindows(duration: number): Array<AudioWindow> {
  const windows: Array<AudioWindow> = [];
  const step: number = WINDOW_LENGTH - WINDOW_OVERLAP;
  let start: number = 0;

  while (start < duration) {
    const rest: number = duration - start;

    if (rest <= WINDOW_LENGTH + MIN_LAST_WINDOW) {
      windows.push({ start, length: rest });
      break;
    }

    windows.push({ start, length: WINDOW_LENGTH });
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
 */
export function postTitle(member: string, date: string, title: string, people: Array<string> = []): string {
  const names: Array<string> = [shortName(member), ...people].filter((name: string): boolean => name !== '');
  const day: string = date.replace(/\D/g, '');

  return `${ names.length > 0 ? `【${ names.join('&') }】` : '' }${ title.trim() } | ${ day ? `${ day } ` : '' }直播切片`;
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
