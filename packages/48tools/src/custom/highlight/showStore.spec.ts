/**
 * 切片页面的数据：从文件夹里扫出各场、等你挑的排前面、同一场的改动一个接一个做。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getShowState, refreshShows, reloadShow, resetShowsForTest, setShowRoots, updateShow, waitingCount, type Show } from './showStore';
import { newShowInfo, readShowInfo, writeShowInfo, type ShowInfo, type ShowItem } from './highlightShow';

function infoOf(liveId: string, foundAt: number, status: ShowInfo['status']): ShowInfo {
  return {
    ...newShowInfo({ liveId, member: 'SNH48 成员甲', title: liveId, date: '2026.11.23' }, {
      model: 'test-model', duration: 1_000, summaries: [], notes: [], recommended: new Set([0]),
      items: [{ start: 100, end: 180, title: '一', cover: '', quote: '', reason: '说明', score: 8 }, { start: 300, end: 380, title: '二', cover: '', quote: '', reason: '说明', score: 7 }]
    }),
    foundAt, status
  };
}

describe('showStore', (): void => {
  let root: string;

  beforeEach((): void => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-'));
    resetShowsForTest();
    setShowRoots((): Array<{ dir: string; sub?: string }> => [
      { dir: path.join(root, '录播切片') }, { dir: path.join(root, 'B站公演'), sub: '切片' }, { dir: path.join(root, '没有这个文件夹') }
    ]);
  });

  afterEach((): void => fs.rmSync(root, { recursive: true, force: true }));

  test('直播的在文件夹里，公演的在「切片」里；没有清单的不算；等你挑的在前，同样的新的在前', async (): Promise<void> => {
    await writeShowInfo(path.join(root, '录播切片', '挑过的'), infoOf('挑过的', 3, 'done'));
    await writeShowInfo(path.join(root, '录播切片', '旧的'), infoOf('旧的', 1, 'waiting'));
    await writeShowInfo(path.join(root, '录播切片', '写好的'), infoOf('写好的', 0, 'naming'));
    await writeShowInfo(path.join(root, 'B站公演', '公演', '切片'), infoOf('公演', 2, 'waiting'));
    fs.mkdirSync(path.join(root, '录播切片', '以前切的'));
    await refreshShows();

    expect(getShowState().shows.map((show: Show): string => show.info.liveId)).toEqual(['写好的', '公演', '旧的', '挑过的']);
    expect(waitingCount(getShowState().shows)).toBe(3);
  });

  test('同时改同一场：一个接一个，不会互相盖掉', async (): Promise<void> => {
    const dir: string = path.join(root, '录播切片', '一场');

    await writeShowInfo(dir, infoOf('一场', 1, 'waiting'));
    await reloadShow(dir);

    const change: (index: number) => Promise<unknown> = (index: number): Promise<unknown> => updateShow(dir, (info: ShowInfo): ShowInfo => ({
      ...info, items: info.items.map((item: ShowItem, order: number): ShowItem => (order === index ? { ...item, title: `改过${ index }` } : item))
    }));

    await Promise.all([change(0), change(1), updateShow(dir, (info: ShowInfo): ShowInfo => ({ ...info, status: 'done' }))]);

    const saved: ShowInfo | undefined = await readShowInfo(dir);

    expect(saved?.items.map((item: ShowItem): string => item.title)).toEqual(['改过0', '改过1']);
    expect(saved?.status).toBe('done');
    expect(getShowState().shows[0].info).toEqual(saved);
  });

  test('前一个改动出错，后面的照样改；清单没了返回 undefined', async (): Promise<void> => {
    const dir: string = path.join(root, '录播切片', '一场');

    await writeShowInfo(dir, infoOf('一场', 1, 'waiting'));
    await expect(updateShow(dir, (): ShowInfo => {
      throw new Error('坏了');
    })).rejects.toThrow('坏了');
    expect((await updateShow(dir, (info: ShowInfo): ShowInfo => ({ ...info, status: 'done' })))?.status).toBe('done');

    fs.rmSync(dir, { recursive: true });
    expect(await updateShow(dir, (info: ShowInfo): ShowInfo => info)).toBeUndefined();
  });
});
