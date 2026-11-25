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
import { readRoomCache, readRoomCacheBetween, writeRoomCache, clearRoomCache, type RoomCacheData, type RoomStream } from './roomCache';
import { requestAllMessage } from './roomApi';
import { sleep, readJson, writeJson } from '../common/util';
import { noteMessages, getChannel, setChannel } from './unreadStore';
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
 *
 * 未读消息数（./unreadStore）：每次房间的消息有变化，都把消息的时间交给它（reportMessages）。
 *
 * 每个房间有两路消息（RoomStream），各自加载、各自缓存：
 *   - owner：只有成员发的（上面第 3 步的接口），页面默认看这一路
 *   - all：房间里所有人的消息，包括粉丝（./roomApi 的 list/all 接口，翻页方式一样）
 * 每次进入一个房间，两路都会更新：正在看的那一路先取，另一路跟在后面取并存进缓存。所以即使一直「只看成员」，
 * 进过的房间也会把全部消息存下来。全部消息量很大，每个房间本地最多保留最新的 MAX_ALL_CACHED 条。
 * 未读数只按成员这一路算。
 */
export type { RoomStream } from './roomCache';

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
  cacheMore?: boolean;           // 本地缓存里还有更早的消息没读进来（往上滚动时先读本地的）
}

export interface RoomState {
  follows: Array<RoomMember>;
  current?: RoomMember;
  rooms: Record<number, RoomData>;    // 只有成员的消息
  allRooms: Record<number, RoomData>; // 所有人的消息
  mode: RoomStream;                   // 页面现在看的是哪一路。每次启动都从「只看成员」开始
}

const FOLLOWS_KEY: string = 'ROOM_FOLLOWS';
const LAST_ROOM_KEY: string = 'ROOM_LAST';
const CACHE_CHUNK: number = 500;       // 从本地缓存一次读多少条
const MAX_ALL_CACHED: number = 20_000; // 「全部消息」每个房间本地最多保留多少条（最新的）
const MAX_ALL_CACHED_KEY: string = 'ROOM_ALL_CACHE_MAX'; // 想改上面这个上限时，在 localStorage 里写这个值（测试时也用它）
const PAGE_GAP: number = 120;          // 补「全部消息」时每取一批歇一下（毫秒），不要一口气发太多请求

// 补新消息时最多往回取多少批（每批 50 条）。超过说明离上次太久，放弃旧缓存，从最新的重新开始
const MAX_CATCH_UP_PAGES: Record<RoomStream, number> = { owner: 60, all: 100 };
const roomsKey: Record<RoomStream, 'rooms' | 'allRooms'> = { owner: 'rooms', all: 'allRooms' };
const listeners: Set<() => void> = new Set();
const followListeners: Set<(member: RoomMember, followed: boolean) => void> = new Set();

function isMember(value: unknown): value is RoomMember {
  return Boolean(value) && typeof (value as RoomMember).ownerId === 'number' && typeof (value as RoomMember).name === 'string';
}

let state: RoomState = {
  follows: typeof localStorage === 'undefined' ? [] : readJson<Array<unknown>>(FOLLOWS_KEY, []).filter(isMember),
  current: undefined,
  rooms: {},
  allRooms: {},
  mode: 'owner'
};

function setState(patch: Partial<RoomState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
}

function emptyRoom(): RoomData {
  return { items: [], nextTime: 0, hasMore: true, loading: false, opened: false };
}

function getRoom(stream: RoomStream, ownerId: number): RoomData | undefined {
  return state[roomsKey[stream]][ownerId];
}

function setRoom(stream: RoomStream, ownerId: number, patch: Partial<RoomData>): void {
  const key: 'rooms' | 'allRooms' = roomsKey[stream];

  setState({ [key]: { ...state[key], [ownerId]: { ...emptyRoom(), ...state[key][ownerId], ...patch } } });
}

function maxAllCached(): number {
  const saved: number = Number(readJson<unknown>(MAX_ALL_CACHED_KEY, undefined));

  return Number.isInteger(saved) && saved >= 100 ? saved : MAX_ALL_CACHED;
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

export function onFollowChange(listener: (member: RoomMember, followed: boolean) => void): () => void {
  followListeners.add(listener);

  return (): void => {
    followListeners.delete(listener);
  };
}

export function toggleFollow(member: RoomMember): void {
  const wasFollowed: boolean = isFollowed(member.ownerId);
  const follows: Array<RoomMember> = wasFollowed
    ? state.follows.filter((item: RoomMember): boolean => item.ownerId !== member.ownerId)
    : [...state.follows, { ownerId: member.ownerId, name: member.name, avatar: member.avatar }];

  try {
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(follows));
  } catch { /* noop */ }

  setState({ follows });

  for (const listener of followListeners) listener(member, !wasFollowed);
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
export function keyOf(raw: CustomMessageV2): string {
  return raw.msgIdClient || String(raw.msgIdServer) || `${ raw.msgTime }`;
}

/* 把接口返回的一批消息（从新到旧）变成显示用的列表（从旧到新）。owner 只保留成员发的，all 全部保留 */
export function toItems(messages: Array<CustomMessageV2>, stream: RoomStream = 'owner'): Array<RoomMessageItem> {
  const items: Array<RoomMessageItem> = [];

  for (const raw of messages) {
    try {
      const message: FormatCustomMessage = FormatData(raw);
      const hidden: boolean = message.type === 'custom' && ['PRESENT_TEXT', 'RED_PACKET_2024'].includes(message.attach.messageType);

      if ((stream === 'all' || message.user?.roleId === 3) && !hidden) items.push({ key: keyOf(raw), raw, message });
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

interface Channel {
  serverId: number;
  channelId: number;
}

/* 成员房间的地址（serverId / channelId）。两路消息共用，查到一次就记下来 */
async function ensureChannel(member: RoomMember): Promise<Channel> {
  for (const stream of ['owner', 'all'] as const) {
    const room: RoomData | undefined = getRoom(stream, member.ownerId);

    if (room?.serverId && room.channelId) return { serverId: room.serverId, channelId: room.channelId };
  }

  const saved: Channel | undefined = getChannel(member.ownerId);

  if (saved) return saved;

  const res: ServerJumpResult | undefined = await requestServerJump(member.ownerId);

  if (!res) throw new Error('请先登录口袋48账号');

  if (!res.content?.channelId || !res.content?.serverId) throw new Error(res.message || '没有找到这个成员的房间');

  setChannel(member.ownerId, res.content.serverId, res.content.channelId);

  return { serverId: res.content.serverId, channelId: res.content.channelId };
}

/* 从成员名单里搜出来的成员没有头像：她的消息加载出来后，用消息里的头像补上（正在看的房间和关注列表） */
function adoptAvatar(ownerId: number): void {
  const missing: boolean = (state.current?.ownerId === ownerId && !state.current.avatar)
    || state.follows.some((member: RoomMember): boolean => member.ownerId === ownerId && !member.avatar);

  if (!missing) return;

  const avatar: string | undefined = state.rooms[ownerId]?.items
    .find((item: RoomMessageItem): boolean => Number(item.message.user?.userId) === ownerId && Boolean(item.message.user?.avatar))
    ?.message.user?.avatar;

  if (!avatar) return;

  const follows: Array<RoomMember> = state.follows
    .map((member: RoomMember): RoomMember => (member.ownerId === ownerId && !member.avatar ? { ...member, avatar } : member));

  writeJson(FOLLOWS_KEY, follows);
  setState({
    follows,
    current: state.current?.ownerId === ownerId && !state.current.avatar ? { ...state.current, avatar } : state.current
  });
}

/* 房间的消息有变化：交给未读统计（只按成员这一路算） */
function reportMessages(ownerId: number): void {
  noteMessages(ownerId, (state.rooms[ownerId]?.items ?? []).map((item: RoomMessageItem): number => item.raw.msgTime));
  adoptAvatar(ownerId);
}

function errorText(err: unknown): string {
  const statusCode: number | undefined = (err as { response?: { statusCode?: number } })?.response?.statusCode;

  if (statusCode) return `接口返回 ${ statusCode }`;

  return err instanceof Error ? err.message : String(err);
}

/* 把房间现在的翻页位置和新取到的消息存到本机 */
function saveRoom(stream: RoomStream, ownerId: number, items: Array<RoomMessageItem>): void {
  const room: RoomData | undefined = getRoom(stream, ownerId);

  if (!room?.opened) return;

  writeRoomCache(stream, {
    ownerId,
    serverId: room.serverId,
    channelId: room.channelId,
    nextTime: room.nextTime,
    hasMore: room.hasMore,
    updatedAt: Date.now()
  }, items.map((item: RoomMessageItem): { key: string; raw: CustomMessageV2 } => ({ key: item.key, raw: item.raw })),
  stream === 'all' ? maxAllCached() : undefined);
}

async function requestPage(
  stream: RoomStream,
  channel: Channel,
  nextTime: number
): Promise<{ messages: Array<CustomMessageV2>; nextTime: number }> {
  const res: HomeMessageResult | undefined = stream === 'all'
    ? await requestAllMessage(channel.channelId, channel.serverId, nextTime)
    : await requestHomeownerMessage(channel.channelId, channel.serverId, nextTime);

  if (!res) throw new Error('请先登录口袋48账号');

  if (!res.success && !res.content) throw new Error(res.message || '获取消息失败');

  return { messages: res.content?.message ?? [], nextTime: res.content?.nextTime ?? 0 };
}

/**
 * 取更早的一批消息：本地缓存里还有更早的就先读本地的，读完了再去网络取。
 * 房间第一次打开、本地又没有缓存时，取到的就是最新的一批。
 * @param { RoomMember } member
 * @param { RoomStream } [stream = 'owner']
 */
export async function loadOlder(member: RoomMember, stream: RoomStream = 'owner'): Promise<void> {
  const current: RoomData = getRoom(stream, member.ownerId) ?? emptyRoom();

  if (current.loading || (current.opened && !current.hasMore && !current.cacheMore)) return;

  if (current.opened && current.cacheMore) {
    setRoom(stream, member.ownerId, { loading: true, error: undefined });

    const cache: RoomCacheData = await readRoomCache(stream, member.ownerId, { before: current.items[0]?.raw.msgTime, limit: CACHE_CHUNK });
    const latest: RoomData = getRoom(stream, member.ownerId)!;

    setRoom(stream, member.ownerId, {
      items: mergeItems(toItems([...cache.messages].reverse(), stream), latest.items),
      cacheMore: cache.more,
      loading: false
    });

    return;
  }

  if (!getPocket48Token()) {
    setRoom(stream, member.ownerId, { error: '请先登录口袋48账号' });

    return;
  }

  setRoom(stream, member.ownerId, { loading: true, error: undefined });

  try {
    const channel: Channel = await ensureChannel(member);
    const room: RoomData = getRoom(stream, member.ownerId)!;
    const page: { messages: Array<CustomMessageV2>; nextTime: number } = await requestPage(stream, channel, room.opened ? room.nextTime : 0);
    const latest: RoomData = getRoom(stream, member.ownerId)!;
    const added: Array<RoomMessageItem> = toItems(page.messages, stream);

    setRoom(stream, member.ownerId, {
      ...channel,
      items: mergeItems(latest.items, added),
      nextTime: page.nextTime,
      // 没有返回消息，或者位置不再变化，说明已经翻到头了
      hasMore: page.messages.length > 0 && page.nextTime > 0 && page.nextTime !== latest.nextTime,
      loading: false,
      opened: true
    });
    saveRoom(stream, member.ownerId, added);
    stream === 'owner' && reportMessages(member.ownerId);
  } catch (err) {
    console.error(err);
    setRoom(stream, member.ownerId, { loading: false, error: errorText(err) });
  }
}

/**
 * 把本地缓存里从 time 到「已经加载的最早一条」之间的消息都读进来（跳到搜索结果、跳到某一天时用：
 * 页面上的消息必须从那里一直连到最新，中间不能有空档）。time 比已加载的还新时什么都不做。
 * @return { boolean } 读完后 time 那里的消息是不是已经在列表里了
 */
export async function loadBackTo(member: RoomMember, stream: RoomStream, time: number): Promise<boolean> {
  const current: RoomData | undefined = getRoom(stream, member.ownerId);

  if (!current?.opened || current.loading) return false;

  const oldest: number = current.items[0]?.raw.msgTime ?? Infinity;

  if (time >= oldest) return true;

  setRoom(stream, member.ownerId, { loading: true, error: undefined });

  const messages: Array<CustomMessageV2> = await readRoomCacheBetween(stream, member.ownerId, time - 300_000, oldest, Infinity);
  const older: RoomCacheData = await readRoomCache(stream, member.ownerId, { before: (messages[0]?.msgTime ?? time) - 1, limit: 1 });
  const latest: RoomData = getRoom(stream, member.ownerId)!;

  setRoom(stream, member.ownerId, {
    items: mergeItems(toItems([...messages].reverse(), stream), latest.items),
    cacheMore: older.messages.length > 0,
    loading: false
  });

  return messages.length > 0;
}

/**
 * 取最新的消息，并一直往回取到和已有的消息接上为止（中间不留空档）。
 * 用在：打开有本地缓存的房间、再次进入房间、点「刷新」、每分钟的自动刷新。
 * @param { RoomMember } member
 * @param { RoomStream } [stream = 'owner']
 */
export async function syncNewest(member: RoomMember, stream: RoomStream = 'owner'): Promise<void> {
  const current: RoomData | undefined = getRoom(stream, member.ownerId);

  if (!current?.opened || current.syncing || current.loading) return;

  if (!getPocket48Token()) return;

  setRoom(stream, member.ownerId, { syncing: true, error: undefined });

  try {
    const channel: Channel = await ensureChannel(member);
    const room: RoomData = getRoom(stream, member.ownerId)!;
    const newestKnown: number = room.items.length > 0 ? room.items[room.items.length - 1].raw.msgTime : 0;
    const fetched: Array<CustomMessageV2> = [];
    let nextTime: number = 0;
    let connected: boolean = false;

    for (let i: number = 0; i < MAX_CATCH_UP_PAGES[stream]; i++) {
      if (i > 0 && stream === 'all') await sleep(PAGE_GAP);

      const page: { messages: Array<CustomMessageV2>; nextTime: number } = await requestPage(stream, channel, nextTime);

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

    const added: Array<RoomMessageItem> = toItems(fetched, stream);
    const latest: RoomData = getRoom(stream, member.ownerId)!;

    if (connected) {
      setRoom(stream, member.ownerId, { items: mergeItems(latest.items, added), syncing: false });
      saveRoom(stream, member.ownerId, added);
    } else {
      // 离上次太久，新消息多到接不上：放弃旧的缓存，只保留刚取到的这些，更早的往上滚动时再取
      await clearRoomCache(stream, member.ownerId);
      setRoom(stream, member.ownerId, { items: added, nextTime, hasMore: true, cacheMore: false, syncing: false, fromCache: false });
      saveRoom(stream, member.ownerId, added);
    }

    stream === 'owner' && reportMessages(member.ownerId);
  } catch (err) {
    console.error(err);
    // 补新消息失败不影响看本地已有的内容，只在本地一条都没有时才显示错误
    setRoom(stream, member.ownerId, { syncing: false, error: getRoom(stream, member.ownerId)?.items.length ? undefined : errorText(err) });
  }
}

/* 打开房间的一路消息：先显示本地缓存里最新的一批，再补上新的；这次运行里已经打开过的，只补新的 */
async function openStream(member: RoomMember, stream: RoomStream): Promise<void> {
  const existing: RoomData | undefined = getRoom(stream, member.ownerId);

  if (existing?.opened) return syncNewest(member, stream);

  if (existing?.loading) return;

  setRoom(stream, member.ownerId, { loading: true, error: undefined });

  const cache: RoomCacheData = await readRoomCache(stream, member.ownerId, { limit: CACHE_CHUNK });

  if (getRoom(stream, member.ownerId)?.opened) return; // 读缓存期间已经被别的操作打开了

  const items: Array<RoomMessageItem> = toItems([...cache.messages].reverse(), stream);

  if (cache.meta && items.length > 0) {
    setRoom(stream, member.ownerId, {
      serverId: cache.meta.serverId,
      channelId: cache.meta.channelId,
      items,
      nextTime: cache.meta.nextTime,
      hasMore: cache.meta.hasMore,
      cacheMore: cache.more,
      loading: false,
      opened: true,
      fromCache: true
    });
    stream === 'owner' && reportMessages(member.ownerId);
    await syncNewest(member, stream);
  } else {
    setRoom(stream, member.ownerId, { loading: false });
    await loadOlder(member, stream);
  }
}

/* 两路都更新：正在看的那一路先来，另一路跟在后面（把它也存进缓存） */
async function openBothStreams(member: RoomMember): Promise<void> {
  const first: RoomStream = state.mode;

  await openStream(member, first);
  await openStream(member, first === 'owner' ? 'all' : 'owner');
}

/* 进入一个成员的房间 */
export async function openRoom(member: RoomMember): Promise<void> {
  setState({ current: member });

  try {
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(member));
  } catch { /* noop */ }

  await openBothStreams(member);
}

/* 切换「只看成员 / 全部消息」 */
export function setMode(mode: RoomStream): void {
  if (state.mode === mode) return;

  setState({ mode });
  state.current && openStream(state.current, mode);
}

/* 清除一个房间的本地缓存（两路都清），并重新从网络加载 */
export async function resetRoomCache(member: RoomMember): Promise<void> {
  await Promise.all([clearRoomCache('owner', member.ownerId), clearRoomCache('all', member.ownerId)]);
  setState({
    rooms: { ...state.rooms, [member.ownerId]: emptyRoom() },
    allRooms: { ...state.allRooms, [member.ownerId]: emptyRoom() }
  });
  await openBothStreams(member);
}

/* 读出本地缓存里这个房间一路消息的全部内容（导出用），和已经加载的合并，从新到旧 */
export async function readAllCached(member: RoomMember, stream: RoomStream): Promise<Array<CustomMessageV2>> {
  const cache: RoomCacheData = await readRoomCache(stream, member.ownerId);
  const merged: Array<RoomMessageItem> = mergeItems(
    toItems([...cache.messages].reverse(), stream),
    getRoom(stream, member.ownerId)?.items ?? []);

  return merged.map((item: RoomMessageItem): CustomMessageV2 => item.raw).reverse();
}

/* 测试用 */
export function resetRoomStoreForTest(): void {
  state = { follows: [], current: undefined, rooms: {}, allRooms: {}, mode: 'owner' };
  listeners.clear();
  followListeners.clear();
}
