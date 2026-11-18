import { useSyncExternalStore } from 'react';

/**
 * 下载队列：记录所有正在进行和已经结束的任务（录播视频 / 音频下载、直播录制、录像转 mp4），
 * 让用户在任何页面都能看到进度。界面是 ./DownloadQueuePanel（右下角的悬浮按钮）。
 * 只是一个内存里的列表，不负责真正的下载；各个下载的地方在开始、有进度、结束时调用这里的函数。
 * 接入点：Pocket48Record.tsx（录播下载）、custom/live/liveRecording（直播录制和转换）。
 */
export type QueueTaskStatus = 'running' | 'done' | 'error' | 'stopped';

export interface QueueTask {
  id: string;
  title: string;
  kind: string;          // 例如：视频、音频、直播录制、转 mp4
  filePath?: string;     // 结束后可以在文件夹里显示
  status: QueueTaskStatus;
  percent?: number;      // 0 ~ 100，没有进度的任务（直播录制）不填
  detail?: string;       // 速度、剩余时间等说明
  error?: string;
  startTime: number;
  endTime?: number;
  stop?: () => void;     // 停止任务
}

export type QueueTaskInit = Pick<QueueTask, 'id' | 'title' | 'kind'> & Partial<Pick<QueueTask, 'filePath' | 'percent' | 'detail' | 'stop'>>;

const MAX_FINISHED: number = 30; // 最多保留多少条已结束的记录
const NOTIFY_INTERVAL: number = 400;

let tasks: Array<QueueTask> = [];
const listeners: Set<() => void> = new Set();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  tasks = [...tasks]; // useSyncExternalStore 靠引用变化判断更新

  for (const listener of listeners) listener();
}

/* 进度更新很频繁，合并成最多每 400ms 通知一次 */
function emitLater(): void {
  notifyTimer ??= setTimeout((): void => {
    notifyTimer = null;
    emit();
  }, NOTIFY_INTERVAL);
}

function find(id: string): QueueTask | undefined {
  return tasks.find((task: QueueTask): boolean => task.id === id);
}

/* 开始一个任务；同一个 id 再次开始时覆盖旧记录 */
export function queueTaskStart(init: QueueTaskInit): void {
  tasks = tasks.filter((task: QueueTask): boolean => task.id !== init.id);
  tasks.unshift({ ...init, status: 'running', startTime: Date.now() });

  const finished: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status !== 'running');

  if (finished.length > MAX_FINISHED) {
    const drop: Set<QueueTask> = new Set(finished.slice(MAX_FINISHED));

    tasks = tasks.filter((task: QueueTask): boolean => !drop.has(task));
  }

  emit();
}

/* 更新进度 */
export function queueTaskProgress(id: string, percent: number | undefined, detail?: string): void {
  const task: QueueTask | undefined = find(id);

  if (!task || task.status !== 'running') return;

  if (percent !== undefined) task.percent = Math.max(task.percent ?? 0, Math.min(100, percent));

  if (detail !== undefined) task.detail = detail;

  emitLater();
}

/* 结束一个任务；detail 是结束后显示的说明（例如压缩前后的大小），不传就清掉下载时的速度说明 */
export function queueTaskEnd(id: string, status: Exclude<QueueTaskStatus, 'running'>, error?: string, detail?: string): void {
  const task: QueueTask | undefined = find(id);

  if (!task || task.status !== 'running') return;

  task.status = status;
  task.error = error;
  task.detail = detail;
  task.endTime = Date.now();
  task.stop = undefined;

  if (status === 'done' && task.percent !== undefined) task.percent = 100;

  emit();
}

export function queueTaskRemove(id: string): void {
  tasks = tasks.filter((task: QueueTask): boolean => task.id !== id || task.status === 'running');
  emit();
}

export function queueClearFinished(): void {
  tasks = tasks.filter((task: QueueTask): boolean => task.status === 'running');
  emit();
}

export function getQueueTasks(): Array<QueueTask> {
  return tasks;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

/* React 里读取队列 */
export function useQueueTasks(): Array<QueueTask> {
  return useSyncExternalStore(subscribe, getQueueTasks);
}

/* 测试用：清空 */
export function resetQueueForTest(): void {
  tasks = [];
  listeners.clear();

  if (notifyTimer) clearTimeout(notifyTimer);

  notifyTimer = null;
}
