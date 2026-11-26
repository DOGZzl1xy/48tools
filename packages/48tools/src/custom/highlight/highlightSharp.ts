import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { runFfmpeg } from './highlightFfmpeg';
import { toOut } from './highlightCut';
import type { Segment } from './highlightTypes';

/**
 * 直播切片的封面候选：从这一段里每秒取两帧，算每一帧清不清楚，把成片分成几段、每段挑最清楚的那一帧。
 * 以前按字幕的时间取（重点句开口后 0.7 秒），不看画面，一半是闭眼、低头、手在动发糊的（用户 2026-11-26 说「很多都是不清楚的」）。
 * 清楚不清楚用拉普拉斯方差（边缘越锐利越大），太暗的不要；挑出来的再交给 Gemini 选一张（看表情、眼睛）。
 * 2026-11-26 拿沈馨一场 5 分钟的片段试过：算一遍 3 秒多，挑出来的 12 帧都清楚，均匀取的 12 帧里有闭眼、手挡脸、发糊的。
 */
export const SAMPLE_FPS: number = 2;
const SAMPLE_W: number = 180;  // 缩小了算：只看大的边缘（动起来糊掉的就是这些），也快
const SAMPLE_H: number = 320;
const DARK: number = 25;       // 平均亮度低于它的（黑屏、切换时的暗帧）不要

/* 一帧灰度图（SAMPLE_W × SAMPLE_H）有多清楚：中间部分（去掉四边 8%，那里有水印）的拉普拉斯方差；太暗的是 0 */
export function sharpness(gray: Uint8Array, offset: number = 0, width: number = SAMPLE_W, height: number = SAMPLE_H): number {
  const x0: number = Math.max(1, Math.round(width * 0.08));
  const y0: number = Math.max(1, Math.round(height * 0.08));
  let sum: number = 0;
  let squares: number = 0;
  let light: number = 0;
  let count: number = 0;

  for (let y: number = y0; y < height - y0; y++) {
    for (let x: number = x0; x < width - x0; x++) {
      const at: number = offset + (y * width) + x;
      const lap: number = (4 * gray[at]) - gray[at - 1] - gray[at + 1] - gray[at - width] - gray[at + width];

      sum += lap;
      squares += lap * lap;
      light += gray[at];
      count++;
    }
  }

  if (count === 0 || light / count < DARK) return 0;

  return (squares / count) - ((sum / count) ** 2);
}

export interface Sample {
  time: number;   // 成片里的时间（秒）
  score: number;
}

/* 成片分成 count 段，每段挑最清楚的一帧（全是 0 分的段不要）；返回成片里的时间，从早到晚 */
export function pickSharp(samples: Array<Sample>, total: number, count: number): Array<number> {
  const picked: Array<number> = [];

  for (let part: number = 0; part < count; part++) {
    const from: number = (total * part) / count;
    const to: number = (total * (part + 1)) / count;
    let best: Sample | undefined;

    for (const sample of samples) {
      if (sample.time >= from && sample.time < to && sample.score > 0 && (!best || sample.score > best.score)) best = sample;
    }

    best && picked.push(best.time);
  }

  return picked;
}

/* 每一帧在录播这一段里的时间 → 成片里的时间；剪掉的地方、最后 0.2 秒以内的不要 */
export function samplesInClip(scores: Array<number>, segments: Array<Segment>, total: number): Array<Sample> {
  return scores.flatMap((score: number, index: number): Array<Sample> => {
    const time: number | null = toOut(segments, index / SAMPLE_FPS);

    return time !== null && time < total - 0.2 ? [{ time, score }] : [];
  });
}

interface SharpInput {
  ffmpeg: string;
  source: string;
  cwd: string;                   // 临时文件放在这里
  start: number;                 // 录播里这一段从第几秒开始、多长
  length: number;
  segments: Array<Segment>;
  total: number;
  count: number;
  signal?: AbortSignal;
}

/**
 * 从录播的这一段里挑 count 个清楚的封面候选
 * @return { Promise<Array<number>> } 成片里的时间；一帧都没取到时是空的
 */
export async function sharpTimes(input: SharpInput): Promise<Array<number>> {
  const { ffmpeg, source, cwd, start, length, segments, total, count, signal }: SharpInput = input;
  const file: string = path.join(cwd, 'sharp.gray');

  try {
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error', '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', source, '-an',
      '-vf', `fps=${ SAMPLE_FPS }:start_time=0,scale=${ SAMPLE_W }:${ SAMPLE_H }:flags=area,format=gray`, '-f', 'rawvideo', file
    ], { cwd, signal });

    const gray: Buffer = await fsP.readFile(file);
    const size: number = SAMPLE_W * SAMPLE_H;
    const scores: Array<number> = Array.from({ length: Math.floor(gray.length / size) }, (_item: unknown, index: number): number => sharpness(gray, index * size));

    return pickSharp(samplesInClip(scores, segments, total), total, count);
  } finally {
    await fsP.rm(file, { force: true }).catch((): void => undefined);
  }
}
