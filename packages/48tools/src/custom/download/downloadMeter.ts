import type { ProgressStats } from './formatProgress';

/**
 * 根据最近几个分片的耗时计算下载速度和剩余时间。
 * 耗时包含下载、解析和写入，所以剩余时间是整体的预计时间；按分片的播放时长加权，分片长短不一时也比较准。
 */
class DownloadMeter {
  static readonly windowSize: number = 12;
  readonly #segments: Array<{ duration: number }>;
  readonly #remainingMedia: Array<number>; // 每个分片之后剩余的播放时长
  #window: Array<{ bytes: number; ms: number; media: number }> = [];
  #lastTime: number = performance.now();
  downloaded: number = 0;

  constructor(segments: Array<{ duration: number }>) {
    this.#segments = segments;
    this.#remainingMedia = new Array(segments.length).fill(0);

    for (let index: number = segments.length - 2; index >= 0; index--) {
      this.#remainingMedia[index] = this.#remainingMedia[index + 1] + segments[index + 1].duration;
    }
  }

  /**
   * 一个分片处理完后调用
   * @param { number } index - 分片序号
   * @param { number } bytes - 分片大小
   */
  tick(index: number, bytes: number): ProgressStats {
    const now: number = performance.now();

    this.downloaded += bytes;
    this.#window.push({ bytes, ms: now - this.#lastTime, media: this.#segments[index].duration });
    this.#lastTime = now;

    if (this.#window.length > DownloadMeter.windowSize) this.#window.shift();

    let sumBytes: number = 0,
      sumMs: number = 0,
      sumMedia: number = 0;

    for (const item of this.#window) {
      sumBytes += item.bytes;
      sumMs += item.ms;
      sumMedia += item.media;
    }

    const stats: ProgressStats = { downloaded: this.downloaded, stage: 'download' };

    if (sumMs <= 0) return stats;

    stats.speed = sumBytes / sumMs * 1000;

    // 至少有 3 个分片的数据再估算剩余时间，避免开头跳动太大
    if (this.#window.length >= 3) {
      const remainingSegments: number = this.#segments.length - index - 1;
      const remainingMedia: number = this.#remainingMedia[index];

      stats.eta = sumMedia > 0 && remainingMedia > 0
        ? remainingMedia * (sumMs / sumMedia) / 1000
        : remainingSegments * (sumMs / this.#window.length) / 1000;
    }

    return stats;
  }
}

export default DownloadMeter;
