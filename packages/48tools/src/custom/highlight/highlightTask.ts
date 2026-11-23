import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
// @ts-expect-error
import got from 'got';
import { requestLiveRoomInfo, requestDownloadFile, type LiveRoomInfo } from '@48tools-api/48';
import { getFFmpeg } from '../../utils/utils';
import { engineUserAgent, source } from '../../utils/snh48';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { SEGMENT_TIMEOUT, segmentViaProxy } from '../download/segmentRetry';
import { pocket48Agent } from '../pocket48Proxy/pocket48Proxy';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import {
  prepareHighlight, processHighlight, saveRadioCover, DOWNLOAD_END,
  type HighlightJob, type HighlightDeps, type HighlightProgress, type HighlightResult, type ClipResult, type PreparedSource
} from './highlightPipeline';
import { highlightDefaults, type GeminiConfig } from './highlightGemini';
import { StagedQueue, type QueueStage, type QueueOutcome } from './highlightQueue';
import { recognizeAudio, isAlignerInstalled } from './alignerRun';
import { readGlossaryFile } from './glossaryFile';
import type { TimedToken } from './highlightTokens';
import { safeFileName, parseLrc } from './highlightTime';
import { downloadReplay, type DownloadProgress } from './highlightDownload';
import { membersPrompt } from './highlightMembers';
import { getMemberDirectory, loadMemberDirectory } from '../room/memberDirectory';
import { beijingDate } from '../room/roomTime';
import type { HighlightCount } from './highlightTypes';
import { getLiveRecordDir } from '../live/liveRecording';
import { keptReplayOf } from '../live/replayGrabCore';

/**
 * 录播自动切片接到程序里的部分：从设置里读 Gemini 的 key 和保存位置，登记到下载队列，排队执行。
 * 真正干活的是 ./highlightPipeline，排队的规则在 ./highlightQueue：
 * 同一时间只切一场（合成视频很吃 CPU），前一场开始切的时候后一场就开始下载录播；同一场录播不会重复加。
 * 接入点：./HighlightDialog（录播列表里点「自动切片」后的对话框）。
 */
export interface HighlightRecord {
  liveId: string;
  title: string;
  ctime: string;
  liveType?: number; // 1：直播，2：电台
  userInfo: { nickname: string };
}

const OUT_FOLDER: string = '录播切片';
const WORK_FOLDER: string = '.work';
const queue: StagedQueue<PreparedSource> = new StagedQueue();

/* 视频直播和电台都能切（电台用电台封面当画面，用户 2026-11-23 定的） */
export function canHighlight(record: HighlightRecord): boolean {
  return [1, 2].includes(Number(record.liveType));
}

export function isRadio(record: Pick<HighlightRecord, 'liveType'>): boolean {
  return Number(record.liveType) === 2;
}

/* 这场录播的切片任务在下载队列里的 id */
export function highlightTaskId(liveId: string): string {
  return `highlight:${ liveId }`;
}

export function highlightGeminiConfig(): GeminiConfig {
  return {
    apiKey: getSetting('sttGeminiKey') ?? '',
    model: getSetting('highlightModel') || highlightDefaults.model,
    baseUrl: getSetting('sttGeminiBaseUrl') || highlightDefaults.baseUrl,
    via: getSetting('highlightVia') === 'agy' ? 'agy' : 'api',
    agyModel: getSetting('highlightAgyModel') || undefined
  };
}

/* 切片保存在哪个文件夹：设置里指定的，或者「默认保存文件夹 / 录播切片」；都没有时返回 undefined */
export function highlightBaseDir(): string | undefined {
  const own: string | undefined = resolveLocalDir(getSetting('highlightDir'));

  if (own) return own;

  const download: string | undefined = resolveLocalDir(getSetting('downloadDir'));

  return download ? path.join(download, OUT_FOLDER) : undefined;
}

/* 成员名字：SNH48-沈馨 → SNH48 沈馨 */
function memberName(nickname: string): string {
  return nickname.replace(/-/g, ' ').trim();
}

export function highlightJobOf(record: HighlightRecord, count: HighlightCount, baseDir: string): HighlightJob {
  const day: string = beijingDate(Number(record.ctime)); // 文件夹名、画面和发布标题上的日期都按北京时间
  const folder: string = safeFileName(`${ record.userInfo.nickname }_${ record.title }_${ day }_${ record.liveId }`, 90);
  const outDir: string = path.join(baseDir, folder);

  return {
    liveId: record.liveId,
    member: memberName(record.userInfo.nickname),
    title: record.title,
    date: day.replace(/-/g, '.'),
    count,
    autoScore: getSetting('highlightAutoScore'),
    outDir,
    workDir: path.join(outDir, WORK_FOLDER),
    ffmpeg: getFFmpeg(),
    gemini: highlightGeminiConfig(),
    glossary: readGlossaryFile(),
    members: membersPrompt(getMemberDirectory().members, record.userInfo.nickname),
    radio: isRadio(record)
  };
}

function doneText(result: HighlightResult): string {
  if (result.clips.length === 0) {
    return result.found === 0 ? '这场录播里没有找到值得剪的片段' : '找到的片段剪完都太短，没有做成切片';
  }

  return `做了 ${ result.clips.length } 个切片：${ result.clips.map((clip: ClipResult): string => clip.title).join('、') }`;
}

function notify(title: string, body: string): void {
  try {
    typeof Notification !== 'undefined' && new Notification(title, { body });
  } catch { /* 系统不让弹通知就算了，下载队列里也看得到 */ }
}

/**
 * 下载录播的一个分片：和普通录播下载用同样的请求头和超时（卡住就断开，由调用的地方重试）。
 * 直连失败两次以后改走口袋48代理（个别分片从美国的 CDN 节点每次都下不来，走国内节点就好，见 ../download/segmentRetry）
 */
async function fetchSegment(uri: string, file: string, signal: AbortSignal, attempt: number = 0): Promise<number> {
  await pipeline(
    got.stream(uri, {
      headers: { Host: new URL(uri).hostname, 'User-Agent': engineUserAgent },
      timeout: SEGMENT_TIMEOUT,
      agent: segmentViaProxy(attempt) ? pocket48Agent() : undefined
    }),
    fs.createWriteStream(file),
    { signal });

  const size: number = (await fsP.stat(file)).size;

  if (size === 0) throw new Error('下载到的分片是空的');

  return size;
}

/* 下载一张图（电台封面）：先写到旁边的临时文件，是图片才换上去（不会把兜底的那一帧换成一个网页） */
async function fetchImage(url: string, file: string, signal?: AbortSignal): Promise<void> {
  const res: { headers: Record<string, string | undefined>; body: Buffer } = await got(url, {
    responseType: 'buffer', timeout: { request: 60_000 }, signal
  });

  if (!res.headers['content-type']?.startsWith('image/') || res.body.length < 1_000) throw new Error(`不是图片：${ res.headers['content-type'] }`);

  await fsP.writeFile(`${ file }.part`, res.body);
  await fsP.rename(`${ file }.part`, file);
}

const deps: HighlightDeps = {
  async liveInfo(liveId: string): Promise<{ playStreamPath: string; msgFilePath: string; coverUrl?: string }> {
    const res: LiveRoomInfo = await requestLiveRoomInfo(liveId);

    if (!res.success || !res.content) throw new Error(res.message || '取不到这场录播的信息');

    const coverPath: string | undefined = (res.content as { coverPath?: string }).coverPath;

    return { playStreamPath: res.content.playStreamPath, msgFilePath: res.content.msgFilePath, coverUrl: source(coverPath) || undefined };
  },
  fetchText: (url: string): Promise<string> => requestDownloadFile(url),
  fetchImage,
  fetchSegment,
  // 装了本地打轴模型就用它给字幕定时间；没装时返回 null，流程用 Gemini 给的时间
  recognize: (audioFile: string, signal?: AbortSignal): Promise<Array<TimedToken> | null> => recognizeAudio(getFFmpeg(), audioFile, signal)
};

/* 本机已经有的录播和弹幕（.lrc）当作切片的素材；录播被删了就报错（可以在下载队列里看到原因） */
async function localSource(
  file: string, danmuFile: string | undefined, report: (progress: HighlightProgress) => void, detail: string
): Promise<PreparedSource> {
  await fsP.access(file);
  report({ percent: DOWNLOAD_END, detail });

  let danmu: string = '';

  if (danmuFile) {
    try {
      danmu = await fsP.readFile(danmuFile, 'utf8');
    } catch (err) {
      console.warn('读不到弹幕文件，成片里不显示弹幕', err);
    }
  }

  // 电台的录音（.m4a）：旁边同名的 .jpg 是下载时存的电台封面，当成片的画面
  const picture: string = file.replace(/\.[^.\\/]+$/, '.jpg');

  return { source: file, danmu: danmu ? parseLrc(danmu) : [], picture: /\.m4a$/i.test(file) && fs.existsSync(picture) ? picture : undefined };
}

/* 自动抓取下好、还留着的这场录播（在直播录制文件夹里；没有返回 undefined）。电台找的是录音 */
function findKeptReplay(liveId: string, radio: boolean): { file: string; danmuFile?: string } | undefined {
  const dir: string = getLiveRecordDir('');

  if (!dir) return undefined;

  let names: Array<string>;

  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }

  const kept: { file: string; danmuFile?: string } | undefined = keptReplayOf(names, liveId, radio);

  return kept && { file: path.join(dir, kept.file), danmuFile: kept.danmuFile && path.join(dir, kept.danmuFile) };
}

/* 现在能不能做切片（保存位置、Gemini 的设置）；不能时返回原因 */
export function highlightUnavailable(): string | undefined {
  if (!highlightBaseDir()) return '还没有设置保存位置';

  const gemini: GeminiConfig = highlightGeminiConfig();

  if (gemini.via === 'agy') {
    if (!isAlignerInstalled()) return '通过本机的 agy 做切片时，要先在「设置 → 录播切片」里安装「本地打轴模型」';
  } else if (!gemini.apiKey.trim()) {
    return '还没有填写 Gemini 的 API key（设置 → 语音转文字）';
  }

  return undefined;
}

export interface QueuedHighlight {
  key: string;     // 排队用的 id（同一个 key 同时只能有一个）
  title: string;   // 下载队列里显示的
  job: HighlightJob;
  // 第 1 步：准备好整场的视频和弹幕（下载录播，或者把录下来的几段接起来）
  prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource>;
  retry(): unknown;
  whenEnded?(outcome: QueueOutcome, text: string): void;
}

/* 加到切片的队列里（同一时间只切一场，前一场开始切的时候后一场就开始准备），进度在下载队列里 */
export function enqueueHighlight(item: QueuedHighlight): void {
  const { key, job }: QueuedHighlight = item;
  const id: string = highlightTaskId(key);
  let started: boolean = false; // 开始下载了没有（停止时的说明不一样）
  let text: string = '';        // 做完后显示的说明

  function report(progress: HighlightProgress): void {
    queueTaskProgress(id, progress.percent, progress.detail);
  }

  queueTaskStart({
    id,
    title: item.title,
    kind: '切片',
    filePath: job.outDir,
    percent: 0,
    detail: '排队中，等前面那场开始切片后就开始准备…',
    stop: (): void => queue.stop(key),
    retry: item.retry
  });
  queue.add({
    id: key,
    prepare: (signal: AbortSignal): Promise<PreparedSource> => item.prepare(signal, report),
    async process(prepared: PreparedSource, signal: AbortSignal): Promise<void> {
      text = doneText(await processHighlight(job, deps, prepared, report, signal));
    },
    onStage(stage: QueueStage): void {
      if (stage === 'preparing') started = true;

      if (stage === 'ready') queueTaskProgress(id, DOWNLOAD_END, '准备好了，等前面那场切完就开始…');
    },
    onEnd(outcome: QueueOutcome, err?: unknown): void {
      if (outcome === 'done') {
        queueTaskEnd(id, 'done', undefined, text);
        notify(`切片完成：${ job.member } ${ job.title }`, text);
      } else if (outcome === 'stopped') {
        queueTaskEnd(id, 'stopped', undefined, started
          ? '已停止。再点「重试」会接着做，已经准备好的部分不用重来'
          : '已取消，还没有开始');
      } else {
        console.error('自动切片失败', err);
        queueTaskEnd(id, 'error', err instanceof Error ? err.message : String(err));
      }

      item.whenEnded?.(outcome, text);
    }
  });
}

/* 这个 key 是不是正在排队或者切片 */
export function isHighlightQueued(key: string): boolean {
  return queue.has(key);
}

/**
 * 开始给一场录播做切片（加到下载队列里，排队执行）
 * @param { HighlightRecord } record - 录播列表里的一行
 * @param { HighlightCount } count - 做几个，或者 'auto'
 * @param { (outcome: QueueOutcome, text: string) => void } [whenEnded] - 做完、停止或失败后调用（「自动抓取并切片」用它在切完后删掉录像）；
 *   在下载队列里点「重试」重新开始时也会带上
 * @return { string | undefined } 不能开始时返回原因
 */
export function startHighlight(
  record: HighlightRecord, count: HighlightCount, whenEnded?: (outcome: QueueOutcome, text: string) => void
): string | undefined {
  if (!canHighlight(record)) return '这种直播不能做切片';

  if (queue.has(record.liveId)) return '这场录播已经在切片了，进度在下载队列里';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) return unavailable;

  const job: HighlightJob = highlightJobOf(record, count, highlightBaseDir()!);

  enqueueHighlight({
    key: record.liveId,
    title: `${ record.userInfo.nickname } ${ record.title }`,
    job,
    async prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> {
      // 成员名单一天更新一次：开始下载前确认是新的（取不到时用本机存的那份）
      await loadMemberDirectory();
      job.members = membersPrompt(getMemberDirectory().members, record.userInfo.nickname) || job.members;

      // 自动抓取已经把整场录播下好了（切片失败时会留着）：直接用，不再下一遍
      const kept: { file: string; danmuFile?: string } | undefined = findKeptReplay(record.liveId, isRadio(record));

      if (kept) return localSource(kept.file, kept.danmuFile, report, '用自动抓取已经下好的录播');

      return prepareHighlight(job, deps, report, signal);
    },
    retry: (): unknown => startHighlight(record, count, whenEnded),
    whenEnded
  });

  return undefined;
}

/**
 * 把一个录播地址（一般是 m3u8）下成一个文件：同时下几个分片、卡住自动重试、和别的录播下载排队（一次只下一场）、下完合成。
 * 中间的分片放在 workDir 里（默认「输出文件名.parts」），下完删掉；停了再来时下好的分片不用重下。
 * 接入点：downloadFullReplay、custom/bilibili/gongyanReplay（口袋48 的公演录播）
 * @param { string } url
 * @param { string } output
 * @param { (percent: number, detail: string) => void } report - percent 是 0 ~ 100
 * @param { AbortSignal } [signal]
 * @param { string } [workDir]
 * @param { string } [cover] - 电台：只留声音，开头那一帧存成这张图
 */
export async function downloadStream(
  url: string, output: string, report: (percent: number, detail: string) => void, signal?: AbortSignal, workDir: string = `${ output }.parts`,
  cover?: string
): Promise<void> {
  let playlist: string | undefined;

  try {
    playlist = /\.m3u8(\?|$)/i.test(url) ? await deps.fetchText(url) : undefined;
  } catch { /* 读不到 m3u8 的内容就让 ffmpeg 自己下载，不显示百分比 */ }

  await fsP.mkdir(workDir, { recursive: true });
  await downloadReplay({
    ffmpeg: getFFmpeg(),
    url,
    playlist,
    workDir,
    output,
    cover,
    fetchSegment,
    signal,
    onProgress: (progress: DownloadProgress): void => report(Math.round(progress.part * 100), progress.detail)
  });
  await fsP.rm(workDir, { recursive: true, force: true });
}

/**
 * 下载一场录播的完整视频（和切片下载录播是同一套：同时下几个分片、卡住自动重试、下完合成一个文件），顺便取弹幕。
 * 中间的分片放在「输出文件名.parts」里，下完删掉；停了再来时下好的分片不用重下。
 * 接入点：custom/live/replayGrab（自动抓取：直播结束后下载录播）
 * @param { string } liveId
 * @param { string } output - 合成后的文件（.mp4，电台用 .m4a）
 * @param { (percent: number, detail: string) => void } report - percent 是 0 ~ 100
 * @param { AbortSignal } [signal]
 * @param { string } [cover] - 电台：只留录音，电台封面存成这张图（这场直播的封面图；取不到时是录播开头那一帧，画面只是口袋48的占位图）
 * @return { Promise<{ danmu?: string }> } 弹幕文件的内容（这场没有弹幕、取不到时没有）
 */
export async function downloadFullReplay(
  liveId: string, output: string, report: (percent: number, detail: string) => void, signal?: AbortSignal, cover?: string
): Promise<{ danmu?: string }> {
  const info: { playStreamPath: string; msgFilePath: string; coverUrl?: string } = await deps.liveInfo(liveId);

  if (!info.playStreamPath) throw new Error('这场直播没有录播地址（可能还没生成，或者已经被删除）');

  let danmu: string | undefined;

  if (info.msgFilePath) {
    try {
      danmu = await deps.fetchText(info.msgFilePath);
    } catch (err) {
      console.warn('弹幕文件下载失败', err);
    }
  }

  await downloadStream(info.playStreamPath, output, report, signal, undefined, cover);

  if (cover) await saveRadioCover(deps, info.coverUrl, cover, signal);

  return { danmu };
}

/**
 * 用已经下好的录播和弹幕做切片（数量「自动」），不再下载一遍。接入点：custom/live/replayGrab（自动抓取勾了「切片」）
 * @param { HighlightRecord } record
 * @param { string } file - 下好的录播
 * @param { string | undefined } danmuFile - 下好的弹幕（.lrc）
 * @param { (outcome: QueueOutcome, text: string) => void } [whenEnded] - 做完、停止或失败后调用；在下载队列里点「重试」时也会带上
 * @return { string | undefined } 不能开始时返回原因
 */
export function startHighlightFromFile(
  record: HighlightRecord, file: string, danmuFile: string | undefined, whenEnded?: (outcome: QueueOutcome, text: string) => void
): string | undefined {
  if (!canHighlight(record)) return '这种直播不能做切片';

  if (queue.has(record.liveId)) return '这场录播已经在切片了，进度在下载队列里';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) return unavailable;

  const job: HighlightJob = highlightJobOf(record, 'auto', highlightBaseDir()!);

  enqueueHighlight({
    key: record.liveId,
    title: `${ record.userInfo.nickname } ${ record.title }`,
    job,
    async prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> {
      await loadMemberDirectory();
      job.members = membersPrompt(getMemberDirectory().members, record.userInfo.nickname) || job.members;

      return localSource(file, danmuFile, report, '用已经下好的录播');
    },
    retry: (): unknown => startHighlightFromFile(record, file, danmuFile, whenEnded),
    whenEnded
  });

  return undefined;
}
