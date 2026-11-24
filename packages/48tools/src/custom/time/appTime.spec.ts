import { getTimeZone, showNow, showSavedTime, showTime, showTimeWithZone } from './appTime';
import { computerZone, formatInZone } from './timeZone';

let mockZone: string | undefined;

jest.mock('../settings/settingsStore', (): object => ({ getSetting: (key: string): string | undefined => (key === 'timeZone' ? mockZone : undefined) }));

const moment: number = Date.UTC(2026, 10, 23, 12, 30, 5);

beforeEach((): void => {
  mockZone = undefined;
});

test('默认是北京时间，接口给的字符串时间戳也认', (): void => {
  expect(getTimeZone()).toBe('Asia/Shanghai');
  expect(showTime(moment)).toBe('2026-11-23 20:30:05');
  expect(showTime(String(moment))).toBe('2026-11-23 20:30:05');
  expect(showTime(moment, 'YYYY-MM-DD~HH.mm.ss')).toBe('2026-11-23~20.30.05');
  expect(showTimeWithZone(moment)).toBe('2026-11-23 20:30:05（北京时间）');
});

test('改了设置马上按新的来', (): void => {
  mockZone = 'America/New_York';
  expect(showTime(moment)).toBe('2026-11-23 07:30:05');
  expect(showTimeWithZone(String(moment))).toBe('2026-11-23 07:30:05（纽约时间）');

  mockZone = 'system';
  expect(getTimeZone()).toBe(computerZone());
  expect(showTime(moment)).toBe(formatInZone(moment, computerZone()));
});

test('现在的时间', (): void => {
  const before: string = formatInZone(Date.now(), 'Asia/Shanghai', 'YYYY-MM-DD HH:mm');
  const now: string = showNow('YYYY-MM-DD HH:mm');
  const after: string = formatInZone(Date.now(), 'Asia/Shanghai', 'YYYY-MM-DD HH:mm');

  expect([before, after]).toContain(now);
});

test('上次登录的时间', (): void => {
  expect(showSavedTime(new Date(moment).toISOString())).toBe('2026-11-23 20:30:05');
  expect(showSavedTime(formatInZone(moment, computerZone()))).toBe('2026-11-23 20:30:05'); // 以前按电脑时区存的
  expect(showSavedTime('很久以前')).toBe('很久以前');
  expect(showSavedTime(undefined)).toBe('');
});
