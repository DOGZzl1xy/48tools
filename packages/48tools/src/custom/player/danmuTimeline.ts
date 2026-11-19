import type { DanmuItem } from '../../pages/PlayerWindow/types';

/**
 * 回放弹幕的时间轴：弹幕文件里每条弹幕都带着它在视频里出现的时间（秒），
 * 播放到哪里，就显示到哪一条。这里是和界面无关的计算，方便测试。
 */

/* 按出现时间从早到晚排好（时间相同的保持文件里的顺序） */
export function sortDanmu(list: Array<DanmuItem>): Array<DanmuItem> {
  return [...list].sort((a: DanmuItem, b: DanmuItem): number => a.currentTime - b.currentTime);
}

/**
 * 播放到 time 秒时，已经出现了多少条弹幕（list 必须已经按时间排好）
 * @param { Array<DanmuItem> } list - 弹幕
 * @param { number } time - 视频当前播放到的秒数
 */
export function countUpTo(list: Array<DanmuItem>, time: number): number {
  let low: number = 0;
  let high: number = list.length;

  while (low < high) {
    const middle: number = (low + high) >>> 1;

    if (list[middle].currentTime <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

/* 秒数显示成 5:43 或 1:05:43 */
export function shortTime(seconds: number): string {
  const total: number = Math.max(0, Math.floor(seconds));
  const hour: number = Math.floor(total / 3_600);
  const minute: number = Math.floor((total % 3_600) / 60);
  const second: string = String(total % 60).padStart(2, '0');

  return hour > 0 ? `${ hour }:${ String(minute).padStart(2, '0') }:${ second }` : `${ minute }:${ second }`;
}
