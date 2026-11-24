import { DatePicker } from 'antd';
import * as dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import dayjsConfig from 'rc-picker/es/generate/dayjs';
import type { GenerateConfig } from 'rc-picker/es/generate';
import { formatInZone, parseInZone } from './timeZone';
import { getTimeZone } from './appTime';

/**
 * 选日期、选时间：「今天」「此刻」和选出来的时间都按设置里的时区，不按这台电脑的时区。
 * 选择器里的 Dayjs 只当成「那个时区的钟面」用：UTC 模式的 Dayjs，上面的年月日时分秒就是钟面上的数字
 * （用电脑时区的 Dayjs 装的话，电脑夏令时跳过去的那一小时装不下）。要毫秒时用 pickedTime 换算，不要直接 valueOf。
 */
dayjs.extend(utc);

const FORMAT: string = 'YYYY-MM-DD HH:mm:ss';

const config: GenerateConfig<Dayjs> = {
  ...dayjsConfig,
  getNow: (): Dayjs => dayjs.utc(formatInZone(Date.now(), getTimeZone(), FORMAT), FORMAT),
  getFixedDate: (text: string): Dayjs => dayjs.utc(text, 'YYYY-M-DD'),
  locale: {
    ...dayjsConfig.locale,
    // 键盘输入的：原来按电脑的时区读。「第几周」的写法这里用不到，交给原来的
    parse(locale: string, text: string, formats: Array<string>): Dayjs | null {
      if (formats.some((format: string): boolean => /wo/i.test(format))) return dayjsConfig.locale.parse(locale, text, formats);

      return formats
        .map((format: string): Dayjs => dayjs.utc(text, format, true))
        .find((date: Dayjs): boolean => date.isValid()) ?? null;
    }
  }
};

/* 选出来的时间是设置里的时区的钟面 → 毫秒 */
export function pickedTime(value: Dayjs): number {
  return parseInZone(value.format(FORMAT), getTimeZone());
}

const ZonedDatePicker: typeof DatePicker = DatePicker.generatePicker<Dayjs>(config) as unknown as typeof DatePicker;

export default ZonedDatePicker;
