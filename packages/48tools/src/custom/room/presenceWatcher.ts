import { getMemberDirectory, loadMemberDirectory, type DirectoryState } from './memberDirectory';
import { getRoomState, onFollowChange, type RoomMember } from './roomStore';
import {
  getPresenceConfig,
  fetchPresence,
  fetchPresenceEvents,
  fetchRoster,
  addRosterMember,
  removeRosterMember,
  type PresenceClientConfig,
  type PresenceEventsResponse,
  type PresenceResponse,
  type RosterResponse
} from './presenceApi';
import {
  buildAccidToOwnerMap,
  getSavedIdentity,
  linkServerRoster,
  resolveMemberIdentity,
  type MemberIdentity
} from './presenceIdentity';
import {
  applyServerEvents,
  applyServerPresence,
  getPresenceEventsCursor,
  markPresenceServiceDown,
  setPresenceServiceConfigured,
  setPresenceUnresolved
} from './presenceStore';

/**
 * 远端在线状态服务的后台同步器：
 *   - 程序启动时若本机 local/pocket48.json 配置了服务地址和密钥，自动启动定时轮询（每 30 秒拉一次 GET /presence）
 *   - 启动时、断线恢复后以及电脑休眠唤醒后，自动拉取 GET /events?since=... 补齐期间错过的上下线记录
 *   - 启动时与服务端 GET /roster 对账：把本地已关注但服务端名单里还没有的成员自动 POST /roster 补上
 *   - 本地新增关注时 POST /roster 通知服务端追加；取消关注时 DELETE /roster/{accid}
 *   - 远端未启动、断网或云信断线时静默标为「未知」，不弹报错打扰用户，等服务恢复后自动接上
 *   - 查不到账号的成员（成员名单还没收录的新成员）加不进服务端名单：记下来告诉界面（「状态未知」的原因），
 *     每 10 分钟对账时再试一次，不会每 30 秒都去试
 *   - 测试窗口（TEST=true 启动的那种）只读：照常取状态和历史记录，但不对账、不增删服务端名单。
 *     测试窗口用的是另一份数据，里面关注的成员和平时用的不一样，不能让它改到线上的名单
 * 接入点：custom/shell/AppShell.tsx 启动时调用 startPresenceWatcher。
 */
const POLL_INTERVAL_MS: number = 30_000;
const FIRST_SYNC_DELAY_MS: number = 3_000;
const ROSTER_RECONCILE_INTERVAL_MS: number = 10 * 60_000;
const WAKE_GAP_MS: number = 90_000;

let started: boolean = false;
let polling: boolean = false;
let syncingRoster: boolean = false;
let syncingEvents: boolean = false;
let lastRosterSyncAt: number = 0;
let lastTickAt: number = 0;
let loggedDown: boolean = false;
const pendingAdds: Map<number, RoomMember> = new Map();

/* 是不是测试窗口（检查脚本启动的）：是的话不改服务端的名单 */
export function isPresenceReadOnly(): boolean {
  const initial: { isTest?: boolean } | undefined = (globalThis as { __INITIAL_STATE__?: { isTest?: boolean } }).__INITIAL_STATE__;

  return Boolean(initial?.isTest) || process.env.TEST === 'true';
}

/* 关注的成员里哪些查不到账号：告诉界面 */
function reportUnresolved(): void {
  const directory: DirectoryState = getMemberDirectory();
  const ownerIds: Array<number> = getRoomState().follows
    .filter((member: RoomMember): boolean => !getSavedIdentity(member.ownerId)?.accid && !directory.byId[member.ownerId]?.account)
    .map((member: RoomMember): number => member.ownerId);

  setPresenceUnresolved(ownerIds);
}

/* 拉取 GET /events?since=<cursor> 补齐离线/休眠期间的上下线记录 */
export async function syncPresenceEvents(config?: PresenceClientConfig): Promise<number> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();

  if (!cfg || syncingEvents) return 0;

  syncingEvents = true;

  try {
    const since: number = getPresenceEventsCursor();
    const res: PresenceEventsResponse = await fetchPresenceEvents({ since, config: cfg });
    const directory: DirectoryState = getMemberDirectory();
    const follows: Array<RoomMember> = getRoomState().follows;
    const map: Map<string, number> = buildAccidToOwnerMap(directory, follows);

    return applyServerEvents(res, map);
  } catch (err) {
    // 补档失败不打扰用户，下次重连或唤醒时继续按旧游标补齐
    console.warn('拉取历史上下线记录失败:', err instanceof Error ? err.message : String(err));

    return 0;
  } finally {
    syncingEvents = false;
  }
}

/* 拉一次 GET /presence，更新所有成员的在线 / 离线 / 未知状态 */
export async function pollPresenceOnce(config?: PresenceClientConfig): Promise<boolean> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();

  if (!cfg || polling) return false;

  polling = true;

  try {
    const wasDown: boolean = loggedDown;
    const res: PresenceResponse = await fetchPresence(cfg);
    const directory: DirectoryState = getMemberDirectory();
    const follows: Array<RoomMember> = getRoomState().follows;
    const map: Map<string, number> = buildAccidToOwnerMap(directory, follows);

    // 响应里有还没关联到本地 ownerId 的新成员时，顺便把 /roster 拉下来按 serverId 关联一次
    const hasUnmapped: boolean = (res.members ?? []).some((m: { accid: string }): boolean => !map.has(m.accid));

    if (hasUnmapped && !syncingRoster) {
      try {
        const rosterRes: RosterResponse = await fetchRoster(cfg);
        const linked: Map<string, number> = linkServerRoster(rosterRes.members ?? [], directory, follows);

        applyServerPresence(res, linked);
      } catch {
        applyServerPresence(res, map);
      }
    } else {
      applyServerPresence(res, map);
    }

    loggedDown = false;
    reportUnresolved();

    // 断线恢复后顺便拉一次 /events 补档
    if (wasDown) void syncPresenceEvents(cfg);

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

/* 与服务端 /roster 对账：把本地关注列表里缺席的成员追加到服务端 */
export async function syncFollowedRoster(config?: PresenceClientConfig): Promise<void> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();

  if (!cfg || syncingRoster || isPresenceReadOnly()) return;

  syncingRoster = true;

  try {
    await loadMemberDirectory();

    const rosterRes: RosterResponse = await fetchRoster(cfg);
    const directory: DirectoryState = getMemberDirectory();
    const follows: Array<RoomMember> = getRoomState().follows;

    linkServerRoster(rosterRes.members ?? [], directory, follows);

    const onServer: Set<string> = new Set((rosterRes.members ?? []).map((item: { accid: string }): string => item.accid));

    for (const member of follows) {
      try {
        const identity: MemberIdentity | undefined = await resolveMemberIdentity(member);

        if (!identity?.accid) {
          pendingAdds.set(member.ownerId, member);
          continue;
        }

        if (!onServer.has(identity.accid)) {
          await addRosterMember({ accid: identity.accid, name: member.name, serverId: identity.serverId }, cfg);
          onServer.add(identity.accid);
        }

        pendingAdds.delete(member.ownerId);
      } catch (err) {
        pendingAdds.set(member.ownerId, member);
        console.warn('同步关注成员到在线状态服务失败:', member.name, err);
      }
    }

    lastRosterSyncAt = Date.now();
    reportUnresolved();
  } catch (err) {
    // 服务尚未启动或网络断开时静默等待下一轮
    if (!loggedDown) {
      console.warn('拉取在线状态名单失败（将自动重试）:', err instanceof Error ? err.message : String(err));
      loggedDown = true;
    }
  } finally {
    syncingRoster = false;
  }
}

/* 本地新增关注 → 若已能从缓存/公开名单解析 accid，立即 POST /roster 通知服务端追加 */
export async function notifyFollowAdded(member: RoomMember, config?: PresenceClientConfig): Promise<boolean> {
  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();

  if (!cfg || isPresenceReadOnly()) return false;

  try {
    await loadMemberDirectory();

    const identity: MemberIdentity | undefined = await resolveMemberIdentity(member);

    if (!identity?.accid) {
      pendingAdds.set(member.ownerId, member);
      reportUnresolved();

      return false;
    }

    await addRosterMember({ accid: identity.accid, name: member.name, serverId: identity.serverId }, cfg);
    pendingAdds.delete(member.ownerId);

    // 稍等服务端就绪后补查一次，尽快点亮状态
    if (typeof window !== 'undefined') {
      window.setTimeout((): void => {
        void pollPresenceOnce(cfg);
      }, 1_500);
    }

    return true;
  } catch (err) {
    pendingAdds.set(member.ownerId, member);
    console.warn('通知在线状态服务新增关注失败（稍后自动重试）:', member.name, err);

    return false;
  }
}

/* 本地取消关注 → 若已知 accid 则通知服务端 DELETE /roster/{accid} */
export async function notifyFollowRemoved(member: RoomMember, config?: PresenceClientConfig): Promise<boolean> {
  pendingAdds.delete(member.ownerId);
  reportUnresolved();

  const cfg: PresenceClientConfig | undefined = config ?? getPresenceConfig();

  if (!cfg || isPresenceReadOnly()) return false;

  const accid: string | undefined = getSavedIdentity(member.ownerId)?.accid
    ?? getMemberDirectory().byId[member.ownerId]?.account;

  if (!accid) return false;

  try {
    await removeRosterMember(accid, cfg);

    return true;
  } catch (err) {
    console.warn('通知在线状态服务移除成员失败:', member.name, err);

    return false;
  }
}

async function tick(): Promise<void> {
  const cfg: PresenceClientConfig | undefined = getPresenceConfig();

  if (!cfg) return;

  const now: number = Date.now();
  const wokeFromSleep: boolean = lastTickAt > 0 && now - lastTickAt >= WAKE_GAP_MS;

  lastTickAt = now;

  // 没加成功的成员（查不到账号、或者当时服务没连上）跟着每 10 分钟一次的对账再试，不用每 30 秒都试
  if (now - lastRosterSyncAt >= ROSTER_RECONCILE_INTERVAL_MS) {
    lastRosterSyncAt = now; // 这一轮失败了也等下一个 10 分钟
    await syncFollowedRoster(cfg);
  }

  if (wokeFromSleep) await syncPresenceEvents(cfg);

  await pollPresenceOnce(cfg);
}

/* 启动后台轮询与关注变动监听（只启动一次；未配置服务地址时静默不启动） */
export function startPresenceWatcher(): void {
  if (started) return;

  const cfg: PresenceClientConfig | undefined = getPresenceConfig();

  if (!cfg) return;

  started = true;
  setPresenceServiceConfigured(true);

  onFollowChange((member: RoomMember, followed: boolean): void => {
    void (followed ? notifyFollowAdded(member) : notifyFollowRemoved(member));
  });

  window.setTimeout(async (): Promise<void> => {
    lastTickAt = Date.now();
    await syncFollowedRoster(cfg);
    await syncPresenceEvents(cfg);
    await pollPresenceOnce(cfg);
  }, FIRST_SYNC_DELAY_MS);
  window.setInterval((): void => {
    void tick();
  }, POLL_INTERVAL_MS);
}
