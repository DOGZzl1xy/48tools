import { Fragment, useSyncExternalStore, type ReactElement, type ChangeEvent } from 'react';
import { shell } from 'electron';
import { Button, Input, Segmented, Space } from 'antd';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import { showOpenDialog } from '../../utils/remote/dialog';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import Row from '../settings/SettingsRow';
import { highlightDefaults } from './highlightGemini';
import { AUTO_SCORE, AUTO_SCORE_OPTIONS } from './highlightTime';
import AlignerOption from './AlignerOption';
import { agyDefaults } from './highlightAgy';
import { ensureGlossaryFile } from './glossaryFile';
import { onPackChange, pack } from '../sync/packRegistry';
import LearnOption from '../learn/LearnOption';

/**
 * 设置页面里的「录播切片」：用哪个 Gemini 模型、走接口还是本机的 agy、专有词汇、「自动」时多少分以上才推荐、切片保存在哪里、本地打轴模型装不装。
 * API key 和接口地址用「语音转文字」里 Google Gemini 的那一份，不用另外填。
 * 接入点：custom/settings/SettingsPage.tsx。
 */
function HighlightOption(props: {}): ReactElement {
  const overrides: CustomSettings = useSettingOverrides();
  const syncedGlossary: boolean = useSyncExternalStore(onPackChange, (): boolean => pack().config.glossary !== undefined);
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
      <Row label="模型">
        <Input value={ overrides.highlightModel ?? '' }
          placeholder={ highlightDefaults.model }
          spellCheck={ false }
          onChange={ (event: ChangeEvent<HTMLInputElement>): void => setSetting('highlightModel', event.target.value.trim()) }
        />
      </Row>
      <Row label="Gemini 走哪里">
        <Space direction="vertical" size={ 6 } className="w-full">
          <Segmented options={ [{ label: '接口（按量付费）', value: 'api' }, { label: '本机的 agy（订阅额度）', value: 'agy' }] }
            value={ resolveSetting(overrides, 'highlightVia') === 'agy' ? 'agy' : 'api' }
            // 两种都明确存下来：存成「不设置」的话会退回 local/pocket48.json 里的值，那里写了 agy 时就切不回接口
            onChange={ (value: string): void => setSetting('highlightVia', value === 'agy' ? 'agy' : 'api') }
          />
          {
            resolveSetting(overrides, 'highlightVia') === 'agy' ? (
              <Input value={ overrides.highlightAgyModel ?? '' }
                placeholder={ `agy 里的模型名，不填就用 ${ agyDefaults.model }` }
                spellCheck={ false }
                onChange={ (event: ChangeEvent<HTMLInputElement>): void => setSetting('highlightAgyModel', event.target.value.trim()) }
              />
            ) : null
          }
        </Space>
      </Row>
      { /* 数字是之前切过的几场（共约 3 小时）里各个分数以上的爆点数，按每小时算 */ }
      <Row label="「自动」的门槛" hint="找完爆点后默认推荐哪些（切哪些由你挑）。越高推荐得越少，按之前切过的几场，每小时直播大约：8 分 5～6 个，8.5 分 3 个，9 分 1～2 个，9.5 分不到 1 个">
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
      <Row label="专有词汇" hint={ syncedGlossary ? '人名、昵称、圈内叫法。现在用的是同步下来的那一份：改了这个文件，要重新打包发布内容包才生效' : '人名、昵称、圈内叫法' }>
        <Button icon={ <IconFolderOpenOutlined /> } onClick={ (): void => shell.showItemInFolder(ensureGlossaryFile()) }>打开所在位置</Button>
      </Row>
      <LearnOption />
      <AlignerOption />
    </Fragment>
  );
}

export default HighlightOption;
