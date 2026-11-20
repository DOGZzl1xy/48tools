import * as path from 'node:path';
import type { ReactElement } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router';
import { App, Button, Input, Modal, Segmented, Space, Typography } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import { showOpenDialog } from '../../utils/remote/dialog';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { setQueueOpen } from '../shell/shellStore';
import { useHighlightDialogRecord, closeHighlightDialog } from './highlightDialogStore';
import { startHighlight, type HighlightRecord } from './highlightTask';
import { highlightDefaults } from './highlightGemini';
import type { HighlightCount } from './highlightTypes';

/**
 * 「自动切片」对话框：在录播列表里点一场直播的「自动切片」后打开。选做几个（或者自动）、保存到哪里，
 * 点开始后任务进下载队列（见 ./highlightTask）。
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
  const hasKey: boolean = !!resolveSetting(overrides, 'sttGeminiKey');
  const ownDir: string | undefined = resolveLocalDir(resolveSetting(overrides, 'highlightDir'));
  const downloadDir: string | undefined = resolveLocalDir(resolveSetting(overrides, 'downloadDir'));
  const baseDir: string | undefined = ownDir ?? (downloadDir ? path.join(downloadDir, OUT_FOLDER) : undefined);

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
      okText="开始"
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
            <div>
              <div className="mb-[6px]">做几个切片</div>
              <Segmented options={ countOptions }
                value={ count }
                onChange={ (value: HighlightCount): void => setSetting('highlightCount', value === 'auto' ? undefined : value) }
              />
              <Typography.Text className="block mt-[6px] text-[12px]" type="secondary">
                {
                  count === 'auto'
                    ? '只做爆点分 8 分以上的，平均每 8 分钟最多一个，最多 8 个。'
                    : '按爆点分从高到低做；找到的不够就有几个做几个。'
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
              会先把整场录播下载下来（做完自动删除），再把音频和弹幕内容（不含粉丝昵称）发给 Google Gemini（{ model }）找爆点、写字幕。
              一小时的录播大约要 15 分钟，进度在下载队列里看。
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
