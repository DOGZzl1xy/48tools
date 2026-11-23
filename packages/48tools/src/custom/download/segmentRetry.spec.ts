import { withRetry, retryWait, segmentViaProxy, RETRY_WAITS, PROXY_FROM_ATTEMPT } from './segmentRetry';

/* 不真的等：记下要等多久 */
function recorder(waits: Array<number>): (ms: number) => Promise<void> {
  return (ms: number): Promise<void> => {
    waits.push(ms);

    return Promise.resolve();
  };
}

describe('segmentRetry：分片失败后等得越来越久再重试', (): void => {
  test('等待时间从 2 秒起越来越长，最长 1 分钟，一共等 4 分钟以上', (): void => {
    expect(retryWait(1)).toBe(2_000);
    expect(RETRY_WAITS.every((ms: number, index: number): boolean => index === 0 || ms >= RETRY_WAITS[index - 1])).toBe(true);
    expect(Math.max(...RETRY_WAITS)).toBe(60_000);
    expect(RETRY_WAITS.reduce((sum: number, ms: number): number => sum + ms, 0)).toBeGreaterThanOrEqual(4 * 60_000);
    expect(retryWait(99)).toBe(60_000);
  });

  test('中间失败几次最后成功：照常返回，每次重试前按顺序等', async (): Promise<void> => {
    const waits: Array<number> = [];
    let calls: number = 0;

    const result: string = await withRetry((): Promise<string> => {
      calls++;

      return calls < 4 ? Promise.reject(new Error('The server aborted pending request')) : Promise.resolve('好了');
    }, { isStopped: (): boolean => false, sleep: recorder(waits) });

    expect(result).toBe('好了');
    expect(waits).toEqual([2_000, 5_000, 10_000]);
  });

  test('一直失败：重试完所有次数后报错，说明里写着重试了几次', async (): Promise<void> => {
    const waits: Array<number> = [];

    await expect(withRetry((): Promise<void> => Promise.reject(new Error('断开了')), {
      label: '第 3/10 个分片', isStopped: (): boolean => false, sleep: recorder(waits)
    })).rejects.toThrow(`第 3/10 个分片失败（已重试 ${ RETRY_WAITS.length } 次）：断开了`);
    expect(waits).toEqual(RETRY_WAITS);
  });

  test('每次都告诉下载函数这是第几次：前两次直连，之后走代理（个别分片从美国节点每次都下不来）', async (): Promise<void> => {
    const tries: Array<string> = [];

    const result: string = await withRetry((attempt: number): Promise<string> => {
      tries.push(segmentViaProxy(attempt) ? '代理' : '直连');

      return segmentViaProxy(attempt) ? Promise.resolve('好了') : Promise.reject(new Error('The server aborted pending request'));
    }, { isStopped: (): boolean => false, sleep: recorder([]) });

    expect(result).toBe('好了');
    expect(tries).toEqual(['直连', '直连', '代理']);
    expect(PROXY_FROM_ATTEMPT).toBe(2);
  });

  test('停止下载后不再重试', async (): Promise<void> => {
    let calls: number = 0;

    await expect(withRetry((): Promise<void> => {
      calls++;

      return Promise.reject(new Error('断开了'));
    }, { isStopped: (): boolean => true, sleep: recorder([]) })).rejects.toThrow('断开了');
    expect(calls).toBe(1);
  });
});
