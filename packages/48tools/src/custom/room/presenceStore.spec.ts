import * as http from 'node:http';
import type { CustomMessageV2 } from '@48tools-api/48';

jest.mock('@48tools-api/48', (): object => ({
  requestServerJump: jest.fn()
}), { virtual: true });
jest.mock('../../utils/snh48', (): object => ({
  getPocket48Token: (): undefined => undefined
}));

import {
  getPresenceState,
  applyServerPresence,
  applyServerEvents,
  getPresenceEventsCursor,
  markPresenceServiceDown,
  updateMemberPresence,
  appendPresenceEvent,
  mergeChatTimeline,
  presenceLabel,
  presenceReason,
  flushPendingEvents,
  getPendingPresenceEventCount,
  setPresenceUnresolved,
  resetPresenceStoreForTest,
  type ChatTimelineItem,
  type PresenceEvent
} from './presenceStore';
import {
  fetchPresence,
  fetchPresenceEvents,
  fetchRoster,
  addRosterMember,
  removeRosterMember,
  fetchPresenceHealth,
  normalizePin,
  isAllowedPresenceUrl,
  PresenceApiError,
  type PresenceClientConfig,
  type PresenceEventsResponse,
  type PresenceHealthResponse,
  type PresenceResponse,
  type PresenceServerEvent,
  type RosterMember,
  type RosterResponse
} from './presenceApi';
import type { DirectoryState } from './memberDirectory';
import { linkServerRoster, resetPresenceIdentityForTest } from './presenceIdentity';
import { getUnreadState, resetUnreadForTest } from './unreadStore';
import type { RoomMessageItem } from './roomStore';

function msg(id: string, msgTime: number): RoomMessageItem {
  const raw: CustomMessageV2 = {
    msgIdServer: Number(id.replace(/\D/g, '')) || 1,
    msgIdClient: id,
    msgTime,
    msgType: 'TEXT',
    bodys: `msg-${ id }`,
    extInfo: JSON.stringify({ user: { userId: 1001, nickName: '成员', roleId: 3 } })
  };

  return { key: id, raw, message: { type: 'text', body: `msg-${ id }`, user: { userId: 1001, nickName: '成员', roleId: 3 } } as unknown as RoomMessageItem['message'] };
}

describe('presenceStore', function(): void {
  beforeEach(function(): void {
    resetPresenceStoreForTest();
    resetPresenceIdentityForTest();
    resetUnreadForTest(true);
  });

  test('applyServerPresence：正确处理 online / offline / stale / link断连，绝不写入虚假下线且不触发未读', function(): void {
    const map: Map<string, number> = new Map([
      ['acc_1', 1001],
      ['acc_2', 1002]
    ]);
    const t0: number = Date.UTC(2026, 10, 24, 12, 0, 0);

    // 1. 首次轮询：acc_1 离线，acc_2 stale=true → 不应产生历史刷屏事件
    const p1: PresenceResponse = {
      serverTime: t0 + 10_000,
      link: { connected: true, lastPollAt: t0 + 5_000 },
      members: [
        { accid: 'acc_1', name: '甲', online: false, since: t0, stale: false },
        { accid: 'acc_2', name: '乙', online: false, since: null, stale: true }
      ]
    };

    applyServerPresence(p1, map);
    expect(getPresenceState().byOwner[1001].status).toBe('offline');
    expect(getPresenceState().byOwner[1002].status).toBe('unknown');
    expect(getPresenceState().events[1001]).toBeUndefined();

    // 2. acc_1 上线（offline → online）→ 记录一条上线事件，时间为 since
    const t1: number = t0 + 60_000;

    applyServerPresence({
      serverTime: t1 + 15_000,
      link: { connected: true, lastPollAt: t1 + 10_000 },
      members: [
        { accid: 'acc_1', name: '甲', online: true, since: t1, stale: false },
        { accid: 'acc_2', name: '乙', online: false, since: t1, stale: false }
      ]
    }, map);
    expect(getPresenceState().byOwner[1001].status).toBe('online');
    expect(getPresenceState().events[1001]).toEqual([{ ownerId: 1001, time: t1, kind: 'online' }]);
    expect(getPresenceState().byOwner[1002].status).toBe('offline');
    expect(getPresenceState().events[1002]).toBeUndefined(); // 首次确认不写入事件

    // 3. 服务端链路断开（link.connected=false）→ 标为 unknown，不写入虚假下线
    applyServerPresence({
      serverTime: t1 + 90_000,
      link: { connected: false, lastPollAt: t1 + 10_000 },
      members: [
        { accid: 'acc_1', name: '甲', online: false, since: t1, stale: true }
      ]
    }, map);
    expect(getPresenceState().service.connected).toBe(false);
    expect(getPresenceState().byOwner[1001].status).toBe('unknown');
    expect(getPresenceState().byOwner[1002].status).toBe('unknown');
    expect(getPresenceState().events[1001]).toHaveLength(1);

    // 4. 恢复连接后 acc_1 依然在线 → 不重复记录；随后真正下线 → 记录一条下线事件
    const t2: number = t1 + 180_000;

    applyServerPresence({
      serverTime: t1 + 120_000,
      link: { connected: true, lastPollAt: t1 + 120_000 },
      members: [{ accid: 'acc_1', name: '甲', online: true, since: t1, stale: false }]
    }, map);
    expect(getPresenceState().events[1001]).toHaveLength(1);

    applyServerPresence({
      serverTime: t2 + 5_000,
      link: { connected: true, lastPollAt: t2 + 5_000 },
      members: [{ accid: 'acc_1', name: '甲', online: false, since: t2, stale: false }]
    }, map);
    expect(getPresenceState().events[1001]).toEqual([
      { ownerId: 1001, time: t1, kind: 'online' },
      { ownerId: 1001, time: t2, kind: 'offline' }
    ]);

    // 5. 请求失败标为服务不可用，同样不产生假下线
    markPresenceServiceDown('connect ECONNREFUSED');
    expect(getPresenceState().service.connected).toBe(false);
    expect(getPresenceState().byOwner[1001].status).toBe('unknown');
    expect(getPresenceState().events[1001]).toHaveLength(2);

    // 6. 未读数和分隔线完全不受影响
    expect(getUnreadState().counts).toEqual({});
    expect(getUnreadState().dividers).toEqual({});
  });

  test('短时间窗口内的同类重复事件会被去重', function(): void {
    updateMemberPresence(1001, false, 1_000);
    appendPresenceEvent({ ownerId: 1001, time: 10_000, kind: 'online' });
    appendPresenceEvent({ ownerId: 1001, time: 12_000, kind: 'online' });
    appendPresenceEvent({ ownerId: 1001, time: 13_000, kind: 'offline' });

    expect(getPresenceState().events[1001]).toEqual([
      { ownerId: 1001, time: 10_000, kind: 'online' },
      { ownerId: 1001, time: 13_000, kind: 'offline' }
    ]);
  });

  test('mergeChatTimeline 按时间穿插合并，同时间上线在前下线在后', function(): void {
    const messages: Array<RoomMessageItem> = [msg('m1', 200), msg('m2', 500)];
    const events: Array<PresenceEvent> = [
      { ownerId: 1001, time: 100, kind: 'online' },
      { ownerId: 1001, time: 200, kind: 'online' },
      { ownerId: 1001, time: 350, kind: 'offline' },
      { ownerId: 1001, time: 500, kind: 'offline' },
      { ownerId: 1001, time: 700, kind: 'online' }
    ];

    const timeline: Array<ChatTimelineItem> = mergeChatTimeline(messages, events, false);

    expect(timeline.map((item: ChatTimelineItem): string => (item.kind === 'message' ? item.key : `${ item.event.kind }@${ item.time }`)))
      .toEqual(['online@200', 'm1', 'offline@350', 'm2', 'offline@500', 'online@700']);

    const fullTimeline: Array<ChatTimelineItem> = mergeChatTimeline(messages, events, true);

    expect(fullTimeline[0].kind).toBe('presence');
    expect(fullTimeline[0].time).toBe(100);
  });

  test('presenceLabel 只有三种说法；状态未知时 presenceReason 给出原因', function(): void {
    const t: number = Date.UTC(2026, 10, 24, 12, 30, 0);

    expect(presenceLabel({ status: 'online', online: true, stale: false, since: t, serverTime: t, updatedAt: t })).toBe('在线');
    expect(presenceLabel({ status: 'offline', online: false, stale: false, since: t, serverTime: t, updatedAt: t })).toBe('离线');
    expect(presenceLabel({ status: 'unknown', online: false, stale: true, updatedAt: t })).toBe('状态未知');
    expect(presenceLabel(undefined)).toBe('状态未知');

    // 状态明确时没有「原因」
    expect(presenceReason({ status: 'offline', online: false, stale: false, updatedAt: t }, { configured: true, connected: true }, false)).toBeUndefined();
    // 服务没连上 > 查不到账号 > 还没拿到
    expect(presenceReason(undefined, { configured: true, connected: false }, true)).toContain('没有连上');
    expect(presenceReason(undefined, { configured: true, connected: true }, true)).toContain('账号信息');
    expect(presenceReason(undefined, { configured: true, connected: true }, false)).toContain('稍等');
  });

  test('setPresenceUnresolved 记下查不到账号的成员，没变化时不通知界面', function(): void {
    setPresenceUnresolved([7, 8]);

    const first: unknown = getPresenceState();

    expect(getPresenceState().unresolved).toEqual({ 7: true, 8: true });
    setPresenceUnresolved([8, 7]);
    expect(getPresenceState()).toBe(first);
    setPresenceUnresolved([]);
    expect(getPresenceState().unresolved).toEqual({});
  });

  test('补档时对不上成员的记录先存着，对上之后补进时间线，不会丢', function(): void {
    const day: number = 86_400_000;
    const now: number = 100 * day;

    // 第一次补档：acc_2 还不知道是谁
    const added: number = applyServerEvents({
      serverTime: now,
      retentionMs: 7 * day,
      events: [
        { t: now - 5_000_000, accid: 'acc_1', name: '甲', online: true },
        { t: now - 4_000_000, accid: 'acc_2', name: '乙', online: true },
        { t: now - 3_000_000, accid: 'acc_2', name: '乙', online: false }
      ]
    }, new Map([['acc_1', 1001]]));

    expect(added).toBe(1);
    expect(getPresenceEventsCursor()).toBe(now); // 进度照常往前走
    expect(getPendingPresenceEventCount()).toBe(2);
    expect(getPresenceState().events[1002]).toBeUndefined();

    // 同样的记录再来一次不会重复存
    applyServerEvents({
      serverTime: now,
      retentionMs: 7 * day,
      events: [{ t: now - 4_000_000, accid: 'acc_2', name: '乙', online: true }]
    }, new Map([['acc_1', 1001]]));
    expect(getPendingPresenceEventCount()).toBe(2);

    // 之后知道 acc_2 是 1002 了：补进时间线
    expect(flushPendingEvents(new Map([['acc_1', 1001], ['acc_2', 1002]]), now)).toBe(2);
    expect(getPendingPresenceEventCount()).toBe(0);
    expect(getPresenceState().events[1002]).toEqual([
      { ownerId: 1002, time: now - 4_000_000, kind: 'online' },
      { ownerId: 1002, time: now - 3_000_000, kind: 'offline' }
    ]);
    expect(getUnreadState().counts).toEqual({});
  });

  test('一直对不上的记录过了保留期就丢掉；拿到 /presence 时也会顺便补', function(): void {
    const day: number = 86_400_000;
    const now: number = 100 * day;

    applyServerEvents({
      serverTime: now,
      retentionMs: 7 * day,
      events: [
        { t: now - (9 * day), accid: 'acc_old', name: '旧', online: true },
        { t: now - 1_000, accid: 'acc_3', name: '丙', online: true }
      ]
    }, new Map());
    expect(getPendingPresenceEventCount()).toBe(2);

    // 对不上、又太旧的丢掉，其余留着
    expect(flushPendingEvents(new Map(), now)).toBe(0);
    expect(getPendingPresenceEventCount()).toBe(1);

    // /presence 的结果带来了对应关系：顺便补上
    applyServerPresence({
      serverTime: now,
      link: { connected: true, lastPollAt: now },
      members: [{ accid: 'acc_3', name: '丙', online: true, since: now - 1_000, stale: false }]
    }, new Map([['acc_3', 1003]]));
    expect(getPendingPresenceEventCount()).toBe(0);
    expect(getPresenceState().events[1003]).toEqual([{ ownerId: 1003, time: now - 1_000, kind: 'online' }]);
  });

  test('applyServerEvents 批量导入历史上下线事件、去重、推进游标且不触发未读', function(): void {
    const map: Map<string, number> = new Map([['acc_1', 1001]]);

    const added1: number = applyServerEvents({
      serverTime: 50_000,
      retentionMs: 7 * 86_400_000,
      events: [
        { t: 10_000, accid: 'acc_1', name: '甲', online: true },
        { t: 30_000, accid: 'acc_1', name: '甲', online: false },
        { t: 35_000, accid: 'acc_unknown', name: '未知人', online: true }
      ]
    }, map);

    expect(added1).toBe(2);
    expect(getPendingPresenceEventCount()).toBe(1); // acc_unknown 那条先存着
    expect(getPresenceEventsCursor()).toBe(50_000);
    expect(getPresenceState().events[1001]).toEqual([
      { ownerId: 1001, time: 10_000, kind: 'online' },
      { ownerId: 1001, time: 30_000, kind: 'offline' }
    ]);

    // 重复事件（相同时间戳或短窗口同类）自动忽略，只接纳新事件
    const added2: number = applyServerEvents({
      serverTime: 80_000,
      retentionMs: 7 * 86_400_000,
      events: [
        { t: 30_000, accid: 'acc_1', name: '甲', online: false },
        { t: 32_000, accid: 'acc_1', name: '甲', online: false },
        { t: 70_000, accid: 'acc_1', name: '甲', online: true }
      ]
    }, map);

    expect(added2).toBe(1);
    expect(getPresenceEventsCursor()).toBe(80_000);
    expect(getPresenceState().events[1001]).toHaveLength(3);
    expect(getUnreadState().counts).toEqual({});
    expect(getUnreadState().dividers).toEqual({});
  });

  test('linkServerRoster 通过 serverId 和 account 关联本地 ownerId', function(): void {
    const directory: DirectoryState = {
      members: [
        { id: 161808466, name: '沈馨', serverId: 29266436 },
        { id: 711741, name: '杨宇馨', serverId: 951786, account: '20190415142845_woogr8r27s1clnl' }
      ],
      byId: {
        161808466: { id: 161808466, name: '沈馨', serverId: 29266436 },
        711741: { id: 711741, name: '杨宇馨', serverId: 951786, account: '20190415142845_woogr8r27s1clnl' }
      }
    };
    const mapped: Map<string, number> = linkServerRoster([
      { accid: '20251005123709_wfex8jqicp506rb', name: '沈馨', serverId: 29266436 }
    ], directory, []);

    expect(mapped.get('20251005123709_wfex8jqicp506rb')).toBe(161808466);
    expect(mapped.get('20190415142845_woogr8r27s1clnl')).toBe(711741);
  });
});

describe('presenceApi', function(): void {
  let server: http.Server;
  let config: PresenceClientConfig;
  let roster: Array<{ accid: string; name: string; serverId?: number }>;

  beforeAll(async function(): Promise<void> {
    roster = [{ accid: 'acc_1', name: '沈馨', serverId: 29266436 }];
    server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
      const url: string = req.url ?? '/';

      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, uptime: 120, connected: true, members: roster.length, lastPollAt: 1000 }));

        return;
      }

      if (req.headers.authorization !== 'Bearer test_key') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));

        return;
      }

      if (req.method === 'GET' && url === '/presence') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          serverTime: 2000,
          link: { connected: true, lastPollAt: 1900, node: 'node-1' },
          members: roster.map((m: RosterMember): object => ({ accid: m.accid, name: m.name, online: true, since: 1500, stale: false }))
        }));

        return;
      }

      if (req.method === 'GET' && url.startsWith('/events')) {
        const parsed: URL = new URL(url, 'http://127.0.0.1');
        const since: number = Number(parsed.searchParams.get('since') ?? 0);
        const accid: string | null = parsed.searchParams.get('accid');
        const all: Array<PresenceServerEvent> = [
          { t: 1000, accid: 'acc_1', name: '沈馨', online: true },
          { t: 2000, accid: 'acc_1', name: '沈馨', online: false },
          { t: 2500, accid: 'acc_2', name: '徐佳琳', online: true }
        ].filter((e: PresenceServerEvent): boolean => e.t >= since && (!accid || e.accid === accid));

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ serverTime: 3000, retentionMs: 604_800_000, events: all }));

        return;
      }

      if (req.method === 'GET' && url === '/roster') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ members: roster }));

        return;
      }

      if (req.method === 'POST' && url === '/roster') {
        const chunks: Array<Buffer> = [];

        req.on('data', (c: Buffer): void => {
          chunks.push(c);
        });
        req.on('end', (): void => {
          const body: { accid?: string; name?: string; serverId?: number } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (!body.accid) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'missing accid' }));

            return;
          }

          roster.push({ accid: body.accid, name: body.name ?? '', serverId: body.serverId });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, members: roster }));
        });

        return;
      }

      if (req.method === 'DELETE' && url.startsWith('/roster/')) {
        const accid: string = decodeURIComponent(url.slice('/roster/'.length));

        roster = roster.filter((m: RosterMember): boolean => m.accid !== accid);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, members: roster }));

        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve: () => void): void => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address: { port: number } = server.address() as { port: number };

    config = { baseUrl: `http://127.0.0.1:${ address.port }`, apiKey: 'test_key' };
  });

  afterAll(async function(): Promise<void> {
    await new Promise<void>((resolve: () => void): void => {
      server.close((): void => resolve());
    });
  });

  test('服务地址只允许 https，http 只允许本机', function(): void {
    expect(isAllowedPresenceUrl('https://example.com:8443')).toBe(true);
    expect(isAllowedPresenceUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedPresenceUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedPresenceUrl('http://example.com:8443')).toBe(false);
    expect(isAllowedPresenceUrl('ftp://example.com')).toBe(false);
    expect(isAllowedPresenceUrl('不是地址')).toBe(false);
  });

  test('normalizePin 规范化 SHA-256 指纹', function(): void {
    expect(normalizePin('aa:bb:cc 11:22')).toBe('AABBCC1122');
  });

  test('完整接口联调：/health、/presence、GET/POST/DELETE /roster 及 401 鉴权', async function(): Promise<void> {
    const health: PresenceHealthResponse = await fetchPresenceHealth(config);

    expect(health.ok).toBe(true);
    expect(health.connected).toBe(true);

    const presence: PresenceResponse = await fetchPresence(config);

    expect(presence.members).toHaveLength(1);
    expect(presence.members[0].online).toBe(true);

    const eventsAll: PresenceEventsResponse = await fetchPresenceEvents({ since: 1500, config });

    expect(eventsAll.events).toHaveLength(2);

    const eventsOne: PresenceEventsResponse = await fetchPresenceEvents({ since: 0, accid: 'acc_1', config });

    expect(eventsOne.events.map((e: PresenceServerEvent): number => e.t)).toEqual([1000, 2000]);

    const added: RosterResponse = await addRosterMember({ accid: 'acc_new', name: '新成员', serverId: 12345 }, config);

    expect(added.ok).toBe(true);
    expect(added.members.some((m: RosterMember): boolean => m.accid === 'acc_new')).toBe(true);

    const listed: RosterResponse = await fetchRoster(config);

    expect(listed.members).toHaveLength(2);

    const removed: RosterResponse = await removeRosterMember('acc_new', config);

    expect(removed.ok).toBe(true);
    expect(removed.members).toHaveLength(1);

    await expect(fetchPresence({ ...config, apiKey: 'wrong_key' })).rejects.toThrow(PresenceApiError);
  });
});
