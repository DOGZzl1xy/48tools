/**
 * 公演录像文件夹：叫什么、程序重启后按 liveId 找回录到一半的那场。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordingFolderName, findRecordingDir, unfinishedRecordings, MANIFEST } from './gongyanFiles';

describe('公演录像文件夹', (): void => {
  test('文件夹名：标题里已经有队名就不重复', (): void => {
    expect(recordingFolderName({ day: '2026-11-22', team: 'NII', title: 'TEAM NII《示例》十三周年特别公演' })).toBe('2026-11-22 TEAM NII《示例》十三周年特别公演');
    expect(recordingFolderName({ day: '2026-11-22', team: 'X', title: '《Fire X》2.0公演' })).toBe('2026-11-22 X 《Fire X》2.0公演');
  });

  test('按 liveId 找文件夹（和文件夹叫什么无关）；没写结束时间的是录到一半的', (): void => {
    const base: string = fs.mkdtempSync(path.join(os.tmpdir(), 'gongyan-files-'));

    try {
      const write: (name: string, liveId: string, endedAt?: number) => void = (name: string, liveId: string, endedAt?: number): void => {
        fs.mkdirSync(path.join(base, name));
        fs.writeFileSync(path.join(base, name, MANIFEST), JSON.stringify({ show: { liveId }, parts: [], ...(endedAt ? { endedAt } : {}) }));
      };

      write('旧的名字', 'a');
      write('另一场', 'b', 123);
      fs.mkdirSync(path.join(base, '没有说明文件'));

      expect(findRecordingDir(base, 'a')?.dir).toBe(path.join(base, '旧的名字'));
      expect(findRecordingDir(base, 'c')).toBeUndefined();
      expect(unfinishedRecordings(base).map((item: { dir: string }): string => path.basename(item.dir))).toEqual(['旧的名字']);
      expect(findRecordingDir(path.join(base, '不存在'), 'a')).toBeUndefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
