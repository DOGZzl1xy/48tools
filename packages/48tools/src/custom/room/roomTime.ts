import { BEIJING, wallClock, zoneName, type WallClock } from '../time/timeZone';

/**
 * 房间消息的时间怎么显示：按设置里选的时区（默认北京时间，见 custom/time/appTime），和这台电脑的时区无关。
 */
export interface RoomClock {
  day: string;  // 2026年11月19日 星期四（分隔线上用）
  date: string; // 2026-11-19（判断是不是同一天、跳到某一天时用）
  time: string; // 08:33
  full: string; // 2026-11-19 08:33:12（北京时间）（鼠标放到时间上时显示）
}

const weekdays: Array<string> = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function two(value: number): string {
  return String(value).padStart(2, '0');
}

export function roomClock(ms: number, zone: string = BEIJING): RoomClock {
  const clock: WallClock | undefined = wallClock(ms, zone);

  if (!clock) return { day: '', date: '', time: '', full: '' };

  const { year, month, date, weekday, hours, minutes, seconds }: WallClock = clock;
  const dateText: string = `${ year }-${ two(month) }-${ two(date) }`;

  return {
    day: `${ year }年${ month }月${ date }日 ${ weekdays[weekday] }`,
    date: dateText,
    time: `${ two(hours) }:${ two(minutes) }`,
    full: `${ dateText } ${ two(hours) }:${ two(minutes) }:${ two(seconds) }（${ zoneName(zone, ms) }）`
  };
}
