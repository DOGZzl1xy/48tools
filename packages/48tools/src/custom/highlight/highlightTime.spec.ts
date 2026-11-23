/**
 * 录播自动切片里和时间有关的计算：读弹幕文件、分段、合并爆点、决定做几个、文件名。
 */
import {
  toSeconds, clock, parseLrc, planWindows, mergeHighlights, targetCount, safeFileName, postTitle, cleanPeople,
  isGiftDanmu, isReactionDanmu, danmuHeat, clipWindow, clipLengthProblem, clipLengthNote, CLIP_MIN_SECONDS, CLIP_MAX_SECONDS,
  RETRY_EXTRA_CONTEXT
} from './highlightTime';
import type { DanmuLine, Highlight } from './highlightTypes';

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

describe('planWindows：每段的长度和重叠可以改', (): void => {
  test('一小时、20 分钟一段、重叠 5 分钟：0~20、15~35、30~50、45~60', (): void => {
    expect(planWindows(3_600, 1_200, 300)).toEqual([
      { start: 0, length: 1_200 }, { start: 900, length: 1_200 }, { start: 1_800, length: 1_200 }, { start: 2_700, length: 900 }
    ]);
  });

  test('最后剩下不到 5 分钟就并进前一段', (): void => {
    expect(planWindows(1_400, 1_200, 300)).toEqual([{ start: 0, length: 1_400 }]);
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

  test('片段里有另外的爆点：短标题用 | 接在主标题后面', (): void => {
    expect(postTitle('SNH48 测试成员', '2026.11.21', '全队全是萝莉', [], ['傻瓜也是瓜'])).toBe('【测试成员】全队全是萝莉 | 傻瓜也是瓜 | 20261121 直播切片');
    expect(postTitle('SNH48 测试成员', '2026.11.21', '主标题', ['成员乙'], ['第二个', ' ', '第三个'])).toBe('【测试成员&成员乙】主标题 | 第二个 | 第三个 | 20261121 直播切片');
  });

  test('和主标题说的是同一句话的不接', (): void => {
    expect(postTitle('SNH48 测试成员', '2026.11.21', '在台上给自己跳笑是什么体验', [], ['在台上给自己跳笑', '第二个'])).toBe('【测试成员】在台上给自己跳笑是什么体验 | 第二个 | 20261121 直播切片');
    expect(postTitle('SNH48 测试成员', '2026.11.21', '跳笑', [], ['在台上给自己跳笑'])).toBe('【测试成员】跳笑 | 20261121 直播切片');
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

describe('弹幕热度', (): void => {
  function line(time: number, message: string): DanmuLine {
    return { time, nickname: '测试粉丝', message };
  }

  test('礼物消息和反应词', (): void => {
    expect(isGiftDanmu('送给SNH48-测试成员 1个荧光棒-SII')).toBe(true);
    expect(isGiftDanmu('送给你一首歌')).toBe(false);
    expect(['爆', '典中典', '串子快滚', '？？？', '哈哈哈哈', '绷不住了', '谁哭了？'].every(isReactionDanmu)).toBe(true);
    expect(['晚上好', '今天吃什么', '哈哈'].some(isReactionDanmu)).toBe(false);
  });

  test('弹幕突然变多、反应扎堆的时刻：时间是这一段里的，礼物不算', (): void => {
    const danmu: Array<DanmuLine> = [
      // 平时：每半分钟两条
      ...Array.from({ length: 60 }, (item: unknown, index: number): DanmuLine => line(1_800 + (index * 15), '日常聊天')),
      // 1800 + 600 秒起：一下子十条，其中六条是反应
      ...['爆', '爆', '？？？', '哈哈哈哈', '典', '绷', '这也行', '好家伙吗', '我不理解', '真的假的'].map(
        (message: string, index: number): DanmuLine => line(2_400 + index, message)),
      // 礼物刷屏不算
      ...Array.from({ length: 20 }, (item: unknown, index: number): DanmuLine => line(2_000 + index, '送给SNH48-测试成员 1个荧光棒')),
      // 这一段以外的不算
      ...Array.from({ length: 20 }, (item: unknown, index: number): DanmuLine => line(100 + index, '爆'))
    ];
    const heat: Array<string> = danmuHeat(danmu, { start: 1_800, length: 900 });

    expect(heat).toHaveLength(1);
    expect(heat[0]).toContain('10:00 起的 30 秒：12 条弹幕（平时约 2 条）');
    expect(heat[0]).toContain('其中反应 7 条');
    expect(heat[0]).toContain('「爆」');
  });

  test('没有明显的高峰时什么都不给', (): void => {
    expect(danmuHeat(Array.from({ length: 40 }, (item: unknown, index: number): DanmuLine => line(index * 20, '日常聊天')), { start: 0, length: 900 })).toEqual([]);
    expect(danmuHeat([], { start: 0, length: 900 })).toEqual([]);
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

describe('切片的长度', (): void => {
  test('成片 45 秒到 5 分钟', (): void => {
    expect([CLIP_MIN_SECONDS, CLIP_MAX_SECONDS]).toEqual([45, 300]);
    expect(clipLengthProblem(44.9)).toBe('short');
    expect(clipLengthProblem(45)).toBeNull();
    expect(clipLengthProblem(300)).toBeNull();
    expect(clipLengthProblem(300.5)).toBe('long');
  });

  test('交给模型的音频：爆点前后各多留十几秒；爆点很短时至少给 90 秒，好把铺垫和后续留下', (): void => {
    expect(clipWindow({ start: 600, end: 720 }, 3_600)).toEqual({ start: 585, length: 147 });
    expect(clipWindow({ start: 600, end: 630 }, 3_600)).toEqual({ start: 568.5, length: 90 });
  });

  test('碰到录播开头、结尾时往另一边补', (): void => {
    expect(clipWindow({ start: 5, end: 20 }, 3_600)).toEqual({ start: 0, length: 90 });
    expect(clipWindow({ start: 3_580, end: 3_595 }, 3_600)).toEqual({ start: 3_510, length: 90 });
  });

  test('剪完太短重做时前后各再多给 30 秒', (): void => {
    expect(clipWindow({ start: 600, end: 720 }, 3_600, RETRY_EXTRA_CONTEXT)).toEqual({ start: 555, length: 207 });
  });

  test('重做时告诉模型的话：实际多长、要往哪边改', (): void => {
    expect(clipLengthNote('short', 31.4)).toContain('只有 31 秒');
    expect(clipLengthNote('short', 31.4)).toContain('铺垫');
    expect(clipLengthNote('long', 333)).toContain('有 333 秒，超过了 5 分钟');
    expect(clipLengthNote('long', 333)).toContain('45 秒到 5 分钟');
  });
});
