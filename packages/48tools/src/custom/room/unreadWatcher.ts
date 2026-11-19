import {
  requestServerJump,
  requestHomeownerMessage,
  type ServerJumpResult,
  type HomeMessageResult,
  type CustomMessageV2
} from '@48tools-api/48';
import { getPocket48Token } from '../../utils/snh48';
import { getRoomState, syncNewest, toItems, type RoomMember, type RoomData, type RoomMessageItem } from './roomStore';
import { noteMessages, getViewing, getSeen, getChannel, setChannel, handleWindowFocus } from './unreadStore';

/**
 * 在后台定时检查关注的成员有没有发新消息，结果交给 ./unreadStore 算未读数。
 * 程序开着就一直检查，不需要停在「房间消息」页面：
 *   - 正在看的房间不用管，页面自己每分钟会取一次
 *   - 这次运行里打开过的房间：直接把新消息补进去（顺便存进本地缓存），点进去时已经是最新的
 *   - 没打开过的房间：只取最新的一两批（每批 50 条）来数未读，不写缓存
 * 每个关注的成员每 2 分钟发 1 个请求，成员之间隔一小会儿，不会一下子发出一大堆。
 * 接入点：custom/shell/AppShell.tsx 启动时调用 startUnreadWatcher。
 */
const CHECK_INTERVAL: number = 120_000;
const FIRST_CHECK_DELAY: number = 4_000;
const GAP_BETWEEN_MEMBERS: number = 400;
const PROBE_PAGES: number = 2;     // 没打开过的房间最多看几批
const UNREAD_AT_LEAST: number = 100; // 看完这几批还没接上「看到哪了」，就显示成 99+

let started: boolean = false;
let checking: boolean = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): unknown => setTimeout(resolve, ms));
}

/* 没打开过的房间：取最新的一两批，数一数有多少条比「看到哪了」新 */
async function probe(member: RoomMember): Promise<void> {
  const room: RoomData | undefined = getRoomState().rooms[member.ownerId];
  let channel: { serverId: number; channelId: number } | undefined = room?.serverId && room.channelId
    ? { serverId: room.serverId, channelId: room.channelId }
    : getChannel(member.ownerId);

  if (!channel) {
    const res: ServerJumpResult | undefined = await requestServerJump(member.ownerId);

    if (!res?.content?.serverId || !res.content.channelId) return;

    channel = { serverId: res.content.serverId, channelId: res.content.channelId };
    setChannel(member.ownerId, channel.serverId, channel.channelId);
  }

  const seen: number | undefined = getSeen(member.ownerId);
  const times: Array<number> = [];
  let nextTime: number = 0;
  let connected: boolean = false;

  for (let i: number = 0; i < PROBE_PAGES; i++) {
    const res: HomeMessageResult | undefined = await requestHomeownerMessage(channel.channelId, channel.serverId, nextTime);

    if (!res?.content) return;

    const messages: Array<CustomMessageV2> = res.content.message ?? [];
    const oldest: number = messages.reduce((min: number, raw: CustomMessageV2): number => Math.min(min, raw.msgTime), Infinity);

    // 和房间里显示的一样：只数成员发的、会显示出来的消息
    times.push(...toItems(messages).map((item: RoomMessageItem): number => item.raw.msgTime));

    if (seen === undefined || messages.length === 0 || oldest <= seen || !res.content.nextTime || res.content.nextTime === nextTime) {
      connected = true;
      break;
    }

    nextTime = res.content.nextTime;
  }

  noteMessages(member.ownerId, times, connected ? 0 : UNREAD_AT_LEAST);
}

async function checkMember(member: RoomMember): Promise<void> {
  if (getViewing() === member.ownerId) return;

  if (getRoomState().rooms[member.ownerId]?.opened) {
    await syncNewest(member);
  } else {
    await probe(member);
  }
}

/* 把关注的成员挨个检查一遍 */
export async function checkFollowedRooms(): Promise<void> {
  if (checking || !getPocket48Token()) return;

  checking = true;

  try {
    for (const member of getRoomState().follows) {
      try {
        await checkMember(member);
      } catch (err) {
        console.error('检查房间新消息失败', member.name, err); // 网络不通时不打扰用户，下一轮再试
      }

      await sleep(GAP_BETWEEN_MEMBERS);
    }
  } finally {
    checking = false;
  }
}

export function startUnreadWatcher(): void {
  if (started) return;

  started = true;
  window.addEventListener('focus', handleWindowFocus);
  window.setTimeout(checkFollowedRooms, FIRST_CHECK_DELAY);
  window.setInterval(checkFollowedRooms, CHECK_INTERVAL);
}
