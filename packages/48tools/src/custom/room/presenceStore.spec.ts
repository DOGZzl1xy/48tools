import * as http from 'node:http';
import type { CustomMessageV2 } from '@48tools-api/48';
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
  formatPresenceDuration,
  resetPresenceStoreForTest,
  type ChatTimelineItem,
  type PresenceEvent
} from './presenceStore';
import {
  pushFollowList,
  fetchPresence,
  fetchPresenceEvents,
  fetchPresenceHealth,
  isAllowedPresenceUrl,
  normalizePin,
  PresenceApiError,
  type ListMemberInput,
  type ListSyncResponse,
  type PresenceClientConfig,
  type PresenceEventsResponse,
  type PresenceHealthResponse,
  type PresenceResponse,
  type PresenceServerEvent
} from './presenceApi';
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
    resetUnreadForTest(true);
  });

  test('applyServerPresence：直接用 ownerId 映射，正确处理 online / offline / stale / link断连且不触发未读', function(): void {
    const t0: number = Date.UTC(2026, 10, 24, 12, 0, 0);

    // 1. 首次轮询：1001 离线，1002 stale=true → 不应产生历史刷屏事件
    const p1: PresenceResponse = {
      serverTime: t0 + 10_000,
      link: { connected: true, lastPollAt: t0 + 5_000 },
      members: [
        { ownerId: 1001, accid: 'acc_1', name: '甲', online: false, since: t0, stale: false },
        { ownerId: 1002, accid: 'acc_2', name: '乙', online: false, since: null, stale: true }
      ]
    };

    applyServerPresence(p1);
    expect(getPresenceState().byOwner[1001].status).toBe('offline');
    expect(getPresenceState().byOwner[1002].status).toBe('unknown');
    expect(getPresenceState().events[1001]).toBeUndefined();

    // 2. 1001 上线（offline → online）→ 记录一条上线事件，时间为 since
    const t1: number = t0 + 60_000;

    applyServerPresence({
      serverTime: t1 + 15_000,
      link: { connected: true, lastPollAt: t1 + 10_000 },
      members: [
        { ownerId: 1001, accid: 'acc_1', name: '甲', online: true, since: t1, stale: false },
        { ownerId: 1002, accid: 'acc_2', name: '乙', online: false, since: t1, stale: false }
      ]
    });
    expect(getPresenceState().byOwner[1001].status).toBe('online');
    expect(getPresenceState().events[1001]).toEqual([{ ownerId: 1001, time: t1, kind: 'online' }]);
    expect(getPresenceState().byOwner[1002].status).toBe('offline');
    expect(getPresenceState().events[1002]).toBeUndefined();

    // 3. 服务端链路断开（link.connected=false）→ 全部标为 unknown，不写入虚假下线
    applyServerPresence({
      serverTime: t1 + 90_000,
      link: { connected: false, lastPollAt: t1 + 10_000 },
      members: [
        { ownerId: 1001, accid: 'acc_1', name: '甲', online: false, since: t1, stale: true }
      ]
    });
    expect(getPresenceState().service.connected).toBe(false);
    expect(getPresenceState().byOwner[1001].status).toBe('unknown');
    expect(getPresenceState().byOwner[1002].status).toBe('unknown');
    expect(getPresenceState().events[1001]).toHaveLength(1);

    // 4. 恢复连接后 1001 依然在线 → 不重复记录；随后真正下线 → 记录一条下线事件
    const t2: number = t1 + 180_000;

    applyServerPresence({
      serverTime: t1 + 120_000,
      link: { connected: true, lastPollAt: t1 + 120_000 },
      members: [{ ownerId: 1001, accid: 'acc_1', name: '甲', online: true, since: t1, stale: false }]
    });
    expect(getPresenceState().events[1001]).toHaveLength(1);

    applyServerPresence({
      serverTime: t2 + 5_000,
      link: { connected: true, lastPollAt: t2 + 5_000 },
      members: [{ ownerId: 1001, accid: 'acc_1', name: '甲', online: false, since: t2, stale: false }]
    });
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

  test('applyServerEvents 直接按 ownerId 批量导入历史事件、按最大 t 推进游标且去重', function(): void {
    const added1: number = applyServerEvents({
      serverTime: 50_000,
      retentionMs: 7 * 86_400_000,
      events: [
        { t: 10_000, ownerId: 1001, accid: 'acc_1', name: '甲', online: true },
        { t: 30_000, ownerId: 1001, accid: 'acc_1', name: '甲', online: false }
      ]
    }, 'user_a');

    expect(added1).toBe(2);
    expect(getPresenceEventsCursor('user_a')).toBe(30_000);
    expect(getPresenceState().events[1001]).toEqual([
      { ownerId: 1001, time: 10_000, kind: 'online' },
      { ownerId: 1001, time: 30_000, kind: 'offline' }
    ]);

    // 重复事件忽略，只接纳新事件并推进到新最大 t
    const added2: number = applyServerEvents({
      serverTime: 80_000,
      retentionMs: 7 * 86_400_000,
      events: [
        { t: 30_000, ownerId: 1001, accid: 'acc_1', name: '甲', online: false },
        { t: 32_000, ownerId: 1001, accid: 'acc_1', name: '甲', online: false },
        { t: 70_000, ownerId: 1001, accid: 'acc_1', name: '甲', online: true }
      ]
    }, 'user_a');

    expect(added2).toBe(1);
    expect(getPresenceEventsCursor('user_a')).toBe(70_000);
    expect(getPresenceState().events[1001]).toHaveLength(3);
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

  test('presenceLabel 与 formatPresenceDuration 区分在线 / 离线 / 未知', function(): void {
    const since: number = Date.UTC(2026, 10, 24, 12, 30, 0); // 北京时间 20:30
    const serverTime: number = since + (16 * 60_000);

    expect(formatPresenceDuration(20_000)).toBe('不到 1 分钟');
    expect(formatPresenceDuration(16 * 60_000)).toBe('16 分钟');
    expect(formatPresenceDuration(90 * 60_000)).toBe('1 小时 30 分钟');

    expect(presenceLabel(undefined, 'Asia/Shanghai', { configured: true, connected: false })).toBe('状态未知 · 服务未连接');
    expect(presenceLabel({ status: 'unknown', online: false, stale: true, updatedAt: serverTime }, 'Asia/Shanghai', { configured: true, connected: true }))
      .toBe('状态未知');
    expect(presenceLabel({ status: 'online', online: true, stale: false, since, serverTime, updatedAt: serverTime }, 'Asia/Shanghai'))
      .toBe('在线 · 已在线 16 分钟（20:30 上线）');
    expect(presenceLabel({ status: 'offline', online: false, stale: false, since, serverTime, updatedAt: serverTime }, 'Asia/Shanghai'))
      .toBe('离线 · 20:30 下线');
  });
});

describe('presenceApi', function(): void {
  let server: http.Server;
  let config: PresenceClientConfig;
  let lists: Record<string, Array<ListMemberInput>>;

  beforeAll(async function(): Promise<void> {
    lists = {};
    server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
      const url: string = req.url ?? '/';
      const parsed: URL = new URL(url, 'http://127.0.0.1');

      if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(
          req.headers.authorization === 'Bearer test_key'
            ? { ok: true, uptime: 120, connected: true, union: 1, users: Object.keys(lists).length }
            : { ok: true }
        ));

        return;
      }

      if (req.headers.authorization !== 'Bearer test_key') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));

        return;
      }

      if (req.method === 'POST' && parsed.pathname === '/list') {
        const chunks: Array<Buffer> = [];

        req.on('data', (c: Buffer): void => {
          chunks.push(c);
        });
        req.on('end', (): void => {
          const body: { userId?: string; members?: Array<ListMemberInput> } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (!body.userId || !Array.isArray(body.members)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid body' }));

            return;
          }

          lists[body.userId] = body.members;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            userId: body.userId,
            unionSize: body.members.length,
            tracked: body.members.map((m: ListMemberInput): object => ({ ...m, accid: `acc_${ m.ownerId }` })),
            pending: []
          }));
        });

        return;
      }

      if (req.method === 'GET' && parsed.pathname === '/presence') {
        const userId: string = parsed.searchParams.get('userId') ?? '';
        const list: Array<ListMemberInput> = lists[userId] ?? [];

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          serverTime: 2000,
          link: { connected: true, lastPollAt: 1900, node: 'node-1' },
          members: list.map((m: ListMemberInput): object => ({
            ownerId: m.ownerId,
            accid: `acc_${ m.ownerId }`,
            name: m.name,
            serverId: m.serverId,
            online: true,
            since: 1500,
            stale: false
          }))
        }));

        return;
      }

      if (req.method === 'GET' && parsed.pathname === '/events') {
        const since: number = Number(parsed.searchParams.get('since') ?? 0);
        const userId: string | null = parsed.searchParams.get('userId');
        const all: Array<PresenceServerEvent> = [
          { t: 1000, ownerId: 187367578, accid: 'acc_187367578', name: '任亿宸', online: true },
          { t: 2000, ownerId: 187367578, accid: 'acc_187367578', name: '任亿宸', online: false }
        ].filter((e: PresenceServerEvent): boolean => e.t >= since && Boolean(userId));

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ serverTime: 3000, retentionMs: 604_800_000, events: all }));

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

  test('isAllowedPresenceUrl 只允许 https 或本机 http', function(): void {
    expect(isAllowedPresenceUrl('https://example.com:8443')).toBe(true);
    expect(isAllowedPresenceUrl('http://example.com:8443')).toBe(false);
    expect(isAllowedPresenceUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedPresenceUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedPresenceUrl('not-a-url')).toBe(false);
  });

  test('normalizePin 规范化 SHA-256 指纹', function(): void {
    expect(normalizePin('aa:bb:cc 11:22')).toBe('AABBCC1122');
  });

  test('完整多用户接口联调：POST /list、GET /presence?userId=、GET /events?since=&userId=、/health 及 401 鉴权', async function(): Promise<void> {
    const pubHealth: PresenceHealthResponse = await fetchPresenceHealth(config);
    const authHealth: PresenceHealthResponse = await fetchPresenceHealth(config, { auth: true });

    expect(pubHealth).toEqual({ ok: true });
    expect(authHealth.connected).toBe(true);

    const pushed: ListSyncResponse = await pushFollowList('user_acc_1', [
      { ownerId: 187367578, name: '任亿宸', serverId: 33575670 }
    ], config);

    expect(pushed.ok).toBe(true);
    expect(pushed.userId).toBe('user_acc_1');
    expect(pushed.tracked).toHaveLength(1);

    const presence: PresenceResponse = await fetchPresence({ userId: 'user_acc_1', config });

    expect(presence.members).toHaveLength(1);
    expect(presence.members[0].ownerId).toBe(187367578);
    expect(presence.members[0].online).toBe(true);

    const events: PresenceEventsResponse = await fetchPresenceEvents({ since: 1500, userId: 'user_acc_1', config });

    expect(events.events).toHaveLength(1);
    expect(events.events[0].ownerId).toBe(187367578);

    await expect(fetchPresence({ userId: 'user_acc_1', config: { ...config, apiKey: 'wrong_key' } }))
      .rejects.toThrow(PresenceApiError);
  });
});
