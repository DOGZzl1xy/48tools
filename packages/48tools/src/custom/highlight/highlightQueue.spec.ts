/**
 * 录播自动切片的排队：只处理一个、前一个开始处理时后一个开始准备、最多提前准备好一个、停止、出错不影响后面的。
 */
import { StagedQueue, type StagedTask, type QueueOutcome, type QueueStage } from './highlightQueue';

interface Gate {
  resolve: (value?: string) => void;
  reject: (err: Error) => void;
}

interface Fake {
  task: StagedTask<string>;
  prepare: Gate;
  process: Gate;
}

/* 等所有排着的 then 跑完 */
function settle(): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });
}

describe('StagedQueue', (): void => {
  let log: Array<string>;
  let queue: StagedQueue<string>;

  /* 一个假的任务：准备和处理什么时候结束由测试决定；被通知停止时自己报错退出 */
  function fake(id: string): Fake {
    const gates: { prepare?: Gate; process?: Gate } = {};

    function step(name: 'prepare' | 'process', signal: AbortSignal): Promise<string> {
      return new Promise((resolve: (value: string) => void, reject: (err: Error) => void): void => {
        gates[name] = { resolve: (value: string = `${ id } 的录播`): void => resolve(value), reject };
        signal.addEventListener('abort', (): void => reject(new Error('停了')));
      });
    }

    const task: StagedTask<string> = {
      id,
      prepare: (signal: AbortSignal): Promise<string> => step('prepare', signal),
      async process(prepared: string, signal: AbortSignal): Promise<void> {
        log.push(`${ id } 拿到 ${ prepared }`);
        await step('process', signal);
      },
      onStage: (stage: QueueStage): number => log.push(`${ id } ${ stage }`),
      onEnd: (outcome: QueueOutcome, err?: unknown): number => log.push(`${ id } ${ outcome }${ err instanceof Error ? `：${ err.message }` : '' }`)
    };

    return {
      task,
      get prepare(): Gate {
        return gates.prepare!;
      },
      get process(): Gate {
        return gates.process!;
      }
    };
  }

  beforeEach((): void => {
    log = [];
    queue = new StagedQueue();
  });

  test('第一场开始切的时候第二场开始下载；第三场要等第二场开始切', async (): Promise<void> => {
    const [a, b, c]: Array<Fake> = [fake('A'), fake('B'), fake('C')];

    queue.add(a.task);
    queue.add(b.task);
    queue.add(c.task);
    expect(log).toEqual(['A preparing']);

    a.prepare.resolve();
    await settle();
    expect(log).toEqual(['A preparing', 'A processing', 'A 拿到 A 的录播', 'B preparing']);

    // B 下载好了，A 还没切完：B 等着，C 不开始下载
    b.prepare.resolve();
    await settle();
    expect(log.slice(4)).toEqual(['B ready']);

    a.process.resolve();
    await settle();
    expect(log.slice(5)).toEqual(['A done', 'B processing', 'B 拿到 B 的录播', 'C preparing']);
    expect(queue.has('A')).toBe(false);

    b.process.resolve();
    await settle();
    c.prepare.resolve();
    await settle();
    c.process.resolve();
    await settle();
    expect(log.slice(9)).toEqual(['B done', 'C processing', 'C 拿到 C 的录播', 'C done']);
  });

  test('同一个任务不能加两次；结束后可以再加', async (): Promise<void> => {
    const a: Fake = fake('A');

    expect(queue.add(a.task)).toBe(true);
    expect(queue.add(fake('A').task)).toBe(false);
    queue.stop('A');
    await settle();
    expect(queue.add(fake('A').task)).toBe(true);
  });

  test('还在排队的任务点停止：立刻结束，轮到它时也不会开始', async (): Promise<void> => {
    const [a, b, c]: Array<Fake> = [fake('A'), fake('B'), fake('C')];

    queue.add(a.task);
    queue.add(b.task);
    queue.add(c.task);
    queue.stop('B');
    expect(log).toEqual(['A preparing', 'B stopped']);
    expect(queue.has('B')).toBe(false);

    a.prepare.resolve();
    await settle();
    expect(log.slice(2)).toEqual(['A processing', 'A 拿到 A 的录播', 'C preparing']);
  });

  test('下载好了在等的任务点停止：立刻结束，后面的开始下载', async (): Promise<void> => {
    const [a, b, c]: Array<Fake> = [fake('A'), fake('B'), fake('C')];

    queue.add(a.task);
    queue.add(b.task);
    queue.add(c.task);
    a.prepare.resolve();
    await settle();
    b.prepare.resolve();
    await settle();
    queue.stop('B');
    expect(log.slice(-2)).toEqual(['B stopped', 'C preparing']);
  });

  test('正在下载或正在切的任务点停止：等它自己退出后算「已停止」，后面的接着做', async (): Promise<void> => {
    const [a, b]: Array<Fake> = [fake('A'), fake('B')];

    queue.add(a.task);
    queue.add(b.task);
    a.prepare.resolve();
    await settle();
    queue.stop('B'); // 正在下载
    queue.stop('A'); // 正在切
    await settle();
    expect(log.slice(4)).toEqual(['B stopped：停了', 'A stopped：停了']);
    expect(queue.has('A') || queue.has('B')).toBe(false);
  });

  test('一个任务出错不影响后面的', async (): Promise<void> => {
    const [a, b]: Array<Fake> = [fake('A'), fake('B')];

    queue.add(a.task);
    queue.add(b.task);
    a.prepare.reject(new Error('下载失败'));
    await settle();
    expect(log).toEqual(['A preparing', 'A error：下载失败', 'B preparing']);

    b.prepare.resolve();
    await settle();
    b.process.reject(new Error('合成失败'));
    await settle();
    expect(log.slice(3)).toEqual(['B processing', 'B 拿到 B 的录播', 'B error：合成失败']);
  });
});
