import { useSyncExternalStore } from 'react';

/**
 * 房间的未读消息数（关注列表头像上的气泡、侧边栏「房间消息」上的数字）。
 *
 * 怎么算未读：每个成员记一个「看到哪了」的时间（seen，存在本机 localStorage）。比这个时间新的消息就是未读。
 *   - 第一次遇到一个成员时，把 seen 定在他当时最新的一条消息上，所以不会把以前的历史消息都算成未读
 *   - 正在看这个房间、并且程序窗口在前台时，新来的消息直接算已读
 *   - 窗口不在前台时来的消息先记成未读，回到窗口时再清零
 *   - 进入一个有未读的房间时清零，并记下一条分隔线的位置（dividers），房间里会在这里画「以下是新消息」
 * 消息从哪来：正在看的房间由页面自己每分钟取一次；其它关注的成员由 ./unreadWatcher 在后台定时检查。
 * 两边取到消息后都调用 noteMessages，把消息的时间交给这里。
 */
export interface UnreadState {
  counts: Record<number, number>;   // 每个成员有多少条没看过的消息
  dividers: Record<number, number>; // 这个时间之后的消息，是进入房间时还没看过的
}

interface SavedEntry {
  seen?: number;      // 看到哪了（消息的时间）
  serverId?: number;  // 房间的地址，后台检查时用，省得每次都去查
  channelId?: number;
}

const SAVED_KEY: string = 'ROOM_UNREAD';
const listeners: Set<() => void> = new Set();

function readSaved(): Record<number, SavedEntry> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null');

    return value && typeof value === 'object' ? value as Record<number, SavedEntry> : {};
  } catch {
    return {};
  }
}

let saved: Record<number, SavedEntry> = readSaved();
let state: UnreadState = { counts: {}, dividers: {} };
let newest: Record<number, number> = {}; // 每个成员已知的最新一条消息的时间
let viewing: number | undefined;         // 正在看哪个成员的房间
let armed: boolean = false;              // 刚进入房间、第一批消息还没取完：这期间发现的新消息要画分隔线
let isWindowFocused: () => boolean = (): boolean => typeof document === 'undefined' || document.hasFocus();

function setState(patch: Partial<UnreadState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
}

function save(ownerId: number, patch: SavedEntry): void {
  saved = { ...saved, [ownerId]: { ...saved[ownerId], ...patch } };

  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch { /* noop */ }
}

function setCount(ownerId: number, count: number): void {
  if ((state.counts[ownerId] ?? 0) === count) return;

  setState({ counts: { ...state.counts, [ownerId]: count } });
}

/* 把一个房间标成已读；withDivider 为 true 时在原来看到的位置留一条分隔线 */
function markRead(ownerId: number, withDivider: boolean): void {
  const seen: number | undefined = saved[ownerId]?.seen;

  if ((newest[ownerId] ?? 0) > (seen ?? 0)) save(ownerId, { seen: newest[ownerId] });

  setState({
    counts: state.counts[ownerId] ? { ...state.counts, [ownerId]: 0 } : state.counts,
    dividers: withDivider && seen !== undefined ? { ...state.dividers, [ownerId]: seen } : state.dividers
  });
}

export function getUnreadState(): UnreadState {
  return state;
}

export function useUnreadState(): UnreadState {
  return useSyncExternalStore((listener: () => void): (() => void) => {
    listeners.add(listener);

    return (): void => {
      listeners.delete(listener);
    };
  }, getUnreadState);
}

/**
 * 交来一个成员的消息时间，更新他的未读数
 * @param { number } ownerId
 * @param { Array<number> } times - 消息的时间，要包含他最新的那些消息
 * @param { number } atLeast - 这些消息没能和「看到哪了」接上时，未读数至少算这么多
 */
export function noteMessages(ownerId: number, times: Array<number>, atLeast: number = 0): void {
  if (times.length === 0) return;

  const seen: number | undefined = saved[ownerId]?.seen;
  let count: number = 0;
  let max: number = newest[ownerId] ?? 0;

  for (const time of times) {
    if (time > max) max = time;

    if (seen !== undefined && time > seen) count++;
  }

  newest[ownerId] = max;

  // 第一次遇到这个成员：从现在开始算
  if (seen === undefined) {
    save(ownerId, { seen: max });

    return;
  }

  if (count > 0 && atLeast > count) count = atLeast;

  if (count > 0 && viewing === ownerId && isWindowFocused()) {
    markRead(ownerId, armed);
    armed = false;
  } else {
    setCount(ownerId, count);
  }
}

/* 页面告诉这里：现在正在看哪个成员的房间（离开时传 undefined） */
export function setViewing(ownerId: number | undefined): void {
  viewing = ownerId;
  armed = ownerId !== undefined;

  if (Object.keys(state.dividers).length > 0) setState({ dividers: {} });

  if (ownerId !== undefined && (state.counts[ownerId] ?? 0) > 0 && isWindowFocused()) {
    markRead(ownerId, true);
    armed = false;
  }
}

/* 房间的第一批消息已经取完：之后看着房间时来的新消息不再画分隔线 */
export function settleViewing(ownerId: number): void {
  if (viewing === ownerId) armed = false;
}

/* 程序窗口回到前台：正在看的房间里攒下的未读清零 */
export function handleWindowFocus(): void {
  if (viewing !== undefined && (state.counts[viewing] ?? 0) > 0) markRead(viewing, true);
}

export function getViewing(): number | undefined {
  return viewing;
}

export function getSeen(ownerId: number): number | undefined {
  return saved[ownerId]?.seen;
}

export function getChannel(ownerId: number): { serverId: number; channelId: number } | undefined {
  const entry: SavedEntry | undefined = saved[ownerId];

  return entry?.serverId && entry.channelId ? { serverId: entry.serverId, channelId: entry.channelId } : undefined;
}

export function setChannel(ownerId: number, serverId: number, channelId: number): void {
  if (saved[ownerId]?.serverId === serverId && saved[ownerId]?.channelId === channelId) return;

  save(ownerId, { serverId, channelId });
}

/* 这些成员一共有多少条未读 */
export function totalUnread(counts: Record<number, number>, ownerIds: Array<number>): number {
  return ownerIds.reduce((sum: number, ownerId: number): number => sum + (counts[ownerId] ?? 0), 0);
}

/* 气泡上显示的文字 */
export function unreadText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/* 测试用 */
export function resetUnreadForTest(focused: boolean = true): void {
  saved = {};
  state = { counts: {}, dividers: {} };
  newest = {};
  viewing = undefined;
  armed = false;
  isWindowFocused = (): boolean => focused;
  listeners.clear();
}
