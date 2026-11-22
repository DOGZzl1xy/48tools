/**
 * 公演切片的排版：左边直播画面、下面字幕、右边弹幕；封面压暗加大字和色块。
 */
import {
  assColor, stageTitleRows, coverSegments, buildStageVideoAss, buildStageCoverAss, stageRenderFilter, stageCoverFilter, type StageInfo
} from './highlightStageAss';
import type { FontSet, PlacedDanmu } from './highlightAss';

const fonts: FontSet = { text: 'Font Medium', heavy: 'Font Heavy', heavyBold: false, regular: 'Font', em: 1.448, dir: '../fonts' };
const stage: StageInfo = { team: 'NII', teamColor: '#af83bb', show: '《示例公演》', date: '2026.11.21' };

function dialogues(ass: string): Array<string> {
  return ass.split('\n').filter((line: string): boolean => line.startsWith('Dialogue:'));
}

describe('公演排版：小工具', (): void => {
  test('颜色转成 ASS 的 BBGGRR', (): void => {
    expect(assColor('#af83bb')).toBe('&HBB83AF&');
    expect(assColor('a9ca27')).toBe('&H27CAA9&');
  });

  test('标题超过 8 个字分两行，尽量在中间的标点处断', (): void => {
    expect(stageTitleRows('忘词现场')).toEqual(['忘词现场']);
    expect(stageTitleRows('这首歌好绝，原班人马回来了')).toEqual(['这首歌好绝', '原班人马回来了']);
    expect(stageTitleRows('一二三四五六七八九十')).toEqual(['一二三四五', '六七八九十']);
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
  test('右边有队伍标签、公演名、标题和弹幕（只有内容，没有昵称）；没有字幕时下面不出字', (): void => {
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
    expect(ass).toContain('2026.11.21  公演切片');
    expect(ass).toContain('忘词现场');
    expect(events.filter((line: string): boolean => line.includes(',Danmu,')).length).toBe(3); // 第一条出现后又被顶上去一次
    expect(ass).not.toContain('路人甲');
    expect(events.some((line: string): boolean => line.includes(',Caption,'))).toBe(false);
    expect(ass).toContain(assColor(stage.teamColor));
  });

  test('有字幕时字幕在直播画面下面', (): void => {
    const ass: string = buildStageVideoAss({
      stage,
      title: '题目',
      lines: [{ start: 1, end: 3, text: '今天的话题是什么', keep: true, emphasis: [] }, { start: 4, end: 5, text: '剪掉的', keep: false, emphasis: [] }],
      segments: [{ from: 0, to: -1, start: 0, end: 60, out: 0 }],
      total: 60,
      danmu: [],
      fonts
    });
    const captions: Array<string> = dialogues(ass).filter((line: string): boolean => line.includes(',Caption,'));

    expect(captions).toHaveLength(1);
    expect(captions[0]).toContain('\\pos(720,945)');
    expect(captions[0]).toContain('今天的话题是什么');
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
  test('16:9 和 4:3：标签、日期、大字；色块轮流用两种颜色', (): void => {
    for (const width of [1_920, 1_440]) {
      const ass: string = buildStageCoverAss({ stage, lines: ['甲【耳朵红了】', '【全员】笑场'], fonts, width });

      expect(ass).toContain(`PlayResX: ${ width }`);
      expect(ass).toContain('SNH48 TEAM NII · 《示例公演》');
      expect(ass).toContain('耳朵红了');
      expect(ass).toContain(assColor('#ffd400'));
      expect(ass).toContain(assColor('#ff6fa3'));
    }
  });

  test('封面的底：取左上的直播画面放大、裁成要的宽度、压暗', (): void => {
    const filter: string = stageCoverFilter(fonts, 'cover.ass', 1_440);

    expect(filter).toContain('crop=1440:810:0:0');
    expect(filter).toContain('crop=1440:1080');
    expect(filter).toContain('brightness=-0.32');
  });
});
