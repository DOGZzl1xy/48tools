import { Fragment, type ReactElement, type ChangeEvent } from 'react';
import { Button, Input, Segmented, Space } from 'antd';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import { showOpenDialog } from '../../utils/remote/dialog';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import Row from '../settings/SettingsRow';
import { highlightDefaults } from './highlightGemini';
import { AUTO_SCORE, AUTO_SCORE_OPTIONS } from './highlightTime';
import AlignerOption from './AlignerOption';

/**
 * 设置页面里的「录播切片」：用哪个 Gemini 模型、「自动」时多少分以上才做、切片保存在哪里、本地打轴模型装不装。
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
      <Row label="「自动」的门槛"
        hint={ '做几个切片选「自动」时，只做爆点分不低于它的片段（满分 10 分，模型打的）。调高了做得少、更精；调低了做得多。'
          + `默认 ${ AUTO_SCORE } 分：一场一个半小时的直播大约做 5、6 个，9 分大约 2 个。` }
      >
        <Segmented options={ AUTO_SCORE_OPTIONS.map((score: number): { label: string; value: number } => ({ label: `${ score } 分`, value: score })) }
          value={ resolveSetting(overrides, 'highlightAutoScore') ?? AUTO_SCORE }
          onChange={ (value: number): void => setSetting('highlightAutoScore', value === AUTO_SCORE ? undefined : value) }
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
      <AlignerOption />
    </Fragment>
  );
}

export default HighlightOption;
