import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { useSyncExternalStore } from 'react';
import { readShowInfo, writeShowInfo, SHOW_FILE, type ShowInfo } from './highlightShow';

/**
 * 切片页面用的数据：各场录播的爆点清单（./highlightShow 的 爆点.json）。
 * 清单就放在各场的切片文件夹里，这里扫一遍文件夹读出来；文件夹删掉、搬走了，列表里也就没了。
 * 改清单都走 updateShow：同一场的改动一个接一个做（每次先读最新的再改），界面上改字和后台切完记结果不会互相盖掉。
 * 哪些文件夹由 setShowRoots 告诉（./highlightTask 和 ../bilibili 各有各的保存位置，放在这里会互相引用）。
 */
export interface Show {
  dir: string;
  info: ShowInfo;
}

interface State {
  shows: Array<Show>;
  loaded: boolean;
  selected?: string; // 切片页面里正在看的是哪一场（文件夹）
}

let state: State = { shows: [], loaded: false };
let roots: () => Array<{ dir: string; sub?: string }> = (): Array<{ dir: string; sub?: string }> => [];
const listeners: Set<() => void> = new Set();
const chains: Map<string, Promise<unknown>> = new Map();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
}

const order: Record<ShowInfo['status'], number> = { naming: 0, waiting: 1, done: 2 };

/* 等你定标题的在前，然后是等你挑的；同样的按时间，新的在前 */
export function sortShows(shows: Array<Show>): Array<Show> {
  return [...shows].sort((a: Show, b: Show): number => (order[a.info.status] - order[b.info.status]) || (b.info.foundAt - a.info.foundAt));
}

/* sub：爆点清单在每一场的文件夹下面的哪个文件夹里（公演的在「切片」里） */
export function setShowRoots(value: () => Array<{ dir: string; sub?: string }>): void {
  roots = value;
}

async function readRoot(root: { dir: string; sub?: string }): Promise<Array<Show>> {
  let names: Array<string> = [];

  try {
    names = (await fsP.readdir(root.dir, { withFileTypes: true }))
      .filter((entry: fs.Dirent): boolean => entry.isDirectory())
      .map((entry: fs.Dirent): string => entry.name);
  } catch { /* 还没有这个文件夹 */ }

  const shows: Array<Show | undefined> = await Promise.all(names.map(async (name: string): Promise<Show | undefined> => {
    const dir: string = path.join(root.dir, name, root.sub ?? '');
    const info: ShowInfo | undefined = fs.existsSync(path.join(dir, SHOW_FILE)) ? await readShowInfo(dir) : undefined;

    return info && { dir, info };
  }));

  return shows.filter((show: Show | undefined): show is Show => show !== undefined);
}

/* 重新扫一遍 */
export async function refreshShows(): Promise<void> {
  const shows: Array<Show> = (await Promise.all(roots().map(readRoot))).flat();

  set({ shows: sortShows(shows), loaded: true });
}

function replaceShow(dir: string, info: ShowInfo): void {
  set({ shows: sortShows([...state.shows.filter((show: Show): boolean => show.dir !== dir), { dir, info }]) });
}

/* 文件夹里的清单是别处写的（刚找完爆点）：读进来 */
export async function reloadShow(dir: string): Promise<void> {
  const info: ShowInfo | undefined = await readShowInfo(dir);

  info && replaceShow(dir, info);
}

/**
 * 改一场的清单：先读最新的，改完存起来。同一场的改动排队做
 * @param { string } dir
 * @param { (info: ShowInfo) => ShowInfo } change - 返回原来的对象表示不用改
 */
export function updateShow(dir: string, change: (info: ShowInfo) => ShowInfo): Promise<ShowInfo | undefined> {
  const next: Promise<ShowInfo | undefined> = (chains.get(dir) ?? Promise.resolve()).catch((): void => undefined).then(async (): Promise<ShowInfo | undefined> => {
    const info: ShowInfo | undefined = await readShowInfo(dir);

    if (!info) return undefined;

    const changed: ShowInfo = change(info);

    if (changed !== info) await writeShowInfo(dir, changed);

    replaceShow(dir, changed);

    return changed;
  });

  chains.set(dir, next);

  return next;
}

/* 清单删掉了：列表里也拿掉 */
export function forgetShow(dir: string): void {
  set({ shows: state.shows.filter((show: Show): boolean => show.dir !== dir) });
}

export function selectShow(dir: string | undefined): void {
  set({ selected: dir });
}

export function getShowState(): State {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

export function useShowState(): State {
  return useSyncExternalStore(subscribe, getShowState);
}

/* 有几场在等着挑、等着定标题 */
export function waitingCount(shows: Array<Show>): number {
  return shows.filter((show: Show): boolean => show.info.status !== 'done').length;
}

/* 测试用 */
export function resetShowsForTest(): void {
  state = { shows: [], loaded: false };
  listeners.clear();
  chains.clear();
}
