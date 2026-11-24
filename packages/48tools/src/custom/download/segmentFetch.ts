import { promises as fsP } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { segmentViaProxy } from './segmentRetry';

/**
 * 下载一个分片到文件：直连停住了，从断点改走口袋48代理（北京节点）补完，补完核对大小（用户 2026-11-24 定的）。
 * 实测（2026-11-24）：新录播在 CDN 的美国节点上没有缓存，要现从国内取，大约 1% 的分片会停在中间（总在 1 MB 的整数倍处），60 秒后服务器才断开。
 * 停住的时候重新直连、从断点续传、换别的美国节点都没用，全要等满那 60 秒；从断点走北京代理 2.5～11.5 秒就补完。
 *   - STALL_MS 没有新数据（从发请求算起，没等到响应也算）就断开，剩下的走代理；直连半路断开的也一样
 *   - 没有配置代理：照旧等（重新直连也没用），由 ./segmentRetry 的 SEGMENT_TIMEOUT 和 withRetry 处理
 *   - 直连、代理都没下来：报错，由 withRetry 过一会儿重来；第 PROXY_FROM_ATTEMPT 次起整个分片走代理（见 ./segmentRetry）
 * 只补停住的那一点（几百 KB），代理很慢（约 0.4 MB/s）但够用；别的分片照样直连，也不等它（见 ./segmentPrefetcher、custom/highlight/highlightDownload）。
 * 接入点：Pocket48M3u8Download.worker 的 downloadSegment、custom/highlight/highlightTask 的 fetchSegment。
 */
export const STALL_MS: number = 10_000;
export const PROXY_STALL_MS: number = 30_000; // 走代理时停住这么久就算失败

interface SegmentResponse {
  statusCode?: number;
  headers: Record<string, string | Array<string> | undefined>;
}

export interface SegmentFetchOptions {
  file: string;
  attempt?: number;  // 第几次（0 是第一次），见 ./segmentRetry 的 withRetry
  hasProxy: boolean; // 有没有口袋48代理可以用
  /* 发请求（got.stream）：viaProxy 走不走代理，headers 是要加的请求头（从断点续传的 Range） */
  open(viaProxy: boolean, headers: Record<string, string>): Readable;
  signal?: AbortSignal;
  isStopped?(): boolean; // 已停止下载：不再改走代理
  stall?: number;        // 测试时换掉
}

interface Received {
  bytes: number;  // 已经写进文件的
  total?: number; // 整个分片多大（响应头里说的）
}

class SegmentStalled extends Error {
  constructor(ms: number) {
    super(`${ ms / 1_000 } 秒没有新数据`);
    this.name = 'SegmentStalled';
  }
}

function headerText(value: string | Array<string> | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
}

/* 请求本身有问题（4xx，例如录播被删了）：换条路也一样，不用走代理 */
function isRefused(err: unknown): boolean {
  const status: number | undefined = (err as { response?: { statusCode?: number } } | null)?.response?.statusCode;

  return status !== undefined && status >= 400 && status < 500;
}

/* 看响应头：整个分片多大；要的是从断点续传，服务器给的却是整个时，从头写 */
function readResponse(res: SegmentResponse, received: Received): string | undefined {
  const start: number = received.bytes;
  let total: number | undefined;

  if (res.statusCode === 206) {
    const range: RegExpExecArray | null = /^bytes\s+(\d+)-\d+\/(\d+)/i.exec(headerText(res.headers['content-range']));

    if (!range || Number(range[1]) !== start) return '续传的位置不对';

    total = Number(range[2]);
  } else {
    received.bytes = 0;

    // 压缩过的响应，长度不是解压后的大小，不能拿来核对
    if (!headerText(res.headers['content-encoding'])) total = Number(headerText(res.headers['content-length'])) || undefined;
  }

  if (total !== undefined && received.total !== undefined && total !== received.total) {
    return `两边的大小不一样（${ received.total } 和 ${ total }）`;
  }

  received.total ??= total;

  return undefined;
}

/* 收数据写进文件，接在 received.bytes 后面。停住、断开、没收完都报错，已经收到的留在文件里 */
async function receive(stream: Readable, handle: FileHandle, received: Received, stallMs: number, signal?: AbortSignal): Promise<void> {
  let last: number = Date.now();
  let failed: Error | undefined;

  function stop(err: Error): void {
    failed ??= err;
    stream.destroy(err);
  }

  function handleAbort(): void {
    stop(new Error('已停止下载'));
  }

  const timer: ReturnType<typeof setInterval> | undefined = Number.isFinite(stallMs)
    ? setInterval((): void => {
      Date.now() - last >= stallMs && stop(new SegmentStalled(stallMs));
    }, Math.min(500, stallMs / 4))
    : undefined;

  stream.once('response', (res: SegmentResponse): void => {
    const problem: string | undefined = readResponse(res, received);

    last = Date.now();
    problem && stop(new Error(problem));
  });
  // 读完、断开以后才冒出来的错误没有人接，会变成没处理的异常
  stream.on('error', (): void => { /* 由 for await 抛出 */ });
  signal?.addEventListener('abort', handleAbort, { once: true });
  signal?.aborted && handleAbort();

  try {
    for await (const chunk of stream) {
      const data: Buffer = chunk as Buffer;

      if (failed) break;

      await handle.write(data, 0, data.length, received.bytes);
      received.bytes += data.length;
      last = Date.now();
    }
  } catch (err) {
    throw failed ?? err;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', handleAbort);
  }

  if (failed) throw failed;

  if (received.total !== undefined && received.bytes !== received.total) {
    throw new Error(`分片没有下完整（${ received.bytes }/${ received.total }）`);
  }
}

/* 下载一个分片，返回大小 */
export async function fetchSegmentFile(options: SegmentFetchOptions): Promise<number> {
  const { file, attempt = 0, hasProxy, open, signal, stall = STALL_MS }: SegmentFetchOptions = options;
  const isStopped: () => boolean = (): boolean => Boolean(signal?.aborted || options.isStopped?.());
  const received: Received = { bytes: 0 };
  const handle: FileHandle = await fsP.open(file, 'w');

  try {
    if (hasProxy && segmentViaProxy(attempt)) {
      await receive(open(true, {}), handle, received, PROXY_STALL_MS, signal);
    } else {
      try {
        await receive(open(false, {}), handle, received, hasProxy ? stall : Number.POSITIVE_INFINITY, signal);
      } catch (err) {
        if (!hasProxy || isStopped() || isRefused(err)) throw err;

        // 收到的比说好的还多：这一份不能要，从头来
        if (received.total !== undefined && received.bytes > received.total) received.bytes = 0;

        // 数据都收到了、只是连接没有正常结束：不用补
        if (received.total === undefined || received.bytes !== received.total) {
          const at: number = received.bytes;

          console.warn(`分片直连没下完（${ err instanceof Error ? err.message : String(err) }），从 ${ at } 字节起走代理补`);
          await receive(open(true, at > 0 ? { Range: `bytes=${ at }-` } : {}), handle, received, PROXY_STALL_MS, signal);
        }
      }
    }

    await handle.truncate(received.bytes);
  } finally {
    await handle.close();
  }

  if (received.bytes === 0) throw new Error('下载到的分片是空的');

  return received.bytes;
}
