import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { clock } from './highlightTime';
import type { Highlight } from './highlightTypes';
import type { StageInfo } from './highlightStageAss';
import type { ClipResult, HighlightJob } from './highlightPipeline';

/**
 * 一场录播的爆点清单（输出文件夹里的 爆点.json）：找到的全部爆点、推荐切哪些、挑的人改过的标题和说明、做成了哪些切片。
 * 用户 2026-11-23 定的：找完爆点就停下来等人挑。推荐的默认「切片」，其余默认「不切」，每个都能单独改；标题和说明也能改，
 * 改好了才写字幕、剪片，这样 Gemini 拿到的是核对过的文字。
 * 这个文件只管清单的内容和读写；界面在 ./HighlightsPage，读写的排队在 ./showStore，切在 ./pickTask。
 */
export const SHOW_FILE: string = '爆点.json';
export const INFO_FILE: string = '切片说明.txt';

/* 做成的切片（写切片说明、界面上显示用） */
export type ShowClip = Pick<ClipResult, 'index' | 'title' | 'postTitle' | 'otherTitles' | 'description' | 'start' | 'end' | 'duration' | 'score'>;

export interface ShowItem extends Highlight {
  recommended: boolean;                                // 程序推荐的
  cut: boolean;                                        // 挑的人选了切（默认照推荐的；已经切过的选了就是重切）
  original?: Pick<Highlight, 'title' | 'reason'>;      // 改过标题或说明以后，Gemini 原来写的
  clip?: ShowClip;
  problem?: string;                                    // 上次没做成的原因
}

export interface ShowInfo {
  version: 2;
  status: 'waiting' | 'done';  // waiting：找完了，还没挑
  liveId: string;
  member: string;
  title: string;
  date: string;
  radio?: boolean;
  stage?: StageInfo;
  local?: HighlightJob['local']; // 用的是本机已经下好的录播
  model: string;
  foundAt: number;
  duration: number;
  summaries: Array<string>;
  notes: Array<string>;        // 找爆点时没用上的和原因
  items: Array<ShowItem>;      // 按爆点分从高到低
}

/* 这一场是哪一种：电台、直播、公演 */
export type ShowKind = 'radio' | 'live' | 'stage';

export function showKind(info: Pick<ShowInfo, 'radio' | 'stage'>): ShowKind {
  if (info.stage) return 'stage';

  return info.radio ? 'radio' : 'live';
}

export function madeCount(info: Pick<ShowInfo, 'items'>): number {
  return info.items.filter((item: ShowItem): boolean => item.clip !== undefined).length;
}

/* 切这一场的任务排队用的 id（找爆点的 id 是 liveId，B 站公演录完自动找的是 gongyan-liveId） */
export function pickKey(info: Pick<ShowInfo, 'liveId'>): string {
  return `pick-${ info.liveId }`;
}

export function findKeys(info: Pick<ShowInfo, 'liveId'>): Array<string> {
  return [info.liveId, `gongyan-${ info.liveId }`];
}

type JobInfo = Pick<HighlightJob, 'liveId' | 'member' | 'title' | 'date' | 'radio' | 'stage' | 'local'>;

/* 成片是不是从这个爆点做的（成片的起止可能比爆点宽一些，也可能窄一些） */
function madeFrom(item: Pick<Highlight, 'start' | 'end'>, clip: Pick<ShowClip, 'start' | 'end'>): boolean {
  const shared: number = Math.min(item.end, clip.end) - Math.max(item.start, clip.start);

  return shared > Math.min(item.end - item.start, clip.end - clip.start) * 0.5;
}

/**
 * 找完爆点后的清单
 * @param { JobInfo } job
 * @param { object } found
 * @param { Set<number> } found.recommended - 推荐的是第几个
 * @param { ShowInfo | undefined } old - 这一场以前的清单（重新找一遍时）：做好的切片接过来，不会忘了已经切过
 */
export function newShowInfo(
  job: JobInfo,
  found: { model: string; duration: number; summaries: Array<string>; notes: Array<string>; items: Array<Highlight>; recommended: Set<number> },
  old?: ShowInfo
): ShowInfo {
  const made: Array<ShowClip> = (old?.items ?? []).flatMap((item: ShowItem): Array<ShowClip> => (item.clip ? [item.clip] : []));

  return {
    version: 2,
    status: found.items.length > 0 ? 'waiting' : 'done',
    liveId: job.liveId,
    member: job.member,
    title: job.title,
    date: job.date,
    ...(job.radio ? { radio: true } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.local ? { local: job.local } : {}),
    model: found.model,
    foundAt: Date.now(),
    duration: found.duration,
    summaries: found.summaries,
    notes: found.notes,
    items: found.items.map((item: Highlight, order: number): ShowItem => {
      const clip: ShowClip | undefined = made.find((one: ShowClip): boolean => madeFrom(item, one));
      const recommended: boolean = found.recommended.has(order);

      return { ...item, recommended, cut: recommended && !clip, ...(clip ? { clip } : {}) };
    })
  };
}

function isShowInfo(value: unknown): value is ShowInfo {
  return (value as ShowInfo | null)?.version === 2 && Array.isArray((value as ShowInfo).items);
}

/* 读一场的清单；没有（以前切的没有存）、读不了时返回 undefined */
export async function readShowInfo(dir: string): Promise<ShowInfo | undefined> {
  try {
    const info: unknown = JSON.parse(await fsP.readFile(path.join(dir, SHOW_FILE), { encoding: 'utf8' }));

    return isShowInfo(info) ? info : undefined;
  } catch {
    return undefined;
  }
}

export function readShowInfoSync(dir: string): ShowInfo | undefined {
  try {
    const info: unknown = JSON.parse(fs.readFileSync(path.join(dir, SHOW_FILE), { encoding: 'utf8' }));

    return isShowInfo(info) ? info : undefined;
  } catch {
    return undefined;
  }
}

/* 一个切片在切片说明里的几行 */
export function clipInfoLines(clip: ShowClip): Array<string> {
  return [
    `${ String(clip.index).padStart(2, '0') }. ${ clip.postTitle }（${ clock(clip.start) } ~ ${ clock(clip.end) }，${
      Math.round(clip.duration) } 秒，${ clip.score } 分）`,
    ...clip.otherTitles.map((title: string): string => `    备选：${ title }`),
    `    ${ clip.description }`,
    ''
  ];
}

/* 没切的爆点在切片说明里的一行 */
export function candidateLine(item: Pick<ShowItem, 'start' | 'end' | 'title' | 'score' | 'reason' | 'problem'>): string {
  return `    ${ clock(item.start) } ~ ${ clock(item.end) } ${ item.title }（${ item.score } 分）${ item.reason }${ item.problem ? `（没做成：${ item.problem }）` : '' }`;
}

/* 切片说明：照清单写，每次改了清单都重写 */
export function showText(info: ShowInfo): string {
  const clips: Array<ShowClip> = info.items
    .flatMap((item: ShowItem): Array<ShowClip> => (item.clip ? [item.clip] : []))
    .sort((a: ShowClip, b: ShowClip): number => a.index - b.index);
  const others: Array<ShowItem> = info.items.filter((item: ShowItem): boolean => !item.clip);

  return [
    `${ info.member }「${ info.title }」${ info.date }`,
    `录播长度 ${ clock(info.duration) }，找到 ${ info.items.length } 个爆点，做了 ${ clips.length } 个切片（模型 ${ info.model }）`,
    '',
    ...info.summaries.map((text: string, order: number): string => `第 ${ order + 1 } 段：${ text }`),
    '',
    ...clips.flatMap(clipInfoLines),
    ...(info.notes.length > 0 ? ['找爆点时没用上的：', ...info.notes] : []),
    ...(others.length > 0 ? ['没切的爆点：', ...others.map(candidateLine)] : []),
    ''
  ].join('\r\n');
}

/* 存清单，同时重写切片说明。先写到旁边再换过去，写到一半断电也不会把原来的弄坏 */
export async function writeShowInfo(dir: string, info: ShowInfo): Promise<void> {
  const file: string = path.join(dir, SHOW_FILE);

  await fsP.mkdir(dir, { recursive: true });
  await fsP.writeFile(`${ file }.part`, JSON.stringify(info, null, 2), { encoding: 'utf8' });
  await fsP.rename(`${ file }.part`, file);
  await fsP.writeFile(path.join(dir, INFO_FILE), showText(info), { encoding: 'utf8' });
}

/* 改标题或说明：空的不改；改回 Gemini 写的就不算改过 */
export function editItem(item: ShowItem, patch: Partial<Pick<Highlight, 'title' | 'reason'>>): ShowItem {
  const original: Pick<Highlight, 'title' | 'reason'> = item.original ?? { title: item.title, reason: item.reason };
  const title: string = patch.title?.trim() || item.title;
  const reason: string = patch.reason?.trim() || item.reason;

  if (title === item.title && reason === item.reason) return item;

  const { original: _original, edited: _edited, ...rest }: ShowItem = item;

  return title === original.title && reason === original.reason
    ? { ...rest, title, reason }
    : { ...rest, title, reason, edited: true, original };
}

/* 交给切片流程的爆点。改过的标题直接写在画面和封面上（coverTitle）；封面上别的大字是照 Gemini 原来的标题写的，改了标题就不用了 */
export function highlightOf(item: ShowItem): Highlight {
  const { recommended: _recommended, cut: _cut, original, clip: _clip, problem: _problem, coverLines, ...highlight }: ShowItem = item;

  return original && original.title !== item.title
    ? { ...highlight, cover: '', coverTitle: item.title }
    : { ...highlight, ...(coverLines ? { coverLines } : {}) };
}

/* 要切哪些、编号是几：重切的用原来的编号，新切的接在已经做好的后面 */
export function planCuts(info: ShowInfo, fileNames: Array<string>): Array<{ item: ShowItem; index: number }> {
  let next: number = Math.max(
    0,
    ...info.items.map((item: ShowItem): number => item.clip?.index ?? 0),
    ...fileNames.map((name: string): number => Number(/^(\d+)-.*\.mp4$/i.exec(name)?.[1] ?? 0))
  ) + 1;

  return info.items
    .filter((item: ShowItem): boolean => item.cut)
    .map((item: ShowItem): { item: ShowItem; index: number } => ({ item, index: item.clip?.index ?? next++ }));
}

export function sameItem(a: Pick<Highlight, 'start' | 'end'>, b: Pick<Highlight, 'start' | 'end'>): boolean {
  return a.start === b.start && a.end === b.end;
}

/* 清单里只留要用的几项（成片的路径不留：文件夹搬走了也能看） */
function shortClip(clip: ShowClip): ShowClip {
  const { index, title, postTitle, otherTitles, description, start, end, duration, score }: ShowClip = clip;

  return { index, title, postTitle, otherTitles, description, start, end, duration, score };
}

/* 一个切片做完（或者没做成）以后的清单 */
export function withResult(info: ShowInfo, item: Pick<Highlight, 'start' | 'end'>, result: ShowClip | string): ShowInfo {
  return {
    ...info,
    items: info.items.map((one: ShowItem): ShowItem => {
      if (!sameItem(one, item)) return one;

      const { problem: _problem, ...rest }: ShowItem = one;

      return typeof result === 'string' ? { ...rest, cut: false, problem: result } : { ...rest, cut: false, clip: shortClip(result) };
    })
  };
}
