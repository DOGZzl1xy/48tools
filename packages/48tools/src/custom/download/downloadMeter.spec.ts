import DownloadMeter from './downloadMeter';
import type { ProgressStats } from './formatProgress';

/* 时间自己走的速度表 */
function meterOf(count: number, pending?: Array<number>): { meter: DownloadMeter; go(ms: number): void } {
  let now: number = 1_000;
  const segments: Array<{ duration: number }> = Array.from({ length: count }, (): { duration: number } => ({ duration: 5 }));

  return {
    meter: new DownloadMeter(segments, pending, (): number => now),
    go(ms: number): void {
      now += ms;
    }
  };
}

describe('downloadMeter：速度和剩余时间', (): void => {
  test('匀速下载', (): void => {
    const { meter, go }: ReturnType<typeof meterOf> = meterOf(100);
    let stats: ProgressStats = {};

    for (let index: number = 0; index < 50; index++) {
      go(1_000);
      stats = meter.tick(index, 2_000);
    }

    expect(stats.speed).toBeCloseTo(2_000);
    expect(stats.eta).toBeCloseTo(50);
    expect(stats.downloaded).toBe(100_000);
  });

  test('一个停住 20 秒、后面的攒着一起处理：速度不会忽然变得离谱', (): void => {
    const { meter, go }: ReturnType<typeof meterOf> = meterOf(200);
    let stats: ProgressStats = {};

    for (let index: number = 0; index < 40; index++) {
      go(500);
      meter.tick(index, 2_000);
    }

    go(20_000); // 停住 20 秒，这期间后面 40 个都下好了

    for (let index: number = 40; index < 80; index++) stats = meter.tick(index, 2_000);

    expect(stats.speed).toBeGreaterThan(3_000);
    expect(stats.speed).toBeLessThan(5_000); // 真实速度 4000
  });

  test('断点续传：只算还没下的；不按顺序完成也可以', (): void => {
    const { meter, go }: ReturnType<typeof meterOf> = meterOf(20, [5, 12, 13, 14, 15]);
    let stats: ProgressStats = {};

    for (const index of [12, 5, 14]) {
      go(1_000);
      stats = meter.tick(index, 2_000);
    }

    expect(stats.eta).toBeCloseTo(2);

    for (const index of [13, 15]) {
      go(1_000);
      stats = meter.tick(index, 2_000);
    }

    expect(stats.eta).toBe(0);
  });
});
