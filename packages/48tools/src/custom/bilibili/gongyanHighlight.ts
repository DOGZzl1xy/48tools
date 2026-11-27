import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { getFFmpeg } from '../../utils/utils';
import { getSetting } from '../settings/settingsStore';
import { membersPrompt } from '../highlight/highlightMembers';
import { teamColorOf } from '../highlight/highlightTheme';
import { readGlossaryFile } from '../highlight/glossaryFile';
import { highlightGeminiConfig, highlightUnavailable, enqueueHighlight, isHighlightQueued } from '../highlight/highlightTask';
import { pickKey } from '../highlight/highlightShow';
import { getMemberDirectory, loadMemberDirectory } from '../room/memberDirectory';
import { DOWNLOAD_END, type HighlightJob, type HighlightProgress, type PreparedSource } from '../highlight/highlightPipeline';
import type { GongyanManifest } from './gongyanRecorder';
import { MANIFEST } from './gongyanFiles';
import { showNameOf } from './gongyanSchedule';
import { prepareGongyanSource } from './gongyanSource';

/**
 * B 站公演录完以后自动切片：读录像文件夹里的 manifest.json，把录下来的几段接起来、对好弹幕（./gongyanSource），
 * 然后交给切片队列（公演版的提示和排版，job.stage）。切片放在录像文件夹下面的「切片」里；录像本身留着。
 * 接入点：./gongyanWatcher（录完时调用）。
 */
const OUT_FOLDER: string = '切片';
const WORK_FOLDER: string = '.work';

/* 「2026-11-21」→「2026.11.21」 */
function dotDate(day: string): string {
  return day.replace(/-/g, '.');
}

export function stageJobOf(manifest: GongyanManifest, dir: string): HighlightJob {
  const outDir: string = path.join(dir, OUT_FOLDER);
  const team: string = manifest.show.team;
  const show: string = showNameOf(manifest.show.title);

  return {
    liveId: manifest.show.liveId,
    member: `SNH48 TEAM ${ team }`,
    title: show,
    date: dotDate(manifest.show.day),
    count: 'auto',
    autoScore: getSetting('highlightAutoScore'),
    outDir,
    workDir: path.join(outDir, WORK_FOLDER),
    ffmpeg: getFFmpeg(),
    gemini: highlightGeminiConfig(),
    glossary: readGlossaryFile(),
    members: membersPrompt(getMemberDirectory().members, ''),
    stage: {
      team,
      teamColor: teamColorOf(team),
      show,
      date: dotDate(manifest.show.day)
    }
  };
}

/**
 * 给录好的一场公演做切片（加到切片队列里）
 * @param { string } manifestFile - 录像文件夹里的 manifest.json
 * @return { Promise<string | undefined> } 不能开始时返回原因
 */
export async function startGongyanHighlight(manifestFile: string): Promise<string | undefined> {
  const dir: string = path.dirname(manifestFile);
  let manifest: GongyanManifest;

  try {
    manifest = JSON.parse(await fsP.readFile(manifestFile, 'utf8'));
  } catch {
    return `读不到 ${ MANIFEST }`;
  }

  const key: string = `gongyan-${ manifest.show.liveId }`;

  if (isHighlightQueued(key) || isHighlightQueued(pickKey(manifest.show))) return '这场公演已经在找爆点或者切片了，进度在下载队列里';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) {
    console.warn('B 站公演：录好了但不能切片', unavailable);

    return unavailable;
  }

  const job: HighlightJob = stageJobOf(manifest, dir);

  enqueueHighlight({
    key,
    title: `SNH48 TEAM ${ manifest.show.team } ${ job.title } 公演`,
    job,
    async prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> {
      // 成员名单一天更新一次：开始前确认是新的（取不到时用本机存的那份）
      await loadMemberDirectory();
      job.members = membersPrompt(getMemberDirectory().members, '') || job.members;

      return prepareGongyanSource({
        ffmpeg: job.ffmpeg, dir, manifest, workDir: job.workDir, onProgress: report, progressEnd: DOWNLOAD_END, signal
      });
    },
    retry: (): unknown => startGongyanHighlight(manifestFile)
  });

  return undefined;
}
