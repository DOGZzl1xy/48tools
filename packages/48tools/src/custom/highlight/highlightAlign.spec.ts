/**
 * 录播自动切片里把字幕的时间对回声音上：找音节、按停顿分段、整体挪动、每句归到哪一段、段里按字数分音节。
 */
import {
  envelopeOf, syllablePeaks, countChars, stretchesOf, bestOffset, assignLines, placeLines, alignLines, type Stretch
} from './highlightAlign';
import type { CaptionLine, Silence } from './highlightTypes';

function line(start: number, end: number, text: string, keep: boolean = true): CaptionLine {
  return { start, end, text, keep, emphasis: [] };
}

/* 一段假的声音：在 beats 这些时刻各有一个 0.12 秒的音节，其余时间是很小的底噪 */
function fakeSamples(length: number, beats: Array<number>, rate: number = 8_000): Int16Array {
  const samples: Int16Array = new Int16Array(Math.round(length * rate));

  for (let index: number = 0; index < samples.length; index++) {
    const time: number = index / rate;
    const near: number | undefined = beats.find((at: number): boolean => time >= at && time < at + 0.12);
    const amplitude: number = near === undefined ? 20 : 8_000 * Math.sin(((time - near) / 0.12) * Math.PI);

    samples[index] = Math.round(amplitude * Math.sin(index * 0.9));
  }

  return samples;
}

/* 从 start 开始每 0.2 秒一个音节，一共 count 个 */
function syllables(start: number, count: number): Array<number> {
  return Array.from({ length: count }, (item: unknown, index: number): number => Number((start + (index * 0.2)).toFixed(2)));
}

function times(lines: Array<CaptionLine>): Array<Array<number>> {
  return lines.map((item: CaptionLine): Array<number> => [Number(item.start.toFixed(2)), Number(item.end.toFixed(2))]);
}

describe('找音节', (): void => {
  test('音量包络每 10 毫秒一个值', (): void => {
    const envelope: Array<number> = envelopeOf(fakeSamples(2, [0.5, 1.2]), 8_000);

    expect(envelope).toHaveLength(200);
    expect(envelope[56]).toBeGreaterThan(1_000);
    expect(envelope[100]).toBeLessThan(50);
  });

  test('每个音节一个峰，底噪里没有', (): void => {
    const peaks: Array<number> = syllablePeaks(envelopeOf(fakeSamples(4, [0.5, 0.7, 0.9, 2.5, 2.7]), 8_000));

    expect(peaks).toHaveLength(5);
    expect(peaks.map((time: number): number => Number(time.toFixed(1)))).toEqual([0.6, 0.8, 1, 2.6, 2.8]);
    expect(syllablePeaks(envelopeOf(fakeSamples(2, []), 8_000))).toEqual([]);
  });
});

describe('字数和分段', (): void => {
  test('标点和空格不算字', (): void => {
    expect(countChars('然后呢，我还跟我室友一起吃的呢！')).toBe(14);
    expect(countChars('OK 好的 99')).toBe(6);
    expect(countChars('……')).toBe(0);
  });

  test('两段停顿之间是一段声音；太短的不算', (): void => {
    const silences: Array<Silence> = [{ start: 0, end: 1 }, { start: 5, end: 6 }, { start: 6.1, end: 7 }, { start: 9, end: 10 }];

    expect(stretchesOf(silences, 10)).toEqual([{ start: 1, end: 5 }, { start: 7, end: 9 }]);
    expect(stretchesOf([], 4)).toEqual([{ start: 0, end: 4 }]);
    expect(stretchesOf([{ start: 2, end: 3 }], 6)).toEqual([{ start: 0, end: 2 }, { start: 3, end: 6 }]);
  });
});

describe('整体挪动', (): void => {
  const stretches: Array<Stretch> = [{ start: 2, end: 6 }, { start: 8, end: 11 }];

  test('整段早了 1.5 秒：找回来', (): void => {
    expect(bestOffset([line(0.5, 4.5, '一二三四'), line(6.5, 9.5, '五六七')], stretches)).toBeCloseTo(1.5);
  });

  test('本来就对的不动', (): void => {
    expect(bestOffset([line(2, 6, '一二三四'), line(8, 11, '五六七')], stretches)).toBe(0);
  });
});

describe('每句话归到哪一段', (): void => {
  const stretches: Array<Stretch> = [{ start: 2, end: 6 }, { start: 8, end: 9 }, { start: 12, end: 16 }];

  test('落在停顿里的句子归到离它近、装得下的那一段', (): void => {
    // 第二句整句在停顿里（6 ~ 8），离两边一样近，但前一段已经装满了（20 个字要 5 秒，那一段只有 4 秒），所以归到后一段
    const lines: Array<CaptionLine> = [line(2.1, 5.9, '一二三四五六七八九十一二三四五六七八九十'), line(6.2, 7.8, '短的'), line(12.5, 15.5, '一二三四五六七八九十')];

    expect(assignLines(lines, stretches, 4)).toEqual([0, 1, 2]);
    // 前一段没满的时候，一样近就归到前面
    expect(assignLines([line(2.1, 5.9, '一二三四五六七八'), lines[1], lines[2]], stretches, 4)).toEqual([0, 0, 2]);
    // 明显离后一段近
    expect(assignLines([line(2.1, 5.9, '一二三四五六七八'), line(7, 7.9, '短的'), lines[2]], stretches, 4)).toEqual([0, 1, 2]);
  });

  test('顺序不能乱；一段可以放好几句，也可以空着', (): void => {
    const lines: Array<CaptionLine> = [line(2, 3.5, '一二三四五'), line(3.5, 5.5, '六七八九十'), line(12, 15, '一二三四五六七八')];

    expect(assignLines(lines, stretches, 4)).toEqual([0, 0, 2]);
  });

  test('差得太远（要挪 6 秒以上）就不对了', (): void => {
    expect(assignLines([line(30, 32, '太远了')], stretches, 4)).toBeNull();
    expect(assignLines([], stretches, 4)).toBeNull();
  });
});

describe('段里按字数分音节', (): void => {
  test('第一句从这段声音开始的地方开始，最后一句到它结束的地方结束，中间在音节之间断开', (): void => {
    const stretches: Array<Stretch> = [{ start: 10, end: 13 }];
    // 15 个音节（10.0 ~ 12.8），第一句 5 个字、第二句 10 个字：在第 5、6 个音节之间断开
    const placed: Array<CaptionLine> = placeLines(
      [line(8.5, 9.5, '一二三四五'), line(9.5, 11.6, '一二三四五六七八九十')], stretches, [0, 0], syllables(10, 15), 5);

    expect(times(placed)).toEqual([[10, 10.9], [10.9, 13]]);
  });

  test('这一段比这些字该用的时间长得多（里面有笑声）：保持原来的时间，只是不伸到外面', (): void => {
    const stretches: Array<Stretch> = [{ start: 10, end: 30 }];
    const placed: Array<CaptionLine> = placeLines([line(9.5, 11, '一二三四'), line(20, 21.5, '五六七八')], stretches, [0, 0], syllables(10, 90), 4);

    expect(times(placed)).toEqual([[10, 11.5], [20, 21.5]]);
  });

  test('前面紧挨着一小段没人认领的声音：从它开始', (): void => {
    const stretches: Array<Stretch> = [{ start: 9.3, end: 9.5 }, { start: 10, end: 12 }];
    const placed: Array<CaptionLine> = placeLines([line(10, 12, '这个一二三四五六七')], stretches, [1], syllables(10, 10), 4.5);

    expect(times(placed)).toEqual([[9.3, 12]]);
  });
});

describe('alignLines', (): void => {
  // 两段话：2 ~ 6 秒（20 个音节）、8 ~ 11 秒（15 个音节），中间和前后是停顿
  const silences: Array<Silence> = [{ start: 0, end: 2 }, { start: 6, end: 8 }, { start: 11, end: 14 }];
  const peaks: Array<number> = [...syllables(2, 20), ...syllables(8, 15)];
  const right: Array<CaptionLine> = [
    line(2, 4, '一二三四五六七八九十'), line(4, 6, '一二三四五六七八九十'), line(8, 11, '一二三四五六七八九十一二三四五', false)
  ];
  const expected: Array<Array<number>> = [[2, 3.9], [3.9, 6], [8, 11]];

  test('时间本来就对：基本不变', (): void => {
    expect(times(alignLines(right, silences, peaks, 14))).toEqual(expected);
  });

  test('整段早了 1.5 秒（第一句大半落在停顿里）：对回去，结果和时间对的那份一样', (): void => {
    const early: Array<CaptionLine> = right.map((item: CaptionLine): CaptionLine => ({ ...item, start: item.start - 1.5, end: item.end - 1.5 }));

    expect(times(alignLines(early, silences, peaks, 14))).toEqual(expected);
  });

  test('越往后早得越多：也对得回去', (): void => {
    const drift: Array<CaptionLine> = [line(1.2, 3, '一二三四五六七八九十'), line(3, 4.5, '一二三四五六七八九十'), line(5.6, 8.4, '一二三四五六七八九十一二三四五', false)];

    expect(times(alignLines(drift, silences, peaks, 14))).toEqual(expected);
  });

  test('文字、留不留、重点词不变', (): void => {
    const aligned: Array<CaptionLine> = alignLines([{ start: 0.5, end: 4.5, text: '一二三四五六七八九十', keep: false, emphasis: ['三四'] }], silences, peaks, 14);

    expect(aligned[0]).toMatchObject({ text: '一二三四五六七八九十', keep: false, emphasis: ['三四'] });
  });

  test('没有句子、没有声音、对不上：原样返回', (): void => {
    const far: Array<CaptionLine> = [line(40, 42, '太远了')];

    expect(alignLines([], silences, peaks, 14)).toEqual([]);
    expect(alignLines(right, [{ start: 0, end: 14 }], [], 14)).toBe(right);
    expect(alignLines(far, [...silences.slice(0, 2), { start: 11, end: 60 }], peaks, 60)).toBe(far);
  });
});
