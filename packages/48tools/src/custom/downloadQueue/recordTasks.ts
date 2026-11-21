import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dayjs from 'dayjs';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from './downloadQueue';
import { formatProgressDetail, type ProgressStats } from '../download/formatProgress';

/**
 * 录播下载（视频 / 音频）登记到下载队列用的接入函数，以及写进音频文件的信息。
 * 接入点：Pocket48Record.tsx 的 handleDownloadM3u8Click、handleStopClick（recordTaskStopping）。
 *
 * 停止下载时下载到一半的内容不会删掉：视频留在保存的文件里（不完整，能播放）；音频留在「文件名.part.aac」，
 * 下次下载同一场的音频时可以接着下；备用方案下载的分片留在「文件名.cache」文件夹里。
 * worker 停止和正常结束时发的是同一种消息，所以点了停止的任务记在 stopping 里，结束时据此显示「已停止」。
 */
interface RecordLike {
  liveId: string;
  title: string;
  ctime: string;
  userInfo: { nickname: string };
}

type WorkerMessage = { type: string; data?: unknown; error?: { message?: string } } & ProgressStats;

function taskId(liveId: string): string {
  return `record:${ liveId }`;
}

const stopping: Set<string> = new Set(); // 点了「停止」、还没结束的录播

/* 点了停止（录播列表的「停止下载」和下载队列的「停止」都要调用） */
export function recordTaskStopping(liveId: string): void {
  stopping.add(liveId);
}

/* 停止后下载到一半的内容在哪里 */
export function stoppedDetail(filePath: string): string {
  const parsed: path.ParsedPath = path.parse(filePath);

  if (fs.existsSync(path.join(parsed.dir, `${ parsed.name }.part.aac`))) return '已停止。已下载的部分保留着，再下载这场的音频时可以接着下';

  if (fs.existsSync(`${ filePath }.cache`)) return `已停止。已下载的分片留在「${ parsed.base }.cache」文件夹里`;

  if (fs.existsSync(filePath)) return '已停止。已下载的部分留在保存的文件里（不完整）';

  return '已停止';
}

export function recordTaskStart(record: RecordLike, filePath: string, audioOnly: boolean, stop: () => void, retry?: () => void): void {
  stopping.delete(record.liveId);
  queueTaskStart({
    id: taskId(record.liveId),
    title: `${ record.userInfo.nickname } ${ record.title }`,
    kind: audioOnly ? '音频' : '视频',
    filePath,
    percent: 0,
    detail: '准备中…',
    stop(): void {
      recordTaskStopping(record.liveId);
      stop();
    },
    retry
  });
}

export function recordTaskProgress(liveId: string, message: WorkerMessage): void {
  queueTaskProgress(taskId(liveId), typeof message.data === 'number' ? message.data : undefined, formatProgressDetail(message));
}

/* 下载结束：出错、被停止（点过停止，或者最终文件没有生成）、完成 */
export function recordTaskEnd(liveId: string, filePath: string, message: WorkerMessage): void {
  const stopped: boolean = stopping.delete(liveId);

  if (message.type === 'error' && !stopped) {
    queueTaskEnd(taskId(liveId), 'error', message.error?.message || '下载失败');
  } else if (stopped || !fs.existsSync(filePath)) {
    queueTaskEnd(taskId(liveId), 'stopped', undefined, stoppedDetail(filePath));
  } else {
    queueTaskEnd(taskId(liveId), 'done');
  }
}

/* 写进 m4a 的信息：标题、成员、专辑、日期、备注（直播 ID） */
export function audioMetaOf(record: RecordLike): Record<string, string> {
  const time: dayjs.Dayjs = dayjs(Number(record.ctime));

  return {
    title: record.title,
    artist: record.userInfo.nickname,
    album: '口袋48录播',
    date: time.isValid() ? time.format('YYYY-MM-DD') : '',
    comment: `liveId: ${ record.liveId }`
  };
}
