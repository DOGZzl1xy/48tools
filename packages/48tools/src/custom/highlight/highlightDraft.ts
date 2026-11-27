import { buildSegments, toOut } from './highlightCut';
import { plainTitle, stageCoverLines, stagePostTitle } from './highlightStage';
import { postTitle } from './highlightTime';
import type { StageInfo } from './highlightStageAss';
import type { CaptionLine, ClipDraft, ClipScript, Highlight, Segment } from './highlightTypes';

/**
 * 写好、等人定标题的切片（ClipDraft）：选标题、改亮点、改字幕、封面上写什么、发布用的标题怎么拼。
 * 都是纯计算；谁来写、谁来渲染在 ./highlightPipeline，界面在 ./DraftPanel。
 */
export const MAX_POINTS: number = 3;      // 封面上的亮点、公演封面的大字都是最多三行
export const POINT_LENGTH: number = 24;

/* 成片由这一段里的哪几截拼成（字幕的字可以改，留不留、时间不变，所以每次算出来都一样） */
export function draftSegments(draft: Pick<ClipDraft, 'lines' | 'length' | 'whole'>): { segments: Array<Segment>; total: number } {
  return draft.whole
    ? { segments: [{ from: 0, to: -1, start: 0, end: draft.length, out: 0 }], total: draft.length }
    : buildSegments(draft.lines, draft.length);
}

/* 成片里的时间 → 这一段里的时间（toOut 反过来） */
export function fromOut(segments: Array<Segment>, time: number): number {
  const segment: Segment | undefined = segments.findLast((item: Segment): boolean => item.out <= time) ?? segments[0];

  return segment ? Math.min(segment.end, segment.start + Math.max(0, time - segment.out)) : time;
}

/* 播放录播里的这一段时，播到 time（这一段里的时间）该怎么办：在留下的部分里接着播，落在剪掉的地方就跳到下一截，后面没有了就停 */
export function playAt(segments: Array<Segment>, time: number): { go: 'play' } | { go: 'jump'; to: number } | { go: 'stop' } {
  if (toOut(segments, time) !== null) return { go: 'play' };

  const next: Segment | undefined = segments.find((segment: Segment): boolean => segment.start > time);

  return next ? { go: 'jump', to: next.start } : { go: 'stop' };
}

/* 播到 time 时正在说的那句（留下的、没被清空的） */
export function lineAt(lines: Array<CaptionLine>, time: number): CaptionLine | undefined {
  return lines.findLast((line: CaptionLine): boolean => line.keep && line.start <= time && time <= line.end + 0.9);
}

export interface DraftInput {
  key: string;
  window: { start: number; length: number };
  script: ClipScript;
  lines: Array<CaptionLine>;
  timing: string;
  whole: boolean;
  frames: Array<number>;
  pictures?: Array<string>; // 别的封面候选（电台封面库的照片）
  frame: number;
}

/* 草稿是照爆点的哪个标题和说明写的 */
export function basisOf(highlight: Pick<Highlight, 'title' | 'reason'>): string {
  return `${ highlight.title }
${ highlight.reason }`;
}

/* 写字幕那一步的结果 → 草稿。挑片的人取过标题就先用他的，没取用 Gemini 最满意的那个 */
export function newDraft(highlight: Pick<Highlight, 'title' | 'reason' | 'coverTitle'>, input: DraftInput): ClipDraft {
  const { script }: DraftInput = input;

  return {
    key: input.key,
    basis: basisOf(highlight),
    start: input.window.start,
    length: input.window.length,
    ...(input.whole ? { whole: true } : {}),
    lines: input.lines,
    timing: input.timing,
    titles: script.titles && script.titles.length > 0 ? script.titles : [script.title],
    more: script.more ?? [],
    description: script.description,
    points: script.points,
    people: script.people ?? [],
    frames: input.frames,
    ...(input.pictures && input.pictures.length > 0 ? { pictures: input.pictures } : {}),
    title: highlight.coverTitle ?? script.title,
    ...(highlight.coverTitle ? { ownTitle: highlight.coverTitle } : {}),
    frame: input.frame
  };
}

/* 定的标题是自己取的，不是 Gemini 起的那几个里的 */
export function isOwnTitle(draft: Pick<ClipDraft, 'title' | 'titles'>): boolean {
  return !draft.titles.includes(draft.title);
}

function tidy(lines: Array<string>): Array<string> {
  return lines.map((line: string): string => line.trim()).filter((line: string): boolean => line !== '').slice(0, MAX_POINTS);
}

/* 封面上的亮点（直播、电台；公演的写在说明里） */
export function draftPoints(draft: Pick<ClipDraft, 'points' | 'ownPoints'>): Array<string> {
  return tidy(draft.ownPoints ?? draft.points);
}

/* 公演封面上的大字：就是定的标题，唱歌的只写歌名（用户 2026-11-27 定的，不再另外写、另外改；见 ./highlightStage 的 stageCoverLines） */
export function draftCoverLines(highlight: Highlight, draft: Pick<ClipDraft, 'title' | 'titles'>): Array<string> {
  return stageCoverLines(highlight, draft.title, isOwnTitle(draft));
}

/* 画面、文件名上写的标题：公演的标题里可能有【】（封面上刷荧光笔的记号），不显示出来 */
export function shownTitle(job: { stage?: StageInfo }, draft: Pick<ClipDraft, 'title'>): string {
  return job.stage ? plainTitle(draft.title) : draft.title;
}

/* 选标题、自己写标题；空的不改 */
export function pickTitle(draft: ClipDraft, title: string): ClipDraft {
  const text: string = title.trim();

  if (text === '' || text === draft.title) return draft;

  return { ...draft, title: text, ...(draft.titles.includes(text) ? {} : { ownTitle: text }) };
}

/* 改第几个亮点；写到最后一个后面就是加一个，undefined 是删掉。改回 Gemini 写的就不算改过 */
function editList(wrote: Array<string>, now: Array<string>, index: number, text: string | undefined): Array<string> | undefined {
  const next: Array<string> = [...now];

  if (text === undefined) next.splice(index, 1);
  else next[index] = text.trim();

  return next.length === wrote.length && next.every((line: string, order: number): boolean => line === wrote[order]) ? undefined : next.slice(0, MAX_POINTS);
}

export function editPoint(draft: ClipDraft, index: number, text: string | undefined): ClipDraft {
  const { ownPoints, ...rest }: ClipDraft = draft;
  const next: Array<string> | undefined = editList(draft.points, ownPoints ?? draft.points, index, text);

  return next ? { ...rest, ownPoints: next } : rest;
}

/* 封面候选一共几个：录播里取的，加上别的图（上传的、播放时选的、电台封面库的） */
export function candidateCount(draft: Pick<ClipDraft, 'frames' | 'pictures'>): number {
  return draft.frames.length + (draft.pictures?.length ?? 0);
}

/* 加一张别的图当封面候选，并且就用它；已经有了就直接用 */
export function pickPicture(draft: ClipDraft, entry: string): ClipDraft {
  const pictures: Array<string> = draft.pictures ?? [];
  const at: number = pictures.indexOf(entry);

  if (at >= 0) return { ...draft, frame: draft.frames.length + at };

  return { ...draft, pictures: [...pictures, entry], frame: draft.frames.length + pictures.length };
}

/* 改一句字幕的字；清空就是这一句不显示（声音还在） */
export function editLine(draft: ClipDraft, index: number, text: string): ClipDraft {
  return { ...draft, lines: draft.lines.map((line: CaptionLine, order: number): CaptionLine => (order === index ? { ...line, text: text.trim() } : line)) };
}

/**
 * 看得见的东西（标题、亮点、封面的画面）有没有变：和做好的切片里记的不一样，就要重做标题和封面。
 * 最后一项以前是公演改过的封面大字，现在没有这样东西了；留着一个 null，这样以前做好的切片记的还对得上，不会都变成「要重做」
 */
export function lookOf(draft: ClipDraft): string {
  return JSON.stringify([draft.title, draft.frame, draftPoints(draft), null]);
}

/* 画面右上角和封面上的小字 */
export function videoTag(job: { member: string; date: string }): string {
  return `${ job.member }  ${ job.date }`.trim();
}

export function coverTag(job: { member: string; date: string }): string {
  return `${ job.member }  直播切片  ${ job.date }`.trim();
}

/**
 * 发布用的标题（.txt）：定的是 Gemini 起的就用它，另外几个当备选；自己取的写在画面和封面上，.txt 里还是 Gemini 的
 * @return { { post: string; others: Array<string> } } 拼好名字和日期的
 */
export function draftPostTitles(
  job: { member: string; date: string; stage?: StageInfo }, draft: Pick<ClipDraft, 'title' | 'titles' | 'people' | 'more'>
): { post: string; others: Array<string> } {
  const main: string = isOwnTitle(draft) ? draft.titles[0] ?? draft.title : draft.title;
  const full: (title: string) => string = (title: string): string => (job.stage
    ? stagePostTitle(job.stage, title)
    : postTitle(job.member, job.date, title, draft.people, draft.more));

  return { post: full(main), others: draft.titles.filter((title: string): boolean => title !== main).map(full) };
}
