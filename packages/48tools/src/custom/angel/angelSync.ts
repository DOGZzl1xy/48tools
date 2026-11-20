import { requestHomeownerMessage, type HomeMessageResult, type CustomMessageV2 } from '@48tools-api/48';
import { getPocket48Token } from '../../utils/snh48';
import { sleep } from '../common/util';
import { readRoomCache, readRoomCacheBetween, writeRoomCache, firstCachedSince, clearRoomCache, type RoomCacheData } from '../room/roomCache';
import { toItems, type RoomMessageItem } from '../room/roomStore';
import { BASELINE_START, type AngelMember } from './angelConfig';

/**
 * 把参加者房间里「成员发的消息」（房主本人 + 来串门的成员）存进房间消息的本地缓存（../room/roomCache 的 owner 那一路），
 * 和「房间消息」页面用的是同一份：这里取过的，在房间页面打开时直接就有；那边取过的，这里也不用再取。
 * 缓存的规矩和房间页一样：一个房间的消息在时间上必须连续，所以
 *   1. 先从最新的往回取，直到和本地最新的一条接上
 *   2. 本地最早的一条比 BASELINE_START（游戏前一周）还晚时，再从本地记的位置继续往更早取
 * 每批 50 条，批之间歇一下。
 */
const PAGE_GAP: number = 300;
const MAX_PAGES: number = 400;
const READ_LIMIT: number = 50_000;

interface WalkResult {
  messages: Array<CustomMessageV2>;
  nextTime: number;
  hasMore: boolean;
  stopped: boolean; // 停在了想要的位置（或者到头了）；false 是取了 MAX_PAGES 批还没到
}

interface Page {
  messages: Array<CustomMessageV2>;
  nextTime: number;
}

async function requestPage(member: AngelMember, channel: { serverId: number; channelId: number }, nextTime: number): Promise<Page> {
  const res: HomeMessageResult | undefined = await requestHomeownerMessage(channel.channelId, channel.serverId, nextTime);

  if (!res) throw new Error('请先登录口袋48账号');

  if (!res.success && !res.content) throw new Error(`${ member.name }：${ res.message || '获取消息失败' }`);

  return { messages: res.content?.message ?? [], nextTime: res.content?.nextTime ?? 0 };
}

function oldestOf(messages: Array<CustomMessageV2>): number {
  return messages.reduce((min: number, raw: CustomMessageV2): number => Math.min(min, raw.msgTime), Infinity);
}

/* 从 start 往更早一批批取，直到 stop 说够了或者到头 */
async function walkBack(
  member: AngelMember,
  channel: { serverId: number; channelId: number },
  start: number,
  stop: (page: Page) => boolean
): Promise<WalkResult> {
  const messages: Array<CustomMessageV2> = [];
  let nextTime: number = start;

  for (let i: number = 0; i < MAX_PAGES; i++) {
    if (i > 0) await sleep(PAGE_GAP);

    const page: Page = await requestPage(member, channel, nextTime);
    const hasMore: boolean = page.messages.length > 0 && page.nextTime > 0 && page.nextTime !== nextTime;

    messages.push(...page.messages);

    if (!hasMore) return { messages, nextTime: page.nextTime, hasMore: false, stopped: true };

    nextTime = page.nextTime;

    if (stop(page)) return { messages, nextTime, hasMore: true, stopped: true };
  }

  return { messages, nextTime, hasMore: true, stopped: false };
}

function records(messages: Array<CustomMessageV2>): Array<{ key: string; raw: CustomMessageV2 }> {
  return toItems(messages, 'owner').map((item: RoomMessageItem): { key: string; raw: CustomMessageV2 } => ({ key: item.key, raw: item.raw }));
}

/* 更新一个成员的房间缓存，返回这次新取到的条数 */
export async function syncMember(member: AngelMember): Promise<number> {
  if (!getPocket48Token()) throw new Error('请先登录口袋48账号');

  const cache: RoomCacheData = await readRoomCache('owner', member.ownerId, { limit: 1 });
  const channel: { serverId: number; channelId: number } = {
    serverId: cache.meta?.serverId ?? member.serverId,
    channelId: cache.meta?.channelId ?? member.channelId
  };
  const newest: number = cache.meta ? cache.messages[cache.messages.length - 1]?.msgTime ?? 0 : 0;
  let fetched: number = 0;

  // 1. 最新的，往回接上本地的
  const head: WalkResult = await walkBack(member, channel, 0, (page: Page): boolean =>
    (newest > 0 ? oldestOf(page.messages) <= newest : oldestOf(page.messages) < BASELINE_START));

  fetched += head.messages.length;

  if (newest === 0 || !head.stopped) {
    // 本地没有，或者离上次太久接不上：从这次取到的重新开始
    if (newest > 0) await clearRoomCache('owner', member.ownerId);

    await writeRoomCache('owner', {
      ownerId: member.ownerId, ...channel, nextTime: head.nextTime, hasMore: head.hasMore, updatedAt: Date.now()
    }, records(head.messages));
  } else {
    await writeRoomCache('owner', {
      ownerId: member.ownerId,
      ...channel,
      nextTime: cache.meta?.nextTime ?? head.nextTime,
      hasMore: cache.meta?.hasMore ?? head.hasMore,
      updatedAt: Date.now()
    }, records(head.messages));
  }

  // 2. 往更早补到游戏前一周
  const after: RoomCacheData = await readRoomCache('owner', member.ownerId, { limit: 1 });
  const oldest: CustomMessageV2 | undefined = await firstCachedSince('owner', member.ownerId, 0);

  if (after.meta?.hasMore && after.meta.nextTime > 0 && oldest && oldest.msgTime > BASELINE_START) {
    const tail: WalkResult = await walkBack(member, channel, after.meta.nextTime, (page: Page): boolean => oldestOf(page.messages) < BASELINE_START);

    fetched += tail.messages.length;
    await writeRoomCache('owner', {
      ownerId: member.ownerId, ...channel, nextTime: tail.nextTime, hasMore: tail.hasMore, updatedAt: Date.now()
    }, records(tail.messages));
  }

  return fetched;
}

/* 读出缓存里 from 以后的消息（从旧到新） */
export function readMemberMessages(member: AngelMember, from: number = BASELINE_START): Promise<Array<CustomMessageV2>> {
  return readRoomCacheBetween('owner', member.ownerId, from, Infinity, READ_LIMIT);
}
