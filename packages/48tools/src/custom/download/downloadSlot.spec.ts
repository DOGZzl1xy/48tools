import { DownloadSlot, DownloadWaitStopped, withDownloadSlot, type SlotTicket } from './downloadSlot';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise: Promise<void> = new Promise((done: () => void): void => {
    resolve = done;
  });

  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i: number = 0; i < 5; i++) await Promise.resolve();
}

describe('downloadSlot：所有录播下载一次只下一场', (): void => {
  test('空着就马上轮到；后来的排队，先来先下', async (): Promise<void> => {
    const slot: DownloadSlot = new DownloadSlot();
    const a: SlotTicket = slot.take();
    const b: SlotTicket = slot.take();
    const c: SlotTicket = slot.take();

    expect(a.waiting()).toBe(false);
    expect(b.waiting()).toBe(true);
    expect(slot.busy).toBe(3);

    a.release();
    await b.ready;
    expect(b.waiting()).toBe(false);
    expect(c.waiting()).toBe(true);

    b.release();
    b.release(); // 调用两次只算一次，不会把 c 也放过去
    await c.ready;
    expect(slot.busy).toBe(1);
    c.release();
    expect(slot.busy).toBe(0);
  });

  test('排队时不排了：从队里拿掉，不影响后面的', async (): Promise<void> => {
    const slot: DownloadSlot = new DownloadSlot();
    const a: SlotTicket = slot.take();
    const b: SlotTicket = slot.take();
    const c: SlotTicket = slot.take();

    b.release();
    a.release();
    await c.ready;
    expect(c.waiting()).toBe(false);
    expect(slot.busy).toBe(1);
  });

  test('withDownloadSlot：前一场下完才开始，排队时提示一次', async (): Promise<void> => {
    const slot: DownloadSlot = new DownloadSlot();
    const first: { promise: Promise<void>; resolve: () => void } = deferred();
    const order: Array<string> = [];
    const onWaiting: jest.Mock = jest.fn();

    const one: Promise<void> = withDownloadSlot(async (): Promise<void> => {
      order.push('一开始');
      await first.promise;
      order.push('一结束');
    }, { slot });
    const two: Promise<void> = withDownloadSlot((): Promise<void> => {
      order.push('二开始');

      return Promise.resolve();
    }, { slot, onWaiting });

    await flush();
    expect(order).toEqual(['一开始']);
    expect(onWaiting).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(['一开始', '一结束', '二开始']);
    expect(slot.busy).toBe(0);
  });

  test('withDownloadSlot：下载失败也让给下一场', async (): Promise<void> => {
    const slot: DownloadSlot = new DownloadSlot();

    await expect(withDownloadSlot((): Promise<void> => Promise.reject(new Error('断开了')), { slot })).rejects.toThrow('断开了');
    await expect(withDownloadSlot((): Promise<string> => Promise.resolve('好了'), { slot })).resolves.toBe('好了');
  });

  test('withDownloadSlot：排队时点了停止，不再开始，也不占位', async (): Promise<void> => {
    const slot: DownloadSlot = new DownloadSlot();
    const first: { promise: Promise<void>; resolve: () => void } = deferred();
    const controller: AbortController = new AbortController();
    const task: jest.Mock = jest.fn((): Promise<void> => Promise.resolve());

    const one: Promise<void> = withDownloadSlot((): Promise<void> => first.promise, { slot });
    const two: Promise<void> = withDownloadSlot(task, { slot, signal: controller.signal });

    await flush();
    controller.abort();
    await expect(two).rejects.toBeInstanceOf(DownloadWaitStopped);
    expect(slot.busy).toBe(1);

    first.resolve();
    await one;
    expect(task).not.toHaveBeenCalled();
    expect(slot.busy).toBe(0);
  });
});
