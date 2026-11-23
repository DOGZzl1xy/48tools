/**
 * 所有录播下载共用一个「下载位」：同一时间只下一场，后来的排队，先来先下（用户 2026-11-23 定的）。
 * 起因：两场切片的录播和一场公演录播一起下时，三场都在中途失败（The server aborted pending request：服务器在传一个分片的中途断开了连接）。
 * 用户说明这是口袋48 服务器那边的问题，最近经常这样，和同时下几场关系不大；一次只下一场是为了不给服务器添负担、出问题时好排查。
 * 每场自己仍然同时下几个分片（../download/segmentPrefetcher），只是场和场之间不并行。
 * 这里只管排队（纯逻辑，方便测试）；在下载队列里显示「排队中」的是用它的地方。
 * 接入点：../highlight/highlightDownload 的 downloadReplay（录播切片、自动抓取、公演录播切片）、
 *   ../downloadQueue/recordTasks 的 recordTaskQueue（录播下载）、Live48/InVideo（公演录播下载）。
 */
export interface SlotTicket {
  ready: Promise<void>;  // 轮到这一场了
  waiting(): boolean;    // 还在排队
  release(): void;       // 下完（或失败、停止）了，让给下一场；还在排队时调用就是不排了。调用几次都只算一次
}

export class DownloadSlot {
  #current: SlotTicket | null = null;
  #queue: Array<{ ticket: SlotTicket; go: () => void }> = [];

  /* 排一个号：空着就马上轮到 */
  take(): SlotTicket {
    let go!: () => void;
    let released: boolean = false;
    const ready: Promise<void> = new Promise((resolve: () => void): void => {
      go = resolve;
    });
    const ticket: SlotTicket = {
      ready,
      waiting: (): boolean => !released && this.#current !== ticket,
      release: (): void => {
        if (released) return;

        released = true;

        if (this.#current === ticket) {
          this.#next();
        } else {
          this.#queue = this.#queue.filter((item: { ticket: SlotTicket }): boolean => item.ticket !== ticket);
        }
      }
    };

    if (this.#current === null) {
      this.#current = ticket;
      go();
    } else {
      this.#queue.push({ ticket, go });
    }

    return ticket;
  }

  /* 排在前面的还有几场（包括正在下的） */
  get busy(): number {
    return (this.#current ? 1 : 0) + this.#queue.length;
  }

  #next(): void {
    const next: { ticket: SlotTicket; go: () => void } | undefined = this.#queue.shift();

    this.#current = next?.ticket ?? null;
    next?.go();
  }
}

export const downloadSlot: DownloadSlot = new DownloadSlot();

export class DownloadWaitStopped extends Error {
  constructor() {
    super('已停止（还在排队，没有开始下载）');
    this.name = 'DownloadWaitStopped';
  }
}

/**
 * 等轮到了再下载，下完让给下一场
 * @param { () => Promise<T> } task - 真正的下载
 * @param { { signal?: AbortSignal; onWaiting?: () => void; slot?: DownloadSlot } } options - onWaiting：要排队时调用一次（显示「排队中」）；
 *   排队时 signal 中止就不排了（抛 DownloadWaitStopped）
 */
export async function withDownloadSlot<T>(
  task: () => Promise<T>, options: { signal?: AbortSignal; onWaiting?: () => void; slot?: DownloadSlot } = {}
): Promise<T> {
  const { signal, onWaiting }: { signal?: AbortSignal; onWaiting?: () => void } = options;

  if (signal?.aborted) throw new DownloadWaitStopped();

  const ticket: SlotTicket = (options.slot ?? downloadSlot).take();

  try {
    if (ticket.waiting()) {
      onWaiting?.();
      await new Promise<void>((resolve: () => void, reject: (reason: Error) => void): void => {
        const handleAbort: () => void = (): void => reject(new DownloadWaitStopped());

        signal?.addEventListener('abort', handleAbort, { once: true });
        ticket.ready.then((): void => {
          signal?.removeEventListener('abort', handleAbort);
          resolve();
        });
      });
    }

    return await task();
  } finally {
    ticket.release();
  }
}
