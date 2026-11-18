import * as fs from 'node:fs';
import * as dayjs from 'dayjs';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from './downloadQueue';
import { formatProgressDetail, type ProgressStats } from '../download/formatProgress';

/**
 * 录播下载（视频 / 音频）登记到下载队列用的接入函数，以及写进音频文件的信息。
 * 接入点：Pocket48Record.tsx 的 handleDownloadM3u8Click。
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

export function recordTaskStart(record: RecordLike, filePath: string, audioOnly: boolean, stop: () => void): void {
  queueTaskStart({
    id: taskId(record.liveId),
    title: `${ record.userInfo.nickname } ${ record.title }`,
    kind: audioOnly ? '音频' : '视频',
    filePath,
    percent: 0,
    detail: '准备中…',
    stop
  });
}

export function recordTaskProgress(liveId: string, message: WorkerMessage): void {
  queueTaskProgress(taskId(liveId), typeof message.data === 'number' ? message.data : undefined, formatProgressDetail(message));
}

/* 下载结束：出错、完成（最终文件已经生成）或被停止（没有生成最终文件） */
export function recordTaskEnd(liveId: string, filePath: string, message: WorkerMessage): void {
  if (message.type === 'error') {
    queueTaskEnd(taskId(liveId), 'error', message.error?.message || '下载失败');
  } else {
    queueTaskEnd(taskId(liveId), fs.existsSync(filePath) ? 'done' : 'stopped');
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
