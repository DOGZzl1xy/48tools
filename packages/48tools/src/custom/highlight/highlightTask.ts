import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as dayjs from 'dayjs';
// @ts-expect-error
import got from 'got';
import { requestLiveRoomInfo, requestDownloadFile, type LiveRoomInfo } from '@48tools-api/48';
import { getFFmpeg } from '../../utils/utils';
import { engineUserAgent } from '../../utils/snh48';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { SEGMENT_TIMEOUT } from '../download/segmentRetry';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import {
  prepareHighlight, processHighlight, DOWNLOAD_END,
  type HighlightJob, type HighlightDeps, type HighlightProgress, type HighlightResult, type ClipResult, type PreparedSource
} from './highlightPipeline';
import { highlightDefaults, type GeminiConfig } from './highlightGemini';
import { StagedQueue, type QueueStage, type QueueOutcome } from './highlightQueue';
import { recognizeAudio, isAlignerInstalled } from './alignerRun';
import { readGlossaryFile } from './glossaryFile';
import type { TimedToken } from './highlightTokens';
import { safeFileName } from './highlightTime';
import type { HighlightCount } from './highlightTypes';

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

/* 只有视频直播能切（电台没有画面） */
export function canHighlight(record: HighlightRecord): boolean {
  return Number(record.liveType) === 1;
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
  const time: dayjs.Dayjs = dayjs(Number(record.ctime));
  const folder: string = safeFileName(
    `${ record.userInfo.nickname }_${ record.title }_${ time.isValid() ? time.format('YYYY-MM-DD') : '' }_${ record.liveId }`, 90);
  const outDir: string = path.join(baseDir, folder);

  return {
    liveId: record.liveId,
    member: memberName(record.userInfo.nickname),
    title: record.title,
    date: time.isValid() ? time.format('YYYY.MM.DD') : '',
    count,
    autoScore: getSetting('highlightAutoScore'),
    outDir,
    workDir: path.join(outDir, WORK_FOLDER),
    ffmpeg: getFFmpeg(),
    gemini: highlightGeminiConfig(),
    glossary: readGlossaryFile()
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

/* 下载录播的一个分片：和普通录播下载用同样的请求头和超时（卡住 30 秒就断开，由调用的地方重试） */
async function fetchSegment(uri: string, file: string, signal: AbortSignal): Promise<number> {
  await pipeline(
    got.stream(uri, { headers: { Host: new URL(uri).hostname, 'User-Agent': engineUserAgent }, timeout: SEGMENT_TIMEOUT }),
    fs.createWriteStream(file),
    { signal });

  const size: number = (await fsP.stat(file)).size;

  if (size === 0) throw new Error('下载到的分片是空的');

  return size;
}

const deps: HighlightDeps = {
  async liveInfo(liveId: string): Promise<{ playStreamPath: string; msgFilePath: string }> {
    const res: LiveRoomInfo = await requestLiveRoomInfo(liveId);

    if (!res.success || !res.content) throw new Error(res.message || '取不到这场录播的信息');

    return { playStreamPath: res.content.playStreamPath, msgFilePath: res.content.msgFilePath };
  },
  fetchText: (url: string): Promise<string> => requestDownloadFile(url),
  fetchSegment,
  // 装了本地打轴模型就用它给字幕定时间；没装时返回 null，流程用 Gemini 给的时间
  recognize: (audioFile: string, signal?: AbortSignal): Promise<Array<TimedToken> | null> => recognizeAudio(getFFmpeg(), audioFile, signal)
};

/**
 * 开始给一场录播做切片（加到下载队列里，排队执行）
 * @param { HighlightRecord } record - 录播列表里的一行
 * @param { HighlightCount } count - 做几个，或者 'auto'
 * @return { string | undefined } 不能开始时返回原因
 */
export function startHighlight(record: HighlightRecord, count: HighlightCount): string | undefined {
  if (!canHighlight(record)) return '电台直播没有画面，不能做切片';

  if (queue.has(record.liveId)) return '这场录播已经在切片了，进度在下载队列里';

  const baseDir: string | undefined = highlightBaseDir();

  if (!baseDir) return '还没有设置保存位置';

  const job: HighlightJob = highlightJobOf(record, count, baseDir);

  if (job.gemini.via === 'agy') {
    if (!isAlignerInstalled()) return '通过本机的 agy 做切片时，要先在「设置 → 录播切片」里安装「本地打轴模型」';
  } else if (!job.gemini.apiKey.trim()) {
    return '还没有填写 Gemini 的 API key（设置 → 语音转文字）';
  }

  const id: string = highlightTaskId(record.liveId);
  let started: boolean = false; // 开始下载了没有（停止时的说明不一样）
  let text: string = '';        // 做完后显示的说明

  function report(progress: HighlightProgress): void {
    queueTaskProgress(id, progress.percent, progress.detail);
  }

  queueTaskStart({
    id,
    title: `${ record.userInfo.nickname } ${ record.title }`,
    kind: '切片',
    filePath: job.outDir,
    percent: 0,
    detail: '排队中，等前面那场开始切片后就开始下载…',
    stop: (): void => queue.stop(record.liveId),
    retry(): void {
      startHighlight(record, count);
    }
  });
  queue.add({
    id: record.liveId,
    prepare: (signal: AbortSignal): Promise<PreparedSource> => prepareHighlight(job, deps, report, signal),
    async process(prepared: PreparedSource, signal: AbortSignal): Promise<void> {
      text = doneText(await processHighlight(job, deps, prepared, report, signal));
    },
    onStage(stage: QueueStage): void {
      if (stage === 'preparing') started = true;

      if (stage === 'ready') queueTaskProgress(id, DOWNLOAD_END, '录播下载好了，等前面那场切完就开始…');
    },
    onEnd(outcome: QueueOutcome, err?: unknown): void {
      if (outcome === 'done') {
        queueTaskEnd(id, 'done', undefined, text);
        notify(`切片完成：${ job.member } ${ job.title }`, text);
      } else if (outcome === 'stopped') {
        queueTaskEnd(id, 'stopped', undefined, started
          ? '已停止。再点「重试」会接着做，已经下载的部分不用重新下载'
          : '已取消，还没有开始下载');
      } else {
        console.error('自动切片失败', err);
        queueTaskEnd(id, 'error', err instanceof Error ? err.message : String(err));
      }
    }
  });

  return undefined;
}
