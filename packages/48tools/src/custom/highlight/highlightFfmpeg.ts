import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { HighlightStopped } from './highlightGemini';
import type { FontSet } from './highlightAss';
import type { Silence } from './highlightTypes';

/**
 * 录播自动切片里跑 ffmpeg 的几个小函数：运行（可以中途停止、报告进度）、读时长、找静音、找字体。
 */
export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onTime?: (seconds: number) => void; // 已经处理到第几秒（要在参数里加 -progress pipe:1）
  allowFail?: boolean;                // 退出码不是 0 也当成功（只想看它打印的信息时）
}

const STDERR_LIMIT: number = 400_000;

/**
 * 运行 ffmpeg，返回它打印在 stderr 上的内容
 * @param { string } ffmpeg - 配置的 ffmpeg
 * @param { Array<string> } args
 * @param { RunOptions } [options]
 */
export function runFfmpeg(ffmpeg: string, args: Array<string>, options: RunOptions = {}): Promise<string> {
  return new Promise((resolve: (value: string) => void, reject: (reason: Error) => void): void => {
    if (options.signal?.aborted) {
      reject(new HighlightStopped());

      return;
    }

    const child: ChildProcessWithoutNullStreams = spawn(ffmpeg, args, { cwd: options.cwd, windowsHide: true });
    let stderr: string = '';

    function handleAbort(): void {
      child.kill();
    }

    options.signal?.addEventListener('abort', handleAbort, { once: true });
    child.stdout.on('data', (data: Buffer): void => {
      const matches: Array<RegExpMatchArray> = Array.from(data.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g));

      if (matches.length > 0) options.onTime?.(Number(matches[matches.length - 1][1]) / 1_000_000);
    });
    child.stderr.on('data', (data: Buffer): void => {
      stderr = (stderr + data.toString('utf8')).slice(-STDERR_LIMIT);
    });
    child.on('error', (err: NodeJS.ErrnoException): void => {
      options.signal?.removeEventListener('abort', handleAbort);
      reject(err.code === 'ENOENT' ? new Error('找不到 FFmpeg，请先在「设置 → 工具路径」里配置') : err);
    });
    child.on('close', (code: number | null): void => {
      options.signal?.removeEventListener('abort', handleAbort);

      if (options.signal?.aborted) {
        reject(new HighlightStopped());
      } else if (code === 0 || options.allowFail) {
        resolve(stderr);
      } else {
        const lines: Array<string> = stderr.trim().split(/\r?\n/).filter((line: string): boolean => line.trim() !== '');

        reject(new Error(`ffmpeg 出错：${ (lines[lines.length - 1] ?? `退出码 ${ code }`).slice(0, 300) }`));
      }
    });
  });
}

/* 一个视频 / 音频文件的时长（秒）。从 ffmpeg -i 打印的信息里读，不需要 ffprobe */
export async function mediaDuration(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number> {
  const log: string = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', file], { signal, allowFail: true });
  const match: RegExpExecArray | null = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);

  if (!match) throw new Error('读不出录播的时长，文件可能没有下载完整');

  return (Number(match[1]) * 3_600) + (Number(match[2]) * 60) + Number(match[3]);
}

/* 文件里有没有画面（电台的录音没有） */
export async function hasVideoStream(ffmpeg: string, file: string, signal?: AbortSignal): Promise<boolean> {
  const log: string = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', file], { signal, allowFail: true });

  return /Stream #\d+:\d+.*: Video:/.test(log);
}

/* ffmpeg 的 silencedetect 打印的内容 → 静音的时间段 */
export function parseSilences(log: string): Array<Silence> {
  const list: Array<Silence> = [];
  let start: number | null = null;

  for (const line of log.split('\n')) {
    const startMatch: RegExpExecArray | null = /silence_start: (-?[\d.]+)/.exec(line);
    const endMatch: RegExpExecArray | null = /silence_end: ([\d.]+)/.exec(line);

    if (startMatch) start = Math.max(0, Number(startMatch[1]));

    if (endMatch && start !== null) {
      list.push({ start, end: Number(endMatch[1]) });
      start = null;
    }
  }

  return list;
}

/* 一段音频里的静音（比 -32dB 小、持续 0.45 秒以上） */
export async function detectSilences(ffmpeg: string, file: string, signal?: AbortSignal): Promise<Array<Silence>> {
  const log: string = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-32dB:d=0.45', '-f', 'null', '-'
  ], { signal });

  return parseSilences(log);
}

/* 画面上一个点的颜色（YUV）；x、y 要是偶数 */
export async function pixelAt(ffmpeg: string, file: string, time: number, x: number, y: number, signal?: AbortSignal): Promise<{ y: number; u: number; v: number }> {
  const raw: string = `${ file }.pixel`;

  try {
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error', '-ss', time.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${ x }:${ y }`, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', raw
    ], { signal });

    const data: Buffer = await fsP.readFile(raw);

    if (data.length < 6) throw new Error('读不出成片的画面');

    return { y: data[0], u: data[4], v: data[5] };
  } finally {
    await fsP.rm(raw, { force: true });
  }
}

export const PCM_RATE: number = 8_000;

/**
 * 一段音频的采样（单声道、8kHz，只留人声的频段），找音节用（见 ./highlightAlign）
 * @param { string } ffmpeg
 * @param { string } file - 音频文件；采样先写到它旁边的 .pcm 文件里，读完就删
 * @param { AbortSignal } [signal]
 */
export async function readPcm(ffmpeg: string, file: string, signal?: AbortSignal): Promise<Int16Array> {
  const pcmFile: string = `${ file }.pcm`;

  try {
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error', '-i', file, '-ac', '1', '-ar', String(PCM_RATE), '-af', 'highpass=f=200,lowpass=f=3400', '-f', 's16le', pcmFile
    ], { signal });

    const data: Buffer = await fsP.readFile(pcmFile);

    return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  } finally {
    await fsP.rm(pcmFile, { force: true });
  }
}

const sourceHanFiles: Array<string> = [
  'SourceHanSansSC-Medium.otf', 'SourceHanSansSC-Heavy.otf', 'SourceHanSansSC-Regular.otf', 'SourceHanSansSC-Bold.otf'
];

/**
 * 成片用的字体：电脑上装了思源黑体（四个粗细的 otf）就用它，复制到工作文件夹的 fonts/ 里让 ffmpeg 读；
 * 没装就用 Windows 自带的微软雅黑
 * @param { string } workDir - 成片的工作文件夹
 */
export async function pickFonts(workDir: string): Promise<FontSet> {
  const dirs: Array<string> = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Windows/Fonts'),
    path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts')
  ];
  const found: string | undefined = dirs.find(
    (dir: string): boolean => sourceHanFiles.every((name: string): boolean => fs.existsSync(path.join(dir, name))));

  if (!found) {
    return { text: 'Microsoft YaHei', heavy: 'Microsoft YaHei', heavyBold: true, regular: 'Microsoft YaHei', em: 1.32 };
  }

  const target: string = path.join(workDir, 'fonts');

  await fsP.mkdir(target, { recursive: true });

  for (const name of sourceHanFiles) {
    await fsP.copyFile(path.join(found, name), path.join(target, name));
  }

  return {
    text: 'Source Han Sans SC Medium',
    heavy: 'Source Han Sans SC Heavy',
    heavyBold: false,
    regular: 'Source Han Sans SC',
    em: 1.448,
    dir: 'fonts'
  };
}
