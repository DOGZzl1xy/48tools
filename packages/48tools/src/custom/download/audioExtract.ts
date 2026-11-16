import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import {
  isSourceBoundary,
  parseMediaPlaylist,
  type HlsSegment,
  type SegmentTimeline
} from '../../pages/48/Pocket48/Pocket48Record/Pocket48M3u8Download.worker/timeline';
import DownloadMeter from './downloadMeter';
import { SegmentPrefetcher } from './segmentPrefetcher';
import type { ProgressStats } from './formatProgress';

/**
 * 只下载音频：每下载一个分片就送进 ffmpeg 提取音频，边下载边生成 .part.aac（随时可以播放）。
 * 下载完成后，如果保存的是 .m4a，再无损封装成 m4a 并删除 .part.aac；中途停止时保留 .part.aac。
 * 接入点：Pocket48M3u8Download.worker 在 audioOnly 时调用 createAudio，并把 worker 内部函数通过 deps 传进来。
 */
export interface AudioWorkerData {
  ffmpeg: string;
  playStreamPath: string; // 本地 m3u8 文件
  filePath: string;
  qid?: string;
}

export interface AudioWorkerDeps {
  // 返回分片大小，失败会重试；signal 中止后不再重试
  downloadSegment(uri: string, file: string, label?: string, onRetry?: (attempt: number) => void, signal?: AbortSignal): Promise<number>;
  probeTimeline(ffprobe: string, file: string): Promise<SegmentTimeline>;
  getFFprobe(ffmpeg: string): string;
  runProcess(command: string, args: Array<string>): Promise<void>;
  postProgress(qid: string | undefined, value: number, stats?: ProgressStats): void;
  isStopped(): boolean;
  setActiveChild(child: ChildProcessWithoutNullStreams | null): void; // 停止下载时由 worker 结束这个进程
}

type AudioExtractor = {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
};

/**
 * 启动一个 ffmpeg：从 stdin 读 TS，只把第一路音频原样（不重新编码）以 ADTS(AAC) 写到 stdout，
 * stdout 追加到输出文件。ADTS 没有时间戳，可以直接首尾拼接，所以下载中途的文件也能播放。
 */
function startAudioExtractor(ffmpeg: string, output: fs.WriteStream, deps: AudioWorkerDeps): AudioExtractor {
  const child: ChildProcessWithoutNullStreams = spawn(ffmpeg, [
    '-hide_banner',
    '-v', 'error',
    '-f', 'mpegts',
    '-i', 'pipe:0',
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'copy',
    '-f', 'adts',
    'pipe:1'
  ]);
  const stderr: Array<Buffer> = [];

  deps.setActiveChild(child);
  child.stdout.pipe(output, { end: false });
  child.stderr.on('data', function(data: Buffer): void {
    stderr.push(data);
  });
  child.stdin.on('error', function(): void { /* ffmpeg 退出后写入会报 EPIPE，错误由 done 统一处理 */ });

  const done: Promise<void> = new Promise((resolve: () => void, reject: (reason: Error) => void): void => {
    child.on('error', reject);
    child.on('close', function(code: number | null): void {
      if (code === 0 || deps.isStopped()) {
        resolve();
      } else {
        const message: string = Buffer.concat(stderr).toString('utf8').trim();

        reject(new Error(`音频提取失败：${ message || `ffmpeg退出码：${ code ?? 'unknown' }` }`));
      }
    });
  });

  done.catch((): void => { /* 由调用方 await 处理，这里避免未处理的 rejection */ });

  return { child, done };
}

/* 写入 stdin，处理背压；ffmpeg 已经退出时不会一直等待 */
async function writeToExtractor(extractor: AudioExtractor, data: Buffer): Promise<void> {
  const stdin: Writable = extractor.child.stdin;

  if (stdin.destroyed) return;

  if (!stdin.write(data)) {
    await new Promise<void>((resolve: () => void): void => {
      function finish(): void {
        stdin.off('drain', finish);
        stdin.off('close', finish);
        resolve();
      }

      stdin.on('drain', finish);
      stdin.on('close', finish); // ffmpeg 退出时 stdin 会关闭
    });
  }
}

async function closeExtractor(extractor: AudioExtractor): Promise<void> {
  extractor.child.stdin.end();
  await extractor.done;
}

/**
 * 下载音频
 * @param { AudioWorkerData } workerData
 * @param { string } workDir - 临时目录（存放当前分片）
 * @param { AudioWorkerDeps } deps - worker 内部函数
 */
export async function createAudio(workerData: AudioWorkerData, workDir: string, deps: AudioWorkerDeps): Promise<void> {
  const { ffmpeg, playStreamPath, filePath, qid }: AudioWorkerData = workerData;
  const playlistData: string = await fsP.readFile(playStreamPath, { encoding: 'utf8' });
  const segments: Array<HlsSegment> = parseMediaPlaylist(playlistData);

  if (segments.length === 0) {
    throw new Error('m3u8中没有可下载的TS分片。');
  }

  const ffprobe: string = deps.getFFprobe(ffmpeg);
  const parsed: path.ParsedPath = path.parse(filePath);
  const saveAsAac: boolean = parsed.ext.toLowerCase() === '.aac';
  const aacFile: string = saveAsAac ? filePath : path.join(parsed.dir, `${ parsed.name }.part.aac`);
  const segmentFile: string = path.join(workDir, '_current_segment.ts');
  const output: fs.WriteStream = fs.createWriteStream(aacFile);
  const meter: DownloadMeter = new DownloadMeter(segments);
  const prefetcher: SegmentPrefetcher = new SegmentPrefetcher(segments.length, workDir, // 并行下载，按顺序提取音频
    (i: number, file: string, signal: AbortSignal): Promise<number> => deps.downloadSegment(segments[i].uri, file,
      `第 ${ i + 1 }/${ segments.length } 个分片`,
      (attempt: number): void => deps.postProgress(qid, i / segments.length * 98, { stage: 'retry', retry: attempt }), signal));
  let extractor: AudioExtractor | null = null;
  let previousTimeline: SegmentTimeline | null = null;
  let hasAudio: boolean = false;

  try {
    for (let index: number = 0; index < segments.length; index++) {
      if (deps.isStopped()) break;

      const segment: HlsSegment = segments[index];

      try {
        const bytes: number = await prefetcher.take(index, segmentFile);

        if (deps.isStopped()) break;

        let timeline: SegmentTimeline | null = null;

        try {
          timeline = await deps.probeTimeline(ffprobe, segmentFile);
        } catch { /* 解析失败时不判断源切换，直接交给 ffmpeg */ }

        // 没有音频的分片（例如只有画面）跳过
        if (!timeline || timeline.audio) {
          // 源切换（编码参数变化）时重启 ffmpeg，继续往同一个文件里追加
          if (extractor && timeline && previousTimeline && isSourceBoundary(segment, previousTimeline, timeline)) {
            await closeExtractor(extractor);
            extractor = null;
          }

          extractor ??= startAudioExtractor(ffmpeg, output, deps);
          await writeToExtractor(extractor, await fsP.readFile(segmentFile));
          hasAudio = true;
          previousTimeline = timeline ?? previousTimeline;
        }

        deps.postProgress(qid, (index + 1) / segments.length * 98, meter.tick(index, bytes));
      } finally {
        await fsP.rm(segmentFile, { force: true });
      }
    }

    if (extractor) {
      await closeExtractor(extractor);
      extractor = null;
    }
  } finally {
    await prefetcher.close();
    extractor?.child.kill('SIGTERM');
    deps.setActiveChild(null);
    await new Promise<void>((resolve: () => void): void => {
      output.end(resolve);
    });
  }

  if (deps.isStopped()) return;
  if (!hasAudio) throw new Error('录播中没有找到音频。');

  if (!saveAsAac) {
    deps.postProgress(qid, 99, { stage: 'audio' });
    await deps.runProcess(ffmpeg, [
      '-y',
      '-v', 'error',
      '-i', aacFile,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      filePath
    ]);
    await fsP.rm(aacFile, { force: true });
  }

  deps.postProgress(qid, 100);
}
