import type { ProgressStats } from './formatProgress';

/**
 * 根据最近一段时间下完的分片计算下载速度和剩余时间。
 * 按时间取最近 WINDOW_MS（不够 MIN_SAMPLES 个分片时往前多取一些）：分片是同时下的，一批一批地完成，
 * 前面的停住时后面的会攒着一起处理，只看最近几个分片的间隔的话，速度会忽高忽低。
 * 剩余时间按还没下的播放时长算（分片长短不一时也比较准），分片不按顺序完成也可以。
 */
const WINDOW_MS: number = 30_000;
const MIN_SAMPLES: number = 12;
const MIN_FOR_ETA: number = 3; // 至少有几个分片的数据再估算剩余时间，避免开头跳动太大

interface Sample {
  bytes: number;
  media: number;
  time: number;
}

class DownloadMeter {
  readonly #segments: Array<{ duration: number }>;
  readonly #now: () => number;
  #samples: Array<Sample> = [];
  #since: number;          // 最早那个样本是从什么时候开始算的
  #remainingMedia: number; // 还没下的播放时长
  #remaining: number;      // 还没下的分片数
  downloaded: number = 0;

  /**
   * @param { Array<{ duration: number }> } segments - 整场的分片
   * @param { Array<number> } [pending] - 要下的是哪几个（断点续传时只有没下过的），默认全部
   * @param { () => number } [now] - 测试时换掉
   */
  constructor(segments: Array<{ duration: number }>, pending?: Array<number>, now: () => number = (): number => performance.now()) {
    const list: Array<{ duration: number }> = pending ? pending.map((index: number): { duration: number } => segments[index]) : segments;

    this.#segments = segments;
    this.#now = now;
    this.#since = now();
    this.#remaining = list.length;
    this.#remainingMedia = list.reduce((sum: number, item: { duration: number }): number => sum + item.duration, 0);
  }

  /**
   * 一个分片处理完后调用
   * @param { number } index - 分片序号
   * @param { number } bytes - 分片大小
   */
  tick(index: number, bytes: number): ProgressStats {
    const now: number = this.#now();
    const media: number = this.#segments[index].duration;

    this.downloaded += bytes;
    this.#remaining = Math.max(0, this.#remaining - 1);
    this.#remainingMedia = Math.max(0, this.#remainingMedia - media);
    this.#samples.push({ bytes, media, time: now });

    while (this.#samples.length > MIN_SAMPLES && now - this.#samples[0].time > WINDOW_MS) {
      this.#since = this.#samples[0].time;
      this.#samples.shift();
    }

    const ms: number = now - this.#since;
    const stats: ProgressStats = { downloaded: this.downloaded, stage: 'download' };

    if (ms <= 0) return stats;

    stats.speed = this.#samples.reduce((sum: number, item: Sample): number => sum + item.bytes, 0) / ms * 1000;

    if (this.#samples.length >= MIN_FOR_ETA) {
      const sampleMedia: number = this.#samples.reduce((sum: number, item: Sample): number => sum + item.media, 0);

      stats.eta = sampleMedia > 0 && this.#remainingMedia > 0
        ? this.#remainingMedia * (ms / sampleMedia) / 1000
        : this.#remaining * (ms / this.#samples.length) / 1000;
    }

    return stats;
  }
}

export default DownloadMeter;
