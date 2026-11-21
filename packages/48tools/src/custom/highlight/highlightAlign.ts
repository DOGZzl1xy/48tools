import type { CaptionLine, Silence } from './highlightTypes';

/**
 * 录播自动切片里把字幕的时间对回声音上。
 * 模型给每句话标的时间不稳定：一般差零点几秒，偶尔整段早一两秒（字幕出来了人还没开口，后面一直早一句）。
 * 声音本身是准的，所以用它来校正，模型给的时间只用来判断「这句话大概在哪」：
 *   1. 声音按停顿分成一段一段（stretchesOf）
 *   2. 先看整体挪多少能让这些句子落在有声音的地方最多（bestOffset，-3 ~ +3 秒）
 *   3. 每句话归到一段声音里，顺序不变：离模型给的时间近，而且这一段装得下这些字（assignLines）
 *   4. 同一段里的几句话，按字数分这一段里的音节：第一句从这段声音开始的地方开始，最后一句到它结束的地方结束（placeLines）
 * 音节的位置从音量的起伏里找（syllablePeaks），不需要识别内容。
 * 都是纯计算，方便测试。接入点：./highlightPipeline 的 makeClip。
 */
export interface Stretch {
  start: number;
  end: number;
}

const ENVELOPE_RATE: number = 100;   // 音量包络每秒 100 个值
const MIN_STRETCH: number = 0.15;    // 比这还短的声音不算一段
const MAX_MOVE: number = 6;          // 一句话最多挪这么远，再远说明对不上，宁可不动
const TOO_FAR: number = 1e6;
const MAX_OFFSET: number = 3;        // 整体最多挪 3 秒
const MIN_RATE: number = 2.5;        // 语速（字 / 秒）的合理范围
const MAX_RATE: number = 8;
const DEFAULT_RATE: number = 4.5;

/**
 * 音量包络：每 10 毫秒一个值（这 10 毫秒里的均方根）
 * @param { Int16Array } samples - 单声道的采样
 * @param { number } rate - 采样率
 */
export function envelopeOf(samples: Int16Array, rate: number): Array<number> {
  const step: number = Math.round(rate / ENVELOPE_RATE);
  const envelope: Array<number> = [];

  for (let at: number = 0; at + step <= samples.length; at += step) {
    let sum: number = 0;

    for (let index: number = 0; index < step; index++) sum += samples[at + index] ** 2;

    envelope.push(Math.sqrt(sum / step));
  }

  return envelope;
}

/**
 * 音节的位置（秒）：平滑后的音量里明显的峰。每个字大致一个峰，数得不全（大约七八成），但和字数成比例，够用来分配时间
 * @param { Array<number> } envelope - envelopeOf 的结果
 */
export function syllablePeaks(envelope: Array<number>): Array<number> {
  const smooth: Array<number> = envelope.map((value: number, index: number): number => {
    let sum: number = 0;
    let count: number = 0;

    for (let offset: number = -3; offset <= 3; offset++) {
      const near: number | undefined = envelope[index + offset];

      if (near !== undefined) {
        sum += near;
        count++;
      }
    }

    return sum / count;
  });
  // 「响」的标准：最响的 5% 里最小的那个
  const loud: number = [...smooth].sort((a: number, b: number): number => b - a)[Math.floor(smooth.length * 0.05)] ?? 0;
  const peaks: Array<number> = [];

  for (let index: number = 2; index < smooth.length - 2; index++) {
    const value: number = smooth[index];
    const isPeak: boolean = value > smooth[index - 1] && value >= smooth[index + 1] && value > loud * 0.12;

    if (!isPeak) continue;

    // 比前面 0.12 秒里最低的地方高出三成多才算一个新的音节，两个峰至少隔 0.1 秒
    let dip: number = Infinity;

    for (let back: number = Math.max(0, index - 12); back < index; back++) dip = Math.min(dip, smooth[back]);

    const time: number = index / ENVELOPE_RATE;

    if (value > dip * 1.35 && (peaks.length === 0 || time - peaks[peaks.length - 1] > 0.1)) peaks.push(time);
  }

  return peaks;
}

/* 一句话里有几个字（标点、空格不算） */
export function countChars(text: string): number {
  return Array.from(text).filter((ch: string): boolean => /[\p{L}\p{N}]/u.test(ch)).length;
}

/* 有声音的段落：两段停顿之间 */
export function stretchesOf(silences: Array<Silence>, length: number): Array<Stretch> {
  const stretches: Array<Stretch> = [];
  let at: number = 0;

  for (const silence of [...silences, { start: length, end: length }]) {
    if (silence.start - at >= MIN_STRETCH) stretches.push({ start: at, end: Math.min(length, silence.start) });

    at = Math.max(at, silence.end);
  }

  return stretches;
}

/* 整体挪多少（-3 ~ +3 秒）能让这些句子落在有声音的地方最多；差不多的时候选挪得少的 */
export function bestOffset(lines: Array<CaptionLine>, stretches: Array<Stretch>): number {
  let best: number = 0;
  let bestScore: number = -Infinity;

  for (let step: number = -MAX_OFFSET * 10; step <= MAX_OFFSET * 10; step++) {
    const offset: number = step / 10;
    let covered: number = 0;

    for (const line of lines) {
      for (const stretch of stretches) {
        covered += Math.max(0, Math.min(line.end + offset, stretch.end) - Math.max(line.start + offset, stretch.start));
      }
    }

    const score: number = covered - (Math.abs(offset) * 0.05);

    if (score > bestScore) {
      best = offset;
      bestScore = score;
    }
  }

  return best;
}

/**
 * 每句话归到哪一段声音里（返回每句对应的段落下标；顺序不能乱，一段可以放好几句，也可以空着）。
 * 代价：句子的中点离那一段有多远，加上这一段装不下这些字时超出的时间。对不上（有句子要挪 6 秒以上）时返回 null
 * @param { Array<CaptionLine> } lines - 按时间排好的句子
 * @param { Array<Stretch> } stretches
 * @param { number } rate - 语速（字 / 秒）
 */
export function assignLines(lines: Array<CaptionLine>, stretches: Array<Stretch>, rate: number): Array<number> | null {
  const lineCount: number = lines.length;
  const stretchCount: number = stretches.length;

  if (lineCount === 0 || stretchCount === 0) return null;

  // 前 i 句一共多少字；第 k 段里前 i 句要挪的距离之和
  const charsBefore: Array<number> = [0];

  for (const line of lines) charsBefore.push(charsBefore[charsBefore.length - 1] + countChars(line.text));

  const movedBefore: Array<Array<number>> = stretches.map((stretch: Stretch): Array<number> => {
    const sums: Array<number> = [0];

    for (const line of lines) {
      const middle: number = (line.start + line.end) / 2;
      const distance: number = middle < stretch.start ? stretch.start - middle : (middle > stretch.end ? middle - stretch.end : 0);

      sums.push(sums[sums.length - 1] + (distance > MAX_MOVE ? TOO_FAR : distance));
    }

    return sums;
  });
  // cost[i][k]：前 i 句已经放好，最后一批放在第 k 段；reach[i][k]：最后一批放在第 k 段或它前面
  const cost: Array<Array<number>> = Array.from({ length: lineCount + 1 }, (): Array<number> => new Array(stretchCount).fill(Infinity));
  const reach: Array<Array<number>> = Array.from({ length: lineCount + 1 }, (): Array<number> => new Array(stretchCount).fill(Infinity));
  const from: Array<Array<number>> = Array.from({ length: lineCount + 1 }, (): Array<number> => new Array(stretchCount).fill(-1));

  for (let i: number = 1; i <= lineCount; i++) {
    for (let k: number = 0; k < stretchCount; k++) {
      const room: number = stretches[k].end - stretches[k].start;

      // 第 j ~ i-1 句放在第 k 段
      for (let j: number = 0; j < i; j++) {
        const before: number = j === 0 ? 0 : (k === 0 ? Infinity : reach[j][k - 1]);
        const moved: number = movedBefore[k][i] - movedBefore[k][j];

        if (before === Infinity || moved >= TOO_FAR) continue;

        const over: number = Math.max(0, ((charsBefore[i] - charsBefore[j]) / rate) - room - 0.5);
        const total: number = before + moved + (2 * over);

        if (total < cost[i][k]) {
          cost[i][k] = total;
          from[i][k] = j;
        }
      }

      reach[i][k] = Math.min(cost[i][k], k > 0 ? reach[i][k - 1] : Infinity);
    }
  }

  // 从最后一句往回找
  const result: Array<number> = new Array(lineCount).fill(-1);
  let rest: number = lineCount; // 还有前面多少句没定
  let limit: number = stretchCount; // 这一批只能放在它前面的段落里

  while (rest > 0) {
    let k: number = -1;

    for (let candidate: number = 0; candidate < limit; candidate++) {
      if (cost[rest][candidate] < (k === -1 ? Infinity : cost[rest][k])) k = candidate;
    }

    if (k === -1) return null;

    const j: number = from[rest][k];

    for (let index: number = j; index < rest; index++) result[index] = k;

    rest = j;
    limit = k;
  }

  return result;
}

/**
 * 按归好的段落重新定每句话的时间：同一段里的几句话，按字数分这一段里的音节
 * @param { Array<CaptionLine> } lines
 * @param { Array<Stretch> } stretches
 * @param { Array<number> } assignment - assignLines 的结果
 * @param { Array<number> } peaks - 音节的位置
 * @param { number } rate - 语速（字 / 秒）
 */
export function placeLines(
  lines: Array<CaptionLine>, stretches: Array<Stretch>, assignment: Array<number>, peaks: Array<number>, rate: number
): Array<CaptionLine> {
  const result: Array<CaptionLine> = lines.map((line: CaptionLine): CaptionLine => ({ ...line }));
  const used: Set<number> = new Set(assignment);

  stretches.forEach((stretch: Stretch, k: number): void => {
    const members: Array<number> = [];

    assignment.forEach((value: number, index: number): void => {
      value === k && members.push(index);
    });

    if (members.length === 0) return;

    const chars: Array<number> = members.map((index: number): number => Math.max(1, countChars(lines[index].text)));
    const total: number = chars.reduce((sum: number, value: number): number => sum + value, 0);
    const room: number = stretch.end - stretch.start;

    // 这一段比这些字该用的时间长得多：里面有没写成字幕的声音（笑声、别人说话），不知道话在哪。保持模型给的时间，只是不让它伸到这一段外面
    if (total / rate < room * 0.55) {
      for (const index of members) {
        const length: number = Math.min(room, lines[index].end - lines[index].start);
        const start: number = Math.min(Math.max(lines[index].start, stretch.start), stretch.end - length);

        result[index].start = start;
        result[index].end = start + length;
      }

      return;
    }

    const inside: Array<number> = peaks.filter((time: number): boolean => time >= stretch.start && time <= stretch.end);
    const before: Stretch | undefined = stretches[k - 1];
    // 前面紧挨着一小段没有归到任何句子的声音（第一个字和后面的话之间顿了一下）：从它开始
    let at: number = before && !used.has(k - 1) && before.end - before.start < 0.5 && stretch.start - before.end < 0.7
      ? before.start : stretch.start;
    let done: number = 0;

    members.forEach((index: number, order: number): void => {
      done += chars[order];

      let end: number = stretch.end;

      if (order < members.length - 1) {
        if (inside.length >= members.length * 2) {
          // 说到第几个音节：在它和下一个音节中间断开
          const position: number = Math.ceil((done / total) * inside.length);

          end = (inside[Math.max(0, position - 1)] + inside[Math.min(inside.length - 1, position)]) / 2;
        } else {
          end = stretch.start + ((done / total) * room); // 音节找得太少，按时间平分
        }
      }

      result[index].start = at;
      result[index].end = Math.max(at + 0.1, end);
      at = result[index].end;
    });
  });

  return result;
}

/**
 * 把模型给的逐句时间对回声音上。对不上时原样返回
 * @param { Array<CaptionLine> } lines - 按时间排好、互不重叠的句子（tidyLines 的结果）
 * @param { Array<Silence> } silences - 这段音频里的停顿
 * @param { Array<number> } peaks - 这段音频里音节的位置（syllablePeaks 的结果）
 * @param { number } length - 这段音频的长度（秒）
 */
export function alignLines(lines: Array<CaptionLine>, silences: Array<Silence>, peaks: Array<number>, length: number): Array<CaptionLine> {
  const stretches: Array<Stretch> = stretchesOf(silences, length);

  if (lines.length === 0 || stretches.length === 0) return lines;

  // 语速：模型给的每句话「字数 / 时长」的中位数
  const rates: Array<number> = lines
    .map((line: CaptionLine): number => countChars(line.text) / Math.max(0.3, line.end - line.start))
    .sort((a: number, b: number): number => a - b);
  const rate: number = Math.min(MAX_RATE, Math.max(MIN_RATE, rates[Math.floor(rates.length / 2)] || DEFAULT_RATE));
  const offset: number = bestOffset(lines, stretches);
  const moved: Array<CaptionLine> = lines.map((line: CaptionLine): CaptionLine => ({
    ...line,
    start: Math.max(0, line.start + offset),
    end: Math.min(length, Math.max(line.start + offset + 0.1, line.end + offset))
  }));
  const assignment: Array<number> | null = assignLines(moved, stretches, rate);

  return assignment ? placeLines(moved, stretches, assignment, peaks, rate) : lines;
}
