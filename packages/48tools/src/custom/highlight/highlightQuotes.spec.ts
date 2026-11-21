/**
 * 录播自动切片里按原话找时间：在本地识别的结果里找一句话、用找到的原话改正爆点的时间。
 */
import { locateQuote, fixHighlightTimes, type QuoteHit } from './highlightQuotes';
import type { TimedToken } from './highlightTokens';
import type { Highlight } from './highlightTypes';

/* 一串字从 start 开始、每 0.2 秒一个 */
function heard(text: string, start: number): Array<TimedToken> {
  return Array.from(text).map((ch: string, index: number): TimedToken => ({ text: ch, time: Number((start + (index * 0.2)).toFixed(2)) }));
}

// 本地识别的结果：三段话，中间隔得很远；「你们给我滚」说了两次
const tokens: Array<TimedToken> = [
  ...heard('我下次去就这样坐在那里很平静地看着你们', 880),
  ...heard('然后人家就以为我是嫂嫂你们给我滚', 890),
  ...heard('是嫂嫂不是私生', 905),
  ...heard('今天好冷啊但是我是一个很自律的人你们给我滚', 1000)
];

function highlight(patch: Partial<Highlight>): Highlight {
  return { start: 0, end: 60, title: '标题', cover: '', quote: '', reason: '', score: 8, ...patch };
}

describe('locateQuote', (): void => {
  test('一字不差的话：开始和结束是第一个、最后一个字的时间', (): void => {
    expect(locateQuote(tokens, '然后人家就以为我是嫂嫂')).toEqual({ start: 890, end: 892, score: 1 });
  });

  test('标点、错字、少字也找得到', (): void => {
    const hit: QuoteHit | null = locateQuote(tokens, '我就这样坐在那里，很平静的看着你们！');

    // 「我」对到了「去」（错一个字比跳过三个字划算）
    expect(hit?.start).toBeCloseTo(880.6);
    expect(hit?.end).toBeCloseTo(883.6);
    expect(hit!.score).toBeGreaterThan(0.8);
  });

  test('同一句话出现两次：取离大概的时间近的那次；from 之后才找', (): void => {
    expect(locateQuote(tokens, '你们给我滚', { near: 900 })?.start).toBeCloseTo(892.2);
    expect(locateQuote(tokens, '你们给我滚', { near: 1200 })?.start).toBeCloseTo(1003.2);
    expect(locateQuote(tokens, '你们给我滚', { near: 900, from: 950 })?.start).toBeCloseTo(1003.2);
  });

  test('没说过的话、太短又不完全一样的话：找不到', (): void => {
    expect(locateQuote(tokens, '明天我们一起去吃火锅吧')).toBeNull();
    expect(locateQuote(tokens, '嫂子')).toBeNull();
    expect(locateQuote(tokens, '')).toBeNull();
    expect(locateQuote([], '然后人家就以为我是嫂嫂')).toBeNull();
  });

  test('话很长：part 是 tail 时用结尾那部分找，结束时间是最后一个字', (): void => {
    const said: string = '今天其实我本来不想开直播的但是你们一直在群里叫我所以我就来了结果一开播就被你们骂我真的会谢';
    const own: Array<TimedToken> = heard(said, 100);

    // 这句话前面还有一大段没识别出来的：用开头找不到，用结尾的 40 个字找得到
    const quote: string = `这一大段字本地模型完全没有识别出来因为她说得太快了而且还有背景音乐在响${ said }`;

    expect(locateQuote(own, quote)).toBeNull();
    expect(locateQuote(own, quote, { part: 'tail' })?.end).toBeCloseTo(100 + ((Array.from(said).length - 1) * 0.2));
  });
});

describe('fixHighlightTimes', (): void => {
  test('模型说的时间晚了三分多钟：按开头、结尾的原话放回去', (): void => {
    // 实际在 880 ~ 906 秒，模型说 1095 ~ 1155
    const fixed: Highlight | null = fixHighlightTimes(highlight({
      start: 1095, end: 1155, quote: '然后人家就以为我是嫂嫂', first: '我下次去就这样坐在那里', last: '是嫂嫂，不是私生'
    }), tokens);

    expect(fixed?.start).toBeCloseTo(880);
    expect(fixed?.end).toBeCloseTo(907.2);
    expect(fixed?.title).toBe('标题');
  });

  test('只找到最关键的那句：按模型说的长度，前面留六成、后面留四成', (): void => {
    const fixed: Highlight | null = fixHighlightTimes(highlight({ start: 500, end: 550, quote: '然后人家就以为我是嫂嫂', first: '没有识别出来的开头', last: '也没有识别出来的结尾' }), tokens);

    expect(fixed?.start).toBeCloseTo(890 - 30);
    expect(fixed?.end).toBeCloseTo(892 + 20);
  });

  test('开头那句在别处也说过、离关键句太远：不用它', (): void => {
    // 「你们给我滚」在 892 和 1003 各说过一次；关键句在 1001 附近，开头那句应该取 892 之后…但 892 比关键句早不到 330 秒，可以用
    const fixed: Highlight | null = fixHighlightTimes(highlight({ start: 990, end: 1010, quote: '我是一个很自律的人', first: '你们给我滚' }), tokens);

    expect(fixed!.start).toBeLessThan(1001.4);
    expect(fixed!.end).toBeGreaterThan(1003);

    // 关键句在前、开头那句只在后面说过：开头不能比关键句晚，按关键句来
    const other: Highlight | null = fixHighlightTimes(highlight({ start: 880, end: 900, quote: '我下次去就这样坐在那里', first: '是嫂嫂不是私生' }), tokens);

    expect(other!.start).toBeLessThan(880.1);
  });

  test('片段最短 15 秒、最长 330 秒', (): void => {
    const short: Highlight | null = fixHighlightTimes(highlight({ start: 0, end: 5, quote: '是嫂嫂不是私生', first: '是嫂嫂不是私生', last: '是嫂嫂不是私生' }), tokens);
    const long: Highlight | null = fixHighlightTimes(highlight({ start: 0, end: 900, quote: '然后人家就以为我是嫂嫂', first: '我下次去就这样坐在那里', last: '很自律的人你们给我滚' }), tokens);

    expect(short!.end - short!.start).toBeCloseTo(15);
    expect(long!.end - long!.start).toBeLessThanOrEqual(330);
    expect(long!.start).toBeCloseTo(880);
  });

  test('一句原话都找不到：不要这个爆点', (): void => {
    expect(fixHighlightTimes(highlight({ start: 100, end: 160, quote: '完全没有说过的一句话', first: '也没有说过' }), tokens)).toBeNull();
    expect(fixHighlightTimes(highlight({ start: 100, end: 160 }), tokens)).toBeNull();
  });
});
