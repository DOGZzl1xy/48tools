import * as fs from 'node:fs';
import { shell } from 'electron';
import { useState, type ReactElement, type ReactNode, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Checkbox, Dropdown, type MenuProps } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import type { CheckboxChangeEvent } from 'antd/es/checkbox';
import {
  ClockCircleOutlined as IconClockCircleOutlined,
  CloseCircleOutlined as IconCloseCircleOutlined,
  DeleteOutlined as IconDeleteOutlined,
  FolderOpenOutlined as IconFolderOpenOutlined,
  MinusCircleOutlined as IconMinusCircleOutlined,
  PlaySquareOutlined as IconPlaySquareOutlined
} from '@ant-design/icons';
import { formatBytes } from '../download/formatProgress';
import { setQueueOpen } from '../shell/shellStore';
import type { QueueTask } from '../downloadQueue/downloadQueue';
import { shortName } from './highlightTime';
import type { ShowInfo } from './highlightShow';
import type { Show } from './showStore';
import { cancelShow, deleteReplay, removeShow, replayFiles, type ReplayFile } from './pickTask';

/**
 * 切片页面里一场录播的操作（用户 2026-11-23 要的）：左边的列表右键、右上角的「更多」都是这一套。
 * 取消切片：不打算切时用，正在切的会停下来，自动抓取的那一项也跟着结束，不会一直挂着；清单留着，以后还能回来切。
 * 删除完整录播：把本机的录播文件放进回收站；删之前列出是哪些文件。
 */
export interface ShowActions {
  openFolder(show: Show): void;
  showReplay(files: Array<ReplayFile>): void;
  cancel(show: Show): void;
  deleteReplay(show: Show): void;
  remove(show: Show): void;
}

function sizeOf(files: Array<ReplayFile>): string {
  return formatBytes(files.reduce((sum: number, file: ReplayFile): number => sum + file.size, 0));
}

function nameOf(info: ShowInfo): string {
  return info.stage ? info.title : `${ shortName(info.member) }「${ info.title }」`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* 删了以后还能不能再下 */
function deleteNote(info: ShowInfo): string {
  return info.stage
    ? '公演的录像删了不一定能再下载到，以后想补切、重切可能就切不了了。'
    : '以后想补切、重切时会重新下载（口袋48 上还有这场录播的话）。';
}

export function useShowActions(): ShowActions {
  const { message: messageApi, modal: modalApi }: useAppProps = App.useApp();

  return {
    openFolder({ dir }: Show): void {
      fs.existsSync(dir) ? shell.openPath(dir) : messageApi.warning('文件夹不在了');
    },
    showReplay(files: Array<ReplayFile>): void {
      files.length > 0 && shell.showItemInFolder(files[0].path);
    },
    cancel({ dir, info }: Show): void {
      const files: Array<ReplayFile> = replayFiles(dir, info);
      let alsoDelete: boolean = false;

      modalApi.confirm({
        title: `取消切片：${ nameOf(info) }？`,
        content: (
          <div>
            <p className="mt-0 mb-[8px]">正在做的会停下来，做好的切片留着。爆点清单和写好的标题也留着，以后还能回来切。</p>
            {
              files.length > 0 ? (
                <Checkbox onChange={ (event: CheckboxChangeEvent): void => {
                  alsoDelete = event.target.checked;
                } }
                >
                  同时删除本地的完整录播（{ sizeOf(files) }，放进回收站）
                </Checkbox>
              ) : null
            }
          </div>
        ),
        okText: '取消切片',
        cancelText: '返回',
        async onOk(): Promise<void> {
          try {
            await cancelShow(dir, info);
            alsoDelete && await deleteReplay(dir, info);
            messageApi.success(alsoDelete ? '已取消切片，录播放进回收站了' : '已取消切片');
          } catch (err) {
            messageApi.error(reasonOf(err));
          }
        }
      });
    },
    deleteReplay({ dir, info }: Show): void {
      const files: Array<ReplayFile> = replayFiles(dir, info);

      modalApi.confirm({
        title: `删除完整录播：${ nameOf(info) }？`,
        content: (
          <div>
            <ul className="picks-files">
              { files.map((file: ReplayFile): ReactElement => <li key={ file.path } title={ file.path }><span>{ file.name }</span><small>{ formatBytes(file.size) }</small></li>) }
            </ul>
            <p className="mt-[8px] mb-0">放进回收站，切片和爆点清单不动。{ deleteNote(info) }</p>
          </div>
        ),
        okText: '删除录播',
        okButtonProps: { danger: true },
        cancelText: '返回',
        async onOk(): Promise<void> {
          try {
            await deleteReplay(dir, info);
            messageApi.success('录播放进回收站了');
          } catch (err) {
            messageApi.error(reasonOf(err));
          }
        }
      });
    },
    remove({ dir, info }: Show): void {
      modalApi.confirm({
        title: `从列表移除：${ nameOf(info) }？`,
        content: '只移除这一场的爆点清单（改过的文字、写好的标题和亮点也没了，以后不能只改标题），切片和录播都不动。还没切的会先取消。',
        okText: '移除',
        cancelText: '返回',
        async onOk(): Promise<void> {
          try {
            await removeShow(dir, info);
          } catch (err) {
            messageApi.error(reasonOf(err));
          }
        }
      });
    }
  };
}

/* 一场的菜单；cutting：正在切 */
function menuOf(show: Show, cutting: boolean, files: Array<ReplayFile>, actions: ShowActions): MenuProps {
  const { info }: Show = show;

  return {
    items: [
      { key: 'folder', icon: <IconFolderOpenOutlined />, label: '在 Explorer 中显示' },
      { key: 'replay', icon: <IconPlaySquareOutlined />, label: '在 Explorer 中显示录播', disabled: files.length === 0 },
      { type: 'divider' },
      { key: 'cancel', icon: <IconCloseCircleOutlined />, label: '取消切片', disabled: !cutting && info.status === 'done' },
      {
        key: 'delete', icon: <IconDeleteOutlined />, danger: files.length > 0 && !cutting, disabled: files.length === 0 || cutting,
        label: files.length > 0 ? `删除完整录播（${ sizeOf(files) }）` : '删除完整录播（本机没有）'
      },
      { key: 'remove', icon: <IconMinusCircleOutlined />, label: '从列表移除', disabled: cutting }
    ],
    onClick({ key, domEvent }: { key: string; domEvent: { stopPropagation(): void } }): void {
      domEvent.stopPropagation();

      if (key === 'folder') actions.openFolder(show);
      else if (key === 'replay') actions.showReplay(files);
      else if (key === 'cancel') actions.cancel(show);
      else if (key === 'delete') actions.deleteReplay(show);
      else if (key === 'remove') actions.remove(show);
    }
  };
}

/* 一场的菜单：右键（列表里的一行）或者点一下（右上角的「更多」） */
export function ShowMenu(props: {
  readonly show: Show; readonly cutting: boolean; readonly trigger: 'contextMenu' | 'click'; readonly children: ReactNode;
}): ReactElement {
  const { show, cutting, trigger, children }: { show: Show; cutting: boolean; trigger: 'contextMenu' | 'click'; children: ReactNode } = props;
  const [files, setFiles]: [Array<ReplayFile>, D<S<Array<ReplayFile>>>] = useState<Array<ReplayFile>>([]);
  const actions: ShowActions = useShowActions();

  return (
    <Dropdown trigger={ [trigger] }
      placement={ trigger === 'click' ? 'bottomRight' : undefined }
      menu={ menuOf(show, cutting, files, actions) }
      // 打开的时候才去看录播还在不在、多大
      onOpenChange={ (open: boolean): void => {
        open && setFiles(replayFiles(show.dir, show.info));
      } }
    >
      { children }
    </Dropdown>
  );
}

/* 正在找爆点的一项：右键可以取消 */
export function FindingMenu(props: { readonly task: QueueTask; readonly children: ReactNode }): ReactElement {
  const { task, children }: { task: QueueTask; children: ReactNode } = props;

  return (
    <Dropdown trigger={ ['contextMenu'] }
      menu={{
        items: [
          { key: 'queue', icon: <IconClockCircleOutlined />, label: '在下载队列里看' },
          { key: 'stop', icon: <IconCloseCircleOutlined />, label: '取消找爆点', disabled: !task.stop }
        ],
        onClick({ key, domEvent }: { key: string; domEvent: { stopPropagation(): void } }): void {
          domEvent.stopPropagation();
          key === 'stop' ? task.stop?.() : setQueueOpen(true);
        }
      }}
    >
      { children }
    </Dropdown>
  );
}
