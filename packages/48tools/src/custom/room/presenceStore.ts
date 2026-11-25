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
import type { RoomMessageItem } from './roomStore';
import type { PresenceEventsResponse, PresenceResponse } from './presenceApi';

export type { PresenceEvent, PresenceKind } from './presenceCache';

/**
 * 成员在线状态与上下线时间线记录（供成员栏、首页关注列表、聊天记录使用）。
 *
 * 三态展示规则：
 *   - online：服务端明确在线且未过期（头像右下角显示主题色圆点）
 *   - offline：服务端明确离线且未过期（头像右下角显示灰色实心圆点）
 *   - unknown：stale=true、link.connected=false、since=null 或尚未连上服务（显示灰色空心环，不误判为离线，也不写入下线记录）
 *
 * 界面上只说三句话：在线 / 离线 / 状态未知（presenceLabel）。状态未知时的原因另外给（presenceReason），放在房间标题的提示里。
 *
 * 隔离约束：
 *   - 与未读统计（./unreadStore）完全隔离，上下线记录不会触发未读数字、「以下是新消息」分隔线或「有新消息」提示
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
  unresolved: Record<number, boolean>; // 关注了、但查不到云信账号的成员（服务端没法跟踪她，状态一直是未知）
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
const PENDING_EVENTS_KEY: string = 'ROOM_PRESENCE_PENDING_EVENTS';
const PENDING_EVENTS_MAX: number = 500;
const PENDING_EVENTS_KEEP_MS: number = 8 * 86_400_000; // 服务端只留 7 天，本地多留一天就够了
const DEDUPE_WINDOW_MS: number = 5_000;
const listeners: Set<() => void> = new Set();
const loadingOwners: Set<number> = new Set();

function loadEventsCursor(): number {
  if (typeof localStorage === 'undefined') return 0;

  const value: unknown = readJson<unknown>(EVENTS_CURSOR_KEY, 0);

  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function saveEventsCursor(cursor: number): void {
  if (typeof localStorage === 'undefined') return;

  writeJson(EVENTS_CURSOR_KEY, cursor);
}

let eventsCursor: number = loadEventsCursor();

export function getPresenceEventsCursor(): number {
  return eventsCursor;
}

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

/**
 * 还对不上本地成员的历史记录：补档（GET /events）时，某个账号暂时不知道是哪个成员（成员名单还没取到、
 * 身份还没关联上），先按账号存在这里；等对应关系有了再放进时间线。以前这种记录是直接跳过的，
 * 而补档的进度照样往前走，结果就再也补不回来了。
 */
interface PendingEvent {
  accid: string;
  time: number;
  kind: PresenceKind;
}

function loadPendingEvents(): Array<PendingEvent> {
  if (typeof localStorage === 'undefined') return [];

  const saved: unknown = readJson<unknown>(PENDING_EVENTS_KEY, []);

  if (!Array.isArray(saved)) return [];

  return saved.filter((item: PendingEvent): boolean => Boolean(item)
    && typeof item.accid === 'string'
    && typeof item.time === 'number'
    && (item.kind === 'online' || item.kind === 'offline'));
}

let pendingEvents: Array<PendingEvent> = loadPendingEvents();

function savePendingEvents(): void {
  if (typeof localStorage === 'undefined') return;

  writeJson(PENDING_EVENTS_KEY, pendingEvents);
}

export function getPendingPresenceEventCount(): number {
  return pendingEvents.length;
}

let lastConfirmed: Record<number, ConfirmedRecord> = loadLastConfirmed();
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

export function presenceEventKey(event: PresenceEvent): string {
  return `presence:${ event.ownerId }:${ event.time }:${ event.kind }`;
}

/* 界面上显示的状态：只有这三种说法（头像圆点的提示、房间标题里的文字都用它） */
export function presenceLabel(presence: MemberPresence | undefined): string {
  if (presence?.status === 'online') return '在线';

  if (presence?.status === 'offline') return '离线';

  return '状态未知';
}

/* 状态未知时的原因（房间标题里鼠标放到「状态未知」上时显示）；状态明确时没有 */
export function presenceReason(
  presence: MemberPresence | undefined,
  service: PresenceServiceState | undefined,
  unresolved: boolean
): string | undefined {
  if (presence?.status === 'online' || presence?.status === 'offline') return undefined;

  if (service?.configured && !service.connected) return '在线状态服务暂时没有连上，连上后会自动恢复';

  if (unresolved) return '成员名单里还没有她的账号信息，暂时查不到她的在线状态';

  return '还没有拿到她的状态，稍等一会儿';
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

/* 哪些关注的成员查不到账号（由 ./presenceWatcher 算出来）；没有变化时不通知界面 */
export function setPresenceUnresolved(ownerIds: Array<number>): void {
  const next: Record<number, boolean> = {};

  for (const ownerId of ownerIds) next[ownerId] = true;

  const prevKeys: Array<string> = Object.keys(state.unresolved);

  if (prevKeys.length === ownerIds.length && prevKeys.every((key: string): boolean => next[Number(key)])) return;

  setState({ unresolved: next });
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

/* 把一批已经知道是谁的记录放进时间线（去重），返回新增了多少条 */
function acceptEvents(incomingByOwner: Map<number, Array<PresenceEvent>>): number {
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

  if (toPersist.length > 0) {
    setState({ events: nextEvents });
    void writePresenceEvents(toPersist);
  }

  return toPersist.length;
}

/**
 * 之前对不上成员的记录，现在能对上的就放进时间线；太旧的（服务端也早就不留了）丢掉。
 * @param { Map<string, number> } accidToOwner
 * @param { number } [now] - 现在的时间。调用的地方传服务端的时间（记录的时间也是服务端的），不受本机时钟影响
 * @return { number } 这次放进时间线的条数
 */
export function flushPendingEvents(accidToOwner: Map<string, number>, now: number = Date.now()): number {
  if (pendingEvents.length === 0) return 0;

  const incomingByOwner: Map<number, Array<PresenceEvent>> = new Map();
  const rest: Array<PendingEvent> = [];

  for (const item of pendingEvents) {
    const ownerId: number | undefined = accidToOwner.get(item.accid);

    if (ownerId !== undefined) {
      const list: Array<PresenceEvent> = incomingByOwner.get(ownerId) ?? [];

      list.push({ ownerId, time: item.time, kind: item.kind });
      incomingByOwner.set(ownerId, list);
    } else if (now - item.time < PENDING_EVENTS_KEEP_MS) {
      rest.push(item);
    }
  }

  if (rest.length === pendingEvents.length) return 0;

  pendingEvents = rest;
  savePendingEvents();

  return acceptEvents(incomingByOwner);
}

/**
 * 消费服务端 GET /presence 的完整响应：
 *   - link.connected === false 或 member.stale === true 或 member.since === null → status='unknown'（不记录下线）
 *   - 否则 status='online'|'offline'，仅当与上次确认状态发生切换时写入本地时间线缓存
 */
export function applyServerPresence(
  response: PresenceResponse,
  accidToOwner: Map<string, number>
): void {
  const linkConnected: boolean = Boolean(response.link?.connected);
  const serverTime: number = Number(response.serverTime) || Date.now();

  flushPendingEvents(accidToOwner, serverTime);

  const nextByOwner: Record<number, MemberPresence> = { ...state.byOwner };
  let nextEvents: Record<number, Array<PresenceEvent>> = state.events;
  let confirmedChanged: boolean = false;
  const nextConfirmed: Record<number, ConfirmedRecord> = { ...lastConfirmed };

  for (const item of response.members ?? []) {
    const ownerId: number | undefined = accidToOwner.get(item.accid);

    if (ownerId === undefined) continue;

    const prev: MemberPresence | undefined = nextByOwner[ownerId];
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

    // 只有之前已有确认态、且状态确实发生了切换时才写入时间线记录（避免服务重启或程序首次打开时刷一排历史状态）
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

  // 如果整条云信链路断开，但 members 里未包含的旧条目也一并标为未知
  if (!linkConnected) {
    for (const [k, cur] of Object.entries(nextByOwner)) {
      if (cur.status !== 'unknown') {
        nextByOwner[Number(k)] = { ...cur, status: 'unknown', online: false, stale: true, serverTime };
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
 * 消费服务端 GET /events?since=... 的历史上下线事件（按时间升序），用于补齐程序关闭/电脑休眠/断网期间的空档。
 * 写入本地 IndexedDB 缓存并更新游标，完全不影响未读数。
 * 暂时对不上本地成员的记录不丢：先存起来（见上面的 PendingEvent），以后对上了再补进时间线。
 * @return { number } 本次新增写入的事件条数
 */
export function applyServerEvents(
  response: PresenceEventsResponse,
  accidToOwner: Map<string, number>
): number {
  const flushed: number = flushPendingEvents(accidToOwner, Number(response.serverTime) || Date.now());
  const incomingByOwner: Map<number, Array<PresenceEvent>> = new Map();
  const known: Set<string> = new Set(pendingEvents.map((item: PendingEvent): string => `${ item.accid }:${ item.time }`));
  let maxTime: number = eventsCursor;
  let pendingChanged: boolean = false;

  for (const raw of response.events ?? []) {
    const time: number = Number(raw.t);

    if (!Number.isFinite(time) || time <= 0) continue;

    if (time > maxTime) maxTime = time;

    const kind: PresenceKind = raw.online ? 'online' : 'offline';
    const ownerId: number | undefined = accidToOwner.get(raw.accid);

    if (ownerId === undefined) {
      if (typeof raw.accid === 'string' && raw.accid !== '' && !known.has(`${ raw.accid }:${ time }`)) {
        known.add(`${ raw.accid }:${ time }`);
        pendingEvents.push({ accid: raw.accid, time, kind });
        pendingChanged = true;
      }

      continue;
    }

    const list: Array<PresenceEvent> = incomingByOwner.get(ownerId) ?? [];

    list.push({ ownerId, time, kind });
    incomingByOwner.set(ownerId, list);
  }

  if (pendingChanged) {
    // 只留最新的一部分，免得一直对不上的账号把它撑大
    if (pendingEvents.length > PENDING_EVENTS_MAX) pendingEvents = pendingEvents.slice(pendingEvents.length - PENDING_EVENTS_MAX);

    savePendingEvents();
  }

  const added: number = acceptEvents(incomingByOwner);
  const nextCursor: number = Math.max(maxTime, Number(response.serverTime) || 0);

  if (nextCursor > eventsCursor) {
    eventsCursor = nextCursor;
    saveEventsCursor(eventsCursor);
  }

  return flushed + added;
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
  const nextUnresolved: Record<number, boolean> = { ...state.unresolved };
  const nextConfirmed: Record<number, ConfirmedRecord> = { ...lastConfirmed };

  delete nextByOwner[ownerId];
  delete nextEvents[ownerId];
  delete nextLoaded[ownerId];
  delete nextUnresolved[ownerId];
  delete nextConfirmed[ownerId];
  lastConfirmed = nextConfirmed;
  saveLastConfirmed(nextConfirmed);
  setState({ byOwner: nextByOwner, events: nextEvents, loaded: nextLoaded, unresolved: nextUnresolved });
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
  eventsCursor = 0;
  pendingEvents = [];
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
