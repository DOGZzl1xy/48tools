import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
// @ts-expect-error
import got from 'got';
import { requestLiveRoomInfo, requestDownloadFile, requestLiveList, type LiveRoomInfo, type LiveData, type LiveInfo } from '@48tools-api/48';
import { getFFmpeg } from '../../utils/utils';
import { engineUserAgent, source } from '../../utils/snh48';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { SEGMENT_TIMEOUT } from '../download/segmentRetry';
import { fetchSegmentFile } from '../download/segmentFetch';
import { pocket48Agent } from '../pocket48Proxy/pocket48Proxy';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import {
  prepareHighlight, findHighlights, saveRadioCover, DOWNLOAD_END,
  type HighlightJob, type HighlightDeps, type HighlightProgress, type PreparedSource
} from './highlightPipeline';
import { pickKey, readShowInfoSync, type ShowInfo, type ShowItem } from './highlightShow';
import { reloadShow, selectShow } from './showStore';
import { highlightDefaults, type GeminiConfig } from './highlightGemini';
import { StagedQueue, type QueueStage, type QueueOutcome } from './highlightQueue';
import { recognizeAudio, isAlignerInstalled } from './alignerRun';
import { readGlossaryFile } from './glossaryFile';
import type { TimedToken } from './highlightTokens';
import { safeFileName, parseLrc } from './highlightTime';
import { downloadReplay, type DownloadProgress } from './highlightDownload';
import { membersPrompt } from './highlightMembers';
import { getMemberDirectory, loadMemberDirectory } from '../room/memberDirectory';
import { beijingDate } from '../time/timeZone';
import { sleep } from '../common/util';
import type { HighlightCount } from './highlightTypes';
import type { MemberPhoto } from './radioPhotos';
import { getLiveRecordDir } from '../live/liveRecording';
import { keptReplayOf } from '../live/replayGrabCore';

/**
 * 录播自动切片接到程序里的部分：从设置里读 Gemini 的 key 和保存位置，登记到下载队列，排队执行。
 * 真正干活的是 ./highlightPipeline，排队的规则在 ./highlightQueue：
 * 同一时间只切一场（合成视频很吃 CPU），前一场开始切的时候后一场就开始下载录播；同一场录播不会重复加。
 * 分三次排队：先找爆点，清单写好就停下来等人在切片页面挑（用户 2026-11-23 定的）；挑好了排队写标题，写好再停下来等人定
 * （用户 2026-11-24 定的）；定好了再排队渲染（后两次见 ./pickTask）。
 * 「切完」要做的事（自动抓取：切完删掉录播）等真的切完才做：找完爆点时记在 waitingEnds 里，切完、不切了时由 endWaiting 叫到。
 * 接入点：./HighlightDialog（录播列表里点「自动切片」后的对话框）、../live/replayGrab、../bilibili 的公演切片。
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
const SHOWS_HASH: string = '#/48/Highlights';
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

function foundText(info: ShowInfo): string {
  if (info.items.length === 0) return '这场录播里没有找到值得剪的片段';

  const cuts: number = info.items.filter((item: ShowItem): boolean => item.cut).length;

  return `找到 ${ info.items.length } 个爆点，推荐切 ${ cuts } 个，等你挑`;
}

/* 打开切片页面，看这一场 */
export function openShow(dir: string): void {
  selectShow(dir);
  window.location.hash = SHOWS_HASH;
  window.focus();
}

function notify(title: string, body: string, onClick?: () => void): void {
  try {
    if (typeof Notification === 'undefined') return;

    const notification: Notification = new Notification(title, { body });

    onClick && (notification.onclick = onClick);
  } catch { /* 系统不让弹通知就算了，下载队列里也看得到 */ }
}

/* 找完爆点、还在等人挑的场次：切完（或者不切了）以后要告诉谁 */
const waitingEnds: Map<string, (outcome: QueueOutcome, text: string) => void> = new Map();

/* 等人挑的一场有结果了：切完了（done）、不切了（stopped） */
export function endWaiting(liveId: string, outcome: QueueOutcome, text: string): void {
  const end: ((outcome: QueueOutcome, text: string) => void) | undefined = waitingEnds.get(liveId);

  waitingEnds.delete(liveId);
  end?.(outcome, text);
}

/**
 * 下载录播的一个分片：和普通录播下载用同样的请求头和超时，停住 10 秒就从断点走口袋48代理补完（见 ../download/segmentFetch），
 * 失败由调用的地方重试
 */
function fetchSegment(uri: string, file: string, signal: AbortSignal, attempt: number = 0): Promise<number> {
  return fetchSegmentFile({
    file,
    attempt,
    signal,
    hasProxy: pocket48Agent() !== undefined,
    open: (viaProxy: boolean, headers: Record<string, string>): Readable => got.stream(uri, {
      headers: { Host: new URL(uri).hostname, 'User-Agent': engineUserAgent, ...headers },
      timeout: SEGMENT_TIMEOUT,
      agent: viaProxy ? pocket48Agent() : undefined
    })
  });
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

const PAST_PAGES: number = 2;      // 往期直播、电台取几页（一页 20 场左右）
const PAST_CAROUSELS: number = 6;  // 最近几场电台的轮播图也取

/* 一场直播的轮播图（电台播放时轮着放的几张，成员自己设的） */
function carouselsOf(content: LiveRoomInfo['content'] | undefined, time: number, title: string): Array<MemberPhoto> {
  return (content?.carousels?.carousels ?? []).map((url: string): MemberPhoto => ({ url: source(url), time, kind: '电台', title }));
}

/**
 * 电台切片封面库的照片（见 ./radioPhotos）：这场电台的轮播图，她以前直播、电台的封面，最近几场电台的轮播图。
 * 她在房间里发的照片不要（用户 2026-11-26 定的）。哪一路取不到都不要紧
 */
async function memberPhotos(liveId: string): Promise<Array<MemberPhoto>> {
  const room: LiveRoomInfo = await requestLiveRoomInfo(liveId);
  const userId: number = Number(room.content?.user?.userId);
  const photos: Array<MemberPhoto> = carouselsOf(room.content, Number(room.content?.ctime), room.content?.title ?? '');

  if (!userId) return photos;

  const lives: Array<LiveInfo> = [];
  let next: string = '0';

  try {
    for (let page: number = 0; page < PAST_PAGES; page++) {
      const res: LiveData = await requestLiveList(next, false, undefined, userId);

      lives.push(...(res.content?.liveList ?? []));
      next = res.content?.next ?? '';

      if (!next || next === '0') break;
    }
  } catch (err) {
    console.warn('封面库：取不到她以前的直播', err);
  }

  for (const live of lives) {
    live.coverPath && photos.push({ url: source(live.coverPath), time: Number(live.ctime), kind: Number(live.liveType) === 2 ? '电台' : '直播', title: live.title });
  }

  for (const live of lives.filter((item: LiveInfo): boolean => Number(item.liveType) === 2 && item.liveId !== liveId).slice(0, PAST_CAROUSELS)) {
    try {
      photos.push(...carouselsOf((await requestLiveRoomInfo(live.liveId)).content, Number(live.ctime), live.title));
    } catch (err) {
      console.warn('封面库：取不到这场电台的轮播图', live.liveId, err);
    }
  }

  return photos.filter((photo: MemberPhoto): boolean => /^https?:\/\//.test(photo.url));
}

export const highlightDeps: HighlightDeps = {
  async liveInfo(liveId: string): Promise<{ playStreamPath: string; msgFilePath: string; coverUrl?: string }> {
    const res: LiveRoomInfo = await requestLiveRoomInfo(liveId);

    if (!res.success || !res.content) throw new Error(res.message || '取不到这场录播的信息');

    const coverPath: string | undefined = (res.content as { coverPath?: string }).coverPath;

    return { playStreamPath: res.content.playStreamPath, msgFilePath: res.content.msgFilePath, coverUrl: source(coverPath) || undefined };
  },
  fetchText: (url: string): Promise<string> => requestDownloadFile(url),
  fetchImage,
  memberPhotos,
  fetchSegment,
  // 装了本地打轴模型就用它给字幕定时间；没装时返回 null，流程用 Gemini 给的时间
  recognize: (audioFile: string, signal?: AbortSignal): Promise<Array<TimedToken> | null> => recognizeAudio(getFFmpeg(), audioFile, signal)
};

/* 本机已经有的录播和弹幕（.lrc）当作切片的素材；录播被删了就报错（可以在下载队列里看到原因） */
export async function localSource(
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
export function findKeptReplay(liveId: string, radio: boolean): { file: string; danmuFile?: string } | undefined {
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
  // 准备好以后做什么，返回做完后显示的说明；不给就是找爆点（findHighlights），找完等人挑
  process?(prepared: PreparedSource, report: (progress: HighlightProgress) => void, signal: AbortSignal): Promise<string>;
  kind?: string;    // 下载队列里写是什么任务；不给的话，找爆点是「找爆点」，别的是「切片」
  notice?: string;  // 做完时通知的标题；不给的话「找好爆点了」「切片完成」
  waiting?: string; // 排队时显示的说明
  retry(): unknown;
  whenEnded?(outcome: QueueOutcome, text: string): void; // 找爆点时：找完不算结束，等切完（./pickTask）才叫
  whenFound?(): void;                                    // 找好爆点了，开始等人挑
}

/* 加到切片的队列里（同一时间只切一场，前一场开始切的时候后一场就开始准备），进度在下载队列里 */
export function enqueueHighlight(item: QueuedHighlight): void {
  const { key, job }: QueuedHighlight = item;
  const id: string = highlightTaskId(key);
  const finding: boolean = item.process === undefined;
  let started: boolean = false; // 开始下载了没有（停止时的说明不一样）
  let text: string = '';        // 做完后显示的说明
  let found: ShowInfo | undefined;

  function report(progress: HighlightProgress): void {
    queueTaskProgress(id, progress.percent, progress.detail);
  }

  queueTaskStart({
    id,
    title: item.title,
    kind: item.kind ?? (finding ? '找爆点' : '切片'),
    filePath: job.outDir,
    percent: 0,
    detail: item.waiting ?? '排队中，等前面那场开始切片后就开始准备…',
    stop: (): void => queue.stop(key),
    retry: item.retry
  });
  queue.add({
    id: key,
    prepare: (signal: AbortSignal): Promise<PreparedSource> => item.prepare(signal, report),
    async process(prepared: PreparedSource, signal: AbortSignal): Promise<void> {
      if (item.process) {
        text = await item.process(prepared, report, signal);

        return;
      }

      found = await findHighlights(job, highlightDeps, prepared, report, signal);
      text = foundText(found);
      await reloadShow(job.outDir);
    },
    onStage(stage: QueueStage): void {
      if (stage === 'preparing') started = true;

      if (stage === 'ready') queueTaskProgress(id, DOWNLOAD_END, '准备好了，等前面那场切完就开始…');
    },
    onEnd(outcome: QueueOutcome, err?: unknown): void {
      if (outcome === 'done') {
        queueTaskEnd(id, 'done', undefined, text);
        notify(`${ item.notice ?? (finding ? '找好爆点了' : '切片完成') }：${ job.member } ${ job.title }`, text, (): void => openShow(job.outDir));
      } else if (outcome === 'stopped') {
        queueTaskEnd(id, 'stopped', undefined, started
          ? '已停止。再点「重试」会接着做，已经准备好的部分不用重来'
          : '已取消，还没有开始');
      } else {
        console.error(`${ item.kind ?? (finding ? '找爆点' : '切片') }失败`, err);
        queueTaskEnd(id, 'error', err instanceof Error ? err.message : String(err));
      }

      // 找到了：等人挑好、切完再说
      if (outcome === 'done' && found?.status === 'waiting') {
        item.whenEnded && waitingEnds.set(job.liveId, item.whenEnded);
        item.whenFound?.();
      } else {
        item.whenEnded?.(outcome, text);
      }
    }
  });
}

/* 这个 key 是不是正在排队或者切片 */
export function isHighlightQueued(key: string): boolean {
  return queue.has(key);
}

const STOP_WAIT: number = 20_000;

/* 停掉，等它真的停下来（ffmpeg 退出、不再占着文件）；等太久就算了 */
export async function stopHighlight(key: string): Promise<void> {
  queue.stop(key);

  const end: number = Date.now() + STOP_WAIT;

  while (queue.has(key) && Date.now() < end) await sleep(100);
}

/**
 * 准备一场直播的素材：自动抓取已经把整场录播下好了（切片失败时会留着）就直接用，否则下载
 * @param { HighlightJob } job - 成员名单会换成最新的
 * @param { string } nickname - 主播，SNH48-沈馨
 */
export async function prepareLive(
  job: HighlightJob, nickname: string, report: (progress: HighlightProgress) => void, signal: AbortSignal
): Promise<PreparedSource> {
  // 成员名单一天更新一次：开始下载前确认是新的（取不到时用本机存的那份）
  await loadMemberDirectory();
  job.members = membersPrompt(getMemberDirectory().members, nickname) || job.members;

  const kept: { file: string; danmuFile?: string } | undefined = findKeptReplay(job.liveId, Boolean(job.radio));

  if (kept) return localSource(kept.file, kept.danmuFile, report, '用自动抓取已经下好的录播');

  return prepareHighlight(job, highlightDeps, report, signal);
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

  if (queue.has(record.liveId)) return '这场录播已经在找爆点了，进度在下载队列里';

  if (queue.has(pickKey(record))) return '这场录播正在切片，进度在下载队列里';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) return unavailable;

  const job: HighlightJob = highlightJobOf(record, count, highlightBaseDir()!);

  enqueueHighlight({
    key: record.liveId,
    title: `${ record.userInfo.nickname } ${ record.title }`,
    job,
    prepare: (signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> => (
      prepareLive(job, record.userInfo.nickname, report, signal)),
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
    playlist = /\.m3u8(\?|$)/i.test(url) ? await highlightDeps.fetchText(url) : undefined;
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
  const info: { playStreamPath: string; msgFilePath: string; coverUrl?: string } = await highlightDeps.liveInfo(liveId);

  if (!info.playStreamPath) throw new Error('这场直播没有录播地址（可能还没生成，或者已经被删除）');

  let danmu: string | undefined;

  if (info.msgFilePath) {
    try {
      danmu = await highlightDeps.fetchText(info.msgFilePath);
    } catch (err) {
      console.warn('弹幕文件下载失败', err);
    }
  }

  await downloadStream(info.playStreamPath, output, report, signal, undefined, cover);

  if (cover) await saveRadioCover(highlightDeps, info.coverUrl, cover, signal);

  return { danmu };
}

/**
 * 用已经下好的录播和弹幕找爆点（推荐的数量「自动」），不再下载一遍，找完等人挑。接入点：custom/live/replayGrab（自动抓取勾了「切片」）
 * @param { HighlightRecord } record
 * @param { string } file - 下好的录播
 * @param { string | undefined } danmuFile - 下好的弹幕（.lrc）
 * @param { (outcome: QueueOutcome, text: string) => void } [whenEnded] - 切完、不切了，或者找爆点时停止、失败以后调用；在下载队列里点「重试」时也会带上
 * @param { () => void } [whenFound] - 找好爆点、开始等人挑时调用
 * @return { string | undefined } 不能开始时返回原因
 */
export function startHighlightFromFile(
  record: HighlightRecord, file: string, danmuFile: string | undefined,
  whenEnded?: (outcome: QueueOutcome, text: string) => void, whenFound?: () => void
): string | undefined {
  if (!canHighlight(record)) return '这种直播不能做切片';

  if (queue.has(record.liveId)) return '这场录播已经在找爆点了，进度在下载队列里';

  if (queue.has(pickKey(record))) return '这场录播正在切片，进度在下载队列里';

  const unavailable: string | undefined = highlightUnavailable();

  if (unavailable) return unavailable;

  const job: HighlightJob = { ...highlightJobOf(record, 'auto', highlightBaseDir()!), local: { file, danmuFile } };
  const old: ShowInfo | undefined = readShowInfoSync(job.outDir);

  // 程序重启前已经用这份录播找好爆点了：不再找，接着等人挑；重启前刚切完（或者不切了）就直接说结果
  if (old?.local?.file === file) {
    if (old.status !== 'done') {
      whenEnded && waitingEnds.set(record.liveId, whenEnded);
      whenFound?.();
    } else {
      const made: number = old.items.filter((item: ShowItem): boolean => item.clip !== undefined).length;

      whenEnded?.(made > 0 ? 'done' : 'stopped', made > 0 ? `做了 ${ made } 个切片` : '没有切');
    }

    return undefined;
  }

  enqueueHighlight({
    key: record.liveId,
    title: `${ record.userInfo.nickname } ${ record.title }`,
    job,
    async prepare(signal: AbortSignal, report: (progress: HighlightProgress) => void): Promise<PreparedSource> {
      await loadMemberDirectory();
      job.members = membersPrompt(getMemberDirectory().members, record.userInfo.nickname) || job.members;

      return localSource(file, danmuFile, report, '用已经下好的录播');
    },
    retry: (): unknown => startHighlightFromFile(record, file, danmuFile, whenEnded, whenFound),
    whenEnded,
    whenFound
  });

  return undefined;
}
