import { describe, test, expect } from '@jest/globals';
import { infer, permanentGradient, bestAssignment, pairWeights, IMPOSSIBLE, type PairClue, type AngelInference } from './angelModel';

/* 直接枚举所有排列算概率，用来对照 */
function bruteForce(matrix: Array<Array<number>>): Array<Array<number>> {
  const n: number = matrix.length;
  const prob: Array<Array<number>> = matrix.map((): Array<number> => new Array(n).fill(0));
  let total: number = 0;

  function walk(row: number, used: Array<boolean>, picked: Array<number>, w: number): void {
    if (row === n) {
      total += w;
      picked.forEach((t: number, a: number): void => {
        prob[a][t] += w;
      });

      return;
    }

    for (let t: number = 0; t < n; t++) {
      if (used[t]) continue;

      used[t] = true;
      picked.push(t);
      walk(row + 1, used, picked, w * matrix[row][t]);
      picked.pop();
      used[t] = false;
    }
  }

  walk(0, new Array(n).fill(false), [], 1);

  return prob.map((row: Array<number>): Array<number> => row.map((v: number): number => v / total));
}

function clue(angel: string, target: string, weight: number): PairClue {
  return { id: `${ angel }-${ target }`, source: 'claude', angels: [angel], targets: [target], weight, reason: '', cites: [] };
}

const names: Array<string> = ['甲', '乙', '丙', '丁', '戊', '己'];

describe('守护天使推理', function(): void {
  test('积和式：3×3 的值和偏导', function(): void {
    const { perm, grad }: { perm: number; grad: Array<Array<number>> } = permanentGradient([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);

    // 1·(5·9+6·8) + 2·(4·9+6·7) + 3·(4·8+5·7) = 93 + 156 + 201
    expect(perm).toBeCloseTo(450);
    expect(grad[0][0]).toBeCloseTo((5 * 9) + (6 * 8));
    expect(grad[2][1]).toBeCloseTo((1 * 6) + (3 * 4));
  });

  test('没有线索时每个人是每个人天使的概率都是 1/n', function(): void {
    const result: AngelInference = infer(names, []);

    for (const row of result.prob) for (const p of row) expect(p).toBeCloseTo(1 / names.length);

    expect(result.feasible).toBe(true);
  });

  test('和枚举所有排列的结果一致', function(): void {
    const clues: Array<PairClue> = [
      clue('甲', '乙', 2), clue('乙', '丙', 1), clue('丙', '甲', -1), clue('丁', '丁', 0.7),
      clue('戊', '甲', 1.5), clue('己', '乙', IMPOSSIBLE), clue('甲', '甲', IMPOSSIBLE)
    ];
    const weight: Array<Array<number>> = pairWeights(names, clues);
    const expected: Array<Array<number>> = bruteForce(weight.map((row: Array<number>): Array<number> =>
      row.map((w: number): number => (Number.isFinite(w) ? Math.exp(w) : 0))));
    const result: AngelInference = infer(names, clues);

    result.prob.forEach((row: Array<number>, a: number): void => {
      row.forEach((p: number, t: number): void => expect(p).toBeCloseTo(expected[a][t], 9));
    });

    expect(result.prob[5][1]).toBe(0);
    // 每一行、每一列加起来都是 1
    for (let i: number = 0; i < names.length; i++) {
      expect(result.prob[i].reduce((s: number, v: number): number => s + v, 0)).toBeCloseTo(1, 9);
      expect(result.prob.reduce((s: number, row: Array<number>): number => s + row[i], 0)).toBeCloseTo(1, 9);
    }
  });

  test('确定的一对会把这一行、这一列的其他人排除掉', function(): void {
    const result: AngelInference = infer(names, [clue('甲', '乙', 8)]);

    expect(result.prob[0][1]).toBeGreaterThan(0.99);
    expect(result.prob[2][1]).toBeLessThan(0.01);
    expect(result.best[0]).toBe(1);
  });

  test('一组候选人共用一条线索', function(): void {
    const group: PairClue = { ...clue('甲', '丙', 1.5), angels: ['甲', '乙'] };
    const result: AngelInference = infer(names, [group]);

    expect(result.prob[0][2]).toBeCloseTo(result.prob[1][2], 9);
    expect(result.prob[0][2]).toBeGreaterThan(result.prob[3][2]);
  });

  test('互相矛盾的线索：标出来，不报错', function(): void {
    const clues: Array<PairClue> = names.slice(1).map((angel: string): PairClue => clue(angel, '甲', IMPOSSIBLE));

    clues.push(clue('甲', '甲', IMPOSSIBLE));

    const result: AngelInference = infer(names, clues);

    expect(result.feasible).toBe(false);
    expect(result.prob[0][0]).toBe(0);
  });

  test('匈牙利算法：选出分数之和最大的一组', function(): void {
    expect(bestAssignment([[1, 9, 1], [9, 1, 1], [1, 1, 9]])).toEqual([1, 0, 2]);
    expect(bestAssignment([[0, -Infinity], [-Infinity, 0]])).toEqual([0, 1]);
  });
});
