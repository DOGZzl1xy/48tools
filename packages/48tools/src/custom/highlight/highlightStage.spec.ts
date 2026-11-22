/**
 * 公演切片的规则：片段的起止和长度、发布标题、提示里讲到的东西、弹幕的时间对到接起来的录像上。
 */
import {
  STAGE_LIMITS, stageKindOf, stageClipWindow, stageLengthProblem, stageScript, stageCoverLines, stagePostTitle, stageFindRequest, mapDanmuToParts
} from './highlightStage';
import type { DanmuLine, Highlight } from './highlightTypes';
import type { StageInfo } from './highlightStageAss';

const stage: StageInfo = { team: 'X', teamColor: '#a9ca27', show: '《示例公演》', date: '2026.11.21' };

function highlight(extra: Partial<Highlight>): Highlight {
  return { start: 100, end: 300, title: '标题', cover: '封面的话', quote: '', reason: '理由', score: 8, ...extra };
}

describe('公演切片：起止和长度', (): void => {
  test('没写 kind 的当成 mc', (): void => {
    expect(stageKindOf(highlight({}))).toBe('mc');
    expect(stageKindOf(highlight({ kind: 'song' }))).toBe('song');
  });

  test('唱歌前后多留一点（前奏、结束动作和掌声），失误留得少；不超出录像', (): void => {
    expect(stageClipWindow(highlight({ kind: 'song', start: 100, end: 340 }), 3_600)).toEqual({ start: 98, length: 246 });
    expect(stageClipWindow(highlight({ kind: 'mistake', start: 50, end: 80 }), 3_600)).toEqual({ start: 49, length: 33 });
    expect(stageClipWindow(highlight({ kind: 'song', start: 1, end: 3_599 }), 3_600)).toEqual({ start: 0, length: 3_600 });
  });

  test('长度：失误可以短于 45 秒；mc 45 秒到 5 分钟', (): void => {
    expect(STAGE_LIMITS.mc).toEqual({ min: 45, max: 300 });
    expect(stageLengthProblem('mistake', 20)).toBeUndefined();
    expect(stageLengthProblem('mistake', 8)).toContain('至少 12 秒');
    expect(stageLengthProblem('song', 40)).toContain('至少 60 秒');
    expect(stageLengthProblem('song', 600)).toContain('最多 480 秒');
    expect(stageLengthProblem('mc', 30)).toContain('至少 45 秒');
  });
});

describe('公演切片：文案', (): void => {
  test('唱歌的看点是歌名和演唱的人；歌名不知道就不写', (): void => {
    expect(stageScript(highlight({ kind: 'song', song: '《示例歌》', singers: ['甲', '乙'] })).points).toEqual(['《示例歌》', '甲、乙']);
    expect(stageScript(highlight({ kind: 'song', song: '未知', singers: [] })).points).toEqual([]);
    expect(stageScript(highlight({ kind: 'mistake' }))).toMatchObject({ lines: [], points: ['封面的话'], description: '理由' });
  });

  test('封面大字：有 cover_lines 用它，没有用标题和封面的话', (): void => {
    expect(stageCoverLines(highlight({ coverLines: ['甲【好绝】'] }), '标题')).toEqual(['甲【好绝】']);
    expect(stageCoverLines(highlight({}), '新标题')).toEqual(['新标题', '封面的话']);
  });

  test('发布标题带队伍、最多三个人、公演名和日期', (): void => {
    expect(stagePostTitle(stage, '忘词现场', ['甲', '乙', '丙', '丁'])).toBe('【SNH48 TEAM X｜甲&乙&丙】忘词现场 | 《示例公演》 2026.11.21 公演切片');
    expect(stagePostTitle(stage, '忘词现场')).toBe('【SNH48 TEAM X】忘词现场 | 《示例公演》 2026.11.21 公演切片');
  });

  test('提示：讲清楚流程和三类片段，只带这段时间的弹幕；走 agy 时要开头结尾的原话', (): void => {
    const danmu: Array<DanmuLine> = [
      { time: 590, nickname: '', message: '太早了' },
      { time: 620, nickname: '', message: '哈哈哈哈' },
      { time: 700, nickname: '', message: '组合好绝' }
    ];
    const ask: ReturnType<typeof stageFindRequest> = stageFindRequest(
      { member: 'SNH48 TEAM X', title: '《示例公演》' }, { start: 600, length: 1_200 }, 'AAAA', danmu, true, stage);
    const prompt: string = (ask.parts[0] as { text: string }).text;

    expect(prompt).toContain('SNH48 TEAM X 《示例公演》 公演');
    expect(prompt).toContain('剧场须知');
    expect(prompt).toContain('mistake');
    expect(prompt).toContain('00:20 哈哈哈哈');
    expect(prompt).not.toContain('太早了');
    expect(prompt).toContain('first、last');
    expect((ask.schema as any).properties.highlights.items.required).toEqual(expect.arrayContaining(['kind', 'cover_lines', 'first', 'last']));

    const noQuotes: string = (stageFindRequest({ member: 'm', title: 't' }, { start: 0, length: 60 }, 'A', [], false, stage).parts[0] as { text: string }).text;

    expect(noQuotes).not.toContain('first、last');
    expect(noQuotes).not.toContain('<弹幕>');
  });
});

describe('公演切片：弹幕对到接起来的录像上', (): void => {
  test('录像断过：后面那段往前挪，落在空档里的弹幕不要', (): void => {
    const startedAt: number = 1_000_000;
    // 第一段从 0 秒录了 100 秒，断了 20 秒，第二段从 120 秒开始录了 50 秒
    const parts: Array<{ start: number; duration: number }> = [
      { start: startedAt, duration: 100 },
      { start: startedAt + 120_000, duration: 50 }
    ];
    const danmu: Array<DanmuLine> = [
      { time: 10, nickname: '', message: '第一段' },
      { time: 110, nickname: '', message: '空档里' },
      { time: 130, nickname: '', message: '第二段' },
      { time: 200, nickname: '', message: '录完以后' }
    ];

    expect(mapDanmuToParts(danmu, startedAt, parts)).toEqual([
      { time: 10, nickname: '', message: '第一段' },
      { time: 110, nickname: '', message: '第二段' }
    ]);
  });

  test('第一段晚一点才真正开始录：时间从这一段开始算', (): void => {
    expect(mapDanmuToParts([{ time: 5, nickname: '', message: 'a' }], 0, [{ start: 2_000, duration: 60 }]))
      .toEqual([{ time: 3, nickname: '', message: 'a' }]);
  });
});
