import * as path from 'node:path';
import type { ReactElement } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router';
import { Alert, App, Button, Input, Modal, Segmented, Space, Typography } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import { showOpenDialog } from '../../utils/remote/dialog';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { setQueueOpen } from '../shell/shellStore';
import { useHighlightDialogRecord, closeHighlightDialog } from './highlightDialogStore';
import { startHighlight, highlightJobOf, type HighlightRecord } from './highlightTask';
import { readShowInfoSync, type ShowInfo } from './highlightShow';
import { selectShow } from './showStore';
import { highlightDefaults } from './highlightGemini';
import { AUTO_SCORE } from './highlightTime';
import { agyDefaults } from './highlightAgy';
import type { HighlightCount } from './highlightTypes';

/**
 * 「自动切片」对话框：在录播列表里点一场直播的「自动切片」后打开。选默认推荐几个（或者自动）、保存到哪里，
 * 点开始后任务进下载队列（见 ./highlightTask）：先找爆点，找完在切片页面（./HighlightsPage）挑好、定好标题再切。
 * 这场以前找过的可以直接去挑，也可以重新找一遍。
 * 由 custom/shell/AppShell 渲染一次；用 ./highlightDialogStore 的 openHighlightDialog 打开。
 */
const countOptions: Array<{ label: string; value: HighlightCount }> = [
  { label: '自动', value: 'auto' },
  { label: '1 个', value: 1 },
  { label: '2 个', value: 2 },
  { label: '3 个', value: 3 },
  { label: '5 个', value: 5 },
  { label: '8 个', value: 8 }
];

const OUT_FOLDER: string = '录播切片';

function HighlightDialog(props: {}): ReactElement {
  const record: HighlightRecord | null = useHighlightDialogRecord();
  const overrides: CustomSettings = useSettingOverrides();
  const { message: messageApi }: useAppProps = App.useApp();
  const navigate: NavigateFunction = useNavigate();
  const count: HighlightCount = resolveSetting(overrides, 'highlightCount') ?? 'auto';
  const model: string = resolveSetting(overrides, 'highlightModel') || highlightDefaults.model;
  const viaAgy: boolean = resolveSetting(overrides, 'highlightVia') === 'agy';
  const hasKey: boolean = viaAgy || !!resolveSetting(overrides, 'sttGeminiKey'); // 走本机的 agy 时不需要 key
  const ownDir: string | undefined = resolveLocalDir(resolveSetting(overrides, 'highlightDir'));
  const downloadDir: string | undefined = resolveLocalDir(resolveSetting(overrides, 'downloadDir'));
  const baseDir: string | undefined = ownDir ?? (downloadDir ? path.join(downloadDir, OUT_FOLDER) : undefined);

  // 这场以前找过爆点：它的切片文件夹和清单
  const oldDir: string | undefined = record && baseDir ? highlightJobOf(record, count, baseDir).outDir : undefined;
  const old: ShowInfo | undefined = oldDir ? readShowInfoSync(oldDir) : undefined;

  function handleShowClick(): void {
    closeHighlightDialog();
    selectShow(oldDir);
    navigate('/48/Highlights');
  }

  async function handleChooseDirClick(): Promise<void> {
    const result: { canceled: boolean; filePaths?: Array<string> } = await showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: ownDir ?? downloadDir
    });

    if (result.canceled || !result.filePaths?.length) return;

    setSetting('highlightDir', result.filePaths[0]);
  }

  function handleSettingsClick(): void {
    closeHighlightDialog();
    navigate('/Settings');
  }

  function handleStartClick(): void {
    if (!record) return;

    const problem: string | undefined = startHighlight(record, count);

    if (problem) {
      messageApi.warning(problem);

      return;
    }

    closeHighlightDialog();
    setQueueOpen(true);
  }

  return (
    <Modal title="自动切片"
      open={ record !== null }
      width={ 560 }
      okText={ old ? '重新找一遍' : '开始找爆点' }
      cancelText="取消"
      okButtonProps={{ disabled: !hasKey || !baseDir }}
      destroyOnHidden={ true }
      onOk={ handleStartClick }
      onCancel={ closeHighlightDialog }
    >
      {
        record ? (
          <Space className="w-full" direction="vertical" size={ 16 }>
            <Typography.Text strong={ true }>{ record.userInfo.nickname } { record.title }</Typography.Text>
            {
              old ? (
                <Alert type="info"
                  showIcon={ true }
                  message={ `这场找过爆点了（${ old.items.length } 个）。重新找一遍会换掉清单、改过的文字和写好的标题，做好的切片不动。` }
                  action={ <Button size="small" type="primary" onClick={ handleShowClick }>去挑爆点</Button> }
                />
              ) : null
            }
            <div>
              <div className="mb-[6px]">默认推荐切几个</div>
              <Segmented options={ countOptions }
                value={ count }
                onChange={ (value: HighlightCount): void => setSetting('highlightCount', value === 'auto' ? undefined : value) }
              />
              <Typography.Text className="block mt-[6px] text-[12px]" type="secondary">
                {
                  count === 'auto'
                    ? `推荐爆点分 ${ resolveSetting(overrides, 'highlightAutoScore') ?? AUTO_SCORE } 分以上的（门槛在设置页「录播切片」里改），最多 8 个。`
                    : '按爆点分从高到低推荐；找到的不够就有几个推荐几个。'
                }
              </Typography.Text>
            </div>
            <div>
              <div className="mb-[6px]">保存到</div>
              <Space.Compact className="w-full">
                <Input readOnly={ true } value={ baseDir ?? '' } placeholder="还没有设置，点右边选一个文件夹" />
                <Button icon={ <IconFolderOpenOutlined /> } onClick={ handleChooseDirClick }>选择</Button>
              </Space.Compact>
              <Typography.Text className="block mt-[6px] text-[12px]" type="secondary">
                每场录播一个文件夹，里面是成片（mp4）、封面（jpg）和写着标题、简介的说明（txt）。
              </Typography.Text>
            </div>
            <Typography.Text className="block text-[12px]" type="secondary">
              会先把整场录播下载下来（切完自动删除），再把音频和弹幕内容（不含粉丝昵称）{ viaAgy ? `通过本机的 agy 交给 Gemini（${ resolveSetting(overrides, 'highlightAgyModel') || agyDefaults.model }，用订阅额度）` : `发给 Google Gemini（${ model }，按量付费）` }找爆点。找完停下来，你在「切片」页面挑好要切哪些；Gemini 写好字幕、标题和亮点再停一次，你定好了才渲染。
              进度在下载队列和录播列表里看。可以连着加几场：前一场开始找爆点时，后一场就开始下载。
            </Typography.Text>
            {
              hasKey ? null : (
                <Typography.Text type="danger">
                  还没有填写 Gemini 的 API key。
                  <Button type="link" size="small" onClick={ handleSettingsClick }>去设置</Button>
                </Typography.Text>
              )
            }
          </Space>
        ) : null
      }
    </Modal>
  );
}

export default HighlightDialog;
