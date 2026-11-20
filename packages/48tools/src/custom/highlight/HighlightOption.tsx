import { Fragment, type ReactElement, type ChangeEvent } from 'react';
import { Button, Input, Space } from 'antd';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import { showOpenDialog } from '../../utils/remote/dialog';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import Row from '../settings/SettingsRow';
import { highlightDefaults } from './highlightGemini';

/**
 * 设置页面里的「录播切片」：用哪个 Gemini 模型、切片保存在哪里。
 * API key 和接口地址用「语音转文字」里 Google Gemini 的那一份，不用另外填。
 * 接入点：custom/settings/SettingsPage.tsx。
 */
function HighlightOption(props: {}): ReactElement {
  const overrides: CustomSettings = useSettingOverrides();
  const dir: string = resolveSetting(overrides, 'highlightDir') ?? '';
  const invalid: boolean = dir !== '' && resolveLocalDir(dir) === undefined;

  async function handleChooseClick(): Promise<void> {
    const result: { canceled: boolean; filePaths?: Array<string> } = await showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveLocalDir(dir) ?? resolveLocalDir(resolveSetting(overrides, 'downloadDir'))
    });

    if (result.canceled || !result.filePaths?.length) return;

    setSetting('highlightDir', result.filePaths[0]);
  }

  return (
    <Fragment>
      <Row label="模型"
        hint={ '在「录播下载」里点一场直播的「更多 → 自动切片」，程序会让 Gemini 听录播、找爆点、写字幕，再剪成带弹幕的横屏短视频。'
          + `API key 用上面「语音转文字」里 Google Gemini 的那一个。不填就用 ${ highlightDefaults.model }。` }
      >
        <Input value={ overrides.highlightModel ?? '' }
          placeholder={ highlightDefaults.model }
          spellCheck={ false }
          onChange={ (event: ChangeEvent<HTMLInputElement>): void => setSetting('highlightModel', event.target.value.trim()) }
        />
      </Row>
      <Row label="切片保存文件夹" hint="不设置时保存在「默认保存文件夹」下面的「录播切片」里。每场录播一个文件夹。">
        <Space.Compact className="w-full">
          <Input readOnly={ true }
            value={ dir }
            placeholder="没有设置（默认保存文件夹 / 录播切片）"
            status={ invalid ? 'error' : undefined }
          />
          <Button icon={ <IconFolderOpenOutlined /> } onClick={ handleChooseClick }>选择</Button>
          { overrides.highlightDir ? <Button onClick={ (): void => setSetting('highlightDir', undefined) }>恢复默认</Button> : null }
        </Space.Compact>
      </Row>
    </Fragment>
  );
}

export default HighlightOption;
