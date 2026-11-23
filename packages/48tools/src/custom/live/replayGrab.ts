import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { requestLiveRoomInfo, type LiveRoomInfo } from '@48tools-api/48';
import { readJson, writeJson } from '../common/util';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { canHighlight, isRadio, downloadFullReplay, startHighlightFromFile } from '../highlight/highlightTask';
import { getFilePath, getFileTime } from '../../utils/utils';
import { findRecordingFiles } from './convertRecording';
import { isM3u8 } from './liveReconnect';
import { getLiveRecordDir } from './liveRecording';
import { ReplayGrabber, saveDirOf, type GrabActions, type GrabEntry, type GrabFiles, type GrabRecord, type GrabOutcome } from './replayGrabCore';

/**
 * 自动抓取：开播时只记下来，直播结束后下载录播、切片。流程见 ./replayGrabCore，这里接上真正的录播查询、下载、切片、
 * 删除文件、下载队列和本机存储。
 * 接入点：pages/48/Pocket48/utils/autoGrab.ts（发现盯着的成员开播时 trackLive）、custom/shell/AppShell.tsx（程序启动后 resumeReplayGrabs）。
 */
const STORAGE_KEY: string = 'AUTO_GRAB_PENDING';
const LEGACY_KEY: string = 'AUTO_CLIP_PENDING'; // 旧版「录制并自动切片」没做完的

interface LegacyEntry {
  record: GrabRecord;
  files?: Array<string>;
}

/* 本机存的待办；旧版「录制并自动切片」留下的转成「只切片」，切完连当时录的录像一起删 */
function load(): Array<GrabEntry> {
  const entries: Array<GrabEntry> = readJson<Array<GrabEntry>>(STORAGE_KEY, []);
  const legacy: Array<LegacyEntry> = readJson<Array<LegacyEntry>>(LEGACY_KEY, []);

  if (legacy.length > 0) {
    for (const old of legacy) {
      if (old?.record?.liveId && !entries.some((entry: GrabEntry): boolean => entry.record.liveId === old.record.liveId)) {
        const files: Array<string> = old.files ?? [];

        // 录播下到当时录像所在的文件夹
        entries.push({ record: old.record, actions: { full: false, clip: true }, dir: files[0] ? path.dirname(files[0]) : getLiveRecordDir(''), legacy: files });
      }
    }

    writeJson(STORAGE_KEY, entries);
    writeJson(LEGACY_KEY, undefined);
  }

  return entries;
}

/* 删掉一个文件；录像连同断线重连产生的 xxx(1).flv、xxx(2).flv… */
async function removeFile(file: string): Promise<void> {
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

/* 下载完整的录播和弹幕：文件名和「录播下载」手动下的一样，弹幕是同名的 .lrc；电台只存录音，电台封面是同名的 .jpg */
async function download(
  entry: GrabEntry, report: (percent: number, detail: string) => void, signal: AbortSignal
): Promise<GrabFiles> {
  const { record }: GrabEntry = entry;
  const radio: boolean = isRadio(record);
  const name: string = getFilePath({
    typeTitle: radio ? '口袋48录播音频' : '口袋48录播',
    infoArray: [record.userInfo.nickname, record.title, getFileTime(record.ctime), record.liveId],
    ext: radio ? '.m4a' : '.mp4'
  });
  const dir: string = saveDirOf(entry, getLiveRecordDir(''));

  if (!dir) throw new Error('不知道录播存到哪里：先在「自动抓取配置」或「设置 → 保存位置」里选一个文件夹');

  const file: string = path.join(dir, name);
  const cover: string | undefined = radio ? file.replace(/\.[^.\\/]+$/, '.jpg') : undefined;
  const { danmu }: { danmu?: string } = await downloadFullReplay(record.liveId, file, report, signal, cover);
  let danmuFile: string | undefined;

  if (danmu) {
    danmuFile = file.replace(/\.[^.\\/]+$/, '.lrc');
    await fsP.writeFile(danmuFile, danmu, { encoding: 'utf8' });
  }

  return { file, danmuFile, coverFile: cover && fs.existsSync(cover) ? cover : undefined };
}

const grabber: ReplayGrabber = new ReplayGrabber({
  async isReplayReady(liveId: string): Promise<boolean> {
    const res: LiveRoomInfo = await requestLiveRoomInfo(liveId);

    return Boolean(res?.success && res.content?.playStreamPath && isM3u8(res.content.playStreamPath));
  },
  download,
  canClip: canHighlight,
  startClip(record: GrabRecord, file: string, danmuFile: string | undefined, onEnd: (outcome: GrabOutcome, text: string) => void): string | undefined {
    return startHighlightFromFile(record, file, danmuFile, onEnd);
  },
  remove: removeFile,
  load,
  save: (entries: Array<GrabEntry>): void => writeJson(STORAGE_KEY, entries.length > 0 ? entries : undefined),
  taskStart(id: string, title: string, detail: string, stop: () => void): void {
    queueTaskStart({ id, title, kind: '自动抓取', detail, stop });
  },
  taskProgress: (id: string, percent: number | undefined, detail: string): void => queueTaskProgress(id, percent, detail),
  taskEnd: (id: string, status: GrabOutcome, detail: string): void => {
    queueTaskEnd(id, status, status === 'error' ? detail : undefined, status === 'error' ? undefined : detail);
  },
  wait: waitFor,
  now: (): number => Date.now()
});

/* 盯着的成员开播了：记下来，结束后按勾选的下载、切片（已经记过的不重复记） */
export function trackLive(record: GrabRecord, actions: GrabActions, dir: string): void {
  grabber.track(record, actions, dir);
}

/* 这场直播已经记下了（还没做完） */
export function isTrackedLive(liveId: string): boolean {
  return grabber.has(liveId);
}

/* 程序启动后调用：上次没做完的接着做 */
export function resumeReplayGrabs(): void {
  try {
    grabber.resume();
  } catch (err) {
    console.error('自动抓取：恢复上次没做完的失败', err);
  }
}
