/* 进度说明：下载速度、剩余时间、已下载大小 */
export interface ProgressStats {
  speed?: number;      // 字节/秒
  eta?: number;        // 秒
  downloaded?: number; // 字节
  stage?: 'download' | 'merge' | 'audio';
}

/* 格式化字节数 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${ Math.round(bytes) } B`;

  const units: Array<string> = ['KB', 'MB', 'GB', 'TB'];
  let value: number = bytes / 1024;
  let index: number = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${ value.toFixed(value >= 100 ? 0 : 1) } ${ units[index] }`;
}

/* 格式化剩余时间 */
export function formatDuration(seconds: number): string {
  const s: number = Math.max(0, Math.round(seconds));

  if (s < 60) return `${ s }秒`;

  const h: number = Math.floor(s / 3600);
  const m: number = Math.floor((s % 3600) / 60);

  if (h > 0) return `${ h }小时${ String(m).padStart(2, '0') }分`;

  return `${ m }分${ String(s % 60).padStart(2, '0') }秒`;
}

/* 生成进度说明文字，例如「3.2 MB/s · 剩余 1分23秒 · 已下载 120 MB」 */
export function formatProgressDetail(stats: ProgressStats): string {
  if (stats.stage === 'merge') return '下载完成，正在合并分段…';

  if (stats.stage === 'audio') return '下载完成，正在封装音频…';

  const parts: Array<string> = [];

  if (stats.speed !== undefined && Number.isFinite(stats.speed)) {
    parts.push(`${ formatBytes(stats.speed) }/s`);
  }

  if (stats.eta !== undefined && Number.isFinite(stats.eta)) {
    parts.push(`剩余 ${ formatDuration(stats.eta) }`);
  } else if (parts.length > 0) {
    parts.push('剩余时间计算中…');
  }

  if (stats.downloaded !== undefined) {
    parts.push(`已下载 ${ formatBytes(stats.downloaded) }`);
  }

  return parts.join(' · ');
}
