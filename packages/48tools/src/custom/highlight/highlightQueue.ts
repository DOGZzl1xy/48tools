/**
 * 录播自动切片的排队：每个任务分两步，先「准备」（下载录播）再「处理」（找爆点、合成）。
 *   - 处理很吃 CPU，同一时间只处理一个，按加进来的顺序
 *   - 前一个开始处理时，后一个就开始准备，不用等前一个全部做完
 *   - 最多提前准备好一个：准备好了还没轮到处理的任务没被取走之前，再后面的不开始准备（录播很大，免得一下子占满硬盘）
 *   - 停止：还在排队或者准备好了在等的，立刻结束；正在准备或处理的，通知它停（signal），等它自己退出
 * 只管顺序，不知道任务具体做什么，方便单独测试。接入点：./highlightTask。
 */
export type QueueStage = 'waiting' | 'preparing' | 'ready' | 'processing';
export type QueueOutcome = 'done' | 'stopped' | 'error';

export interface StagedTask<P> {
  id: string;
  prepare: (signal: AbortSignal) => Promise<P>;
  process: (prepared: P, signal: AbortSignal) => Promise<void>;
  /* 开始准备、准备好了但要等前面的（ready）、开始处理时调用 */
  onStage?: (stage: QueueStage) => void;
  /* 结束：做完、被停止、出错（err） */
  onEnd: (outcome: QueueOutcome, err?: unknown) => void;
}

interface Entry<P> {
  task: StagedTask<P>;
  controller: AbortController;
  stage: QueueStage;
  prepared?: P;
  ended: boolean;
}

export class StagedQueue<P> {
  readonly #entries: Array<Entry<P>> = [];

  has(id: string): boolean {
    return this.#entries.some((entry: Entry<P>): boolean => entry.task.id === id);
  }

  /* 加一个任务；同一个 id 已经在队里时不加，返回 false */
  add(task: StagedTask<P>): boolean {
    if (this.has(task.id)) return false;

    this.#entries.push({ task, controller: new AbortController(), stage: 'waiting', ended: false });
    this.#pump();

    return true;
  }

  stop(id: string): void {
    const entry: Entry<P> | undefined = this.#entries.find((item: Entry<P>): boolean => item.task.id === id);

    if (!entry) return;

    entry.controller.abort();

    // 没有在运行的步骤，不会有谁来报告结束，这里直接结束
    if (entry.stage === 'waiting' || entry.stage === 'ready') this.#finish(entry, 'stopped');
  }

  #stage(entry: Entry<P>, stage: QueueStage): void {
    entry.stage = stage;

    try {
      entry.task.onStage?.(stage);
    } catch (err) {
      console.error(err);
    }
  }

  #pump(): void {
    const entries: Array<Entry<P>> = this.#entries;

    // 处理：没有正在处理的，就轮到最前面那个准备好的
    if (!entries.some((entry: Entry<P>): boolean => entry.stage === 'processing')) {
      const ready: Entry<P> | undefined = entries.find((entry: Entry<P>): boolean => entry.stage === 'ready');

      ready && this.#process(ready);
    }

    // 准备：没有正在准备的，也没有准备好了在等的，下一个才开始
    if (!entries.some((entry: Entry<P>): boolean => entry.stage === 'preparing' || entry.stage === 'ready')) {
      const waiting: Entry<P> | undefined = entries.find((entry: Entry<P>): boolean => entry.stage === 'waiting');

      waiting && this.#prepare(waiting);
    }
  }

  #prepare(entry: Entry<P>): void {
    this.#stage(entry, 'preparing');
    entry.task.prepare(entry.controller.signal).then((prepared: P): void => {
      if (entry.ended) return;

      if (entry.controller.signal.aborted) {
        this.#finish(entry, 'stopped');

        return;
      }

      entry.prepared = prepared;
      entry.stage = 'ready';
      this.#pump();

      // 马上就轮到处理的不用提示「在等前面的」
      entry.stage === 'ready' && !entry.ended && this.#stage(entry, 'ready');
    }, (err: unknown): void => this.#finish(entry, entry.controller.signal.aborted ? 'stopped' : 'error', err));
  }

  #process(entry: Entry<P>): void {
    this.#stage(entry, 'processing');
    entry.task.process(entry.prepared as P, entry.controller.signal).then(
      (): void => this.#finish(entry, 'done'),
      (err: unknown): void => this.#finish(entry, entry.controller.signal.aborted ? 'stopped' : 'error', err));
  }

  #finish(entry: Entry<P>, outcome: QueueOutcome, err?: unknown): void {
    if (entry.ended) return;

    entry.ended = true;
    this.#entries.splice(this.#entries.indexOf(entry), 1);

    try {
      entry.task.onEnd(outcome, err);
    } catch (endError) {
      console.error(endError);
    }

    this.#pump();
  }
}
