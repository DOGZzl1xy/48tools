import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { runFfmpeg, mediaDuration } from '../highlight/highlightFfmpeg';
import { clock, parseLrc, safeFileName } from '../highlight/highlightTime';
import { mapDanmuToParts, type RecordedPart } from '../highlight/highlightStage';
import type { HighlightProgress, PreparedSource } from '../highlight/highlightPipeline';
import type { DanmuLine } from '../highlight/highlightTypes';
import type { GongyanManifest, GongyanPart } from './gongyanRecorder';
import { MANIFEST } from './gongyanFiles';

/**
 * 公演切片的第 1 步：把录下来的几段（./gongyanRecorder 存的 ts）接成一个 mp4，弹幕的时间对到接起来的录像上。
 *   - 边录边写的文件里不一定写了时长，每一段的长度要整个读一遍才知道
 *   - 几段的画面参数（编码、分辨率、声音的采样率）都一样时直接拷贝着接起来（快）；不一样时（比如中途画质变了）重新编码
 *   - 接完量一下长度：比录到的短很多（某一段的结尾写坏了，ffmpeg 读到那里就不往下接了），就把每段先单独整理一遍再接；还是不对就报错
 *   - B 站一连上会先把缓存的几秒一下子发过来，所以每一段的画面其实从连上之前几秒开始，对弹幕时要算进去（partStart）
 *   - 接好的 mp4 用公演名命名、留在录像文件夹里（切完不删），manifest.json 记下它和每段的长度，然后删掉 ts；
 *     重试、重切时直接用这个 mp4（用户 2026-11 定的：录像只留一个 mp4）
 * 接入点：./gongyanHighlight。
 */
export interface GongyanSourceInput {
  ffmpeg: string;
  dir: string;               // 录像文件夹（manifest.json 在这里）
  manifest: GongyanManifest;
  workDir: string;           // 中间文件放在这里
  onProgress(progress: HighlightProgress): void;
  progressEnd: number;       // 这一步做完时的总进度
  signal?: AbortSignal;
}

export interface GongyanSource extends PreparedSource {
  parts: number;             // 用了几段
}

interface ScannedPart extends RecordedPart {
  file: string;              // 完整路径
  signature: string;
}

const MIN_PART_SECONDS: number = 5;
const MAX_BURST_SECONDS: number = 10;

async function exists(file: string): Promise<boolean> {
  try {
    await fsP.access(file);

    return true;
  } catch {
    return false;
  }
}

/* concat 列表里的一行文件名（单引号要转义） */
export function concatLine(file: string): string {
  return `file '${ file.replace(/\\/g, '/').replace(/'/g, '\'\\\'\'') }'`;
}

/* ffmpeg -i 打印的信息里，画面和声音的参数：参数一样的几段才能直接拷贝着接起来 */
export function streamSignature(log: string): string {
  const video: RegExpExecArray | null = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(log);
  const audio: RegExpExecArray | null = /Stream #\d+:\d+.*?: Audio: (\w+).*?, (\d+) Hz/.exec(log);

  return `${ video ? `${ video[1] } ${ video[2] }x${ video[3] }` : 'no-video' } ${ audio ? `${ audio[1] } ${ audio[2] }` : 'no-audio' }`;
}

/**
 * 这一段的画面实际是什么时候开始的（毫秒）：录到的比经过的时间长，多出来的是连上时一下子发过来的缓存，画面从连上之前那么久开始。
 * 录到的比经过的短（卡住了一阵才断开）时就按开始录的时间算。
 */
export function partStart(part: GongyanPart, duration: number): number {
  if (!part.end) return part.start;

  const burst: number = duration - ((part.end - part.start) / 1_000);

  return part.start - (Math.min(Math.max(burst, 0), MAX_BURST_SECONDS) * 1_000);
}

/* 整个读一遍（只拷贝不解码，很快），读到的最后时间就是这一段的长度；顺便拿到画面参数 */
async function scanPart(ffmpeg: string, file: string, signal?: AbortSignal): Promise<{ duration: number; signature: string }> {
  let duration: number = 0;
  const log: string = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'
  ], {
    signal,
    allowFail: true,
    onTime: (seconds: number): void => {
      duration = Math.max(duration, seconds);
    }
  });
  const match: RegExpExecArray | null = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const header: number = match ? (Number(match[1]) * 3_600) + (Number(match[2]) * 60) + Number(match[3]) : 0;

  return { duration: duration || header, signature: streamSignature(log) };
}

interface JoinInput {
  ffmpeg: string;
  parts: Array<{ file: string; duration: number }>;
  list: string;
  output: string;
  copy: boolean;
  onTime(seconds: number): void;
  signal?: AbortSignal;
}

/* 用 concat 把几段接起来；copy 时直接拷贝，失败了再重新编码 */
async function join(input: JoinInput): Promise<void> {
  const { ffmpeg, parts, list, output, copy, onTime, signal }: JoinInput = input;

  // 写上每一段的长度：文件里不一定写了，不写的话 concat 要自己猜下一段从哪里接
  await fsP.writeFile(list, parts.map((part: { file: string; duration: number }): string =>
    `${ concatLine(part.file) }\nduration ${ part.duration.toFixed(3) }`).join('\n'));

  const head: Array<string> = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-map', '0:a:0'];
  const reencode: Array<string> = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '160k'];
  const tail: Array<string> = ['-movflags', '+faststart', '-y', output];

  if (copy) {
    try {
      await runFfmpeg(ffmpeg, [...head, '-c', 'copy', ...tail], { signal, onTime });

      return;
    } catch (err) {
      if (signal?.aborted) throw err;

      console.warn('B 站公演：直接接起来失败，重新编码', err);
    }
  }

  await runFfmpeg(ffmpeg, [...head, ...reencode, ...tail], { signal, onTime });
}

/* 弹幕对到接起来的录像上；一条弹幕都没收到时没有这个文件 */
async function readDanmu(dir: string, manifest: GongyanManifest, parts: Array<RecordedPart>): Promise<Array<DanmuLine>> {
  const danmuFile: string = path.join(dir, manifest.danmu);

  if (!(await exists(danmuFile))) return [];

  try {
    return mapDanmuToParts(parseLrc(await fsP.readFile(danmuFile, 'utf8')), manifest.startedAt, parts);
  } catch (err) {
    console.warn('B 站公演：读不到弹幕，成片里不显示弹幕', err);

    return [];
  }
}

export async function prepareGongyanSource(input: GongyanSourceInput): Promise<GongyanSource> {
  const { ffmpeg, dir, manifest, workDir, onProgress, progressEnd, signal }: GongyanSourceInput = input;
  const joinedName: string = manifest.joined ?? `${ safeFileName(manifest.show.title, 80) }.mp4`;
  const joinedFile: string = path.join(dir, joinedName);

  // 后面找爆点、剪片段都要往工作文件夹里写，不管接不接都先建好（以前只在接的时候建，重切时会报「打不开输出文件」）
  await fsP.mkdir(workDir, { recursive: true });

  // 以前已经接好了（ts 删掉了）：直接用接好的 mp4，弹幕按记下的每段长度对
  if (manifest.joined && await exists(joinedFile)) {
    const recorded: Array<RecordedPart> = manifest.parts
      .filter((part: GongyanPart): boolean => Boolean(part.duration))
      .map((part: GongyanPart): RecordedPart => ({ start: partStart(part, part.duration!), duration: part.duration! }));
    const lines: Array<DanmuLine> = await readDanmu(dir, manifest, recorded);

    onProgress({ percent: progressEnd, detail: `录像已经接好了（${ lines.length } 条弹幕）` });

    return { source: joinedFile, danmu: lines, parts: recorded.length };
  }

  const source: string = path.join(workDir, 'source.mp4');
  const parts: Array<ScannedPart> = [];
  const used: Array<GongyanPart & { duration: number }> = [];

  for (const part of manifest.parts) {
    const file: string = path.join(dir, part.file);

    if (!(await exists(file))) continue;

    onProgress({ percent: 0, detail: `检查录像 ${ part.file }…` });

    const scanned: { duration: number; signature: string } = await scanPart(ffmpeg, file, signal);

    if (scanned.duration >= MIN_PART_SECONDS) {
      parts.push({ file, duration: scanned.duration, signature: scanned.signature, start: partStart(part, scanned.duration) });
      used.push({ ...part, duration: Number(scanned.duration.toFixed(3)) });
    }
  }

  if (parts.length === 0) throw new Error('没有录到能用的录像');

  {
    const total: number = parts.reduce((sum: number, part: RecordedPart): number => sum + part.duration, 0);
    const tolerance: number = Math.max(5, total * 0.02);
    const copy: boolean = parts.every((part: ScannedPart): boolean => part.signature === parts[0].signature);
    const list: string = path.join(workDir, 'parts.txt');
    const report: (label: string) => (seconds: number) => void = (label: string) => (seconds: number): void => {
      const done: number = Math.min(1, seconds / Math.max(1, total));

      onProgress({ percent: done * progressEnd, detail: `${ label } ${ Math.round(done * 100) }%` });
    };

    await join({ ffmpeg, parts, list, output: source, copy, onTime: report(copy ? '把录像接起来' : '几段的画质不一样，重新编码'), signal });

    let joined: number = await mediaDuration(ffmpeg, source, signal).catch((): number => 0);

    if (joined < total - tolerance) {
      // 某一段的结尾写坏了：每段先单独整理一遍（读到坏的地方就停），再接
      console.warn(`B 站公演：接起来只有 ${ clock(joined) }，录到的有 ${ clock(total) }，每段整理一遍再接`);

      const clean: Array<{ file: string; duration: number }> = [];

      for (const [index, part] of parts.entries()) {
        const file: string = path.join(workDir, `clean-${ String(index + 1).padStart(2, '0') }.ts`);

        await runFfmpeg(ffmpeg, ['-hide_banner', '-i', part.file, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts', '-y', file],
          { signal, allowFail: true });
        clean.push({ file, duration: part.duration });
      }

      await join({ ffmpeg, parts: clean, list, output: source, copy, onTime: report('重新整理录像'), signal });
      await Promise.all(clean.map((item: { file: string }): Promise<void> => fsP.rm(item.file, { force: true })));
      joined = await mediaDuration(ffmpeg, source, signal).catch((): number => 0);

      if (joined < total - tolerance) throw new Error(`录像接不起来：接好的只有 ${ clock(joined) }，录到的有 ${ clock(total) }`);
    }

  }

  // 接好的 mp4 放到录像文件夹里留着（切完不删），记下每段的长度，然后删掉 ts（长度已经核对过，内容都在 mp4 里）
  await fsP.rename(source, joinedFile);
  manifest.parts = used;
  manifest.joined = joinedName;
  await fsP.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
  await Promise.all(used.map((part: GongyanPart): Promise<void> => fsP.rm(path.join(dir, part.file), { force: true })));

  const danmu: Array<DanmuLine> = await readDanmu(dir, manifest, parts);

  onProgress({ percent: progressEnd, detail: `录像准备好了（${ parts.length } 段，${ danmu.length } 条弹幕）` });

  return { source: joinedFile, danmu, parts: parts.length };
}
