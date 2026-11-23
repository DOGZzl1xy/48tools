import { promises as fsP } from 'node:fs';
import { runFfmpeg } from './highlightFfmpeg';
import { clock, isGiftDanmu, isReactionDanmu } from './highlightTime';
import type { DanmuLine, Highlight } from './highlightTypes';

/**
 * 公演切片里失误（mistake）和唱歌（song）的起止。不按原话定位：唱歌、舞台上很吵的时候本机识别不准，
 * 同一句歌词还可能唱两遍（2026-11-22 NII 的开场歌被掐断重跳，按歌词定位对到了重唱的那一遍，失误本身没切进去）。
 * 和 Gemini 商量后改成：
 *   - 失误按粉丝的反应定：弹幕先去重（名字应援、抽奖口令这类复读，同样的话 30 秒里最多算 2 条；「哈哈」「咋了」这类反应不去重），
 *     按 1 秒一步数 10 秒里有多少条。在模型给的时间附近找最高的地方，和周围几分钟比明显高出来才算；
 *     从高峰往回找到弹幕开始涨的地方，再往前留 20 秒（弹幕比舞台晚 5 ~ 15 秒）；往后找到弹幕回落的地方，多留几秒。
 *     模型抄来的「代表性弹幕的时间」（reaction）是从弹幕文字里抄的，比它听音频报的时间准，有的话以它为中心找。
 *   - 唱歌按伴奏定：鼓和贝斯的低频（40 ~ 150Hz）唱歌时一直很强，说话、尖叫、掌声时很弱（实测 60 dB 对 3 ~ 20 dB），
 *     一首歌就是低频里连续的一整块。取和模型给的时间重叠一半以上的那几块，从第一块的开头到最后一块的结尾。
 *   - 两种都找不到明显的结果时，用模型给的时间，前后多留一些。
 * 接入点：./highlightPipeline 找爆点那一步（找到以后、存缓存之前）。
 */
export interface StageTiming {
  start: number;
  end: number;
  how: string; // 时间是怎么来的（写进切片说明）
}

const SAME_TEXT_SECONDS: number = 30;
const SAME_TEXT_MAX: number = 2;
const SURPRISE: RegExp = /咋了|怎么了|啥意思|什么意思|什么情况|何意味|重开|重来|重跳|控台|停了|断了|没声|人呢|没上|失误|事故|放错|[?？]{2,}/;
const SMOOTH_SECONDS: number = 10;     // 数多少秒里的弹幕
const SEARCH_NEAR_REACTION: number = 45;
const BASELINE_SECONDS: number = 300;  // 和前后几分钟比
const MIN_BASELINE_SAMPLES: number = 30;
const LEAD_SECONDS: number = 19;       // 弹幕开始涨之前留多久（切片时还会再多留 1 秒）
const TAIL_SECONDS: number = 6;
const QUIET_SECONDS: number = 10;      // 弹幕回落以后要连续这么久都不高，才算这件事过去了
const MISTAKE_MAX: number = 150;

export const LOW_BAND_STEP: number = 0.5; // 低频能量多少秒一格
const MUSIC_GAP: number = 1.5;        // 一首歌里短暂的停顿（不超过这么久）不算断开
const MUSIC_MIN: number = 20;         // 比这短的一块不算一首歌
const MUSIC_CONTRAST: number = 20;    // 唱歌和不唱歌的低频至少要差这么多 dB，才认为听得出伴奏

/* 弹幕的文字去掉空格、标点、表情，用来判断是不是同一句话 */
function sameTextKey(message: string): string {
  return message.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/**
 * 每一秒有多少条弹幕（去掉礼物；复读的同一句话 30 秒里最多算 2 条，反应类的不去重）
 * @param { Array<DanmuLine> } danmu - 整场的弹幕
 * @param { number } from - 从第几秒
 * @param { number } to - 到第几秒（不含）
 */
export function reactionCounts(danmu: Array<DanmuLine>, from: number, to: number): Array<number> {
  const counts: Array<number> = new Array(Math.max(0, Math.ceil(to - from))).fill(0);
  const seen: Map<string, Array<number>> = new Map();
  const sorted: Array<DanmuLine> = danmu
    .filter((item: DanmuLine): boolean => item.time >= from && item.time < to && !isGiftDanmu(item.message))
    .sort((a: DanmuLine, b: DanmuLine): number => a.time - b.time);

  for (const item of sorted) {
    const key: string = sameTextKey(item.message);
    const reaction: boolean = isReactionDanmu(item.message) || SURPRISE.test(item.message);

    if (!reaction && key !== '') {
      const recent: Array<number> = (seen.get(key) ?? []).filter((time: number): boolean => item.time - time < SAME_TEXT_SECONDS);

      if (recent.length >= SAME_TEXT_MAX) {
        seen.set(key, recent);
        continue;
      }

      seen.set(key, [...recent, item.time]);
    }

    counts[Math.floor(item.time - from)]++;
  }

  return counts;
}

function median(values: Array<number>): number {
  const sorted: Array<number> = [...values].sort((a: number, b: number): number => a - b);

  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
}

/* 模型给的时间，前后多留一些（找不到更准的时间时用） */
function modelTiming(highlight: Highlight, duration: number, before: number, after: number, why: string): StageTiming {
  return {
    start: Math.max(0, highlight.start - before),
    end: Math.min(duration, highlight.end + after),
    how: `${ why }，用模型给的时间（${ clock(highlight.start) } ~ ${ clock(highlight.end) }）`
  };
}

/**
 * 失误的起止：按弹幕的反应
 * @param { Highlight } highlight - 模型给的（reaction 是它抄的代表性弹幕的时间，可能没有）
 * @param { Array<DanmuLine> } danmu - 整场的弹幕，时间是在录像里的秒数
 * @param { number } duration - 录像多长
 */
export function locateMistake(highlight: Highlight, danmu: Array<DanmuLine>, duration: number): StageTiming {
  const reaction: number | undefined = highlight.reaction !== undefined && Number.isFinite(highlight.reaction) ? highlight.reaction : undefined;
  const searchFrom: number = Math.max(0, reaction !== undefined ? reaction - SEARCH_NEAR_REACTION : highlight.start - 30);
  const searchTo: number = Math.min(duration, reaction !== undefined ? reaction + SEARCH_NEAR_REACTION : highlight.end + 60);
  const from: number = Math.max(0, Math.floor(searchFrom - BASELINE_SECONDS));
  const to: number = Math.min(Math.ceil(duration), Math.ceil(searchTo + BASELINE_SECONDS));
  const counts: Array<number> = reactionCounts(danmu, from, to);
  const half: number = SMOOTH_SECONDS / 2;
  // 第 i 秒前后 5 秒里一共多少条
  const smooth: Array<number> = counts.map((_count: number, index: number): number => counts
    .slice(Math.max(0, index - half), index + half)
    .reduce((sum: number, value: number): number => sum + value, 0));
  const usualValues: Array<number> = smooth.filter((_value: number, index: number): boolean => (
    from + index < searchFrom - 30 || from + index > searchTo + 60));
  const usual: number = median(usualValues);
  const spread: number = median(usualValues.map((value: number): number => Math.abs(value - usual)));
  let peak: number = -1;

  for (let index: number = Math.ceil(searchFrom - from); index <= Math.floor(searchTo - from) && index < smooth.length; index++) {
    if (peak < 0 || smooth[index] > smooth[peak]) peak = index;
  }

  if (peak < 0 || usualValues.length < MIN_BASELINE_SAMPLES) return modelTiming(highlight, duration, 5, 5, '弹幕太少');

  const height: number = smooth[peak];

  if (height < Math.max(8, usual * 2.2) || height < usual + (3 * 1.4826 * spread)) {
    return modelTiming(highlight, duration, 5, 5, `附近弹幕没有明显的反应（最多 ${ height } 条/10 秒，平时约 ${ usual } 条）`);
  }

  const level: number = usual + ((height - usual) * 0.3);
  let rise: number = peak;

  while (rise > 0 && smooth[rise - 1] > level) rise--;

  let fall: number = peak;
  let quiet: number = 0;

  while (fall < smooth.length - 1 && quiet < QUIET_SECONDS) {
    fall++;
    quiet = smooth[fall] > level ? 0 : quiet + 1;
  }

  fall -= quiet;

  const start: number = Math.max(0, from + rise - LEAD_SECONDS);
  const end: number = Math.min(duration, from + fall + TAIL_SECONDS, start + MISTAKE_MAX);

  return {
    start,
    end,
    how: `按弹幕的反应定的时间（${ clock(from + rise) } 开始刷、${ clock(from + fall) } 回落，最多 ${ height } 条/10 秒，平时约 ${ usual } 条；`
      + `模型给的是 ${ clock(highlight.start) } ~ ${ clock(highlight.end) }）`
  };
}

/**
 * 一段音频的低频能量（dB），LOW_BAND_STEP 秒一格
 * @param { string } ffmpeg
 * @param { string } source - 录像
 * @param { number } from - 从第几秒
 * @param { number } length - 多长
 * @param { string } pcmFile - 中间文件放在哪（读完就删）
 * @param { AbortSignal } [signal]
 */
export async function lowBandLevels(
  ffmpeg: string, source: string, from: number, length: number, pcmFile: string, signal?: AbortSignal
): Promise<Array<number>> {
  const rate: number = 8_000;

  try {
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error', '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', source,
      '-vn', '-ac', '1', '-ar', String(rate), '-af', 'highpass=f=40,lowpass=f=150,lowpass=f=150', '-f', 's16le', pcmFile
    ], { signal });

    const data: Buffer = await fsP.readFile(pcmFile);
    const samples: Int16Array = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
    const per: number = rate * LOW_BAND_STEP;
    const levels: Array<number> = [];

    for (let index: number = 0; index + per <= samples.length; index += per) {
      let sum: number = 0;

      for (let offset: number = index; offset < index + per; offset++) sum += samples[offset] * samples[offset];

      levels.push(10 * Math.log10((sum / per) + 1));
    }

    return levels;
  } finally {
    await fsP.rm(pcmFile, { force: true });
  }
}

/**
 * 低频里连续很强的几块（秒，相对于 levels 的开头）；听不出伴奏（强弱差得不够多）时返回空数组
 * @param { Array<number> } levels - lowBandLevels 的结果
 */
export function musicRuns(levels: Array<number>): Array<{ start: number; end: number }> {
  const sorted: Array<number> = [...levels].sort((a: number, b: number): number => a - b);
  const loud: number = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const quiet: number = sorted[Math.floor(sorted.length * 0.1)] ?? 0;

  if (levels.length === 0 || loud - quiet < MUSIC_CONTRAST) return [];

  const threshold: number = (loud + quiet) / 2;
  const runs: Array<{ start: number; end: number }> = [];

  levels.forEach((level: number, index: number): void => {
    if (level < threshold) return;

    const time: number = index * LOW_BAND_STEP;
    const last: { start: number; end: number } | undefined = runs.at(-1);

    if (last && time - last.end <= MUSIC_GAP) {
      last.end = time + LOW_BAND_STEP;
    } else {
      runs.push({ start: time, end: time + LOW_BAND_STEP });
    }
  });

  return runs.filter((run: { start: number; end: number }): boolean => run.end - run.start >= MUSIC_MIN);
}

/**
 * 一首歌的起止：按伴奏
 * @param { Highlight } highlight - 模型给的
 * @param { Array<number> } levels - 从 from 开始的低频能量
 * @param { number } from - levels 从录像的第几秒开始
 * @param { number } duration - 录像多长
 */
export function locateSong(highlight: Highlight, levels: Array<number>, from: number, duration: number): StageTiming {
  const runs: Array<{ start: number; end: number }> = musicRuns(levels)
    .map((run: { start: number; end: number }): { start: number; end: number } => ({ start: from + run.start, end: from + run.end }));

  if (runs.length === 0) return modelTiming(highlight, duration, 8, 6, '听不出伴奏');

  let picked: Array<{ start: number; end: number }> = runs.filter((run: { start: number; end: number }): boolean => (
    Math.min(run.end, highlight.end) - Math.max(run.start, highlight.start) >= (run.end - run.start) * 0.5));

  if (picked.length === 0) {
    const middle: number = (highlight.start + highlight.end) / 2;

    picked = runs.filter((run: { start: number; end: number }): boolean => run.start <= middle && middle <= run.end);
  }

  if (picked.length === 0) return modelTiming(highlight, duration, 8, 6, '模型给的时间附近没有伴奏');

  const start: number = picked[0].start;
  const end: number = picked[picked.length - 1].end;

  return {
    start,
    end,
    how: `按伴奏定的起止（${ clock(start) } ~ ${ clock(end) }；模型给的是 ${ clock(highlight.start) } ~ ${ clock(highlight.end) }）`
  };
}
