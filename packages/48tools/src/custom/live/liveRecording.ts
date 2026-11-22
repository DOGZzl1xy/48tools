import * as fs from 'node:fs';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { queueTaskStart, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { convertRecordingFiles, findRecordingFiles, type RecordFormat } from './convertRecording';
import { autoClipRecordingStart, autoClipRecordingEnd, isAutoClip, canAutoClip } from './autoClip';
import type { AutoClipRecord } from './autoClipCore';

/**
 * 直播录制的几个接入函数：
 *   - getLiveRecordDir：自动录制保存的文件夹。local/pocket48.json 里配置了 liveRecordDir（没有就用 downloadDir）时，
 *     优先于界面「自动抓取配置」里填的目录
 *   - liveRecordingStart / liveRecordingEnd：录制开始、结束时登记到下载队列；结束后按 liveRecordFormat 转成 mp4
 *   - 「自动抓取并切片」（传了 autoClip）：录完不转 mp4，等录播出来后自动切片，切完删掉录像（见 ./autoClip）
 * 接入点：pages/48/Pocket48/utils/autoGrab.ts（自动录制）、Pocket48Live.tsx（手动录制）。
 */
export interface LiveRecordingInfo {
  liveId: string;
  title: string;    // 显示用：成员 + 直播标题
  filePath: string;
  autoClip?: AutoClipRecord; // 「自动抓取并切片」：这场直播的信息（电台不能切，照常录）
  stop?: () => void;
}

/* 自动录制保存的文件夹 */
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
  const clip: boolean = Boolean(info.autoClip && canAutoClip(info.autoClip));

  if (clip) autoClipRecordingStart(info.autoClip!, info.filePath);

  queueTaskStart({
    id: taskId(info.liveId),
    title: info.title,
    kind: '直播录制',
    filePath: info.filePath,
    detail: clip ? '录制中…（直播结束后自动切片，切完删掉录像）' : (info.autoClip ? '录制中…（电台不能切片，录像照常保留）' : '录制中…'),
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
  const clip: boolean = isAutoClip(info.liveId);
  const clipText: string | undefined = clip ? '直播结束后等录播出来自动切片，切完删掉录像（进度在「自动切片」那一项）' : undefined;

  if (error) {
    queueTaskEnd(taskId(info.liveId), 'error', error, clipText);
  } else {
    queueTaskEnd(taskId(info.liveId), hasFile ? 'done' : 'error', hasFile ? undefined : '没有录到内容', clipText);
  }

  // 「自动抓取并切片」：不转 mp4（切完就删），等录播出来后切片
  if (clip) {
    autoClipRecordingEnd(info.liveId);

    return;
  }

  // 出错时已经录下来的部分也照常转换
  convertRecordingFiles(info.filePath, getLiveRecordFormat(), ffmpeg).catch((err: unknown): void => {
    console.error('录像转换失败', err);
  });
}
