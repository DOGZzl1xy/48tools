/**
 * 直播录制断线后的重连逻辑（在录制 worker 里使用）。
 * 原版的问题：
 *   - 断线后查询直播信息，查询失败（例如代理波动）时既不重试也不结束，这场直播会一直显示「录制中」，之后不会再录
 *   - 直播地址没变时直接放弃，要等下一轮自动抓取才新开文件
 * 现在：
 *   - 断线后 3 秒就重连；查询直播信息失败会重试，实在查不到就用原来的地址重连
 *   - 连续 3 次「连上不到 20 秒就断」认为直播已经结束，结束录制
 *   - 直播结束后地址会变成录播的 m3u8，这种情况不当作直播继续录
 * 接入点：Pocket48LiveDownload.worker 和 DownloadAndTranscoding.worker 的 ffmpeg 结束回调。
 */
export const QUICK_FAIL_MS: number = 20_000;
export const MAX_QUICK_FAILS: number = 3;
export const INFO_RETRIES: number = 5;

export interface LiveInfoLike {
  success?: boolean;
  content?: { playStreamPath?: string } | null;
}

export interface LiveReconnectOptions {
  liveId: string;
  getUrl(): string;                                   // 当前的直播地址
  requestInfo(liveId: string): Promise<LiveInfoLike>; // 查询直播信息
  restart(playStreamPath: string): void;              // 用这个地址重新开始录（新文件）
  close(): void;                                      // 结束录制
  isKilled(): boolean;                                // 用户手动停止了
  wait?(ms: number): Promise<void>;                   // 测试用
  now?(): number;                                     // 测试用
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

export function isM3u8(url: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return /\.m3u8(\?|$)/i.test(url);
  }
}

export class LiveReconnect {
  readonly #options: LiveReconnectOptions;
  #quickFails: number = 0;
  #startedAt: number;

  constructor(options: LiveReconnectOptions) {
    this.#options = options;
    this.#startedAt = this.#now();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /* ffmpeg 每次启动时调用 */
  markStart(): void {
    this.#startedAt = this.#now();
  }

  /* ffmpeg 意外结束（不是用户停止）时调用 */
  async handleClose(): Promise<void> {
    const { liveId, getUrl, requestInfo, restart, close, isKilled }: LiveReconnectOptions = this.#options;
    const wait: (ms: number) => Promise<void> = this.#options.wait ?? defaultWait;

    this.#quickFails = (this.#now() - this.#startedAt) < QUICK_FAIL_MS ? this.#quickFails + 1 : 0;

    if (this.#quickFails >= MAX_QUICK_FAILS) return close();

    await wait(this.#quickFails === 0 ? 3_000 : 20_000 * this.#quickFails);

    if (isKilled()) return close();

    let requestOk: boolean = false;
    let url: string | undefined;

    for (let i: number = 0; i < INFO_RETRIES; i++) {
      try {
        const res: LiveInfoLike = await requestInfo(liveId);

        requestOk = true;
        url = res.success ? (res.content?.playStreamPath || undefined) : undefined;
        break;
      } catch (err) {
        console.warn(`查询直播信息失败，第 ${ i + 1 } 次：`, err);
        await wait(15_000);

        if (isKilled()) return close();
      }
    }

    if (isKilled()) return close();

    // 接口正常但已经没有直播地址：直播结束
    if (requestOk && !url) return close();

    // 直播结束后地址变成录播 m3u8：不继续录
    if (url && isM3u8(url) && !isM3u8(getUrl())) return close();

    restart(url ?? getUrl());
  }
}

/* 只保留最近的若干条 ffmpeg 输出，避免长时间录制时日志一直占内存 */
export function pushCapped<T>(list: Array<T>, item: T, max: number = 300): void {
  list.push(item);

  if (list.length > max) list.splice(0, list.length - max);
}
