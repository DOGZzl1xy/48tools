import { sortDanmu, countUpTo, shortTime } from './danmuTimeline';
import type { DanmuItem } from '../../pages/PlayerWindow/types';

function item(currentTime: number, vid: string): DanmuItem {
  return { time: '', currentTime, endTimeString: '', nickname: 'n', message: 'm', vid };
}

describe('danmuTimeline', function(): void {
  test('sortDanmu sorts by time and keeps file order for equal times', function(): void {
    const list: Array<DanmuItem> = [item(5, 'a'), item(1, 'b'), item(5, 'c'), item(0.5, 'd')];
    const sorted: Array<DanmuItem> = sortDanmu(list);

    expect(sorted.map((o: DanmuItem): string => o.vid)).toEqual(['d', 'b', 'a', 'c']);
    expect(list.map((o: DanmuItem): string => o.vid)).toEqual(['a', 'b', 'c', 'd']); // 不改原数组
  });

  test('countUpTo returns how many items have appeared at a given time', function(): void {
    const list: Array<DanmuItem> = [item(1, 'a'), item(2, 'b'), item(2, 'c'), item(10, 'd')];

    expect(countUpTo(list, 0)).toBe(0);
    expect(countUpTo(list, 0.99)).toBe(0);
    expect(countUpTo(list, 1)).toBe(1);
    expect(countUpTo(list, 2)).toBe(3);
    expect(countUpTo(list, 9.9)).toBe(3);
    expect(countUpTo(list, 10)).toBe(4);
    expect(countUpTo(list, 99999)).toBe(4);
    expect(countUpTo([], 5)).toBe(0);
  });

  test('shortTime formats seconds', function(): void {
    expect(shortTime(0)).toBe('0:00');
    expect(shortTime(343.453)).toBe('5:43');
    expect(shortTime(3_903)).toBe('1:05:03');
    expect(shortTime(-3)).toBe('0:00');
  });
});
