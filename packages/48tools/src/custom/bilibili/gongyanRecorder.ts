import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { getFFmpeg } from '../../utils/utils';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../downloadQueue/downloadQueue';
import { safeFileName, clock } from '../highlight/highlightTime';
import { roomInfo, playUrl, type BiliRoomInfo } from './biliApi';
import { BiliDanmuRecorder } from './biliDanmuRecorder';

/**
 * 录一场 B 站直播的公演：视频（ffmpeg 拷贝着存成 ts，断了就接着录下一段）+ 弹幕（./biliDanmuRecorder），
 * 存 ts 不存 flv：断线、点停止时最后一点数据是写了一半的，flv 写坏的结尾会让后面把几段接起来时只接上第一段，ts 不会。
 * 放在一个文件夹里，manifest.json 记下每一段是什么时候开始、结束的（切片时按它把几段接起来、对上弹幕的时间）。
 *   - 断线后房间还在直播就 3 秒后接着录（新的一段）；查了几次都不在直播了（或者点了停止）就结束
 *   - 下载队列里显示录了多久、多少条弹幕；结束后调用 onDone（开始切片）
 * 接入点：./gongyanWatcher（口袋48公演开播时）。
 */
export interface GongyanShow {
  liveId: string;   // 口袋48 公演的 liveId
  title: string;    // 《Fire X》2.0公演
  subTitle: string; // Team X 剧场公演
  team: string;     // X / NII / HII
  day: string;      // 北京时间的日期 2026-11-21
}

export interface GongyanPart {
  file: string;     // 文件名（在这个文件夹里）
  start: number;    // 开始录的时间（毫秒）
  end?: number;
}

export interface GongyanManifest {
  version: 1;
  room: number;         // B 站实际房间号
  show: GongyanShow;
  biliTitle: string;
  cover: string;        // B 站直播间封面
  startedAt: number;
  endedAt?: number;
  parts: Array<GongyanPart>;
  danmu: string;        // 弹幕文件名
  danmuCount?: number;
}

export const MANIFEST: string = 'manifest.json';
const DANMU_FILE: string = 'danmu.lrc';
const OFFLINE_CHECKS: number = 3;          // 断了以后连着查这么多次都不在直播，才算结束
const OFFLINE_CHECK_MS: number = 30_000;
const RESTART_MS: number = 3_000;
const UA: string = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const running: Map<string, () => void> = new Map(); // liveId → 停止

export function isGongyanRecording(liveId?: string): boolean {
  return liveId ? running.has(liveId) : running.size > 0;
}

/* 停止录制（和在下载队列里点停止一样：录好的部分照样拿去切片） */
export function stopGongyanRecording(liveId: string): void {
  running.get(liveId)?.();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): unknown => setTimeout(resolve, ms));
}

/* 用 ffmpeg 录一段，直到流断了或者停止；返回 ffmpeg 的最后几行输出（出错时看） */
function recordPart(url: string, file: string, setChild: (child: ChildProcessWithoutNullStreams | null) => void): Promise<string> {
  return new Promise((resolve: (log: string) => void): void => {
    const child: ChildProcessWithoutNullStreams = spawn(getFFmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-nostats',
      '-rw_timeout', '15000000', // 15 秒收不到数据就当断了
      '-user_agent', UA,
      '-headers', 'Referer: https://live.bilibili.com\r\n',
      '-i', url,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts',
      '-y', file
    ], { windowsHide: true });
    const log: Array<string> = [];

    setChild(child);
    child.stdout.resume();
    child.stderr.on('data', (data: Buffer): void => {
      log.push(data.toString());

      if (log.length > 20) log.shift();
    });
    child.on('error', (err: Error): void => {
      setChild(null);
      resolve(String(err));
    });
    child.on('close', (): void => {
      setChild(null);
      resolve(log.join('').trim());
    });
  });
}

async function writeManifest(dir: string, manifest: GongyanManifest): Promise<void> {
  await fsP.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
}

/**
 * 开始录（不等录完）
 * @param { GongyanShow } show
 * @param { string } baseDir - 录像放在它下面的「日期 队伍 公演名」文件夹里
 * @param { number | string } room - B 站房间号（短号也行）
 * @param { (manifestFile: string) => void } onDone - 录完（不管是直播结束还是点了停止）后调用
 */
export function startGongyanRecording(
  show: GongyanShow, baseDir: string, room: number | string, onDone: (manifestFile: string) => void
): void {
  if (running.has(show.liveId)) return;

  let stopped: boolean = false;
  let child: ChildProcessWithoutNullStreams | null = null;
  const stop: () => void = (): void => {
    stopped = true;
    child?.kill();
  };
  const id: string = `gongyan:${ show.liveId }`;
  const dir: string = path.join(baseDir, safeFileName(`${ show.day } ${ show.team } ${ show.title }`, 80));

  running.set(show.liveId, stop);
  queueTaskStart({ id, title: `B站公演 ${ show.team } ${ show.title }`, kind: 'B站公演录制', filePath: dir, detail: '准备录制…', stop });

  void (async (): Promise<void> => {
    let manifest: GongyanManifest | undefined;
    let danmu: BiliDanmuRecorder | undefined;
    let danmuCount: number = 0;

    try {
      await fsP.mkdir(dir, { recursive: true });

      const info: BiliRoomInfo = await roomInfo(room);
      const startedAt: number = Date.now();

      manifest = {
        version: 1, room: info.roomId, show, biliTitle: info.title, cover: info.cover || info.keyframe, startedAt, parts: [], danmu: DANMU_FILE
      };
      danmu = new BiliDanmuRecorder({
        roomId: info.roomId,
        file: path.join(dir, DANMU_FILE),
        startedAt,
        onCount: (count: number): void => {
          danmuCount = count;
        }
      });
      danmu.start();

      const progress: ReturnType<typeof setInterval> = setInterval((): void => {
        queueTaskProgress(id, undefined, `录制中… 已录 ${ clock((Date.now() - startedAt) / 1_000) }，弹幕 ${ danmuCount } 条，${ manifest!.parts.length } 段`);
      }, 5_000);

      try {
        while (!stopped) {
          let url: string;

          try {
            url = (await playUrl(info.roomId)).url;
          } catch (err) {
            console.warn('B 站公演：取不到直播地址', err);
            url = '';
          }

          if (url) {
            const part: GongyanPart = { file: `part-${ String(manifest.parts.length + 1).padStart(2, '0') }.ts`, start: Date.now() };

            manifest.parts.push(part);
            await writeManifest(dir, manifest);

            const log: string = await recordPart(url, path.join(dir, part.file), (c: ChildProcessWithoutNullStreams | null): void => {
              child = c;
            });

            part.end = Date.now();
            await writeManifest(dir, manifest);

            if (log) console.warn('B 站公演：一段录制结束', part.file, log.slice(-300));
          }

          if (stopped) break;

          // 断了：房间还在直播就接着录，连着几次都不在直播就结束
          let live: boolean = false;

          for (let i: number = 0; i < OFFLINE_CHECKS && !stopped; i++) {
            try {
              live = (await roomInfo(info.roomId)).live;
            } catch {
              live = true; // 查不到时当作还在播，再试
            }

            if (live) break;

            await sleep(OFFLINE_CHECK_MS);
          }

          if (!live) break;

          await sleep(RESTART_MS);
        }
      } finally {
        clearInterval(progress);
      }

      danmuCount = danmu.stop();
      manifest.endedAt = Date.now();
      manifest.danmuCount = danmuCount;
      // 没录到东西的段（文件很小）去掉
      manifest.parts = manifest.parts.filter((part: GongyanPart): boolean => {
        try {
          return fs.statSync(path.join(dir, part.file)).size > 1024 * 1024;
        } catch {
          return false;
        }
      });
      await writeManifest(dir, manifest);

      const minutes: number = Math.round(manifest.parts.reduce((sum: number, part: GongyanPart): number => sum + ((part.end ?? part.start) - part.start), 0) / 60_000);

      queueTaskEnd(id, manifest.parts.length > 0 ? 'done' : 'error', manifest.parts.length > 0 ? undefined : '没有录到内容',
        `录了 ${ minutes } 分钟（${ manifest.parts.length } 段），弹幕 ${ danmuCount } 条`);

      if (manifest.parts.length > 0) onDone(path.join(dir, MANIFEST));
    } catch (err) {
      danmu?.stop();
      console.error('B 站公演录制失败', err);
      queueTaskEnd(id, 'error', err instanceof Error ? err.message : String(err));
    } finally {
      running.delete(show.liveId);
    }
  })();
}
