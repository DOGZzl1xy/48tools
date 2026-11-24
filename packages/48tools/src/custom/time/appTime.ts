import { getSetting, resolveSetting, useSettingOverrides } from '../settings/settingsStore';
import { formatInZone, parseSavedTime, resolveZone, zoneName } from './timeZone';

/**
 * 整个程序的时间都从这里走：按设置里选的时区（默认北京时间，用户 2026-11-23 定的），和这台电脑的时区无关。
 * 界面、导出的文件、下载和录制的文件名都用它；不要再直接 dayjs().format、getHours 之类（那是按电脑的时区）。
 * 切片、公演的日期固定是北京时间，用 ./timeZone 的 beijingDate。
 */

/* 现在用的时区（界面以外的代码用） */
export function getTimeZone(): string {
  return resolveZone(getSetting('timeZone'));
}

/* 现在用的时区（React 里用，改了设置会重新渲染） */
export function useTimeZone(): string {
  return resolveZone(resolveSetting(useSettingOverrides(), 'timeZone'));
}

/**
 * 显示一个时刻
 * @param { number | string } value - 毫秒时间戳（接口给的常常是数字写成的字符串）
 * @param { string } [format] - YYYY、MM、DD、HH、mm、ss
 */
export function showTime(value: number | string, format?: string): string {
  return formatInZone(Number(value), getTimeZone(), format);
}

/* 现在的时间 */
export function showNow(format?: string): string {
  return showTime(Date.now(), format);
}

/* 后面带上是哪里的时间：2026-11-23 20:00:00（北京时间）。写进文件里的用它，换过时区也看得出是哪个 */
export function showTimeWithZone(value: number | string): string {
  return `${ showTime(value) }（${ zoneName(getTimeZone(), Number(value)) }）`;
}

/* 显示存在本机的时间（上次登录的时间）；看不懂时原样显示 */
export function showSavedTime(text: string | undefined): string {
  return text ? (formatInZone(parseSavedTime(text), getTimeZone()) || text) : '';
}
