import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webUtils } from 'electron';
import { Fragment, useState, type DragEvent, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Button, Image, Input, Popconfirm, Radio, Segmented, Spin, Typography, type RadioChangeEvent } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  CloseOutlined as IconCloseOutlined,
  DownOutlined as IconDownOutlined,
  FolderOpenOutlined as IconFolderOpenOutlined,
  PictureOutlined as IconPictureOutlined,
  PlayCircleOutlined as IconPlayCircleOutlined,
  PlusOutlined as IconPlusOutlined,
  RedoOutlined as IconRedoOutlined,
  UpOutlined as IconUpOutlined,
  UploadOutlined as IconUploadOutlined
} from '@ant-design/icons';
import {
  candidateCount, draftPostTitles, editLine, editPoint, isOwnTitle, pickPicture, pickTitle, MAX_POINTS, POINT_LENGTH
} from './highlightDraft';
import { candidateThumb, coverDir } from './highlightCover';
import { addPictureFile, captureFrame, chooseImage, isImageFile } from './coverPick';
import { libraryDir } from './radioPhotos';
import { highlightOf, isRestyled, type ShowInfo, type ShowItem } from './highlightShow';
import { useCoverPreview, type CoverPreview } from './coverPreview';
import { useDraftField, type DraftField } from './useDraftField';
import { clock } from './highlightTime';
import DraftPlayer from './DraftPlayer';
import type { CaptionLine, ClipDraft, Highlight } from './highlightTypes';

/**
 * 切片页面里一个写好了的爆点（用户 2026-11-24 定的：先定标题和亮点，再渲染）：
 * 选 Gemini 起的标题或者自己写，亮点可以改、删、加（公演没有亮点这一栏：封面上的大字就是标题），封面当场看、可以换一帧，字幕能改错字，能直接放录播里的这一段。
 * 渲染完还能回来改标题、亮点、封面的画面，点「重做标题和封面」只换那一条，不用重新渲染。
 */
export const TITLE_MAX: number = 40;
const OWN_VALUE: string = ' own'; // 「自己写」那一项的值；标题开头不会有空格，不会和 Gemini 起的撞上

interface TextRowProps {
  readonly value: string;
  readonly label: string;
  readonly maxLength: number;
  readonly locked: boolean;
  readonly placeholder?: string;
  onSave(text: string): Promise<unknown>;
  onRemove?(): void;
}

/* 一行亮点，右边可以删 */
function TextRow(props: TextRowProps): ReactElement {
  const { value, label, maxLength, locked, placeholder, onSave, onRemove }: TextRowProps = props;
  const field: DraftField = useDraftField(value, onSave);

  return (
    <div className="picks-row">
      <Input className="picks-edit"
        variant="borderless"
        aria-label={ label }
        value={ field.value }
        maxLength={ maxLength }
        placeholder={ placeholder }
        spellCheck={ false }
        disabled={ locked }
        onChange={ field.onChange }
        onBlur={ field.onBlur }
        onPressEnter={ (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.blur() }
      />
      { onRemove ? <Button type="text" size="small" icon={ <IconCloseOutlined /> } aria-label={ `删掉：${ value }` } disabled={ locked } onClick={ onRemove } /> : null }
    </div>
  );
}

/* 一句字幕；清空就是这一句不显示 */
function CaptionRow(props: { readonly line: CaptionLine; readonly at: number; readonly locked: boolean; onSave(text: string): Promise<unknown> }): ReactElement {
  const { line, at, locked, onSave }: { line: CaptionLine; at: number; locked: boolean; onSave(text: string): Promise<unknown> } = props;
  const field: DraftField = useDraftField(line.text, onSave, true);

  return (
    <div className="picks-row">
      <span className="picks-meta">{ clock(at) }</span>
      <Input className="picks-edit"
        variant="borderless"
        size="small"
        aria-label={ `字幕 ${ clock(at) }` }
        value={ field.value }
        placeholder="（这一句不显示）"
        spellCheck={ false }
        disabled={ locked }
        onChange={ field.onChange }
        onBlur={ field.onBlur }
        onPressEnter={ (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.blur() }
      />
    </div>
  );
}

interface DraftPanelProps {
  readonly dir: string;
  readonly info: ShowInfo;
  readonly item: ShowItem;      // 有 draft 的
  readonly locked: boolean;     // 正在渲染，不能改
  readonly busy: boolean;       // 这一场正在做别的，不能重新写、重做
  onDraft(change: (draft: ClipDraft) => ClipDraft): Promise<unknown>;
  onRewrite(): void;
  onRetitle(): void;
}

/* 公演的标题：【】里的词是封面上要刷荧光笔的，这里不显示括号，把词标出来 */
function MarkedTitle(props: { readonly text: string }): ReactElement {
  const parts: Array<string> = props.text.split(/【([^【】]*)】/);

  return (
    <span>
      {
        parts.map((part: string, index: number): ReactElement | string => (index % 2 === 1
          ? <mark key={ index } className="picks-title-mark" title="封面上这个词下面刷荧光笔">{ part }</mark>
          : part.replace(/[【】]/g, '')))
      }
    </span>
  );
}

/* 选标题：Gemini 起的三个，或者自己写 */
function TitlePicker(props: { readonly draft: ClipDraft; readonly locked: boolean; readonly stage: boolean; onDraft: DraftPanelProps['onDraft'] }): ReactElement {
  const { draft, locked, stage, onDraft }: { draft: ClipDraft; locked: boolean; stage: boolean; onDraft: DraftPanelProps['onDraft'] } = props;
  const own: boolean = isOwnTitle(draft);
  const field: DraftField = useDraftField(draft.ownTitle ?? '', (text: string): Promise<unknown> => onDraft((now: ClipDraft): ClipDraft => pickTitle(now, text)));

  function handleChange(event: RadioChangeEvent): void {
    const title: string = event.target.value === OWN_VALUE ? draft.ownTitle ?? '' : event.target.value;

    void onDraft((now: ClipDraft): ClipDraft => pickTitle(now, title));
  }

  return (
    <Radio.Group className="picks-titles" value={ own ? OWN_VALUE : draft.title } disabled={ locked } onChange={ handleChange }>
      { draft.titles.map((title: string): ReactElement => <Radio key={ title } value={ title }>{ stage ? <MarkedTitle text={ title } /> : title }</Radio>) }
      <div className="picks-row">
        <Radio value={ OWN_VALUE } disabled={ locked || !draft.ownTitle } aria-label="用自己写的标题" />
        <Input className="picks-edit"
          variant="borderless"
          aria-label="自己写标题"
          value={ field.value }
          maxLength={ TITLE_MAX }
          placeholder={ stage ? '自己写（用【】括起来的词，封面上会刷荧光笔，括号不显示）' : '自己写' }
          spellCheck={ false }
          disabled={ locked }
          onChange={ field.onChange }
          onBlur={ field.onBlur }
          onPressEnter={ (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.blur() }
        />
      </div>
    </Radio.Group>
  );
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* 这个候选叫什么（读屏、鼠标停上去时看） */
function candidateLabel(draft: ClipDraft, index: number): string {
  const entry: string | undefined = index >= draft.frames.length ? draft.pictures?.[index - draft.frames.length] : undefined;

  if (!entry) return `第 ${ index + 1 } 帧`;

  return path.isAbsolute(entry) ? `封面库：${ path.parse(entry).name }` : `第 ${ index + 1 } 张（自己选的）`;
}

/**
 * 封面：当场做出来看，点开看大图。下面换一张：录播里挑的几帧（直播挑清楚的）、电台封面库的照片、自己上传的、播放时选的一帧；
 * 也可以把图拖进来（用户 2026-11-26 要的）
 */
function Cover(props: Pick<DraftPanelProps, 'dir' | 'info' | 'item' | 'locked' | 'onDraft'>): ReactElement {
  const { dir, info, item, locked, onDraft }: Pick<DraftPanelProps, 'dir' | 'info' | 'item' | 'locked' | 'onDraft'> = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const [shape, setShape]: ['wide' | 'standard', D<S<'wide' | 'standard'>>] = useState<'wide' | 'standard'>('wide');
  const [adding, setAdding]: [boolean, D<S<boolean>>] = useState(false);
  const [dragging, setDragging]: [boolean, D<S<boolean>>] = useState(false);
  const preview: CoverPreview = useCoverPreview(dir, info, item);
  const draft: ClipDraft = item.draft!;
  const covers: string = coverDir(dir, draft.key);
  const library: string = libraryDir(dir, info.member);
  const hasLibrary: boolean = !info.stage && fs.existsSync(library);
  const version: string = draft.frames.join('-');

  async function add(task: () => Promise<string>): Promise<void> {
    setAdding(true);

    try {
      const entry: string = await task();

      await onDraft((now: ClipDraft): ClipDraft => pickPicture(now, entry));
    } catch (err) {
      console.error('封面换图失败', err);
      messageApi.error(`这张图用不了：${ reasonOf(err) }`);
    } finally {
      setAdding(false);
    }
  }

  async function handleChooseClick(fromLibrary: boolean): Promise<void> {
    const file: string | undefined = await chooseImage(fromLibrary ? library : undefined);

    if (file) await add((): Promise<string> => addPictureFile(dir, info, draft, file));
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (locked || !event.dataTransfer.types.includes('Files')) return;

    event.preventDefault();
    setDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);

    const file: File | undefined = event.dataTransfer.files[0];
    const filePath: string = file ? webUtils.getPathForFile(file) : '';

    if (locked || adding) return;

    if (!filePath || !isImageFile(filePath)) {
      messageApi.warning('拖进来的不是图片（jpg、png、webp）');

      return;
    }

    void add((): Promise<string> => addPictureFile(dir, info, draft, filePath));
  }

  return (
    <div className={ `picks-cover${ dragging ? ' is-dragging' : '' }` }
      onDragOver={ handleDragOver }
      onDragLeave={ (): void => setDragging(false) }
      onDrop={ handleDrop }
    >
      <Spin spinning={ preview.loading } delay={ 300 }>
        <div className="picks-cover-image">
          {
            preview.covers ? (
              <Image className={ shape === 'standard' ? 'is-standard' : undefined } src={ preview.covers[shape] } alt={ `封面 ${ shape === 'wide' ? '16:9' : '4:3' }` } />
            ) : <span className="picks-cover-empty">{ preview.error ? `封面没做出来：${ preview.error }` : '' }</span>
          }
        </div>
      </Spin>
      <Segmented size="small"
        options={ [{ label: '16:9', value: 'wide' }, { label: '4:3', value: 'standard' }] }
        value={ shape }
        onChange={ (value: string): void => setShape(value as 'wide' | 'standard') }
      />
      {
        candidateCount(draft) > 1 ? (
          <div className={ `picks-frames${ info.stage ? ' is-stage' : '' }` } role="radiogroup" aria-label="封面用哪一张">
            {
              Array.from({ length: candidateCount(draft) }, (_item: unknown, index: number): ReactElement => (
                <button key={ index }
                  className={ index === draft.frame ? 'is-active' : '' }
                  type="button"
                  role="radio"
                  aria-checked={ index === draft.frame }
                  aria-label={ candidateLabel(draft, index) }
                  title={ candidateLabel(draft, index) }
                  disabled={ locked }
                  onClick={ (): Promise<unknown> => onDraft((now: ClipDraft): ClipDraft => ({ ...now, frame: index })) }
                >
                  <img src={ `${ pathToFileURL(candidateThumb(covers, draft, index)).href }?v=${ version }` } alt="" loading="lazy" />
                </button>
              ))
            }
          </div>
        ) : null
      }
      <div className="picks-cover-actions">
        <Button size="small" icon={ <IconUploadOutlined /> } loading={ adding } disabled={ locked } onClick={ (): Promise<void> => handleChooseClick(false) }>上传图片</Button>
        {
          hasLibrary ? (
            <Button size="small" icon={ <IconFolderOpenOutlined /> } disabled={ locked || adding } title={ library } onClick={ (): Promise<void> => handleChooseClick(true) }>封面库</Button>
          ) : null
        }
      </div>
      <span className="picks-meta">{ info.radio ? '也可以把图拖到这里' : '播放这一段时也能选一帧，或者把图拖到这里' }</span>
    </div>
  );
}

function DraftPanel(props: DraftPanelProps): ReactElement {
  const { dir, info, item, locked, busy, onDraft, onRewrite, onRetitle }: DraftPanelProps = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const [playing, setPlaying]: [boolean, D<S<boolean>>] = useState(false);
  const [captions, setCaptions]: [boolean, D<S<boolean>>] = useState(false);
  const draft: ClipDraft = item.draft!;
  const highlight: Highlight = highlightOf(item);
  const made: boolean = item.clip !== undefined && !item.cut; // 做好了：改的是标题和封面，字幕要重切才能改
  const { post, others }: { post: string; others: Array<string> } = draftPostTitles(info, draft);
  const source: string | undefined = info.source && fs.existsSync(info.source) ? info.source : undefined;
  const kept: Array<{ line: CaptionLine; index: number }> = draft.lines
    .map((line: CaptionLine, index: number): { line: CaptionLine; index: number } => ({ line, index }))
    .filter(({ line }: { line: CaptionLine }): boolean => line.keep);

  // 封面上写的亮点（直播、电台）。公演的封面只写标题，没有另外要定的东西
  const rows: Array<string> = draft.ownPoints ?? draft.points;

  function editRow(index: number, text: string | undefined): Promise<unknown> {
    return onDraft((now: ClipDraft): ClipDraft => editPoint(now, index, text));
  }

  /* 播放时「用这一帧做封面」：录播里的这一刻存成一张图，封面换成它 */
  async function handleCapture(time: number): Promise<void> {
    try {
      const entry: string = await captureFrame(dir, info, draft, source!, time);

      await onDraft((now: ClipDraft): ClipDraft => pickPicture(now, entry));
      messageApi.success('封面换成这一帧了');
    } catch (err) {
      console.error('取这一帧失败', err);
      messageApi.error(`没取到这一帧：${ reasonOf(err) }`);
    }
  }

  return (
    <div className="picks-draft">
      <div className="picks-draft-main">
        <div className="picks-draft-fields">
          <div className="picks-field">
            <span className="picks-field-name">标题</span>
            <TitlePicker draft={ draft } locked={ locked } stage={ Boolean(info.stage) } onDraft={ onDraft } />
          </div>
          {
            info.stage ? null : (
              <div className="picks-field">
                <span className="picks-field-name">亮点</span>
                <div className="picks-field-body">
                  {
                    rows.map((row: string, index: number): ReactElement => (
                      <TextRow key={ `${ index }-${ rows.length }` }
                        value={ row }
                        label={ `亮点 ${ index + 1 }` }
                        maxLength={ POINT_LENGTH }
                        locked={ locked }
                        placeholder="写一句"
                        onSave={ (text: string): Promise<unknown> => editRow(index, text) }
                        onRemove={ (): void => void editRow(index, undefined) }
                      />
                    ))
                  }
                  {
                    rows.length < MAX_POINTS ? (
                      <Button type="text" size="small" icon={ <IconPlusOutlined /> } disabled={ locked || rows.at(-1)?.trim() === '' } onClick={ (): Promise<unknown> => editRow(rows.length, '') }>
                        加一个
                      </Button>
                    ) : null
                  }
                </div>
              </div>
            )
          }
          <div className="picks-field">
            <span className="picks-field-name">发布</span>
            <div className="picks-field-body">
              <Typography.Text className="picks-post" type="secondary" copyable={{ text: post, tooltips: ['复制发布用的标题', '复制好了'] }}>{ post }</Typography.Text>
              <span className="picks-meta">写在 .txt 里{ others.length > 0 ? `，另外 ${ others.length } 个当备选` : '' }</span>
            </div>
          </div>
        </div>
        <Cover dir={ dir } info={ info } item={ item } locked={ locked } onDraft={ onDraft } />
      </div>
      <div className="picks-draft-actions">
        <Button size="small" icon={ <IconPlayCircleOutlined /> } disabled={ !source } title={ source ? undefined : '录播不在本机了' } onClick={ (): void => setPlaying(true) }>播放这一段</Button>
        {
          kept.length > 0 ? (
            <Button size="small" icon={ captions ? <IconUpOutlined /> : <IconDownOutlined /> } onClick={ (): void => setCaptions(!captions) }>字幕 { kept.length } 句</Button>
          ) : null
        }
        <Popconfirm title="重新写一遍？" description="再问一次 Gemini，现在的标题、亮点和改过的字幕都会换掉。" okText="重新写" cancelText="返回" onConfirm={ onRewrite }>
          <Button size="small" icon={ <IconRedoOutlined /> } disabled={ locked || busy }>重新写</Button>
        </Popconfirm>
        <span className="picks-space" />
        {
          made ? (
            <Fragment>
              { isRestyled(item) ? <span className="picks-meta">改过了，还没重做</span> : null }
              <Button type="primary" size="small" icon={ <IconPictureOutlined /> } disabled={ busy || !isRestyled(item) } onClick={ onRetitle }>重做标题和封面</Button>
            </Fragment>
          ) : null
        }
      </div>
      {
        captions ? (
          <div className="picks-captions">
            { made ? <div className="picks-meta">已经渲染了：改字幕要先打开「重切」。</div> : null }
            {
              kept.map(({ line, index }: { line: CaptionLine; index: number }): ReactElement => (
                <CaptionRow key={ index }
                  line={ line }
                  at={ draft.start + line.start }
                  locked={ locked || made }
                  onSave={ (text: string): Promise<unknown> => onDraft((now: ClipDraft): ClipDraft => editLine(now, index, text)) }
                />
              ))
            }
          </div>
        ) : null
      }
      {
        playing && source ? (
          <DraftPlayer title={ draft.title }
            source={ source }
            picture={ info.picture }
            draft={ draft }
            onCapture={ info.radio || locked ? undefined : handleCapture }
            onClose={ (): void => setPlaying(false) }
          />
        ) : null
      }
    </div>
  );
}

export default DraftPanel;
