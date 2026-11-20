/**
 * 守护天使的推理模型（纯计算，不碰界面和网络）。
 *
 * 抽签是「每人抽一个，不放回，可能抽到自己」，所以结果是参加者的一个排列：每个人恰好是一个人的天使，
 * 也恰好有一个天使。每条线索给一组（天使 → 小主人）乘上一个倍数 e^weight（weight 是对数，正的是支持，负的是反对，
 * 小于等于 IMPOSSIBLE 的表示不可能）。没有线索时每种排列一样可能。
 * 某人是某人天使的概率 = 所有包含这一对的排列的权重之和 / 所有排列的权重之和，也就是矩阵积和式（permanent）的偏导：
 *   P(a → t) = A[a][t] · ∂perm(A)/∂A[a][t] / perm(A)
 * 用 Ryser 公式（格雷码遍历列的子集）一次算出所有偏导，20 人以内几十毫秒。
 * 算之前先用 Sinkhorn 把矩阵缩放成每行每列和为 1（行、列各乘一个数不改变上面的概率），避免 Ryser 公式正负相消丢精度。
 */
export interface Cite {
  room: string;  // 哪个成员的房间
  time: string;  // 北京时间「11/16 15:51」
  text: string;
}

/* 线索从哪来：Claude 读消息写的、Gemini 审查时补充的、两边都认可的、规则自动找的 */
export type ClueSource = 'claude' | 'gemini' | 'both' | 'rule';

export const SOURCE_LABEL: Record<ClueSource, string> = { claude: 'Claude', gemini: 'Gemini', both: 'Claude + Gemini', rule: '自动' };

export interface PairClue {
  id: string;
  source: ClueSource;
  angels: Array<string>;  // 可能的天使（名字），写多个表示「这几个人里的一个」，每个人都乘同样的倍数
  targets: Array<string>; // 小主人
  weight: number;
  title?: string;
  reason: string;
  cites: Array<Cite>;
  since?: number;                                  // 从这个时间起才知道这条线索（回溯历史概率时用）；没有表示一直都算
  steps?: Array<{ from: number; weight: number }>; // 后来有了新证据，权重跟着变：from 之后用这个 weight（按时间排好）
}

/**
 * 某个时间点能用的线索：还没出现的去掉，权重换成当时的值。
 * 回溯历史概率时用：每个时间点只用那之前已经有的证据（见 ./angelHistory）。
 */
export function cluesAt(clues: Array<PairClue>, at: number): Array<PairClue> {
  const result: Array<PairClue> = [];

  for (const clue of clues) {
    if (clue.since !== undefined && clue.since > at) continue;

    const step: { from: number; weight: number } | undefined = clue.steps?.filter((item: { from: number }): boolean => item.from <= at).pop();

    result.push(step ? { ...clue, weight: step.weight } : clue);
  }

  return result;
}

/**
 * 自动线索和人工线索合在一起。人工线索已经几乎确定排除的组合（权重 ≤ OVERRIDE_AT），同一组合的自动线索不再计入：
 * 比如人工已经核实「李继醇不是自己的天使」，自动找到的「李继醇自称抽到自己」就不能再当支持。
 */
export const OVERRIDE_AT: number = -3;

export function mergeClues(rule: Array<PairClue>, manual: Array<PairClue>): Array<PairClue> {
  const excluded: Array<PairClue> = manual.filter((clue: PairClue): boolean => clue.weight <= OVERRIDE_AT);
  const covered: (clue: PairClue) => boolean = (clue: PairClue): boolean => excluded.some((m: PairClue): boolean =>
    clue.angels.every((a: string): boolean => m.angels.includes(a)) && clue.targets.every((t: string): boolean => m.targets.includes(t)));

  return [...rule.filter((clue: PairClue): boolean => !covered(clue)), ...manual];
}

export interface AngelInference {
  names: Array<string>;
  prob: Array<Array<number>>;  // prob[a][t]：names[a] 是 names[t] 的天使的概率
  weight: Array<Array<number>>; // 每一对的线索权重之和（对数）
  best: Array<number>;         // 整体最可能的一组：best[a] = a 抽到的人
  feasible: boolean;           // 线索之间没有矛盾（至少有一种排列可能）
}

export const IMPOSSIBLE: number = -8;
const MAX_WEIGHT: number = 8;

/* 每一对的权重之和；不可能的是 -Infinity。线索里不在名单上的名字忽略 */
export function pairWeights(names: Array<string>, clues: Array<PairClue>): Array<Array<number>> {
  const index: Map<string, number> = new Map(names.map((name: string, i: number): [string, number] => [name, i]));
  const weight: Array<Array<number>> = names.map((): Array<number> => names.map((): number => 0));

  for (const clue of clues) {
    for (const angel of clue.angels) {
      for (const target of clue.targets) {
        const a: number | undefined = index.get(angel);
        const t: number | undefined = index.get(target);

        if (a === undefined || t === undefined) continue;

        weight[a][t] = clue.weight <= IMPOSSIBLE ? -Infinity : weight[a][t] + clue.weight;
      }
    }
  }

  return weight;
}

/* 缩放成每行每列和为 1（双随机矩阵）。有全 0 的行或列时原样返回 */
export function sinkhorn(matrix: Array<Array<number>>, rounds: number = 500): Array<Array<number>> {
  const n: number = matrix.length;
  const m: Array<Array<number>> = matrix.map((row: Array<number>): Array<number> => [...row]);

  for (let round: number = 0; round < rounds; round++) {
    let worst: number = 0;

    for (let i: number = 0; i < n; i++) {
      const sum: number = m[i].reduce((s: number, v: number): number => s + v, 0);

      if (sum <= 0) return m;

      for (let j: number = 0; j < n; j++) m[i][j] /= sum;
    }

    for (let j: number = 0; j < n; j++) {
      let sum: number = 0;

      for (let i: number = 0; i < n; i++) sum += m[i][j];

      if (sum <= 0) return m;

      worst = Math.max(worst, Math.abs(sum - 1));

      for (let i: number = 0; i < n; i++) m[i][j] /= sum;
    }

    if (worst < 1e-12) break;
  }

  return m;
}

/* 积和式和它对每个元素的偏导（Ryser 公式） */
export function permanentGradient(a: Array<Array<number>>): { perm: number; grad: Array<Array<number>> } {
  const n: number = a.length;
  const grad: Array<Array<number>> = a.map((): Array<number> => new Array(n).fill(0));

  if (n === 0) return { perm: 1, grad };

  const rowSum: Float64Array = new Float64Array(n);
  const inSet: Uint8Array = new Uint8Array(n);
  const prefix: Float64Array = new Float64Array(n + 1);
  const suffix: Float64Array = new Float64Array(n + 1);
  let perm: number = 0;
  let size: number = 0;

  for (let k: number = 1; k < 2 ** n; k++) {
    const j: number = 31 - Math.clz32(k & -k); // 格雷码：这一步加进或移出的列
    const add: number = inSet[j] ? -1 : 1;

    inSet[j] ^= 1;
    size += add;

    for (let i: number = 0; i < n; i++) rowSum[i] += add * a[i][j];

    prefix[0] = 1;
    suffix[n] = 1;

    for (let i: number = 0; i < n; i++) prefix[i + 1] = prefix[i] * rowSum[i];

    for (let i: number = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] * rowSum[i];

    const sign: number = size % 2 === 0 ? 1 : -1;

    perm += sign * prefix[n];

    for (let col: number = 0; col < n; col++) {
      if (!inSet[col]) continue;

      for (let i: number = 0; i < n; i++) grad[i][col] += sign * prefix[i] * suffix[i + 1];
    }
  }

  const outer: number = n % 2 === 0 ? 1 : -1;

  return { perm: outer * perm, grad: grad.map((row: Array<number>): Array<number> => row.map((v: number): number => outer * v)) };
}

/* 整体最可能的一组（匈牙利算法，让每一对的分数之和最大） */
export function bestAssignment(score: Array<Array<number>>): Array<number> {
  const n: number = score.length;
  const INF: number = 1e18;
  const cost: (i: number, j: number) => number = (i: number, j: number): number =>
    (Number.isFinite(score[i - 1][j - 1]) ? -score[i - 1][j - 1] : 1e9);
  const u: Array<number> = new Array(n + 1).fill(0);
  const v: Array<number> = new Array(n + 1).fill(0);
  const p: Array<number> = new Array(n + 1).fill(0);
  const way: Array<number> = new Array(n + 1).fill(0);

  for (let i: number = 1; i <= n; i++) {
    p[0] = i;

    let j0: number = 0;
    const minv: Array<number> = new Array(n + 1).fill(INF);
    const used: Array<boolean> = new Array(n + 1).fill(false);

    do {
      used[j0] = true;

      const i0: number = p[j0];
      let delta: number = INF;
      let j1: number = 0;

      for (let j: number = 1; j <= n; j++) {
        if (used[j]) continue;

        const cur: number = cost(i0, j) - u[i0] - v[j];

        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }

        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j: number = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1: number = way[j0];

      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const result: Array<number> = new Array(n).fill(-1);

  for (let j: number = 1; j <= n; j++) if (p[j] > 0) result[p[j] - 1] = j - 1;

  return result;
}

export function infer(names: Array<string>, clues: Array<PairClue>): AngelInference {
  const n: number = names.length;
  const weight: Array<Array<number>> = pairWeights(names, clues);
  const base: Array<Array<number>> = weight.map((row: Array<number>): Array<number> =>
    row.map((w: number): number => (Number.isFinite(w) ? Math.exp(Math.min(MAX_WEIGHT, Math.max(-MAX_WEIGHT, w))) : 0)));
  const scaled: Array<Array<number>> = sinkhorn(base);
  const { perm, grad }: { perm: number; grad: Array<Array<number>> } = permanentGradient(scaled);
  const feasible: boolean = n === 0 || perm > 1e-200;
  let prob: Array<Array<number>>;

  if (feasible) {
    prob = scaled.map((row: Array<number>, a: number): Array<number> => {
      const raw: Array<number> = row.map((v: number, t: number): number => Math.max(0, v * grad[a][t]));
      const sum: number = raw.reduce((s: number, v: number): number => s + v, 0);

      return raw.map((v: number): number => (sum > 0 ? v / sum : 0));
    });
  } else {
    // 线索互相矛盾：退回到只按每一行自己的权重（不再保证每人恰好被抽一次）
    prob = base.map((row: Array<number>): Array<number> => {
      const sum: number = row.reduce((s: number, v: number): number => s + v, 0);

      return row.map((v: number): number => (sum > 0 ? v / sum : 0));
    });
  }

  const best: Array<number> = bestAssignment(prob.map((row: Array<number>): Array<number> =>
    row.map((p: number): number => (p > 0 ? Math.log(p) : -Infinity))));

  return { names, prob, weight, best, feasible };
}
