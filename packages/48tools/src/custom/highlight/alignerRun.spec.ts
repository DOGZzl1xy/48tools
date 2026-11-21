/**
 * 本地打轴插件装没装：插件文件夹在哪、缺了哪些文件。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  alignerDir, missingAlignerFiles, isAlignerInstalled, ALIGNER_MARKER, ALIGNER_EXE, ALIGNER_MODEL_FILE, ALIGNER_TOKENS_FILE
} from './alignerRun';

describe('alignerRun', (): void => {
  const saved: string | undefined = process.env.LOCALAPPDATA;
  let local: string;

  beforeEach((): void => {
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'aligner-'));
    process.env.LOCALAPPDATA = local;
  });

  afterEach((): void => {
    if (saved === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = saved;
    }

    fs.rmSync(local, { recursive: true, force: true });
  });

  test('插件在 LOCALAPPDATA 下面；没有这个环境变量时用它的默认位置，不是用户文件夹本身', (): void => {
    expect(alignerDir()).toBe(path.join(local, '48tools-plugins', 'aligner'));
    delete process.env.LOCALAPPDATA;
    expect(alignerDir()).toBe(path.join(os.homedir(), 'AppData', 'Local', '48tools-plugins', 'aligner'));
  });

  test('四个文件都在才算装好，缺了哪个能说出来', (): void => {
    const files: Array<string> = [ALIGNER_MARKER, ALIGNER_EXE, ALIGNER_MODEL_FILE, ALIGNER_TOKENS_FILE];

    expect(missingAlignerFiles()).toEqual(files);

    for (const file of files.slice(1)) {
      fs.mkdirSync(path.dirname(path.join(alignerDir(), file)), { recursive: true });
      fs.writeFileSync(path.join(alignerDir(), file), '');
    }

    expect(missingAlignerFiles()).toEqual([ALIGNER_MARKER]); // 没装完（没有 installed.json）
    expect(isAlignerInstalled()).toBe(false);

    fs.writeFileSync(path.join(alignerDir(), ALIGNER_MARKER), '{}');
    expect(missingAlignerFiles()).toEqual([]);
    expect(isAlignerInstalled()).toBe(true);
  });
});
