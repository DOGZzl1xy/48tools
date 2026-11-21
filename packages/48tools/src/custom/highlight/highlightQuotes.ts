import type { Highlight } from './highlightTypes';
import type { TimedToken } from './highlightTokens';

/**
 * 录播自动切片里「按原话找时间」：通过本机的 agy 问 Gemini 时，它说的时间不准（半小时的音频能差几十秒到几分钟），
 * 但它引的原话是对的。所以让它给出每个爆点开头、结尾和最关键的那句原话，再到本地识别的结果（每个字都有准确的时间，
 * 见 ./alignerRun）里把这几句话找出来，用找到的时间。
 *   - locateQuote：在一串带时间的字里找一句话（容许错字、多字、少字）
 *   - fixHighlightTimes：用找到的原话改正一个爆点的开始和结束；找不到就不要这个爆点
 * 都是纯计算，方便测试。接入点：./highlightPipeline 的 processHighlight（只在走 agy 时用）。
 */
export interface QuoteHit {
  start: number;  // 这句话第一个字的时间
  end: number;    // 最后一个字的时间
  score: number;  // 0 ~ 1：这句话里有多少字对上了
}

const MAX_QUOTE: number = 40;       // 原话太长就只用前（或后）这么多字找
const MIN_SCORE: number = 0.6;      // 至少对上这么多才算找到
const MIN_CHARS: number = 4;        // 比这短的话到处都是，必须一字不差
const MIN_LENGTH: number = 15;      // 爆点最短、最长多少秒
const MAX_LENGTH: number = 330;

function normalize(text: string): Array<string> {
  return Array.from(text.toLowerCase()).filter((ch: string): boolean => /[\p{L}\p{N}]/u.test(ch));
}

/**
 * 在本地识别的结果里找一句话。有好几处一样像时，取离 near 最近的
 * @param { Array<TimedToken> } tokens - 本地识别的结果（按时间排好）
 * @param { string } quote - 要找的话
 * @param { object } [options]
 * @param { number } [options.near] - 大概在什么时间（秒）
 * @param { number } [options.from] - 只在这个时间之后找
 * @param { 'head' | 'tail' } [options.part] - 话太长时用开头还是结尾的那部分找（默认开头）
 */
export function locateQuote(
  tokens: Array<TimedToken>, quote: string, options: { near?: number; from?: number; part?: 'head' | 'tail' } = {}
): QuoteHit | null {
  const all: Array<string> = normalize(quote);
  const want: Array<string> = options.part === 'tail' ? all.slice(-MAX_QUOTE) : all.slice(0, MAX_QUOTE);
  const heard: Array<{ ch: string; time: number }> = tokens
    .filter((token: TimedToken): boolean => options.from === undefined || token.time >= options.from)
    .flatMap((token: TimedToken): Array<{ ch: string; time: number }> => normalize(token.text).map((ch: string): { ch: string; time: number } => ({ ch, time: token.time })));
  const rows: number = want.length + 1;
  const cols: number = heard.length + 1;

  if (want.length === 0 || heard.length === 0) return null;

  // 这句话要整句对上，识别结果里从哪开始、到哪结束都可以（开头一行全是 0，最后一行取最小的）
  const cost: Uint16Array = new Uint16Array(rows * cols);

  for (let i: number = 1; i < rows; i++) {
    cost[i * cols] = i;

    for (let j: number = 1; j < cols; j++) {
      const at: number = (i * cols) + j;

      cost[at] = Math.min(cost[at - cols - 1] + (want[i - 1] === heard[j - 1].ch ? 0 : 1), cost[at - cols] + 1, cost[at - 1] + 1);
    }
  }

  // 最后一行里代价最小的结束位置；一样小的取离 near 最近的
  const last: number = (rows - 1) * cols;
  let endAt: number = -1;

  for (let j: number = 1; j < cols; j++) {
    const better: boolean = endAt === -1 || cost[last + j] < cost[last + endAt]
      || (cost[last + j] === cost[last + endAt] && options.near !== undefined
        && Math.abs(heard[j - 1].time - options.near) < Math.abs(heard[endAt - 1].time - options.near));

    if (better) endAt = j;
  }

  const score: number = 1 - (cost[last + endAt] / want.length);

  if (score < (want.length < MIN_CHARS ? 1 : MIN_SCORE)) return null;

  // 往回走，找到这句话是从识别结果的第几个字开始的
  let row: number = rows - 1;
  let col: number = endAt;

  while (row > 0 && col > 0) {
    const at: number = (row * cols) + col;

    if (cost[at] === cost[at - cols - 1] + (want[row - 1] === heard[col - 1].ch ? 0 : 1)) {
      row--;
      col--;
    } else if (cost[at] === cost[at - cols] + 1) {
      row--;
    } else {
      col--;
    }
  }

  return { start: heard[Math.min(col, endAt - 1)].time, end: heard[endAt - 1].time, score };
}

/**
 * 用找到的原话改正一个爆点的时间。找不到任何一句原话时返回 null（位置不可信，不要这个爆点）
 * @param { Highlight } highlight - 模型给的爆点：start、end 是它说的时间（不准），first、last、quote 是开头、结尾、最关键的原话
 * @param { Array<TimedToken> } tokens - 这一段录播的本地识别结果，时间和 highlight 用同一个起点
 */
export function fixHighlightTimes(highlight: Highlight, tokens: Array<TimedToken>): Highlight | null {
  const length: number = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, highlight.end - highlight.start));
  const quote: QuoteHit | null = highlight.quote ? locateQuote(tokens, highlight.quote, { near: highlight.start + (length / 2) }) : null;
  // 开头那句：先在关键句附近找（同一句话可能在别处也说过）
  const first: QuoteHit | null = highlight.first ? locateQuote(tokens, highlight.first, { near: quote ? quote.start : highlight.start }) : null;
  let start: number | null = first ? first.start : (quote ? quote.start - Math.min(60, length * 0.6) : null);

  if (start === null) return null;

  // 开头那句找到的地方离关键句太远（超过最长的片段）：多半找错了，按关键句来
  if (first && quote && (quote.start < first.start || quote.start - first.start > MAX_LENGTH)) start = quote.start - Math.min(60, length * 0.6);

  start = Math.max(0, start);

  const lastHit: QuoteHit | null = highlight.last
    ? locateQuote(tokens, highlight.last, { near: start + length, from: Math.max(start, quote ? quote.start : start), part: 'tail' })
    : null;
  let end: number = lastHit && lastHit.end - start <= MAX_LENGTH ? lastHit.end + 1 : (quote ? quote.end + Math.min(40, length * 0.4) : start + length);

  // 关键句一定要在片段里面
  if (quote && end < quote.end + 1) end = quote.end + 1;

  end = Math.min(start + MAX_LENGTH, Math.max(end, start + MIN_LENGTH));

  return { ...highlight, start, end };
}
