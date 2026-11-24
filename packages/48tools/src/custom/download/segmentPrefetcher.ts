import { promises as fsP } from 'node:fs';
import * as path from 'node:path';

/**
 * 分片并行预取。
 * 海外直连国内 CDN 时，单个连接快不起来（新录播在美国节点上没有缓存，要现从国内取），多开几个连接才快。
 * 实测（2026-11-24，没有缓存的录播）：4 个 2.0~2.7 MB/s，8 个 3.9~5.8 MB/s，12 个 7.5~7.8 MB/s；用户定的用 8 个。
 * 同时下 SEGMENT_CONCURRENCY 个，下载到临时文件；处理（拼接视频、提取音频）仍然严格按顺序 take。
 * 下好了、还没轮到处理的不占名额：一个分片停住时后面的照常往前下，最多提前 SEGMENT_AHEAD 个（临时文件两百多 MB）。
 * 以前下好的也占名额（一共只提前 4 个），前面那个停住一分钟，整场就跟着停一分钟（2026-11-24 用户反映的「卡住不动」）。
 * 接入点：Pocket48M3u8Download.worker 的 downloadParts、downloadSegment（登记请求）、run（结束时关闭）、stop（取消请求）；
 *         custom/download/audioExtract 的下载循环。
 */
export const SEGMENT_CONCURRENCY: number = 8;
export const SEGMENT_AHEAD: number = 100;

type AbortableRequest = {
  destroy(error?: Error): void;
  once(event: 'close', listener: () => void): unknown;
};

/* 正在进行的分片请求，停止下载或出错时一起取消 */
const segmentRequests: Set<AbortableRequest> = new Set();
const prefetchers: Set<SegmentPrefetcher> = new Set();

/* 登记一个分片请求，请求结束后自动移除 */
export function trackSegmentRequest(request: AbortableRequest): void {
  segmentRequests.add(request);
  request.once('close', (): void => {
    segmentRequests.delete(request);
  });
}

/* 取消所有进行中的分片请求 */
export function abortSegmentRequests(): void {
  for (const request of segmentRequests) {
    try {
      request.destroy();
    } catch { /* noop */ }
  }

  segmentRequests.clear();
}

/**
 * 下载第 index 个分片到 file，返回分片大小（内部自己处理重试）。
 * signal 中止后不应再重试。
 */
export type SegmentDownloader = (index: number, file: string, signal: AbortSignal) => Promise<number>;

export class SegmentPrefetcher {
  readonly #total: number;
  readonly #workDir: string;
  readonly #download: SegmentDownloader;
  readonly #concurrency: number;
  readonly #ahead: number;
  readonly #controller: AbortController = new AbortController();
  readonly #tasks: Map<number, Promise<number>> = new Map();
  #next: number = 0;    // 下一个要开始下载的分片
  #head: number = 0;    // 下一个要处理的分片
  #running: number = 0; // 正在下载的有几个

  /**
   * @param { number } total - 分片总数
   * @param { string } workDir - 临时目录
   * @param { SegmentDownloader } download
   * @param { number } [concurrency]
   * @param { number } [start] - 从第几个分片开始（断点续传）
   * @param { number } [ahead] - 最多提前下到要处理的后面多少个
   */
  constructor(
    total: number,
    workDir: string,
    download: SegmentDownloader,
    concurrency: number = SEGMENT_CONCURRENCY,
    start: number = 0,
    ahead: number = SEGMENT_AHEAD
  ) {
    this.#next = start;
    this.#head = start;
    this.#total = total;
    this.#workDir = workDir;
    this.#download = download;
    this.#concurrency = Math.max(1, concurrency);
    this.#ahead = Math.max(this.#concurrency, ahead);
    prefetchers.add(this);
  }

  #file(index: number): string {
    return path.join(this.#workDir, `_prefetch_${ String(index).padStart(6, '0') }.ts`);
  }

  /* 补满下载队列：下完（或失败）一个就接着下一个，不等前面的处理 */
  #fill(): void {
    while (!this.#controller.signal.aborted && this.#running < this.#concurrency
      && this.#next < this.#total && this.#next < this.#head + this.#ahead) {
      const index: number = this.#next++;
      const task: Promise<number> = this.#download(index, this.#file(index), this.#controller.signal);
      const settled: () => void = (): void => {
        this.#running--;
        this.#fill();
      };

      this.#running++;
      this.#tasks.set(index, task);
      task.then(settled, settled); // 错误在 take 时抛出
    }
  }

  /**
   * 按顺序取第 index 个分片：等它下载完成后移动到 dest，返回分片大小
   * @param { number } index
   * @param { string } dest - 目标文件（会被覆盖）
   */
  async take(index: number, dest: string): Promise<number> {
    this.#fill();

    const task: Promise<number> | undefined = this.#tasks.get(index);

    if (!task) throw new Error(`第 ${ index + 1 } 个分片不在下载队列中。`);

    try {
      const bytes: number = await task;

      await fsP.rename(this.#file(index), dest);

      return bytes;
    } finally {
      this.#tasks.delete(index);
      this.#head = index + 1;
      this.#fill();
    }
  }

  /* 停止预取：取消进行中的请求，等它们结束后删除临时文件 */
  async close(): Promise<void> {
    if (!prefetchers.delete(this)) return;

    this.#controller.abort();
    abortSegmentRequests();
    await Promise.allSettled(this.#tasks.values());
    this.#tasks.clear();

    for (let index: number = 0; index < this.#next; index++) {
      await fsP.rm(this.#file(index), { force: true });
    }
  }
}

/* 关闭所有预取（下载结束、出错或停止时调用） */
export async function closeSegmentPrefetchers(): Promise<void> {
  await Promise.all(Array.from(prefetchers, (prefetcher: SegmentPrefetcher): Promise<void> => prefetcher.close()));
}
