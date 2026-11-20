/**
 * 概率变化曲线：生成 SVG 字符串（不依赖 React 和其他文件），给 angel.48tools.app 的网页用：
 *   - 网页（local/angel/site/publish.mjs）用仓库里的 typescript 把这个文件转成 JS，生成网页时和网页里的脚本都调用它，所以这里不能 import 任何东西
 *   - 测试见 ./angelHistory.spec.ts
 * 颜色全部用 CSS 变量，由网页的样式表定义（明暗主题跟着变）：
 *   --s1 ~ --s4：四条主线；--chart-ctx：其他组合的浅灰线；--chart-grid、--chart-text、--chart-text-2、--chart-text-3；
 *   --chart-surface（点的描边）、--chart-future（揭晓前还没到的时间）、--chart-tip-bg、--chart-tip-line
 * 鼠标停在某个时间点上会显示竖线和当时的数值（纯 CSS，不用脚本）：.chart-col:hover .chart-hover 显示。
 */
export interface ChartPoint {
  t: number;
  p: number;
}

export interface ChartSeries {
  label: string;
  color: string;           // CSS 颜色，比如 var(--s1)
  points: Array<ChartPoint>;
}

export interface TrendOptions {
  start: number;           // 横轴起点
  end: number;             // 横轴终点（揭晓）
  now: number;
  yMax: number;
  baseline: number;        // 平均值（1/人数）
  series: Array<ChartSeries>;
  context: Array<Array<ChartPoint>>;
  timeLabel: (t: number) => string;
  width?: number;          // 图的大小（viewBox），默认 960 × 340；放在小地方时用小一点的尺寸，字才不会被缩得太小
  height?: number;
  labelSpace?: number;     // 右边留给线末尾名字的宽度，默认 170
  aria?: string;
}

export interface HistoryLike {
  at: number;
  names: Array<string>;
  prob: Array<Array<number>>;
}

const hour: number = 3_600_000;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c: string): string => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

const fmt: (n: number) => string = (n: number): string => n.toFixed(1);
const pct: (p: number) => string = (p: number): string => `${ Math.round(p * 100) }%`;

/* 某一对（天使 → 小主人）在每个时间点的概率 */
export function pairPoints(history: Array<HistoryLike>, angel: string, target: string): Array<ChartPoint> {
  const points: Array<ChartPoint> = [];

  for (const entry of history) {
    const a: number = entry.names.indexOf(angel);
    const t: number = entry.names.indexOf(target);

    if (a >= 0 && t >= 0) points.push({ t: entry.at, p: entry.prob[a][t] });
  }

  return points;
}

/* 纵轴上限：最大值往上取到 10% 的整数倍，至少 floor（默认 30%）；上限在 20% 以内时按 5% 取 */
export function niceMax(values: Array<number>, floor: number = 0.3): number {
  const top: number = Math.max(0, ...values) + 0.02;
  const unit: number = top <= 0.2 ? 0.05 : 0.1;

  return Math.max(floor, Math.ceil(top / unit) * unit);
}

function polyline(points: Array<ChartPoint>, x: (t: number) => number, y: (p: number) => number, attrs: string): string {
  if (points.length === 0) return '';

  if (points.length === 1) {
    return `<circle cx="${ fmt(x(points[0].t)) }" cy="${ fmt(y(points[0].p)) }" r="1.5" ${ attrs }/>`;
  }

  return `<polyline points="${ points.map((point: ChartPoint): string => `${ fmt(x(point.t)) },${ fmt(y(point.p)) }`).join(' ') }" fill="none" stroke-linejoin="round" stroke-linecap="round" ${ attrs }/>`;
}

/* 直接标在线末尾的名字：按高度排开，至少隔 16px */
function spreadLabels(items: Array<{ y: number }>, min: number, max: number, gap: number): Array<number> {
  const order: Array<number> = items.map((_: { y: number }, i: number): number => i).sort((a: number, b: number): number => items[a].y - items[b].y);
  const placed: Array<number> = new Array(items.length).fill(0);
  let last: number = -Infinity;

  for (const i of order) {
    placed[i] = Math.max(items[i].y, last + gap, min);
    last = placed[i];
  }

  // 超出底部时整体往上推
  const overflow: number = last - max;

  if (overflow > 0) for (const i of order) placed[i] -= overflow;

  return placed;
}

/* 主图：几条最可能的组合 + 其他组合的浅灰线 + 平均线 + 揭晓前的区域 */
export function renderTrend(options: TrendOptions): string {
  const W: number = options.width ?? 960;
  const H: number = options.height ?? 340;
  const left: number = 44;
  const labelSpace: number = options.labelSpace ?? 170;
  // 线末尾的名字标在「现在」右边：离揭晓还早时右边本来就有空，只留不够的那部分
  const frac: number = Math.min(1, Math.max(0.01, (options.now - options.start) / (options.end - options.start)));
  const right: number = Math.max(16, W - left - ((W - left - labelSpace) / frac));
  const top: number = 16;
  const bottom: number = 30;
  const w: number = W - left - right;
  const h: number = H - top - bottom;
  const x: (t: number) => number = (t: number): number => left + (((t - options.start) / (options.end - options.start)) * w);
  const y: (p: number) => number = (p: number): number => top + h - ((p / options.yMax) * h);
  const parts: Array<string> = [];
  const nowX: number = x(Math.min(options.now, options.end));

  // 揭晓前（还没到的时间）
  if (options.now < options.end) {
    parts.push(`<rect x="${ fmt(nowX) }" y="${ top }" width="${ fmt(left + w - nowX) }" height="${ h }" fill="var(--chart-future)"/>`);
    parts.push(`<text x="${ fmt(left + w - 6) }" y="${ top + 14 }" text-anchor="end" class="chart-note">揭晓前</text>`);
  }

  // 横线和纵轴刻度（上限小的时候 5% 一格）
  const step: number = options.yMax <= 0.2 + 1e-9 ? 0.05 : 0.1;

  for (let p: number = 0; p <= options.yMax + 1e-9; p += step) {
    parts.push(`<line x1="${ left }" x2="${ left + w }" y1="${ fmt(y(p)) }" y2="${ fmt(y(p)) }" stroke="var(--chart-grid)" stroke-width="1"/>`);
    parts.push(`<text x="${ left - 8 }" y="${ fmt(y(p) + 4) }" text-anchor="end" class="chart-axis">${ pct(p) }</text>`);
  }

  // 每天 0 点一个刻度
  for (let t: number = options.start; t <= options.end + 1; t += 24 * hour) {
    const isEnd: boolean = t >= options.end - 1;

    parts.push(`<line x1="${ fmt(x(t)) }" x2="${ fmt(x(t)) }" y1="${ top + h }" y2="${ top + h + 4 }" stroke="var(--chart-grid)"/>`);
    parts.push(`<text x="${ fmt(x(t)) }" y="${ H - 8 }" text-anchor="middle" class="chart-axis">${ esc(isEnd ? '揭晓' : options.timeLabel(t).split(' ')[0]) }</text>`);
  }

  // 平均线
  parts.push(`<line x1="${ left }" x2="${ left + w }" y1="${ fmt(y(options.baseline)) }" y2="${ fmt(y(options.baseline)) }" stroke="var(--chart-text-3)" stroke-width="1" stroke-dasharray="4 4"/>`);
  parts.push(`<text x="${ left + 6 }" y="${ fmt(y(options.baseline) - 6) }" class="chart-note">平均 ${ pct(options.baseline) }</text>`);

  // 其他组合
  for (const points of options.context) {
    parts.push(polyline(points, x, y, 'stroke="var(--chart-ctx)" stroke-width="1"'));
  }

  // 主线（后画的在上面：第一名最后画）
  for (const series of [...options.series].reverse()) {
    parts.push(polyline(series.points, x, y, `stroke="${ series.color }" stroke-width="2"`));

    for (const point of series.points) {
      parts.push(`<circle cx="${ fmt(x(point.t)) }" cy="${ fmt(y(point.p)) }" r="4" fill="${ series.color }" stroke="var(--chart-surface)" stroke-width="2"/>`);
    }
  }

  // 线末尾的名字和数值
  const ends: Array<{ y: number; series: ChartSeries; last: ChartPoint }> = options.series
    .filter((series: ChartSeries): boolean => series.points.length > 0)
    .map((series: ChartSeries): { y: number; series: ChartSeries; last: ChartPoint } => {
      const last: ChartPoint = series.points[series.points.length - 1];

      return { y: y(last.p), series, last };
    });
  const labelY: Array<number> = spreadLabels(ends, top + 6, top + h, 18);

  ends.forEach((end: { y: number; series: ChartSeries; last: ChartPoint }, i: number): void => {
    const lx: number = x(end.last.t) + 10;

    parts.push(`<line x1="${ fmt(lx) }" x2="${ fmt(lx + 10) }" y1="${ fmt(labelY[i]) }" y2="${ fmt(labelY[i]) }" stroke="${ end.series.color }" stroke-width="3" stroke-linecap="round"/>`);
    parts.push(`<text x="${ fmt(lx + 16) }" y="${ fmt(labelY[i] + 4) }" class="chart-label">${ esc(end.series.label) } <tspan class="chart-value">${ pct(end.last.p) }</tspan></text>`);
  });

  // 鼠标停留：每个时间点一列
  const times: Array<number> = [...new Set(options.series.flatMap((series: ChartSeries): Array<number> => series.points.map((point: ChartPoint): number => point.t)))]
    .sort((a: number, b: number): number => a - b);

  times.forEach((t: number, i: number): void => {
    const cx: number = x(t);
    const from: number = i === 0 ? left : (x(times[i - 1]) + cx) / 2;
    const to: number = i === times.length - 1 ? Math.min(left + w, cx + 30) : (cx + x(times[i + 1])) / 2;
    const rows: Array<{ series: ChartSeries; p: number }> = options.series
      .map((series: ChartSeries): { series: ChartSeries; p: number } | undefined => {
        const point: ChartPoint | undefined = series.points.find((item: ChartPoint): boolean => item.t === t);

        return point ? { series, p: point.p } : undefined;
      })
      .filter((row: { series: ChartSeries; p: number } | undefined): row is { series: ChartSeries; p: number } => row !== undefined);
    const boxW: number = 190;
    const boxH: number = 28 + (rows.length * 18);
    const boxX: number = cx + boxW + 12 > W ? cx - boxW - 10 : cx + 10;
    const tip: string = rows.map((row: { series: ChartSeries; p: number }, k: number): string => {
      const ry: number = top + 40 + (k * 18);

      return `<circle cx="${ fmt(boxX + 14) }" cy="${ ry - 4 }" r="4" fill="${ row.series.color }"/>`
        + `<text x="${ fmt(boxX + 24) }" y="${ ry }" class="chart-tip">${ esc(row.series.label) }</text>`
        + `<text x="${ fmt(boxX + boxW - 12) }" y="${ ry }" text-anchor="end" class="chart-tip chart-value">${ pct(row.p) }</text>`;
    }).join('');

    parts.push(`<g class="chart-col"><rect x="${ fmt(from) }" y="${ top }" width="${ fmt(Math.max(4, to - from)) }" height="${ h }" fill="transparent"/>`
      + '<g class="chart-hover">'
      + `<line x1="${ fmt(cx) }" x2="${ fmt(cx) }" y1="${ top }" y2="${ top + h }" stroke="var(--chart-text-3)" stroke-width="1"/>`
      + `<rect x="${ fmt(boxX) }" y="${ top + 8 }" width="${ boxW }" height="${ boxH }" rx="10" fill="var(--chart-tip-bg)" stroke="var(--chart-tip-line)"/>`
      + `<text x="${ fmt(boxX + 12) }" y="${ top + 24 }" class="chart-tip chart-tip-head">${ esc(t >= options.now - 1 ? `现在（${ options.timeLabel(t) }）` : options.timeLabel(t)) }</text>`
      + `${ tip }</g></g>`);
  });

  return `<svg class="chart-trend" viewBox="0 0 ${ W } ${ H }" role="img" aria-label="${ esc(options.aria ?? '最可能的组合的概率变化') }">${ parts.join('') }</svg>`;
}

/* 小图：某个小主人最可能的天使（主线）+ 其他人（浅灰线） */
export function renderSmall(options: {
  start: number;
  end: number;
  now: number;
  yMax: number;
  baseline: number;
  main: ChartPoint[];
  context: Array<Array<ChartPoint>>;
  timeLabel: (t: number) => string;
}): string {
  const W: number = 300;
  const H: number = 110;
  const left: number = 4;
  const right: number = 40;
  const top: number = 8;
  const bottom: number = 18;
  const w: number = W - left - right;
  const h: number = H - top - bottom;
  const x: (t: number) => number = (t: number): number => left + (((t - options.start) / (options.end - options.start)) * w);
  const y: (p: number) => number = (p: number): number => top + h - ((p / options.yMax) * h);
  const parts: Array<string> = [];
  const nowX: number = x(Math.min(options.now, options.end));

  if (options.now < options.end) {
    parts.push(`<rect x="${ fmt(nowX) }" y="${ top }" width="${ fmt(left + w - nowX) }" height="${ h }" fill="var(--chart-future)"/>`);
  }

  parts.push(`<line x1="${ left }" x2="${ left + w }" y1="${ top + h }" y2="${ top + h }" stroke="var(--chart-grid)"/>`);
  parts.push(`<line x1="${ left }" x2="${ left + w }" y1="${ fmt(y(options.baseline)) }" y2="${ fmt(y(options.baseline)) }" stroke="var(--chart-text-3)" stroke-dasharray="3 3"/>`);
  parts.push(`<text x="${ left }" y="${ H - 4 }" class="chart-axis">${ esc(options.timeLabel(options.start).split(' ')[0]) }</text>`);
  parts.push(`<text x="${ left + w }" y="${ H - 4 }" text-anchor="end" class="chart-axis">揭晓</text>`);

  for (const points of options.context) parts.push(polyline(points, x, y, 'stroke="var(--chart-ctx)" stroke-width="1"'));

  parts.push(polyline(options.main, x, y, 'stroke="var(--s1)" stroke-width="2"'));

  const last: ChartPoint | undefined = options.main[options.main.length - 1];

  if (last) {
    parts.push(`<circle cx="${ fmt(x(last.t)) }" cy="${ fmt(y(last.p)) }" r="4" fill="var(--s1)" stroke="var(--chart-surface)" stroke-width="2"/>`);
    parts.push(`<text x="${ fmt(x(last.t) + 8) }" y="${ fmt(y(last.p) + 4) }" class="chart-label chart-value">${ pct(last.p) }</text>`);
  }

  return `<svg class="chart-small" viewBox="0 0 ${ W } ${ H }" role="img">${ parts.join('') }</svg>`;
}

/**
 * 某一个人的一组概率怎么变化：
 *   - mode 'target'：谁是 TA 的天使（TA 那一列：每个人是 TA 天使的概率）
 *   - mode 'angel'：TA 抽到了谁（TA 那一行）
 * 现在最可能的 4 个人上色并在线末尾标名字，其他人画成浅灰线；纵轴按这个人自己的数值定（每个人单独算）。
 */
export function personChart(
  history: Array<HistoryLike>,
  current: HistoryLike,
  person: string,
  mode: 'target' | 'angel',
  start: number,
  end: number,
  timeLabel: (t: number) => string,
  size: { width?: number; height?: number; labelSpace?: number } = {}
): { svg: string; legend: Array<{ label: string; color: string }> } {
  const timeline: Array<HistoryLike> = [...history.filter((entry: HistoryLike): boolean => entry.at < current.at), current];
  const names: Array<string> = current.names;
  const index: number = names.indexOf(person);
  const valueOf: (entry: HistoryLike, other: number) => number = (entry: HistoryLike, other: number): number => (mode === 'target' ? entry.prob[other][index] : entry.prob[index][other]);
  const pointsOf: (other: string) => Array<ChartPoint> = (other: string): Array<ChartPoint> => (mode === 'target' ? pairPoints(timeline, other, person) : pairPoints(timeline, person, other));
  const ranked: Array<number> = names.map((_: string, i: number): number => i).sort((a: number, b: number): number => valueOf(current, b) - valueOf(current, a));
  const label: (other: string) => string = (other: string): string => (other === person ? `${ other }（自己）` : other);
  const series: Array<ChartSeries> = ranked.slice(0, 4).map((i: number, k: number): ChartSeries => ({
    label: label(names[i]),
    color: `var(--s${ k + 1 })`,
    points: pointsOf(names[i])
  }));
  const context: Array<Array<ChartPoint>> = ranked.slice(4).map((i: number): Array<ChartPoint> => pointsOf(names[i]));
  const values: Array<number> = [...series, ...context.map((points: Array<ChartPoint>): ChartSeries => ({ label: '', color: '', points }))]
    .flatMap((item: ChartSeries): Array<number> => item.points.map((point: ChartPoint): number => point.p));
  const svg: string = renderTrend({
    start,
    end,
    now: current.at,
    yMax: niceMax(values, 0.15),
    baseline: 1 / Math.max(1, names.length),
    series,
    context,
    timeLabel,
    aria: mode === 'target' ? `${ person } 的天使是谁的概率变化` : `${ person } 抽到了谁的概率变化`,
    ...size
  });

  return { svg, legend: series.map((item: ChartSeries): { label: string; color: string } => ({ label: item.label, color: item.color })) };
}

export interface ChartBundle {
  trend: string;
  legend: Array<{ label: string; color: string }>;
  small: Array<{ target: string; angel: string; p: number; svg: string }>;
}

/**
 * 从历史（每 12 小时一个点）和现在的结果生成所有的图：
 *   - trend：现在最可能的 4 组的变化（颜色跟着组合走，按现在的排名分配），其他曾经到过 8% 的组合画成浅灰线
 *   - small：每个人一张小图，主线是现在最可能是 TA 天使的人，其他人是浅灰线；所有小图用同一个纵轴，方便比较
 */
export function buildCharts(
  history: Array<HistoryLike>,
  current: HistoryLike,
  start: number,
  end: number,
  timeLabel: (t: number) => string,
  size: { width?: number; height?: number; labelSpace?: number } = {}
): ChartBundle {
  const timeline: Array<HistoryLike> = [...history.filter((entry: HistoryLike): boolean => entry.at < current.at), current];
  const names: Array<string> = current.names;
  const pairs: Array<{ angel: string; target: string; p: number }> = names
    .flatMap((angel: string, a: number): Array<{ angel: string; target: string; p: number }> =>
      names.map((target: string, t: number): { angel: string; target: string; p: number } => ({ angel, target, p: current.prob[a][t] })))
    .sort((m: { p: number }, n: { p: number }): number => n.p - m.p);
  const top: Array<{ angel: string; target: string; p: number }> = pairs.slice(0, 4);
  const series: Array<ChartSeries> = top.map((pair: { angel: string; target: string }, i: number): ChartSeries => ({
    label: `${ pair.angel } → ${ pair.target }`,
    color: `var(--s${ i + 1 })`,
    points: pairPoints(timeline, pair.angel, pair.target)
  }));
  const topKeys: Set<string> = new Set(top.map((pair: { angel: string; target: string }): string => `${ pair.angel }>${ pair.target }`));
  const context: Array<Array<ChartPoint>> = pairs
    .filter((pair: { angel: string; target: string }): boolean => !topKeys.has(`${ pair.angel }>${ pair.target }`))
    .map((pair: { angel: string; target: string }): Array<ChartPoint> => pairPoints(timeline, pair.angel, pair.target))
    .filter((points: Array<ChartPoint>): boolean => points.some((point: ChartPoint): boolean => point.p >= 0.08))
    .slice(0, 24);
  const allValues: Array<number> = timeline.flatMap((entry: HistoryLike): Array<number> => entry.prob.flat());
  const yMax: number = niceMax(allValues);
  const baseline: number = 1 / Math.max(1, names.length);
  const trend: string = renderTrend({ start, end, now: current.at, yMax, baseline, series, context, timeLabel, ...size });
  const small: ChartBundle['small'] = names.map((target: string, t: number): { target: string; angel: string; p: number; svg: string } => {
    const ranked: Array<number> = names.map((_: string, a: number): number => a).sort((a: number, b: number): number => current.prob[b][t] - current.prob[a][t]);
    const angel: string = names[ranked[0]];

    return {
      target,
      angel,
      p: current.prob[ranked[0]][t],
      svg: renderSmall({
        start,
        end,
        now: current.at,
        yMax,
        baseline,
        main: pairPoints(timeline, angel, target),
        context: ranked.slice(1).map((a: number): Array<ChartPoint> => pairPoints(timeline, names[a], target)),
        timeLabel
      })
    };
  });

  return { trend, legend: series.map((item: ChartSeries): { label: string; color: string } => ({ label: item.label, color: item.color })), small };
}
