/**
 * 录播自动切片的「剪」：整理模型给的句子、用静音修正时间、留下的句子拼成几段、时间换算。
 */
import { tidyLines, snapLines, buildSegments, toOut } from './highlightCut';
import type { CaptionLine, Segment } from './highlightTypes';

function line(start: number, end: number, keep: boolean = true, text: string = '一句话'): CaptionLine {
  return { start, end, text, keep, emphasis: [] };
}

describe('tidyLines', (): void => {
  test('按时间排好，空的、时间不对的去掉，相邻的不重叠', (): void => {
    const lines: Array<CaptionLine> = tidyLines([
      line(5, 9),
      line(1, 6),
      line(2, 3, true, '   '),
      line(NaN, 3),
      line(200, 210),
      { start: 10, end: 12, text: ' 有空格 ', keep: 'yes' as unknown as boolean, emphasis: ['重点', '', 3 as unknown as string] }
    ], 100);

    expect(lines.map((item: CaptionLine): Array<number> => [item.start, item.end])).toEqual([[1, 5], [5, 9], [10, 12]]);
    expect(lines[2]).toEqual({ start: 10, end: 12, text: '有空格', keep: false, emphasis: ['重点'] });
  });

  test('结束时间不超过片段长度', (): void => {
    expect(tidyLines([line(95, 120)], 100)[0].end).toBe(100);
  });
});

describe('snapLines', (): void => {
  test('开头落在静音里：从静音结束的地方开始', (): void => {
    // 模型说 36.9 开始，其实 36.98 ~ 38.29 是静音，38.29 才开口
    const [snapped]: Array<CaptionLine> = snapLines([line(36.9, 41)], [{ start: 36.98, end: 38.29 }]);

    expect(snapped.start).toBeCloseTo(38.19);
    expect(snapped.end).toBe(41);
  });

  test('结尾落在静音里：到静音开始的地方结束', (): void => {
    const [snapped]: Array<CaptionLine> = snapLines([line(7.3, 11.1)], [{ start: 10.19, end: 12.18 }]);

    expect(snapped.start).toBe(7.3);
    expect(snapped.end).toBeCloseTo(10.34);
  });

  test('句子中间的短暂停顿不动', (): void => {
    const [snapped]: Array<CaptionLine> = snapLines([line(10, 20)], [{ start: 14, end: 14.6 }]);

    expect([snapped.start, snapped.end]).toEqual([10, 20]);
  });
});

describe('buildSegments', (): void => {
  test('连着的句子是一段，开头结尾多留一点', (): void => {
    const { segments, total }: { segments: Array<Segment>; total: number } = buildSegments([line(10, 12), line(12.5, 15)], 100);

    expect(segments).toHaveLength(1);
    expect(segments[0].start).toBeCloseTo(9.7);
    expect(segments[0].end).toBeCloseTo(17.5); // 最后一句后面多留 2.5 秒
    expect(total).toBeCloseTo(7.8);
  });

  test('中间空得久就剪掉；不要的句子不会被带进来', (): void => {
    const lines: Array<CaptionLine> = [
      line(0, 4, false),       // 开头无关的话
      line(4.1, 8),
      line(8.2, 10),
      line(10.1, 14, false),   // 感谢礼物
      line(14.2, 18),
      line(25, 28),            // 前面沉默了 7 秒
      line(28.2, 30, false)
    ];
    const { segments, total }: { segments: Array<Segment>; total: number } = buildSegments(lines, 40);

    expect(segments.map((item: Segment): Array<number> => [item.from, item.to])).toEqual([[1, 2], [4, 4], [5, 5]]);
    expect(segments[0].start).toBeCloseTo(4);      // 不早于前一句不要的话结束的地方
    expect(segments[0].end).toBeCloseTo(10.1);     // 不晚于后一句不要的话开始的地方
    expect(segments[2].end).toBeCloseTo(28.2);
    expect(segments[1].out).toBeCloseTo(segments[0].end - segments[0].start);
    expect(total).toBeCloseTo(segments.reduce((sum: number, item: Segment): number => sum + (item.end - item.start), 0));
  });

  test('一句都没留', (): void => {
    expect(buildSegments([line(0, 4, false)], 10)).toEqual({ segments: [], total: 0 });
  });
});

describe('toOut', (): void => {
  const segments: Array<Segment> = [
    { from: 0, to: 0, start: 10, end: 20, out: 0 },
    { from: 1, to: 1, start: 30, end: 35, out: 10 }
  ];

  test('片段里的时间换成成片里的时间', (): void => {
    expect(toOut(segments, 12)).toBe(2);
    expect(toOut(segments, 31)).toBe(11);
  });

  test('被剪掉的地方是 null', (): void => {
    expect(toOut(segments, 25)).toBeNull();
    expect(toOut(segments, 5)).toBeNull();
  });
});
