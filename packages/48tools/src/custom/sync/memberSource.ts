import type { RoomIdObj } from '@48tools-api/48/jsdelivrCDN';
import { getPresenceConfig, requestPresenceJson, type PresenceClientConfig } from '../room/presenceApi';

/**
 * 成员名单从哪里来：配置了同步服务（和在线状态是同一个，local/pocket48.json 的 presenceUrl）时先问它要（GET /members）。
 * 服务那边把口袋48 官方的成员总表和原版用的公开名单合成一份、定时更新，新成员和预备生当天就有，
 * 格式和公开名单一样；程序里所有用成员名单的地方（自动抓取选成员、房间里显示队伍、搜索成员、切片时给 Gemini 的名单、
 * 在线状态找房间号）都经过 services/48/jsdelivrCDN 的 requestRoomId，在那里接上，所以各处看到的是同一份。
 * 没配同步服务、或者这次没取到时返回 null，用公开名单。
 */
export type SyncedMembers = RoomIdObj & { synced: true };

export function canSyncMembers(): boolean {
  return getPresenceConfig() !== undefined;
}

export async function requestSyncedMembers(
  fetchJson: (server: PresenceClientConfig) => Promise<RoomIdObj> = (server: PresenceClientConfig): Promise<RoomIdObj> =>
    requestPresenceJson<RoomIdObj>('GET', '/members', { config: server, timeoutMs: 20_000 })
): Promise<SyncedMembers | null> {
  const config: PresenceClientConfig | undefined = getPresenceConfig();

  if (!config) return null;

  try {
    const res: RoomIdObj = await fetchJson(config);

    return Array.isArray(res?.roomId) && res.roomId.length > 0 ? { roomId: res.roomId, buildTime: res.buildTime, synced: true } : null;
  } catch (err) {
    console.warn('成员名单没从同步服务取到，用公开名单', err);

    return null;
  }
}
