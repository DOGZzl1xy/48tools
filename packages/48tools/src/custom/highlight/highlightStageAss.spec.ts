/**
 * 公演切片的排版：左边直播画面、下面字幕、右边弹幕；封面压暗加大字和色块。
 */
import {
  assColor, stageTitleRows, stageShowLabel, coverSegments, buildStageVideoAss, buildStageCoverAss, stageRenderFilter, stageCoverFilter, type StageInfo
} from './highlightStageAss';
import { deriveTeamTokens } from './highlightTheme';
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

  test('滤镜：画面缩到 1440×810 放左上，支持静态底板，压字幕，统一响度', (): void => {
    const filter: string = stageRenderFilter([{ from: 0, to: 10, start: 0, end: 10, out: 0 }], fonts, 'video.ass');
    const withBg: string = stageRenderFilter([{ from: 0, to: 10, start: 0, end: 10, out: 0 }], fonts, 'video.ass', 1);

    expect(filter).toContain('scale=1440:810');
    expect(filter).toContain('[bg][vs]overlay=0:0');
    expect(filter).toContain('video.ass');
    expect(filter).toContain('loudnorm');
    expect(withBg).toContain('[1:v]scale=out_range=tv');
  });
});

describe('公演排版：封面', (): void => {

  test('封面的底：原图零模糊、不压暗人脸，取左上的直播画面放大并裁成要的宽度', (): void => {
    const filter: string = stageCoverFilter(fonts, 'cover.ass', 1_440);

    expect(filter).toContain('crop=1440:810:0:0');
    expect(filter).toContain('crop=1440:1080');
    expect(filter).not.toContain('brightness=-0.42');
    expect(filter).not.toContain('boxblur');
  });
});
