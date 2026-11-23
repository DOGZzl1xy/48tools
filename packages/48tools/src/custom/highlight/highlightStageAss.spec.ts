/**
 * 公演切片的排版：左边直播画面、下面字幕、右边弹幕；封面压暗加大字和色块。
 */
import {
  assColor, teamShade, stageTitleRows, stageShowLabel, coverSegments, buildStageVideoAss, buildStageCoverAss, stageRenderFilter, stageCoverFilter, type StageInfo
} from './highlightStageAss';
import type { FontSet, PlacedDanmu } from './highlightAss';

const fonts: FontSet = { text: 'Font Medium', heavy: 'Font Heavy', heavyBold: false, regular: 'Font', em: 1.448, dir: '../fonts' };
const stage: StageInfo = { team: 'NII', teamColor: '#af83bb', show: '《示例公演》', date: '2026.11.21' };

function dialogues(ass: string): Array<string> {
  return ass.split('\n').filter((line: string): boolean => line.startsWith('Dialogue:'));
}

describe('公演排版：小工具', (): void => {
  test('画面上的公演名：后面加「公演」，本来就以「公演」结尾的不再加', (): void => {
    expect(stageShowLabel('《Fire X》2.0')).toBe('《Fire X》2.0 公演');
    expect(stageShowLabel('《新芽之契》十三周年庆特别公演')).toBe('《新芽之契》十三周年庆特别公演');
  });

  test('颜色转成 ASS 的 BBGGRR', (): void => {
    expect(assColor('#af83bb')).toBe('&HBB83AF&');
    expect(assColor('a9ca27')).toBe('&H27CAA9&');
  });

  test('标题超过 8 个字分两行，尽量在中间的标点处断', (): void => {
    expect(stageTitleRows('忘词现场')).toEqual(['忘词现场']);
    expect(stageTitleRows('这首歌好绝，原班人马回来了')).toEqual(['这首歌好绝', '原班人马回来了']);
    expect(stageTitleRows('一二三四五六七八九十')).toEqual(['一二三四五', '六七八九十']);
    // 中间没有标点：在词和词之间断，不把一个词拆开；第二行不以「的」开头；一样近时取靠后的
    expect(stageTitleRows('不是那么熟悉的前辈')).toEqual(['不是那么', '熟悉的前辈']);
    expect(stageTitleRows('没升格不配加前辈微信')).toEqual(['没升格不配', '加前辈微信']);
    expect(stageTitleRows('初兔跳一半突然掐断重开')).toEqual(['初兔跳一半突然', '掐断重开']);
  });

  test('封面的一行：【】里的词要色块', (): void => {
    expect(coverSegments('甲【耳朵红了】')).toEqual([{ text: '甲', mark: false }, { text: '耳朵红了', mark: true }]);
    expect(coverSegments('【全员】一起 【笑场】')).toEqual([
      { text: '全员', mark: true }, { text: '一起', mark: false }, { text: '笑场', mark: true }
    ]);
    expect(coverSegments('没有标记')).toEqual([{ text: '没有标记', mark: false }]);
  });
});

describe('公演排版：成片', (): void => {
  test('右边有队伍标签、公演名、日期、标题和弹幕（只有内容，没有昵称）；不写「公演切片」和「弹幕」两个字；没有字幕时下面不出字', (): void => {
    const danmu: Array<PlacedDanmu> = [
      { time: 0, at: 0, nickname: '路人甲', message: '哈哈哈' },
      { time: 2, at: 2, nickname: '路人乙', message: '心疼' }
    ];
    const ass: string = buildStageVideoAss({
      stage, title: '忘词现场', lines: [], segments: [{ from: 0, to: -1, start: 0, end: 30, out: 0 }], total: 30, danmu, fonts
    });
    const events: Array<string> = dialogues(ass);

    expect(ass).toContain('SNH48 TEAM NII');
    expect(ass).toContain('《示例公演》 公演');
    expect(ass).toContain('2026.11.21');
    expect(ass).not.toContain('公演切片');
    expect(events.some((line: string): boolean => line.endsWith('}弹幕'))).toBe(false);
    expect(ass).toContain('忘词现场');
    expect(events.filter((line: string): boolean => line.includes(',Danmu,')).length).toBe(3); // 第一条出现后又被顶上去一次
    expect(ass).not.toContain('路人甲');
    expect(events.some((line: string): boolean => line.includes(',Caption,'))).toBe(false);
    expect(ass).toContain(assColor(stage.teamColor));
  });

  test('有字幕时字幕在直播画面下面，重点词用队伍的颜色', (): void => {
    const ass: string = buildStageVideoAss({
      stage,
      title: '题目',
      lines: [{ start: 1, end: 3, text: '今天的话题是什么', keep: true, emphasis: ['话题'] }, { start: 4, end: 5, text: '剪掉的', keep: false, emphasis: [] }],
      segments: [{ from: 0, to: -1, start: 0, end: 60, out: 0 }],
      total: 60,
      danmu: [],
      fonts
    });
    const captions: Array<string> = dialogues(ass).filter((line: string): boolean => line.includes(',Caption,'));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('\\pos(720,945)');
    expect(captions[0].replace(/\{[^}]*\}/g, '')).toMatch(/,,今天的话题是什么$/);
    expect(captions[0]).toContain(`\\c${ assColor(stage.teamColor) }}话`); // 重点词用队伍的颜色
  });

  test('滤镜：画面缩到 1440×810 放左上，压字幕，统一响度', (): void => {
    const filter: string = stageRenderFilter([{ from: 0, to: 10, start: 0, end: 10, out: 0 }], fonts, 'video.ass');

    expect(filter).toContain('scale=1440:810');
    expect(filter).toContain('[bg][vs]overlay=0:0');
    expect(filter).toContain('video.ass');
    expect(filter).toContain('loudnorm');
  });
});

describe('公演排版：封面', (): void => {
  test('16:9 和 4:3：标签（不用「·」）、日期（不写「公演切片」）、大字；色块用队伍的颜色', (): void => {
    for (const width of [1_920, 1_440]) {
      const ass: string = buildStageCoverAss({ stage, lines: ['甲【耳朵红了】', '【全员】笑场'], fonts, width });

      expect(ass).toContain(`PlayResX: ${ width }`);
      expect(ass).toContain('SNH48 TEAM NII  《示例公演》');
      expect(ass).not.toContain('·');
      expect(ass).toContain('2026.11.21');
      expect(ass).not.toContain('公演切片');
      expect(ass).toContain('耳朵红了');

      // 荧光笔（标签 + 两个要突出的词）都是深一点的 NII 紫，不再用整块的团队色矩形，也不用黄色、粉色
      const boxes: Array<string> = dialogues(ass).filter((line: string): boolean => line.includes(',Shape,') && line.includes('\\p1'));
      const ink: string = assColor(teamShade('#af83bb', 0.42));

      expect(boxes).toHaveLength(3);
      expect(boxes.every((line: string): boolean => line.includes(`\\c${ ink }`))).toBe(true);
      expect(ass).not.toContain(`\\c${ assColor('#af83bb') }`);
      expect(ass).not.toContain(assColor('#ffd400'));
      expect(ass).not.toContain(assColor('#ff6fa3'));
    }
  });

  test('荧光笔只盖住字的下半截；要突出的词白字，最后一行别的字浅紫', (): void => {
    const ass: string = buildStageCoverAss({ stage, lines: ['交换衣服【守护谁穿谁的】', '徐佳琳守护的是【某某】？'], fonts, width: 1_920 });
    const texts: Array<string> = dialogues(ass).filter((line: string): boolean => line.includes(',Text,'));
    const tint: string = assColor(teamShade('#af83bb', 0.87, 0.42));
    const lineOf: (text: string) => string = (text: string): string => texts.find((line: string): boolean => line.endsWith(text))!;

    expect(lineOf('交换衣服')).not.toContain('\\c&');          // 第一行白字
    expect(lineOf('守护谁穿谁的')).not.toContain('\\c&');      // 要突出的词白字
    expect(lineOf('徐佳琳守护的是')).toContain(`\\c${ tint }`); // 最后一行浅紫
    expect(lineOf('某某')).not.toContain('\\c&');

    // 荧光笔的上沿在字的中间往下，不从字的顶上开始
    const size: number = Number(/\\fs(\d+)/.exec(lineOf('守护谁穿谁的'))![1]);
    const textY: number = Number(/\\pos\(\d+,(\d+)\)/.exec(lineOf('守护谁穿谁的'))![1]);
    const band: string = dialogues(ass).filter((line: string): boolean => line.includes(',Shape,'))[1];
    const ys: Array<number> = [...band.matchAll(/[ml] -?\d+ (-?\d+)/g)].map((match: RegExpMatchArray): number => Number(match[1]));

    expect(Math.min(...ys)).toBeGreaterThan(textY + (size * 0.45));
    expect(Math.max(...ys)).toBeLessThan(textY + size);
  });

  test('团队色推算的深色、浅色：色相不变，NII 的紫和参考图一致', (): void => {
    expect(teamShade('#af83bb', 0.42)).toBe('#7d4c8a');
    expect(teamShade('#af83bb', 0.87, 0.42)).toBe('#e6d0ec');
    expect(teamShade('#8fc8eb', 0.42)).toBe('#207db6'); // SII 蓝
    expect(teamShade('#ffffff', 0.5)).toBe('#808080');  // 没有颜色的还是灰
  });

  test('唱歌的封面只有「《歌名》」一个色块：字比平常大、色块留得更宽，不超出画面', (): void => {
    const sizeOf: (ass: string, text: string) => number = (ass: string, text: string): number => {
      const line: string | undefined = dialogues(ass).find((item: string): boolean => item.endsWith(text));

      return Number(/\\fs(\d+)/.exec(line ?? '')?.[1] ?? 0);
    };

    for (const width of [1_920, 1_440]) {
      const song: string = buildStageCoverAss({ stage, lines: ['【《示例歌》】'], fonts, width });
      const normal: string = buildStageCoverAss({ stage, lines: ['【《示例歌》】', '第二行'], fonts, width });

      expect(sizeOf(song, '《示例歌》')).toBeGreaterThan(sizeOf(normal, '《示例歌》') * 1.25);

      // 色块的左右边都在画面里
      const songBox: string = dialogues(song).filter((line: string): boolean => line.includes(',Shape,') && line.includes('\\p1')).at(-1)!;
      const xs: Array<number> = [...songBox.matchAll(/[ml] (-?\d+) -?\d+/g)].map((match: RegExpMatchArray): number => Number(match[1]));

      expect(Math.min(...xs)).toBeGreaterThan(0);
      expect(Math.max(...xs)).toBeLessThan(width);
    }

    // 歌名很长时字号跟着缩小，色块还在画面里
    const long: string = buildStageCoverAss({ stage, lines: ['【《一首名字特别特别长的歌》】'], fonts, width: 1_440 });
    const box: string = dialogues(long).filter((line: string): boolean => line.includes(',Shape,') && line.includes('\\p1')).at(-1)!;

    expect(Math.max(...[...box.matchAll(/[ml] (-?\d+) -?\d+/g)].map((match: RegExpMatchArray): number => Number(match[1])))).toBeLessThan(1_440);
  });

  test('封面的底：取左上的直播画面放大、裁成要的宽度、压暗', (): void => {
    const filter: string = stageCoverFilter(fonts, 'cover.ass', 1_440);

    expect(filter).toContain('crop=1440:810:0:0');
    expect(filter).toContain('crop=1440:1080');
    expect(filter).toContain('brightness=-0.42');
  });
});
