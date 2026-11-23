/**
 * 公演切片里失误、唱歌的起止（./highlightStageTiming）：失误按弹幕的反应，唱歌按伴奏的低频。
 * 数字照着 2026-11-22 NII 公演的实际情况编：平时 10 秒十几条，失误时 10 秒五六十条；唱歌时低频 60 dB，说话、掌声时 5 ~ 20 dB。
 */
import { reactionCounts, locateMistake, musicRuns, locateSong, LOW_BAND_STEP } from './highlightStageTiming';
import type { DanmuLine, Highlight } from './highlightTypes';

function highlight(extra: Partial<Highlight>): Highlight {
  return { start: 0, end: 0, title: '标题', cover: '', quote: '', reason: '', score: 9, ...extra };
}

/* 平时的弹幕：每秒一条，每条都不一样 */
function usualDanmu(from: number, to: number): Array<DanmuLine> {
  return Array.from({ length: to - from }, (_item: unknown, index: number): DanmuLine => ({ time: from + index + 0.5, nickname: '', message: `第${ from + index }条` }));
}

/* 一段时间里每秒 n 条反应 */
function burst(from: number, to: number, perSecond: number, words: Array<string>): Array<DanmuLine> {
  const out: Array<DanmuLine> = [];

  for (let time: number = from; time < to; time++) {
    for (let index: number = 0; index < perSecond; index++) out.push({ time: time + (index / perSecond), nickname: '', message: words[(time + index) % words.length] });
  }

  return out;
}

describe('弹幕去重', (): void => {
  test('同一句应援 30 秒里最多算 2 条（去掉表情和标点后一样也算同一句）；反应不去重；礼物不算', (): void => {
    const danmu: Array<DanmuLine> = [
      ...Array.from({ length: 20 }, (_item: unknown, index: number): DanmuLine => ({ time: index, nickname: '', message: index % 2 ? '小牛🧡小牛🧡' : '小牛小牛！' })),
      ...Array.from({ length: 5 }, (_item: unknown, index: number): DanmuLine => ({ time: index, nickname: '', message: '咋了' })),
      { time: 3, nickname: '', message: '送给 小牛 1个心锁' },
      { time: 40, nickname: '', message: '小牛小牛' }
    ];
    const counts: Array<number> = reactionCounts(danmu, 0, 60);

    expect(counts.reduce((sum: number, value: number): number => sum + value, 0)).toBe(2 + 5 + 1);
    expect(counts[40]).toBe(1); // 过了 30 秒又能算了
  });
});

describe('失误的起止：按弹幕的反应', (): void => {
  // 2100 秒开始弹幕暴涨（停音乐了），持续 70 秒
  const danmu: Array<DanmuLine> = [
    ...usualDanmu(1_500, 2_700),
    ...burst(2_100, 2_170, 5, ['咋了', '啥意思', '重开', '哈哈哈哈', '控台开早了', '什么情况'])
  ];

  test('从弹幕开始涨的地方往前留 19 秒，到回落以后几秒；模型的时间偏了一分钟也一样', (): void => {
    for (const start of [2_060, 2_120, 2_030]) {
      const timing: ReturnType<typeof locateMistake> = locateMistake(highlight({ kind: 'mistake', start, end: start + 80 }), danmu, 7_200);

      expect(timing.start).toBeGreaterThanOrEqual(2_100 - 26);
      expect(timing.start).toBeLessThanOrEqual(2_100 - 15);
      expect(timing.end).toBeGreaterThanOrEqual(2_170);
      expect(timing.end).toBeLessThanOrEqual(2_170 + 12);
      expect(timing.how).toContain('按弹幕的反应');
    }
  });

  test('模型抄来的弹幕时间：以它为中心找，旁边更高的高峰不会把它吸走', (): void => {
    const two: Array<DanmuLine> = [...danmu, ...burst(2_400, 2_420, 9, ['哈哈哈哈', '笑死'])];
    const near: ReturnType<typeof locateMistake> = locateMistake(highlight({ kind: 'mistake', start: 2_200, end: 2_300, reaction: 2_105 }), two, 7_200);

    expect(near.start).toBeLessThan(2_100);
    expect(near.end).toBeLessThan(2_300);
  });

  test('附近弹幕没有明显变多：用模型给的时间，前后各多留 5 秒', (): void => {
    const timing: ReturnType<typeof locateMistake> = locateMistake(highlight({ kind: 'mistake', start: 1_800, end: 1_840 }), usualDanmu(1_500, 2_700), 7_200);

    expect(timing).toMatchObject({ start: 1_795, end: 1_845 });
    expect(timing.how).toContain('没有明显的反应');
  });

  test('一直有人刷名字应援：去重以后不算高峰', (): void => {
    const cheers: Array<DanmuLine> = [...usualDanmu(1_500, 2_700), ...burst(1_790, 1_850, 8, ['小牛小牛小牛', '小羊🧡小羊🧡'])];

    expect(locateMistake(highlight({ kind: 'mistake', start: 1_800, end: 1_840 }), cheers, 7_200).how).toContain('没有明显的反应');
  });

  test('弹幕太少（录像开头）：用模型给的时间', (): void => {
    expect(locateMistake(highlight({ kind: 'mistake', start: 10, end: 40 }), [], 7_200)).toMatchObject({ start: 5, end: 45 });
  });
});

/* 低频能量：给出每一段的 dB，按 LOW_BAND_STEP 一格 */
function levels(parts: Array<[number, number]>): Array<number> {
  return parts.flatMap(([seconds, db]: [number, number]): Array<number> => new Array(Math.round(seconds / LOW_BAND_STEP)).fill(db));
}

describe('唱歌的起止：按伴奏', (): void => {
  // 从第 1000 秒开始：说话 60 秒 → 歌 160 秒 → 停 5 秒 → 下一首 215 秒 → 掌声和说话 120 秒
  const from: number = 1_000;
  const track: Array<number> = levels([[60, 8], [160, 60], [5, 15], [215, 61], [120, 12]]);

  test('一首歌是低频里连续的一块；中间一秒的停顿不算断开', (): void => {
    const withGap: Array<number> = levels([[30, 8], [50, 60], [1, 10], [50, 60], [30, 8]]);

    expect(musicRuns(track)).toEqual([{ start: 60, end: 220 }, { start: 225, end: 440 }]);
    expect(musicRuns(withGap)).toEqual([{ start: 30, end: 131 }]);
    expect(musicRuns(levels([[300, 30]]))).toEqual([]); // 听不出伴奏
  });

  test('取和模型给的时间重叠一半以上的那首；模型偏了半分钟以上也对得上；相邻只隔 5 秒的另一首不算进来', (): void => {
    expect(locateSong(highlight({ kind: 'song', start: 1_060, end: 1_220 }), track, from, 7_200)).toMatchObject({ start: 1_060, end: 1_220 });
    expect(locateSong(highlight({ kind: 'song', start: 1_100, end: 1_260 }), track, from, 7_200)).toMatchObject({ start: 1_060, end: 1_220 });
    expect(locateSong(highlight({ kind: 'song', start: 1_190, end: 1_410 }), track, from, 7_200)).toMatchObject({ start: 1_225, end: 1_440 });
  });

  test('模型说的是连着的两首：两首都要', (): void => {
    expect(locateSong(highlight({ kind: 'song', start: 1_050, end: 1_450 }), track, from, 7_200)).toMatchObject({ start: 1_060, end: 1_440 });
  });

  test('听不出伴奏，或者附近没有歌：用模型给的时间，前面多留 8 秒、后面 6 秒', (): void => {
    const flat: ReturnType<typeof locateSong> = locateSong(highlight({ kind: 'song', start: 1_100, end: 1_300 }), levels([[600, 30]]), from, 7_200);

    expect(flat).toMatchObject({ start: 1_092, end: 1_306 });
    expect(flat.how).toContain('听不出伴奏');
    expect(locateSong(highlight({ kind: 'song', start: 1_480, end: 1_540 }), track, from, 7_200).how).toContain('附近没有伴奏');
  });
});
