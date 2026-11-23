/**
 * B 站公演自动录制：什么时候查、录哪些队（和网络无关的部分，方便测试；见 ./gongyanWatcher）。
 *   - 口袋48 的公演直播和 B 站 SNH48 直播间（短号 48）是同时开的，所以看口袋48 的公演列表从「未开始」变成「直播中」就开录
 *   - 公演一般北京时间周末午场 13:30、工作日晚场 18:30、周末晚场 18:30 或 19:30 开始，只在这前后查
 *   - 只录 SNH48 的 SII、NII、HII、X 四个队（2026-11-23 用户定的，之前漏了 SII）
 */
export const BILI_GONGYAN_ROOM: number = 48;                 // B 站 SNH48 直播间（短号，实际房间号用接口换）
export const WANTED_TEAMS: Array<string> = ['SII', 'NII', 'HII', 'X'];
// 北京时间（从 0 点起的分钟）：这些时间段里每分钟查一次有没有开播
export const WATCH_WINDOWS: Array<[number, number]> = [[(13 * 60), (14 * 60) + 30], [18 * 60, (20 * 60) + 15]];
const BEIJING_OFFSET_MINUTES: number = 8 * 60;

export interface ShowInfo {
  liveId: string;
  title: string;      // 《Fire X》2.0公演
  subTitle: string;   // Team X 剧场公演
  status: number;     // 1 未开始，2 直播中
  stime?: string;
}

/* 北京时间的「从 0 点起的分钟」和日期（YYYY-MM-DD） */
export function beijingClock(date: Date): { minutes: number; day: string } {
  const shifted: Date = new Date(date.getTime() + (BEIJING_OFFSET_MINUTES * 60_000));

  return {
    minutes: (shifted.getUTCHours() * 60) + shifted.getUTCMinutes(),
    day: shifted.toISOString().slice(0, 10)
  };
}

export function inWatchWindow(date: Date): boolean {
  const { minutes }: { minutes: number } = beijingClock(date);

  return WATCH_WINDOWS.some(([from, to]: [number, number]): boolean => minutes >= from && minutes <= to);
}

/* 公演是哪个队的：「Team X 剧场公演」「TEAM NII」「SNH48 HII …」；认不出来返回 undefined（NIII 是 GNZ48 的，不算 NII） */
export function teamOfShow(show: Pick<ShowInfo, 'title' | 'subTitle'>): string | undefined {
  const text: string = `${ show.subTitle ?? '' } ${ show.title ?? '' }`;
  const match: RegExpExecArray | null = /(?:^|[^A-Za-z])(?:team\s*)?(SII|NII|HII|X)(?![A-Za-z])/i.exec(text.replace(/Fire\s*X/gi, ''));

  if (!match) return undefined;

  // 只有「Team X」「Team NII」这类写法或者副标题里单独出现的队名才算；标题里的 X 很可能是歌名、活动名
  const team: string = match[1].toUpperCase();

  return /team\s*(SII|NII|HII|X)(?![A-Za-z])/i.test(text) || new RegExp(`(?:^|\\s)${ team }(?:\\s|$)`).test(show.subTitle ?? '') ? team : undefined;
}

/**
 * 公演的名字（写在画面和发布标题里）：去掉前面的队名；「《Fire X》2.0公演」这种书名号（加版本号）后面直接跟「公演」的，
 * 去掉「公演」（画面上会再加上）；「《新芽之契》十三周年庆特别公演」这种后面还有别的字的，「公演」留着，不然读不通
 */
export function showNameOf(title: string): string {
  const name: string = title.replace(/^\s*(?:SNH48\s*)?(?:team\s*)?(?:SII|NII|HII|X)(?:队)?\s*(?=《)/i, '').trim();
  const plain: RegExpExecArray | null = /^(.*》[\d.\s]*?)\s*(?:剧场)?公演$/.exec(name);

  return (plain ? plain[1].trim() : name) || title.trim();
}

/* 现在正在直播、而且是要录的队的公演 */
export function liveWantedShows(list: Array<ShowInfo>): Array<ShowInfo & { team: string }> {
  const out: Array<ShowInfo & { team: string }> = [];

  for (const show of list) {
    const team: string | undefined = teamOfShow(show);

    if (Number(show.status) === 2 && team && WANTED_TEAMS.includes(team)) out.push({ ...show, team });
  }

  return out;
}
