import { clipboard, shell } from 'electron';
import { useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Button, Dropdown, Input, Switch, Tag, Typography, type MenuProps } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  CopyOutlined as IconCopyOutlined,
  EditOutlined as IconEditOutlined,
  FolderOpenOutlined as IconFolderOpenOutlined,
  PlayCircleOutlined as IconPlayCircleOutlined,
  ScissorOutlined as IconScissorOutlined,
  StopOutlined as IconStopOutlined,
  UndoOutlined as IconUndoOutlined
} from '@ant-design/icons';
import { clock } from './highlightTime';
import { basisOf } from './highlightDraft';
import { isRestyled, readyToRender, type ShowInfo, type ShowItem } from './highlightShow';
import { useDraftField, type DraftField } from './useDraftField';
import DraftPanel, { TITLE_MAX } from './DraftPanel';
import type { ClipDraft, StageKind } from './highlightTypes';

/**
 * 切片页面（./HighlightsPage）里的一个爆点：切不切的开关，标题和说明直接点进去改（停一会儿、离开输入框时自动存），
 * 写好了标题的下面是定标题的一块（./DraftPanel），做好的切片显示编号和发布用的标题。右键有菜单：切不切、在 Explorer 中显示做好的切片、播放、复制标题、恢复原来的文字。
 */
const kindText: Record<StageKind, string> = { mc: 'MC', song: '唱歌', mistake: '失误' };

export const REASON_MAX: number = 400;

/* 2 分 24 秒 */
export function lengthText(seconds: number): string {
  const total: number = Math.round(seconds);
  const minute: number = Math.floor(total / 60);

  return minute > 0 ? `${ minute } 分${ total % 60 > 0 ? ` ${ total % 60 } 秒` : '' }` : `${ total } 秒`;
}

/* 改过的会怎么用：标题写在画面和封面上，发布用的标题（.txt）还是 Gemini 起 */
function editedText(item: ShowItem): string {
  if (item.draft) return item.draft.basis === basisOf(item) ? '照改过的写的' : '改过了，点「重新写」才会用上';

  if (item.clip && !item.cut) return '改过了，打开「重切」才会用上';

  return item.original && item.original.title !== item.title
    ? '画面和封面用你的标题，.txt 里的标题还是 Gemini 起'
    : '改过了，会按改过的切';
}

interface HighlightPickItemProps {
  readonly dir: string;
  readonly info: ShowInfo;
  readonly item: ShowItem;
  readonly locked: boolean;   // 正在做，不能改切不切
  readonly writing: boolean;  // 正在做的是写标题：已经写好的可以先定
  clipFile(): string | undefined; // 做好的切片在哪里；不在了是 undefined
  onCut(cut: boolean): void;
  onEdit(patch: { title?: string; reason?: string }): Promise<unknown>;
  onDraft(change: (draft: ClipDraft) => ClipDraft): Promise<unknown>;
  onRewrite(): void;
  onRetitle(): void;
}

function HighlightPickItem(props: HighlightPickItemProps): ReactElement {
  const { dir, info, item, locked, writing, clipFile, onCut, onEdit, onDraft, onRewrite, onRetitle }: HighlightPickItemProps = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const [restyling, setRestyling]: [boolean, D<S<boolean>>] = useState(false); // 做好的切片：改标题和亮点的那一块打开了没有
  const title: DraftField = useDraftField(item.title, (text: string): Promise<unknown> => onEdit({ title: text }));
  const reason: DraftField = useDraftField(item.reason, (text: string): Promise<unknown> => onEdit({ reason: text }));
  const naming: boolean = readyToRender(item); // 写好了，等着定标题

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
    } else if (key === 'draft') {
      setRestyling(!restyling);
    }
  }

  const menu: MenuProps = {
    items: [
      { key: 'cut', icon: item.cut ? <IconStopOutlined /> : <IconScissorOutlined />, label: cutLabel(), disabled: locked },
      { key: 'restore', icon: <IconUndoOutlined />, label: '恢复原来的标题和说明', disabled: locked || !item.original },
      ...(item.clip && item.draft && !naming ? [{ key: 'draft', icon: <IconEditOutlined />, label: restyling ? '收起标题和亮点' : '改标题和亮点' }] : []),
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
            {
              // 写好以后标题在下面定，这里只是这个爆点说的是什么
              item.draft ? <span className="picks-title is-fixed" title={ item.title }>{ item.title }</span> : (
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
              )
            }
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
                {
                  item.draft && !naming ? (
                    <Button type="link" size="small" onClick={ (): void => setRestyling(!restyling) }>
                      { restyling ? '收起' : '改标题和亮点' }{ !restyling && isRestyled(item) ? '（改过，还没重做）' : '' }
                    </Button>
                  ) : null
                }
              </div>
            ) : null
          }
          {
            item.original ? (
              <div className="picks-note">
                <span>{ editedText(item) }</span>
                <Button type="link" size="small" disabled={ locked } onClick={ (): Promise<unknown> => onEdit({ ...item.original }) }>恢复原来的</Button>
              </div>
            ) : null
          }
          { item.problem ? <div className="picks-note"><Typography.Text type="danger">没做成：{ item.problem }</Typography.Text></div> : null }
          {
            item.draft && (naming || (restyling && item.clip)) ? (
              <DraftPanel dir={ dir }
                info={ info }
                item={ item }
                locked={ locked && !writing }
                busy={ locked }
                onDraft={ onDraft }
                onRewrite={ onRewrite }
                onRetitle={ onRetitle }
              />
            ) : null
          }
        </div>
      </article>
    </Dropdown>
  );
}

export default HighlightPickItem;
