import { Pocket48Login } from '../../functionalComponents/Pocket48Login/enum';
import type { UserInfo } from '../../functionalComponents/Pocket48Login/types';
import { getMemberDirectory, loadMemberDirectory, type DirectoryState } from './memberDirectory';
import { getRoomState, onFollowChange, type RoomMember } from './roomStore';
import { getChannel } from './unreadStore';
import {
  getPresenceConfig,
  pushFollowList,
  fetchPresence,
  fetchPresenceEvents,
  type ListMemberInput,
  type ListSyncResponse,
  type PresenceClientConfig,
  type PresenceEventsResponse,
  type PresenceResponse
} from './presenceApi';
import {
  applyServerEvents,
  applyServerPresence,
  getPresenceEventsCursor,
  markPresenceServiceDown,
  setPresencePending,
  setPresenceServiceConfigured,
  type PresenceFallbackLookup
} from './presenceStore';

/**
 * 远端在线状态服务的纯 HTTP 后台同步器：
 *   - userId 取本机已登录口袋48账号的 accid（稳定、每人唯一）
 *   - 启动时 & 每次本地关注列表变化（加/删）时，把完整关注清单全量推给 POST /list（服务端自行 diff 与解析）
 *   - 每 30 秒拉一次 GET /presence?userId=<accid>，直接按响应里的 ownerId 更新 UI
 *   - 启动 / 断线恢复 / 电脑休眠唤醒时拉一次 GET /events?since=<游标>&userId=<accid> 补齐期间上下线记录
 *   - 服务不可用、link.connected=false 或 stale=true 时静默显示「未知」并自动重试，不弹窗打扰
 * 接入点：custom/shell/AppShell.tsx 启动时调用 startPresenceWatcher。
 */
const POLL_INTERVAL_MS: number = 30_000;
const FIRST_SYNC_DELAY_MS: number = 3_000;
const FOLLOW_DEBOUNCE_MS: number = 400;
const WAKE_GAP_MS: number = 90_000;

let started: boolean = false;
let polling: boolean = false;
let pushingList: boolean = false;
let syncingEvents: boolean = false;
let listDirty: boolean = true;
let activeUserId: string | undefined;
let lastTickAt: number = 0;
let loggedDown: boolean = false;
let debounceTimer: number | undefined;
const trackedAccidToOwner: Map<string, number> = new Map();

/* 为服务端历史旧事件（升级前尚未带 ownerId 字段）提供纯内存兜底映射，不发任何请求 */
function buildFallbackLookup(): PresenceFallbackLookup {
  const byAccid: Map<string, number> = new Map(trackedAccidToOwner);
  const byName: Map<string, number> = new Map();
  const nameCounts: Map<string, number> = new Map();
  const follows: Array<RoomMember> = getRoomState().follows;

  for (const member of follows) {
    nameCounts.set(member.name, (nameCounts.get(member.name) ?? 0) + 1);
  }

  for (const member of follows) {
    if (nameCounts.get(member.name) === 1) byName.set(member.name, member.ownerId);
  }

  for (const dir of getMemberDirectory().members) {
    if (dir.account && !byAccid.has(dir.account)) byAccid.set(dir.account, dir.id);
  }

  return { byAccid, byName };
}

/* 取本机当前登录口袋48账号的 accid 作为 userId */
export function getCurrentUserId(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;

  try {
    const raw: string | null = localStorage.getItem(Pocket48Login.StorageKey);

    if (!raw) return undefined;

    const info: Partial<UserInfo> = JSON.parse(raw);

    return typeof info.accid === 'string' && info.accid.trim() !== '' ? info.accid.trim() : undefined;
  } catch {
    return undefined;
  }
}

/* 组装当前完整关注清单（带上已知的 serverId 可省服务端一次 jump，没有也没关系） */
export function buildFollowListPayload(follows: Array<RoomMember>, directory: DirectoryState): Array<ListMemberInput> {
  return follows.map((member: RoomMember): ListMemberInput => {
    const serverId: number | undefined = directory.byId[member.ownerId]?.serverId ?? getChannel(member.ownerId)?.serverId;

    return serverId === undefined
      ? { ownerId: member.ownerId, name: member.name }
      : { ownerId: member.ownerId, name: member.name, serverId };
  });
}

/* 拉取 GET /events?since=<游标>&userId=<accid> 补齐期间翻转 */
export async function syncPresenceEvents(userId?: string, config?: PresenceClientConfig): Promise<number> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();
  const uid: string | undefined = userId ?? getCurrentUserId();

  if (!cfg || !uid || syncingEvents) return 0;

  syncingEvents = true;

  try {
    const since: number = getPresenceEventsCursor(uid);
    const res: PresenceEventsResponse = await fetchPresenceEvents({ since, userId: uid, config: cfg });

    return applyServerEvents(res, uid, buildFallbackLookup());
  } catch (err) {
    console.warn('拉取历史上下线记录失败:', err instanceof Error ? err.message : String(err));

    return 0;
  } finally {
    syncingEvents = false;
  }
}

/* 拉一次 GET /presence?userId=<accid>，更新在线 / 离线 / 未知状态 */
export async function pollPresenceOnce(userId?: string, config?: PresenceClientConfig): Promise<boolean> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();
  const uid: string | undefined = userId ?? getCurrentUserId();

  if (!cfg || !uid || polling) return false;

  polling = true;

  try {
    const wasDown: boolean = loggedDown;
    const res: PresenceResponse = await fetchPresence({ userId: uid, config: cfg });

    applyServerPresence(res, buildFallbackLookup());
    loggedDown = false;

    if (wasDown) void syncPresenceEvents(uid, cfg);

    return true;
  } catch (err) {
    const msg: string = err instanceof Error ? err.message : String(err);

    if (!loggedDown) {
      console.warn('在线状态服务暂不可用（将自动重试）:', msg);
      loggedDown = true;
    }

    markPresenceServiceDown(msg);

    return false;
  } finally {
    polling = false;
  }
}

/* 把当前完整关注清单全量推给服务端 POST /list；若推送期间又有变更则紧接着再推一次 */
export async function syncFollowList(userId?: string, config?: PresenceClientConfig): Promise<ListSyncResponse | undefined> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();
  const uid: string | undefined = userId ?? getCurrentUserId();

  if (!cfg || !uid) return undefined;

  if (pushingList) {
    listDirty = true;

    return undefined;
  }

  pushingList = true;
  let lastRes: ListSyncResponse | undefined;

  try {
    await loadMemberDirectory();

    do {
      listDirty = false;

      const payload: Array<ListMemberInput> = buildFollowListPayload(getRoomState().follows, getMemberDirectory());

      lastRes = await pushFollowList(uid, payload, cfg);

      for (const item of lastRes.tracked ?? []) {
        if (item.accid && Number.isFinite(item.ownerId) && item.ownerId > 0) {
          trackedAccidToOwner.set(item.accid, item.ownerId);
        }
      }

      setPresencePending(lastRes.pending ?? []);
    } while (listDirty);

    loggedDown = false;

    return lastRes;
  } catch (err) {
    listDirty = true;

    const msg: string = err instanceof Error ? err.message : String(err);

    if (!loggedDown) {
      console.warn('同步关注清单到在线状态服务失败（将自动重试）:', msg);
      loggedDown = true;
    }

    markPresenceServiceDown(msg);

    return undefined;
  } finally {
    pushingList = false;
  }
}

/* 关注列表发生加/删变化时防抖推送最新整份清单，推完顺手刷新一次在线状态 */
function scheduleFollowListSync(): void {
  listDirty = true;

  if (typeof window === 'undefined') return;

  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(async (): Promise<void> => {
    const res: ListSyncResponse | undefined = await syncFollowList();

    if (res) await pollPresenceOnce();
  }, FOLLOW_DEBOUNCE_MS);
}

async function tick(): Promise<void> {
  const cfg: PresenceClientConfig | undefined = getPresenceConfig();

  if (!cfg) return;

  const uid: string | undefined = getCurrentUserId();

  if (!uid) return;

  const now: number = Date.now();
  const switchedUser: boolean = activeUserId !== uid;
  const wokeFromSleep: boolean = lastTickAt > 0 && now - lastTickAt >= WAKE_GAP_MS;

  lastTickAt = now;

  if (switchedUser) {
    activeUserId = uid;
    listDirty = true;
  }

  if (listDirty) await syncFollowList(uid, cfg);

  if (switchedUser || wokeFromSleep) await syncPresenceEvents(uid, cfg);

  await pollPresenceOnce(uid, cfg);
}

/* 启动后台轮询与关注变动监听（只启动一次；未配置服务地址时静默不启动） */
export function startPresenceWatcher(): void {
  if (started) return;

  const cfg: PresenceClientConfig | undefined = getPresenceConfig();

  if (!cfg) return;

  started = true;
  setPresenceServiceConfigured(true);

  onFollowChange((): void => {
    scheduleFollowListSync();
  });

  window.setTimeout(async (): Promise<void> => {
    lastTickAt = Date.now();

    const uid: string | undefined = getCurrentUserId();

    if (!uid) return;

    activeUserId = uid;
    await syncFollowList(uid, cfg);
    await syncPresenceEvents(uid, cfg);
    await pollPresenceOnce(uid, cfg);
  }, FIRST_SYNC_DELAY_MS);
  window.setInterval((): void => {
    void tick();
  }, POLL_INTERVAL_MS);
}
