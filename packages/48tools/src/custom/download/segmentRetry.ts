/**
 * 分片下载重试。
 * 录播有上千个分片，海外直连国内 CDN 时偶尔会断线、超时或卡住；原来任何一个分片失败都会让整个下载失败。
 *   - SEGMENT_TIMEOUT：连接 15 秒、首字节 30 秒、30 秒没有数据就断开（之后会重试），避免一直卡住
 *   - withRetry：失败后按 1、2、4、8、15 秒的间隔重试，停止下载时不再重试
 * 接入点：Pocket48M3u8Download.worker 的 downloadSegment（加超时）和 downloadSegmentWithRetry。
 */
export const SEGMENT_TIMEOUT: Record<string, number> = {
  lookup: 15_000,
  connect: 15_000,
  secureConnect: 15_000,
  response: 30_000,
  socket: 30_000
};

export interface RetryOptions {
  retries?: number;                   // 最多重试次数，默认 5
  label?: string;                     // 失败时的说明，例如「第 12/1111 个分片」
  isStopped(): boolean;               // 已停止下载时不再重试
  onRetry?(attempt: number, err: unknown): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries: number = options.retries ?? 5;

  for (let attempt: number = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (options.isStopped()) throw err;

      if (attempt >= retries) {
        throw new Error(`${ options.label ?? '下载' }失败（已重试 ${ retries } 次）：${ errorMessage(err) }`, { cause: err });
      }

      options.onRetry?.(attempt + 1, err);
      console.warn(`${ options.label ?? '下载' }失败，第 ${ attempt + 1 } 次重试：${ errorMessage(err) }`);
      await sleep(Math.min(1_000 * (2 ** attempt), 15_000));

      if (options.isStopped()) throw err;
    }
  }
}
