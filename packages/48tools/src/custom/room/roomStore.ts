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
 * 关注列表存在本机（localStorage），消息按房间缓存在内存里，往上滚动时自动取更早的一批。
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

/**
 * 取一批消息
 * @param { RoomMember } member
 * @param { 'older' | 'newest' } direction - older：更早的一批；newest：最新的一批（刷新）
 */
export async function loadMessages(member: RoomMember, direction: 'older' | 'newest'): Promise<void> {
  const current: RoomData = state.rooms[member.ownerId] ?? emptyRoom();

  if (current.loading || (direction === 'older' && current.opened && !current.hasMore)) return;

  if (!getPocket48Token()) {
    setRoom(member.ownerId, { error: '请先登录口袋48账号' });

    return;
  }

  setRoom(member.ownerId, { loading: true, error: undefined });

  try {
    const room: RoomData = await ensureRoom(member);
    const fromStart: boolean = direction === 'newest' || !room.opened;
    const res: HomeMessageResult | undefined = await requestHomeownerMessage(room.channelId!, room.serverId!, fromStart ? 0 : room.nextTime);

    if (!res) throw new Error('请先登录口袋48账号');

    if (!res.success && !res.content) throw new Error(res.message || '获取消息失败');

    const messages: Array<CustomMessageV2> = res.content?.message ?? [];
    const latest: RoomData = state.rooms[member.ownerId];
    const items: Array<RoomMessageItem> = mergeItems(latest.items, toItems(messages));
    const nextTime: number = res.content?.nextTime ?? 0;

    if (direction === 'newest' && latest.opened) {
      // 刷新：只把新的消息并进来，往前翻的位置不变
      setRoom(member.ownerId, { items, loading: false });
    } else {
      setRoom(member.ownerId, {
        items,
        nextTime,
        // 没有返回消息，或者位置不再变化，说明已经翻到头了
        hasMore: messages.length > 0 && nextTime > 0 && nextTime !== latest.nextTime,
        loading: false,
        opened: true
      });
    }
  } catch (err) {
    console.error(err);
    setRoom(member.ownerId, { loading: false, error: errorText(err) });
  }
}

/* 打开一个成员的房间 */
export function openRoom(member: RoomMember): void {
  setState({ current: member });

  try {
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(member));
  } catch { /* noop */ }

  if (!state.rooms[member.ownerId]?.opened) loadMessages(member, 'older');
}

/* 测试用 */
export function resetRoomStoreForTest(): void {
  state = { follows: [], current: undefined, rooms: {} };
  listeners.clear();
}
