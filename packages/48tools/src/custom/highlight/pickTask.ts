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
import { membersPrompt } from './highlightMembers';
import {
  endWaiting, enqueueHighlight, findKeptReplay, highlightBaseDir, highlightDeps, highlightGeminiConfig, highlightUnavailable, isHighlightQueued,
  localSource, prepareLive, stopHighlight
} from './highlightTask';
import {
  cutHighlights, DOWNLOAD_END, type ClipResult, type CutResult, type HighlightJob, type HighlightProgress, type PreparedSource
} from './highlightPipeline';
import { findKeys, pickKey, planCuts, SHOW_FILE, withResult, type ShowInfo, type ShowItem } from './highlightShow';
import { forgetShow, setShowRoots, updateShow } from './showStore';

/**
 * 切片页面（./HighlightsPage）里「开始切片」「取消切片」「删除完整录播」：把挑好的做成切片，做一个记一个。
 * 素材和找爆点时一样准备：直播用工作文件夹里找爆点时下好的、或者自动抓取留着的录播，都没有就重新下载；公演用录像文件夹里的 mp4。
 * 和别的切片一起排队。
 */
const WORK_FOLDER: string = '.work'; // 和找爆点用同一个：下好的录播就在里面
const STAGE_FOLDER: string = '切片';

// 切片页面要看的文件夹：录播切片的保存位置，和 B 站公演的录像文件夹
setShowRoots((): Array<{ dir: string; sub?: string }> => {
  const live: string | undefined = highlightBaseDir();
  const stage: string | undefined = gongyanBaseDir();

  return [...(live ? [{ dir: live }] : []), ...(stage ? [{ dir: stage, sub: STAGE_FOLDER }] : [])];
});

function jobOf(dir: string, info: ShowInfo): HighlightJob {
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
    members: membersPrompt(getMemberDirectory().members, info.stage ? '' : info.member),
    radio: info.radio,
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

/**
 * 开始切挑好的（加到切片的队列里）
 * @param { string } dir - 这一场切片的文件夹
 * @param { ShowInfo } info
 * @return { string | undefined } 不能开始时返回原因
 */
export function startPick(dir: string, info: ShowInfo): string | undefined {
  const key: string = pickKey(info);
  const count: number = info.items.filter((item: ShowItem): boolean => item.cut).length;

  if (count === 0) return '还没有选要切的';

  if (isHighlightQueued(key)) return '这一场正在切，进度在下载队列里';

  if (findKeys(info).some(isHighlightQueued)) return '这一场正在重新找爆点，找完再切';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) return unavailable;

  const recordDir: string = path.dirname(dir); // 公演：切片在录像文件夹下面的「切片」里
  const manifest: GongyanManifest | undefined = info.stage ? readManifest(recordDir) : undefined;

  if (info.stage && !manifest) return '找不到这场公演的录像（录像文件夹里没有 manifest.json），没法切';

  const job: HighlightJob = jobOf(dir, info);

  enqueueHighlight({
    key,
    title: `${ info.member } ${ info.title }`,
    job,
    waiting: '排队中，等前面那场切完…',
    async prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> {
      if (manifest) {
        await loadMemberDirectory();
        job.members = membersPrompt(getMemberDirectory().members, '') || job.members;

        return prepareGongyanSource({
          ffmpeg: job.ffmpeg, dir: recordDir, manifest, workDir: job.workDir, onProgress: report, progressEnd: DOWNLOAD_END, signal
        });
      }

      // 自动抓取下好的：录播可能不在默认的文件夹里，用找爆点时记下的位置
      if (info.local && fs.existsSync(info.local.file)) return localSource(info.local.file, info.local.danmuFile, report, '用已经下好的录播');

      return prepareLive(job, info.member, report, signal);
    },
    async process(prepared: PreparedSource, report: (progress: HighlightProgress) => void, signal: AbortSignal): Promise<string> {
      // 排队的时候可能又改了：照最新的切
      const latest: ShowInfo = await updateShow(dir, (now: ShowInfo): ShowInfo => now) ?? info;

      // 取消以后又在下载队列里点了「重试」：没有要切的，录播也不能当成切完了删掉
      if (!latest.items.some((item: ShowItem): boolean => item.cut)) throw new Error('没有选要切的，到切片页面选好再切');
      const { clips, skipped }: CutResult = await cutHighlights(job, highlightDeps, prepared, latest, (progress: HighlightProgress): void => report({
        percent: DOWNLOAD_END + ((progress.percent / 100) * (100 - DOWNLOAD_END)), detail: progress.detail
      }), async (item: ShowItem, result: ClipResult | string): Promise<void> => {
        await updateShow(dir, (now: ShowInfo): ShowInfo => withResult(now, item, result));
      }, signal);

      await updateShow(dir, (now: ShowInfo): ShowInfo => ({ ...now, status: 'done' }));

      const text: string = [
        clips.length > 0 ? `做了 ${ clips.length } 个切片：${ clips.map((clip: ClipResult): string => clip.title).join('、') }` : '一个都没做成',
        ...skipped
      ].join('；');

      endWaiting(info.liveId, 'done', text);

      return text;
    },
    retry: (): unknown => startPick(dir, info)
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
 * 取消切片：正在切的停下来，选了的都改成不切，不再等人挑；自动抓取的那一项跟着结束（录播保留着），流程不会卡在这里。
 * 爆点清单、做好的切片、本机的录播都留着
 */
export async function cancelShow(dir: string, info: ShowInfo): Promise<void> {
  await stopHighlight(pickKey(info));
  await updateShow(dir, (now: ShowInfo): ShowInfo => ({
    ...now, status: 'done', items: now.items.map((item: ShowItem): ShowItem => ({ ...item, cut: false }))
  }));
  endWaiting(info.liveId, 'stopped', '取消了切片');
}

/* 从列表移除：先取消，再删掉爆点清单；切片、切片说明、录播都不动 */
export async function removeShow(dir: string, info: ShowInfo): Promise<void> {
  if (isBusy(info) || info.status === 'waiting') await cancelShow(dir, info);

  await fsP.rm(path.join(dir, SHOW_FILE), { force: true });
  forgetShow(dir);
}
