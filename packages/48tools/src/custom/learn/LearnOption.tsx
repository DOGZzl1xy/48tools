import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { shell } from 'electron';
import { Button, Space, Switch, Typography } from 'antd';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import Row from '../settings/SettingsRow';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { showTime } from '../time/appTime';
import { getLearnStatus, onLearnStatus, refreshLearnStatus, LEARN_EVERY_DAYS, type LearnStatus } from './learnTask';
import { ensureLearnDir, learnDir } from './learnStore';
import { learnNow } from './learnRunner';

/**
 * 设置页「录播切片」里的一行：持续学习的开关、现在的状态、马上学一次、打开存记录和背景文档的文件夹。
 * 接入点：highlight/HighlightOption。
 */
export function learnStatusText(status: LearnStatus): string {
  const learned: string = status.state.learnedAt > 0
    ? `上次学习 ${ showTime(status.state.learnedAt, 'MM-DD HH:mm') }${ status.state.summary ? `：${ status.state.summary }` : '' }`
    : '还没学过';

  return [
    `记了 ${ status.records } 场${ status.fresh > 0 ? `（${ status.fresh } 场是上次学习以后的）` : '' }`,
    learned,
    status.state.error ? `上次没学成：${ status.state.error }` : ''
  ].filter(Boolean).join('；');
}

function LearnOption(): ReactElement {
  const overrides: CustomSettings = useSettingOverrides();
  const status: LearnStatus = useSyncExternalStore(onLearnStatus, getLearnStatus);
  const enabled: boolean = resolveSetting(overrides, 'learnAuto') !== false;
  const dir: string | undefined = learnDir();

  useEffect((): void => void refreshLearnStatus(), []);

  return (
    <Row label="持续学习"
      hint={ `每场切片留一份记录（第一轮找到的、你切了哪些、定的标题和看点），每 ${ LEARN_EVERY_DAYS } 天让 Gemini 总结一次，更新背景文档，以后找爆点、起标题时带上` }
    >
      <Space direction="vertical" size={ 4 } align="end">
        <Space>
          <Switch checked={ enabled } onChange={ (checked: boolean): void => setSetting('learnAuto', checked ? undefined : false) } />
          <Button loading={ status.running } disabled={ status.fresh === 0 } onClick={ (): void => void learnNow() }>现在学一次</Button>
          { dir ? <Button icon={ <IconFolderOpenOutlined /> } onClick={ (): void => void shell.openPath(ensureLearnDir() ?? dir) }>打开文件夹</Button> : null }
        </Space>
        <Typography.Text type="secondary">{ learnStatusText(status) }</Typography.Text>
      </Space>
    </Row>
  );
}

export default LearnOption;
