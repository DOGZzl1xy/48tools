/**
 * 写好、等人定标题的切片：选标题、改亮点、改字幕、封面上写什么、发布用的标题、播放时跳过剪掉的地方。
 */
import {
  basisOf, draftCoverLines, draftPoints, draftPostTitles, draftSegments, editCoverLine, editLine, editPoint, fromOut, isOwnTitle, lineAt, lookOf, newDraft,
  pickTitle, playAt, type DraftInput
} from './highlightDraft';
import { toOut } from './highlightCut';
import type { CaptionLine, ClipDraft, ClipScript, Highlight, Segment } from './highlightTypes';

const highlight: Highlight = { start: 100, end: 180, title: '找爆点时的标题', cover: '封面的话', quote: '', reason: '说明', score: 8 };
const script: ClipScript = {
  lines: [], title: '第一个', titles: ['第一个', '第二个', '第三个'], more: ['另一个梗'], description: '简介。', points: ['亮点一', '亮点二'], people: ['成员乙']
};

function line(start: number, keep: boolean = true, text: string = `${ start } 秒的话`): CaptionLine {
  return { start, end: start + 3, text, keep, emphasis: [] };
}

// 两截：5 ~ 11 秒的两句，中间剪掉一句，30 秒的一句
const lines: Array<CaptionLine> = [line(5), line(8), line(15, false), line(30)];

function draftOf(patch: Partial<DraftInput> = {}, own?: string): ClipDraft {
  return newDraft({ title: '找爆点时的标题', reason: '说明', coverTitle: own }, {
    key: '100', window: { start: 85, length: 120 }, script, lines, timing: '本地模型打轴', whole: false, frames: [1, 4], frame: 1, ...patch
  });
}

describe('写好的草稿', (): void => {
  test('标题先用 Gemini 最满意的；挑片的人取过就用他的', (): void => {
    expect(draftOf()).toMatchObject({ key: '100', start: 85, length: 120, title: '第一个', titles: ['第一个', '第二个', '第三个'], points: ['亮点一', '亮点二'], frame: 1 });
    expect(isOwnTitle(draftOf())).toBe(false);
    expect(draftOf().basis).toBe(basisOf(highlight)); // 之后改了说明就对不上，要重新写

    const own: ClipDraft = draftOf({}, '我取的');

    expect(own).toMatchObject({ title: '我取的', ownTitle: '我取的', titles: ['第一个', '第二个', '第三个'] });
    expect(isOwnTitle(own)).toBe(true);
    // 以前的结果没有 titles
    expect(draftOf({ script: { ...script, titles: undefined } }).titles).toEqual(['第一个']);
  });

  test('选标题、自己写：自己写过的记着，选回 Gemini 的还能再选上；空的不改', (): void => {
    const own: ClipDraft = pickTitle(draftOf(), ' 我取的 ');
    const back: ClipDraft = pickTitle(own, '第二个');

    expect(own).toMatchObject({ title: '我取的', ownTitle: '我取的' });
    expect(back).toMatchObject({ title: '第二个', ownTitle: '我取的' });
    expect(pickTitle(back, '  ')).toBe(back);
    expect(pickTitle(back, '第二个')).toBe(back);
  });

  test('亮点：改、删、加，最多三个；空的不写上去；改回 Gemini 写的就不算改过', (): void => {
    const draft: ClipDraft = draftOf();
    const added: ClipDraft = editPoint(draft, 2, '');
    const typed: ClipDraft = editPoint(added, 2, ' 亮点三 ');

    expect(draftPoints(added)).toEqual(['亮点一', '亮点二']);
    expect(draftPoints(typed)).toEqual(['亮点一', '亮点二', '亮点三']);
    expect(draftPoints(editPoint(typed, 0, undefined))).toEqual(['亮点二', '亮点三']);
    expect(editPoint(typed, 2, undefined).ownPoints).toBeUndefined();
    expect(editPoint(editPoint(draft, 0, '改了'), 0, '亮点一')).toEqual(draft);
    expect(draftPoints({ points: ['一', '二', '三', '四'] })).toEqual(['一', '二', '三']);
  });

  test('公演的封面大字：Gemini 的标题用 Gemini 的大字，自己取的标题就只写它，改过的用改过的', (): void => {
    const stage: Highlight = { ...highlight, kind: 'mc', coverLines: ['模型的', '【大字】'] };

    expect(draftCoverLines(stage, draftOf())).toEqual(['模型的', '【大字】']);
    expect(draftCoverLines(stage, pickTitle(draftOf(), '我取的'))).toEqual(['我取的']);

    const edited: ClipDraft = editCoverLine(stage, draftOf(), 0, '改过的');

    expect(draftCoverLines(stage, edited)).toEqual(['改过的', '【大字】']);
    expect(draftCoverLines(stage, pickTitle(edited, '我取的'))).toEqual(['改过的', '【大字】']);
    expect(editCoverLine(stage, edited, 0, '模型的').ownCoverLines).toBeUndefined();
    // 唱歌的只写歌名；自己取了标题就写标题
    const song: Highlight = { ...highlight, kind: 'song', song: '《示例歌》' };

    expect(draftCoverLines(song, draftOf())).toEqual(['【《示例歌》】']);
    expect(draftCoverLines(song, pickTitle(draftOf(), '我取的'))).toEqual(['我取的']);
  });

  test('发布用的标题：选的是 Gemini 的就用选的，另外的当备选；自己取的不写进去', (): void => {
    const job: { member: string; date: string } = { member: 'SNH48 成员甲', date: '2026.11.24' };

    expect(draftPostTitles(job, pickTitle(draftOf(), '第二个'))).toEqual({
      post: '【成员甲&成员乙】第二个 | 另一个梗 | 20261124 直播切片',
      others: ['【成员甲&成员乙】第一个 | 另一个梗 | 20261124 直播切片', '【成员甲&成员乙】第三个 | 另一个梗 | 20261124 直播切片']
    });

    const own: { post: string; others: Array<string> } = draftPostTitles(job, pickTitle(draftOf(), '我取的'));

    expect(own.post).toContain('第一个');
    expect(own.others).toHaveLength(2);
    expect(JSON.stringify(own)).not.toContain('我取的');
    expect(draftPostTitles({ ...job, stage: { team: 'X', teamColor: '#a9ca27', show: '《示例公演》', date: '2026.11.24' } }, draftOf()).post)
      .toBe('【SNH48 TEAM X｜成员乙】第一个 | 《示例公演》 2026.11.24 公演切片');
  });

  test('看得见的东西变了没有：标题、亮点、画面、大字算，字幕不算，加了一个空的亮点不算', (): void => {
    const draft: ClipDraft = draftOf();

    for (const changed of [pickTitle(draft, '第二个'), editPoint(draft, 0, '改了'), { ...draft, frame: 0 }, { ...draft, ownCoverLines: ['大字'] }]) {
      expect(lookOf(changed)).not.toBe(lookOf(draft));
    }

    expect(lookOf(editLine(draft, 0, '改字'))).toBe(lookOf(draft));
    expect(lookOf(editPoint(draft, 2, ''))).toBe(lookOf(draft));
  });

  test('改字幕：只改字，剪的地方不变；清空的不显示', (): void => {
    const draft: ClipDraft = draftOf();
    const edited: ClipDraft = editLine(editLine(draft, 0, ' 改了 '), 1, '');

    expect(edited.lines.map((item: CaptionLine): string => item.text)).toEqual(['改了', '', '15 秒的话', '30 秒的话']);
    expect(draftSegments(edited)).toEqual(draftSegments(draft));
  });
});

describe('时间', (): void => {
  const { segments, total }: { segments: Array<Segment>; total: number } = draftSegments({ lines, length: 120 });

  test('成片由哪几截拼成；唱歌、失误整段保留', (): void => {
    expect(segments).toHaveLength(2);
    expect(draftSegments({ lines: [], length: 70, whole: true })).toEqual({ segments: [{ from: 0, to: -1, start: 0, end: 70, out: 0 }], total: 70 });
  });

  test('成片里的时间换回这一段里的时间，和换过去的对得上', (): void => {
    for (const time of [0, 2, segments[1].out + 0.5, total - 0.1]) expect(toOut(segments, fromOut(segments, time))).toBeCloseTo(time, 3);

    expect(fromOut([], 5)).toBe(5);
  });

  test('放录播里的这一段：剪掉的地方跳到下一截，放完就停；字幕照时间换', (): void => {
    expect(playAt(segments, 6)).toEqual({ go: 'play' });
    expect(playAt(segments, 0)).toEqual({ go: 'jump', to: segments[0].start });
    expect(playAt(segments, 16)).toEqual({ go: 'jump', to: segments[1].start });
    expect(playAt(segments, 100)).toEqual({ go: 'stop' });
    expect(lineAt(lines, 6)?.text).toBe('5 秒的话');
    expect(lineAt(lines, 11.5)?.text).toBe('8 秒的话'); // 说完再停一会儿
    expect(lineAt(lines, 16)).toBeUndefined();          // 剪掉的那句
  });
});
