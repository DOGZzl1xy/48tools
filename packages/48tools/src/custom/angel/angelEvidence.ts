import { GAME_START, GAME_END, BASELINE_START, bjTime, bjDay } from './angelConfig';
import type { AngelMessage } from './angelText';
import type { PairClue, Cite } from './angelModel';

/**
 * 从房间消息里自动找的线索（规则，权重都比较小；真正有分量的线索靠人读，见 ./angelFiles 的 clues.json）：
 *   1. 串门：游戏期间 A 去 B 的房间留言明显比游戏前一周多
 *   2. 时间对得上：A 说「给我守护的人点了吃的」之后 2 小时内，B 说「收到天使的东西」（A 和 B 不是同一个人）
 *   3. 自称抽到自己：很多人在开玩笑，但确实有人抽到了自己，给一点点权重
 * 另外整理出每个人每天第一条、最后一条消息的时间（上下线），和几类关键发言，给页面展示、给人读。
 */
export interface RoomMessages {
  name: string;
  ownerId: number;
  messages: Array<AngelMessage>; // 这个房间里成员发的消息（房主 + 来串门的成员），从旧到新
}

export type MomentKind = 'receipt' | 'act' | 'waiting' | 'self' | 'mention';

export interface Moment {
  kind: MomentKind;
  speaker: string;  // 谁说的
  room: string;     // 在谁的房间
  message: AngelMessage;
}

export interface VisitStat {
  visitor: string;
  host: string;
  game: number;     // 游戏期间留言条数
  baseline: number; // 游戏前一周留言条数
  last: Array<AngelMessage>;
}

export interface DayActivity {
  day: string;    // 「11/16」
  first: number;
  last: number;
  count: number;
}

export interface Evidence {
  clues: Array<PairClue>;
  moments: Array<Moment>;
  visits: Array<VisitStat>;
  activity: Record<string, Array<DayActivity>>;
}

const hour: number = 3_600_000;
const TIMING_WINDOW: number = 2 * hour;

const ANGEL_WORD: RegExp = /天使|守护|小主人/;
const FAN_GROUP: RegExp = /守护甜心|守护甜馨/g; // 粉丝团的名字，和游戏无关
const FAN_GIFT: RegExp = /天使\s*\d+\s*[号好]|天使们|各位天使/;
const SELF_ANGEL: RegExp = /我(就|才|也|真)?是(我)?自己的(守护)?(小)?天使|守护(的是)?(我)?自己|我守护我自己|抽到(了)?(我)?自己/;
const BEING_ANGEL: RegExp = /我(当|是|做|也是)(别人的)?(守护)?(小)?天使|我(要|在)?守护|给我守护|我守护的|给(我的)?(守护)?(小)?天使(买|点|送)/;
const WISH: RegExp = /能不能|可不可以|可以.{0,6}吗|希望|如果|想要|要是|看到就|快(来|去)|列一份|你在(看|听)|是不是|猜猜/;
const RECEIPT: RegExp = new RegExp([
  '(天使|守护)[^，。！？,.!?]{0,8}(点|送|买)(了|的|啥|什么|吃|喝|外卖)',
  '(天使|守护)[^，。！？,.!?]{0,8}(投喂|送来|准备了|发力了)',
  '(天使|守护)的[^，。！？,.!?]{0,6}(到了|来了)',
  '(收到|收获|被)[^，。！？,.!?]{0,8}(天使|守护)',
  '(谢谢|感谢|蟹蟹|大爱)[^，。！？,.!?]{0,6}(天使|守护)'
].join('|'));
const ACT_WHO: RegExp = /我守护的|我要守护的|给我守护的|守护的(那个)?人|我的小主人|给小主人/;
const ACT_DO: RegExp = /点|买|送|准备|吃|外卖|投喂|下单|礼物/;
const WAITING: RegExp = /(我的|俺的)(守护)?(小)?天使.{0,6}(呢|在吗|在哪|安静|毫无动静|没动静|冬眠|是否存在|不在)|没人守护我|天使.{0,3}发力呀/;

export function momentKind(raw: string): MomentKind | undefined {
  const text: string = raw.replace(FAN_GROUP, '');

  if (!text || !ANGEL_WORD.test(text) || FAN_GIFT.test(text)) return undefined;

  if (SELF_ANGEL.test(text)) return 'self';

  if (ACT_WHO.test(text) && ACT_DO.test(text)) return 'act';

  if (WISH.test(text)) return 'mention';

  if (WAITING.test(text)) return 'waiting';

  if (RECEIPT.test(text) && !BEING_ANGEL.test(text)) return 'receipt';

  return 'mention';
}

function cite(room: string, message: AngelMessage): Cite {
  return { room, time: bjTime(message.time), text: message.text };
}

export function buildEvidence(rooms: Array<RoomMessages>, participants: Array<string>, now: number): Evidence {
  const nameById: Map<number, string> = new Map(rooms.map((room: RoomMessages): [number, string] => [room.ownerId, room.name]));
  const joined: Set<string> = new Set(participants);
  const gameEnd: number = Math.min(now, GAME_END);
  const moments: Array<Moment> = [];
  const visits: Array<VisitStat> = [];
  const activity: Record<string, Array<DayActivity>> = {};
  const clues: Array<PairClue> = [];

  for (const room of rooms) {
    const days: Map<string, DayActivity> = new Map();
    const byVisitor: Map<string, VisitStat> = new Map();

    for (const message of room.messages) {
      const speaker: string | undefined = nameById.get(message.senderId);

      if (!speaker || message.time < BASELINE_START || message.time >= gameEnd) continue;

      const inGame: boolean = message.time >= GAME_START;

      if (speaker === room.name) {
        if (inGame) {
          const day: string = bjDay(message.time);
          const item: DayActivity = days.get(day) ?? { day, first: message.time, last: message.time, count: 0 };

          item.first = Math.min(item.first, message.time);
          item.last = Math.max(item.last, message.time);
          item.count += 1;
          days.set(day, item);
        }
      } else if (joined.has(speaker) && joined.has(room.name)) {
        const stat: VisitStat = byVisitor.get(speaker) ?? { visitor: speaker, host: room.name, game: 0, baseline: 0, last: [] };

        if (inGame) {
          stat.game += 1;
          stat.last = [...stat.last, message].slice(-3);
        } else {
          stat.baseline += 1;
        }

        byVisitor.set(speaker, stat);
      }

      const kind: MomentKind | undefined = inGame && joined.has(speaker) ? momentKind(message.own) : undefined;

      if (kind) moments.push({ kind, speaker, room: room.name, message });
    }

    activity[room.name] = [...days.values()];
    visits.push(...byVisitor.values());
  }

  // 1. 串门
  const gameDays: number = Math.max(1, (gameEnd - GAME_START) / (24 * hour));

  for (const stat of visits) {
    const excess: number = stat.game - ((stat.baseline / 7) * gameDays);

    if (stat.game < 2 || excess < 1.5) continue;

    clues.push({
      id: `visit:${ stat.visitor }:${ stat.host }`,
      source: 'rule',
      angels: [stat.visitor],
      targets: [stat.host],
      weight: Math.min(0.8, 0.2 * excess),
      title: '串门变多',
      reason: `游戏期间 ${ stat.visitor } 去 ${ stat.host } 的房间留言 ${ stat.game } 次，游戏前一周 ${ stat.baseline } 次`,
      cites: stat.last.map((message: AngelMessage): Cite => cite(stat.host, message))
    });
  }

  // 2. 「给守护的人点了吃的」和「收到天使的东西」时间对得上
  const acts: Array<Moment> = moments.filter((moment: Moment): boolean => moment.kind === 'act');
  const receipts: Array<Moment> = moments.filter((moment: Moment): boolean => moment.kind === 'receipt' && moment.room === moment.speaker);
  const timing: Map<string, PairClue> = new Map();

  for (const act of acts) {
    for (const receipt of receipts) {
      const gap: number = receipt.message.time - act.message.time;

      if (act.speaker === receipt.speaker || gap <= 0 || gap > TIMING_WINDOW) continue;

      const id: string = `timing:${ act.speaker }:${ receipt.speaker }`;
      const existing: PairClue | undefined = timing.get(id);
      const cites: Array<Cite> = [cite(act.room, act.message), cite(receipt.room, receipt.message)];

      if (existing) {
        existing.weight = Math.min(0.8, existing.weight + 0.4);
        existing.cites = [...existing.cites, ...cites].slice(-6);
      } else {
        timing.set(id, {
          id,
          source: 'rule',
          angels: [act.speaker],
          targets: [receipt.speaker],
          weight: 0.4,
          title: '时间对得上',
          reason: `${ act.speaker } 说给守护的人准备了东西，${ Math.round(gap / 60_000) } 分钟后 ${ receipt.speaker } 说收到了天使的东西`,
          cites
        });
      }
    }
  }

  clues.push(...timing.values());

  // 3. 自称抽到自己
  const selfSaid: Set<string> = new Set();

  for (const moment of moments) {
    if (moment.kind !== 'self' || moment.room !== moment.speaker || selfSaid.has(moment.speaker)) continue;

    selfSaid.add(moment.speaker);
    clues.push({
      id: `self:${ moment.speaker }`,
      source: 'rule',
      angels: [moment.speaker],
      targets: [moment.speaker],
      weight: 0.3,
      title: '自称抽到自己',
      reason: `${ moment.speaker }说自己是自己的天使；抽签时确实有人抽到了自己`,
      cites: [cite(moment.room, moment.message)]
    });
  }

  return { clues, moments, visits, activity };
}
