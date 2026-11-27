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

import { canSyncMembers, requestSyncedMembers, resetSyncedMembers } from './memberSource';

const list: RoomIdObj = { buildTime: '2026-11-27 15:18:02', roomId: [{ id: 1, ownerName: '成员甲', team: '预备生', serverId: 100 }] };

describe('requestSyncedMembers', (): void => {
  beforeEach((): void => {
    configured = { baseUrl: 'https://example.invalid:8443', apiKey: 'k' };
    resetSyncedMembers();
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
    for (const answer of [
      (): Promise<RoomIdObj> => Promise.reject(new Error('超时')),
      (): Promise<RoomIdObj> => Promise.resolve({ buildTime: '', roomId: [] }),
      (): Promise<RoomIdObj> => Promise.resolve({ error: 'forbidden' } as unknown as RoomIdObj)
    ]) {
      resetSyncedMembers();
      expect(await requestSyncedMembers(answer)).toBeNull();
    }
  });

  test('取到的留 10 分钟不重复问；没取到的 5 分钟内不再问，过后再试', async (): Promise<void> => {
    let time: number = 1_000_000;
    let asked: number = 0;
    let fail: boolean = true;
    const ask: () => Promise<RoomIdObj> = (): Promise<RoomIdObj> => {
      asked++;

      return fail ? Promise.reject(new Error('连不上')) : Promise.resolve(list);
    };
    const now: () => number = (): number => time;

    expect(await requestSyncedMembers(ask, now)).toBeNull();
    expect(await requestSyncedMembers(ask, now)).toBeNull();
    expect(asked).toBe(1); // 刚失败过：不问

    time += 5 * 60_000;
    fail = false;
    expect(await requestSyncedMembers(ask, now)).toMatchObject({ synced: true });
    expect(await requestSyncedMembers(ask, now)).toMatchObject({ synced: true });
    expect(asked).toBe(2); // 留着的还新：不问

    time += 10 * 60_000;
    await requestSyncedMembers(ask, now);
    expect(asked).toBe(3);
  });
});
