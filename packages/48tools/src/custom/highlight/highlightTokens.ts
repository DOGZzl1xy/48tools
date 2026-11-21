import type { CaptionLine } from './highlightTypes';

/**
 * 录播自动切片的「本地打轴」：装了本地识别模型（见 ./alignerPlugin）时，用它识别出来的每个字的时间给字幕定时间。
 * 文字还是用 Gemini 的（人名、梗、断句更好），本地模型只提供时间：
 *   1. parseRecognizerOutput：读识别程序打印的结果（每个字和它开始的时间，精度约 0.06 秒）
 *   2. timeLinesByTokens：把 Gemini 的整段文字和本地识别的整段文字逐字对齐（编辑距离，容许错字、多字、少字），
 *      相同的字就有了时间；每句话的开始、结束从这句里第一个、最后一个相同的字的时间推出来
 * 一句话里对上的字太少（唱歌、背景音乐、本地模型没听出来）时，这一句保持传进来的时间
 * （传进来的是 ./highlightAlign 用停顿和音节对过的时间）。整体对上的字太少时全部不动。
 * 都是纯计算，方便测试。接入点：./highlightPipeline 的 makeClip。
 */
export interface TimedToken {
  text: string;
  time: number; // 这个字开始的时间（秒）
}

export interface TokenTiming {
  lines: Array<CaptionLine>;
  matched: number; // Gemini 的文字里有多少个字和本地识别的一样
  total: number;   // Gemini 的文字一共多少个字
  used: boolean;   // 有没有用本地识别的时间（对上的字太少时不用）
}

const CHAR_SECONDS: number = 0.18;  // 一个字大约说多久（给没对上的字估时间用）
const LEAD: number = 0;             // 识别给的时间本来就比听得到声音早 0.1 秒左右，字幕不用再提前
const TAIL: number = 0.3;           // 最后一个字开始之后，这句话还要显示多久
const JOIN_GAP: number = 0.6;       // 两句之间空得比这短，就让前一句一直显示到后一句出来
const MIN_TOTAL_RATIO: number = 0.35; // 整体至少要对上这么多字才用本地识别的时间
const MIN_LINE_RATIO: number = 0.4;   // 一句话至少要对上这么多字才用它的时间
const RUN_RATIO: number = 0.6;        // 相同的字太少时，至少这么多字要对到一串连在一起的字上（见 substitutedRun）
const RUN_RATIO_BLIND: number = 0.85; // 一个相同的字都没有时要求更高
const RUN_SECONDS_PER_CHAR: number = 0.6;
const EDIT: number = 2;               // 对齐时错一个字、多一个字、少一个字的代价
const PAUSE_SECONDS: number = 1;      // 识别出来的相邻两个字隔了这么久，算中间有停顿
const FAR: number = 0x3fffffff;       // 对齐时表示「走不到」

/* 只留字母、数字、汉字，字母变小写 */
const DIGITS: string = '零一二三四五六七八九';

/* 字幕里写成阿拉伯数字的，本地模型听出来的是汉字（12 月 → 十二月），比对前换成汉字：两位数按「十二」「二十」读，更长的一位一位读（2026 → 二零二六） */
export function digitsToChinese(text: string): string {
  return text.replace(/\d+/g, (number: string): string => {
    const value: number = Number(number);

    if (number.length === 2 && value >= 10) {
      return `${ value >= 20 ? DIGITS[Math.floor(value / 10)] : '' }十${ value % 10 === 0 ? '' : DIGITS[value % 10] }`;
    }

    return Array.from(number, (digit: string): string => DIGITS[Number(digit)]).join('');
  });
}

function normalize(text: string): Array<string> {
  return Array.from(digitsToChinese(text).toLowerCase()).filter((ch: string): boolean => /[\p{L}\p{N}]/u.test(ch));
}

/**
 * 读识别程序（sherpa-onnx-offline）打印的结果：每个音频文件一行 JSON，里面 tokens 是字、timestamps 是每个字开始的时间。
 * 返回每个文件的结果（一次给它好几个文件时按给的顺序）
 * @param { string } stdout
 */
export function parseRecognizerFiles(stdout: string): Array<Array<TimedToken>> {
  const files: Array<Array<TimedToken>> = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;

    let data: { tokens?: unknown; timestamps?: unknown };

    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }

    if (!Array.isArray(data.tokens) || !Array.isArray(data.timestamps)) continue;

    const tokens: Array<TimedToken> = [];

    data.tokens.forEach((text: unknown, index: number): void => {
      const time: number = Number((data.timestamps as Array<unknown>)[index]);

      if (typeof text === 'string' && Number.isFinite(time)) tokens.push({ text, time });
    });
    files.push(tokens);
  }

  return files;
}

/* 只有一个音频文件时的结果 */
export function parseRecognizerOutput(stdout: string): Array<TimedToken> {
  return parseRecognizerFiles(stdout).flat();
}

/**
 * 两串字逐个对齐（编辑距离）：返回 a 里每个字对上了 b 里的第几个（-1 是没对上），以及是不是同一个字。
 * 她经常把一个词说两遍（「给我点，给我点费大厨了」），这时有好几种对法代价一样。给了 hint 的话用它来挑：
 * 同一句话里相邻的两个字，尽量不对到中间隔了一秒以上的两个字上（一句话中间一般不会停那么久；这一条算半个错字，只在别的都一样时起作用）
 * @param { Array<string> } a - 字幕的字
 * @param { Array<string> } b - 识别出来的字
 * @param { { group: Array<number>; time: Array<number> } } [hint] - group：a 里每个字属于第几句；time：b 里每个字的时间
 */
export function alignChars(
  a: Array<string>, b: Array<string>, hint?: { group: Array<number>; time: Array<number> }
): Array<{ index: number; same: boolean }> {
  const rows: number = a.length + 1;
  const cols: number = b.length + 1;
  const size: number = rows * cols;
  // 三种状态分开记：0 这一步是「对上」（相同或错字），1 是字幕多一个字，2 是识别多一个字。
  // 分开记是因为「跨过停顿」只在连续两步都是「对上」时才算
  const cost: Array<Uint32Array> = [new Uint32Array(size).fill(FAR), new Uint32Array(size).fill(FAR), new Uint32Array(size).fill(FAR)];
  const from: Array<Uint8Array> = [new Uint8Array(size), new Uint8Array(size), new Uint8Array(size)]; // 上一步是哪种状态

  cost[0][0] = 0;

  for (let i: number = 1; i < rows; i++) {
    cost[1][i * cols] = i * EDIT;
    from[1][i * cols] = i === 1 ? 0 : 1;
  }

  for (let j: number = 1; j < cols; j++) {
    cost[2][j] = j * EDIT;
    from[2][j] = j === 1 ? 0 : 2;
  }

  for (let i: number = 1; i < rows; i++) {
    for (let j: number = 1; j < cols; j++) {
      const at: number = (i * cols) + j;
      const acrossPause: boolean = hint !== undefined && i >= 2 && j >= 2
        && hint.group[i - 1] === hint.group[i - 2] && hint.time[j - 1] - hint.time[j - 2] > PAUSE_SECONDS;
      const change: number = a[i - 1] === b[j - 1] ? 0 : EDIT;

      for (let state: number = 0; state < 3; state++) {
        // 走到这一格之前在哪一格
        const prev: number = state === 0 ? at - cols - 1 : (state === 1 ? at - cols : at - 1);
        let best: number = FAR;
        let bestFrom: number = 0;

        for (let before: number = 0; before < 3; before++) {
          const base: number = cost[before][prev];

          if (base >= FAR) continue;

          const total: number = base + (state === 0 ? change + (before === 0 && acrossPause ? 1 : 0) : EDIT);

          if (total < best) {
            best = total;
            bestFrom = before;
          }
        }

        cost[state][at] = best;
        from[state][at] = bestFrom;
      }
    }
  }

  const result: Array<{ index: number; same: boolean }> = a.map((): { index: number; same: boolean } => ({ index: -1, same: false }));
  let row: number = a.length;
  let col: number = b.length;
  let last: number = 0;

  for (let candidate: number = 1; candidate < 3; candidate++) {
    if (cost[candidate][(row * cols) + col] < cost[last][(row * cols) + col]) last = candidate;
  }

  while (row > 0 || col > 0) {
    const before: number = from[last][(row * cols) + col];

    if (last === 0) {
      result[row - 1] = { index: col - 1, same: a[row - 1] === b[col - 1] };
      row--;
      col--;
    } else if (last === 1) {
      row--;
    } else {
      col--;
    }

    last = before;
  }

  return result;
}

/**
 * 一句相同的字太少的话：如果它大部分字都对到了识别结果里连在一起、长短差不多的一串字上（错字也算），返回那串字的时间。
 * 字幕里这句话前后的句子都对上了时，夹在中间没人认领的那串字就是这句话（人名、梗、英文最容易被本地模型听错）
 * @param { Array<{ index: number; same: boolean }> } own - 这句话每个字对到了识别结果的第几个字
 * @param { Array<{ time: number }> } heard - 识别结果（每个字一项）
 * @param { number } count - 这句话有几个字
 * @param { number } same - 其中完全相同的有几个
 */
export function substitutedRun(
  own: Array<{ index: number; same: boolean }>, heard: Array<{ time: number }>, count: number, same: number
): { start: number; end: number } | null {
  const indexes: Array<number> = own.filter((pair: { index: number }): boolean => pair.index >= 0).map((pair: { index: number }): number => pair.index);

  // 对上（相同或错字）的字要占这句话的大部分；一个相同的字都没有时要求更高
  if (indexes.length < Math.max(2, Math.ceil(count * (same > 0 ? RUN_RATIO : RUN_RATIO_BLIND)))) return null;

  const firstIndex: number = indexes[0];
  const lastIndex: number = indexes[indexes.length - 1];
  const start: number = heard[firstIndex].time;
  const end: number = heard[lastIndex].time;

  // 对到的那串字要连在一起（中间夹的别的字不多），说完用的时间和字数相称（不会一个字一秒以上）
  if (lastIndex - firstIndex + 1 > (indexes.length * 1.5) + 1 || end - start > (count * RUN_SECONDS_PER_CHAR) + 1) return null;

  return { start, end };
}

/**
 * 用本地识别的每个字的时间给字幕定时间
 * @param { Array<CaptionLine> } lines - 按时间排好的句子（时间是模型给的、已经用停顿和音节对过的）
 * @param { Array<TimedToken> } tokens - 本地识别的结果
 * @param { number } length - 这段音频的长度（秒）
 */
export function timeLinesByTokens(lines: Array<CaptionLine>, tokens: Array<TimedToken>, length: number): TokenTiming {
  const lineChars: Array<Array<string>> = lines.map((line: CaptionLine): Array<string> => normalize(line.text));
  const text: Array<string> = lineChars.flat();
  const heard: Array<{ ch: string; time: number }> = tokens.flatMap(
    (token: TimedToken): Array<{ ch: string; time: number }> => normalize(token.text).map((ch: string): { ch: string; time: number } => ({ ch, time: token.time })));
  const pairs: Array<{ index: number; same: boolean }> = alignChars(text, heard.map((item: { ch: string }): string => item.ch), {
    group: lineChars.flatMap((chars: Array<string>, order: number): Array<number> => chars.map((): number => order)),
    time: heard.map((item: { time: number }): number => item.time)
  });
  const matched: number = pairs.filter((pair: { same: boolean }): boolean => pair.same).length;
  const total: number = text.length;

  if (total === 0 || matched / total < MIN_TOTAL_RATIO) return { lines, matched, total, used: false };

  // 每句话：用这句里对上的第一个、最后一个字的时间推出开始和结束
  const timed: Array<CaptionLine & { anchored: boolean }> = [];
  let offset: number = 0;

  lines.forEach((line: CaptionLine, order: number): void => {
    const count: number = lineChars[order].length;
    const own: Array<{ index: number; same: boolean }> = pairs.slice(offset, offset + count);
    const same: number = own.filter((pair: { same: boolean }): boolean => pair.same).length;
    // 只认完全相同的字的时间（对成错字的那些，位置可能差一两个字）
    const first: number = own.findIndex((pair: { same: boolean }): boolean => pair.same);
    let last: number = -1;

    own.forEach((pair: { same: boolean }, position: number): void => {
      if (pair.same) last = position;
    });
    offset += count;

    if (count === 0 || first === -1 || same < Math.max(1, Math.ceil(count * MIN_LINE_RATIO))) {
      // 相同的字太少，但这句话整句对到了识别结果里连在一起的一串字上（多半是本地模型把人名、梗听错了，
      // 比如「彤馨恋BE了呀」听成「我今天闭异了呀」）：前后的句子都对上了，夹在中间的这串字就是这句话，用它的时间
      const run: { start: number; end: number } | null = count > 0 ? substitutedRun(own, heard, count, same) : null;

      if (run) {
        timed.push({ ...line, start: Math.max(0, run.start - LEAD), end: Math.min(length, Math.max(run.start + 0.2, run.end + TAIL)), anchored: true });
      } else {
        timed.push({ ...line, anchored: false });
      }

      return;
    }

    const start: number = Math.max(0, heard[own[first].index].time - (first * CHAR_SECONDS) - LEAD);
    const end: number = Math.min(length, heard[own[last].index].time + ((count - 1 - last) * CHAR_SECONDS) + TAIL);

    timed.push({ ...line, start, end: Math.max(start + 0.2, end), anchored: true });
  });

  // 没有时间依据的句子：夹在前后有依据的句子中间，不许越界
  timed.forEach((line: CaptionLine & { anchored: boolean }, order: number): void => {
    if (line.anchored) return;

    let floor: number = 0;
    let ceiling: number = length;

    for (let back: number = order - 1; back >= 0; back--) {
      if (timed[back].anchored) {
        floor = timed[back].end;
        break;
      }
    }

    for (let ahead: number = order + 1; ahead < timed.length; ahead++) {
      if (timed[ahead].anchored) {
        ceiling = timed[ahead].start;
        break;
      }
    }

    const span: number = Math.min(line.end - line.start, Math.max(0.2, ceiling - floor));

    line.start = Math.min(Math.max(line.start, floor), Math.max(floor, ceiling - span));
    line.end = line.start + span;
  });

  // 顺序不能乱、不能重叠；两句之间空得很短就连起来
  const result: Array<CaptionLine> = timed.map((line: CaptionLine & { anchored: boolean }): CaptionLine => ({
    start: line.start, end: line.end, text: line.text, keep: line.keep, emphasis: line.emphasis
  }));

  result.forEach((line: CaptionLine, order: number): void => {
    const prev: CaptionLine | undefined = result[order - 1];

    if (!prev) return;

    if (line.start < prev.start + 0.1) {
      line.start = prev.start + 0.1;
      line.end = Math.max(line.end, line.start + 0.2);
    }

    if (prev.end > line.start || line.start - prev.end < JOIN_GAP) prev.end = line.start;
  });

  return { lines: result, matched, total, used: true };
}
