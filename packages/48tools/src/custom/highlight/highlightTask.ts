import * as path from 'node:path';
import * as dayjs from 'dayjs';
import { requestLiveRoomInfo, requestDownloadFile, type LiveRoomInfo } from '@48tools-api/48';
import { getFFmpeg } from '../../utils/utils';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { runHighlight, isStopped, type HighlightJob, type HighlightProgress, type HighlightResult, type ClipResult } from './highlightPipeline';
import { highlightDefaults, type GeminiConfig } from './highlightGemini';
import { safeFileName } from './highlightTime';
import type { HighlightCount } from './highlightTypes';

/**
 * 录播自动切片接到程序里的部分：从设置里读 Gemini 的 key 和保存位置，登记到下载队列，一个一个地做。
 * 真正干活的是 ./highlightPipeline。
 * 同一时间只做一场（合成视频很吃 CPU），后面加进来的排队；同一场录播不会重复加。
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
const active: Set<string> = new Set();
let chain: Promise<void> = Promise.resolve();

/* 只有视频直播能切（电台没有画面） */
export function canHighlight(record: HighlightRecord): boolean {
  return Number(record.liveType) === 1;
}

export function isHighlightActive(liveId: string): boolean {
  return active.has(liveId);
}

export function highlightGeminiConfig(): GeminiConfig {
  return {
    apiKey: getSetting('sttGeminiKey') ?? '',
    model: getSetting('highlightModel') || highlightDefaults.model,
    baseUrl: getSetting('sttGeminiBaseUrl') || highlightDefaults.baseUrl
  };
}

/* 切片保存在哪个文件夹：设置里指定的，或者「默认保存文件夹 / 录播切片」；都没有时返回 undefined */
export function highlightBaseDir(): string | undefined {
  const own: string | undefined = resolveLocalDir(getSetting('highlightDir'));

  if (own) return own;

  const download: string | undefined = resolveLocalDir(getSetting('downloadDir'));

  return download ? path.join(download, OUT_FOLDER) : undefined;
}

function taskId(liveId: string): string {
  return `highlight:${ liveId }`;
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
    outDir,
    workDir: path.join(outDir, WORK_FOLDER),
    ffmpeg: getFFmpeg(),
    gemini: highlightGeminiConfig()
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

async function run(record: HighlightRecord, job: HighlightJob, controller: AbortController): Promise<void> {
  const id: string = taskId(record.liveId);

  try {
    if (controller.signal.aborted) {
      queueTaskEnd(id, 'stopped');

      return;
    }

    const result: HighlightResult = await runHighlight(job, {
      async liveInfo(liveId: string): Promise<{ playStreamPath: string; msgFilePath: string }> {
        const res: LiveRoomInfo = await requestLiveRoomInfo(liveId);

        if (!res.success || !res.content) throw new Error(res.message || '取不到这场录播的信息');

        return { playStreamPath: res.content.playStreamPath, msgFilePath: res.content.msgFilePath };
      },
      fetchText: (url: string): Promise<string> => requestDownloadFile(url)
    }, (progress: HighlightProgress): void => queueTaskProgress(id, progress.percent, progress.detail), controller.signal);
    const text: string = doneText(result);

    queueTaskEnd(id, 'done', undefined, text);
    notify(`切片完成：${ job.member } ${ job.title }`, text);
  } catch (err) {
    if (isStopped(err)) {
      queueTaskEnd(id, 'stopped', undefined, '已停止。再点「重试」会接着做，下载好的录播不用重新下载');
    } else {
      console.error('自动切片失败', err);
      queueTaskEnd(id, 'error', err instanceof Error ? err.message : String(err));
    }
  } finally {
    active.delete(record.liveId);
  }
}

/**
 * 开始给一场录播做切片（加到下载队列里，排队执行）
 * @param { HighlightRecord } record - 录播列表里的一行
 * @param { HighlightCount } count - 做几个，或者 'auto'
 * @return { string | undefined } 不能开始时返回原因
 */
export function startHighlight(record: HighlightRecord, count: HighlightCount): string | undefined {
  if (!canHighlight(record)) return '电台直播没有画面，不能做切片';

  if (active.has(record.liveId)) return '这场录播已经在切片了，进度在下载队列里';

  const baseDir: string | undefined = highlightBaseDir();

  if (!baseDir) return '还没有设置保存位置';

  const job: HighlightJob = highlightJobOf(record, count, baseDir);

  if (!job.gemini.apiKey.trim()) return '还没有填写 Gemini 的 API key（设置 → 语音转文字）';

  const controller: AbortController = new AbortController();

  active.add(record.liveId);
  queueTaskStart({
    id: taskId(record.liveId),
    title: `${ record.userInfo.nickname } ${ record.title }`,
    kind: '切片',
    filePath: job.outDir,
    percent: 0,
    detail: '排队中…',
    stop: (): void => controller.abort(),
    retry(): void {
      startHighlight(record, count);
    }
  });
  chain = chain.then((): Promise<void> => run(record, job, controller));

  return undefined;
}
