import * as path from 'node:path';

/**
 * 音频下载断点续传的进度记录（文件名.part.json）。worker（custom/download/audioExtract）负责写，
 * 界面（custom/download/audioResume）负责在下次下载同一个录播时找到它。
 */
export const CHECKPOINT_EVERY: number = 40; // 每处理多少个分片记录一次

export interface AudioResumeState {
  version: 1;
  liveId: string;
  filePath: string;  // 最终要保存的文件（.m4a 或 .aac）
  total: number;     // 分片总数
  nextIndex: number; // 下一个要下载的分片
  aacBytes: number;  // 记录时 .part.aac 的大小
  updatedAt: number;
}

/* 进度记录文件的位置 */
export function resumeStatePath(filePath: string): string {
  const parsed: path.ParsedPath = path.parse(filePath);

  return path.join(parsed.dir, `${ parsed.name }.part.json`);
}

/* 下载中的音频文件（保存为 .aac 时就是文件本身） */
export function partAacPath(filePath: string): string {
  const parsed: path.ParsedPath = path.parse(filePath);

  return parsed.ext.toLowerCase() === '.aac' ? filePath : path.join(parsed.dir, `${ parsed.name }.part.aac`);
}

/**
 * 进度记录能不能用：分片总数要和现在的一致，音频文件不能比记录的小
 * @param { AudioResumeState } state
 * @param { number } total - 现在的分片总数
 * @param { number } aacSize - 现在 .part.aac 的大小
 */
export function isResumeStateUsable(state: AudioResumeState | null | undefined, total: number, aacSize: number): boolean {
  return Boolean(state)
    && state!.version === 1
    && state!.total === total
    && Number.isInteger(state!.nextIndex)
    && state!.nextIndex > 0
    && state!.nextIndex < total
    && Number.isInteger(state!.aacBytes)
    && state!.aacBytes >= 0
    && aacSize >= state!.aacBytes;
}
