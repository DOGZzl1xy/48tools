/**
 * 分片预取：同时下几个、按顺序处理；一个停住时后面的照常往前下。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SegmentPrefetcher, SEGMENT_CONCURRENCY } from './segmentPrefetcher';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

describe('segmentPrefetcher', (): void => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-prefetcher-'));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function takeAll(prefetcher: SegmentPrefetcher, total: number, start: number = 0): Promise<Array<string>> {
    const out: Array<string> = [];

    for (let index: number = start; index < total; index++) {
      const dest: string = path.join(dir, 'current.ts');

      await prefetcher.take(index, dest);
      out.push(fs.readFileSync(dest, 'utf8'));
    }

    return out;
  }

  test('同时下 8 个，按顺序拿到', async (): Promise<void> => {
    let running: number = 0;
    let most: number = 0;
    const prefetcher: SegmentPrefetcher = new SegmentPrefetcher(30, dir, async (index: number, file: string): Promise<number> => {
      most = Math.max(most, ++running);
      await sleep(5 + ((index * 7) % 20)); // 快慢不一，完成的顺序是乱的
      fs.writeFileSync(file, String(index));
      running--;

      return 1;
    });

    expect(SEGMENT_CONCURRENCY).toBe(8);
    expect(await takeAll(prefetcher, 30)).toEqual(Array.from({ length: 30 }, (item: unknown, index: number): string => String(index)));
    expect(most).toBe(8);
    await prefetcher.close();
    expect(fs.readdirSync(dir)).toEqual(['current.ts']);
  });

  test('一个停住时后面的照常往前下，最多提前 ahead 个', async (): Promise<void> => {
    const started: Array<number> = [];
    let release!: () => void;
    const stuck: Promise<void> = new Promise((resolve: () => void): void => {
      release = resolve;
    });
    const prefetcher: SegmentPrefetcher = new SegmentPrefetcher(60, dir, async (index: number, file: string): Promise<number> => {
      started.push(index);
      index === 2 && await stuck;
      await sleep(1);
      fs.writeFileSync(file, String(index));

      return 1;
    }, 4, 0, 20);
    const all: Promise<Array<string>> = takeAll(prefetcher, 60);

    await sleep(400);
    expect(Math.max(...started)).toBe(21); // 第 2 个停住：下到它后面第 20 个为止
    release();
    expect(await all).toHaveLength(60);
    expect(started).toHaveLength(60); // 每个只下一次
    await prefetcher.close();
  });

  test('接着上次的下：从 start 开始', async (): Promise<void> => {
    const started: Array<number> = [];
    const prefetcher: SegmentPrefetcher = new SegmentPrefetcher(12, dir, (index: number, file: string): Promise<number> => {
      started.push(index);
      fs.writeFileSync(file, String(index));

      return Promise.resolve(1);
    }, undefined, 9);

    expect(await takeAll(prefetcher, 12, 9)).toEqual(['9', '10', '11']);
    expect(started).toEqual([9, 10, 11]);
    await prefetcher.close();
  });

  test('有一个怎么都下不来：轮到它时报错，关闭后不再下新的，临时文件删掉', async (): Promise<void> => {
    let started: number = 0;
    const prefetcher: SegmentPrefetcher = new SegmentPrefetcher(200, dir, async (index: number, file: string): Promise<number> => {
      started++;
      await sleep(5);

      if (index === 3) throw new Error('第 4 个分片失败');

      fs.writeFileSync(file, String(index));

      return 1;
    });

    await expect(takeAll(prefetcher, 200)).rejects.toThrow('第 4 个分片失败');
    await prefetcher.close();

    const count: number = started;

    await sleep(60);
    expect(started).toBe(count);
    expect(fs.readdirSync(dir)).toEqual(['current.ts']);
  });
});
