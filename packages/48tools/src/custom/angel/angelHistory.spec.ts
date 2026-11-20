import { describe, test, expect } from '@jest/globals';
import { predictAt, pendingSlots, mergeEntries, type HistoryEntry } from './angelHistory';
import { cluesAt, type PairClue } from './angelModel';
import { buildCharts, niceMax } from './angelChart';
import { GAME_START, HISTORY_START, UPDATE_EVERY, historySlots, parseBjTime, bjTime } from './angelConfig';
import type { RoomMessages } from './angelEvidence';
import type { AngelMessage } from './angelText';

/* 名字都是编的 */
const hour: number = 3_600_000;
const names: Array<string> = ['成员甲', '成员乙', '成员丙'];

function clue(angel: string, target: string, weight: number, extra: Partial<PairClue> = {}): PairClue {
  return { id: `${ angel }-${ target }`, source: 'claude', angels: [angel], targets: [target], weight, reason: '', cites: [], ...extra };
}

function say(roomId: number, senderId: number, time: number, own: string): AngelMessage {
  return { key: `${ roomId }-${ time }-${ own }`, roomId, senderId, senderNick: '', time, type: 'TEXT', text: own, own };
}

describe('守护天使：历史概率', function(): void {
  test('北京时间的「11/19 16:40」能来回转换', function(): void {
    const at: number | undefined = parseBjTime('11/19 16:40');

    expect(at).toBeDefined();
    expect(bjTime(at!)).toBe('11/19 16:40');
    expect(parseBjTime('不是时间')).toBeUndefined();
  });

  test('时间点从 11/17 0 点起每 12 小时一个', function(): void {
    expect(HISTORY_START - GAME_START).toBe(24 * hour);
    expect(historySlots(HISTORY_START + (25 * hour))).toEqual([HISTORY_START, HISTORY_START + UPDATE_EVERY, HISTORY_START + (2 * UPDATE_EVERY)]);
  });

  test('还没出现的线索不算，权重用当时的值', function(): void {
    const t0: number = HISTORY_START;
    const late: PairClue = clue('成员甲', '成员乙', 2, { since: t0 + hour });
    const changing: PairClue = clue('成员乙', '成员丙', 0.5, { steps: [{ from: t0 - hour, weight: 1 }, { from: t0 + hour, weight: 0.5 }] });

    expect(cluesAt([late, changing], t0)).toEqual([{ ...changing, weight: 1 }]);
    expect(cluesAt([late, changing], t0 + (2 * hour)).map((c: PairClue): number => c.weight)).toEqual([2, 0.5]);
  });

  test('每个时间点只用那之前的消息', function(): void {
    const t0: number = HISTORY_START + UPDATE_EVERY;
    // 成员甲在游戏期间三次去成员乙的房间：都在 t0 之后，所以 t0 时不该有「串门变多」
    const rooms: Array<RoomMessages> = [
      { name: '成员甲', ownerId: 1, messages: [] },
      { name: '成员乙', ownerId: 2, messages: [1, 2, 3].map((i: number): AngelMessage => say(2, 1, t0 + (i * hour), '在吗')) },
      { name: '成员丙', ownerId: 3, messages: [] }
    ];
    const before: HistoryEntry = predictAt(rooms, names, [], t0, t0 + hour);
    const after: HistoryEntry = predictAt(rooms, names, [], t0 + (5 * hour), t0 + (5 * hour));

    expect(before.prob[0][1]).toBeCloseTo(1 / 3, 6);
    expect(after.prob[0][1]).toBeGreaterThan(1 / 3);
    expect(before.kind).toBe('live');
    expect(predictAt(rooms, names, [], t0, t0 + (13 * hour)).kind).toBe('backtest');
  });

  test('最新的时间点要等这一轮分析写完，或者过了 3 小时', function(): void {
    const latest: number = HISTORY_START + UPDATE_EVERY;
    const now: number = latest + hour;

    expect(pendingSlots([], now, latest - hour)).toEqual([HISTORY_START]);
    expect(pendingSlots([], now, latest + (10 * 60_000))).toEqual([HISTORY_START, latest]);
    expect(pendingSlots([], latest + (4 * hour), 0)).toEqual([HISTORY_START, latest]);
  });

  test('已经记下的点不会被新算的覆盖', function(): void {
    const old: HistoryEntry = { at: 1, label: 'a', kind: 'live', computedAt: 1, names, prob: [[1]], best: [0] };
    const fresh: HistoryEntry = { ...old, computedAt: 2, prob: [[0]] };
    const other: HistoryEntry = { ...old, at: 0 };

    expect(mergeEntries([old], [fresh, other])).toEqual([other, old]);
  });

  test('曲线：最可能的 4 组上色，图里没有 NaN', function(): void {
    const at: Array<number> = [HISTORY_START, HISTORY_START + UPDATE_EVERY];
    const prob: Array<Array<number>> = [[0.1, 0.6, 0.3], [0.3, 0.1, 0.6], [0.6, 0.3, 0.1]];
    const history: Array<{ at: number; names: Array<string>; prob: Array<Array<number>> }> = at.map((t: number): { at: number; names: Array<string>; prob: Array<Array<number>> } => ({ at: t, names, prob }));
    const charts: ReturnType<typeof buildCharts> = buildCharts(history, { at: at[1] + hour, names, prob }, HISTORY_START, HISTORY_START + (6 * 24 * hour), bjTime);

    expect(charts.legend).toHaveLength(4);
    expect(charts.legend[0].label).toBe('成员甲 → 成员乙');
    expect(charts.small).toHaveLength(3);
    expect(charts.trend).not.toContain('NaN');
    expect(charts.small.every((item: { svg: string }): boolean => !item.svg.includes('NaN'))).toBe(true);
    expect(niceMax([0.12])).toBe(0.3);
    expect(niceMax([0.33])).toBe(0.4);
  });
});
