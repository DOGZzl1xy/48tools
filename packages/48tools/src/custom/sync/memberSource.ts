import type { RoomIdObj } from '@48tools-api/48/jsdelivrCDN';
import { getPresenceConfig, requestPresenceJson, type PresenceClientConfig } from '../room/presenceApi';

/**
 * 成员名单从哪里来：配置了同步服务（和在线状态是同一个，local/pocket48.json 的 presenceUrl）时先问它要（GET /members）。
 * 服务那边把口袋48 官方的成员总表和原版用的公开名单合成一份、定时更新，新成员和预备生当天就有，
 * 格式和公开名单一样；程序里所有用成员名单的地方（自动抓取选成员、房间里显示队伍、搜索成员、切片时给 Gemini 的名单、
 * 在线状态找房间号）都经过 services/48/jsdelivrCDN 的 requestRoomId，在那里接上，所以各处看到的是同一份。
 * 没配同步服务、或者这次没取到时返回 null，用公开名单。
 * 取到的留 10 分钟（好几个页面打开时都会要名单，不用每次都问）；没取到的 5 分钟内不再问（服务连不上时不让每个页面都等到超时）。
 */
export type SyncedMembers = RoomIdObj & { synced: true };

const KEEP_MS: number = 10 * 60_000;
const RETRY_AFTER_MS: number = 5 * 60_000;
const TIMEOUT_MS: number = 8_000;

let kept: { at: number; value: SyncedMembers } | undefined;
let failedAt: number = -Infinity;

export function canSyncMembers(): boolean {
  return getPresenceConfig() !== undefined;
}

export async function requestSyncedMembers(
  fetchJson: (server: PresenceClientConfig) => Promise<RoomIdObj> = (server: PresenceClientConfig): Promise<RoomIdObj> =>
    requestPresenceJson<RoomIdObj>('GET', '/members', { config: server, timeoutMs: TIMEOUT_MS }),
  now: () => number = Date.now
): Promise<SyncedMembers | null> {
  const config: PresenceClientConfig | undefined = getPresenceConfig();

  if (!config) return null;

  if (kept && now() - kept.at < KEEP_MS) return kept.value;

  if (now() - failedAt < RETRY_AFTER_MS) return null;

  try {
    const res: RoomIdObj = await fetchJson(config);

    if (Array.isArray(res?.roomId) && res.roomId.length > 0) {
      kept = { at: now(), value: { roomId: res.roomId, buildTime: res.buildTime, synced: true } };

      return kept.value;
    }
  } catch (err) {
    console.warn('成员名单没从同步服务取到，用公开名单', err);
  }

  failedAt = now();

  return null;
}

/* 测试用：忘掉留着的名单和「刚才没取到」 */
export function resetSyncedMembers(): void {
  kept = undefined;
  failedAt = -Infinity;
}
