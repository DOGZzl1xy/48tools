import { historySlots, nextUpdateAt, bjTime } from './angelConfig';
import { buildEvidence, type Evidence, type RoomMessages } from './angelEvidence';
import { infer, cluesAt, type AngelInference, type PairClue } from './angelModel';
import type { AngelMessage } from './angelText';

/**
 * 历史概率：每个推断时间一个点（北京时间 11/17 0 点起，见 ./angelConfig 的 UPDATE_TIMES），每个点都只用那之前的信息重新算一遍：
 *   - 房间消息只用那个时间点之前的（自动线索按这些重新找）
 *   - 人工线索（clues.json）只用那时已经出现的（since 之前的不算），权重用当时的值（steps）
 * 算好的点存进 local/angel/history.json（见 ./angelFiles），以后不再改，用来画概率变化曲线（见 ./angelChart）。
 * 补以前的点叫「回溯」（backtest）；在下一个推断时间之前记下的叫「实时」（live）。
 * 最新的那个时间点要等这一轮人工分析写完（clues.json 比这个点新），或者已经过了 3 小时，才记下来。
 */
export interface HistoryEntry {
  at: number;
  label: string;           // 北京时间「11/17 00:00」
  kind: 'backtest' | 'live';
  computedAt: number;
  names: Array<string>;
  prob: Array<Array<number>>;
  best: Array<number>;
}

const WAIT_FOR_ANALYSIS: number = 3 * 3_600_000;
const LIVE_WINDOW: number = 6 * 3_600_000; // 最后一个推断时间之后没有下一个，6 小时内记下的算实时

/* 只用 at 之前的信息算一遍 */
export function predictAt(
  rooms: Array<RoomMessages>,
  participants: Array<string>,
  manual: Array<PairClue>,
  at: number,
  computedAt: number = Date.now()
): HistoryEntry {
  const truncated: Array<RoomMessages> = rooms.map((room: RoomMessages): RoomMessages => ({
    ...room,
    messages: room.messages.filter((message: AngelMessage): boolean => message.time < at)
  }));
  const evidence: Evidence = buildEvidence(truncated, participants, at);
  const inference: AngelInference = infer(participants, [...evidence.clues, ...cluesAt(manual, at)]);

  return {
    at,
    label: bjTime(at),
    kind: computedAt >= (nextUpdateAt(at) ?? (at + LIVE_WINDOW)) ? 'backtest' : 'live',
    computedAt,
    names: participants,
    prob: inference.prob,
    best: inference.best
  };
}

/* 现在应该补上哪些时间点 */
export function pendingSlots(entries: Array<HistoryEntry>, now: number, cluesChangedAt: number): Array<number> {
  const slots: Array<number> = historySlots(now);
  const latest: number | undefined = slots[slots.length - 1];
  const have: Set<number> = new Set(entries.map((entry: HistoryEntry): number => entry.at));

  return slots.filter((at: number): boolean => !have.has(at)
    && (at !== latest || cluesChangedAt >= at || now - at >= WAIT_FOR_ANALYSIS));
}

/* 把新算的点合进去，按时间排好（同一个时间点以已有的为准） */
export function mergeEntries(entries: Array<HistoryEntry>, added: Array<HistoryEntry>): Array<HistoryEntry> {
  const byAt: Map<number, HistoryEntry> = new Map();

  for (const entry of [...added, ...entries]) byAt.set(entry.at, entry);

  return [...byAt.values()].sort((a: HistoryEntry, b: HistoryEntry): number => a.at - b.at);
}
