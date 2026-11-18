import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { formatBytes } from '../download/formatProgress';

/**
 * 直播录完后把 flv / ts 转成 mp4。
 * 录制时仍然用 flv：flv 边录边写，程序中途退出文件也能播；mp4 要等结束时写索引，中途退出整个文件就坏了。
 * 所以做法是录完再转：
 *   - mp4：无损重新封装（不重新编码，很快，大小基本不变）
 *   - mp4-compress：重新编码成 H.264 压缩（口袋48直播码率偏高，一般能小一半以上），音频不动
 * 压缩用的编码器按顺序尝试：配置的 ffmpeg 的 libx264 → 系统 PATH 里 ffmpeg 的 libx264 → Windows 自带的 h264_mf
 * → 都不行就退回无损封装。转换成功并且时长核对一致后才删除原文件，否则保留原文件。
 * 在 local/pocket48.json 里用 liveRecordFormat 配置（flv / mp4 / mp4-compress），不配置就保持 flv。
 * 接入点：custom/live/liveRecording 在录制结束时调用。
 */
export type RecordFormat = 'flv' | 'mp4' | 'mp4-compress';

interface MediaInfo {
  duration?: number; // 秒
  width?: number;
  height?: number;
  fps?: number;
}

interface Encoder {
  name: string;
  ffmpeg: string;
  args: Array<string>;
}

export interface ConvertResult {
  ok: boolean;
  output?: string;
  encoder?: string;
  message?: string;
}

/* ffmpeg 对应的 ffprobe */
export function getFFprobePath(ffmpeg: string): string {
  const parsed: path.ParsedPath = path.parse(ffmpeg);

  if (!/^ffmpeg$/i.test(parsed.name)) return 'ffprobe';

  return path.join(parsed.dir, `ffprobe${ parsed.ext }`);
}

function runCapture(command: string, args: Array<string>): Promise<string> {
  return new Promise((resolve: (value: string) => void, reject: (reason: Error) => void): void => {
    const child: ChildProcessWithoutNullStreams = spawn(command, args, { windowsHide: true });
    const out: Array<Buffer> = [];

    child.stdout.on('data', (data: Buffer): void => {
      out.push(data);
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code: number | null): void => {
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`${ command } 退出码 ${ code }`));
    });
  });
}

async function probe(ffprobe: string, file: string): Promise<MediaInfo> {
  try {
    const text: string = await runCapture(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
      '-of', 'json',
      file
    ]);
    const json: {
      streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
      format?: { duration?: string };
    } = JSON.parse(text);
    const [num, den]: Array<number> = (json.streams?.[0]?.r_frame_rate ?? '').split('/').map(Number);
    const duration: number = Number(json.format?.duration);

    return {
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      width: json.streams?.[0]?.width,
      height: json.streams?.[0]?.height,
      fps: num > 0 && den > 0 ? num / den : undefined
    };
  } catch {
    return {};
  }
}

/* 压缩时依次尝试的编码器 */
export function encoderCandidates(ffmpeg: string, compress: boolean, info: MediaInfo): Array<Encoder> {
  const copy: Encoder = { name: '无损封装', ffmpeg, args: ['-c', 'copy'] };

  if (!compress) return [copy];

  const x264: Array<string> = ['-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'copy'];
  // h264_mf 只能指定码率：按 分辨率 × 帧率 估算（540×960@20 约 0.9 Mbps）
  const pixelsPerSecond: number = (info.width ?? 720) * (info.height ?? 1280) * (info.fps ?? 20);
  const bitrate: number = Math.round(Math.min(6_000_000, Math.max(500_000, pixelsPerSecond * 0.085)));
  const list: Array<Encoder> = [{ name: 'libx264', ffmpeg, args: x264 }];

  if (ffmpeg !== 'ffmpeg') list.push({ name: 'libx264（系统 ffmpeg）', ffmpeg: 'ffmpeg', args: x264 });

  list.push(
    { name: 'h264_mf', ffmpeg, args: ['-c:v', 'h264_mf', '-b:v', String(bitrate), '-c:a', 'copy'] },
    copy
  );

  return list;
}

/* 核对输出时长：和原文件相差不超过 3 秒或 2% */
export function isDurationOk(source: number | undefined, output: number | undefined): boolean {
  if (!source || !output) return false;

  return Math.abs(source - output) <= Math.max(3, source * 0.02);
}

function runEncoder(
  encoder: Encoder,
  source: string,
  output: string,
  duration: number | undefined,
  onProgress: (percent: number) => void,
  setChild: (child: ChildProcessWithoutNullStreams | null) => void
): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: Error) => void): void => {
    const child: ChildProcessWithoutNullStreams = spawn(encoder.ffmpeg, [
      '-y',
      '-v', 'error',
      '-nostats',
      '-progress', 'pipe:1',
      '-i', source,
      ...encoder.args,
      '-movflags', '+faststart',
      output
    ], { windowsHide: true });
    const stderr: Array<string> = [];

    setChild(child);
    child.stdout.on('data', (data: Buffer): void => {
      const match: Array<RegExpMatchArray> = Array.from(data.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g));

      if (duration && match.length > 0) {
        onProgress(Math.min(99, Number(match[match.length - 1][1]) / 1_000_000 / duration * 100));
      }
    });
    child.stderr.on('data', (data: Buffer): void => {
      if (stderr.length < 20) stderr.push(data.toString());
    });
    child.on('error', (err: Error): void => {
      setChild(null);
      reject(err);
    });
    child.on('close', (code: number | null): void => {
      setChild(null);
      code === 0 ? resolve() : reject(new Error(stderr.join('').trim().split('\n')[0] || `ffmpeg 退出码 ${ code }`));
    });
  });
}

/**
 * 转换一个录像文件
 * @param { string } source - flv / ts 文件
 * @param { RecordFormat } format
 * @param { string } ffmpeg - 配置的 ffmpeg
 */
export async function convertRecording(source: string, format: RecordFormat, ffmpeg: string): Promise<ConvertResult> {
  if (format === 'flv') return { ok: true, output: source };

  const parsed: path.ParsedPath = path.parse(source);
  const output: string = path.join(parsed.dir, `${ parsed.name }.mp4`);
  const taskId: string = `convert:${ source }`;
  const ffprobe: string = getFFprobePath(ffmpeg);
  const info: MediaInfo = await probe(ffprobe, source);
  const sourceSize: number = (await fsP.stat(source)).size;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stopped: boolean = false;

  queueTaskStart({
    id: taskId,
    title: parsed.base,
    kind: format === 'mp4-compress' ? '压缩为 mp4' : '转 mp4',
    filePath: output,
    percent: 0,
    stop(): void {
      stopped = true;
      child?.kill();
    }
  });

  let lastError: string = '';

  for (const encoder of encoderCandidates(ffmpeg, format === 'mp4-compress', info)) {
    if (stopped) break;

    try {
      await runEncoder(encoder, source, output, info.duration,
        (percent: number): void => queueTaskProgress(taskId, percent, `编码器：${ encoder.name }`),
        (c: ChildProcessWithoutNullStreams | null): void => {
          child = c;
        });

      if (stopped) break;

      const outputInfo: MediaInfo = await probe(ffprobe, output);

      if (!isDurationOk(info.duration, outputInfo.duration)) {
        // 时长对不上：两个文件都留着，让用户自己判断
        const message: string = `转换后的时长（${ Math.round(outputInfo.duration ?? 0) } 秒）和原文件（${
          Math.round(info.duration ?? 0) } 秒）不一致，原文件已保留`;

        queueTaskEnd(taskId, 'error', message);

        return { ok: false, output, encoder: encoder.name, message };
      }

      const outputSize: number = (await fsP.stat(output)).size;

      await fsP.rm(source, { force: true });
      queueTaskEnd(taskId, 'done', undefined, `${ formatBytes(sourceSize) } → ${ formatBytes(outputSize) }（${ encoder.name }）`);

      return { ok: true, output, encoder: encoder.name };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await fsP.rm(output, { force: true }).catch((): void => undefined);
    }
  }

  await fsP.rm(output, { force: true }).catch((): void => undefined);

  if (stopped) {
    queueTaskEnd(taskId, 'stopped');

    return { ok: false, message: '已停止' };
  }

  queueTaskEnd(taskId, 'error', `转换失败，原文件已保留：${ lastError }`);

  return { ok: false, message: lastError };
}

/* 找出一次录制产生的所有文件：xxx.flv，以及断线重连产生的 xxx(1).flv、xxx(2).flv… */
export function findRecordingFiles(filePath: string): Array<string> {
  const parsed: path.ParsedPath = path.parse(filePath);
  let names: Array<string> = [];

  try {
    names = fs.readdirSync(parsed.dir);
  } catch { /* noop */ }

  const prefix: string = `${ parsed.name }(`;
  const suffix: string = `)${ parsed.ext }`;

  return names
    .filter((name: string): boolean => name === parsed.base
      || (name.startsWith(prefix) && name.endsWith(suffix) && /^\d+$/.test(name.slice(prefix.length, -suffix.length))))
    .sort((a: string, b: string): number => a.length - b.length || a.localeCompare(b))
    .map((name: string): string => path.join(parsed.dir, name))
    .filter((file: string): boolean => {
      try {
        return fs.statSync(file).size > 1024; // 没录到内容的空文件不处理
      } catch {
        return false;
      }
    });
}

/* 录制结束后调用：按配置把这次录制的所有文件转成 mp4（一个一个转） */
export async function convertRecordingFiles(filePath: string, format: RecordFormat, ffmpeg: string): Promise<void> {
  if (format === 'flv') return;

  for (const file of findRecordingFiles(filePath)) {
    try {
      await convertRecording(file, format, ffmpeg);
    } catch (err) {
      console.error('录像转换失败', file, err);
    }
  }
}
