/**
 * 「守护天使」推理小工具（临时功能，游戏结束后整个 custom/angel 目录和接入点一起删掉）。
 * Team NII 的守护天使游戏：每个人从同一个签筒里抽一个人（不放回，可能抽到自己），游戏期间给抽到的人送惊喜。
 * 这里放名单和时间。名单是 2026-11-19 和用户确认过的；房间地址来自成员名单（roomId.json）和口袋48的搜索。
 * 名单里的人如果后来确认不参加，在 local/angel/clues.json 的 excluded 里写上名字就行，不用改代码（见 ./angelFiles）。
 * 接入点：pages/48/Index.tsx 的 Angel 路由、custom/shell/navConfig.tsx 的「守护天使」、custom/shell/AppShell.tsx 的 startAngelWatcher，
 * 以及主进程打开网页的窗口（packages/main/src/custom/angelWindow.mts、angelChannel.ts，main.mts 里注册）。
 */
export interface AngelMember {
  name: string;
  ownerId: number;
  serverId: number;
  channelId: number;
}

export const ANGEL_MEMBERS: Array<AngelMember> = [
  { name: '胡晓慧', ownerId: 63559, serverId: 1181227, channelId: 1279287 },
  { name: '潘瑛琪', ownerId: 63567, serverId: 1213952, channelId: 1361113 },
  { name: '青钰雯', ownerId: 327581, serverId: 1214147, channelId: 1344944 },
  { name: '金莹玥', ownerId: 538735, serverId: 9405764, channelId: 11749332 },
  { name: '唐程成', ownerId: 113575089, serverId: 8963151, channelId: 11404587 },
  { name: '叶凡', ownerId: 113575101, serverId: 8815699, channelId: 11274137 },
  { name: '李继醇', ownerId: 161808459, serverId: 29234109, channelId: 36410152 },
  { name: '沈馨', ownerId: 161808466, serverId: 29266436, channelId: 36311457 },
  { name: '徐佳琳', ownerId: 161808468, serverId: 29234110, channelId: 36376941 },
  { name: '杨宇馨', ownerId: 711741, serverId: 951786, channelId: 1311988 },
  { name: '柏欣妤', ownerId: 614528, serverId: 1148113, channelId: 1230600 },
  { name: '周湘', ownerId: 711746, serverId: 1181234, channelId: 1164574 },
  { name: '葛俊言', ownerId: 153682082, serverId: 28135965, channelId: 35033643 },
  { name: '黄孟浠', ownerId: 153682083, serverId: 28217844, channelId: 35000666 },
  { name: '朱怡欣', ownerId: 530452, serverId: 1099633, channelId: 1279521 },
  { name: '林佳怡', ownerId: 54526093, serverId: 1213753, channelId: 1279495 },
  { name: '臧文萱', ownerId: 175308892, serverId: 31199534, channelId: 38949312 },
  { name: '杨宝君', ownerId: 175308891, serverId: 31428721, channelId: 39014945 },
  { name: '何绮多', ownerId: 175308883, serverId: 31429051, channelId: 38948965 },
  { name: '秦箐忆', ownerId: 175308889, serverId: 31461450, channelId: 39047472 }
];

/* 默认不参加的人（clues.json 没写 excluded 时用）：在房间里核实过的 */
export const DEFAULT_EXCLUDED: Array<{ name: string; reason: string }> = [
  { name: '青钰雯', reason: '公演名单里没有，11/16 以后房间里没提过守护天使' },
  { name: '金莹玥', reason: '公演名单里没有，11/16 以后房间里没提过守护天使' },
  { name: '柏欣妤', reason: '公演名单里没有，11/16 以后房间里没提过守护天使' },
  { name: '朱怡欣', reason: '11/17 00:46 回粉丝：「巡演不在，守护天使也不参加捏」' }
];

const hour: number = 3_600_000;

/* 都是北京时间 */
export const GAME_START: number = Date.parse('2026-11-16T00:00:00+08:00');
export const GAME_END: number = Date.parse('2026-11-23T00:00:00+08:00');   // 11/22 当天结束
export const BASELINE_START: number = GAME_START - (7 * 24 * hour);          // 游戏前一周：串门次数的对照

/**
 * 推断的时间点（北京时间）：11/17 0 点起每 12 小时一次，到 11/20 12:00；
 * 之后每 6 小时一次（11/20 19:00 起，每天 1 点、7 点、13 点、19 点），最后一次是 11/22 13:00。
 * 程序在这些时间点取新消息重算；历史概率也记在这些时间点上（./angelHistory）。
 */
export const HISTORY_START: number = GAME_START + (24 * hour);                       // 11/17 00:00
export const SIX_HOURLY_FROM: number = Date.parse('2026-11-20T19:00:00+08:00');
export const LAST_UPDATE: number = Date.parse('2026-11-22T13:00:00+08:00');

export const UPDATE_TIMES: Array<number> = ((): Array<number> => {
  const times: Array<number> = [];

  for (let at: number = HISTORY_START; at < SIX_HOURLY_FROM; at += 12 * hour) times.push(at);

  for (let at: number = SIX_HOURLY_FROM; at <= LAST_UPDATE; at += 6 * hour) times.push(at);

  return times;
})();

/* 下一次推断的时间；最后一次过了以后是 undefined */
export function nextUpdateAt(now: number): number | undefined {
  return UPDATE_TIMES.find((at: number): boolean => at > now);
}

/* 最近一次已经到了的推断时间；第一次还没到时是 undefined */
export function lastUpdateAt(now: number): number | undefined {
  return UPDATE_TIMES.findLast((at: number): boolean => at <= now);
}

/* 北京时间的「11/16 15:51」 */
export function bjTime(time: number): string {
  const date: Date = new Date(time + (8 * hour));
  const pad: (n: number) => string = (n: number): string => String(n).padStart(2, '0');

  return `${ date.getUTCMonth() + 1 }/${ date.getUTCDate() } ${ pad(date.getUTCHours()) }:${ pad(date.getUTCMinutes()) }`;
}

/* 北京时间的日期「11/16」 */
export function bjDay(time: number): string {
  return bjTime(time).split(' ')[0];
}

/* 把「11/19 16:40」（北京时间，年份和游戏同一年）变回时间戳；格式不对时是 undefined */
export function parseBjTime(text: string): number | undefined {
  const match: RegExpMatchArray | null = /^\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(text);

  if (!match) return undefined;

  const [, month, day, h, m]: Array<string> = match;
  const year: number = new Date(GAME_START + (8 * hour)).getUTCFullYear();

  return Date.UTC(year, Number(month) - 1, Number(day), Number(h) - 8, Number(m));
}

/* 历史概率的时间点：到 until（含）为止已经到了的推断时间 */
export function historySlots(until: number): Array<number> {
  return UPDATE_TIMES.filter((at: number): boolean => at <= until);
}
