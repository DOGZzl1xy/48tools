/**
 * 录播自动切片的画面排版：字幕的加粗和换行、弹幕放到成片的时间上、字幕文件和滤镜的内容。
 */
import {
  assTime, assEscape, captionText, placeDanmu, buildVideoAss, renderFilter, splitTitle, buildCoverAss, coverFilter, COVER_WIDTHS,
  type FontSet, type PlacedDanmu
} from './highlightAss';
import type { DanmuLine, Segment } from './highlightTypes';

const fonts: FontSet = { text: 'Font Medium', heavy: 'Font Heavy', heavyBold: false, regular: 'Font', em: 1.448, dir: '../fonts' };
const system: FontSet = { text: 'Microsoft YaHei', heavy: 'Microsoft YaHei', heavyBold: true, regular: 'Microsoft YaHei', em: 1.32 };
const segments: Array<Segment> = [
  { from: 0, to: 0, start: 10, end: 20, out: 0 },
  { from: 1, to: 1, start: 40, end: 50, out: 10 }
];

function danmu(time: number, message: string, nickname: string = '测试粉丝'): DanmuLine {
  return { time, nickname, message };
}

describe('assTime / assEscape', (): void => {
  test('时间格式', (): void => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(75.456)).toBe('0:01:15.46');
    expect(assTime(3_723.5)).toBe('1:02:03.50');
  });

  test('花括号和反斜杠换成全角的，免得被当成指令', (): void => {
    expect(assEscape('{\\b1}加粗\n换行')).toBe('｛＼b1｝加粗 换行');
  });
});

describe('captionText', (): void => {
  test('重点词换成粗的字体和黄色，后面换回来', (): void => {
    const { text }: { text: string } = captionText({ text: '应该是有股麻辣烫的味道的', emphasis: ['麻辣烫的味道'] }, fonts);

    expect(text).toBe('应该是有股{\\fnFont Heavy\\b0\\c&H4DE1FF&}麻辣烫的味道{\\fnFont Medium\\b0\\c&HFFFFFF&}的');
  });

  test('没有单独的粗体字体时用加粗', (): void => {
    expect(captionText({ text: '真的好萌啊', emphasis: ['好萌'] }, system).text).toContain('{\\fnMicrosoft YaHei\\b1\\c&H4DE1FF&}好萌');
  });

  test('句子里没有的重点词不管', (): void => {
    expect(captionText({ text: '今天天气不错', emphasis: ['下雨'] }, fonts).text).toBe('今天天气不错');
  });

  test('长的句子在靠中间的标点后面分成两行，字号跟着变', (): void => {
    const long: { text: string; size: number } = captionText({ text: '还说我一笑就变老了，这个话太过分了', emphasis: [] }, fonts);
    const short: { text: string; size: number } = captionText({ text: '太过分了', emphasis: [] }, fonts);

    expect(long.text).toBe('还说我一笑就变老了，\\N这个话太过分了');
    expect(short.size).toBe(116);
    expect(long.size).toBeLessThanOrEqual(116);
  });

  test('英文单词、数字不从中间断开', (): void => {
    const { text }: { text: string } = captionText({ text: '欸不是，为啥我这iPad会突然重启啊', emphasis: ['突然重启'] }, fonts);
    const rows: Array<string> = text.replace(/\{[^}]*\}/g, '').split('\\N');

    expect(rows).toHaveLength(2);
    expect(rows.some((row: string): boolean => row.includes('iPad'))).toBe(true);
  });

  test('一行放不下又没有标点时也会分行，而且放得进画面', (): void => {
    const { text, size }: { text: string; size: number } = captionText({ text: '一二三四五六七八九十一二三四五六七八九十', emphasis: [] }, fonts);

    expect(text.split('\\N')).toHaveLength(2);
    expect((10 * size) / fonts.em).toBeLessThanOrEqual(1_180);
  });
});

describe('placeDanmu', (): void => {
  test('留下的部分按时间放；剪掉的部分里紧跟着的反应放到下一段开头', (): void => {
    const placed: Array<PlacedDanmu> = placeDanmu([
      danmu(112, '在第一段里'),        // 片段从 100 开始：12 → 成片 2
      danmu(123, '对第一段的反应'),    // 23：被剪掉，离第一段结束 3 秒 → 下一段开头
      danmu(135, '隔了很久的无关弹幕'), // 35：离第一段结束 15 秒 → 不要
      danmu(145, '在第二段里')         // 45 → 成片 15
    ], 100, segments, 20);

    expect(placed.map((item: PlacedDanmu): [string, number] => [item.message, Number(item.at.toFixed(2))])).toEqual([
      ['在第一段里', 2],
      ['对第一段的反应', 10.2],
      ['在第二段里', 15]
    ]);
  });

  test('开头先放上片段开始前最近的 5 条', (): void => {
    const before: Array<DanmuLine> = Array.from({ length: 8 }, (item: unknown, index: number): DanmuLine => danmu(60 + index, `之前${ index }`));
    const placed: Array<PlacedDanmu> = placeDanmu([danmu(5, '太早了'), ...before], 100, segments, 20);

    expect(placed.map((item: PlacedDanmu): string => item.message)).toEqual(['之前3', '之前4', '之前5', '之前6', '之前7']);
    expect(placed.every((item: PlacedDanmu): boolean => item.at === 0)).toBe(true);
  });

  test('同一时刻挤在一起的错开', (): void => {
    const placed: Array<PlacedDanmu> = placeDanmu([danmu(112, '甲'), danmu(112.1, '乙'), danmu(112.2, '丙')], 100, segments, 20);

    expect(placed.map((item: PlacedDanmu): number => Number(item.at.toFixed(2)))).toEqual([2, 2.35, 2.7]);
  });
});

describe('buildVideoAss / renderFilter', (): void => {
  const ass: string = buildVideoAss({
    title: '被说一笑就老{气到}回怼',
    tag: '测试成员  2026.11.15',
    lines: [
      { start: 11, end: 13, text: '竟然说我一笑就变老了', keep: true, emphasis: ['一笑就变老了'] },
      { start: 25, end: 27, text: '谢谢礼物', keep: false, emphasis: [] },
      { start: 41, end: 44, text: '提升一点情商吧', keep: true, emphasis: [] }
    ],
    segments,
    total: 20,
    danmu: [{ time: 112, nickname: '测试粉丝', message: '哈哈哈', at: 2 }],
    fonts
  });

  test('有标题、留下的字幕、弹幕；不留的句子不出现', (): void => {
    expect(ass).toContain('被说一笑就老｛气到｝回怼');
    expect(ass).toContain('一笑就变老了');
    expect(ass).toContain('提升一点情商吧');
    expect(ass).not.toContain('谢谢礼物');
  });

  test('字幕的时间是成片里的时间', (): void => {
    expect(ass).toMatch(/Dialogue: 2,0:00:01\.00,[^,]+,Caption/);   // 片段 11 秒 → 成片 1 秒
    expect(ass).toMatch(/Dialogue: 2,0:00:11\.00,[^,]+,Caption/);   // 片段 41 秒 → 成片 11 秒
  });

  test('滤镜：每段剪一刀，拼起来，压字幕，用指定的字体文件夹', (): void => {
    const filter: string = renderFilter(segments, fonts);

    expect(filter).toContain('[0:v]trim=start=10.000:end=20.000');
    expect(filter).toContain('[0:a]atrim=start=40.000:end=50.000');
    expect(filter).toContain('concat=n=2:v=1:a=1[vc][ac]');
    expect(filter).toContain('subtitles=overlay.ass:fontsdir=../fonts[vout]');
    expect(renderFilter(segments, system)).toContain('subtitles=overlay.ass[vout]');
  });

  test('滤镜：响度拉齐之后要重新算音频的时间戳（不然开头卡顿、音画不同步）', (): void => {
    expect(renderFilter(segments, fonts)).toMatch(/\[ac\]loudnorm=[^;[]*,aresample=48000,asetpts=N\/SR\/TB\[aout\]$/);
  });

  test('电台：只剪声音，画面是第二个输入的图，截成拼完的长度', (): void => {
    const filter: string = renderFilter(segments, fonts, 'overlay.ass', true);

    expect(filter).not.toContain('[0:v]');
    expect(filter).toContain('[0:a]atrim=start=10.000:end=20.000');
    expect(filter).toContain('[a0][a1]concat=n=2:v=0:a=1[ac]');
    expect(filter).toContain('[1:v]trim=duration=20.000,setpts=PTS-STARTPTS,scale=out_range=tv,format=yuv420p[vc]');
    expect(filter).toContain('subtitles=overlay.ass:fontsdir=../fonts[vout]');
  });
});

describe('封面', (): void => {
  test('标题超过 7 个字分两行，有标点就在标点后面断', (): void => {
    expect(splitTitle('好萌')).toEqual(['好萌']);
    expect(splitTitle('忘切小号！用大号自吹好萌')).toEqual(['忘切小号！', '用大号自吹好萌']);
    expect(splitTitle('被说一笑就老气到回怼')).toEqual(['被说一笑就', '老气到回怼']);
  });

  test('没有标点时在词和词之间断，不把一个词拆到两行', (): void => {
    expect(splitTitle('真到自己这儿也没招')).toEqual(['真到自己', '这儿也没招']); // 以前是「真到自己这 / 儿也没招」
    expect(splitTitle('吐槽队友不说人话')).toEqual(['吐槽队友', '不说人话']);
    expect(splitTitle('比皇登基后的退费公告')).toEqual(['比皇登基后的', '退费公告']); // 不拆「登基后」
  });

  test('结尾的括号吐槽单独一行；逗号离中间远一点也在逗号后面断', (): void => {
    expect(splitTitle('北大不比北芭差（bushi）')).toEqual(['北大不比北芭差', '（bushi）']);
    expect(splitTitle('登顶神作，但是没有下巴')).toEqual(['登顶神作', '但是没有下巴']);
    expect(splitTitle('只要礼物到位，串子也冰清玉洁')).toEqual(['只要礼物到位', '串子也冰清玉洁']);
    // 自己取的很长的标题分三行
    expect(splitTitle('这是一个特别特别长的标题，长到快要四十个字了，看看在封面上会不会小到看不清楚啊')).toEqual(['这是一个特别特别长的标题', '长到快要四十个字了', '看看在封面上会不会小到看不清楚啊']);
  });

});
