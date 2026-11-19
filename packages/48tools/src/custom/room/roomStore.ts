import { useSyncExternalStore } from 'react';
import {
  requestServerSearch,
  requestServerJump,
  requestHomeownerMessage,
  type ServerSearchResult,
  type ServerApiItem,
  type ServerJumpResult,
  type HomeMessageResult,
  type CustomMessageV2
} from '@48tools-api/48';
import { FormatData } from '../../pages/48/RoomMessage/utils/formatData';
import { source, getPocket48Token } from '../../utils/snh48';
import { readRoomCache, writeRoomCache, clearRoomCache, type RoomCacheData } from './roomCache';
import type { FormatCustomMessage } from '../../pages/48/types';

/**
 * 口袋房间（聊天风格的新页面）的数据：关注列表、每个房间已经加载的消息。
 *
 * 房间消息是怎么取到的（都是口袋48的 HTTP 接口，需要登录后的 token，不需要网易云信 SDK）：
 *   1. 搜索成员：POST /im/api/v1/im/server/search，参数 { searchContent }，
 *      返回 serverApiList，每一项有 serverOwner（成员的用户 ID）、serverDefaultName（名字）、serverDefaultIcon（头像）
 *   2. 找到成员的房间：POST /im/api/v1/im/server/jump，参数 { starId: 成员 ID, targetType: 1 }，
 *      返回 serverId 和 channelId
 *   3. 取房主（成员本人）发的消息：POST /im/api/v1/team/message/list/homeowner，
 *      参数 { serverId, channelId, nextTime, limit }。第一次 nextTime 传 0，拿到最新的一批；
 *      返回里的 nextTime 再传回去，就是更早的一批，这样一直往前翻
 * 这三个请求都在 services/48/index.ts 里（原版就有），这里只是换了一种组织方式：
 * 关注列表存在本机（localStorage），往上滚动时自动取更早的一批。
 *
 * 本地缓存（./roomCache，IndexedDB）：取到的消息会存到本机。下次打开房间时先显示本地的消息，
 * 再从最新的一批开始往回取，直到和本地的消息接上为止，所以只需要取「上次之后新发的」那部分。
 * 更早的消息仍然是往上滚动时才取，取到后也会存下来。
 */
export interface RoomMember {
  ownerId: number; // 成员的用户 ID（serverOwner）
  name: string;
  avatar: string;  // 完整的头像地址
}

export interface RoomMessageItem {
  key: string;
  raw: CustomMessageV2;         // 接口返回的原始消息（导出时用）
  message: FormatCustomMessage; // 解析后的消息（显示用）
}

export interface RoomData {
  serverId?: number;
  channelId?: number;
  items: Array<RoomMessageItem>; // 从旧到新
  nextTime: number;              // 下一次往前翻用的位置
  hasMore: boolean;              // 还有没有更早的消息
  loading: boolean;
  error?: string;
  opened: boolean;               // 已经加载过第一批
  fromCache?: boolean;           // 这次打开时用了本地缓存
  syncing?: boolean;             // 正在补上比本地新的消息
}

export interface RoomState {
  follows: Array<RoomMember>;
  current?: RoomMember;
  rooms: Record<number, RoomData>;
}

const FOLLOWS_KEY: string = 'ROOM_FOLLOWS';
const LAST_ROOM_KEY: string = 'ROOM_LAST';
const listeners: Set<() => void> = new Set();

function readJson<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');

    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function isMember(value: unknown): value is RoomMember {
  return Boolean(value) && typeof (value as RoomMember).ownerId === 'number' && typeof (value as RoomMember).name === 'string';
}

let state: RoomState = {
  follows: typeof localStorage === 'undefined' ? [] : readJson<Array<unknown>>(FOLLOWS_KEY, []).filter(isMember),
  current: undefined,
  rooms: {}
};

function setState(patch: Partial<RoomState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
}

function emptyRoom(): RoomData {
  return { items: [], nextTime: 0, hasMore: true, loading: false, opened: false };
}

function setRoom(ownerId: number, patch: Partial<RoomData>): void {
  setState({ rooms: { ...state.rooms, [ownerId]: { ...emptyRoom(), ...state.rooms[ownerId], ...patch } } });
}

export function getRoomState(): RoomState {
  return state;
}

export function useRoomState(): RoomState {
  return useSyncExternalStore((listener: () => void): (() => void) => {
    listeners.add(listener);

    return (): void => {
      listeners.delete(listener);
    };
  }, getRoomState);
}

/* ---------- 关注列表 ---------- */
export function isFollowed(ownerId: number): boolean {
  return state.follows.some((member: RoomMember): boolean => member.ownerId === ownerId);
}

export function toggleFollow(member: RoomMember): void {
  const follows: Array<RoomMember> = isFollowed(member.ownerId)
    ? state.follows.filter((item: RoomMember): boolean => item.ownerId !== member.ownerId)
    : [...state.follows, { ownerId: member.ownerId, name: member.name, avatar: member.avatar }];

  try {
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(follows));
  } catch { /* noop */ }

  setState({ follows });
}

/* 上次打开的房间（重新进入页面时恢复） */
export function getLastRoom(): RoomMember | undefined {
  const last: unknown = readJson<unknown>(LAST_ROOM_KEY, undefined);

  return isMember(last) ? last : undefined;
}

/* ---------- 搜索成员 ---------- */
export async function searchMembers(keyword: string): Promise<Array<RoomMember>> {
  const res: ServerSearchResult | undefined = await requestServerSearch(keyword);

  if (!res) throw new Error('请先登录口袋48账号');

  if (!res.success) throw new Error(res.message || '搜索失败');

  return (res.content?.serverApiList ?? []).map((item: ServerApiItem): RoomMember => ({
    ownerId: Number(item.serverOwner),
    name: item.serverDefaultName || item.serverName,
    avatar: source(item.serverDefaultIcon || item.serverIcon)
  }));
}

/* ---------- 消息 ---------- */
function keyOf(raw: CustomMessageV2): string {
  return raw.msgIdClient || String(raw.msgIdServer) || `${ raw.msgTime }`;
}

/* 把接口返回的一批消息（从新到旧）变成显示用的列表（从旧到新），只保留成员本人发的 */
export function toItems(messages: Array<CustomMessageV2>): Array<RoomMessageItem> {
  const items: Array<RoomMessageItem> = [];

  for (const raw of messages) {
    try {
      const message: FormatCustomMessage = FormatData(raw);
      const hidden: boolean = message.type === 'custom' && ['PRESENT_TEXT', 'RED_PACKET_2024'].includes(message.attach.messageType);

      if (message.user?.roleId === 3 && !hidden) items.push({ key: keyOf(raw), raw, message });
    } catch (err) {
      console.error('房间消息解析失败', err, raw);
    }
  }

  return items.reverse();
}

/* 合并两批消息并去重，结果从旧到新 */
export function mergeItems(older: Array<RoomMessageItem>, newer: Array<RoomMessageItem>): Array<RoomMessageItem> {
  const seen: Set<string> = new Set();
  const result: Array<RoomMessageItem> = [];

  for (const item of [...older, ...newer]) {
    if (seen.has(item.key)) continue;

    seen.add(item.key);
    result.push(item);
  }

  return result.sort((a: RoomMessageItem, b: RoomMessageItem): number => a.raw.msgTime - b.raw.msgTime);
}

async function ensureRoom(member: RoomMember): Promise<RoomData> {
  const room: RoomData = state.rooms[member.ownerId] ?? emptyRoom();

  if (room.serverId && room.channelId) return room;

  const res: ServerJumpResult | undefined = await requestServerJump(member.ownerId);

  if (!res) throw new Error('请先登录口袋48账号');

  if (!res.content?.channelId || !res.content?.serverId) throw new Error(res.message || '没有找到这个成员的房间');

  setRoom(member.ownerId, { serverId: res.content.serverId, channelId: res.content.channelId });

  return state.rooms[member.ownerId];
}

function errorText(err: unknown): string {
  const statusCode: number | undefined = (err as { response?: { statusCode?: number } })?.response?.statusCode;

  if (statusCode) return `接口返回 ${ statusCode }`;

  return err instanceof Error ? err.message : String(err);
}

const MAX_CATCH_UP_PAGES: number = 60; // 补新消息时最多往回取多少批（每批 50 条）

/* 把房间现在的消息和翻页位置存到本机 */
function saveRoom(ownerId: number, items: Array<RoomMessageItem>): void {
  const room: RoomData | undefined = state.rooms[ownerId];

  if (!room?.opened) return;

  writeRoomCache({
    ownerId,
    serverId: room.serverId,
    channelId: room.channelId,
    nextTime: room.nextTime,
    hasMore: room.hasMore,
    updatedAt: Date.now()
  }, items.map((item: RoomMessageItem): { key: string; raw: CustomMessageV2 } => ({ key: item.key, raw: item.raw })));
}

async function requestPage(room: RoomData, nextTime: number): Promise<{ messages: Array<CustomMessageV2>; nextTime: number }> {
  const res: HomeMessageResult | undefined = await requestHomeownerMessage(room.channelId!, room.serverId!, nextTime);

  if (!res) throw new Error('请先登录口袋48账号');

  if (!res.success && !res.content) throw new Error(res.message || '获取消息失败');

  return { messages: res.content?.message ?? [], nextTime: res.content?.nextTime ?? 0 };
}

/**
 * 取更早的一批消息（房间第一次打开、本地又没有缓存时，就是最新的一批）
 * @param { RoomMember } member
 */
export async function loadOlder(member: RoomMember): Promise<void> {
  const current: RoomData = state.rooms[member.ownerId] ?? emptyRoom();

  if (current.loading || (current.opened && !current.hasMore)) return;

  if (!getPocket48Token()) {
    setRoom(member.ownerId, { error: '请先登录口袋48账号' });

    return;
  }

  setRoom(member.ownerId, { loading: true, error: undefined });

  try {
    const room: RoomData = await ensureRoom(member);
    const page: { messages: Array<CustomMessageV2>; nextTime: number } = await requestPage(room, room.opened ? room.nextTime : 0);
    const latest: RoomData = state.rooms[member.ownerId];
    const added: Array<RoomMessageItem> = toItems(page.messages);

    setRoom(member.ownerId, {
      items: mergeItems(latest.items, added),
      nextTime: page.nextTime,
      // 没有返回消息，或者位置不再变化，说明已经翻到头了
      hasMore: page.messages.length > 0 && page.nextTime > 0 && page.nextTime !== latest.nextTime,
      loading: false,
      opened: true
    });
    saveRoom(member.ownerId, added);
  } catch (err) {
    console.error(err);
    setRoom(member.ownerId, { loading: false, error: errorText(err) });
  }
}

/**
 * 取最新的消息，并一直往回取到和已有的消息接上为止（中间不留空档）。
 * 用在：打开有本地缓存的房间、点「刷新」、每分钟的自动刷新。
 * @param { RoomMember } member
 */
export async function syncNewest(member: RoomMember): Promise<void> {
  const current: RoomData | undefined = state.rooms[member.ownerId];

  if (!current?.opened || current.syncing || current.loading) return;

  if (!getPocket48Token()) return;

  setRoom(member.ownerId, { syncing: true, error: undefined });

  try {
    const room: RoomData = await ensureRoom(member);
    const newestKnown: number = room.items.length > 0 ? room.items[room.items.length - 1].raw.msgTime : 0;
    const fetched: Array<CustomMessageV2> = [];
    let nextTime: number = 0;
    let connected: boolean = false;

    for (let i: number = 0; i < MAX_CATCH_UP_PAGES; i++) {
      const page: { messages: Array<CustomMessageV2>; nextTime: number } = await requestPage(room, nextTime);

      fetched.push(...page.messages);

      // 这一批里最早的一条已经不比本地最新的晚：接上了
      const oldest: number = page.messages.reduce((min: number, raw: CustomMessageV2): number => Math.min(min, raw.msgTime), Infinity);

      // 本地一条都没有时只取最新的一批
      if (newestKnown === 0 || page.messages.length === 0 || oldest <= newestKnown || page.nextTime <= 0 || page.nextTime === nextTime) {
        connected = true;
        break;
      }

      nextTime = page.nextTime;
    }

    const added: Array<RoomMessageItem> = toItems(fetched);
    const latest: RoomData = state.rooms[member.ownerId];

    if (connected) {
      setRoom(member.ownerId, { items: mergeItems(latest.items, added), syncing: false });
      saveRoom(member.ownerId, added);
    } else {
      // 离上次太久，新消息多到接不上：放弃旧的缓存，只保留刚取到的这些，更早的往上滚动时再取
      await clearRoomCache(member.ownerId);
      setRoom(member.ownerId, { items: added, nextTime, hasMore: true, syncing: false, fromCache: false });
      saveRoom(member.ownerId, added);
    }
  } catch (err) {
    console.error(err);
    // 补新消息失败不影响看本地已有的内容，只在本地一条都没有时才显示错误
    setRoom(member.ownerId, { syncing: false, error: state.rooms[member.ownerId]?.items.length ? undefined : errorText(err) });
  }
}

/* 打开一个成员的房间：先显示本地缓存的消息，再补上新的 */
export async function openRoom(member: RoomMember): Promise<void> {
  setState({ current: member });

  try {
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(member));
  } catch { /* noop */ }

  if (state.rooms[member.ownerId]?.opened || state.rooms[member.ownerId]?.loading) return;

  setRoom(member.ownerId, { loading: true, error: undefined });

  const cache: RoomCacheData = await readRoomCache(member.ownerId);

  if (state.rooms[member.ownerId]?.opened) return; // 读缓存期间已经被别的操作打开了

  const items: Array<RoomMessageItem> = toItems([...cache.messages].reverse());

  if (cache.meta && items.length > 0) {
    setRoom(member.ownerId, {
      serverId: cache.meta.serverId,
      channelId: cache.meta.channelId,
      items,
      nextTime: cache.meta.nextTime,
      hasMore: cache.meta.hasMore,
      loading: false,
      opened: true,
      fromCache: true
    });
    await syncNewest(member);
  } else {
    setRoom(member.ownerId, { loading: false });
    await loadOlder(member);
  }
}

/* 清除一个房间的本地缓存，并重新从网络加载 */
export async function resetRoomCache(member: RoomMember): Promise<void> {
  await clearRoomCache(member.ownerId);
  setState({ rooms: { ...state.rooms, [member.ownerId]: emptyRoom() } });
  await loadOlder(member);
}

/* 测试用 */
export function resetRoomStoreForTest(): void {
  state = { follows: [], current: undefined, rooms: {} };
  listeners.clear();
}
