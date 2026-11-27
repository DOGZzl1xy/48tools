/**
 * 专有词汇文件：放在哪、第一次用时写一份默认的、读出来。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { glossaryFilePath, ensureGlossaryFile, readGlossaryFile } from './glossaryFile';
import { defaultGlossary } from './highlightGlossary';

let localRoot: string | undefined;

jest.mock('../pocket48Proxy/pocket48Proxy', (): object => ({ getLocalConfigRoot: (): string | undefined => localRoot }));

describe('glossaryFile', (): void => {
  let dir: string;
  let appData: string | undefined;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-'));
    appData = process.env.APPDATA;
    process.env.APPDATA = dir;
    localRoot = undefined;
  });

  afterEach((): void => {
    process.env.APPDATA = appData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('有 local/ 时放在 local/ 里，没有时放在 AppData 里', (): void => {
    expect(glossaryFilePath()).toBe(path.join(dir, '48tools-custom', '专有词汇.txt'));

    localRoot = path.join(dir, 'repo');
    expect(glossaryFilePath()).toBe(path.join(dir, 'repo', 'local', '专有词汇.txt'));
  });

  test('第一次用时写一份默认的；之后读的是文件里改过的内容', (): void => {
    const file: string = ensureGlossaryFile();

    expect(fs.readFileSync(file, 'utf8')).toBe(`${ defaultGlossary() }\n`);
    expect(readGlossaryFile()).toBe(`${ defaultGlossary() }\n`);

    fs.writeFileSync(file, '﻿闫娜：娜姐\n', 'utf8'); // 记事本保存时可能带 BOM
    expect(readGlossaryFile()).toBe('闫娜：娜姐\n');
    expect(ensureGlossaryFile()).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('﻿闫娜：娜姐\n'); // 已经有了就不覆盖
  });
});
