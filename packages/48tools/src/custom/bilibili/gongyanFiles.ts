import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFileName } from '../highlight/highlightTime';
import { teamOfShow } from './gongyanSchedule';
import type { GongyanManifest, GongyanShow } from './gongyanRecorder';

/**
 * 公演录像文件夹：叫什么、找这场（liveId）的文件夹。只读写文件，不联网（方便测试）。
 * 程序重启后要接着录同一场：按 manifest.json 里的 liveId 找原来的文件夹（和文件夹叫什么无关）。
 * 接入点：./gongyanRecorder、./gongyanWatcher、./gongyanSource。
 */
export const MANIFEST: string = 'manifest.json';

/* 文件夹名：「2026-11-22 NII 《新芽之契》…」；标题里已经有队名（「TEAM NII《…》」）时不再重复 */
export function recordingFolderName(show: Pick<GongyanShow, 'day' | 'team' | 'title'>): string {
  const hasTeam: boolean = teamOfShow({ title: show.title, subTitle: '' }) === show.team;

  return safeFileName(hasTeam ? `${ show.day } ${ show.title }` : `${ show.day } ${ show.team } ${ show.title }`, 80);
}

export function readManifest(dir: string): GongyanManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return undefined;
  }
}

/* baseDir 下面所有的录像文件夹 */
function allRecordings(baseDir: string): Array<{ dir: string; manifest: GongyanManifest }> {
  let names: Array<string> = [];

  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return [];
  }

  const out: Array<{ dir: string; manifest: GongyanManifest }> = [];

  for (const name of names) {
    const dir: string = path.join(baseDir, name);
    const manifest: GongyanManifest | undefined = readManifest(dir);

    if (manifest?.show?.liveId) out.push({ dir, manifest });
  }

  return out;
}

/* baseDir 下面这场（liveId）的录像文件夹；没有返回 undefined */
export function findRecordingDir(baseDir: string, liveId: string): { dir: string; manifest: GongyanManifest } | undefined {
  return allRecordings(baseDir).find((item: { manifest: GongyanManifest }): boolean => item.manifest.show.liveId === liveId);
}

/* 录到一半没写结束时间的（程序中途关了、重启了） */
export function unfinishedRecordings(baseDir: string): Array<{ dir: string; manifest: GongyanManifest }> {
  return allRecordings(baseDir).filter((item: { manifest: GongyanManifest }): boolean => !item.manifest.endedAt);
}
