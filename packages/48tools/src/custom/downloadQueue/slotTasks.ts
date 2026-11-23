import { queueTaskProgress } from './downloadQueue';
import { downloadSlot, type SlotTicket } from '../download/downloadSlot';

/**
 * 用 worker 下载的地方和别的录播下载排队（同一时间只下一场，见 ../download/downloadSlot）：
 * 轮到了才开始；排队时下载队列里这一项显示「排队中」；排队时点停止就直接不排了。
 * 接入点：./recordTasks（录播下载）、Live48/InVideo（公演录播下载）。
 */
const waiting: Map<string, () => void> = new Map(); // 下载队列里的 id → 不排了

export const WAITING_TEXT: string = '排队中：等前面的下载完再下（同一时间只下一场）…';

/**
 * 排队，轮到了调用 start。返回下完（结束、出错、停止）后要调用的函数，让给下一场
 * @param { string } queueId - 下载队列里这一项的 id（要先 queueTaskStart）
 * @param { () => void } start - 真正开始下载
 * @param { () => void } cancelled - 排队时点了停止（不会再调用 start）
 */
export function startInSlot(queueId: string, start: () => void, cancelled: () => void): () => void {
  const ticket: SlotTicket = downloadSlot.take();

  if (ticket.waiting()) {
    queueTaskProgress(queueId, 0, WAITING_TEXT);
    waiting.set(queueId, (): void => {
      ticket.release();
      cancelled();
    });
  }

  ticket.ready.then((): void => {
    waiting.delete(queueId);
    start();
  });

  return (): void => ticket.release();
}

/* 点了停止：还在排队的就不排了（返回 true）；已经开始下的返回 false，由调用的地方让下载停下 */
export function cancelWaitingInSlot(queueId: string): boolean {
  const cancel: (() => void) | undefined = waiting.get(queueId);

  if (!cancel) return false;

  waiting.delete(queueId);
  cancel();

  return true;
}
