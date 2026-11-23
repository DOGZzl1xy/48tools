/**
 * 切片页面的「开始切片」「不切了」：不能开始时给原因、用哪份素材、做一个记一个、切完告诉自动抓取。真正的切片换成假的。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QueuedHighlight } from './highlightTask';
import type { ClipResult } from './highlightPipeline';
import { newShowInfo, pickKey, readShowInfo, writeShowInfo, type ShowInfo, type ShowItem } from './highlightShow';
import { getShowState, resetShowsForTest, updateShow, type Show } from './showStore';
import { cancelShow, deleteReplay, removeShow, replayBytes, replayFiles, startPick, type ReplayFile } from './pickTask';

const mockQueued: Array<QueuedHighlight> = [];
const mockEnded: Array<string> = [];
const mockPrepared: Array<string> = [];
const mockStopped: Array<string> = [];
const mockTrashed: Array<string> = [];
let mockKept: { file: string } | undefined;
let mockQueuedKeys: Array<string> = [];
let mockUnavailable: string | undefined;
let mockManifest: object | undefined;

jest.mock('../common/trashFile', (): object => ({
  trashFile(file: string): Promise<void> {
    if (file.includes('占用')) return Promise.reject(new Error('EBUSY'));

    mockTrashed.push(file);
    jest.requireActual<typeof import('node:fs')>('node:fs').rmSync(file);

    return Promise.resolve();
  }
}));
jest.mock('./highlightTask', (): object => ({
  findKeptReplay: (): { file: string } | undefined => mockKept,
  stopHighlight: (key: string): Promise<void> => {
    mockStopped.push(key);
    mockQueuedKeys = mockQueuedKeys.filter((item: string): boolean => item !== key);

    return Promise.resolve();
  },
  endWaiting: (liveId: string, outcome: string): void => void mockEnded.push(`${ liveId } ${ outcome }`),
  enqueueHighlight: (task: QueuedHighlight): void => void mockQueued.push(task),
  highlightBaseDir: (): undefined => undefined,
  highlightDeps: {},
  highlightGeminiConfig: (): object => ({}),
  highlightUnavailable: (): string | undefined => mockUnavailable,
  isHighlightQueued: (key: string): boolean => mockQueuedKeys.includes(key),
  localSource: (file: string): Promise<object> => {
    mockPrepared.push(`本机 ${ file }`);

    return Promise.resolve({ source: file, danmu: [] });
  },
  prepareLive: (): Promise<object> => {
    mockPrepared.push('直播');

    return Promise.resolve({ source: 'live.mp4', danmu: [] });
  }
}));
jest.mock('./highlightPipeline', (): object => ({
  DOWNLOAD_END: 30,
  // 第一个做成，后面的都太短
  async cutHighlights(_job: object, _deps: object, _prepared: object, info: ShowInfo, onProgress: (progress: object) => void,
    onMade: (item: ShowItem, result: ClipResult | string) => Promise<void>): Promise<object> {
    const cuts: Array<ShowItem> = info.items.filter((item: ShowItem): boolean => item.cut);
    const clip: object = { index: 1, title: '新的', postTitle: '【成员甲】新的', otherTitles: [], description: '简介。', start: cuts[0].start, end: cuts[0].end, duration: 80, score: 8 };

    onProgress({ percent: 50, detail: '合成' });
    await onMade(cuts[0], clip as ClipResult);

    for (const item of cuts.slice(1)) await onMade(item, '剪完太短');

    return { clips: [clip], skipped: cuts.slice(1).map((item: ShowItem): string => `「${ item.title }」剪完太短`) };
  }
}));
jest.mock('../../utils/utils', (): object => ({ getFFmpeg: (): string => 'ffmpeg' }));
jest.mock('../bilibili/gongyanSource', (): object => ({
  prepareGongyanSource: (): Promise<object> => {
    mockPrepared.push('公演');

    return Promise.resolve({ source: 'stage.mp4', danmu: [], parts: 1 });
  }
}));
jest.mock('../bilibili/gongyanFiles', (): object => ({ readManifest: (): object | undefined => mockManifest }));
jest.mock('../bilibili/gongyanWatcher', (): object => ({ gongyanBaseDir: (): undefined => undefined }));
jest.mock('../room/memberDirectory', (): object => ({ getMemberDirectory: (): object => ({ members: [] }), loadMemberDirectory: (): Promise<void> => Promise.resolve() }));
jest.mock('./glossaryFile', (): object => ({ readGlossaryFile: (): string => '' }));
jest.mock('./highlightMembers', (): object => ({ membersPrompt: (): string => '' }));

function infoOf(patch: Partial<ShowInfo> = {}): ShowInfo {
  return {
    ...newShowInfo({ liveId: '123', member: 'SNH48 成员甲', title: '测试', date: '2026.11.23' }, {
      model: 'test-model', duration: 600, summaries: [], notes: [], recommended: new Set([0, 1]),
      items: ['一', '二', '三'].map((title: string, order: number): object => ({
        start: order * 100, end: (order * 100) + 80, title, cover: '', quote: '', reason: '说明', score: 8
      })) as Array<ShowItem>
    }),
    ...patch
  };
}

describe('pickTask', (): void => {
  const signal: AbortSignal = new AbortController().signal;
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    mockQueued.length = 0;
    mockEnded.length = 0;
    mockPrepared.length = 0;
    mockStopped.length = 0;
    mockTrashed.length = 0;
    mockKept = undefined;
    mockQueuedKeys = [];
    mockUnavailable = undefined;
    mockManifest = undefined;
    resetShowsForTest();
  });

  afterEach((): void => fs.rmSync(dir, { recursive: true, force: true }));

  test('没选、正在切、Gemini 没设置好、公演录像没了：给原因，不排队', (): void => {
    const info: ShowInfo = infoOf();

    expect(startPick(dir, { ...info, items: info.items.map((item: ShowItem): ShowItem => ({ ...item, cut: false })) })).toBe('还没有选要切的');

    mockUnavailable = '还没有填写 Gemini 的 API key';
    expect(startPick(dir, info)).toBe('还没有填写 Gemini 的 API key');

    mockUnavailable = undefined;
    mockQueuedKeys = [pickKey(info)];
    expect(startPick(dir, info)).toContain('正在切');

    mockQueuedKeys = ['gongyan-123'];
    expect(startPick(dir, info)).toContain('正在重新找爆点');

    mockQueuedKeys = [];
    expect(startPick(dir, infoOf({ stage: { team: 'NII', teamColor: '#af83bb', show: '测试公演', date: '2026.11.23' } }))).toContain('manifest.json');
    expect(mockQueued).toHaveLength(0);
  });

  test('素材：直播照原来的方式准备；自动抓取的用记下的那份（没了就照原来的）；公演用录像文件夹里的', async (): Promise<void> => {
    const file: string = path.join(dir, '录播.mp4');

    fs.writeFileSync(file, '');
    startPick(dir, infoOf());
    startPick(dir, infoOf({ local: { file } }));
    startPick(dir, infoOf({ local: { file: path.join(dir, '删掉了.mp4') } }));
    mockManifest = { show: { liveId: '123' } };
    startPick(dir, infoOf({ stage: { team: 'NII', teamColor: '#af83bb', show: '测试公演', date: '2026.11.23' } }));

    for (const task of mockQueued) await task.prepare(signal, (): void => undefined);

    expect(mockPrepared).toEqual(['直播', `本机 ${ file }`, '直播', '公演']);
    expect(mockQueued[0].job).toMatchObject({ liveId: '123', member: 'SNH48 成员甲', outDir: dir, workDir: path.join(dir, '.work') });
  });

  test('照排队时最新的选择切，做一个记一个；切完是「挑过的」，告诉自动抓取', async (): Promise<void> => {
    const progress: Array<number> = [];

    await writeShowInfo(dir, infoOf());
    startPick(dir, infoOf());
    // 排队的时候又改了：第一个不切了，第三个要切
    await updateShow(dir, (info: ShowInfo): ShowInfo => ({ ...info, items: info.items.map((item: ShowItem, order: number): ShowItem => ({ ...item, cut: order > 0 })) }));

    const text: string = await mockQueued[0].process!({ source: '', danmu: [] }, (one: { percent: number }): void => void progress.push(one.percent), signal);
    const saved: ShowInfo | undefined = await readShowInfo(dir);

    expect(text).toBe('做了 1 个切片：新的；「三」剪完太短');
    expect(progress).toEqual([65]);
    expect(saved?.status).toBe('done');
    expect(saved?.items.map((item: ShowItem): string => `${ item.cut } ${ item.clip?.index ?? '-' } ${ item.problem ?? '-' }`)).toEqual(['false - -', 'false 1 -', 'false - 剪完太短']);
    expect(mockEnded).toEqual(['123 done']);
  });

  test('取消切片：正在切的停下来，都改成不切，告诉自动抓取没切；录播、做好的切片都留着', async (): Promise<void> => {
    fs.mkdirSync(path.join(dir, '.work'));
    fs.writeFileSync(path.join(dir, '.work', 'source.mp4'), '12345');
    fs.writeFileSync(path.join(dir, '01-做好的.mp4'), '');
    await writeShowInfo(dir, infoOf());
    mockQueuedKeys = ['pick-123'];
    await cancelShow(dir, infoOf());

    const saved: ShowInfo | undefined = await readShowInfo(dir);

    expect(saved?.status).toBe('done');
    expect(saved?.items.some((item: ShowItem): boolean => item.cut)).toBe(false);
    expect(mockStopped).toEqual(['pick-123']);
    expect(mockEnded).toEqual(['123 stopped']);
    expect(replayBytes(dir, infoOf())).toBe(5);
    expect(fs.existsSync(path.join(dir, '01-做好的.mp4'))).toBe(true);
  });

  test('取消以后在下载队列里点重试：没有要切的，报错，不会当成切完了', async (): Promise<void> => {
    await writeShowInfo(dir, infoOf());
    startPick(dir, infoOf());
    await cancelShow(dir, infoOf());
    mockEnded.length = 0;
    await expect(mockQueued[0].process!({ source: '', danmu: [] }, (): void => undefined, signal)).rejects.toThrow('没有选要切的');
    expect(mockEnded).toEqual([]);
  });

  test('完整录播：找爆点时下好的、自动抓取或者手动下好的（带弹幕、封面），公演的录像；没有的不算', (): void => {
    const names: (info: ShowInfo) => Array<string> = (info: ShowInfo): Array<string> => replayFiles(dir, info).map((file: ReplayFile): string => file.name);

    expect(names(infoOf())).toEqual([]);

    fs.mkdirSync(path.join(dir, '.work'));
    fs.writeFileSync(path.join(dir, '.work', 'source.mp4'), '12345');

    for (const name of ['录音.m4a', '录音.lrc', '录音.jpg', '手动下的.mp4', '公演.mp4']) fs.writeFileSync(path.join(dir, name), '1');

    expect(names(infoOf())).toEqual(['source.mp4']);

    mockKept = { file: path.join(dir, '手动下的.mp4') };
    expect(names(infoOf())).toEqual(['source.mp4', '手动下的.mp4']);
    expect(names(infoOf({ local: { file: path.join(dir, '录音.m4a') } }))).toEqual(['source.mp4', '录音.m4a', '录音.lrc', '录音.jpg']);

    mockManifest = { joined: '公演.mp4', parts: [{ file: 'part-01.ts' }] };
    expect(replayFiles(path.join(dir, '切片'), infoOf({ stage: { team: 'NII', teamColor: '#af83bb', show: '测试公演', date: '' } })).map((file: ReplayFile): string => file.name)).toEqual(['公演.mp4']);
  });

  test('删除完整录播：放进回收站，别的不动；正在切不能删，被占用时说是哪个文件', async (): Promise<void> => {
    const local: string = path.join(dir, '录播.mp4');

    fs.mkdirSync(path.join(dir, '.work'));

    for (const name of ['.work/source.mp4', '录播.mp4', '录播.lrc', '01-做好的.mp4']) fs.writeFileSync(path.join(dir, name), '1');

    await writeShowInfo(dir, infoOf({ local: { file: local } }));
    mockQueuedKeys = ['pick-123'];
    await expect(deleteReplay(dir, infoOf({ local: { file: local } }))).rejects.toThrow('先取消再删');
    expect(mockTrashed).toEqual([]);

    mockQueuedKeys = [];
    await deleteReplay(dir, infoOf({ local: { file: local } }));
    expect(mockTrashed.map((file: string): string => path.basename(file))).toEqual(['source.mp4', '录播.mp4', '录播.lrc']);
    expect(fs.readdirSync(dir).sort()).toEqual(['01-做好的.mp4', '切片说明.txt', '爆点.json'].sort());

    const busy: string = path.join(dir, '占用.mp4');

    fs.writeFileSync(busy, '1');
    await expect(deleteReplay(dir, infoOf({ local: { file: busy } }))).rejects.toThrow('没有删掉 占用.mp4');
  });

  test('从列表移除：等着挑的先取消，只删清单，切片和说明不动', async (): Promise<void> => {
    fs.writeFileSync(path.join(dir, '01-做好的.mp4'), '');
    await writeShowInfo(dir, infoOf());
    await updateShow(dir, (info: ShowInfo): ShowInfo => info);
    expect(getShowState().shows).toHaveLength(1);

    await removeShow(dir, infoOf());
    expect(fs.readdirSync(dir).sort()).toEqual(['01-做好的.mp4', '切片说明.txt'].sort());
    expect(getShowState().shows.map((show: Show): string => show.dir)).toEqual([]);
    expect(mockEnded).toEqual(['123 stopped']);
  });
});
