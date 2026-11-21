/**
 * 录播自动切片的本地打轴：读识别程序的输出、两串字逐个对齐、用对上的字的时间给每句话定时间。
 */
import { parseRecognizerOutput, alignChars, timeLinesByTokens, digitsToChinese, type TimedToken, type TokenTiming } from './highlightTokens';
import type { CaptionLine } from './highlightTypes';

function line(start: number, end: number, text: string, keep: boolean = true): CaptionLine {
  return { start, end, text, keep, emphasis: [] };
}

/* 一串字从 start 开始、每 0.2 秒一个 */
function heard(text: string, start: number): Array<TimedToken> {
  return Array.from(text).map((ch: string, index: number): TimedToken => ({ text: ch, time: Number((start + (index * 0.2)).toFixed(2)) }));
}

function times(lines: Array<CaptionLine>): Array<Array<number>> {
  return lines.map((item: CaptionLine): Array<number> => [Number(item.start.toFixed(2)), Number(item.end.toFixed(2))]);
}

describe('读识别程序的输出', (): void => {
  test('一行 JSON 里的字和时间；别的行不管', (): void => {
    const out: string = [
      'Creating recognizer ...',
      '{"lang": "<|zh|>", "text": "开放时间", "timestamps": [0.66, 0.90, 1.26, 1.50], "tokens":["开", "放", "时", "间"], "words": []}',
      ''
    ].join('\r\n');

    expect(parseRecognizerOutput(out)).toEqual([
      { text: '开', time: 0.66 }, { text: '放', time: 0.9 }, { text: '时', time: 1.26 }, { text: '间', time: 1.5 }
    ]);
  });

  test('不是 JSON、没有字、时间不是数字：不报错', (): void => {
    expect(parseRecognizerOutput('')).toEqual([]);
    expect(parseRecognizerOutput('{"text": "只有文字"}')).toEqual([]);
    expect(parseRecognizerOutput('{坏的')).toEqual([]);
    expect(parseRecognizerOutput('{"tokens": ["一", "二"], "timestamps": [1, "x"]}')).toEqual([{ text: '一', time: 1 }]);
  });
});

describe('两串字逐个对齐', (): void => {
  test('完全一样', (): void => {
    expect(alignChars(['一', '二', '三'], ['一', '二', '三']).map((pair: { index: number }): number => pair.index)).toEqual([0, 1, 2]);
  });

  test('错字算对上但不算相同；多出来的字跳过；少的字是 -1', (): void => {
    // 文字：徐佳琳不可能；识别：许嘉玲他不可能（三个同音的错字，多一个「他」）
    const pairs: Array<{ index: number; same: boolean }> = alignChars(Array.from('徐佳琳不可能'), Array.from('许嘉玲他不可能'));

    // 「他」多出来，排在三个错字前面还是后面代价一样，这里是排在前面的那种
    expect(pairs.map((pair: { index: number }): number => pair.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pairs.map((pair: { same: boolean }): boolean => pair.same)).toEqual([false, false, false, true, true, true]);
    // 文字里有、识别里没有的字
    expect(alignChars(Array.from('我真的不喝'), Array.from('我不喝')).map((pair: { index: number }): number => pair.index)).toEqual([0, -1, -1, 1, 2]);
  });

  test('一个词说了两遍、只认出一遍：不把一句话里相邻的字对到隔着停顿的两处', (): void => {
    // 字幕两句：「天使给我点」「给我点费大厨」；识别出来的是「天使给我点」(10.0 起)、停顿、「费大厨」(14.0 起)
    const text: Array<string> = Array.from('天使给我点给我点费大厨');
    const group: Array<number> = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    const time: Array<number> = [10, 10.2, 10.4, 10.6, 10.8, 14, 14.2, 14.4];
    const pairs: Array<{ index: number; same: boolean }> = alignChars(text, Array.from('天使给我点费大厨'), { group, time });

    // 第一句的「给我点」对上，第二句的「给我点」是没认出来的那一遍
    expect(pairs.map((pair: { index: number }): number => pair.index)).toEqual([0, 1, 2, 3, 4, -1, -1, -1, 5, 6, 7]);
  });

  test('空的也行', (): void => {
    expect(alignChars([], ['一'])).toEqual([]);
    expect(alignChars(['一'], [])).toEqual([{ index: -1, same: false }]);
  });
});

describe('timeLinesByTokens', (): void => {
  // 她实际说的：10.0 秒起「我跟你们说我守护天使给我点」，停一下，14.0 秒起「给我点费大厨了」
  const tokens: Array<TimedToken> = [...heard('我跟你们说我守护天使给我点', 10), ...heard('给我点费大厨了', 14)];

  test('字幕的时间早了一秒多：按认出来的字的时间放回去', (): void => {
    const result: TokenTiming = timeLinesByTokens(
      [line(8.6, 9.6, '我跟你们说'), line(9.6, 11.4, '我守护天使给我点'), line(11.5, 12.9, '给我点费大厨了')], tokens, 30);

    expect(result.used).toBe(true);
    expect([result.matched, result.total]).toEqual([20, 20]);
    // 第一句从「我」（10.0）开始；第二句从它的第一个字（11.0）开始，前一句显示到它出来；第三句 14.0
    expect(times(result.lines)).toEqual([[10, 11], [11, 12.7], [14, 15.5]]);
  });

  test('有错字、标点、多说的字也对得上', (): void => {
    const wrong: Array<TimedToken> = [...heard('我跟你们说我手护天使他给我点', 10), ...heard('给我点费大出了', 14.2)];
    const result: TokenTiming = timeLinesByTokens([line(8, 10, '我跟你们说，我守护天使给我点！'), line(10, 12, '给我点费大厨了。')], wrong, 30);

    expect(result.used).toBe(true);
    expect(times(result.lines)).toEqual([[10, 12.9], [14.2, 15.7]]);
  });

  test('一句话的开头没认出来：按后面认出来的字往前推', (): void => {
    // 「给我点」没认出来，只认出「费大厨了」从 14.6 开始：这句应该从 14.6 - 3 个字的时间 开始
    const partial: Array<TimedToken> = [...heard('我跟你们说我守护天使给我点', 10), ...heard('费大厨了', 14.6)];
    const result: TokenTiming = timeLinesByTokens([line(8, 10, '我跟你们说我守护天使给我点'), line(10, 12, '给我点费大厨了')], partial, 30);

    expect(result.lines[1].start).toBeCloseTo(14.6 - (3 * 0.18));
  });

  test('某一句基本没认出来（唱歌、背景音乐）：这一句保持原来的时间，但夹在前后两句中间', (): void => {
    const result: TokenTiming = timeLinesByTokens(
      [line(8.6, 9.6, '我跟你们说我守护天使给我点'), line(5, 6.5, '啦啦啦啦啦'), line(11.5, 12.9, '给我点费大厨了')], tokens, 30);

    expect(result.used).toBe(true);
    expect(result.lines[1].start).toBeGreaterThanOrEqual(result.lines[0].start);
    expect(result.lines[1].end).toBeLessThanOrEqual(result.lines[2].start);
    expect(result.lines[2].start).toBeCloseTo(14);
  });

  test('本地模型把一句话听错了（人名、英文）：前后的句子对上了，夹在中间的那串字就是它', (): void => {
    // 实际：35.3「哎」，停了十秒，46.1 说「彤馨恋BE了呀」（本地模型听成「我今天闭异了呀」），53.0「哎不是为啥我这iPad会突然重启」
    const misheard: Array<TimedToken> = [
      ...heard('我怕他跟我闹我怕他又生气', 32.5 - 2.2), { text: '哎', time: 35.3 }, ...heard('我今天闭异了呀', 46.1), ...heard('哎不是为啥我这iPad会突然重启', 53)
    ];
    // 模型把「彤馨恋BE了呀」的时间标早了十秒，落在「哎」上
    const result: TokenTiming = timeLinesByTokens([
      line(29, 33, '我怕他跟我闹，我怕他又生气', false), line(35.2, 36.1, '彤馨恋BE了呀'), line(36.2, 38, '哎不是，为啥'), line(38, 41, '我这iPad会突然重启啊')
    ], misheard, 70);

    expect(result.lines[1].start).toBeCloseTo(46.1);
    expect(result.lines[1].end).toBeGreaterThan(47.3);
    expect(result.lines[2].start).toBeCloseTo(53);
  });

  test('字幕里的阿拉伯数字按汉字比（本地模型听出来的是汉字）', (): void => {
    expect(digitsToChinese('12月')).toBe('十二月');
    expect(digitsToChinese('20岁、10个、99分、5点')).toBe('二十岁、十个、九十九分、五点');
    expect(digitsToChinese('2026年1米74')).toBe('二零二六年一米七十四');

    // 「12月准备整点啥活」被听成「十二月怎么咱那啥活」：换成汉字后有一半的字相同，按它的时间
    const result: TokenTiming = timeLinesByTokens(
      [line(10, 11.8, '12月准备整点啥活'), line(12, 14, '12月我给直播间里放个炸药')],
      [...heard('十二月怎么咱那啥活', 15.5), ...heard('十二月我给直播间里放个炸药', 17.4)], 40);

    expect(result.lines[0].start).toBeCloseTo(15.5);
  });

  test('一句话没对上，夹在中间的那串字和它长短差太多：不硬套，保持原来的时间', (): void => {
    const misheard: Array<TimedToken> = [...heard('给我点费大厨了', 10), ...heard('一二三四五六七八九十一二三四五六七八九十', 20), ...heard('都没吃完', 40)];
    const result: TokenTiming = timeLinesByTokens([line(9.5, 11.5, '给我点费大厨了'), line(12, 13, '嗯'), line(39, 41, '都没吃完')], misheard, 60);

    expect(result.lines[1].start).toBeCloseTo(12);
  });

  test('整体对上的字太少（识别的是另一段话）：不用，原样返回', (): void => {
    const lines: Array<CaptionLine> = [line(1, 3, '今天天气真不错'), line(3, 5, '我们出去玩吧')];
    const result: TokenTiming = timeLinesByTokens(lines, tokens, 30);

    expect(result.used).toBe(false);
    expect(result.lines).toBe(lines);
  });

  test('文字、留不留、重点词不变；没有字幕或没有识别结果时不用', (): void => {
    const result: TokenTiming = timeLinesByTokens([{ start: 1, end: 2, text: '给我点费大厨了', keep: false, emphasis: ['费大厨'] }], tokens, 30);

    expect(result.lines[0]).toMatchObject({ text: '给我点费大厨了', keep: false, emphasis: ['费大厨'] });
    expect(timeLinesByTokens([], tokens, 30).used).toBe(false);
    expect(timeLinesByTokens([line(1, 2, '给我点费大厨了')], [], 30).used).toBe(false);
  });
});
