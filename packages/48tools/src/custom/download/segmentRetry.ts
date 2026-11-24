/**
 * 分片下载重试。
 * 录播有上千个分片，海外直连国内 CDN 时偶尔会断线、超时或卡住；原来任何一个分片失败都会让整个下载失败。
 *   - 一个分片停住 10 秒：从断点改走代理补完（./segmentFetch，用户 2026-11-24 定的），一般不用重试
 *   - SEGMENT_TIMEOUT：连接 20 秒、首字节 60 秒、60 秒没有数据就断开（之后会重试），避免一直卡住；没有配置代理时靠它
 *   - withRetry：失败后按 RETRY_WAITS 的间隔重试（2 秒起，越等越久，最长 1 分钟，一共 8 次、等 4 分多钟），停止下载时不再重试
 * 2026-11-23 用户反映服务器断开（The server aborted pending request：got 在服务器传到一半断开连接时报的，口袋48 那边最近经常这样，
 * 界面上显示成「网络波动，正在重试」）后原来的 5 次重试（一共只等半分钟）很快用完、整场失败，改成等得更久：一般过一会儿就好。
 * 接入点：Pocket48M3u8Download.worker 的 downloadSegment（加超时）和 downloadSegmentWithRetry、./segmentFetch、custom/highlight/highlightDownload。
 */
export const SEGMENT_TIMEOUT: Record<string, number> = {
  lookup: 20_000,
  connect: 20_000,
  secureConnect: 20_000,
  response: 60_000,
  socket: 60_000
};

// 第 n 次重试前等多久（毫秒）
export const RETRY_WAITS: Array<number> = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];

/**
 * 直连失败这么多次以后，这个分片改走口袋48代理（北京节点）下（用户 2026-11-23 要的解决办法）。
 * 实测（2026-11-23）：个别分片从美国的 CDN 节点回国内取时每次都在同一处断开（沈馨那场的第 59 个、徐佳琳那场的第 142 个，
 * 多少次重试、从断点续传都一样），走北京代理从国内节点取 6 秒左右就完整下到、校验码一致。
 * 代理很慢（整场只有 0.4 MB/s 左右），所以只给下不来的分片用，别的分片照样直连
 */
export const PROXY_FROM_ATTEMPT: number = 2;

/* 第 attempt 次（0 是第一次）下载要不要走代理 */
export function segmentViaProxy(attempt: number): boolean {
  return attempt >= PROXY_FROM_ATTEMPT;
}

export interface RetryOptions {
  retries?: number;                   // 最多重试次数，默认 RETRY_WAITS 的个数
  label?: string;                     // 失败时的说明，例如「第 12/1111 个分片」
  isStopped(): boolean;               // 已停止下载时不再重试
  signal?: AbortSignal;               // 停止时不等了，马上结束
  onRetry?(attempt: number, err: unknown): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>; // 测试时换掉
}

/* 等一会儿；signal 中止时马上结束 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void): void => {
    if (signal?.aborted) {
      resolve();

      return;
    }

    function finish(): void {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }

    const timer: ReturnType<typeof setTimeout> = setTimeout(finish, ms);

    signal?.addEventListener('abort', finish, { once: true });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* 第 attempt 次（从 1 开始）重试前等多久 */
export function retryWait(attempt: number): number {
  return RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length) - 1];
}

/* task 收到这是第几次（0 是第一次），可以据此换下载方式（见 segmentViaProxy） */
export async function withRetry<T>(task: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const retries: number = options.retries ?? RETRY_WAITS.length;

  for (let attempt: number = 0; ; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      if (options.isStopped()) throw err;

      if (attempt >= retries) {
        throw new Error(`${ options.label ?? '下载' }失败（已重试 ${ retries } 次）：${ errorMessage(err) }`, { cause: err });
      }

      options.onRetry?.(attempt + 1, err);
      console.warn(`${ options.label ?? '下载' }失败，第 ${ attempt + 1 } 次重试：${ errorMessage(err) }`);
      await (options.sleep ?? sleep)(retryWait(attempt + 1), options.signal);

      if (options.isStopped()) throw err;
    }
  }
}
