import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Fragment, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Button, Image, Input, Popconfirm, Radio, Segmented, Spin, Typography, type RadioChangeEvent } from 'antd';
import {
  CloseOutlined as IconCloseOutlined,
  DownOutlined as IconDownOutlined,
  PictureOutlined as IconPictureOutlined,
  PlayCircleOutlined as IconPlayCircleOutlined,
  PlusOutlined as IconPlusOutlined,
  RedoOutlined as IconRedoOutlined,
  UpOutlined as IconUpOutlined
} from '@ant-design/icons';
import {
  draftCoverLines, draftPostTitles, editCoverLine, editLine, editPoint, isOwnTitle, pickTitle, MAX_POINTS, POINT_LENGTH
} from './highlightDraft';
import { coverDir, thumbFile } from './highlightCover';
import { highlightOf, isRestyled, type ShowInfo, type ShowItem } from './highlightShow';
import { useCoverPreview, type CoverPreview } from './coverPreview';
import { useDraftField, type DraftField } from './useDraftField';
import { clock } from './highlightTime';
import DraftPlayer from './DraftPlayer';
import type { CaptionLine, ClipDraft, Highlight } from './highlightTypes';

/**
 * 切片页面里一个写好了的爆点（用户 2026-11-24 定的：先定标题和亮点，再渲染）：
 * 选 Gemini 起的标题或者自己写，亮点（公演是封面大字）可以改、删、加，封面当场看、可以换一帧，字幕能改错字，能直接放录播里的这一段。
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

/* 一行亮点（封面大字），右边可以删 */
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

/* 选标题：Gemini 起的三个，或者自己写 */
function TitlePicker(props: { readonly draft: ClipDraft; readonly locked: boolean; onDraft: DraftPanelProps['onDraft'] }): ReactElement {
  const { draft, locked, onDraft }: { draft: ClipDraft; locked: boolean; onDraft: DraftPanelProps['onDraft'] } = props;
  const own: boolean = isOwnTitle(draft);
  const field: DraftField = useDraftField(draft.ownTitle ?? '', (text: string): Promise<unknown> => onDraft((now: ClipDraft): ClipDraft => pickTitle(now, text)));

  function handleChange(event: RadioChangeEvent): void {
    const title: string = event.target.value === OWN_VALUE ? draft.ownTitle ?? '' : event.target.value;

    void onDraft((now: ClipDraft): ClipDraft => pickTitle(now, title));
  }

  return (
    <Radio.Group className="picks-titles" value={ own ? OWN_VALUE : draft.title } disabled={ locked } onChange={ handleChange }>
      { draft.titles.map((title: string): ReactElement => <Radio key={ title } value={ title }>{ title }</Radio>) }
      <div className="picks-row">
        <Radio value={ OWN_VALUE } disabled={ locked || !draft.ownTitle } aria-label="用自己写的标题" />
        <Input className="picks-edit"
          variant="borderless"
          aria-label="自己写标题"
          value={ field.value }
          maxLength={ TITLE_MAX }
          placeholder="自己写"
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

/* 封面：当场做出来看，点开看大图；下面换一帧 */
function Cover(props: Pick<DraftPanelProps, 'dir' | 'info' | 'item' | 'locked' | 'onDraft'>): ReactElement {
  const { dir, info, item, locked, onDraft }: Pick<DraftPanelProps, 'dir' | 'info' | 'item' | 'locked' | 'onDraft'> = props;
  const [shape, setShape]: ['wide' | 'standard', D<S<'wide' | 'standard'>>] = useState<'wide' | 'standard'>('wide');
  const preview: CoverPreview = useCoverPreview(dir, info, item);
  const draft: ClipDraft = item.draft!;
  const covers: string = coverDir(dir, draft.key);

  return (
    <div className="picks-cover">
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
        draft.frames.length > 1 ? (
          <div className={ `picks-frames${ info.stage ? ' is-stage' : '' }` } role="radiogroup" aria-label="封面用哪一帧">
            {
              draft.frames.map((time: number, index: number): ReactElement => (
                <button key={ time }
                  className={ index === draft.frame ? 'is-active' : '' }
                  type="button"
                  role="radio"
                  aria-checked={ index === draft.frame }
                  aria-label={ `第 ${ index + 1 } 帧` }
                  disabled={ locked }
                  onClick={ (): Promise<unknown> => onDraft((now: ClipDraft): ClipDraft => ({ ...now, frame: index })) }
                >
                  <img src={ `${ pathToFileURL(thumbFile(covers, index)).href }?v=${ draft.frames.join('-') }` } alt="" />
                </button>
              ))
            }
          </div>
        ) : null
      }
    </div>
  );
}

function DraftPanel(props: DraftPanelProps): ReactElement {
  const { dir, info, item, locked, busy, onDraft, onRewrite, onRetitle }: DraftPanelProps = props;
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

  // 封面上写的：直播、电台是亮点，公演是大字
  const rows: Array<string> = info.stage ? draft.ownCoverLines ?? draftCoverLines(highlight, draft) : draft.ownPoints ?? draft.points;

  function editRow(index: number, text: string | undefined): Promise<unknown> {
    return onDraft((now: ClipDraft): ClipDraft => (info.stage ? editCoverLine(highlight, now, index, text) : editPoint(now, index, text)));
  }

  return (
    <div className="picks-draft">
      <div className="picks-draft-main">
        <div className="picks-draft-fields">
          <div className="picks-field">
            <span className="picks-field-name">标题</span>
            <TitlePicker draft={ draft } locked={ locked } onDraft={ onDraft } />
          </div>
          <div className="picks-field">
            <span className="picks-field-name">{ info.stage ? '封面大字' : '亮点' }</span>
            <div className="picks-field-body">
              {
                rows.map((row: string, index: number): ReactElement => (
                  <TextRow key={ `${ index }-${ rows.length }` }
                    value={ row }
                    label={ `${ info.stage ? '封面大字' : '亮点' } ${ index + 1 }` }
                    maxLength={ POINT_LENGTH }
                    locked={ locked }
                    placeholder={ info.stage ? '【】里的词会突出' : '写一句' }
                    onSave={ (text: string): Promise<unknown> => editRow(index, text) }
                    onRemove={ info.stage && rows.length === 1 ? undefined : (): void => void editRow(index, undefined) }
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
          <DraftPlayer title={ draft.title } source={ source } picture={ info.picture } draft={ draft } onClose={ (): void => setPlaying(false) } />
        ) : null
      }
    </div>
  );
}

export default DraftPanel;
