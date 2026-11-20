import type { MessageInstance } from 'antd/es/message/interface';
import { store } from '../../store/store';
import autoGrab from '../../pages/48/Pocket48/utils/autoGrab';
import { IDBGetPocket48LiveOptions, setAutoGrab } from '../../pages/48/reducers/pocket48';
import type { Pocket48LiveAutoGrabOptions } from '../../pages/48/types';
import { getSetting, setSetting, type AutoGrabMode } from '../settings/settingsStore';
import { getLiveRecordDir } from './liveRecording';

/**
 * 自动抓取（监听指定成员，开播就录）的启动和停止，从「直播抓取」页面里抽出来，这样不打开那个页面也能启动：
 *   - 程序启动后自动开始（custom/shell/AppShell 调用 autoStartAutoGrab；设置里可以关：autoGrabAutoStart）
 *   - 录制方式（flv / ts / 备用 flv）用上次在页面上手动开始时选的（rememberAutoGrabMode），没选过用 flv
 * 真正干活的还是原版的 pages/48/Pocket48/utils/autoGrab（每隔几分钟查一次直播列表），定时器的编号也还是放在
 * 原版的 redux 里（pocket48.autoGrabTimer），所以页面上的「开始 / 停止自动抓取」按钮和这里是同一个状态。
 * 配置（间隔、成员、目录）存在原版的 IndexedDB 里，由 ./AutoGrabOptionsPage 编辑。
 */
export const AUTO_GRAB_OPTIONS_NAME: string = 'pocket48LiveAutoGrabOptions'; // 和原版 LiveOptions.tsx 的 OPTIONS_NAME 一样

export type AutoGrabStartResult = 'started' | 'running' | 'no-config' | 'no-users' | 'no-dir';

/* 配置里的成员（逗号分隔的名字或 ID）拆成数组 */
export function parseAutoGrabUsers(text: string | undefined): Array<string> {
  return (text ?? '').split(/\s*[,，\n]\s*/).map((item: string): string => item.trim()).filter((item: string): boolean => item !== '');
}

export async function readAutoGrabOptions(): Promise<Pocket48LiveAutoGrabOptions | undefined> {
  const result: { result?: { value: Pocket48LiveAutoGrabOptions } }
    = await (store.dispatch as (action: unknown) => Promise<{ result?: { value: Pocket48LiveAutoGrabOptions } }>)(
      IDBGetPocket48LiveOptions({ query: AUTO_GRAB_OPTIONS_NAME }));

  return result?.result?.value;
}

export function isAutoGrabRunning(): boolean {
  return typeof (store.getState() as { pocket48: { autoGrabTimer: number | null } }).pocket48.autoGrabTimer === 'number';
}

/* 记住手动开始时选的录制方式，自动开始时用 */
export function rememberAutoGrabMode(mode: AutoGrabMode): void {
  setSetting('autoGrabMode', mode === 'flv' ? undefined : mode);
}

/**
 * 开始自动抓取
 * @param { MessageInstance } messageApi - 轮询出错时用它提示
 * @param { AutoGrabMode } [mode] - 录制方式，不传用记住的
 */
export async function startAutoGrab(messageApi: MessageInstance, mode?: AutoGrabMode): Promise<AutoGrabStartResult> {
  if (isAutoGrabRunning()) return 'running';

  const options: Pocket48LiveAutoGrabOptions | undefined = await readAutoGrabOptions();

  if (!options) return 'no-config';

  const users: Array<string> = parseAutoGrabUsers(options.users);

  if (users.length === 0) return 'no-users';

  if (!getLiveRecordDir(options.dir ?? '')) return 'no-dir';

  if (isAutoGrabRunning()) return 'running'; // 读配置期间已经在页面上手动开始了

  const used: AutoGrabMode = mode ?? getSetting('autoGrabMode') ?? 'flv';
  const args: [MessageInstance, string, Array<string>, boolean, boolean] = [messageApi, options.dir ?? '', users, used === 'ts', used === 'backup'];
  const minutes: number = Math.max(1, Number(options.time) || 1);

  autoGrab(...args);
  store.dispatch(setAutoGrab(window.setInterval(autoGrab, minutes * 60_000, ...args)));

  return 'started';
}

export function stopAutoGrab(): void {
  store.dispatch(setAutoGrab(null));
}

/* 程序启动后调用：设置里没关、配置好了成员，就自动开始。返回有没有开始 */
export async function autoStartAutoGrab(messageApi: MessageInstance): Promise<boolean> {
  if (getSetting('autoGrabAutoStart') === false) return false;

  try {
    const result: AutoGrabStartResult = await startAutoGrab(messageApi);

    if (result === 'started') messageApi.info('已自动开始自动抓取');

    return result === 'started';
  } catch (err) {
    console.error('自动开始自动抓取失败', err);

    return false;
  }
}
