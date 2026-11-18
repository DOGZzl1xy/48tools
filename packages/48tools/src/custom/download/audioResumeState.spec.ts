import * as path from 'node:path';
import { isResumeStateUsable, resumeStatePath, partAacPath, type AudioResumeState } from './audioResumeState';

const state: AudioResumeState = {
  version: 1,
  liveId: '1',
  filePath: 'D:/download/a.m4a',
  total: 100,
  nextIndex: 40,
  aacBytes: 5000,
  updatedAt: 0
};

describe('audio resume state', function(): void {
  test('usable only when segment count matches and the audio file is not shorter', function(): void {
    expect(isResumeStateUsable(state, 100, 5000)).toBe(true);
    expect(isResumeStateUsable(state, 100, 9000)).toBe(true);  // 多出来的部分会被截掉
    expect(isResumeStateUsable(state, 100, 4999)).toBe(false); // 音频文件比记录的小
    expect(isResumeStateUsable(state, 101, 5000)).toBe(false); // 分片数变了
    expect(isResumeStateUsable({ ...state, nextIndex: 0 }, 100, 5000)).toBe(false);
    expect(isResumeStateUsable({ ...state, nextIndex: 100 }, 100, 5000)).toBe(false);
    expect(isResumeStateUsable(undefined, 100, 5000)).toBe(false);
  });

  test('file names', function(): void {
    expect(resumeStatePath('D:/download/a.m4a').split(path.sep).join('/')).toBe('D:/download/a.part.json');
    expect(partAacPath('D:/download/a.m4a').split(path.sep).join('/')).toBe('D:/download/a.part.aac');
    expect(partAacPath('D:/download/a.aac')).toBe('D:/download/a.aac');
  });
});
