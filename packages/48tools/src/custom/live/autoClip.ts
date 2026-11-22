import { promises as fsP } from 'node:fs';
import { requestLiveRoomInfo, type LiveRoomInfo } from '@48tools-api/48';
import { readJson, writeJson } from '../common/util';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { startHighlight, canHighlight } from '../highlight/highlightTask';
import { findRecordingFiles } from './convertRecording';
import { isM3u8 } from './liveReconnect';
import { AutoClipper, type AutoClipEntry, type AutoClipRecord, type AutoClipOutcome } from './autoClipCore';

/**
 * 「自动抓取并切片」：流程见 ./autoClipCore，这里接上真正的录播查询、切片、删除录像、下载队列和本机存储。
 * 接入点：./liveRecording（录制开始、结束）、pages/48/Pocket48/utils/autoGrab.ts（选了这种方式时把直播信息带上）、
 * custom/shell/AppShell.tsx（程序启动后 resumeAutoClips）。
 */
const STORAGE_KEY: string = 'AUTO_CLIP_PENDING';

/* 删掉一个录像：xxx.flv 和断线重连产生的 xxx(1).flv、xxx(2).flv… */
async function removeRecording(file: string): Promise<void> {
  for (const item of new Set([file, ...findRecordingFiles(file)])) {
    await fsP.rm(item, { force: true });
  }
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: Error) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);

    signal.addEventListener('abort', (): void => {
      clearTimeout(timer);
      reject(new Error('已停止'));
    }, { once: true });
  });
}

const clipper: AutoClipper = new AutoClipper({
  async isReplayReady(liveId: string): Promise<boolean> {
    const res: LiveRoomInfo = await requestLiveRoomInfo(liveId);

    return Boolean(res?.success && res.content?.playStreamPath && isM3u8(res.content.playStreamPath));
  },
  startClip(record: AutoClipRecord, onEnd: (outcome: AutoClipOutcome, text: string) => void): string | undefined {
    return startHighlight(record, 'auto', onEnd);
  },
  removeRecording,
  load: (): Array<AutoClipEntry> => readJson<Array<AutoClipEntry>>(STORAGE_KEY, []),
  save: (entries: Array<AutoClipEntry>): void => writeJson(STORAGE_KEY, entries.length > 0 ? entries : undefined),
  taskStart(id: string, title: string, detail: string, stop: () => void): void {
    queueTaskStart({ id, title, kind: '自动切片', detail, stop });
  },
  taskDetail: (id: string, detail: string): void => queueTaskProgress(id, undefined, detail),
  taskEnd: (id: string, status: 'done' | 'stopped' | 'error', detail: string): void => {
    queueTaskEnd(id, status, status === 'error' ? detail : undefined, status === 'error' ? undefined : detail);
  },
  wait: waitFor,
  now: (): number => Date.now()
});

/* 这场直播能不能「录完切片」（电台没有画面，不能切） */
export function canAutoClip(record: AutoClipRecord): boolean {
  return canHighlight(record);
}

export function autoClipRecordingStart(record: AutoClipRecord, file: string): void {
  clipper.recordingStart(record, file);
}

export function isAutoClip(liveId: string): boolean {
  return clipper.has(liveId);
}

export function autoClipRecordingEnd(liveId: string): void {
  clipper.recordingEnd(liveId);
}

/* 程序启动后调用：上次没做完的接着做 */
export function resumeAutoClips(): void {
  try {
    clipper.resume();
  } catch (err) {
    console.error('自动切片：恢复上次没做完的失败', err);
  }
}
