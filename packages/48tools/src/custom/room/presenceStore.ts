import { useSyncExternalStore } from 'react';
import {
  readPresenceCache,
  writePresenceEvent,
  writePresenceEvents,
  clearPresenceCache,
  type PresenceEvent,
  type PresenceKind
} from './presenceCache';
import { readJson, writeJson } from '../common/util';
import { roomClock } from './roomTime';
import type { RoomMessageItem } from './roomStore';
import type { ListPendingMember, PresenceEventsResponse, PresenceResponse } from './presenceApi';

export type { PresenceEvent, PresenceKind } from './presenceCache';

/**
 * 成员在线状态与上下线时间线记录（供成员栏、首页关注列表、聊天记录使用）。
 *
 * 三态展示规则：
 *   - online：服务端明确在线且未过期（头像右下角显示主题色圆点）
 *   - offline：服务端明确离线且未过期（头像右下角显示灰色圆点）
 *   - unknown：stale=true、link.connected=false、since=null 或服务不可用（灰色圆点 + 问号，不误标为离线，不写假下线）
 *
 * 隔离约束：
 *   - 与未读统计（./unreadStore）完全隔离，上下线记录不会触发未读数字、「以下是新消息」分隔线或「有新消息」提示
 *   - 直接用服务端返回的 ownerId 映射回本地成员，客户端不需要维护 accid 映射
 */
export type PresenceStatus = 'online' | 'offline' | 'unknown';

export interface MemberPresence {
  status: PresenceStatus;
  online: boolean;
  stale: boolean;
  since?: number;
  updatedAt: number;
  serverTime?: number;
  changedAt?: number;
}

export interface PresenceServiceState {
  configured: boolean;
  connected: boolean;
  lastPollAt?: number;
  error?: string;
}

export interface PresenceState {
  service: PresenceServiceState;
  byOwner: Record<number, MemberPresence>;
  events: Record<number, Array<PresenceEvent>>;
  loaded: Record<number, boolean>;
  unresolved: Record<number, string>; // POST /list 返回的 pending 成员（暂未解析出 accid，服务端会自动重试）
}

export type ChatTimelineItem =
  | { kind: 'message'; key: string; time: number; item: RoomMessageItem }
  | { kind: 'presence'; key: string; time: number; event: PresenceEvent };

interface ConfirmedRecord {
  status: 'online' | 'offline';
  since?: number;
}

const LAST_CONFIRMED_KEY: string = 'ROOM_PRESENCE_LAST';
const EVENTS_CURSOR_KEY: string = 'ROOM_PRESENCE_EVENTS_CURSOR';
const DEDUPE_WINDOW_MS: number = 5_000;
const listeners: Set<() => void> = new Set();
const loadingOwners: Set<number> = new Set();

function loadLastConfirmed(): Record<number, ConfirmedRecord> {
  if (typeof localStorage === 'undefined') return {};

  const saved: unknown = readJson<unknown>(LAST_CONFIRMED_KEY, null);

  if (!saved || typeof saved !== 'object') return {};

  const out: Record<number, ConfirmedRecord> = {};

  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    const id: number = Number(k);

    if (!Number.isFinite(id) || !v || typeof v !== 'object') continue;

    const rec: Partial<ConfirmedRecord> = v as Partial<ConfirmedRecord>;

    if (rec.status === 'online' || rec.status === 'offline') {
      out[id] = { status: rec.status, since: typeof rec.since === 'number' ? rec.since : undefined };
    }
  }

  return out;
}

function saveLastConfirmed(next: Record<number, ConfirmedRecord>): void {
  if (typeof localStorage === 'undefined') return;

  writeJson(LAST_CONFIRMED_KEY, next);
}

function loadEventsCursors(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};

  const saved: unknown = readJson<unknown>(EVENTS_CURSOR_KEY, null);

  if (typeof saved === 'number' && Number.isFinite(saved) && saved > 0) return { default: saved };

  if (!saved || typeof saved !== 'object') return {};

  const out: Record<string, number> = {};

  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }

  return out;
}

function saveEventsCursors(cursors: Record<string, number>): void {
  if (typeof localStorage === 'undefined') return;

  writeJson(EVENTS_CURSOR_KEY, cursors);
}

let lastConfirmed: Record<number, ConfirmedRecord> = loadLastConfirmed();
let eventsCursors: Record<string, number> = loadEventsCursors();
let state: PresenceState = {
  service: { configured: false, connected: false },
  byOwner: {},
  events: {},
  loaded: {},
  unresolved: {}
};

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<PresenceState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getPresenceEventsCursor(userId: string = 'default'): number {
  return eventsCursors[userId] ?? 0;
}

export function presenceEventKey(event: PresenceEvent): string {
  return `presence:${ event.ownerId }:${ event.time }:${ event.kind }`;
}

/* 格式化持续时长（根据服务端 serverTime - since 计算，不受本机时钟偏差影响） */
export function formatPresenceDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';

  const minutes: number = Math.floor(ms / 60_000);

  if (minutes < 1) return '不到 1 分钟';

  if (minutes < 60) return `${ minutes } 分钟`;

  const hours: number = Math.floor(minutes / 60);
  const rem: number = minutes % 60;

  return rem > 0 ? `${ hours } 小时 ${ rem } 分钟` : `${ hours } 小时`;
}

/* 头像圆点的悬停提示文字（严格区分在线 / 离线 / 未知） */
export function presenceLabel(
  presence: MemberPresence | undefined,
  zone?: string,
  service?: PresenceServiceState
): string {
  if (!presence || presence.status === 'unknown') {
    if (service?.configured && !service.connected) return '状态未知 · 服务未连接';

    return '状态未知';
  }

  const timeRef: number | undefined = presence.since ?? presence.changedAt;
  const clockTime: string = timeRef !== undefined ? roomClock(timeRef, zone).time : '';

  if (presence.status === 'online') {
    const duration: string = presence.since !== undefined && presence.serverTime !== undefined
      ? formatPresenceDuration(Math.max(0, presence.serverTime - presence.since))
      : '';

    if (duration && clockTime) return `在线 · 已在线 ${ duration }（${ clockTime } 上线）`;

    if (clockTime) return `在线 · ${ clockTime } 上线`;

    return '在线';
  }

  return clockTime ? `离线 · ${ clockTime } 下线` : '离线';
}

/* 状态说明（供聊天页标题栏悬停显示「为什么是未知 / 暂未解析」） */
export function presenceReason(
  presence: MemberPresence | undefined,
  service?: PresenceServiceState,
  unresolved?: boolean | string
): string | undefined {
  if (typeof unresolved === 'string' && unresolved) return unresolved;

  if (unresolved) return '服务端暂未解析到该成员（可能无口袋房间），将自动重试';

  if (presence && presence.status !== 'unknown') return undefined;

  if (service && !service.configured) return '尚未配置在线状态服务';

  if (service && !service.connected) return service.error ? `在线状态服务未连接：${ service.error }` : '在线状态服务未连接，正在自动重连';

  return '正在等待服务端轮询更新';
}

export function setPresencePending(pending: Array<ListPendingMember>): void {
  const next: Record<number, string> = {};

  for (const item of pending) {
    if (Number.isFinite(item.ownerId) && item.ownerId > 0) {
      next[item.ownerId] = item.reason || '服务端暂未解析到该成员，将自动重试';
    }
  }

  setState({ unresolved: next });
}

/* 合并两组上下线记录并去重，结果按时间从旧到新 */
function mergeEvents(existing: Array<PresenceEvent>, incoming: Array<PresenceEvent>): Array<PresenceEvent> {
  const byTime: Map<number, PresenceEvent> = new Map();

  for (const event of existing) byTime.set(event.time, event);

  for (const event of incoming) byTime.set(event.time, event);

  return [...byTime.values()].sort((a: PresenceEvent, b: PresenceEvent): number => a.time - b.time);
}

export function getPresenceState(): PresenceState {
  return state;
}

export function usePresenceState(): PresenceState {
  return useSyncExternalStore((listener: () => void): (() => void) => {
    listeners.add(listener);

    return (): void => {
      listeners.delete(listener);
    };
  }, getPresenceState);
}

/* 读取某个成员缓存在本机的上下线记录（进入房间时调用，多次调用只会读一次） */
export async function loadPresenceHistory(ownerId: number): Promise<void> {
  if (state.loaded[ownerId] || loadingOwners.has(ownerId)) return;

  loadingOwners.add(ownerId);

  try {
    const cached: Array<PresenceEvent> = await readPresenceCache(ownerId);
    const merged: Array<PresenceEvent> = mergeEvents(cached, state.events[ownerId] ?? []);
    const lastEvent: PresenceEvent | undefined = merged[merged.length - 1];
    const current: MemberPresence | undefined = state.byOwner[ownerId];
    const nextByOwner: Record<number, MemberPresence> = current && current.changedAt === undefined && lastEvent
      ? { ...state.byOwner, [ownerId]: { ...current, changedAt: lastEvent.time } }
      : state.byOwner;

    setState({
      byOwner: nextByOwner,
      events: { ...state.events, [ownerId]: merged },
      loaded: { ...state.loaded, [ownerId]: true }
    });
  } finally {
    loadingOwners.delete(ownerId);
  }
}

/* 写入一条上下线事件到内存和本地缓存（不改变未读状态） */
export function appendPresenceEvent(event: PresenceEvent): void {
  const prevList: Array<PresenceEvent> = state.events[event.ownerId] ?? [];
  const last: PresenceEvent | undefined = prevList[prevList.length - 1];

  if (last && last.kind === event.kind && Math.abs(event.time - last.time) <= DEDUPE_WINDOW_MS) return;

  const nextList: Array<PresenceEvent> = mergeEvents(prevList, [event]);

  setState({ events: { ...state.events, [event.ownerId]: nextList } });
  void writePresenceEvent(event);
}

export function setPresenceServiceConfigured(configured: boolean): void {
  if (state.service.configured === configured) return;

  setState({ service: { ...state.service, configured } });
}

/* 服务断连或请求失败：把已有成员统一标为「未知」，绝不写入虚假下线记录 */
export function markPresenceServiceDown(error: string): void {
  const nextByOwner: Record<number, MemberPresence> = {};

  for (const [k, cur] of Object.entries(state.byOwner)) {
    nextByOwner[Number(k)] = { ...cur, status: 'unknown', online: false, stale: true };
  }

  setState({
    service: { ...state.service, configured: true, connected: false, error },
    byOwner: nextByOwner
  });
}

export interface PresenceFallbackLookup {
  byAccid?: Map<string, number>;
  byName?: Map<string, number>;
}

function resolveOwnerId(
  rawOwnerId: number | null | undefined,
  accid: string | undefined,
  name: string | undefined,
  fallback?: PresenceFallbackLookup
): number | undefined {
  const direct: number = Number(rawOwnerId);

  if (Number.isFinite(direct) && direct > 0) return direct;

  if (accid && fallback?.byAccid?.has(accid)) return fallback.byAccid.get(accid);

  if (name && fallback?.byName?.has(name)) return fallback.byName.get(name);

  return undefined;
}

/**
 * 消费服务端 GET /presence?userId=... 的完整响应（直接按 ownerId 映射；旧数据缺 ownerId 时按内存表兜底）：
 *   - link.connected === false 或 member.stale === true 或 member.since === null → status='unknown'（灰+问号，不写假下线）
 *   - 否则 status='online'|'offline'，仅当与上次确认状态发生切换时写入本地时间线缓存
 */
export function applyServerPresence(response: PresenceResponse, fallback?: PresenceFallbackLookup): void {
  const linkConnected: boolean = Boolean(response.link?.connected);
  const serverTime: number = Number(response.serverTime) || Date.now();
  const nextByOwner: Record<number, MemberPresence> = {};
  let nextEvents: Record<number, Array<PresenceEvent>> = state.events;
  let confirmedChanged: boolean = false;
  const nextConfirmed: Record<number, ConfirmedRecord> = { ...lastConfirmed };

  for (const item of response.members ?? []) {
    const ownerId: number | undefined = resolveOwnerId(item.ownerId, item.accid, item.name, fallback);

    if (ownerId === undefined) continue;

    const prev: MemberPresence | undefined = state.byOwner[ownerId];
    const isUnknown: boolean = !linkConnected || Boolean(item.stale) || item.since === null;

    if (isUnknown) {
      nextByOwner[ownerId] = {
        status: 'unknown',
        online: false,
        stale: true,
        since: prev?.since,
        updatedAt: serverTime,
        serverTime,
        changedAt: prev?.changedAt
      };
      continue;
    }

    const nextStatus: 'online' | 'offline' = item.online ? 'online' : 'offline';
    const since: number = Number(item.since);
    const prevConfirmed: ConfirmedRecord | undefined = nextConfirmed[ownerId];

    // 只有之前已有确认态、且状态确实发生了切换时才写入时间线记录
    if (prevConfirmed && prevConfirmed.status !== nextStatus) {
      const eventTime: number = Number.isFinite(since) && since > 0 ? since : serverTime;
      const prevList: Array<PresenceEvent> = nextEvents[ownerId] ?? [];
      const last: PresenceEvent | undefined = prevList[prevList.length - 1];
      const duplicate: boolean = Boolean(last && last.kind === nextStatus && Math.abs(eventTime - last.time) <= DEDUPE_WINDOW_MS);

      if (!duplicate) {
        const event: PresenceEvent = { ownerId, time: eventTime, kind: nextStatus };

        nextEvents = { ...nextEvents, [ownerId]: mergeEvents(prevList, [event]) };
        void writePresenceEvent(event);
      }
    }

    if (!prevConfirmed || prevConfirmed.status !== nextStatus || prevConfirmed.since !== since) {
      nextConfirmed[ownerId] = { status: nextStatus, since };
      confirmedChanged = true;
    }

    nextByOwner[ownerId] = {
      status: nextStatus,
      online: nextStatus === 'online',
      stale: false,
      since,
      updatedAt: serverTime,
      serverTime,
      changedAt: since
    };
  }

  // 云信链路断开时，已跟踪但本次响应没带回来的旧条目也保留为「未知」
  if (!linkConnected) {
    for (const [k, cur] of Object.entries(state.byOwner)) {
      const id: number = Number(k);

      if (!nextByOwner[id]) {
        nextByOwner[id] = { ...cur, status: 'unknown', online: false, stale: true, serverTime };
      }
    }
  }

  if (confirmedChanged) {
    lastConfirmed = nextConfirmed;
    saveLastConfirmed(nextConfirmed);
  }

  setState({
    service: {
      configured: true,
      connected: linkConnected,
      lastPollAt: response.link?.lastPollAt ?? serverTime,
      error: undefined
    },
    byOwner: nextByOwner,
    events: nextEvents
  });
}

/**
 * 消费服务端 GET /events?since=...&userId=... 的历史上下线事件（直接按 ownerId 映射，按 t 升序），
 * 用于补齐程序关闭/电脑休眠/断网期间的空档；游标保存为「上次最大 t」，完全不影响未读数。
 */
export function applyServerEvents(
  response: PresenceEventsResponse,
  userId: string = 'default',
  fallback?: PresenceFallbackLookup
): number {
  const incomingByOwner: Map<number, Array<PresenceEvent>> = new Map();
  const prevCursor: number = eventsCursors[userId] ?? 0;
  let maxEventTime: number = 0;

  for (const raw of response.events ?? []) {
    const time: number = Number(raw.t);

    if (!Number.isFinite(time) || time <= 0) continue;

    if (time > maxEventTime) maxEventTime = time;

    const ownerId: number | undefined = resolveOwnerId(raw.ownerId, raw.accid, raw.name, fallback);

    if (ownerId === undefined) continue;

    const list: Array<PresenceEvent> = incomingByOwner.get(ownerId) ?? [];

    list.push({ ownerId, time, kind: raw.online ? 'online' : 'offline' });
    incomingByOwner.set(ownerId, list);
  }

  let nextEvents: Record<number, Array<PresenceEvent>> = state.events;
  const toPersist: Array<PresenceEvent> = [];

  for (const [ownerId, batch] of incomingByOwner) {
    const existing: Array<PresenceEvent> = nextEvents[ownerId] ?? [];
    const accepted: Array<PresenceEvent> = [];
    let merged: Array<PresenceEvent> = existing;

    for (const ev of batch) {
      const duplicate: boolean = merged.some(
        (cur: PresenceEvent): boolean => cur.time === ev.time
          || (cur.kind === ev.kind && Math.abs(cur.time - ev.time) <= DEDUPE_WINDOW_MS)
      );

      if (duplicate) continue;

      accepted.push(ev);
      merged = mergeEvents(merged, [ev]);
    }

    if (accepted.length > 0) {
      if (nextEvents === state.events) nextEvents = { ...state.events };

      nextEvents[ownerId] = merged;
      toPersist.push(...accepted);
    }
  }

  // 有事件时游标推进到最大 t；首次拉取且无历史事件时推进到 serverTime，避免以后每次都查 since=0
  const nextCursor: number = maxEventTime > 0
    ? Math.max(prevCursor, maxEventTime)
    : (prevCursor === 0 && Number.isFinite(response.serverTime) && response.serverTime > 0 ? response.serverTime : prevCursor);

  if (nextCursor > prevCursor) {
    eventsCursors = { ...eventsCursors, [userId]: nextCursor };
    saveEventsCursors(eventsCursors);
  }

  if (toPersist.length > 0) {
    setState({ events: nextEvents });
    void writePresenceEvents(toPersist);
  }

  return toPersist.length;
}

/**
 * 手动更新单个成员的在线状态（单测或本地调试用）。
 */
export function updateMemberPresence(
  ownerId: number,
  online: boolean,
  time: number = Date.now(),
  options: { recordEvent?: boolean } = {}
): void {
  const prev: MemberPresence | undefined = state.byOwner[ownerId];
  const prevConfirmed: ConfirmedRecord | undefined = lastConfirmed[ownerId];
  const nextStatus: 'online' | 'offline' = online ? 'online' : 'offline';
  const transitioned: boolean = prevConfirmed !== undefined && prevConfirmed.status !== nextStatus;
  const shouldRecord: boolean = options.recordEvent ?? transitioned;

  let nextEvents: Record<number, Array<PresenceEvent>> = state.events;
  let changedAt: number | undefined = prev?.changedAt;

  if (shouldRecord) {
    const prevList: Array<PresenceEvent> = state.events[ownerId] ?? [];
    const last: PresenceEvent | undefined = prevList[prevList.length - 1];
    const duplicate: boolean = Boolean(last && last.kind === nextStatus && Math.abs(time - last.time) <= DEDUPE_WINDOW_MS);

    if (!duplicate) {
      const event: PresenceEvent = { ownerId, time, kind: nextStatus };

      nextEvents = { ...state.events, [ownerId]: mergeEvents(prevList, [event]) };
      changedAt = time;
      void writePresenceEvent(event);
    }
  }

  lastConfirmed = { ...lastConfirmed, [ownerId]: { status: nextStatus, since: changedAt } };
  setState({
    byOwner: {
      ...state.byOwner,
      [ownerId]: { status: nextStatus, online, stale: false, since: changedAt, updatedAt: time, changedAt }
    },
    events: nextEvents
  });
}

export async function clearMemberPresence(ownerId: number): Promise<void> {
  const nextByOwner: Record<number, MemberPresence> = { ...state.byOwner };
  const nextEvents: Record<number, Array<PresenceEvent>> = { ...state.events };
  const nextLoaded: Record<number, boolean> = { ...state.loaded };
  const nextConfirmed: Record<number, ConfirmedRecord> = { ...lastConfirmed };

  delete nextByOwner[ownerId];
  delete nextEvents[ownerId];
  delete nextLoaded[ownerId];
  delete nextConfirmed[ownerId];
  lastConfirmed = nextConfirmed;
  saveLastConfirmed(nextConfirmed);
  setState({ byOwner: nextByOwner, events: nextEvents, loaded: nextLoaded });
  await clearPresenceCache(ownerId);
}

/**
 * 把消息列表和缓存的上下线记录按时间穿插合并，结果从旧到新。
 * 默认只保留不早于「已加载的最早一条消息」的上下线记录，避免历史记录堆在列表最前面；
 * 如果已经翻到最早的消息（includeBeforeOldest = true）或房间还没有消息，则全部显示。
 * 时间完全相同时：上线排在消息前，下线排在消息后。
 */
export function mergeChatTimeline(
  messages: Array<RoomMessageItem>,
  events: Array<PresenceEvent>,
  includeBeforeOldest: boolean = false
): Array<ChatTimelineItem> {
  if (events.length === 0) {
    return messages.map((item: RoomMessageItem): ChatTimelineItem => ({
      kind: 'message',
      key: item.key,
      time: item.raw.msgTime,
      item
    }));
  }

  const oldestMsgTime: number | undefined = messages[0]?.raw.msgTime;
  const visibleEvents: Array<PresenceEvent> = oldestMsgTime !== undefined && !includeBeforeOldest
    ? events.filter((event: PresenceEvent): boolean => event.time >= oldestMsgTime)
    : events;

  if (visibleEvents.length === 0) {
    return messages.map((item: RoomMessageItem): ChatTimelineItem => ({
      kind: 'message',
      key: item.key,
      time: item.raw.msgTime,
      item
    }));
  }

  const result: Array<ChatTimelineItem> = [];
  let i: number = 0;
  let j: number = 0;

  while (i < messages.length && j < visibleEvents.length) {
    const msg: RoomMessageItem = messages[i];
    const ev: PresenceEvent = visibleEvents[j];
    const eventFirst: boolean = ev.time < msg.raw.msgTime || (ev.time === msg.raw.msgTime && ev.kind === 'online');

    if (eventFirst) {
      result.push({ kind: 'presence', key: presenceEventKey(ev), time: ev.time, event: ev });
      j++;
    } else {
      result.push({ kind: 'message', key: msg.key, time: msg.raw.msgTime, item: msg });
      i++;
    }
  }

  while (i < messages.length) {
    const msg: RoomMessageItem = messages[i++];

    result.push({ kind: 'message', key: msg.key, time: msg.raw.msgTime, item: msg });
  }

  while (j < visibleEvents.length) {
    const ev: PresenceEvent = visibleEvents[j++];

    result.push({ kind: 'presence', key: presenceEventKey(ev), time: ev.time, event: ev });
  }

  return result;
}

/* 测试用 */
export function resetPresenceStoreForTest(): void {
  lastConfirmed = {};
  eventsCursors = {};
  state = {
    service: { configured: false, connected: false },
    byOwner: {},
    events: {},
    loaded: {},
    unresolved: {}
  };
  loadingOwners.clear();
  listeners.clear();
}
