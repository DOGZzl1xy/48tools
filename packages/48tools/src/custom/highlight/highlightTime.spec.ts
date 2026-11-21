/**
 * 录播自动切片里和时间有关的计算：读弹幕文件、分段、合并爆点、决定做几个、文件名。
 */
import { toSeconds, clock, parseLrc, planWindows, mergeHighlights, targetCount, safeFileName, postTitle, cleanPeople } from './highlightTime';
import type { Highlight } from './highlightTypes';

function highlight(start: number, end: number, score: number, title: string = '标题'): Highlight {
  return { start, end, score, title, cover: '', quote: '', reason: '' };
}

describe('toSeconds / clock', (): void => {
  test('MM:SS、HH:MM:SS、数字都能读', (): void => {
    expect(toSeconds('10:42')).toBe(642);
    expect(toSeconds('1:02:03')).toBe(3_723);
    expect(toSeconds(12.5)).toBe(12.5);
    expect(toSeconds(' 00:07 ')).toBe(7);
  });

  test('看不懂的是 NaN', (): void => {
    expect(toSeconds('大概十分钟')).toBeNaN();
    expect(toSeconds(undefined)).toBeNaN();
    expect(toSeconds('1:2:3:4')).toBeNaN();
    expect(toSeconds('10:')).toBeNaN();
  });

  test('秒数显示成时间', (): void => {
    expect(clock(642)).toBe('10:42');
    expect(clock(3_723)).toBe('1:02:03');
    expect(clock(-3)).toBe('00:00');
  });
});

describe('parseLrc', (): void => {
  test('读出时间、昵称、内容，按时间排好，空的不要', (): void => {
    const list: ReturnType<typeof parseLrc> = parseLrc([
      '[00:01:03.500]小蘑菇\t晚上好',
      '[00:00:20.437]阿树（测试）\t怎么又播了',
      '[00:00:30.000]没有内容\t   ',
      '不是弹幕的一行'
    ].join('\n'));

    expect(list).toEqual([
      { time: 20.437, nickname: '阿树（测试）', message: '怎么又播了' },
      { time: 63.5, nickname: '小蘑菇', message: '晚上好' }
    ]);
  });
});

describe('planWindows', (): void => {
  test('不到半小时就是一段', (): void => {
    expect(planWindows(1_200)).toEqual([{ start: 0, length: 1_200 }]);
  });

  test('每段半小时，相邻两段重叠两分钟', (): void => {
    expect(planWindows(3_489)).toEqual([
      { start: 0, length: 1_800 },
      { start: 1_680, length: 1_809 }
    ]);
  });

  test('最后剩下不到五分钟就并进前一段', (): void => {
    expect(planWindows(2_000)).toEqual([{ start: 0, length: 2_000 }]);
  });

  test('很长的录播', (): void => {
    const windows: ReturnType<typeof planWindows> = planWindows(7_200);

    expect(windows.map((item: { start: number }): number => item.start)).toEqual([0, 1_680, 3_360, 5_040, 6_720]);
    expect(windows[4].start + windows[4].length).toBe(7_200);
  });
});

describe('mergeHighlights', (): void => {
  test('按分数从高到低，重叠一半以上的只留分高的', (): void => {
    const merged: Array<Highlight> = mergeHighlights([
      highlight(1_700, 1_780, 7, '前一段找到的'),
      highlight(1_705, 1_790, 9, '后一段找到的同一件事'),
      highlight(100, 200, 8, '别的')
    ]);

    expect(merged.map((item: Highlight): string => item.title)).toEqual(['后一段找到的同一件事', '别的']);
  });

  test('只擦到一点边的都留着；时间不对的去掉', (): void => {
    const merged: Array<Highlight> = mergeHighlights([
      highlight(0, 100, 8, '甲'),
      highlight(95, 200, 8, '乙'),
      highlight(300, 250, 10, '结束比开始早'),
      highlight(NaN, 50, 10, '没有时间')
    ]);

    expect(merged.map((item: Highlight): string => item.title).sort()).toEqual(['乙', '甲']);
  });
});

describe('targetCount', (): void => {
  const sorted: Array<Highlight> = [highlight(0, 60, 9.5), highlight(100, 160, 9), highlight(200, 260, 8.5), highlight(300, 360, 5)];

  test('选了数量就按数量，不够就有几个做几个', (): void => {
    expect(targetCount(sorted, 2, 3_600)).toBe(2);
    expect(targetCount(sorted, 8, 3_600)).toBe(4);
  });

  test('自动：只做 8.5 分以上的；门槛可以改', (): void => {
    expect(targetCount(sorted, 'auto', 3_600)).toBe(3);
    expect(targetCount(sorted, 'auto', 3_600, 9)).toBe(2);
    expect(targetCount(sorted, 'auto', 3_600, 9.5)).toBe(1);
  });

  test('自动：短的录播最多的个数跟着变少', (): void => {
    expect(targetCount(sorted, 'auto', 400)).toBe(1);
  });

  test('自动：没有够分的，最高的有 7 分也做一个', (): void => {
    expect(targetCount([highlight(0, 60, 8), highlight(100, 160, 8)], 'auto', 3_600)).toBe(1);
    expect(targetCount([highlight(0, 60, 7)], 'auto', 3_600)).toBe(1);
    expect(targetCount([highlight(0, 60, 6.5)], 'auto', 3_600)).toBe(0);
    expect(targetCount([], 'auto', 3_600)).toBe(0);
  });
});

describe('postTitle', (): void => {
  test('【名字】短标题 | 日期 直播切片', (): void => {
    expect(postTitle('SNH48 沈馨', '2026.11.15', '忘切小号用大号自吹好萌')).toBe('【沈馨】忘切小号用大号自吹好萌 | 20261115 直播切片');
    expect(postTitle('SNH48-沈馨', '2026-11-15', ' 标题 ')).toBe('【沈馨】标题 | 20261115 直播切片');
  });

  test('没有名字或日期时不留空的括号', (): void => {
    expect(postTitle('', '', '标题')).toBe('标题 | 直播切片');
  });

  test('有其他主角时用 & 连在主播后面', (): void => {
    expect(postTitle('SNH48 测试成员', '2026.11.15', '标题', ['成员乙'])).toBe('【测试成员&成员乙】标题 | 20261115 直播切片');
    expect(postTitle('SNH48 测试成员', '2026.11.15', '标题', ['成员乙', '成员丙'])).toBe('【测试成员&成员乙&成员丙】标题 | 20261115 直播切片');
  });
});

describe('cleanPeople', (): void => {
  test('去掉队伍名、主播自己、重复的和空的，最多 3 个', (): void => {
    expect(cleanPeople(['SNH48-成员乙', ' 成员乙 ', '测试成员', '', 'GNZ48 成员丙'], 'SNH48 测试成员')).toEqual(['成员乙', '成员丙']);
    expect(cleanPeople(['甲', '乙', '丙', '丁'], '测试成员')).toEqual(['甲', '乙', '丙']);
  });

  test('不是名字的东西不要：太长的一句话、带括号的', (): void => {
    expect(cleanPeople(['一个不知道是谁的很长很长的描述性文字', '【成员乙】'], '测试成员')).toEqual(['成员乙']);
  });

  test('模型没给或者给的不是列表', (): void => {
    expect(cleanPeople(undefined, '测试成员')).toEqual([]);
    expect(cleanPeople('成员乙', '测试成员')).toEqual([]);
  });
});

describe('safeFileName', (): void => {
  test('去掉不能用在文件名里的字符', (): void => {
    expect(safeFileName('忘切小号！用大号自吹"好萌"?')).toBe('忘切小号！用大号自吹 好萌');
    expect(safeFileName('a/b\\c:d')).toBe('a b c d');
    expect(safeFileName('结尾有点... ')).toBe('结尾有点');
  });

  test('太长就截断，空的给个名字', (): void => {
    expect(safeFileName('一二三四五六', 4)).toBe('一二三四');
    expect(safeFileName('???')).toBe('未命名');
  });
});
