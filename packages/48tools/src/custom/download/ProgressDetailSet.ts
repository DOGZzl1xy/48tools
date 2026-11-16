import ProgressSet from '../../components/ProgressNative/ProgressSet';
import { formatProgressDetail, type ProgressStats } from './formatProgress';

/**
 * 在原来的 ProgressSet 上增加进度条和说明文字（速度、剩余时间、已下载大小）。
 * 和 ProgressSet 一样直接更新 dom，避免频繁渲染表格。
 * 接入点：pages/48/reducers/pocket48.ts 用它代替 ProgressSet，Pocket48Record 用 ProgressDetail 渲染。
 */
class ProgressDetailSet extends ProgressSet {
  public barId: string;
  public detailId: string;
  #detail: string = '';

  constructor(id: string) {
    super(id);
    this.barId = `progress-detail-bar-${ id }`;
    this.detailId = `progress-detail-text-${ id }`;
  }

  override update(v: number): void {
    if (v > this.value) {
      const bar: HTMLElement | null = document.getElementById(this.barId);

      if (bar) bar.style.width = `${ Math.min(100, v) }%`;
    }

    super.update(v);
  }

  get detail(): string {
    return this.#detail;
  }

  set detail(text: string) {
    if (text === this.#detail) return;

    this.#detail = text;

    const detail: HTMLElement | null = document.getElementById(this.detailId);

    if (detail) detail.textContent = text;
  }
}

/* reducer 里调用：如果是 ProgressDetailSet，就根据 worker 发来的统计信息更新说明 */
export function updateProgressDetail(progressSet: ProgressSet | undefined, stats: ProgressStats): void {
  if (progressSet instanceof ProgressDetailSet) {
    progressSet.detail = formatProgressDetail(stats);
  }
}

export default ProgressDetailSet;
