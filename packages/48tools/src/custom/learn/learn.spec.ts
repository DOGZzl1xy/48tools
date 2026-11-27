/**
 * 持续学习：每场切片记下什么、什么时候该学、学一次以后背景文档和状态怎么变、背景文档怎么附到提示里。Gemini 换成假的。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { digestRecords, hasDecisions, recordFileName, toRecord, type ShowRecord } from './learnRecord';
import { BACKGROUND_LIMIT, learnRequest, learnedPrompt, readLearnAnswer, type LearnAnswer } from './learnPrompt';
import { readBackground, readRecords, readState, saveShowRecord, setLearnDirForTest, learnDir } from './learnStore';
import { freshRecords, learnDue, resetLearnForTest, runLearning, type LearnDeps } from './learnTask';
import { findRequest, knowledge } from '../highlight/highlightGemini';
import type { ShowInfo, ShowItem } from '../highlight/highlightShow';
import type { ClipDraft } from '../highlight/highlightTypes';

const DAY: number = 86_400_000;
const NOW: number = Date.UTC(2026, 10, 27);

function item(change: Partial<ShowItem>): ShowItem {
  return { start: 100.4, end: 160, title: '第一轮的标题', cover: '', quote: '关键的原话', reason: '第一轮的说明', score: 9, recommended: true, cut: false, ...change } as ShowItem;
}

function draft(change: Partial<ClipDraft>): ClipDraft {
  return { titles: ['给的一', '给的二', '给的三'], title: '给的一', points: ['看点一', '看点二'], lines: [], ...change } as ClipDraft;
}

function show(items: Array<ShowItem>, change: Partial<ShowInfo> = {}): ShowInfo {
  return { version: 2, status: 'naming', liveId: 'live/1', member: 'SNH48 测试成员', title: '测试直播', date: '2026.11.26', model: 'm', foundAt: 0, duration: 600, summaries: [], notes: [], items, ...change };
}

describe('记录', (): void => {
  const info: ShowInfo = show([
    item({ cut: true, draft: draft({ title: '我自己写的', ownTitle: '我自己写的', ownPoints: ['看点一'] }) }),
    item({ title: '我改的标题', reason: '我改的说明', original: { title: '第一轮的标题', reason: '第一轮的说明' }, draft: draft({ title: '给的二' }) }),
    item({ score: 8.5, recommended: false })
  ]);
  const record: ShowRecord = toRecord(info, NOW);

  test('记下第一轮写的、切了哪些、改成了什么、定的标题是不是自己写的、看点怎么改的', (): void => {
    expect(record).toMatchObject({ version: 1, liveId: 'live/1', kind: 'live', savedAt: NOW });
    expect(record.items[0]).toMatchObject({
      start: 100, picked: true, made: false, gemini: { title: '第一轮的标题', reason: '第一轮的说明', quote: '关键的原话' },
      titles: { offered: ['给的一', '给的二', '给的三'], chosen: '我自己写的', own: true }, points: { offered: ['看点一', '看点二'], final: ['看点一'] }
    });
    expect(record.items[0].mine).toBeUndefined();
    expect(record.items[1]).toMatchObject({ picked: true, gemini: { title: '第一轮的标题' }, mine: { title: '我改的标题', reason: '我改的说明' }, titles: { chosen: '给的二', own: false } });
    expect(record.items[2]).toMatchObject({ picked: false, recommended: false, score: 8.5 });
    expect(toRecord(show([], { stage: { team: 'X', teamColor: '#a9ca27', show: '《示例》', date: '2026.11.21' } }), NOW)).toMatchObject({ kind: 'stage', team: 'X' });
    expect(toRecord(show([], { radio: true }), NOW).kind).toBe('radio');
  });

  test('只是找完爆点、还没挑的不算做过决定；文件名按日期排', (): void => {
    expect(hasDecisions(record)).toBe(true);
    expect(hasDecisions(toRecord(show([item({}), item({ cut: true })]), NOW))).toBe(false);
    expect(hasDecisions(toRecord(show([item({ clip: { index: 1 } as ShowItem['clip'] })]), NOW))).toBe(true);
    expect(recordFileName(record)).toBe('20261126_live_live_1.json');
  });

  test('写成给 Gemini 看的文字：切没切、分数、原来的和改成的、定的和没选的；太长只留新的', (): void => {
    const text: string = digestRecords([record]);

    expect(text).toContain('【直播｜SNH48 测试成员｜2026.11.26｜测试直播】');
    expect(text).toContain('切了（9 分，程序推荐）');
    expect(text).toContain('没切（8.5 分）');
    expect(text).toContain('定的标题是剪辑者自己写的「我自己写的」（没用给的：「给的一」「给的二」「给的三」）');
    expect(text).toContain('剪辑者把标题改成了「我改的标题」');
    expect(text).toContain('定的标题是给的「给的二」（没选：「给的一」「给的三」）');
    expect(text).toContain('看点从「看点一 / 看点二」改成了「看点一」');

    const old: ShowRecord = { ...record, title: '旧的一场', savedAt: NOW - DAY };

    expect(digestRecords([old, record], 50)).not.toContain('旧的一场');
    expect(digestRecords([old, record])).toMatch(/测试直播[\s\S]*旧的一场/);
  });
});

describe('提示', (): void => {
  test('学习的提问里有现在的背景文档、记录、已有的词汇；结果太长截断、缺字段不报错', (): void => {
    const text: string = learnRequest({ background: '旧的背景', digest: '这是记录', glossary: '甲：乙' }).parts[0].text!;

    expect(text).toContain('<现在的背景文档>\n旧的背景\n</现在的背景文档>');
    expect(text).toContain('<记录>\n这是记录\n</记录>');
    expect(text).toContain('<已有的专有词汇>\n甲：乙');
    expect(learnRequest({ background: '', digest: 'x', glossary: '' }).parts[0].text).toContain('（还没有）');
    expect(learnRequest({ background: '', digest: 'x', glossary: '' }).parts[0].text).not.toContain('<已有的专有词汇>');
    expect(readLearnAnswer({ background: '字'.repeat(BACKGROUND_LIMIT + 50), promptAdvice: ['一', '', 2] }))
      .toEqual({ background: '字'.repeat(BACKGROUND_LIMIT), summary: '', promptAdvice: ['一', '2'] });
    expect(readLearnAnswer(null)).toEqual({ background: '', summary: '', promptAdvice: [] });
  });

  test('背景文档附在每次提示的最后；没有就不加', (): void => {
    expect(learnedPrompt('  ')).toBe('');
    expect(learnedPrompt(undefined)).toBe('');

    const learned: string = learnedPrompt('爱切互相拆台的');
    const meta: { member: string; title: string; learned?: string } = { member: '测试成员', title: '测试直播', learned };

    expect(learned).toContain('<剪辑者的偏好>\n爱切互相拆台的\n</剪辑者的偏好>');
    expect(knowledge(meta)).toContain('爱切互相拆台的');
    expect(findRequest(meta, { start: 0, length: 600 }, 'QUJD', []).parts[0].text).toContain('<剪辑者的偏好>');
    expect(findRequest({ member: '测试成员', title: '测试直播' }, { start: 0, length: 600 }, 'QUJD', []).parts[0].text).not.toContain('<剪辑者的偏好>');
  });
});

describe('学习', (): void => {
  let dir: string;
  let asked: Array<{ background: string; digest: string; glossary: string }>;
  let answer: LearnAnswer | Error;
  let time: number;
  let deps: LearnDeps;
  const decided: ShowInfo = show([item({ cut: true, draft: draft({}) })]);

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
    setLearnDirForTest(dir);
    resetLearnForTest();
    asked = [];
    answer = { background: '一、爱切的内容\n- 互相拆台', summary: '多了一条', promptAdvice: ['标题别太长'] };
    time = NOW;
    deps = {
      enabled: (): boolean => true,
      everyDays: (): number => 3,
      gemini: (): LearnDeps['gemini'] extends () => infer T ? T : never => ({ apiKey: 'k', model: 'm', baseUrl: 'https://gemini.invalid' }),
      glossary: (): string => '甲：乙',
      now: (): number => time,
      ask(_config: unknown, input: { background: string; digest: string; glossary: string }): Promise<LearnAnswer> {
        asked.push(input);

        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }
    };
  });

  afterEach((): void => {
    setLearnDirForTest(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('单元测试里默认不读不写（指定了文件夹才用）', (): void => {
    setLearnDirForTest(undefined);
    expect(learnDir()).toBeUndefined();
    expect(readBackground()).toBe('');
  });

  test('保存清单时存一份记录；没做过决定的不存；同一场再存是覆盖', async (): Promise<void> => {
    await saveShowRecord(show([item({})]), NOW);
    expect(await readRecords()).toEqual([]);
    await saveShowRecord(decided, NOW);
    await saveShowRecord({ ...decided, status: 'done' }, NOW + 1);
    expect(fs.readdirSync(path.join(dir, 'shows'))).toEqual(['20261126_live_live_1.json']);
    expect(await readRecords()).toMatchObject([{ liveId: 'live/1', status: 'done', savedAt: NOW + 1 }]);
  });

  test('该不该学：隔够了天数，而且上次学习以后有新的记录', (): void => {
    const record: ShowRecord = toRecord(decided, NOW);

    expect(learnDue([record], { learnedAt: 0 }, NOW, 3)).toBe(true);                 // 没学过
    expect(learnDue([record], { learnedAt: NOW - DAY }, NOW, 3)).toBe(false);        // 才过了一天
    expect(learnDue([record], { learnedAt: NOW + 1 }, NOW + (4 * DAY), 3)).toBe(false); // 隔够了，但没有新的记录
    expect(freshRecords([record, toRecord(show([item({})]), NOW)], { learnedAt: 0 })).toHaveLength(1);
  });

  test('学一次：问 Gemini，换上新的背景文档（旧的留底），建议存起来，记下时间；没到时间不再问', async (): Promise<void> => {
    await saveShowRecord(decided, NOW - 10);

    let status: Awaited<ReturnType<typeof runLearning>> = await runLearning(deps);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ background: '', glossary: '甲：乙' });
    expect(asked[0].digest).toContain('测试直播');
    expect(readBackground()).toBe('一、爱切的内容\n- 互相拆台');
    expect(fs.readFileSync(path.join(dir, '提示词建议.md'), 'utf8')).toContain('- 标题别太长');
    expect(await readState()).toEqual({ learnedAt: NOW, summary: '多了一条', shows: 1 });
    expect(status).toMatchObject({ running: false, records: 1, fresh: 0 });

    // 第二天又切了一场：还没到 3 天，不学；「现在学一次」可以
    time = NOW + DAY;
    await saveShowRecord({ ...decided, liveId: 'live/2', title: '第二场' }, time - 10);
    status = await runLearning(deps);
    expect(asked).toHaveLength(1);
    expect(status).toMatchObject({ records: 2, fresh: 1 });

    answer = { background: '新的背景', summary: '', promptAdvice: [] };
    await runLearning(deps, true);
    expect(asked).toHaveLength(2);
    expect(asked[1].background).toBe('一、爱切的内容\n- 互相拆台'); // 在原来的基础上更新
    expect(asked[1].digest).toContain('第二场');
    expect(asked[1].digest).not.toContain('测试直播'); // 只给上次学习以后的
    expect(readBackground()).toBe('新的背景');
    expect(fs.readdirSync(path.join(dir, 'history'))).toHaveLength(1);

    // 没有新的记录：强制也不学
    await runLearning(deps, true);
    expect(asked).toHaveLength(2);
  });

  test('没学成（接口出错、没给出文档）：背景文档不动，时间不动，记下原因，下次再试', async (): Promise<void> => {
    await saveShowRecord(decided, NOW - 10);
    answer = new Error('连不上 Gemini 的接口');
    await runLearning(deps);
    expect(readBackground()).toBe('');
    expect(await readState()).toEqual({ learnedAt: 0, error: '连不上 Gemini 的接口' });

    answer = { background: '', summary: '', promptAdvice: [] };
    await runLearning(deps);
    expect((await readState()).error).toBe('没有给出背景文档');

    answer = { background: '好了', summary: '', promptAdvice: [] };
    await runLearning(deps);
    expect(readBackground()).toBe('好了');
    expect((await readState()).error).toBeUndefined();
  });
});
