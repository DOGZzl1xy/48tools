import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BEIJING, SYSTEM_ZONE, ZONE_CHOICES, beijingDate, computerZone, dayStart, formatInZone, fromWallClock, offsetText, parseInZone, parseSavedTime,
  resolveZone, wallClock, zoneName, type ZoneChoice
} from './timeZone';

const NEW_YORK: string = 'America/New_York';
const moment: number = Date.UTC(2026, 10, 23, 12, 30, 5); // 北京时间 2026-11-23 20:30:05，纽约 07:30:05

describe('时区换算', (): void => {
  test('同一个时刻在各个时区怎么写，和电脑的时区无关', (): void => {
    expect(formatInZone(moment, BEIJING)).toBe('2026-11-23 20:30:05');
    expect(formatInZone(moment, NEW_YORK)).toBe('2026-11-23 07:30:05');
    expect(formatInZone(moment, 'UTC')).toBe('2026-11-23 12:30:05');
    expect(formatInZone(moment, 'Asia/Kolkata')).toBe('2026-11-23 18:00:05');
    expect(formatInZone(moment, BEIJING, 'YYYY-MM-DD~HH.mm.ss')).toBe('2026-11-23~20.30.05');
    // 零点写成 00 点，不是 24 点；日期跟着变
    expect(formatInZone(Date.UTC(2026, 10, 23, 16, 0, 0), BEIJING)).toBe('2026-11-24 00:00:00');
    expect(wallClock(Date.UTC(2026, 10, 23, 16, 0, 0), BEIJING)?.weekday).toBe(2);
  });

  test('时间不对时是空的', (): void => {
    expect(formatInZone(Number.NaN, BEIJING)).toBe('');
    expect(formatInZone(Infinity, BEIJING)).toBe('');
    expect(wallClock(1e20, BEIJING)).toBeUndefined();
  });

  test('夏令时', (): void => {
    expect(formatInZone(Date.UTC(2026, 6, 1, 12, 0, 0), NEW_YORK)).toBe('2026-07-01 08:00:00');
    expect(offsetText(Date.UTC(2026, 6, 1), NEW_YORK)).toBe('UTC-4');
    expect(offsetText(moment, NEW_YORK)).toBe('UTC-5');
    // 2026-03-08 02:30 在纽约不存在（2 点跳到 3 点）：往后顺延
    expect(formatInZone(fromWallClock(NEW_YORK, 2026, 3, 8, 2, 30), NEW_YORK)).toBe('2026-03-08 03:30:00');
    // 前后的时间照常
    expect(formatInZone(fromWallClock(NEW_YORK, 2026, 3, 8, 1, 59, 59), NEW_YORK)).toBe('2026-03-08 01:59:59');
    expect(formatInZone(fromWallClock(NEW_YORK, 2026, 3, 8, 3, 0), NEW_YORK)).toBe('2026-03-08 03:00:00');
    expect(formatInZone(fromWallClock(NEW_YORK, 2026, 11, 1, 1, 30), NEW_YORK)).toBe('2026-11-01 01:30:00'); // 重复的一小时
  });

  test('每个可选的时区都能来回换算', (): void => {
    for (const { value } of ZONE_CHOICES) {
      for (const ms of [moment, Date.UTC(2026, 6, 1, 3, 4, 5), Date.UTC(2026, 11, 31, 23, 59, 59)]) {
        expect(`${ value } ${ parseInZone(formatInZone(ms, value), value) }`).toBe(`${ value } ${ ms }`);
      }
    }

    expect(new Set(ZONE_CHOICES.map((item: ZoneChoice): string => item.value)).size).toBe(ZONE_CHOICES.length);
  });

  test('某一天从几点开始算', (): void => {
    expect(dayStart('2026-11-20', BEIJING)).toBe(Date.UTC(2026, 10, 19, 16, 0, 0));
    expect(dayStart('2026-11-20', NEW_YORK)).toBe(Date.UTC(2026, 10, 20, 5, 0, 0));
    expect(formatInZone(dayStart('2026-11-20', BEIJING) - 1, BEIJING)).toBe('2026-11-19 23:59:59');
  });

  test('看不懂的文字', (): void => {
    expect(parseInZone('昨天', BEIJING)).toBeNaN();
    expect(parseInZone('2026-11-23', BEIJING)).toBe(Date.UTC(2026, 10, 22, 16));
  });
});

describe('设置里的时区', (): void => {
  test('没选过是北京时间，认不出来的也按北京时间', (): void => {
    expect(resolveZone(undefined)).toBe(BEIJING);
    expect(resolveZone('')).toBe(BEIJING);
    expect(resolveZone('Mars/Olympus')).toBe(BEIJING);
    expect(resolveZone(NEW_YORK)).toBe(NEW_YORK);
    expect(resolveZone(SYSTEM_ZONE)).toBe(computerZone());
  });

  test('说明文字', (): void => {
    expect(zoneName(BEIJING)).toBe('北京时间');
    expect(zoneName(NEW_YORK)).toBe('纽约时间');
    expect(zoneName('Asia/Kathmandu', moment)).toBe('UTC+5:45');
    expect(offsetText(moment, BEIJING)).toBe('UTC+8');
    expect(offsetText(moment, 'America/St_Johns')).toBe('UTC-3:30');
    expect(offsetText(moment, 'UTC')).toBe('UTC');
  });
});

test('上次登录的时间：现在存 ISO，以前存的是电脑时区的时间', (): void => {
  expect(parseSavedTime(new Date(moment).toISOString())).toBe(moment);
  expect(formatInZone(parseSavedTime('2026-11-23 07:30:05', NEW_YORK), BEIJING)).toBe('2026-11-23 20:30:05');
  expect(parseSavedTime('不知道')).toBeNaN();
});

test('beijingDate：切片、公演、音频信息里的日期固定按北京时间；时间不对时是空的', (): void => {
  // 北京时间 2026-11-22 上午 10 点的直播：电脑在美国东部时是 11-21 晚上，日期也要写 11-22
  expect(beijingDate(Date.UTC(2026, 10, 22, 2, 0, 0))).toBe('2026-11-22');
  expect(beijingDate(Date.UTC(2026, 10, 21, 15, 59, 59))).toBe('2026-11-21'); // 北京时间 23:59:59
  expect(beijingDate(Date.UTC(2026, 10, 21, 16, 0, 0))).toBe('2026-11-22');   // 北京时间 0 点
  expect(beijingDate(Number('abc'))).toBe('');
  expect(beijingDate(0)).toBe('');
});

/**
 * 以后加功能时别又混进按电脑时区的时间：显示、写进文件的时间都要走 ./appTime 或 ./timeZone。
 * 允许的：微博访客的日期（接口给的就是「20261123」，只换写法）、登录时间存成 ISO、设置选择器里当钟面用的 Dayjs。
 */
test('界面代码里没有直接按电脑时区写时间的', (): void => {
  const src: string = path.join(__dirname, '../..');
  const local: RegExp = /\bdayjs\(|\.get(Hours|Minutes|Seconds|Date|Day|Month|FullYear)\(|toLocale(Date|Time)?String\(|toDateString\(|toTimeString\(/;
  const allowed: RegExp = /^\s*(\*|\/\/|\/\*)|dayjs\([\w.]+, 'YYYYMMDD'\)\.format\('YYYY-MM-DD'\)/;
  const found: Array<string> = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file: string = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'sdk' && entry.name !== 'node_modules') walk(file);
      } else if (/\.tsx?$/.test(entry.name) && !/\.spec\.ts$|devImages\.ts$/.test(entry.name)) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line: string, index: number): void => {
          if (local.test(line) && !allowed.test(line)) found.push(`${ path.relative(src, file) }:${ index + 1 } ${ line.trim().slice(0, 100) }`);
        });
      }
    }
  }

  walk(src);
  expect(found).toEqual([]);
});
