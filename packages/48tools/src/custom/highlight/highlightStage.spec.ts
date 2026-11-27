/**
 * 公演切片的规则：片段的起止和长度、发布标题、提示里讲到的东西、弹幕的时间对到接起来的录像上。
 */
import {
  STAGE_LIMITS, stageKindOf, stageClipWindow, stageLengthProblem, stageScript, stageCoverLines, stagePostTitle, stageFindRequest, mapDanmuToParts, stageQuota,
  songNameOf, plainTitle, stageTeamTag, stageSongTitle
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
    expect(stageClipWindow(highlight({ kind: 'song', start: 100, end: 340 }), 3_600)).toEqual({ start: 98, length: 248 });
    expect(stageClipWindow(highlight({ kind: 'mistake', start: 50, end: 80 }), 3_600)).toEqual({ start: 49, length: 33 });
    expect(stageClipWindow(highlight({ kind: 'song', start: 1, end: 3_599 }), 3_600)).toEqual({ start: 0, length: 3_600 });
  });

  test('长度：失误可以短于 45 秒；mc 45 秒到 5 分钟', (): void => {
    expect(STAGE_LIMITS.mc).toEqual({ min: 45, max: 300 });
    expect(stageLengthProblem('mistake', 20)).toBeUndefined();
    expect(stageLengthProblem('mistake', 8)).toContain('至少 12 秒');
    expect(stageLengthProblem('mistake', 150)).toBeUndefined(); // 停音乐重来、救场这类要一两分钟
    expect(stageLengthProblem('mistake', 200)).toContain('最多 160 秒');
    expect(stageLengthProblem('song', 40)).toContain('至少 60 秒');
    expect(stageLengthProblem('song', 600)).toContain('最多 480 秒');
    expect(stageLengthProblem('mc', 30)).toContain('至少 45 秒');
  });
});

describe('公演切片：自动时每类做几个', (): void => {
  function list(kind: 'mc' | 'song' | 'mistake', scores: Array<number>): Array<Highlight> {
    return scores.map((score: number): Highlight => highlight({ kind, score }));
  }

  test('MC 合起来最多 15 个，门槛放宽半分；唱歌、失误各最多 2 个，要够门槛；三类各算各的', (): void => {
    const candidates: Array<Highlight> = [
      ...list('mc', [9.5, 9, 9, 9, 8.5, 8.5, 8.5, 8, 8, 8, 7.5]),
      ...list('song', [9, 8.5, 8.5, 8]),
      ...list('mistake', [8])
    ];

    expect(stageQuota(candidates, 8.5)).toEqual({
      limit: { mc: 10, song: 2, mistake: 0 },
      minScore: { mc: 8, song: 8.5, mistake: 8.5 },
      total: 12
    });
    // 门槛调到 9：MC 8.5 分以上的只有 7 个就做 7 个，唱歌 9 分以上的 1 个
    expect(stageQuota(candidates, 9).limit).toEqual({ mc: 7, song: 1, mistake: 0 });
    // 够分的 MC 再多也最多 15 个
    expect(stageQuota(list('mc', Array.from({ length: 20 }, (): number => 9)), 8.5).limit.mc).toBe(15);
  });

  test('一个够分的都没有：最高的那个不低于 7 分也做一个；再低就不做', (): void => {
    expect(stageQuota([...list('mc', [7.5]), ...list('song', [8])], 8.5)).toMatchObject({ limit: { mc: 0, song: 1, mistake: 0 }, total: 1 });
    expect(stageQuota(list('mc', [6.5]), 8.5).total).toBe(0);
  });
});

describe('公演切片：文案', (): void => {
  test('唱歌的看点是歌名和演唱的人；歌名不知道就不写', (): void => {
    expect(stageScript(highlight({ kind: 'song', song: '《示例歌》', singers: ['甲', '乙'] })).points).toEqual(['《示例歌》', '甲、乙']);
    expect(stageScript(highlight({ kind: 'song', song: '未知', singers: [] })).points).toEqual([]);
    expect(stageScript(highlight({ kind: 'mistake' }))).toMatchObject({ lines: [], points: ['封面的话'], description: '理由' });
  });

  test('封面大字就是定的标题：一行放得下就一行，太长分行，空的不写', (): void => {
    expect(stageCoverLines(highlight({}), '我取的标题')).toEqual(['我取的标题']);
    expect(stageCoverLines(highlight({ kind: 'mistake' }), ' 话筒没声了 ')).toEqual(['话筒没声了']);
    expect(stageCoverLines(highlight({}), '这一个标题有点长，一行放不下要分开')).toEqual(['这一个标题有点长', '一行放不下要分开']);
    expect(stageCoverLines(highlight({}), '  ')).toEqual([]);
    // 不是唱歌的片段，理由里有歌名也照常写标题
    expect(stageCoverLines(highlight({ kind: 'mc', reason: '聊到《某歌》' }), '新标题')).toEqual(['新标题']);
  });

  test('标题里的【】是刷荧光笔的记号：封面上留给排版用，分行时不把标出来的词拆开；别处用 plainTitle 去掉', (): void => {
    expect(stageCoverLines(highlight({}), '娜姐【耳朵红了】')).toEqual(['娜姐【耳朵红了】']);
    expect(stageCoverLines(highlight({}), '娜姐【耳朵红了')).toEqual(['娜姐【耳朵红了】']); // 忘了关的补上
    expect(stageCoverLines(highlight({}), '【】')).toEqual([]);
    expect(plainTitle('娜姐【耳朵红了】')).toBe('娜姐耳朵红了');
    expect(plainTitle(' 【撞号】现场争姐一 ')).toBe('撞号现场争姐一');
    expect(plainTitle('没有记号的标题')).toBe('没有记号的标题');
    // 太长要分行：记号跟着字走
    expect(stageCoverLines(highlight({}), '这一个标题有点长，一行【放不下】要分开')).toEqual(['这一个标题有点长', '一行【放不下】要分开']);
    expect(stageCoverLines(highlight({}), '这一个【标题】有点长，一行放不下要分开')).toEqual(['这一个【标题】有点长', '一行放不下要分开']);
    // 断的地方落在记号中间：整个词挪到一边，不拆成两半
    expect(stageCoverLines(highlight({}), '这一个标题有【点长，一行】放不下要分开')).toEqual(['这一个标题有', '【点长，一行】放不下要分开']);
    expect(stageCoverLines(highlight({}), '【这一个标题有点长，一行放】不下要分开')).toEqual(['【这一个标题有点长，一行放】', '不下要分开']);
  });

  test('唱歌的封面只写歌名（一个色块）；认不出歌名、或者标题是自己写的，就写标题', (): void => {
    expect(stageCoverLines(highlight({ kind: 'song', song: '示例歌' }), '模型起的【标题】')).toEqual(['【《示例歌》】']);
    expect(stageCoverLines(highlight({ kind: 'song', song: '《示例歌》' }), '标题')).toEqual(['【《示例歌》】']);
    expect(stageCoverLines(highlight({ kind: 'song', song: '未知', reason: '三人合唱《另一首》引发回忆杀' }), '标题')).toEqual(['【《另一首》】']);
    expect(stageCoverLines(highlight({ kind: 'song', title: '《标题里的歌》全开麦', reason: '理由里有《别的》' }), '标题')).toEqual(['【《标题里的歌》】']);
    expect(stageCoverLines(highlight({ kind: 'song' }), '认不出歌名')).toEqual(['认不出歌名']);
    expect(stageCoverLines(highlight({ kind: 'song', song: '示例歌' }), '我取的标题', true)).toEqual(['我取的标题']);
    expect(songNameOf(highlight({ kind: 'song' }))).toBeUndefined();
  });

  test('发布标题：【队伍】标题 | 公演名 日期；NII 写「恩兔」，X 写「TeamX」，别的直接写队伍名', (): void => {
    const nii: StageInfo = { team: 'NII', teamColor: '#af83bb', show: '《新芽之契》十三周年庆特别公演', date: '2026.11.22' };

    expect(stagePostTitle(nii, '《光芒》')).toBe('【恩兔】《光芒》 | 《新芽之契》十三周年庆特别公演 2026.11.22');
    expect(stagePostTitle(nii, '草姐：我好像没读过大学')).toBe('【恩兔】草姐：我好像没读过大学 | 《新芽之契》十三周年庆特别公演 2026.11.22');
    expect(stagePostTitle(stage, '忘词现场')).toBe('【TeamX】忘词现场 | 《示例公演》 2026.11.21');
    expect(stagePostTitle({ ...stage, team: 'SII' }, '忘词现场')).toBe('【SII】忘词现场 | 《示例公演》 2026.11.21');
    // 标题里刷荧光笔的记号不写进发布用的标题
    expect(stagePostTitle(stage, '娜姐【耳朵红了】')).toBe('【TeamX】娜姐耳朵红了 | 《示例公演》 2026.11.21');
    expect(['NII', 'nii', 'TEAM NII', 'SNH48 TEAM NII'].map(stageTeamTag)).toEqual(['恩兔', '恩兔', '恩兔', '恩兔']);
    expect(['X', 'Team X', 'SII', 'TEAM HII', 'G', 'NIII', '预备生'].map(stageTeamTag)).toEqual(['TeamX', 'TeamX', 'SII', 'HII', 'G', 'NIII', '预备生']);
  });

  test('唱歌的片段：认得出歌名时第一个标题是「《歌名》」，找爆点时起的排在后面；认不出、别的片段照旧', (): void => {
    expect(stageSongTitle(highlight({ kind: 'song', song: '示例歌' }))).toBe('《示例歌》');
    expect(stageSongTitle(highlight({ kind: 'song', song: '未知' }))).toBeUndefined();
    expect(stageSongTitle(highlight({ kind: 'mc', song: '示例歌' }))).toBeUndefined();
    expect(stageScript(highlight({ kind: 'song', song: '《示例歌》' }))).toMatchObject({ title: '《示例歌》', titles: ['《示例歌》', '标题'] });
    expect(stageScript(highlight({ kind: 'song', song: '未知' }))).toMatchObject({ title: '标题', titles: ['标题'] });
    expect(stageScript(highlight({ kind: 'mistake' }))).toMatchObject({ title: '标题', titles: ['标题'] });
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
    expect(prompt).toContain('reaction：mistake 写粉丝开始刷反应的那条弹幕前面的时间');
    expect((ask.schema as any).properties.highlights.items.required).toEqual(expect.arrayContaining(['kind', 'cover', 'reaction', 'first', 'last']));
    // 封面上的大字就是标题，不再让模型另外写
    expect((ask.schema as any).properties.highlights.items.required).not.toContain('cover_lines');
    expect(prompt).not.toContain('cover_lines');

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
