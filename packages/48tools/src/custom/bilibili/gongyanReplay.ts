import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { requestLiveOne, type LiveOne, type LiveOnePlayStreams } from '@48tools-api/48';
import { beijingDate } from '../room/roomTime';
import { getMemberDirectory, loadMemberDirectory } from '../room/memberDirectory';
import { safeFileName } from '../highlight/highlightTime';
import { mediaDuration } from '../highlight/highlightFfmpeg';
import { membersPrompt } from '../highlight/highlightMembers';
import { DOWNLOAD_END, type HighlightJob, type HighlightProgress, type PreparedSource } from '../highlight/highlightPipeline';
import { enqueueHighlight, highlightUnavailable, isHighlightQueued, downloadStream } from '../highlight/highlightTask';
import { pickKey } from '../highlight/highlightShow';
import { teamOfShow, showNameOf } from './gongyanSchedule';
import { MANIFEST, findRecordingDir, recordingFolderName } from './gongyanFiles';
import { gongyanBaseDir } from './gongyanWatcher';
import { stageJobOf } from './gongyanHighlight';
import { prepareGongyanSource } from './gongyanSource';
import type { GongyanManifest } from './gongyanRecorder';

/**
 * 用口袋48 的公演录播做公演切片（「公演录播」页每一行的「公演切片」）。
 * B 站直播当时没录到的场次用它补（例如 2026-11-22 SII《48Hz》：那时 SII 不在要录的队里）。
 * 口袋48 的公演录播没有弹幕，所以成片右边没有弹幕；失误的起止找不到弹幕的反应，用模型给的时间前后多留一些。
 * 下载和别的录播下载排队（一次只下一场），进度在下载队列里；下好的 mp4 和 manifest.json 放在「B站公演」下这场的文件夹里，
 * 和 B 站录的一样，重切时直接用。B 站已经录过这场（文件夹里有 manifest.json）就不再下载，直接用录好的。
 * 接入点：pages/48/Live48/InVideo/InVideo.tsx。
 */
export interface StageReplayShow {
  liveId: string;
  title: string;      // 《48Hz》公演
  subTitle: string;   // TEAM SII 剧场公演
  stime: string;      // 开始时间（毫秒）
}

/* 这场能不能切：只有 SNH48 SII、NII、HII、X 的公演（返回队名） */
export function stageReplayTeam(show: Pick<StageReplayShow, 'title' | 'subTitle'>): string | undefined {
  return teamOfShow(show);
}

/* 公演录播的地址：清晰度最高的那个（列表里最后一个有地址的） */
async function replayUrl(liveId: string): Promise<string> {
  const res: LiveOne = await requestLiveOne(liveId);
  const streams: Array<LiveOnePlayStreams> = (res?.content?.playStreams ?? []).filter((item: LiveOnePlayStreams): boolean => Boolean(item.streamPath));
  const url: string | undefined = streams.at(-1)?.streamPath;

  if (!url) throw new Error('这场公演没有录播地址（可能还没生成）');

  return url;
}

/**
 * 开始用口袋48 的公演录播做切片（加到切片队列里，先下载再切）
 * @param { StageReplayShow } show - 公演录播列表里的一行
 * @return { string | undefined } 不能开始时返回原因
 */
export function startStageReplayHighlight(show: StageReplayShow): string | undefined {
  const team: string | undefined = stageReplayTeam(show);

  if (!team) return '只能切 SNH48 SII、NII、HII、X 的公演（认不出这场是哪个队的）';

  if (isHighlightQueued(show.liveId) || isHighlightQueued(pickKey(show))) return '这场公演已经在找爆点或者切片了，进度在下载队列里';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) return unavailable;

  const baseDir: string | undefined = gongyanBaseDir();

  if (!baseDir) return '还没有设置保存位置（设置 → 保存位置）';

  const recorded: { dir: string; manifest: GongyanManifest } | undefined = findRecordingDir(baseDir, show.liveId);
  const day: string = beijingDate(Number(show.stime));
  const dir: string = recorded?.dir ?? path.join(baseDir, recordingFolderName({ day, team, title: show.title }));
  const manifest: GongyanManifest = recorded?.manifest ?? {
    version: 1,
    room: 0,
    show: { liveId: show.liveId, title: show.title, subTitle: show.subTitle, team, day },
    biliTitle: '',
    cover: '',
    startedAt: Number(show.stime),
    endedAt: Number(show.stime), // 写上结束时间：程序重启时不会当成没录完的场次去接着录
    parts: [],
    danmu: 'danmu.lrc',          // 没有这个文件：口袋48 的公演录播不带弹幕
    danmuCount: 0
  };
  const job: HighlightJob = stageJobOf(manifest, dir);

  enqueueHighlight({
    key: show.liveId,
    title: `公演 ${ team } ${ showNameOf(show.title) }`,
    job,
    async prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> {
      await loadMemberDirectory();
      job.members = membersPrompt(getMemberDirectory().members, '') || job.members;

      // B 站录过这场，或者上次已经下好了：用录好的
      if (recorded || (manifest.joined && fs.existsSync(path.join(dir, manifest.joined)))) {
        return prepareGongyanSource({ ffmpeg: job.ffmpeg, dir, manifest, workDir: job.workDir, onProgress: report, progressEnd: DOWNLOAD_END, signal });
      }

      const joined: string = `${ safeFileName(show.title, 80) }.mp4`;
      const output: string = path.join(dir, joined);

      await fsP.mkdir(dir, { recursive: true });
      report({ percent: 0, detail: '取公演录播的地址…' });
      await downloadStream(await replayUrl(show.liveId), output, (percent: number, detail: string): void => {
        report({ percent: (percent / 100) * DOWNLOAD_END, detail });
      }, signal, path.join(job.workDir, 'replay'));

      const duration: number = await mediaDuration(job.ffmpeg, output, signal);

      manifest.parts = [{ file: joined, start: Number(show.stime), end: Number(show.stime) + Math.round(duration * 1000), duration: Number(duration.toFixed(3)) }];
      manifest.joined = joined;
      manifest.biliTitle = '口袋48公演录播（没有弹幕）';
      await fsP.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
      report({ percent: DOWNLOAD_END, detail: '公演录播下好了（口袋48 的公演录播没有弹幕）' });

      return { source: output, danmu: [] };
    },
    retry: (): unknown => startStageReplayHighlight(show)
  });

  return undefined;
}
