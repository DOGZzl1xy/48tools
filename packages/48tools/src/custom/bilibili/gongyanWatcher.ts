import * as path from 'node:path';
import * as process from 'node:process';
import { requestOpenLiveList, type OpenLiveList } from '@48tools-api/48';
import { readJson, writeJson } from '../common/util';
import { getSetting } from '../settings/settingsStore';
import { resolveLocalDir } from '../download/defaultSaveDir';
import { roomInfo } from './biliApi';
import { BILI_GONGYAN_ROOM, beijingClock, inWatchWindow, liveWantedShows, type ShowInfo } from './gongyanSchedule';
import { startGongyanRecording, stopGongyanRecording, isGongyanRecording, type GongyanManifest } from './gongyanRecorder';
import { findRecordingDir, unfinishedRecordings } from './gongyanFiles';
import { startGongyanHighlight } from './gongyanHighlight';
import { prepareGongyanSource } from './gongyanSource';

/**
 * B 站公演自动录制并切片：程序开着时，在北京时间 13:30、18:30（19:30）前后每分钟看一次口袋48的公演列表，
 * SNH48 SII / NII / HII / X 的公演开播了、B 站 SNH48 直播间（短号 48）也在直播，就开始录 B 站的视频和弹幕（./gongyanRecorder），
 * 录完自动切片（./gongyanHighlight）。录过的场次记在本机，程序重启不会重录。设置里可以关（gongyanAuto）。
 * 接入点：custom/shell/AppShell.tsx（程序启动后 startGongyanWatcher）。
 */
const CHECK_MS: number = 60_000;
const STORAGE_KEY: string = 'GONGYAN_RECORDED';
const FOLDER: string = 'B站公演';

let timer: ReturnType<typeof setInterval> | undefined;
let checking: boolean = false;

/* 公演录像放在哪：直播录制文件夹，没有就默认保存文件夹，下面的「B站公演」 */
export function gongyanBaseDir(): string | undefined {
  const dir: string | undefined = resolveLocalDir(getSetting('liveRecordDir')) ?? resolveLocalDir(getSetting('downloadDir'));

  return dir ? path.join(dir, FOLDER) : undefined;
}

function notify(title: string, body: string): void {
  try {
    typeof Notification !== 'undefined' && new Notification(title, { body });
  } catch { /* 系统不让弹通知就算了 */ }
}

function recorded(): Array<string> {
  const list: unknown = readJson<unknown>(STORAGE_KEY, []);

  return Array.isArray(list) ? list.filter((item: unknown): item is string => typeof item === 'string') : [];
}

function markRecorded(liveId: string): void {
  writeJson(STORAGE_KEY, [liveId, ...recorded().filter((item: string): boolean => item !== liveId)].slice(0, 100));
}

async function check(): Promise<void> {
  if (checking || getSetting('gongyanAuto') === false || isGongyanRecording()) return;

  const baseDir: string | undefined = gongyanBaseDir();

  if (!baseDir) return;

  // 录到一半程序重启了的场次（有文件夹、没写结束时间）：不管在不在监测时段都要接着录
  const inWindow: boolean = inWatchWindow(new Date());

  if (!inWindow && unfinishedRecordings(baseDir).length === 0) return;

  checking = true;

  try {
    const res: OpenLiveList = await requestOpenLiveList({ record: false });
    const candidates: Array<{ show: ShowInfo & { team: string }; resume?: { dir: string; manifest: GongyanManifest } }> = liveWantedShows(res?.content?.liveList ?? [])
      .map((item: ShowInfo & { team: string }): { show: ShowInfo & { team: string }; resume?: { dir: string; manifest: GongyanManifest } } =>
        ({ show: item, resume: findRecordingDir(baseDir, item.liveId) }))
      .filter((item: { show: ShowInfo; resume?: { manifest: GongyanManifest } }): boolean =>
        (item.resume ? !item.resume.manifest.endedAt : inWindow && !recorded().includes(item.show.liveId)));

    if (candidates.length === 0) return;

    if (!(await roomInfo(BILI_GONGYAN_ROOM)).live) return; // 口袋48 开播了但 B 站还没开：下一分钟再看

    const { show, resume }: { show: ShowInfo & { team: string }; resume?: { dir: string; manifest: GongyanManifest } } = candidates[0];

    markRecorded(show.liveId);
    startGongyanRecording(resume?.manifest.show ?? {
      liveId: show.liveId,
      title: show.title,
      subTitle: show.subTitle,
      team: show.team,
      day: beijingClock(new Date()).day
    }, baseDir, BILI_GONGYAN_ROOM, (manifestFile: string): void => {
      void startGongyanHighlight(manifestFile).then((reason: string | undefined): void => {
        if (reason) notify(`公演录好了，但没有自动切片：${ show.title }`, reason);
      });
    }, resume);
  } catch (err) {
    console.warn('B 站公演：检查开播失败', err);
  } finally {
    checking = false;
  }
}

export function startGongyanWatcher(): void {
  // 检查脚本用（只有 TEST=true 启动时才有）：不等口袋48开播，直接录一个 B 站直播间；切片要另外调用
  if (process.env.TEST === 'true') {
    Object.assign(globalThis, {
      __gongyanTest: { startGongyanRecording, stopGongyanRecording, isGongyanRecording, startGongyanHighlight, prepareGongyanSource, roomInfo }
    });
  }

  if (timer) return;

  timer = setInterval((): void => {
    void check();
  }, CHECK_MS);
  void check();
}
