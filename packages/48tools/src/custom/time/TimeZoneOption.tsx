import { useEffect, useMemo, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Select } from 'antd';
import Row from '../settings/SettingsRow';
import { resolveSetting, setSetting, useSettingOverrides } from '../settings/settingsStore';
import { BEIJING, SYSTEM_ZONE, ZONE_CHOICES, computerZone, formatInZone, offsetText, resolveZone, zoneName, type ZoneChoice } from './timeZone';

/**
 * 设置页面里的「时区」：整个程序的时间按哪个时区（默认北京时间）。
 * 接入点：custom/settings/SettingsPage.tsx。
 */
interface ZoneOption {
  value: string;
  label: string;
  offset: string;
  search: string; // 能搜到的字：名字、UTC+8、IANA 的名字
}

function zoneOptions(now: number): Array<ZoneOption> {
  const own: string = computerZone();

  function option(value: string, label: string, zone: string): ZoneOption {
    const offset: string = offsetText(now, zone);

    return { value, label, offset, search: `${ label } ${ offset } ${ zone }`.toLowerCase() };
  }

  const choices: Array<ZoneOption> = ZONE_CHOICES.map((item: ZoneChoice): ZoneOption => (
    option(item.value, item.value === BEIJING ? '北京（默认）' : item.label, item.value)));

  // 北京排第一，然后是这台电脑的
  choices.splice(1, 0, option(SYSTEM_ZONE, `跟随这台电脑（${ zoneName(own, now) }）`, own));

  return choices;
}

function TimeZoneOption(props: {}): ReactElement {
  const saved: string | undefined = resolveSetting(useSettingOverrides(), 'timeZone');
  const zone: string = resolveZone(saved);
  const options: Array<ZoneOption> = useMemo((): Array<ZoneOption> => zoneOptions(Date.now()), []);
  const [now, setNow]: [number, D<S<number>>] = useState((): number => Date.now());

  // 下面的「现在是」每秒走一下
  useEffect(function(): () => void {
    const timer: number = window.setInterval((): void => setNow(Date.now()), 1_000);

    return (): void => window.clearInterval(timer);
  }, []);

  return (
    <Row label="时区" hint="界面上的时间、导出的文件、新下载和录制的文件名都按它。切片和公演的日期固定用北京时间。">
      <Select className="w-full"
        showSearch={ true }
        value={ saved === SYSTEM_ZONE ? SYSTEM_ZONE : zone }
        options={ options }
        filterOption={ (input: string, option?: ZoneOption): boolean => (option?.search ?? '').includes(input.trim().toLowerCase()) }
        optionRender={ ({ data }: { data: ZoneOption }): ReactElement => (
          <span className="settings-zone"><span>{ data.label }</span><small>{ data.offset }</small></span>
        ) }
        aria-label="时区"
        // 选北京也明确存下来：存成「不设置」的话会退回 local/pocket48.json 里的值
        onChange={ (value: string): void => setSetting('timeZone', value) }
      />
      <small className="settings-note">
        现在是 { formatInZone(now, zone) }（{ zoneName(zone, now) }，{ offsetText(now, zone) }）
      </small>
    </Row>
  );
}

export default TimeZoneOption;
