import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { getLocalConfigRoot } from '../pocket48Proxy/pocket48Proxy';
import { DEFAULT_GLOSSARY } from './highlightGlossary';

/**
 * 专有词汇存在本机的一个文本文件里，切片时读出来用（写法见 ./highlightGlossary）。
 * 要改就打开文件所在的文件夹，用记事本之类的编辑；不在程序里编辑。
 * 文件位置：有 local/ 文件夹（本机私有配置）时放在 local/专有词汇.txt，否则放在用户的 AppData 里。
 * 文件不存在时（第一次用）写一份默认的。
 * 接入点：./highlightTask（开始切片时读）、./HighlightOption（设置页的「打开所在位置」）。
 */
const FILE_NAME: string = '专有词汇.txt';

export function glossaryFilePath(): string {
  const localRoot: string | undefined = getLocalConfigRoot();

  if (localRoot) return path.join(localRoot, 'local', FILE_NAME);

  return path.join(process.env.APPDATA || os.homedir(), '48tools-custom', FILE_NAME);
}

/* 确保文件存在（不存在就写一份默认的），返回它的位置 */
export function ensureGlossaryFile(): string {
  const file: string = glossaryFilePath();

  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${ DEFAULT_GLOSSARY }\n`, { encoding: 'utf8' });
  }

  return file;
}

/* 读出专有词汇的原文；文件读不了时用默认的 */
export function readGlossaryFile(): string {
  try {
    return fs.readFileSync(ensureGlossaryFile(), { encoding: 'utf8' }).replace(/^﻿/, '');
  } catch (err) {
    console.error('读专有词汇文件失败，用默认的', err);

    return DEFAULT_GLOSSARY;
  }
}
