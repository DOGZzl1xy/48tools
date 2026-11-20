import type { CustomMessageV2 } from '@48tools-api/48';
import { getPocket48Token } from '../../utils/snh48';
import { readJson, writeJson } from '../common/util';
import { getAllTranscripts } from '../transcribe/transcriptCache';
import {
  ANGEL_MEMBERS, DEFAULT_EXCLUDED, GAME_START, BASELINE_START, LAST_UPDATE, nextUpdateAt, lastUpdateAt, bjTime, type AngelMember
} from './angelConfig';
import { toAngelMessage, type AngelMessage } from './angelText';
import { buildEvidence, type Evidence, type RoomMessages, type Moment, type VisitStat, type DayActivity } from './angelEvidence';
import { infer, cluesAt, mergeClues, type AngelInference, type PairClue } from './angelModel';
import { predictAt, pendingSlots, mergeEntries, type HistoryEntry } from './angelHistory';
import {
  readClueFile, readGeminiReview, readHistory, writeHistory, cluesWrittenAt, clueFileMtime, writeDigest, getAngelDir,
  type ClueFileState, type GeminiReview
} from './angelFiles';
import { syncMember, readMemberMessages } from './angelSync';

/**
 * 守护天使推理的数据：什么时候去取新消息、怎么算、算完导出。网页 angel.48tools.app 由 local/angel/site/publish.mjs 用导出的结果生成，
 * 程序里的「守护天使」页面只负责用自带的浏览器窗口打开这个网页（./AngelPage）。
 *   - 程序开着就在后台按时更新：每个推断时间一次（见 ./angelConfig 的 UPDATE_TIMES，最后一次 11/22 13:00；错过了就在程序启动后补一次）
 *   - 更新 = 把每个人房间的新消息取进本地缓存（./angelSync）→ 自动找线索（./angelEvidence）
 *     → 和 local/angel/clues.json 里人工写的线索合在一起算概率（./angelModel）→ 导出 digest 给人看（./angelFiles）
 *     → 补上还没记的历史概率时间点（./angelHistory，local/angel/history.json）
 *   - clues.json 改了以后不用重新取消息，一分钟内自动重算
 * 接入点：custom/shell/AppShell.tsx 启动时调用 startAngelWatcher。
 */
export interface AngelSnapshot {
  builtAt: number;
  participants: Array<string>;
  excluded: Array<{ name: string; reason: string }>;
  evidence: Evidence;
  clues: Array<PairClue>;  // 自动的 + 人工的
  inference: AngelInference;
  clueFile: ClueFileState;
  gemini?: GeminiReview;          // Gemini 的独立判断（local/angel/gemini-review.json）
  history: Array<HistoryEntry>;   // 每个推断时间一个点的历史概率（local/angel/history.json，见 ./angelHistory）
  counts: Record<string, number>; // 每个房间游戏期间成员消息的条数
}

export interface AngelState {
  syncing: boolean;
  progress?: { done: number; total: number; name: string };
  lastSync: number;   // 上次从网络取消息的时间
  syncError?: string;
  snapshot?: AngelSnapshot;
  nextAt?: number;   // 下一次推断的时间；最后一次过了以后没有
}

const LAST_SYNC_KEY: string = 'ANGEL_LAST_SYNC';
const FIRST_DELAY: number = 15_000;
const CLUE_POLL: number = 60_000;
const MISSED_GRACE: number = 6 * 3_600_000; // 最后一次推断时程序没开：6 小时内打开还会补取一次
let state: AngelState = {
  syncing: false,
  lastSync: typeof localStorage === 'undefined' ? 0 : Number(readJson<number>(LAST_SYNC_KEY, 0)) || 0,
  nextAt: nextUpdateAt(Date.now())
};
let computing: Promise<void> | undefined;

function setState(patch: Partial<AngelState>): void {
  state = { ...state, ...patch };
}

export function getAngelState(): AngelState {
  return state;
}

/* ---------- 导出给人读的整理 ---------- */
function pct(p: number): string {
  return `${ Math.round(p * 100) }%`;
}

function digestText(snapshot: AngelSnapshot, rooms: Array<RoomMessages>, memberName: Map<number, string>): string {
  const { inference, evidence, participants }: AngelSnapshot = snapshot;
  const lines: Array<string> = [];

  lines.push(`# 守护天使：整理时间 ${ bjTime(snapshot.builtAt) }（北京时间）`);
  lines.push(`参加（${ participants.length }）：${ participants.join('、') }`);
  lines.push(`不参加：${ snapshot.excluded.map((item: { name: string; reason: string }): string => `${ item.name }（${ item.reason }）`).join('；') }`);
  lines.push('', '## 当前结果：每个人最可能的天使');

  inference.names.forEach((target: string, t: number): void => {
    const ranked: Array<string> = inference.names
      .map((angel: string, a: number): [string, number] => [angel, inference.prob[a][t]])
      .sort((x: [string, number], y: [string, number]): number => y[1] - x[1])
      .slice(0, 3)
      .map(([angel, p]: [string, number]): string => `${ angel } ${ pct(p) }`);

    lines.push(`- ${ target } ← ${ ranked.join('，') }`);
  });

  lines.push('', '## 自动线索');

  for (const clue of snapshot.clues.filter((item: PairClue): boolean => item.source === 'rule')) {
    lines.push(`- [${ clue.title }] ${ clue.angels.join('/') } → ${ clue.targets.join('/') } (${ clue.weight.toFixed(2) })：${ clue.reason }`);
  }

  lines.push('', '## 串门（游戏期间 / 游戏前一周）');

  for (const visit of [...evidence.visits].sort((x: VisitStat, y: VisitStat): number => y.game - x.game)) {
    if (visit.game + visit.baseline > 0) lines.push(`- ${ visit.visitor } → ${ visit.host }：${ visit.game } / ${ visit.baseline }`);
  }

  lines.push('', '## 每天第一条 ~ 最后一条（北京时间）');

  for (const name of participants) {
    const days: string = (evidence.activity[name] ?? [])
      .map((day: DayActivity): string => `${ day.day } ${ bjTime(day.first).split(' ')[1] }~${ bjTime(day.last).split(' ')[1] }(${ day.count })`)
      .join('  ');

    lines.push(`- ${ name }：${ days || '没有发言' }`);
  }

  lines.push('', '## 关键发言（天使 / 守护 / 小主人）');

  for (const moment of evidence.moments) {
    lines.push(`- ${ bjTime(moment.message.time) } [${ moment.kind }] ${ moment.speaker }${ moment.room === moment.speaker ? '' : ` @${ moment.room }的房间` }：${ moment.message.text }`);
  }

  lines.push('', '## 游戏期间所有成员消息（按房间；[某某] 是来串门的成员）');

  for (const room of rooms) {
    lines.push('', `### ${ room.name }${ participants.includes(room.name) ? '' : '（不参加）' }`);

    for (const message of room.messages) {
      if (message.time < GAME_START || ['GIFTREPLY', 'AUDIO_GIFT_REPLY', 'EXPRESSIMAGE'].includes(message.type)) continue;

      const who: string = message.senderId === room.ownerId ? '' : `[${ memberName.get(message.senderId) ?? message.senderNick }] `;

      lines.push(`${ bjTime(message.time) } ${ who }${ message.text }`);
    }
  }

  return lines.join('\n');
}

/* ---------- 计算 ---------- */
async function compute(): Promise<void> {
  const transcripts: Map<string, string> = await getAllTranscripts().catch((): Map<string, string> => new Map());
  const memberName: Map<number, string> = new Map(ANGEL_MEMBERS.map((member: AngelMember): [number, string] => [member.ownerId, member.name]));
  const rooms: Array<RoomMessages> = [];

  for (const member of ANGEL_MEMBERS) {
    const raws: Array<CustomMessageV2> = await readMemberMessages(member, BASELINE_START);

    rooms.push({
      name: member.name,
      ownerId: member.ownerId,
      messages: raws.map((raw: CustomMessageV2): AngelMessage => toAngelMessage(raw, member.ownerId, transcripts))
    });
  }

  const clueFile: ClueFileState = readClueFile();
  const excluded: Array<{ name: string; reason: string }> = clueFile.file?.excluded ?? DEFAULT_EXCLUDED;
  const excludedNames: Set<string> = new Set(excluded.map((item: { name: string }): string => item.name));
  const participants: Array<string> = ANGEL_MEMBERS.map((member: AngelMember): string => member.name)
    .filter((name: string): boolean => !excludedNames.has(name));
  const now: number = Date.now();
  const evidence: Evidence = buildEvidence(rooms, participants, now);
  const manual: Array<PairClue> = clueFile.file?.clues ?? [];
  const clues: Array<PairClue> = mergeClues(evidence.clues, cluesAt(manual, now));
  const inference: AngelInference = infer(participants, clues);
  const counts: Record<string, number> = {};

  for (const room of rooms) {
    counts[room.name] = room.messages.filter((m: AngelMessage): boolean => m.time >= GAME_START && m.senderId === room.ownerId).length;
  }

  // 历史概率：补上还没记的时间点（每个点只用那之前的信息），记下以后不再改
  let history: Array<HistoryEntry> = readHistory();
  const pending: Array<number> = pendingSlots(history, now, cluesWrittenAt());

  if (pending.length) {
    history = mergeEntries(history, pending.map((at: number): HistoryEntry => predictAt(rooms, participants, manual, at, now)));
    await writeHistory(history).catch((err: unknown): void => console.error('守护天使：历史概率保存失败', err));
  }

  const snapshot: AngelSnapshot = {
    builtAt: now, participants, excluded, evidence, clues, inference, clueFile, gemini: readGeminiReview(), history, counts
  };

  setState({ snapshot });

  try {
    await writeDigest(digestText(snapshot, rooms, memberName), {
      builtAt: now,
      participants,
      excluded,
      prob: inference.prob,
      best: inference.best,
      clues,
      visits: evidence.visits.map((v: VisitStat): object => ({ visitor: v.visitor, host: v.host, game: v.game, baseline: v.baseline })),
      activity: evidence.activity,
      moments: evidence.moments.map((m: Moment): object => ({ kind: m.kind, speaker: m.speaker, room: m.room, time: bjTime(m.message.time), text: m.message.text })),
      rooms: rooms.map((room: RoomMessages): object => ({
        name: room.name,
        messages: room.messages.filter((m: AngelMessage): boolean => m.time >= GAME_START).map((m: AngelMessage): object => ({
          time: bjTime(m.time), sender: memberName.get(m.senderId) ?? m.senderNick, type: m.type, text: m.text
        }))
      }))
    });
  } catch (err) {
    console.error('守护天使：导出失败', err);
  }
}

/* 只用本地已有的消息重新算（clues.json 改了、第一次打开页面时） */
export function recompute(): Promise<void> {
  computing ??= compute().catch((err: unknown): void => {
    console.error('守护天使：计算失败', err);
  }).finally((): void => {
    computing = undefined;
  });

  return computing;
}

/* 取新消息并重新算 */
export async function refresh(): Promise<void> {
  if (state.syncing) return;

  if (!getPocket48Token()) {
    setState({ syncError: '请先登录口袋48账号' });

    return;
  }

  setState({ syncing: true, syncError: undefined, progress: { done: 0, total: ANGEL_MEMBERS.length, name: '' } });

  const errors: Array<string> = [];

  for (const [i, member] of ANGEL_MEMBERS.entries()) {
    setState({ progress: { done: i, total: ANGEL_MEMBERS.length, name: member.name } });

    try {
      await syncMember(member);
    } catch (err) {
      console.error('守护天使：同步失败', member.name, err);
      errors.push(`${ member.name }：${ err instanceof Error ? err.message : String(err) }`);
    }
  }

  const now: number = Date.now();

  writeJson(LAST_SYNC_KEY, now);
  setState({
    syncing: false,
    progress: undefined,
    lastSync: now,
    nextAt: nextUpdateAt(now),
    syncError: errors.length ? `有 ${ errors.length } 个房间没取到：${ errors.slice(0, 3).join('；') }` : undefined
  });
  await recompute();
}

/* ---------- 后台定时 ---------- */
let started: boolean = false;
let lastClueMtime: number = 0;

function due(now: number): boolean {
  // 上次取消息早于最近一个推断时间，而且离最后一次推断不太久
  const last: number | undefined = lastUpdateAt(now);

  return last !== undefined && now < LAST_UPDATE + MISSED_GRACE && state.lastSync < last;
}

function schedule(): void {
  const now: number = Date.now();
  const at: number | undefined = nextUpdateAt(now);

  setState({ nextAt: at });

  if (at === undefined) return; // 最后一次推断已经过了

  window.setTimeout(async (): Promise<void> => {
    if (due(Date.now())) await refresh();

    schedule();
  }, Math.max(1_000, at - now + 5_000));
}

export function startAngelWatcher(): void {
  if (started || !getAngelDir()) return;

  started = true;
  lastClueMtime = clueFileMtime();

  window.setTimeout(async (): Promise<void> => {
    if (due(Date.now())) await refresh();
    else await recompute();

    schedule();
  }, FIRST_DELAY);

  window.setInterval((): void => {
    const mtime: number = clueFileMtime();

    if (mtime !== lastClueMtime) {
      lastClueMtime = mtime;
      recompute();
    }
  }, CLUE_POLL);
}
