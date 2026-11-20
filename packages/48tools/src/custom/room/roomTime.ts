/**
 * 房间消息的时间怎么显示。
 * 默认按这台电脑的时区；打开「按北京时间显示」后，不管电脑在哪个时区，都显示成北京时间
 * （成员都在国内，人在国外时看北京时间更容易对上她们的作息）。
 */
export interface RoomClock {
  day: string;  // 2026年11月19日 星期四（分隔线上用）
  date: string; // 2026-11-19（判断是不是同一天、跳到某一天时用）
  time: string; // 08:33
  full: string; // 2026-11-19 08:33:12（鼠标放到时间上时显示）
}

const BEIJING_OFFSET: number = 8 * 3_600_000;
const weekdays: Array<string> = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function two(value: number): string {
  return String(value).padStart(2, '0');
}

export function roomClock(ms: number, beijing: boolean): RoomClock {
  // 北京时间：把时间挪 8 小时后按 UTC 读出来，结果和电脑的时区无关
  const d: Date = new Date(beijing ? ms + BEIJING_OFFSET : ms);
  const [year, month, date, weekday, hours, minutes, seconds]: Array<number> = beijing
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const dateText: string = `${ year }-${ two(month) }-${ two(date) }`;

  return {
    day: `${ year }年${ month }月${ date }日 ${ weekdays[weekday] }`,
    date: dateText,
    time: `${ two(hours) }:${ two(minutes) }`,
    full: `${ dateText } ${ two(hours) }:${ two(minutes) }:${ two(seconds) }${ beijing ? '（北京时间）' : '' }`
  };
}

/* 某一天（YYYY-MM-DD）从几点开始算（毫秒）。beijing 的含义同上 */
export function dayStart(dateText: string, beijing: boolean): number {
  const [year, month, date]: Array<number> = dateText.split('-').map(Number);

  return beijing ? Date.UTC(year, month - 1, date) - BEIJING_OFFSET : new Date(year, month - 1, date).getTime();
}
