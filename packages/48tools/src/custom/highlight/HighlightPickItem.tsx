import { clipboard, shell } from 'electron';
import { useEffect, useRef, useState, type ReactElement, type RefObject, type ChangeEvent, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Button, Dropdown, Input, Switch, Tag, Typography, type MenuProps } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  CopyOutlined as IconCopyOutlined,
  FolderOpenOutlined as IconFolderOpenOutlined,
  PlayCircleOutlined as IconPlayCircleOutlined,
  ScissorOutlined as IconScissorOutlined,
  StopOutlined as IconStopOutlined,
  UndoOutlined as IconUndoOutlined
} from '@ant-design/icons';
import { clock } from './highlightTime';
import type { ShowItem } from './highlightShow';
import type { StageKind } from './highlightTypes';

/**
 * 切片页面（./HighlightsPage）里的一个爆点：切不切的开关，标题和说明直接点进去改（停一会儿、离开输入框时自动存），
 * 做好的切片显示编号和发布用的标题。右键有菜单：切不切、在 Explorer 中显示做好的切片、播放、复制标题、恢复原来的文字。
 */
const kindText: Record<StageKind, string> = { mc: 'MC', song: '唱歌', mistake: '失误' };
const SAVE_DELAY: number = 800;

export const TITLE_MAX: number = 40;
export const REASON_MAX: number = 400;

/* 2 分 24 秒 */
export function lengthText(seconds: number): string {
  const total: number = Math.round(seconds);
  const minute: number = Math.floor(total / 60);

  return minute > 0 ? `${ minute } 分${ total % 60 > 0 ? ` ${ total % 60 } 秒` : '' }` : `${ total } 秒`;
}

interface DraftField {
  value: string;
  onChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void;
  onBlur(): void;
}

/* 一边打字一边存：打字时显示打的字，停一会儿或者离开输入框时存；清空了就回到原来的 */
function useDraft(saved: string, save: (text: string) => Promise<unknown>): DraftField {
  const [draft, setDraft]: [string | undefined, D<S<string | undefined>>] = useState<string | undefined>(undefined);
  const timer: RefObject<ReturnType<typeof setTimeout> | undefined> = useRef(undefined);
  const pending: RefObject<(() => void) | undefined> = useRef(undefined); // 还没存的；切到别的场次时也要存上

  async function commit(text: string, done: boolean): Promise<void> {
    clearTimeout(timer.current);
    pending.current = undefined;

    if (text.trim() !== '' && text.trim() !== saved) await save(text);

    // 存好了才换回去，不会闪一下旧的字；还在打字的不动
    done && setDraft((now: string | undefined): string | undefined => (now === text ? undefined : now));
  }

  useEffect((): (() => void) => (): void => {
    clearTimeout(timer.current);
    pending.current?.();
  }, []);

  return {
    value: draft ?? saved,
    onChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void {
      const text: string = event.target.value;

      setDraft(text);
      clearTimeout(timer.current);
      pending.current = (): void => void commit(text, false);
      timer.current = setTimeout((): void => void commit(text, false), SAVE_DELAY);
    },
    onBlur(): void {
      draft !== undefined && void commit(draft, true);
    }
  };
}

interface HighlightPickItemProps {
  readonly item: ShowItem;
  readonly locked: boolean; // 正在切，不能改
  clipFile(): string | undefined; // 做好的切片在哪里；不在了是 undefined
  onCut(cut: boolean): void;
  onEdit(patch: { title?: string; reason?: string }): Promise<unknown>;
}

function HighlightPickItem(props: HighlightPickItemProps): ReactElement {
  const { item, locked, clipFile, onCut, onEdit }: HighlightPickItemProps = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const title: DraftField = useDraft(item.title, (text: string): Promise<unknown> => onEdit({ title: text }));
  const reason: DraftField = useDraft(item.reason, (text: string): Promise<unknown> => onEdit({ reason: text }));

  function cutLabel(): string {
    if (item.clip) return item.cut ? '不重切' : '重切';

    return item.cut ? '不切' : '切片';
  }

  /* 做好的切片的文件；不在了（搬走、删了）就说一声 */
  function withClip(open: (file: string) => unknown): void {
    const file: string | undefined = clipFile();

    file ? open(file) : messageApi.warning('这个切片的文件不在了（可能搬走或者删了）');
  }

  function handleMenuClick({ key, domEvent }: { key: string; domEvent: { stopPropagation(): void } }): void {
    domEvent.stopPropagation();

    if (key === 'cut') {
      onCut(!item.cut);
    } else if (key === 'folder') {
      withClip((file: string): void => shell.showItemInFolder(file));
    } else if (key === 'play') {
      withClip((file: string): Promise<string> => shell.openPath(file));
    } else if (key === 'copy') {
      clipboard.writeText(item.clip?.postTitle ?? item.title);
      messageApi.success('标题复制好了');
    } else if (key === 'restore') {
      onEdit({ ...item.original });
    }
  }

  const menu: MenuProps = {
    items: [
      { key: 'cut', icon: item.cut ? <IconStopOutlined /> : <IconScissorOutlined />, label: cutLabel(), disabled: locked },
      { key: 'restore', icon: <IconUndoOutlined />, label: '恢复原来的标题和说明', disabled: locked || !item.original },
      { type: 'divider' },
      { key: 'folder', icon: <IconFolderOpenOutlined />, label: '在 Explorer 中显示', disabled: !item.clip },
      { key: 'play', icon: <IconPlayCircleOutlined />, label: '播放切片', disabled: !item.clip },
      { key: 'copy', icon: <IconCopyOutlined />, label: item.clip ? '复制发布用的标题' : '复制标题' }
    ],
    onClick: handleMenuClick
  };

  return (
    <Dropdown trigger={ ['contextMenu'] } menu={ menu }>
      <article className={ `picks-item${ item.cut ? ' is-cut' : '' }` }>
        <Switch className="picks-switch"
          aria-label={ `${ item.clip ? '重切' : '切片' }：${ item.title }` }
          checked={ item.cut }
          checkedChildren={ item.clip ? '重切' : '切片' }
          unCheckedChildren={ item.clip ? '已切' : '不切' }
          disabled={ locked }
          onChange={ onCut }
        />
        <div className="picks-item-main">
          <div className="picks-item-head">
            <Input className="picks-edit picks-title"
              variant="borderless"
              aria-label="标题"
              value={ title.value }
              maxLength={ TITLE_MAX }
              spellCheck={ false }
              disabled={ locked }
              onChange={ title.onChange }
              onBlur={ title.onBlur }
              onPressEnter={ (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.blur() }
            />
            <div className="picks-tags">
              { item.kind ? <Tag className="mr-0">{ kindText[item.kind] }</Tag> : null }
              { item.recommended ? <Tag className="mr-0" color="processing">推荐</Tag> : null }
              <span className="picks-meta">{ item.score } 分</span>
              <span className="picks-meta">{ clock(item.start) } ~ { clock(item.end) }</span>
              <span className="picks-meta">{ lengthText(item.end - item.start) }</span>
            </div>
          </div>
          <Input.TextArea className="picks-edit picks-reason"
            variant="borderless"
            aria-label="说明"
            value={ reason.value }
            maxLength={ REASON_MAX }
            rows={ 1 }
            spellCheck={ false }
            disabled={ locked }
            onChange={ reason.onChange }
            onBlur={ reason.onBlur }
          />
          {
            item.clip ? (
              <div className="picks-note">
                <Tag className="mr-0 picks-made">已切 { String(item.clip.index).padStart(2, '0') }</Tag>
                <Typography.Text className="picks-post" type="secondary" copyable={{ text: item.clip.postTitle, tooltips: ['复制发布用的标题', '复制好了'] }}>
                  { item.clip.postTitle }
                </Typography.Text>
              </div>
            ) : null
          }
          {
            item.original ? (
              <div className="picks-note">
                <span>{ item.clip && !item.cut ? '改过了，打开「重切」才会用上' : '改过了，会按改过的切' }</span>
                <Button type="link" size="small" disabled={ locked } onClick={ (): Promise<unknown> => onEdit({ ...item.original }) }>恢复原来的</Button>
              </div>
            ) : null
          }
          { item.problem ? <div className="picks-note"><Typography.Text type="danger">没做成：{ item.problem }</Typography.Text></div> : null }
        </div>
      </article>
    </Dropdown>
  );
}

export default HighlightPickItem;
