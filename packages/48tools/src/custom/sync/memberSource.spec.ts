/**
 * 成员名单从同步服务取：没配服务不问；取到的要是和公开名单一样的格式；取不到、格式不对时返回 null（调用的地方改用公开名单）。
 */
import type { RoomIdObj } from '@48tools-api/48/jsdelivrCDN';
import type { PresenceClientConfig } from '../room/presenceApi';

let configured: PresenceClientConfig | undefined;

jest.mock('../room/presenceApi', (): object => ({
  getPresenceConfig: (): PresenceClientConfig | undefined => configured,
  requestPresenceJson: (): Promise<never> => Promise.reject(new Error('测试里不该真的发请求'))
}));

import { canSyncMembers, requestSyncedMembers } from './memberSource';

const list: RoomIdObj = { buildTime: '2026-11-27 15:18:02', roomId: [{ id: 1, ownerName: '成员甲', team: '预备生', serverId: 100 }] };

describe('requestSyncedMembers', (): void => {
  beforeEach((): void => {
    configured = { baseUrl: 'https://example.invalid:8443', apiKey: 'k' };
    jest.spyOn(console, 'warn').mockImplementation((): void => undefined);
  });

  afterEach((): void => void jest.restoreAllMocks());

  test('没配同步服务：不问，返回 null', async (): Promise<void> => {
    configured = undefined;

    let asked: number = 0;

    expect(canSyncMembers()).toBe(false);
    expect(await requestSyncedMembers((): Promise<RoomIdObj> => {
      asked++;

      return Promise.resolve(list);
    })).toBeNull();
    expect(asked).toBe(0);
  });

  test('取到了：和公开名单一样的格式，标上是同步来的', async (): Promise<void> => {
    expect(canSyncMembers()).toBe(true);
    expect(await requestSyncedMembers((): Promise<RoomIdObj> => Promise.resolve({ ...list, lookups: {} } as RoomIdObj)))
      .toEqual({ ...list, synced: true });
  });

  test('没连上、名单是空的、格式不对：返回 null', async (): Promise<void> => {
    expect(await requestSyncedMembers((): Promise<RoomIdObj> => Promise.reject(new Error('超时')))).toBeNull();
    expect(await requestSyncedMembers((): Promise<RoomIdObj> => Promise.resolve({ buildTime: '', roomId: [] }))).toBeNull();
    expect(await requestSyncedMembers((): Promise<RoomIdObj> => Promise.resolve({ error: 'forbidden' } as unknown as RoomIdObj))).toBeNull();
  });
});
