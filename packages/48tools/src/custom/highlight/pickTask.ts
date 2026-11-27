import { promises as fsP } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFFmpeg } from '../../utils/utils';
import { trashFile } from '../common/trashFile';
import { prepareGongyanSource } from '../bilibili/gongyanSource';
import { readManifest } from '../bilibili/gongyanFiles';
import { gongyanBaseDir } from '../bilibili/gongyanWatcher';
import type { GongyanManifest, GongyanPart } from '../bilibili/gongyanRecorder';
import { getMemberDirectory, loadMemberDirectory } from '../room/memberDirectory';
import { readGlossaryFile } from './glossaryFile';
import { readBackground } from '../learn/learnStore';
import { membersPrompt } from './highlightMembers';
import { memberTeamOf, teamColorOf } from './highlightTheme';
import {
  endWaiting, enqueueHighlight, findKeptReplay, highlightBaseDir, highlightDeps, highlightGeminiConfig, highlightUnavailable, isHighlightQueued,
  localSource, prepareLive, stopHighlight
} from './highlightTask';
import {
  renderDrafts, retitleClip, writeDrafts, DOWNLOAD_END, type ClipResult, type HighlightJob, type HighlightProgress, type PreparedSource
} from './highlightPipeline';
import {
  findKeys, nextStatus, pickKey, planCuts, readyToRender, sameItem, SHOW_FILE, toWrite, withDraft, withResult, type ShowInfo, type ShowItem
} from './highlightShow';
import { coversRoot } from './highlightCover';
import { forgetShow, setShowRoots, updateShow } from './showStore';
import type { ClipDraft } from './highlightTypes';

/**
 * 切片页面（./HighlightsPage）里的几个按钮：
 *   - 写标题（startWrite）：给选了的写字幕、标题、亮点，写一个记一个，写完停下来等人定
 *   - 开始渲染（startRender）：把定好的渲染成切片，做一个记一个
 *   - 重做标题和封面（startRetitle）：做好的切片改了标题、亮点，只换那一条和封面
 *   - 取消切片、删除完整录播、从列表移除
 * 写标题、渲染的素材和找爆点时一样准备：直播用工作文件夹里找爆点时下好的、或者自动抓取留着的录播，都没有就重新下载；公演用录像文件夹里的 mp4。
 * 和别的切片一起排队。
 */
const WORK_FOLDER: string = '.work'; // 和找爆点用同一个：下好的录播就在里面
const STAGE_FOLDER: string = '切片';

export const WRITE_KIND: string = '写标题'; // 下载队列里的任务种类
export const RETITLE_KIND: string = '改标题';


// 切片页面要看的文件夹：录播切片的保存位置，和 B 站公演的录像文件夹
setShowRoots((): Array<{ dir: string; sub?: string }> => {
  const live: string | undefined = highlightBaseDir();
  const stage: string | undefined = gongyanBaseDir();

  return [...(live ? [{ dir: live }] : []), ...(stage ? [{ dir: stage, sub: STAGE_FOLDER }] : [])];
});

function jobOf(dir: string, info: ShowInfo): HighlightJob {
  const directory: ReturnType<typeof getMemberDirectory> = getMemberDirectory();
  const team: string | undefined = info.stage ? info.stage.team : memberTeamOf(directory.members, info.member);

  return {
    liveId: info.liveId,
    member: info.member,
    title: info.title,
    date: info.date,
    count: 'auto',
    outDir: dir,
    workDir: path.join(dir, WORK_FOLDER),
    ffmpeg: getFFmpeg(),
    gemini: highlightGeminiConfig(),
    glossary: readGlossaryFile(),
    learned: readBackground(),
    members: membersPrompt(directory.members, info.stage ? '' : info.member),
    radio: info.radio,
    team,
    teamColor: info.stage ? info.stage.teamColor : teamColorOf(team),
    stage: info.stage
  };
}

export interface ReplayFile {
  path: string;
  name: string;
  size: number; // 字节
}

/**
 * 这一场留在本机的完整录播：找爆点时下好等着切的、自动抓取或者手动下好的（连同名的弹幕 .lrc、电台封面 .jpg），公演的录像
 * @return { Array<ReplayFile> } 录播在最前面；本机没有时是空的
 */
export function replayFiles(dir: string, info: ShowInfo): Array<ReplayFile> {
  const files: Array<string> = [];

  if (info.stage) {
    const recordDir: string = path.dirname(dir);
    const manifest: GongyanManifest | undefined = readManifest(recordDir);

    manifest?.joined && files.push(path.join(recordDir, manifest.joined));
    manifest?.parts.forEach((part: GongyanPart): unknown => files.push(path.join(recordDir, part.file)));
  } else {
    const kept: string | undefined = info.local?.file ?? findKeptReplay(info.liveId, Boolean(info.radio))?.file;

    files.push(path.join(dir, WORK_FOLDER, 'source.mp4'));
    kept && files.push(kept, ...['.lrc', '.jpg'].map((ext: string): string => kept.replace(/\.[^.\\/]+$/, ext)));
  }

  return Array.from(new Set(files)).flatMap((file: string): Array<ReplayFile> => {
    try {
      return [{ path: file, name: path.basename(file), size: fs.statSync(file).size }];
    } catch {
      return []; // 没有这个文件
    }
  });
}

/* 本机的完整录播一共多大（字节）；没有是 0 */
export function replayBytes(dir: string, info: ShowInfo): number {
  return replayFiles(dir, info).reduce((sum: number, file: ReplayFile): number => sum + file.size, 0);
}

/* 这一场正在切、正在重新找 */
export function isBusy(info: ShowInfo): boolean {
  return [pickKey(info), ...findKeys(info)].some(isHighlightQueued);
}

/* 删除本机的完整录播（放进回收站）；切片、清单不动 */
export async function deleteReplay(dir: string, info: ShowInfo): Promise<void> {
  if (isBusy(info)) throw new Error('这一场正在切片或者找爆点，先取消再删');

  for (const file of replayFiles(dir, info)) {
    try {
      await trashFile(file.path);
    } catch (err) {
      console.error('放进回收站失败', file.path, err);

      throw new Error(`没有删掉 ${ file.name }（可能正被别的程序占用）`);
    }
  }

  // 工作文件夹里剩下的（下载到一半的、封面）没有录播也用不上了
  await fsP.rm(path.join(dir, WORK_FOLDER), { recursive: true, force: true });
  await updateShow(dir, (now: ShowInfo): ShowInfo => ({ ...now })); // 清单没变，让界面重新看一眼录播还在不在
}

/* 这一场能不能开始做；不能时返回原因 */
function busyProblem(info: ShowInfo): string | undefined {
  if (isHighlightQueued(pickKey(info))) return '这一场正在做，进度在下载队列里';

  if (findKeys(info).some(isHighlightQueued)) return '这一场正在重新找爆点，找完再切';

  return undefined;
}

/* 公演的录像在哪里（切片在录像文件夹下面的「切片」里）；不是公演是 undefined */
function stageManifest(dir: string, info: ShowInfo): GongyanManifest | undefined {
  return info.stage ? readManifest(path.dirname(dir)) : undefined;
}

/* 准备这一场的录播和弹幕：直播用找爆点时下好的、自动抓取留着的，都没有就重新下载；公演用录像文件夹里的 */
async function prepareShow(
  dir: string, info: ShowInfo, job: HighlightJob, signal: AbortSignal, report: (progress: HighlightProgress) => void
): Promise<PreparedSource> {
  const manifest: GongyanManifest | undefined = stageManifest(dir, info);

  if (manifest) {
    await loadMemberDirectory();
    job.members = membersPrompt(getMemberDirectory().members, '') || job.members;

    return prepareGongyanSource({
      ffmpeg: job.ffmpeg, dir: path.dirname(dir), manifest, workDir: job.workDir, onProgress: report, progressEnd: DOWNLOAD_END, signal
    });
  }

  // 自动抓取下好的：录播可能不在默认的文件夹里，用找爆点时记下的位置
  if (info.local && fs.existsSync(info.local.file)) return localSource(info.local.file, info.local.danmuFile, report, '用已经下好的录播');

  return prepareLive(job, info.member, report, signal);
}

/* 准备好以后的进度：占总进度的 DOWNLOAD_END ~ 100 */
function afterPrepare(report: (progress: HighlightProgress) => void): (progress: HighlightProgress) => void {
  return (progress: HighlightProgress): void => report({ percent: DOWNLOAD_END + ((progress.percent / 100) * (100 - DOWNLOAD_END)), detail: progress.detail });
}

/* 写完、渲染完：记下这一场的状态；都好了就删掉工作文件夹（里面可能有整场录播，很大），告诉自动抓取 */
async function settle(dir: string, info: ShowInfo, text: string): Promise<void> {
  const latest: ShowInfo | undefined = await updateShow(dir, (now: ShowInfo): ShowInfo => ({ ...now, status: nextStatus(now) }));

  if (!latest || latest.status !== 'done') return;

  await fsP.rm(path.join(dir, WORK_FOLDER), { recursive: true, force: true }).catch((): void => undefined);
  endWaiting(info.liveId, 'done', text);
}

/**
 * 给挑好的写字幕、标题、亮点（加到切片的队列里），写完停下来等人定
 * @param { string } dir - 这一场切片的文件夹
 * @param { ShowInfo } info
 * @return { string | undefined } 不能开始时返回原因
 */
export function startWrite(dir: string, info: ShowInfo): string | undefined {
  if (!info.items.some(toWrite)) return '还没有选要切的';

  const problem: string | undefined = busyProblem(info) ?? highlightUnavailable();

  if (problem) return problem;

  if (info.stage && !stageManifest(dir, info)) return '找不到这场公演的录像（录像文件夹里没有 manifest.json），没法切';

  const job: HighlightJob = jobOf(dir, info);

  enqueueHighlight({
    key: pickKey(info),
    title: `${ info.member } ${ info.title }`,
    kind: WRITE_KIND,
    notice: '标题写好了，等你定',
    job,
    waiting: '排队中，等前面那场做完…',
    prepare: (signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> => prepareShow(dir, info, job, signal, report),
    async process(prepared: PreparedSource, report: (progress: HighlightProgress) => void, signal: AbortSignal): Promise<string> {
      // 排队的时候可能又改了：照最新的写
      const latest: ShowInfo = await updateShow(dir, (now: ShowInfo): ShowInfo => ({ ...now, source: prepared.source, picture: prepared.picture })) ?? info;

      // 取消以后又在下载队列里点了「重试」：没有要切的，录播也不能当成切完了删掉
      if (!latest.items.some(toWrite)) throw new Error('没有选要切的，到切片页面选好再写');

      const { written, skipped }: { written: number; skipped: Array<string> } = await writeDrafts(job, highlightDeps, prepared, latest, afterPrepare(report),
        async (item: ShowItem, draft: ClipDraft | string): Promise<void> => {
          await updateShow(dir, (now: ShowInfo): ShowInfo => withDraft(now, item, draft));
        }, signal);
      const text: string = [written > 0 ? `写好了 ${ written } 个，等你定标题和亮点` : '一个都没写成', ...skipped].join('；');

      await settle(dir, info, text);

      return text;
    },
    retry: (): unknown => startWrite(dir, info)
  });

  return undefined;
}

/**
 * 重新写一个：丢掉写好的标题、亮点、字幕，再问一次 Gemini
 * @return { Promise<string | undefined> } 不能开始时返回原因（写好的不动）
 */
export async function rewrite(dir: string, info: ShowInfo, item: ShowItem): Promise<string | undefined> {
  const problem: string | undefined = busyProblem(info) ?? highlightUnavailable();

  if (problem) return problem;

  const now: ShowInfo | undefined = await updateShow(dir, (latest: ShowInfo): ShowInfo => ({
    ...latest,
    items: latest.items.map((one: ShowItem): ShowItem => {
      if (!sameItem(one, item)) return one;

      const { draft: _draft, ...rest }: ShowItem = one;

      return { ...rest, cut: true };
    })
  }));

  return now && startWrite(dir, now);
}

/**
 * 把定好了标题的渲染成切片（加到切片的队列里）
 * @return { string | undefined } 不能开始时返回原因
 */
export function startRender(dir: string, info: ShowInfo): string | undefined {
  if (!info.items.some(readyToRender)) return '还没有写好的，先写标题';

  const problem: string | undefined = busyProblem(info);

  if (problem) return problem;

  if (info.stage && !stageManifest(dir, info)) return '找不到这场公演的录像（录像文件夹里没有 manifest.json），没法切';

  const job: HighlightJob = jobOf(dir, info);

  enqueueHighlight({
    key: pickKey(info),
    title: `${ info.member } ${ info.title }`,
    job,
    waiting: '排队中，等前面那场做完…',
    prepare: (signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> => prepareShow(dir, info, job, signal, report),
    async process(prepared: PreparedSource, report: (progress: HighlightProgress) => void, signal: AbortSignal): Promise<string> {
      const latest: ShowInfo = await updateShow(dir, (now: ShowInfo): ShowInfo => now) ?? info;

      if (!latest.items.some(readyToRender)) throw new Error('没有选要切的，到切片页面选好再渲染');

      const clips: Array<ClipResult> = await renderDrafts(job, prepared, latest, afterPrepare(report), async (item: ShowItem, result: ClipResult): Promise<void> => {
        await updateShow(dir, (now: ShowInfo): ShowInfo => withResult(now, item, result));
      }, signal);
      const text: string = `做了 ${ clips.length } 个切片：${ clips.map((clip: ClipResult): string => clip.title).join('、') }`;

      await settle(dir, info, text);

      return text;
    },
    retry: (): unknown => startRender(dir, info)
  });

  return undefined;
}

/* 做好的切片的文件：编号开头的 mp4（标题可能改过，按编号找） */
export function clipFileOf(dir: string, item: ShowItem): string | undefined {
  if (!item.clip) return undefined;

  try {
    const head: string = `${ String(item.clip.index).padStart(2, '0') }-`;
    const name: string | undefined = fs.readdirSync(dir).find((file: string): boolean => file.startsWith(head) && file.endsWith('.mp4'));

    return name && path.join(dir, name);
  } catch {
    return undefined;
  }
}

/**
 * 做好的切片改了标题、亮点、封面的画面：只换标题那一条、重做封面和说明（不用录播，也不问 Gemini）
 * @return { string | undefined } 不能开始时返回原因
 */
export function startRetitle(dir: string, info: ShowInfo, item: ShowItem): string | undefined {
  const problem: string | undefined = busyProblem(info);

  if (problem) return problem;

  if (!clipFileOf(dir, item)) return '这个切片的文件不在了（可能搬走或者删了）';

  const job: HighlightJob = jobOf(dir, info);

  enqueueHighlight({
    key: pickKey(info),
    title: `${ info.member } ${ info.title }`,
    kind: RETITLE_KIND,
    notice: '标题和封面改好了',
    job,
    waiting: '排队中，等前面那场做完…',
    prepare: (): Promise<PreparedSource> => Promise.resolve({ source: '', danmu: [] }),
    async process(_prepared: PreparedSource, report: (progress: HighlightProgress) => void, signal: AbortSignal): Promise<string> {
      const latest: ShowInfo | undefined = await updateShow(dir, (show: ShowInfo): ShowInfo => show);
      const now: ShowItem | undefined = latest?.items.find((one: ShowItem): boolean => sameItem(one, item));
      const video: string | undefined = now && clipFileOf(dir, now);

      if (!now || !video) throw new Error('这个切片的文件不在了（可能搬走或者删了）');

      const result: ClipResult = await retitleClip(job, now, video, report, signal);

      await updateShow(dir, (show: ShowInfo): ShowInfo => withResult(show, now, result));

      return `改好了 ${ String(result.index).padStart(2, '0') }：${ result.title }`;
    },
    retry: (): unknown => startRetitle(dir, info, item)
  });

  return undefined;
}

/* 这一场要切的编号（界面上预告「04 ~ 06」用） */
export function plannedIndexes(dir: string, info: ShowInfo): Array<number> {
  let names: Array<string> = [];

  try {
    names = fs.readdirSync(dir);
  } catch { /* 还没有这个文件夹 */ }

  return planCuts(info, names).map(({ index }: { index: number }): number => index);
}

/**
 * 取消切片：正在做的停下来，选了的都改成不切，不再等人挑、等人定标题（写好的留着，以后选上还能接着用）；自动抓取的那一项跟着结束（录播保留着），流程不会卡在这里。
 * 爆点清单、做好的切片、本机的录播都留着
 */
export async function cancelShow(dir: string, info: ShowInfo): Promise<void> {
  await stopHighlight(pickKey(info));
  await updateShow(dir, (now: ShowInfo): ShowInfo => ({
    ...now, status: 'done', items: now.items.map((item: ShowItem): ShowItem => ({ ...item, cut: false }))
  }));
  endWaiting(info.liveId, 'stopped', '取消了切片');
}

/* 从列表移除：先取消，再删掉爆点清单（和写好的标题、封面候选）；切片、切片说明、录播都不动 */
export async function removeShow(dir: string, info: ShowInfo): Promise<void> {
  if (isBusy(info) || info.status !== 'done') await cancelShow(dir, info);

  await fsP.rm(path.join(dir, SHOW_FILE), { force: true });
  await fsP.rm(coversRoot(dir), { recursive: true, force: true }); // 封面候选：没有清单就没用了
  forgetShow(dir);
}
