import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import DownloadMeter from '../download/downloadMeter';
import { SegmentPrefetcher } from '../download/segmentPrefetcher';
import { withRetry, segmentViaProxy } from '../download/segmentRetry';
import { formatProgressDetail } from '../download/formatProgress';
import { withDownloadSlot, DownloadWaitStopped } from '../download/downloadSlot';
import { runFfmpeg } from './highlightFfmpeg';
import { HighlightStopped } from './highlightGemini';
import { clock } from './highlightTime';

/**
 * 录播自动切片里下载整场录播的部分。
 * 录播是一个 m3u8（一千来个几秒钟的分片）。和普通的录播下载一样同时下 4 个分片（custom/download/segmentPrefetcher），
 * 卡住或失败的分片自动重试；全部下完后在本机合成一个 mp4（不重新编码，几秒钟的事）。
 * 分片放在「工作文件夹/segments」里，中途停止后再来时已经下好的不用重新下。
 * 不是普通 m3u8 的（很早以前的录播是一个 mp4、加密的、或者调用的地方没给下载分片的函数）让 ffmpeg 直接下载，只有一条连接。
 * 和所有录播下载共用一个下载位（../download/downloadSlot）：前面有别的在下时排队，下完分片就让给下一场（合并在本机做）。
 * 接入点：./highlightPipeline 的 prepareHighlight、./highlightTask 的 downloadStream。
 */

/* 下载一个分片到文件，返回大小；signal 中止后要尽快结束。attempt 是第几次（0 是第一次），直连下不来时改走代理（../download/segmentRetry） */
export type SegmentFetcher = (uri: string, file: string, signal: AbortSignal, attempt: number) => Promise<number>;

export interface PlaylistSegment {
  uri: string;      // 完整的地址
  duration: number; // 秒
  file: string;     // 本机的文件名
}

export interface ReplayPlaylist {
  segments: Array<PlaylistSegment>;
  local: string; // 把分片地址换成本机文件名后的 m3u8，交给 ffmpeg 合成
}

export interface DownloadProgress {
  part: number;   // 0 ~ 1
  detail: string;
}

export interface ReplayDownload {
  ffmpeg: string;
  url: string;            // 录播地址
  playlist?: string;      // 录播地址是 m3u8 时它的内容
  workDir: string;
  output: string;         // 合成后的 mp4
  // 电台：只留声音（画面只是口袋48的占位图，存进去白占地方，44 分钟的录播 521 MB → 19 MB），开头那一帧另存成这张图，
  // 给电台封面兜底（取得到这场直播的封面图时会被换掉，见 ./highlightPipeline 的 saveRadioCover）
  cover?: string;
  fetchSegment?: SegmentFetcher;
  signal?: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
}

const SEGMENT_FOLDER: string = 'segments';
const LOCAL_PLAYLIST: string = 'local.m3u8';
const MERGE_PART: number = 0.97; // 下载占这一步的 97%，剩下的是合成

function segmentFile(index: number): string {
  return `${ String(index).padStart(6, '0') }.ts`;
}

/**
 * 读 m3u8：每个分片的地址（相对地址补全）和时长，以及换成本机文件名后的 m3u8。
 * 没有分片、加密（#EXT-X-KEY）或者分片要先读一个头（#EXT-X-MAP）时返回 undefined，这几种交给 ffmpeg 自己下载
 * @param { string } text - m3u8 的内容
 * @param { string } baseUrl - m3u8 的地址
 */
export function readPlaylist(text: string, baseUrl: string): ReplayPlaylist | undefined {
  if (!/^#EXTM3U/.test(text.trim()) || /#EXT-X-(KEY|MAP|STREAM-INF)/.test(text)) return undefined;

  const segments: Array<PlaylistSegment> = [];
  const local: Array<string> = [];
  let duration: number = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line: string = raw.trim();

    if (line === '') continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;

      local.push(line);
      continue;
    }

    let uri: string;

    try {
      uri = new URL(line, baseUrl).href;
    } catch {
      return undefined;
    }

    const file: string = segmentFile(segments.length);

    segments.push({ uri, duration, file });
    local.push(file);
    duration = 0;
  }

  return segments.length > 0 ? { segments, local: `${ local.join('\n') }\n` } : undefined;
}

/* 已经下好的分片：从头数连续有多少个，一共多大（下载是按顺序放进文件夹的，中间不会有空缺） */
async function downloadedSegments(dir: string, segments: Array<PlaylistSegment>): Promise<{ count: number; bytes: number }> {
  let count: number = 0;
  let bytes: number = 0;

  while (count < segments.length) {
    let size: number = 0;

    try {
      size = (await fsP.stat(path.join(dir, segments[count].file))).size;
    } catch { /* 没有这个文件 */ }

    if (size === 0) break;

    bytes += size;
    count++;
  }

  return { count, bytes };
}

/**
 * 把所有分片下载到 dir 里（同时下几个，按顺序放好）；dir 里已经有的不重新下
 * @param { Pick<ReplayDownload, 'signal' | 'onProgress'> } job
 * @param { ReplayPlaylist } playlist
 * @param { SegmentFetcher } fetchSegment
 * @param { string } dir
 */
export async function downloadSegments(
  job: Pick<ReplayDownload, 'signal' | 'onProgress'>, playlist: ReplayPlaylist, fetchSegment: SegmentFetcher, dir: string
): Promise<void> {
  const { segments }: ReplayPlaylist = playlist;
  const { signal, onProgress }: Pick<ReplayDownload, 'signal' | 'onProgress'> = job;
  const total: number = segments.length;
  const have: { count: number; bytes: number } = await downloadedSegments(dir, segments);
  const meter: DownloadMeter = new DownloadMeter(segments);
  let retrying: number = 0; // 正在重试的分片数，重试时不让别的分片的进度把提示盖掉

  meter.downloaded = have.bytes;

  function report(done: number, text: string): void {
    const part: number = done / total;

    onProgress({ part: part * MERGE_PART, detail: `下载录播 ${ Math.floor(part * 100) }%${ text ? ` · ${ text }` : '' }` });
  }

  const prefetcher: SegmentPrefetcher = new SegmentPrefetcher(total, dir, async (index: number, file: string, inner: AbortSignal): Promise<number> => {
    let retried: boolean = false;

    try {
      return await withRetry((attempt: number): Promise<number> => fetchSegment(segments[index].uri, file, inner, attempt), {
        label: `第 ${ index + 1 }/${ total } 个分片`,
        isStopped: (): boolean => inner.aborted,
        onRetry(attempt: number): void {
          if (!retried) retrying++;

          retried = true;
          report(index, formatProgressDetail({ stage: 'retry', retry: attempt, viaProxy: segmentViaProxy(attempt) }));
        }
      });
    } finally {
      if (retried) retrying--;
    }
  }, undefined, have.count);

  let closing: Promise<void> | undefined;

  /* 停掉还在下的分片、删掉下了一半的；点停止和正常结束都会走到，只做一次 */
  function close(): Promise<void> {
    closing ??= prefetcher.close().catch((): void => undefined);

    return closing;
  }

  function handleAbort(): void {
    close();
  }

  signal?.addEventListener('abort', handleAbort, { once: true });
  have.count > 0 && report(have.count, `接着上次的下，已下载 ${ have.count }/${ total } 个分片`);

  try {
    for (let index: number = have.count; index < total; index++) {
      if (signal?.aborted) throw new HighlightStopped();

      const bytes: number = await prefetcher.take(index, path.join(dir, segments[index].file));
      const text: string = formatProgressDetail(meter.tick(index, bytes));

      retrying === 0 && report(index + 1, text);
    }
  } catch (err) {
    throw signal?.aborted ? new HighlightStopped() : err;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    await close();
  }
}

/* 电台只留声音：合成时不要画面 */
function keepArgs(job: ReplayDownload): Array<string> {
  return job.cover ? ['-vn', '-c', 'copy'] : ['-c', 'copy'];
}

/* 电台：开头那一帧先存成封面兜底。没有画面、存不下来时不存，不影响录音 */
async function saveFirstFrame(job: ReplayDownload, input: string, cwd?: string): Promise<void> {
  if (!job.cover) return;

  try {
    await runFfmpeg(job.ffmpeg, ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', path.resolve(job.cover)], {
      cwd, signal: job.signal
    });
  } catch (err) {
    if (job.signal?.aborted) throw new HighlightStopped();

    console.warn('电台录播的封面没有存下来', err);
  }
}

/* 让 ffmpeg 直接下载（只有一条连接，没有重试） */
async function downloadWithFfmpeg(job: ReplayDownload, expected: number | undefined): Promise<void> {
  await saveFirstFrame(job, job.url);
  await runFfmpeg(job.ffmpeg, [
    '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', job.url, ...keepArgs(job), job.output
  ], {
    signal: job.signal,
    onTime(seconds: number): void {
      const part: number = expected ? Math.min(1, seconds / expected) : 0;

      job.onProgress({
        part,
        detail: expected ? `下载录播 ${ Math.floor(part * 100) }%（单线下载）` : `下载录播，已下载 ${ clock(seconds) }`
      });
    }
  });
}

/* 等轮到这一场再下（所有录播下载一次只下一场，见 ../download/downloadSlot）；排队时点了停止当作切片停止 */
async function inSlot(job: ReplayDownload, task: () => Promise<void>): Promise<void> {
  try {
    await withDownloadSlot(task, {
      signal: job.signal,
      onWaiting: (): void => job.onProgress({ part: 0, detail: '排队中：等前面的下载完再下（同一时间只下一场）…' })
    });
  } catch (err) {
    throw err instanceof DownloadWaitStopped ? new HighlightStopped() : err;
  }
}

/**
 * 把整场录播下载成一个 mp4。和别的录播下载排队，一次只下一场
 * @param { ReplayDownload } job
 */
export async function downloadReplay(job: ReplayDownload): Promise<void> {
  const playlist: ReplayPlaylist | undefined = job.playlist === undefined ? undefined : readPlaylist(job.playlist, job.url);
  const expected: number | undefined = playlist?.segments.reduce((sum: number, item: PlaylistSegment): number => sum + item.duration, 0);

  if (!playlist || !job.fetchSegment) {
    await inSlot(job, (): Promise<void> => {
      job.onProgress({ part: 0, detail: '下载录播…' });

      return downloadWithFfmpeg(job, expected || undefined);
    });

    return;
  }

  const dir: string = path.join(job.workDir, SEGMENT_FOLDER);

  await fsP.mkdir(dir, { recursive: true });
  // 合并是本机的事，下完分片就让给下一场
  await inSlot(job, (): Promise<void> => {
    job.onProgress({ part: 0, detail: '下载录播…' });

    return downloadSegments(job, playlist, job.fetchSegment!, dir);
  });

  // 合成一个文件：ffmpeg 读本机的 m3u8，和直接读网上的那个是同一种处理，只是分片已经在硬盘上了
  job.onProgress({ part: MERGE_PART, detail: '下载完成，正在合并分片…' });
  await fsP.writeFile(path.join(dir, LOCAL_PLAYLIST), playlist.local);
  await saveFirstFrame(job, LOCAL_PLAYLIST, dir);
  await runFfmpeg(job.ffmpeg, [
    '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', LOCAL_PLAYLIST, ...keepArgs(job), path.resolve(job.output)
  ], {
    cwd: dir,
    signal: job.signal,
    onTime(seconds: number): void {
      const part: number = expected ? Math.min(1, seconds / expected) : 0;

      job.onProgress({ part: MERGE_PART + (part * (1 - MERGE_PART)), detail: `下载完成，正在合并分片 ${ Math.floor(part * 100) }%` });
    }
  });
  await fsP.rm(dir, { recursive: true, force: true });
}
