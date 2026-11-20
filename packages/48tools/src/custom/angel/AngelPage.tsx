import { useEffect, useMemo, useState, type ReactElement, type CSSProperties, type Dispatch as D, type SetStateAction as S } from 'react';
import { Alert, Empty, Tooltip, theme, type GlobalToken } from 'antd';
import { ReloadOutlined as IconReloadOutlined, LoadingOutlined as IconLoadingOutlined } from '@ant-design/icons';
import './angel.global.sass';
import { readJson, writeJson } from '../common/util';
import { bjTime, GAME_END, HISTORY_START } from './angelConfig';
import { buildCharts, type ChartBundle } from './angelChart';
import { useAngelState, getAngelState, refresh, recompute, type AngelState, type AngelSnapshot } from './angelStore';
import { SOURCE_LABEL, type PairClue, type Cite, type AngelInference } from './angelModel';
import type { VisitStat, DayActivity, Moment } from './angelEvidence';
import type { AngelMessage } from './angelText';
import type { GeminiReview, GeminiPick } from './angelFiles';

/**
 * 守护天使推理页面（临时功能，见 ./angelConfig）。样式和 angel.48tools.app 的网页一致（local/angel/site/publish.mjs）：
 *   - 顶栏：标题、几个视图、数据更新时间、「立即更新」
 *   - 「概率表」（默认）：最可能的组合（第一名一张大卡片，后面五个排行）、概率变化曲线、完整的概率热力图、Gemini 的独立判断
 *   - 「概率变化」：每个人一张小图，现在最可能是 TA 天使的人的概率怎么变过来的（历史概率见 ./angelHistory，图见 ./angelChart）
 *   - 「谁是 TA 的天使」「TA 抽到了谁」：每个人一张卡片，前三名和相关的线索
 *   - 「线索」：总体判断，支持和反对两栏，每条写明来源（Claude、Gemini、两边都认可、自动）
 *   - 「串门和上下线」：游戏期间谁去了谁的房间、每个人每天第一条和最后一条消息、关键发言
 * 主题色是紫色 #af83bb；深色模式下热力图从暗到亮。
 */
type View = 'matrix' | 'trend' | 'target' | 'angel' | 'clues' | 'activity';

interface Pair {
  angel: string;
  target: string;
  p: number;
}

const VIEW_KEY: string = 'ANGEL_VIEW_V2';
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'matrix', label: '概率表' },
  { key: 'trend', label: '概率变化' },
  { key: 'target', label: '谁是 TA 的天使' },
  { key: 'angel', label: 'TA 抽到了谁' },
  { key: 'clues', label: '线索' },
  { key: 'activity', label: '串门和上下线' }
];

function pct(p: number): string {
  if (p > 0 && p < 0.01) return '<1%';

  return `${ Math.round(p * 100) }%`;
}

function strength(weight: number): [string, string] {
  if (weight <= -8) return ['排除', 'neg'];

  if (weight < 0) return ['反对', 'neg'];

  if (weight >= 3) return ['确定', 'max'];

  if (weight >= 1.5) return ['强', 'max'];

  if (weight >= 0.5) return ['中', 'mid'];

  return ['弱', 'low'];
}

/* 当前是不是深色主题（看内容区的背景色亮不亮） */
function isDarkColor(color: string): boolean {
  const hex: string = color.replace('#', '');

  if (!/^[0-9a-f]{6}$/i.test(hex)) return false;

  const [r, g, b]: Array<number> = [0, 2, 4].map((i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255);

  return ((0.299 * r) + (0.587 * g) + (0.114 * b)) < 0.4;
}

/* 紫色系的颜色变量，跟着明暗主题变 */
function palette(dark: boolean): CSSProperties {
  return {
    '--a-accent': '#af83bb',
    '--a-ink': dark ? '#d2b4dc' : '#7d5089',
    '--a-hot': dark ? '#efe2f3' : '#4a2856',
    '--a-hot-ink': dark ? '#2a1832' : '#fff',
    '--a-mid-ink': dark ? '#fff' : '#4f2b5c',
    '--a-soft': dark ? '#2a1f31' : '#f3ebf5',
    '--a-cell': dark ? '#211c26' : '#f0eaf2',
    '--a-cool': dark ? '#9aa8c4' : '#5f6c86',
    '--a-cool-soft': dark ? '#1e2330' : '#ebeef4',
    '--a-shadow': dark ? 'none' : '0 1px 2px rgb(40 20 50 / .04), 0 12px 32px -12px rgb(60 30 80 / .14)',
    // 曲线的四条主线（按色盲检查选过的顺序）和其他颜色，见 ./angelChart
    '--s1': dark ? '#b07cc8' : '#8a5a9a',
    '--s2': dark ? '#d95926' : '#eb6834',
    '--s3': dark ? '#199e70' : '#1baf7a',
    '--s4': dark ? '#3987e5' : '#2a78d6',
    '--chart-ctx': dark ? '#3b3442' : '#ddd5e0',
    '--chart-grid': 'var(--shell-border)',
    '--chart-text': 'var(--shell-text)',
    '--chart-text-2': 'var(--shell-text-secondary)',
    '--chart-text-3': 'var(--shell-text-tertiary)',
    '--chart-surface': 'var(--shell-surface)',
    '--chart-future': dark ? 'rgb(175 131 187 / .07)' : 'rgb(175 131 187 / .08)',
    '--chart-tip-bg': 'var(--shell-surface)',
    '--chart-tip-line': 'var(--shell-border)'
  } as CSSProperties;
}

/* 热力图格子的颜色：0 → 主题色 → 最深（深色模式下是最亮） */
function heat(p: number): { style: CSSProperties; ink: string } {
  const level: number = Math.min(1, p * 2.5);
  const background: string = level <= 0.5
    ? `color-mix(in oklab, var(--a-accent) ${ Math.round(level * 200) }%, var(--a-cell))`
    : `color-mix(in oklab, var(--a-hot) ${ Math.round((level - 0.5) * 200) }%, var(--a-accent))`;
  let ink: string = '';

  if (level >= 0.8) ink = 'is-top';
  else if (level >= 0.5) ink = 'is-on';
  else if (level >= 0.25) ink = 'is-mid';

  return { style: { background }, ink };
}

function allPairs(inference: AngelInference): Array<Pair> {
  return inference.names
    .flatMap((angel: string, a: number): Array<Pair> => inference.names.map((target: string, t: number): Pair => ({ angel, target, p: inference.prob[a][t] })))
    .sort((x: Pair, y: Pair): number => y.p - x.p);
}

/* ---------- 线索 ---------- */
function Quotes(props: { cites: Array<Cite> }): ReactElement | null {
  if (props.cites.length === 0) return null;

  return (
    <ul className="angel-quotes">
      { props.cites.map((cite: Cite, i: number): ReactElement => (
        <li key={ i }>
          <p>{ cite.text }</p>
          <span>{ cite.room } { cite.time }</span>
        </li>
      )) }
    </ul>
  );
}

function ClueItem(props: { clue: PairClue }): ReactElement {
  const { clue }: { clue: PairClue } = props;
  const [label, tone]: [string, string] = strength(clue.weight);

  return (
    <article className="angel-clue">
      <header>
        <span className={ `angel-chip is-${ tone }` }>{ label }</span>
        <b>{ clue.angels.join('、') } → { clue.targets.join('、') }</b>
        { clue.title ? <em>{ clue.title }</em> : null }
        <span className="angel-src">{ SOURCE_LABEL[clue.source] }</span>
      </header>
      <p className="angel-why">{ clue.reason }</p>
      <Quotes cites={ clue.cites } />
    </article>
  );
}

/* ---------- 概率表 ---------- */
function Hero(props: { pairs: Array<Pair> }): ReactElement | null {
  const [first, ...rest]: Array<Pair> = props.pairs.slice(0, 6);

  if (!first) return null;

  return (
    <section className="angel-hero">
      <div className="angel-lead">
        <span className="angel-kicker">最可能的组合</span>
        <div className="angel-lead-duo"><span>{ first.angel }</span><i>→</i><span>{ first.target }</span></div>
        <div className="angel-lead-num">{ Math.round(first.p * 100) }<small>%</small></div>
        <p>{ first.angel } 是 { first.target } 的守护天使</p>
      </div>
      <ol className="angel-board">
        { rest.map((pair: Pair, i: number): ReactElement => (
          <li key={ `${ pair.angel }-${ pair.target }` }>
            <span className="angel-no">{ String(i + 2).padStart(2, '0') }</span>
            <span className="angel-duo">{ pair.angel }<i>→</i>{ pair.target }</span>
            <span className="angel-meter"><i style={{ width: `${ ((pair.p / first.p) * 100).toFixed(1) }%` }} /></span>
            <span className="angel-val">{ pct(pair.p) }</span>
          </li>
        )) }
      </ol>
    </section>
  );
}

function Matrix(props: { inference: AngelInference }): ReactElement {
  const { inference }: { inference: AngelInference } = props;
  const [hover, setHover]: [[number, number] | null, D<S<[number, number] | null>>] = useState<[number, number] | null>(null);

  return (
    <section className="angel-panel">
      <div className="angel-panel-head">
        <div>
          <h2>概率表</h2>
          <p className="angel-hint">行是天使，列是被守护的人，数字是百分比。描边是整体最可能的一组。</p>
        </div>
        <span className="angel-scale"><b>0</b><i /><b>40%+</b></span>
      </div>
      <div className="angel-scroll">
        <table className="angel-matrix" onMouseLeave={ (): void => setHover(null) }>
          <thead>
            <tr>
              <th className="angel-corner">天使 ＼ 小主人</th>
              { inference.names.map((name: string, t: number): ReactElement => (
                <th key={ name } scope="col" className={ hover?.[1] === t ? 'is-hl' : undefined }><span>{ name }</span></th>
              )) }
            </tr>
          </thead>
          <tbody>
            { inference.names.map((angel: string, a: number): ReactElement => (
              <tr key={ angel }>
                <th scope="row" className={ hover?.[0] === a ? 'is-hl' : undefined }>{ angel }</th>
                { inference.names.map((target: string, t: number): ReactElement => {
                  const p: number = inference.prob[a][t];
                  const { style, ink }: { style: CSSProperties; ink: string } = heat(p);
                  const className: string = [
                    inference.best[a] === t ? 'is-best' : '',
                    ink,
                    hover && (hover[0] === a || hover[1] === t) ? 'is-hl' : ''
                  ].filter(Boolean).join(' ');

                  return (
                    <Tooltip key={ target } title={ `${ angel } → ${ target }  ${ pct(p) }` } mouseEnterDelay={ 0.4 }>
                      <td className={ className || undefined } style={ style } onMouseEnter={ (): void => setHover([a, t]) }>
                        { p >= 0.005 ? Math.round(p * 100) : '' }
                      </td>
                    </Tooltip>
                  );
                }) }
              </tr>
            )) }
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GeminiPanel(props: { review?: GeminiReview }): ReactElement | null {
  const { review }: { review?: GeminiReview } = props;

  if (!review) return null;

  return (
    <section className="angel-panel">
      <div className="angel-panel-head">
        <div>
          <h2>Gemini 的独立判断</h2>
          <p className="angel-hint">
            { review.model } 读完全部消息后给出的判断，{ review.createdAt ? bjTime(review.createdAt) : '' } 更新。概率表已经合并了它认可和补充的线索。
          </p>
        </div>
      </div>
      { review.summary ? <p className="angel-gem-sum">{ review.summary }</p> : null }
      <ul className="angel-gem">
        { review.picks.slice(0, 8).map((pick: GeminiPick): ReactElement => {
          const tone: [string, string] = pick.confidence >= 0.6 ? ['把握高', 'max'] : pick.confidence >= 0.35 ? ['把握中', 'mid'] : ['把握低', 'low'];

          return (
            <li key={ `${ pick.angel }-${ pick.target }` }>
              <header>
                <span className="angel-duo">{ pick.angel }<i>→</i>{ pick.target }</span>
                <span className={ `angel-chip is-${ tone[1] }` }>{ tone[0] }</span>
              </header>
              <p>{ pick.reason }</p>
            </li>
          );
        }) }
      </ul>
    </section>
  );
}

/* ---------- 概率变化 ---------- */
function TrendPanel(props: { charts: ChartBundle }): ReactElement {
  const { charts }: { charts: ChartBundle } = props;

  return (
    <section className="angel-panel">
      <div className="angel-panel-head">
        <div>
          <h2>概率变化</h2>
          <p className="angel-hint">北京时间每 12 小时一个点，每个点只用当时已有的消息和线索重新算，最后一个点是现在。鼠标停在点上看当时的数值。</p>
        </div>
        <ul className="angel-legend">
          { charts.legend.map((item: { label: string; color: string }): ReactElement => (
            <li key={ item.label }><i style={{ background: item.color }} />{ item.label }</li>
          )) }
          <li className="is-ctx"><i />其他到过 8% 的组合</li>
        </ul>
      </div>
      <div className="angel-chart is-wide" dangerouslySetInnerHTML={{ __html: charts.trend }} />
    </section>
  );
}

function SmallMultiples(props: { charts: ChartBundle }): ReactElement {
  return (
    <>
      <p className="angel-hint angel-small-hint">
        每张图是一个人：紫线是现在最可能是 TA 天使的人，浅灰线是其他人，虚线是平均。所有小图用同一个纵轴，可以直接比较。
      </p>
      <div className="angel-smalls">
        { props.charts.small.map((item: { target: string; angel: string; p: number; svg: string }): ReactElement => (
          <article key={ item.target } className="angel-small">
            <header>
              <h3>{ item.target }<span>的天使</span></h3>
              <span className="angel-small-top">{ item.angel }<b>{ pct(item.p) }</b></span>
            </header>
            <div className="angel-chart" dangerouslySetInnerHTML={{ __html: item.svg }} />
          </article>
        )) }
      </div>
    </>
  );
}

/* ---------- 人物卡片 ---------- */
function PersonCard(props: { snapshot: AngelSnapshot; person: string; mode: 'target' | 'angel' }): ReactElement {
  const { snapshot, person, mode }: { snapshot: AngelSnapshot; person: string; mode: 'target' | 'angel' } = props;
  const { inference }: AngelSnapshot = snapshot;
  const index: number = inference.names.indexOf(person);
  const ranked: Array<{ name: string; p: number }> = inference.names
    .map((name: string, i: number): { name: string; p: number } => ({ name, p: mode === 'target' ? inference.prob[i][index] : inference.prob[index][i] }))
    .sort((a: { p: number }, b: { p: number }): number => b.p - a.p)
    .slice(0, 3);
  const related: Array<PairClue> = snapshot.clues
    .filter((clue: PairClue): boolean => (mode === 'target' ? clue.targets.includes(person) : clue.angels.includes(person)))
    .sort((a: PairClue, b: PairClue): number => Math.abs(b.weight) - Math.abs(a.weight));
  const note: string | undefined = snapshot.clueFile.file?.notes[person];

  return (
    <article className="angel-person">
      <h3>{ person }<span>{ mode === 'target' ? '的天使' : '抽到' }</span></h3>
      <ol className="angel-rank">
        { ranked.map((item: { name: string; p: number }, i: number): ReactElement => (
          <li key={ item.name } className={ i === 0 ? 'is-first' : undefined }>
            <span className="angel-who">{ item.name }{ item.name === person ? <small>自己</small> : null }</span>
            <span className="angel-meter"><i style={{ width: `${ Math.max(3, Math.min(100, item.p * 250)).toFixed(1) }%` }} /></span>
            <span className="angel-val">{ pct(item.p) }</span>
          </li>
        )) }
      </ol>
      { note ? <p className="angel-note">{ note }</p> : null }
      { related.length ? (
        <details>
          <summary>依据 { related.length } 条</summary>
          { related.map((clue: PairClue): ReactElement => <ClueItem key={ clue.id } clue={ clue } />) }
        </details>
      ) : null }
    </article>
  );
}

/* ---------- 线索 ---------- */
function CluesView(props: { snapshot: AngelSnapshot }): ReactElement {
  const { snapshot }: { snapshot: AngelSnapshot } = props;
  const summary: Array<string> = (snapshot.clueFile.file?.summary ?? '').split('\n').filter(Boolean);
  const positive: Array<PairClue> = snapshot.clues.filter((c: PairClue): boolean => c.weight > 0).sort((a: PairClue, b: PairClue): number => b.weight - a.weight);
  const negative: Array<PairClue> = snapshot.clues.filter((c: PairClue): boolean => c.weight < 0).sort((a: PairClue, b: PairClue): number => a.weight - b.weight);

  return (
    <>
      { summary.length ? <div className="angel-conclusion">{ summary.map((line: string, i: number): ReactElement => <p key={ i }>{ line }</p>) }</div> : null }
      <div className="angel-columns">
        <section className="angel-panel">
          <div className="angel-panel-head"><div><h2>支持</h2><p className="angel-hint">让某个组合更可能的线索。</p></div></div>
          { positive.map((clue: PairClue): ReactElement => <ClueItem key={ clue.id } clue={ clue } />) }
        </section>
        <section className="angel-panel">
          <div className="angel-panel-head"><div><h2>反对</h2><p className="angel-hint">让某个组合更不可能的线索。</p></div></div>
          { negative.map((clue: PairClue): ReactElement => <ClueItem key={ clue.id } clue={ clue } />) }
        </section>
      </div>
      <p className="angel-foot">不参加：{ snapshot.excluded.map((item: { name: string; reason: string }): string => `${ item.name }（${ item.reason }）`).join('；') }</p>
    </>
  );
}

/* ---------- 串门和上下线 ---------- */
function ActivityView(props: { snapshot: AngelSnapshot }): ReactElement {
  const { evidence, participants }: AngelSnapshot = props.snapshot;
  const visits: Array<VisitStat> = evidence.visits
    .filter((visit: VisitStat): boolean => visit.game > 0)
    .sort((a: VisitStat, b: VisitStat): number => b.game - a.game);
  const days: Array<string> = [...new Set(participants.flatMap((name: string): Array<string> =>
    (evidence.activity[name] ?? []).map((day: DayActivity): string => day.day)))]
    .sort((a: string, b: string): number => Number(a.split('/')[1]) - Number(b.split('/')[1]));
  const hhmm: (time: number) => string = (time: number): string => bjTime(time).split(' ')[1];

  return (
    <>
      <section className="angel-panel">
        <div className="angel-panel-head"><div><h2>串门</h2><p className="angel-hint">游戏期间去别人房间发言的条数，和游戏前一周对比。</p></div></div>
        { visits.length === 0 ? <p className="angel-hint">还没有串门。</p> : (
          <div className="angel-scroll">
            <table className="angel-table">
              <thead><tr><th>谁</th><th>去了谁的房间</th><th className="is-n">游戏期间</th><th className="is-n">前一周</th><th>最近说的</th></tr></thead>
              <tbody>
                { visits.map((visit: VisitStat): ReactElement => (
                  <tr key={ `${ visit.visitor }-${ visit.host }` }>
                    <td>{ visit.visitor }</td>
                    <td>{ visit.host }</td>
                    <td className="is-n">{ visit.game }</td>
                    <td className="is-n">{ visit.baseline }</td>
                    <td className="is-text">{ visit.last.map((m: AngelMessage): string => `${ bjTime(m.time) } ${ m.text }`).join('；') }</td>
                  </tr>
                )) }
              </tbody>
            </table>
          </div>
        ) }
      </section>
      <section className="angel-panel">
        <div className="angel-panel-head"><div><h2>上下线</h2><p className="angel-hint">每天第一条和最后一条房间发言的时间（北京时间），右上角是当天条数。</p></div></div>
        <div className="angel-scroll">
          <table className="angel-table">
            <thead><tr><th>成员</th>{ days.map((day: string): ReactElement => <th key={ day } className="is-n">{ day }</th>) }</tr></thead>
            <tbody>
              { participants.map((name: string): ReactElement => {
                const byDay: Map<string, DayActivity> = new Map((evidence.activity[name] ?? []).map((d: DayActivity): [string, DayActivity] => [d.day, d]));

                return (
                  <tr key={ name }>
                    <td>{ name }</td>
                    { days.map((day: string): ReactElement => {
                      const item: DayActivity | undefined = byDay.get(day);

                      return (
                        <td key={ day } className="is-n">
                          { item ? <>{ hhmm(item.first) } ~ { hhmm(item.last) }<small>{ item.count }</small></> : <span className="angel-dim">—</span> }
                        </td>
                      );
                    }) }
                  </tr>
                );
              }) }
            </tbody>
          </table>
        </div>
      </section>
      <section className="angel-panel">
        <div className="angel-panel-head"><div><h2>关键发言</h2><p className="angel-hint">提到天使、守护、小主人的发言，新的在上面。</p></div></div>
        <ul className="angel-moments">
          { [...evidence.moments].reverse().map((moment: Moment): ReactElement => (
            <li key={ moment.message.key }>
              <span className="angel-chip is-low">{ { receipt: '收到', act: '当天使', waiting: '等天使', self: '说抽到自己', mention: '提到' }[moment.kind] }</span>
              <p>{ moment.message.text }</p>
              <span className="angel-meta">{ moment.speaker }{ moment.room === moment.speaker ? '' : ` 在 ${ moment.room } 的房间` } { bjTime(moment.message.time) }</span>
            </li>
          )) }
        </ul>
      </section>
    </>
  );
}

function AngelPage(props: {}): ReactElement {
  const state: AngelState = useAngelState();
  const snapshot: AngelSnapshot | undefined = state.snapshot;
  const { token }: { token: GlobalToken } = theme.useToken();
  const charts: ChartBundle | undefined = useMemo((): ChartBundle | undefined => (snapshot ? buildCharts(
    snapshot.history,
    { at: snapshot.builtAt, names: snapshot.inference.names, prob: snapshot.inference.prob },
    HISTORY_START,
    GAME_END,
    bjTime
  ) : undefined), [snapshot]);
  const [view, setView]: [View, D<S<View>>] = useState<View>((): View => {
    const saved: View = readJson<View>(VIEW_KEY, 'matrix');

    return VIEWS.some((item: { key: View }): boolean => item.key === saved) ? saved : 'matrix';
  });

  // 后台还没算过（刚启动）时，先用本地缓存算一次
  useEffect(function(): void {
    if (!getAngelState().snapshot) recompute();
  }, []);

  function handleView(value: View): void {
    writeJson(VIEW_KEY, value);
    setView(value);
  }

  const finished: boolean = Date.now() >= GAME_END;
  const refreshTip: string = state.syncing && state.progress
    ? `正在取 ${ state.progress.name } 的消息（${ state.progress.done + 1 }/${ state.progress.total }）`
    : `立即更新${ finished ? '' : `，下次自动更新 ${ bjTime(state.nextAt) }` }`;

  return (
    <div className="angel" style={ palette(isDarkColor(token.colorBgContainer)) }>
      <header className="angel-bar">
        <div className="angel-brand"><i />NII 守护天使</div>
        <nav className="angel-tabs">
          { VIEWS.map((item: { key: View; label: string }): ReactElement => (
            <button key={ item.key } type="button" className={ view === item.key ? 'is-on' : undefined } onClick={ (): void => handleView(item.key) }>
              { item.label }
            </button>
          )) }
        </nav>
        <span className="angel-stamp">数据更新<b>{ snapshot ? bjTime(snapshot.builtAt) : '—' }</b></span>
        <Tooltip title={ refreshTip }>
          <button type="button" className="angel-refresh" disabled={ state.syncing } aria-label="立即更新" onClick={ (): unknown => refresh() }>
            { state.syncing ? <IconLoadingOutlined /> : <IconReloadOutlined /> }
          </button>
        </Tooltip>
      </header>

      { state.syncError ? <Alert type="warning" showIcon={ true } message={ state.syncError } className="angel-alert" /> : null }
      { snapshot?.clueFile.error ? <Alert type="warning" showIcon={ true } message={ snapshot.clueFile.error } className="angel-alert" /> : null }
      { snapshot && !snapshot.inference.feasible
        ? <Alert type="error" showIcon={ true } message="线索之间有矛盾，没有任何一种抽签结果能同时满足，概率只按每一行自己的权重算" className="angel-alert" />
        : null }

      { snapshot ? (
        <div className="angel-body">
          { view === 'matrix' ? (
            <>
              <Hero pairs={ allPairs(snapshot.inference) } />
              <TrendPanel charts={ charts! } />
              <Matrix inference={ snapshot.inference } />
              <GeminiPanel review={ snapshot.gemini } />
            </>
          ) : null }
          { view === 'trend' ? <SmallMultiples charts={ charts! } /> : null }
          { view === 'target' || view === 'angel' ? (
            <div className="angel-people">
              { snapshot.participants.map((name: string): ReactElement => (
                <PersonCard key={ `${ view }-${ name }` } snapshot={ snapshot } person={ name } mode={ view } />
              )) }
            </div>
          ) : null }
          { view === 'clues' ? <CluesView snapshot={ snapshot } /> : null }
          { view === 'activity' ? <ActivityView snapshot={ snapshot } /> : null }
        </div>
      ) : <Empty className="angel-empty" description={ state.syncing ? '正在取消息……' : '正在读取本地缓存……' } /> }
    </div>
  );
}

export default AngelPage;
