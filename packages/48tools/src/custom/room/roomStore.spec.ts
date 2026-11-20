/* eslint-disable require-await */ // 假的接口函数要返回 Promise，但里面没有什么可等的
import type { CustomMessageV2 } from '@48tools-api/48';

/**
 * 房间消息的加载和同步（roomStore）：接口、本地缓存、未读统计都换成假的，只测这里自己的逻辑：
 * 第一次打开取最新一批、补新消息时一直取到和已有的接上、接不上时放弃旧的、往上翻、去重和排序。
 */
const pages: Record<number, { messages: Array<CustomMessageV2>; nextTime: number }> = {};
const written: Array<{ stream: string; count: number }> = [];
const cleared: Array<string> = [];
let requests: Array<number> = [];

jest.mock('@48tools-api/48', (): object => ({
  requestServerSearch: jest.fn(),
  requestServerJump: jest.fn(async (): Promise<object> => ({ content: { serverId: 11, channelId: 22 } })),
  requestHomeownerMessage: jest.fn(async (channelId: number, serverId: number, nextTime: number): Promise<object> => {
    requests.push(nextTime);

    return { success: true, content: { message: pages[nextTime]?.messages ?? [], nextTime: pages[nextTime]?.nextTime ?? 0 } };
  })
}), { virtual: true });
jest.mock('../../pages/48/RoomMessage/utils/formatData', (): object => ({
  FormatData: (raw: CustomMessageV2): object => ({ type: 'text', body: raw.bodys, user: JSON.parse(raw.extInfo).user })
}));
jest.mock('../../utils/snh48', (): object => ({ source: (value: string): string => value, getPocket48Token: (): string => 'token' }));
jest.mock('./roomApi', (): object => ({ requestAllMessage: jest.fn() }));
jest.mock('./roomCache', (): object => ({
  readRoomCache: jest.fn(async (): Promise<object> => ({ messages: [], more: false })),
  readRoomCacheBetween: jest.fn(async (): Promise<Array<unknown>> => []),
  writeRoomCache: jest.fn(async (stream: string, meta: unknown, messages: Array<unknown>): Promise<void> => {
    written.push({ stream, count: messages.length });
  }),
  clearRoomCache: jest.fn(async (stream: string): Promise<void> => {
    cleared.push(stream);
  })
}));
jest.mock('./unreadStore', (): object => ({ noteMessages: jest.fn(), getChannel: (): undefined => undefined, setChannel: jest.fn() }));

import { loadOlder, syncNewest, mergeItems, toItems, getRoomState, resetRoomStoreForTest, type RoomMember, type RoomMessageItem } from './roomStore';

const member: RoomMember = { ownerId: 7, name: '成员', avatar: '' };

/* 一批消息，接口返回的顺序是从新到旧 */
function batch(from: number, to: number): Array<CustomMessageV2> {
  const list: Array<CustomMessageV2> = [];

  for (let time: number = from; time >= to; time--) {
    list.push({
      msgIdServer: time,
      msgIdClient: `m${ time }`,
      msgTime: time * 1_000,
      msgType: 'TEXT',
      bodys: `第${ time }条`,
      extInfo: JSON.stringify({ user: { userId: 7, nickName: '成员', roleId: 3 } })
    } as CustomMessageV2);
  }

  return list;
}

function times(): Array<number> {
  return getRoomState().rooms[7].items.map((item: RoomMessageItem): number => item.raw.msgTime / 1_000);
}

describe('roomStore', function(): void {
  beforeEach(function(): void {
    resetRoomStoreForTest();
    for (const key of Object.keys(pages)) delete pages[Number(key)];
    written.length = 0;
    cleared.length = 0;
    requests = [];
  });

  test('toItems keeps only member messages for the owner stream and returns oldest first', function(): void {
    const fan: CustomMessageV2 = { ...batch(5, 5)[0], msgIdClient: 'fan', extInfo: JSON.stringify({ user: { userId: 9, roleId: 1 } }) };
    const list: Array<CustomMessageV2> = [...batch(3, 1), fan];

    expect(toItems(list).map((item: RoomMessageItem): string => item.key)).toEqual(['m1', 'm2', 'm3']);
    expect(toItems(list, 'all').map((item: RoomMessageItem): string => item.key)).toEqual(['fan', 'm1', 'm2', 'm3']);
  });

  test('mergeItems removes duplicates and sorts by time', function(): void {
    const merged: Array<RoomMessageItem> = mergeItems(toItems(batch(6, 4)), toItems(batch(5, 1)));

    expect(merged.map((item: RoomMessageItem): string => item.key)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  test('first open loads the newest page; scrolling up loads the next one and stops at the end', async function(): Promise<void> {
    pages[0] = { messages: batch(10, 6), nextTime: 6_000 };
    pages[6_000] = { messages: batch(5, 1), nextTime: 1_000 };
    pages[1_000] = { messages: [], nextTime: 0 };

    await loadOlder(member);
    expect(times()).toEqual([6, 7, 8, 9, 10]);
    expect(getRoomState().rooms[7]).toMatchObject({ opened: true, hasMore: true, serverId: 11, channelId: 22 });

    await loadOlder(member);
    expect(times()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await loadOlder(member);
    expect(getRoomState().rooms[7].hasMore).toBe(false);
    expect(requests).toEqual([0, 6_000, 1_000]);

    await loadOlder(member); // 已经到头：不再请求
    expect(requests).toHaveLength(3);
    expect(written.map((item: { count: number }): number => item.count)).toEqual([5, 5, 0]);
  });

  test('syncNewest fetches back until it connects with what is already loaded', async function(): Promise<void> {
    pages[0] = { messages: batch(10, 6), nextTime: 6_000 };
    await loadOlder(member);

    // 之后又来了 12 条新消息（11 ~ 22），每批 5 条
    pages[0] = { messages: batch(22, 18), nextTime: 18_000 };
    pages[18_000] = { messages: batch(17, 13), nextTime: 13_000 };
    pages[13_000] = { messages: batch(12, 8), nextTime: 8_000 };
    requests = [];

    await syncNewest(member);
    expect(requests).toEqual([0, 18_000, 13_000]); // 第三批里有已经加载过的，接上了，不再往回取
    expect(times()).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(cleared).toEqual([]);
    expect(getRoomState().rooms[7].syncing).toBe(false);
  });

  test('syncNewest with nothing new makes one request and changes nothing', async function(): Promise<void> {
    pages[0] = { messages: batch(10, 6), nextTime: 6_000 };
    await loadOlder(member);
    requests = [];

    await syncNewest(member);
    expect(requests).toEqual([0]);
    expect(times()).toEqual([6, 7, 8, 9, 10]);
  });

  test('a failed sync keeps the loaded messages and shows no error', async function(): Promise<void> {
    pages[0] = { messages: batch(10, 6), nextTime: 6_000 };
    await loadOlder(member);

    const api: { requestHomeownerMessage: jest.Mock } = jest.requireMock('@48tools-api/48');
    const errorLog: jest.SpyInstance = jest.spyOn(console, 'error').mockImplementation((): void => undefined);

    api.requestHomeownerMessage.mockRejectedValueOnce(new Error('网络不通'));
    await syncNewest(member);
    errorLog.mockRestore();

    expect(times()).toEqual([6, 7, 8, 9, 10]);
    expect(getRoomState().rooms[7]).toMatchObject({ syncing: false, error: undefined });
  });
});
