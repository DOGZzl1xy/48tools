import type { ProgressStats } from './formatProgress';

/**
 * 从 ffmpeg 的进度输出（size=... time=... speed=1.5x）里算出已下载大小、速度和剩余时间。
 * 接入点：utils/worker/FFmpegDownload.worker 发送 progress 消息时附带这些字段。
 * @param { string } str - ffmpeg stderr 的一段输出
 * @param { number } elapsed - 已经运行的秒数
 * @param { number } duration - 总时长（秒）
 * @param { number } time - 已处理到的时间（秒）
 */
export function parseFFmpegStats(str: string, elapsed: number, duration: number, time: number): ProgressStats {
  const speedFactor: RegExpMatchArray | null = str.match(/speed=\s*([\d.]+)x/i);
  const sizeMatch: RegExpMatchArray | null = str.match(/size=\s*(\d+)\s*(KiB|kB)/i);
  const downloaded: number | undefined = sizeMatch ? Number(sizeMatch[1]) * 1024 : undefined;
  const factor: number = speedFactor ? Number(speedFactor[1]) : 0;

  return {
    stage: 'download',
    downloaded,
    speed: downloaded !== undefined && elapsed > 0 ? downloaded / elapsed : undefined,
    eta: factor > 0 ? Math.max(0, duration - time) / factor : undefined
  };
}
