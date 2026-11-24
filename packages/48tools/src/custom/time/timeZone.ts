/**
 * 时区换算：毫秒时间戳 ↔ 某个时区的年月日时分秒。结果和这台电脑的时区无关，不读设置（读设置的在 ./appTime）。
 * 时区用 IANA 的名字（Asia/Shanghai），夏令时由 Intl 处理。
 */
export const BEIJING: string = 'Asia/Shanghai';
export const SYSTEM_ZONE: string = 'system'; // 设置里选「跟随这台电脑」时存的值

export interface WallClock {
  year: number;
  month: number; // 1～12
  date: number;
  hours: number;
  minutes: number;
  seconds: number;
  weekday: number; // 0 是星期日
}

export interface ZoneChoice {
  value: string;
  label: string; // 设置里显示的
  name: string;  // 时间后面的说明：北京时间
}

/* 设置里可以选的时区（「跟随这台电脑」另外加在前面） */
export const ZONE_CHOICES: Array<ZoneChoice> = [
  { value: BEIJING, label: '北京', name: '北京时间' },
  { value: 'Asia/Hong_Kong', label: '香港', name: '香港时间' },
  { value: 'Asia/Taipei', label: '台北', name: '台北时间' },
  { value: 'Asia/Singapore', label: '新加坡', name: '新加坡时间' },
  { value: 'Asia/Tokyo', label: '东京', name: '东京时间' },
  { value: 'Asia/Seoul', label: '首尔', name: '首尔时间' },
  { value: 'Asia/Bangkok', label: '曼谷', name: '曼谷时间' },
  { value: 'Asia/Kolkata', label: '新德里', name: '新德里时间' },
  { value: 'Asia/Dubai', label: '迪拜', name: '迪拜时间' },
  { value: 'Europe/Moscow', label: '莫斯科', name: '莫斯科时间' },
  { value: 'Europe/Berlin', label: '柏林', name: '柏林时间' },
  { value: 'Europe/Paris', label: '巴黎', name: '巴黎时间' },
  { value: 'Europe/London', label: '伦敦', name: '伦敦时间' },
  { value: 'America/New_York', label: '纽约（美国东部）', name: '纽约时间' },
  { value: 'America/Toronto', label: '多伦多', name: '多伦多时间' },
  { value: 'America/Chicago', label: '芝加哥（美国中部）', name: '芝加哥时间' },
  { value: 'America/Denver', label: '丹佛（美国山地）', name: '丹佛时间' },
  { value: 'America/Los_Angeles', label: '洛杉矶（美国西部）', name: '洛杉矶时间' },
  { value: 'America/Vancouver', label: '温哥华', name: '温哥华时间' },
  { value: 'Pacific/Honolulu', label: '檀香山', name: '檀香山时间' },
  { value: 'America/Sao_Paulo', label: '圣保罗', name: '圣保罗时间' },
  { value: 'Australia/Sydney', label: '悉尼', name: '悉尼时间' },
  { value: 'Pacific/Auckland', label: '奥克兰', name: '奥克兰时间' },
  { value: 'UTC', label: '世界标准时间（UTC）', name: 'UTC' }
];

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters: Map<string, Intl.DateTimeFormat> = new Map();

function formatterOf(zone: string): Intl.DateTimeFormat {
  let formatter: Intl.DateTimeFormat | undefined = formatters.get(zone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short'
    });
    formatters.set(zone, formatter);
  }

  return formatter;
}

/* 这台电脑的时区 */
export function computerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || BEIJING;
}

/* 设置里存的值 → 时区的名字：没选过是北京时间，认不出来的也按北京时间 */
export function resolveZone(saved: string | undefined): string {
  if (!saved) return BEIJING;

  if (saved === SYSTEM_ZONE) return computerZone();

  try {
    formatterOf(saved);

    return saved;
  } catch {
    return BEIJING;
  }
}

/* 这个时刻在这个时区是几点；时间不对时返回 undefined */
export function wallClock(ms: number, zone: string): WallClock | undefined {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined;

  const parts: Record<string, string> = {};

  for (const part of formatterOf(zone).formatToParts(ms)) parts[part.type] = part.value;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    date: Number(parts.day),
    hours: Number(parts.hour),
    minutes: Number(parts.minute),
    seconds: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday]
  };
}

/* 这个时刻这个时区比 UTC 快多少毫秒 */
export function zoneOffset(ms: number, zone: string): number {
  const clock: WallClock | undefined = wallClock(ms, zone);

  if (!clock) return 0;

  return Date.UTC(clock.year, clock.month - 1, clock.date, clock.hours, clock.minutes, clock.seconds) - (Math.floor(ms / 1_000) * 1_000);
}

/* 某个时区的年月日时分秒 → 毫秒（夏令时跳过去的那一小时不存在，往后顺延） */
export function fromWallClock(zone: string, year: number, month: number, date: number, hours: number = 0, minutes: number = 0, seconds: number = 0): number {
  const asUtc: number = Date.UTC(year, month - 1, date, hours, minutes, seconds);
  const first: number = asUtc - zoneOffset(asUtc, zone);
  const second: number = asUtc - zoneOffset(first, zone);

  // 换算回去对得上的那个；都对不上（跳过去的那一小时）用晚的
  const right: number | undefined = [first, second].find((ms: number): boolean => ms + zoneOffset(ms, zone) === asUtc);

  return right ?? Math.max(first, second);
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/* 按格式写出来：YYYY、MM、DD、HH、mm、ss 换成数字，别的原样留着；时间不对时返回空字符串 */
export function formatInZone(ms: number, zone: string, format: string = 'YYYY-MM-DD HH:mm:ss'): string {
  const clock: WallClock | undefined = wallClock(ms, zone);

  if (!clock) return '';

  const values: Record<string, string> = {
    YYYY: String(clock.year).padStart(4, '0'),
    MM: two(clock.month),
    DD: two(clock.date),
    HH: two(clock.hours),
    mm: two(clock.minutes),
    ss: two(clock.seconds)
  };

  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token: string): string => values[token]);
}

/**
 * 北京时间的日期 YYYY-MM-DD；时间不对时返回空字符串。
 * 切片、公演、音频信息里写的日期都用它，不跟着设置里的时区变：这些日期写在画面、发布标题和文件夹名上，
 * 观众在国内；文件夹名还用来认出是不是同一场（换了时区不能变成另一个文件夹）
 */
export function beijingDate(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? formatInZone(ms, BEIJING, 'YYYY-MM-DD') : '';
}

/* 某一天（YYYY-MM-DD）从几点开始算（毫秒） */
export function dayStart(dateText: string, zone: string): number {
  const [year, month, date]: Array<number> = dateText.split('-').map(Number);

  return fromWallClock(zone, year, month, date);
}

/* 'YYYY-MM-DD HH:mm:ss' 是这个时区的时间 → 毫秒；看不懂时返回 NaN */
export function parseInZone(text: string, zone: string): number {
  const match: RegExpExecArray | null = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());

  if (!match) return Number.NaN;

  const [year, month, date, hours, minutes, seconds]: Array<number> = match.slice(1).map((item: string | undefined): number => Number(item ?? 0));

  return fromWallClock(zone, year, month, date, hours, minutes, seconds);
}

/**
 * 存在本机的时间（上次登录的时间）→ 毫秒：现在存的是 ISO 时间；
 * 以前存的是「2026-11-23 10:00:00」，是当时按这台电脑的时区写的
 */
export function parseSavedTime(text: string, zone: string = computerZone()): number {
  const old: number = parseInZone(text, zone);

  return Number.isNaN(old) ? Date.parse(text) : old;
}

/* UTC+8、UTC-3:30、UTC */
export function offsetText(ms: number, zone: string): string {
  const minutes: number = Math.round(zoneOffset(ms, zone) / 60_000);

  if (minutes === 0) return 'UTC';

  const abs: number = Math.abs(minutes);
  const rest: number = abs % 60;

  return `UTC${ minutes > 0 ? '+' : '-' }${ Math.floor(abs / 60) }${ rest > 0 ? `:${ two(rest) }` : '' }`;
}

/* 时间后面的说明：北京时间、纽约时间；不在名单里的时区写 UTC+5:30 */
export function zoneName(zone: string, ms: number = Date.now()): string {
  return ZONE_CHOICES.find((item: ZoneChoice): boolean => item.value === zone)?.name ?? offsetText(ms, zone);
}
