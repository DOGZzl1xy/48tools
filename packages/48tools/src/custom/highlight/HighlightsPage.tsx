import { Fragment, useEffect, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Link } from 'react-router';
import { App, Button, Empty, Progress, Segmented, Tooltip } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  EditOutlined as IconEditOutlined,
  FolderOpenOutlined as IconFolderOpenOutlined,
  HighlightOutlined as IconHighlightOutlined,
  MoreOutlined as IconMoreOutlined,
  ScissorOutlined as IconScissorOutlined
} from '@ant-design/icons';
import './highlights.global.sass';
import '../room/room.global.sass'; // 队伍的小标签（.room-team）
import TeamTag from '../theme/TeamTag';
import type { Team } from '../theme/accent';
import { loadMemberDirectory, teamOfName, useMemberDirectory } from '../room/memberDirectory';
import { setQueueOpen } from '../shell/shellStore';
import { useQueueTasks, type QueueTask } from '../downloadQueue/downloadQueue';
import { formatBytes } from '../download/formatProgress';
import HighlightPickItem from './HighlightPickItem';
import { FindingMenu, ShowMenu, useShowActions, type ShowActions } from './HighlightShowMenu';
import { editItem, madeCount, pickKey, readyToRender, sameItem, showKind, stillWaiting, toWrite, type ShowInfo, type ShowItem, type ShowKind } from './highlightShow';
import { refreshShows, selectShow, updateShow, useShowState, type Show } from './showStore';
import { clipFileOf, plannedIndexes, replayBytes, rewrite, startRender, startRetitle, startWrite, WRITE_KIND } from './pickTask';
import { highlightTaskId } from './highlightTask';
import { clock, shortName } from './highlightTime';
import type { ClipDraft } from './highlightTypes';

/**
 * 切片页面：Gemini 找完爆点以后在这里挑（用户 2026-11-23 定的），写好标题和亮点以后在这里定，定好了才渲染（2026-11-24 定的）。
 *   - 左边：各场录播，分成正在处理、等你定标题、未切片（等你挑的在前面，有数字）、已切片；名字前面是电台、直播、公演，后面是队伍。
 *     右键有菜单：在 Explorer 中显示、取消切片、删除完整录播、从列表移除（./HighlightShowMenu），右上角的「更多」是同一套
 *   - 右边：这一场找到的全部爆点。推荐的默认「切片」，别的默认「不切」，每个都能单独改；标题和说明点进去就能改，自动存
 *     写好了的下面多一块：选标题、改亮点、看封面（./DraftPanel）
 *   - 底下一条：「写标题」「开始渲染」；做的时候显示进度
 * 数据见 ./showStore，切见 ./pickTask。样子和房间消息（../room）一致：左右两栏，颜色都用外壳的变量。
 * 接入点：pages/48/Index.tsx 的 Highlights 路由；入口是侧边栏的「切片」、下载队列、找好时的通知、自动切片对话框。
 */
type Filter = 'all' | 'cut' | 'naming' | 'made';

function cuttingTask(tasks: Array<QueueTask>, info: ShowInfo): QueueTask | undefined {
  const id: string = highlightTaskId(pickKey(info));

  return tasks.find((task: QueueTask): boolean => task.id === id && task.status === 'running');
}

/* 编号：04、06 ~ 08 */
export function indexesText(indexes: Array<number>): string {
  const parts: Array<[number, number]> = [];

  for (const index of [...indexes].sort((a: number, b: number): number => a - b)) {
    const last: [number, number] | undefined = parts.at(-1);

    last && index === last[1] + 1 ? (last[1] = index) : parts.push([index, index]);
  }

  return parts.map(([from, to]: [number, number]): string => (
    from === to ? String(from).padStart(2, '0') : `${ String(from).padStart(2, '0') } ~ ${ String(to).padStart(2, '0') }`)).join('、');
}

const kindText: Record<ShowKind, string> = { radio: '电台', live: '直播', stage: '公演' };
const kindTeam: Record<ShowKind, Team> = { radio: 'hii', live: 'nii', stage: 'sii' }; // 电台、直播的颜色和录播列表里一致（LiveType）

function KindTag(props: { readonly info: ShowInfo }): ReactElement {
  const kind: ShowKind = showKind(props.info);

  return <TeamTag className="mr-0 picks-kind" team={ kindTeam[kind] }>{ kindText[kind] }</TeamTag>;
}

/* 名字后面的队伍：公演是演出的队，成员按成员名单 */
function TeamBadge(props: { readonly info: ShowInfo }): ReactElement | null {
  const { info }: { readonly info: ShowInfo } = props;
  const directory: ReturnType<typeof useMemberDirectory> = useMemberDirectory();
  const team: { label: string; title: string } | undefined = info.stage
    ? { label: info.stage.team, title: `SNH48 TEAM ${ info.stage.team }` }
    : teamOfName(directory, shortName(info.member));

  return team ? <span className="room-team" title={ team.title }>{ team.label }</span> : null;
}

/* 左边一行右边的字：正在做的进度、等你定标题的和等你挑的个数、做了几个 */
function ShowState(props: { readonly info: ShowInfo; readonly task: QueueTask | undefined }): ReactElement {
  const { info, task }: { readonly info: ShowInfo; readonly task: QueueTask | undefined } = props;
  const made: number = madeCount(info);

  if (task) return <span className="picks-show-state is-running">{ Math.floor(task.percent ?? 0) }%</span>;

  if (info.status === 'naming') {
    const ready: number = info.items.filter(readyToRender).length;

    return <span className="shell-item-badge" aria-label={ `${ ready } 个等你定标题` }>{ ready }</span>;
  }

  if (info.status === 'waiting') return <span className="shell-item-badge" aria-label={ `${ info.items.length } 个爆点等你挑` }>{ info.items.length }</span>;

  if (made > 0) return <span className="picks-show-state">{ made } 个</span>;

  return <span className="picks-show-state">{ info.items.length > 0 ? '已取消' : '没找到' }</span>;
}

/* 左边的一场 */
function ShowRow(props: { readonly show: Show; readonly active: boolean; readonly task: QueueTask | undefined }): ReactElement {
  const { show, active, task }: { readonly show: Show; readonly active: boolean; readonly task: QueueTask | undefined } = props;
  const { dir, info }: Show = show;
  const name: string = info.stage ? info.title : shortName(info.member);

  return (
    <ShowMenu show={ show } cutting={ task !== undefined } trigger="contextMenu">
      <button className={ `picks-show${ active ? ' is-active' : '' }` }
        type="button"
        aria-current={ active }
        onClick={ (): void => selectShow(dir) }
      >
        <span className="picks-show-text">
          <b>
            <KindTag info={ info } />
            <span title={ name }>{ name }</span>
            <TeamBadge info={ info } />
          </b>
          <small title={ info.title }>{ info.stage ? '' : `${ info.title } · ` }{ info.date }</small>
        </span>
        <ShowState info={ info } task={ task } />
      </button>
    </ShowMenu>
  );
}

function ShowList(props: { readonly shows: Array<Show>; readonly current: string | undefined; readonly tasks: Array<QueueTask> }): ReactElement {
  const { shows, current, tasks }: { readonly shows: Array<Show>; readonly current: string | undefined; readonly tasks: Array<QueueTask> } = props;

  function rows(list: Array<Show>): Array<ReactElement> {
    return list.map((show: Show): ReactElement => (
      <ShowRow key={ show.dir } show={ show } active={ show.dir === current } task={ cuttingTask(tasks, show.info) } />
    ));
  }

  function group(title: string, list: Array<Show>): ReactElement | null {
    return list.length === 0 ? null : (
      <Fragment>
        <div className="picks-side-title">{ title }<span>{ list.length }</span></div>
        { rows(list) }
      </Fragment>
    );
  }

  const finding: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.kind === '找爆点' && task.status === 'running');
  const cutting: Array<Show> = shows.filter((show: Show): boolean => cuttingTask(tasks, show.info) !== undefined);
  const naming: Array<Show> = shows.filter((show: Show): boolean => !cutting.includes(show) && show.info.status === 'naming');
  const rest: Array<Show> = shows.filter((show: Show): boolean => !cutting.includes(show) && !naming.includes(show));

  // 等你挑的、一个都没切的算未切片
  function isCut(show: Show): boolean {
    return show.info.status === 'done' && madeCount(show.info) > 0;
  }

  return (
    <aside className="picks-side">
      { finding.length + cutting.length > 0 ? <div className="picks-side-title">正在处理</div> : null }
      {
        finding.map((task: QueueTask): ReactElement => (
          <FindingMenu key={ task.id } task={ task }>
            <button className="picks-show picks-finding" type="button" title="打开下载队列" onClick={ (): void => setQueueOpen(true) }>
              <span className="picks-show-text">
                <b><span title={ task.title }>{ task.title }</span></b>
                <small>找爆点：{ task.detail }</small>
              </span>
              <span className="picks-show-state is-running">{ Math.floor(task.percent ?? 0) }%</span>
            </button>
          </FindingMenu>
        ))
      }
      { rows(cutting) }
      { group('等你定标题', naming) }
      { group('未切片', rest.filter((show: Show): boolean => !isCut(show))) }
      { group('已切片', rest.filter(isCut)) }
    </aside>
  );
}

/* 底下的一条：要写几个、要渲染几个；做的时候是进度 */
function Footer(props: { readonly show: Show; readonly task: QueueTask | undefined }): ReactElement {
  const { show, task }: { readonly show: Show; readonly task: QueueTask | undefined } = props;
  const { dir, info }: Show = show;
  const { message: messageApi }: useAppProps = App.useApp();
  const actions: ShowActions = useShowActions();
  const cuts: Array<ShowItem> = info.items.filter((item: ShowItem): boolean => item.cut);
  const again: number = cuts.filter((item: ShowItem): boolean => item.clip !== undefined).length;
  const writes: number = cuts.filter(toWrite).length;
  const renders: number = cuts.filter(readyToRender).length;
  const indexes: Array<number> = plannedIndexes(dir, info);
  const bytes: number = replayBytes(dir, info);

  function handleWriteClick(): void {
    const problem: string | undefined = startWrite(dir, info);

    problem ? messageApi.warning(problem) : messageApi.success('开始写了，写好会通知你来定标题和亮点');
  }

  function handleRenderClick(): void {
    const problem: string | undefined = startRender(dir, info);

    problem ? messageApi.warning(problem) : messageApi.success('开始渲染了，进度在这里和下载队列里看');
  }

  if (task) {
    return (
      <footer className="picks-footer">
        <Progress className="picks-progress" percent={ Math.floor(task.percent ?? 0) } size="small" status="active" />
        <span className="picks-footer-text"><small>{ task.detail }</small></span>
        <Button type="text" onClick={ (): void => actions.cancel(show) }>取消切片</Button>
        <Button onClick={ (): void => setQueueOpen(true) }>下载队列</Button>
      </footer>
    );
  }

  return (
    <footer className="picks-footer">
      <span className="picks-footer-text">
        <b>{ cuts.length > 0 ? `要切 ${ cuts.length } 个${ again > 0 ? `（重切 ${ again } 个）` : '' }${ renders > 0 ? `，写好 ${ renders } 个` : '' }` : '还没有选要切的' }</b>
        <small>
          {
            [
              indexes.length > 0 ? `编号 ${ indexesText(indexes) }` : '',
              bytes > 0 ? `录播在本机（${ formatBytes(bytes) }）` : ''
            ].filter(Boolean).join(' · ')
          }
        </small>
      </span>
      {
        info.status === 'done' ? null : (
          <Button type="text" onClick={ (): void => actions.cancel(show) }>取消切片</Button>
        )
      }
      {
        writes > 0 || renders === 0 ? (
          <Button type={ renders > 0 ? 'default' : 'primary' } icon={ <IconEditOutlined /> } disabled={ writes === 0 } onClick={ handleWriteClick }>
            写标题{ writes > 0 ? `（${ writes }）` : '' }
          </Button>
        ) : null
      }
      {
        renders > 0 ? (
          <Button type="primary" icon={ <IconScissorOutlined /> } onClick={ handleRenderClick }>开始渲染（{ renders }）</Button>
        ) : null
      }
    </footer>
  );
}

const emptyText: Record<Filter, string> = { all: '', cut: '还没有选要切的。', naming: '没有等着定标题的。', made: '还没有切好的。' };

/* 右边：一场的爆点 */
function ShowView(props: { readonly show: Show; readonly task: QueueTask | undefined }): ReactElement {
  const { show, task }: { readonly show: Show; readonly task: QueueTask | undefined } = props;
  const { dir, info }: Show = show;
  const { message: messageApi }: useAppProps = App.useApp();
  const actions: ShowActions = useShowActions();
  const [filter, setFilter]: [Filter, D<S<Filter>>] = useState<Filter>(info.status === 'naming' ? 'naming' : 'all');
  const locked: boolean = task !== undefined;
  const ready: number = info.items.filter(readyToRender).length;
  const cuts: number = info.items.filter((item: ShowItem): boolean => item.cut).length;
  const made: number = madeCount(info);
  const filters: Record<Filter, (item: ShowItem) => boolean> = {
    all: (): boolean => true,
    cut: (item: ShowItem): boolean => item.cut,
    naming: readyToRender,
    made: (item: ShowItem): boolean => item.clip !== undefined
  };
  const list: Array<ShowItem> = info.items.filter(filters[filter]);

  const tabs: Array<{ label: string; value: Filter }> = [
    { label: `全部 ${ info.items.length }`, value: 'all' },
    { label: `要切 ${ cuts }`, value: 'cut' },
    ...(ready > 0 || filter === 'naming' ? [{ label: `定标题 ${ ready }`, value: 'naming' as Filter }] : []),
    { label: `已切 ${ made }`, value: 'made' }
  ];

  // 写好了：切到要定标题的那几个；都渲染完了就回来
  useEffect(function(): void {
    setFilter((now: Filter): Filter => {
      if (info.status === 'naming') return 'naming';

      return now === 'naming' ? 'all' : now;
    });
  }, [info.status]);

  async function change(next: (item: ShowItem) => ShowItem): Promise<void> {
    try {
      await updateShow(dir, (now: ShowInfo): ShowInfo => stillWaiting({ ...now, items: now.items.map(next) }));
    } catch (err) {
      messageApi.error(`没有存下来：${ err instanceof Error ? err.message : String(err) }`);
    }
  }

  function changeOne(target: ShowItem, next: (item: ShowItem) => ShowItem): Promise<void> {
    return change((item: ShowItem): ShowItem => (sameItem(item, target) ? next(item) : item));
  }

  async function handleRewrite(item: ShowItem): Promise<void> {
    const problem: string | undefined = await rewrite(dir, info, item);

    problem ? messageApi.warning(problem) : messageApi.success('开始重新写了');
  }

  function handleRetitle(item: ShowItem): void {
    const problem: string | undefined = startRetitle(dir, info, item);

    problem ? messageApi.warning(problem) : messageApi.success('开始重做标题和封面了');
  }

  return (
    <section className="picks-main">
      <header className="picks-header">
        <div className="picks-header-title">
          <b>
            <KindTag info={ info } />
            <span title={ `${ info.member }「${ info.title }」` }>{ info.member }「{ info.title }」</span>
            <TeamBadge info={ info } />
          </b>
          <small>{ info.date } · 录播 { clock(info.duration) } · 找到 { info.items.length } 个爆点</small>
        </div>
        <Tooltip title="在 Explorer 中显示" placement="bottom">
          <Button type="text" icon={ <IconFolderOpenOutlined /> } aria-label="在 Explorer 中显示" onClick={ (): void => actions.openFolder(show) } />
        </Tooltip>
        <ShowMenu show={ show } cutting={ locked } trigger="click">
          <Button type="text" icon={ <IconMoreOutlined /> } aria-label="更多操作" />
        </ShowMenu>
      </header>
      <div className="picks-toolbar">
        <Segmented options={ tabs }
          value={ filter }
          onChange={ (value: string): void => setFilter(value as Filter) }
        />
        <span className="picks-space" />
        <Button type="text" size="small" disabled={ locked } onClick={ (): Promise<void> => change((item: ShowItem): ShowItem => ({ ...item, cut: item.recommended && !item.clip })) }>
          只选推荐的
        </Button>
        <Button type="text" size="small" disabled={ locked || cuts === 0 } onClick={ (): Promise<void> => change((item: ShowItem): ShowItem => ({ ...item, cut: false })) }>
          全不选
        </Button>
      </div>
      <div className="picks-scroll">
        {
          list.map((item: ShowItem): ReactElement => (
            <HighlightPickItem key={ `${ item.start }-${ item.end }` }
              dir={ dir }
              info={ info }
              item={ item }
              locked={ locked }
              writing={ task?.kind === WRITE_KIND }
              clipFile={ (): string | undefined => clipFileOf(dir, item) }
              onCut={ (cut: boolean): Promise<void> => changeOne(item, (now: ShowItem): ShowItem => ({ ...now, cut })) }
              onEdit={ (patch: { title?: string; reason?: string }): Promise<void> => changeOne(item, (now: ShowItem): ShowItem => editItem(now, patch)) }
              onDraft={ (next: (draft: ClipDraft) => ClipDraft): Promise<void> => changeOne(item, (now: ShowItem): ShowItem => (now.draft ? { ...now, draft: next(now.draft) } : now)) }
              onRewrite={ (): Promise<void> => handleRewrite(item) }
              onRetitle={ (): void => handleRetitle(item) }
            />
          ))
        }
        { list.length === 0 ? <div className="picks-empty">{ emptyText[filter] }</div> : null }
      </div>
      <Footer show={ show } task={ task } />
    </section>
  );
}

function HighlightsPage(props: {}): ReactElement {
  const { shows, loaded, selected }: ReturnType<typeof useShowState> = useShowState();
  const tasks: Array<QueueTask> = useQueueTasks();
  const current: Show | undefined = shows.find((show: Show): boolean => show.dir === selected) ?? shows[0];

  useEffect(function(): void {
    refreshShows();
    loadMemberDirectory(); // 队伍：一天更新一次
  }, []);

  if (!current) {
    return (
      <div className="picks">
        <ShowList shows={ shows } current={ undefined } tasks={ tasks } />
        <section className="picks-main picks-center">
          {
            loaded ? (
              <Empty image={ <IconHighlightOutlined className="text-[48px] opacity-40" /> } description="还没有找过爆点">
                <Link to="/48/Pocket48Record">到录播下载里选一场，点「更多 → 自动切片」</Link>
              </Empty>
            ) : null
          }
        </section>
      </div>
    );
  }

  return (
    <div className="picks">
      <ShowList shows={ shows } current={ current.dir } tasks={ tasks } />
      <ShowView key={ current.dir } show={ current } task={ cuttingTask(tasks, current.info) } />
    </div>
  );
}

export default HighlightsPage;
