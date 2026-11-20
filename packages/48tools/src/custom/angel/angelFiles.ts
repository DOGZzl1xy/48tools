import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import type { Cite, PairClue, ClueSource } from './angelModel';

/**
 * 本机文件（都在仓库的 local/angel/ 里，local/ 已经被 git 忽略，不会上传）：
 *   - clues.json：人工（Claude）读完房间消息后写的线索和说明，页面读进来和自动线索合在一起算。改了以后页面一分钟内自动重算
 *   - digest.txt / digest.json：每次更新后导出的整理好的消息、串门、上下线和当前结果，给人读、给 Claude 分析用
 * clues.json 的格式：
 *   {
 *     "updatedAt": "2026-11-20 12:30",
 *     "summary": "总体判断",
 *     "excluded": [{ "name": "某某", "reason": "为什么不参加" }],
 *     "clues": [{ "angel": "甲" 或 ["甲", "乙"], "target": "丙", "weight": 2, "title": "短标题", "reason": "理由", "source": "claude / gemini / both",
 *                 "cites": [{ "room": "丙", "time": "11/18 17:10", "text": "原话" }] }],
 *     "notes": { "丙": "关于丙的说明" }
 *   }
 * weight 是对数倍数：1 ≈ 这一对的可能性乘 2.7，2 ≈ 乘 7.4，-8 以下表示不可能。
 */
export interface ClueFile {
  updatedAt?: string;
  summary?: string;
  excluded?: Array<{ name: string; reason: string }>;
  clues: Array<PairClue>;
  notes: Record<string, string>;
}

interface RawClue {
  angel?: unknown;
  target?: unknown;
  weight?: unknown;
  title?: unknown;
  reason?: unknown;
  cites?: unknown;
  source?: unknown;
}

/* 往上找 local/（和 custom/pocket48Proxy 找 local/pocket48.json 的方式一样） */
function findLocalDir(): string | undefined {
  // 起点先单独算好再进循环（打包时 babel-plugin-delay-require 的限制，见 custom/pocket48Proxy/pocket48Proxy.ts）
  const starts: Array<string> = [process.cwd(), path.dirname(process.execPath)];

  for (const start of starts) {
    let dir: string = start;

    for (let i: number = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'local', 'pocket48.json'))) return path.join(dir, 'local');

      const parent: string = path.dirname(dir);

      if (parent === dir) break;

      dir = parent;
    }
  }

  return undefined;
}

let angelDir: string | undefined | null = null;

export function getAngelDir(): string | undefined {
  if (angelDir === null) {
    const local: string | undefined = findLocalDir();

    angelDir = local ? path.join(local, 'angel') : undefined;
  }

  return angelDir;
}

function names(value: unknown): Array<string> {
  if (typeof value === 'string') return [value];

  if (Array.isArray(value)) return value.filter((item: unknown): item is string => typeof item === 'string');

  return [];
}

function cites(value: unknown): Array<Cite> {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item: unknown): item is Cite => typeof item === 'object' && item !== null && typeof (item as Cite).text === 'string')
    .map((item: Cite): Cite => ({ room: String(item.room ?? ''), time: String(item.time ?? ''), text: item.text }));
}

/* 解析 clues.json 的内容；格式不对的线索跳过 */
export function parseClueFile(text: string): ClueFile {
  const raw: Record<string, unknown> = JSON.parse(text);
  const clues: Array<PairClue> = (Array.isArray(raw.clues) ? raw.clues as Array<RawClue> : [])
    .map((item: RawClue, i: number): PairClue | undefined => {
      const weight: number = Number(item.weight);
      const angels: Array<string> = names(item.angel);
      const targets: Array<string> = names(item.target);

      if (!Number.isFinite(weight) || angels.length === 0 || targets.length === 0) return undefined;

      return {
        id: `claude:${ i }`,
        source: (['gemini', 'both'].includes(String(item.source)) ? item.source : 'claude') as ClueSource,
        angels,
        targets,
        weight,
        title: typeof item.title === 'string' ? item.title : undefined,
        reason: typeof item.reason === 'string' ? item.reason : '',
        cites: cites(item.cites)
      };
    })
    .filter((clue: PairClue | undefined): clue is PairClue => clue !== undefined);
  const excluded: ClueFile['excluded'] = Array.isArray(raw.excluded)
    ? (raw.excluded as Array<{ name?: unknown; reason?: unknown }>)
      .filter((item: { name?: unknown }): boolean => typeof item?.name === 'string')
      .map((item: { name?: unknown; reason?: unknown }): { name: string; reason: string } => ({
        name: String(item.name), reason: String(item.reason ?? '')
      }))
    : undefined;
  const notes: Record<string, string> = {};

  if (raw.notes && typeof raw.notes === 'object') {
    for (const [key, value] of Object.entries(raw.notes as Record<string, unknown>)) {
      if (typeof value === 'string') notes[key] = value;
    }
  }

  return {
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    excluded,
    clues,
    notes
  };
}

export interface ClueFileState {
  file?: ClueFile;
  mtime: number;   // 0：没有这个文件
  error?: string;
}

export function readClueFile(): ClueFileState {
  const dir: string | undefined = getAngelDir();

  if (!dir) return { mtime: 0, error: '找不到 local/ 文件夹' };

  const file: string = path.join(dir, 'clues.json');

  try {
    const mtime: number = fs.statSync(file).mtimeMs;

    try {
      return { file: parseClueFile(fs.readFileSync(file, 'utf8')), mtime };
    } catch (err) {
      return { mtime, error: `clues.json 格式不对：${ err instanceof Error ? err.message : String(err) }` };
    }
  } catch {
    return { mtime: 0 };
  }
}

/* clues.json 和 gemini-review.json 的修改时间（任意一个变了就重算）；没有的算 0 */
export function clueFileMtime(): number {
  const dir: string | undefined = getAngelDir();
  let total: number = 0;

  for (const name of ['clues.json', 'gemini-review.json']) {
    try {
      total += dir ? fs.statSync(path.join(dir, name)).mtimeMs : 0;
    } catch { /* 没有这个文件 */ }
  }

  return total;
}

/**
 * gemini-review.json：Gemini（Antigravity CLI 里的 neon 模型）读完全部消息后的独立判断，由 local/angel/gemini/review.mjs 生成。
 * 页面只显示它的总体判断和最有把握的组合；它认可、补充的线索已经由人工核对后合并进 clues.json。
 */
export interface GeminiPick {
  angel: string;
  target: string;
  confidence: number;
  reason: string;
}

export interface GeminiReview {
  model: string;
  createdAt: number;
  summary: string;
  picks: Array<GeminiPick>;
}

export function readGeminiReview(): GeminiReview | undefined {
  const dir: string | undefined = getAngelDir();

  if (!dir) return undefined;

  try {
    const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(dir, 'gemini-review.json'), 'utf8'));
    const picks: Array<GeminiPick> = (Array.isArray(raw.picks) ? raw.picks as Array<Record<string, unknown>> : [])
      .filter((item: Record<string, unknown>): boolean => typeof item?.angel === 'string' && typeof item.target === 'string')
      .map((item: Record<string, unknown>): GeminiPick => ({
        angel: String(item.angel),
        target: String(item.target),
        confidence: Number(item.confidence) || 0,
        reason: String(item.reason ?? '')
      }));

    return {
      model: String(raw.model ?? 'Gemini'),
      createdAt: Date.parse(String(raw.createdAt)) || 0,
      summary: String(raw.summary ?? ''),
      picks
    };
  } catch {
    return undefined;
  }
}

/* 导出整理好的内容（覆盖上一次的） */
export async function writeDigest(text: string, json: unknown): Promise<void> {
  const dir: string | undefined = getAngelDir();

  if (!dir) return;

  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'digest.txt'), text, 'utf8');
  await fs.promises.writeFile(path.join(dir, 'digest.json'), JSON.stringify(json), 'utf8');
}
