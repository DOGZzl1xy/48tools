import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { getLocalConfigRoot } from '../pocket48Proxy/pocket48Proxy';
import type { ShowInfo } from '../highlight/highlightShow';
import { hasDecisions, recordFileName, toRecord, type ShowRecord } from './learnRecord';

/**
 * 持续学习存在本机的东西（有 local/ 时在 local/learn/，否则在 AppData 的 48tools-custom/learn/）：
 *   shows/          每一场切片一份记录（见 ./learnRecord），每次保存切片清单时跟着更新
 *   背景.md         现在用的背景文档：每次找爆点、写字幕和标题时附在提示后面；可以自己改，下次学习会在它的基础上更新
 *   history/        每次学习前的背景文档（想退回去就拷回来）
 *   提示词建议.md   学习时顺带给出的、关于提示词本身的建议（不会自动用上）
 *   state.json      上次什么时候学的、学到了什么
 * 单元测试和测试窗口里不读不写（免得测试用的数据混进来），除非测试自己指定了文件夹。
 */
export interface LearnState {
  learnedAt: number;    // 上次学习的时间（没学过是 0）
  summary?: string;     // 上次学到了什么
  shows?: number;       // 上次用了几场的记录
  error?: string;       // 上次没学成的原因
}

const BACKGROUND_FILE: string = '背景.md';
const ADVICE_FILE: string = '提示词建议.md';
let dirForTest: string | undefined;

export function setLearnDirForTest(dir: string | undefined): void {
  dirForTest = dir;
}

/* 存在哪个文件夹；不该读写的时候（单元测试、测试窗口）是 undefined */
export function learnDir(): string | undefined {
  if (dirForTest) return dirForTest;

  if (process.env.JEST_WORKER_ID !== undefined || process.env.TEST === 'true') return undefined;

  const root: string | undefined = getLocalConfigRoot();

  return root ? path.join(root, 'local', 'learn') : path.join(process.env.APPDATA || os.homedir(), '48tools-custom', 'learn');
}

/* 设置页「打开文件夹」用：没有就先建出来 */
export function ensureLearnDir(): string | undefined {
  const dir: string | undefined = learnDir();

  if (dir) fs.mkdirSync(dir, { recursive: true });

  return dir;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fsP.mkdir(path.dirname(file), { recursive: true });
  await fsP.writeFile(`${ file }.part`, text, 'utf8');
  await fsP.rename(`${ file }.part`, file);
}

/* 保存切片清单时调：把这一场的记录存下来（人还没做过决定的不存） */
export async function saveShowRecord(info: ShowInfo, now: number = Date.now()): Promise<void> {
  const dir: string | undefined = learnDir();

  if (!dir) return;

  const record: ShowRecord = toRecord(info, now);

  if (!hasDecisions(record)) return;

  await writeAtomic(path.join(dir, 'shows', recordFileName(record)), JSON.stringify(record, null, 1));
}

export async function readRecords(): Promise<Array<ShowRecord>> {
  const dir: string | undefined = learnDir();

  if (!dir) return [];

  const folder: string = path.join(dir, 'shows');
  const names: Array<string> = await fsP.readdir(folder).catch((): Array<string> => []);
  const records: Array<ShowRecord | undefined> = await Promise.all(names.filter((name: string): boolean => name.endsWith('.json'))
    .map((name: string): Promise<ShowRecord | undefined> => fsP.readFile(path.join(folder, name), 'utf8')
      .then((text: string): ShowRecord => JSON.parse(text) as ShowRecord, (): undefined => undefined)));

  return records.filter((record: ShowRecord | undefined): record is ShowRecord => record?.version === 1 && Array.isArray(record.items));
}

/* 现在的背景文档（没有是空字符串）。开始切片时读一次，所以用同步的 */
export function readBackground(): string {
  const dir: string | undefined = learnDir();

  if (!dir) return '';

  try {
    return fs.readFileSync(path.join(dir, BACKGROUND_FILE), 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return '';
  }
}

/* 换上新的背景文档，旧的留一份在 history/ */
export async function writeBackground(text: string, now: number = Date.now()): Promise<void> {
  const dir: string | undefined = learnDir();

  if (!dir) return;

  const old: string = readBackground();

  if (old !== '') await writeAtomic(path.join(dir, 'history', `${ new Date(now).toISOString().replace(/[:.]/g, '-') }.md`), `${ old }\n`);

  await writeAtomic(path.join(dir, BACKGROUND_FILE), `${ text.trim() }\n`);
}

export async function appendAdvice(advice: Array<string>, now: number = Date.now()): Promise<void> {
  const dir: string | undefined = learnDir();

  if (!dir || advice.length === 0) return;

  await fsP.mkdir(dir, { recursive: true });
  await fsP.appendFile(path.join(dir, ADVICE_FILE),
    `\n## ${ new Date(now + (8 * 3_600_000)).toISOString().slice(0, 16).replace('T', ' ') }\n\n${ advice.map((line: string): string => `- ${ line }`).join('\n') }\n`, 'utf8');
}

export async function readState(): Promise<LearnState> {
  const dir: string | undefined = learnDir();

  if (!dir) return { learnedAt: 0 };

  try {
    const state: LearnState = JSON.parse(await fsP.readFile(path.join(dir, 'state.json'), 'utf8')) as LearnState;

    return { ...state, learnedAt: Number(state?.learnedAt) || 0 };
  } catch {
    return { learnedAt: 0 };
  }
}

export async function writeState(state: LearnState): Promise<void> {
  const dir: string | undefined = learnDir();

  if (dir) await writeAtomic(path.join(dir, 'state.json'), JSON.stringify(state, null, 1));
}
