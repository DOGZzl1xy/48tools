import * as fs from 'node:fs';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { queueTaskStart, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { convertRecordingFiles, findRecordingFiles, type RecordFormat } from './convertRecording';

/**
 * 直播录制的几个接入函数：
 *   - getLiveRecordDir：自动抓取保存的文件夹。local/pocket48.json 里配置了 liveRecordDir（没有就用 downloadDir）时，
 *     优先于界面「自动抓取配置」里填的目录（自动抓取现在下载的是直播结束后的录播，见 ./replayGrab）
 *   - liveRecordingStart / liveRecordingEnd：录制开始、结束时登记到下载队列；结束后按 liveRecordFormat 转成 mp4
 * 接入点：Pocket48Live.tsx（页面上手动点「录制」）。自动抓取以前也用它录直播流，2026-11-23 起改成只记下来、结束后下载录播。
 */
export interface LiveRecordingInfo {
  liveId: string;
  title: string;    // 显示用：成员 + 直播标题
  filePath: string;
  stop?: () => void;
}

/* 自动抓取保存的文件夹 */
export function getLiveRecordDir(dir: string): string {
  return resolveLocalDir(getSetting('liveRecordDir')) ?? resolveLocalDir(getSetting('downloadDir')) ?? dir;
}

export function getLiveRecordFormat(): RecordFormat {
  const format: string | undefined = getSetting('liveRecordFormat');

  return format === 'mp4' || format === 'mp4-compress' ? format : 'flv';
}

function taskId(liveId: string): string {
  return `live:${ liveId }`;
}

/* 录制开始 */
export function liveRecordingStart(info: LiveRecordingInfo): void {
  queueTaskStart({
    id: taskId(info.liveId),
    title: info.title,
    kind: '直播录制',
    filePath: info.filePath,
    detail: '录制中…',
    stop: info.stop
  });
}

/**
 * 录制结束（直播结束、手动停止或出错）
 * @param { LiveRecordingInfo } info
 * @param { string } ffmpeg - 配置的 ffmpeg
 * @param { string } [error] - 出错信息
 */
export function liveRecordingEnd(info: Pick<LiveRecordingInfo, 'liveId' | 'filePath'>, ffmpeg: string, error?: string): void {
  const hasFile: boolean = findRecordingFiles(info.filePath).length > 0 || fs.existsSync(info.filePath);

  if (error) {
    queueTaskEnd(taskId(info.liveId), 'error', error);
  } else {
    queueTaskEnd(taskId(info.liveId), hasFile ? 'done' : 'error', hasFile ? undefined : '没有录到内容');
  }

  // 出错时已经录下来的部分也照常转换
  convertRecordingFiles(info.filePath, getLiveRecordFormat(), ffmpeg).catch((err: unknown): void => {
    console.error('录像转换失败', err);
  });
}
