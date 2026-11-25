import * as fs from 'node:fs';
import { shell } from 'electron';
import { Fragment, useEffect, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Link, useNavigate, type NavigateFunction } from 'react-router';
import { useDispatch, useSelector } from 'react-redux';
import type { Dispatch } from '@reduxjs/toolkit';
import { Avatar, Badge, Button, Collapse, Image, Progress, Space, Tag, Typography } from 'antd';
import {
  ArrowRightOutlined as IconArrowRightOutlined,
  FileSyncOutlined as IconFileSyncOutlined,
  SettingOutlined as IconSettingOutlined
} from '@ant-design/icons';
import { requestLiveList, type LiveData, type LiveInfo, type CustomMessageV2 } from '@48tools-api/48';
import './home.global.sass';
import '../room/room.global.sass'; // 队伍的小标签（.room-team）
import ButtonLink from '../../components/ButtonLink/ButtonLink';
import Pocket48ProxyOption from '../pocket48Proxy/Pocket48ProxyOption';
import imageUrlZfbAvif from '../../pages/Index/images/zfb.avif';
import imageUrlWxAvif from '../../pages/Index/images/wx.avif';
import { setLiveList } from '../../pages/48/reducers/pocket48';
import { source } from '../../utils/snh48';
import { shellNavItems, type ShellNavItem } from '../shell/navConfig';
import { setQueueOpen } from '../shell/shellStore';
import { useQueueTasks, type QueueTask } from '../downloadQueue/downloadQueue';
import { safeOpenExternal } from '../security/safeOpenExternal';
import { useRoomState, openRoom, type RoomState, type RoomMember } from '../room/roomStore';
import { useUnreadState, type UnreadState } from '../room/unreadStore';
import { readRoomCache, type RoomCacheData } from '../room/roomCache';
import { messageText } from '../room/roomSearchText';
import { emojiText } from '../room/emojiText';
import { roomClock, type RoomClock } from '../room/roomTime';
import { useMemberDirectory, loadMemberDirectory, teamOf, type DirectoryState } from '../room/memberDirectory';
import { usePresenceState, type MemberPresence, type PresenceState } from '../room/presenceStore';
import PresenceDot from '../room/PresenceDot';
import { useTimeZone } from '../time/appTime';

/**
 * 首页：常用功能的大卡片；关注的成员（未读数、最新一条消息，点一下进房间）；现在谁在直播（自动抓取是否在运行）；
 * 当前任务和最近完成的下载；设置入口；关于。
 * 以前这里有一块「全部功能」，和侧边栏完全重复，去掉了（侧边栏和 Ctrl+K 都能到任何功能）。
 * 原版首页（pages/Index/Index.tsx）保留不动，赞助信息复用原版的图片。
 * 接入点：router/Routers.tsx 的首页路由。
 */
const featuredKeys: Array<string> = ['48-room-message', 'pocket48-record', 'pocket48-live'];
const featuredText: Record<string, string> = { '48-room-message': '看关注成员在房间里发的消息，语音可以转文字' };
const featured: Array<ShellNavItem> = featuredKeys
  .map((key: string): ShellNavItem | undefined => shellNavItems.find((item: ShellNavItem): boolean => item.key === key))
  .filter((item: ShellNavItem | undefined): item is ShellNavItem => item !== undefined);
const MAX_LIVE: number = 8;

function FeaturedCard(props: { item: ShellNavItem }): ReactElement {
  const { item }: { item: ShellNavItem } = props;

  return (
    <Link className="home-card" to={ item.to } draggable={ false }>
      <span className="home-card-icon">{ item.icon }</span>
      <span className="home-card-text">
        <b>{ item.title }</b>
        <small>{ item.description ?? featuredText[item.key] }</small>
      </span>
      <IconArrowRightOutlined className="home-card-arrow" />
    </Link>
  );
}

/* 最新一条消息的摘要 */
function previewOf(raw: CustomMessageV2 | undefined): string {
  if (!raw) return '';

  const names: Record<string, string> = { IMAGE: '[图片]', AUDIO: '[语音]', VIDEO: '[视频]', EXPRESSIMAGE: '[表情]', LIVEPUSH: '[直播]' };

  return emojiText(messageText(raw)).replace(/\s+/g, ' ').trim() || names[raw.msgType] || '[消息]';
}

/* 关注的成员：头像、队伍、未读数、最新一条消息 */
function FollowedMembers(props: {}): ReactElement {
  const navigate: NavigateFunction = useNavigate();
  const room: RoomState = useRoomState();
  const unread: UnreadState = useUnreadState();
  const directory: DirectoryState = useMemberDirectory();
  const presence: PresenceState = usePresenceState();
  const zone: string = useTimeZone();
  const [cached, setCached]: [Record<number, CustomMessageV2>, D<S<Record<number, CustomMessageV2>>>] = useState({});

  // 没打开过的房间：从本地缓存里读最新的一条
  useEffect(function(): () => void {
    let alive: boolean = true;

    loadMemberDirectory();
    Promise.all(room.follows.map((member: RoomMember): Promise<RoomCacheData> => readRoomCache('owner', member.ownerId, { limit: 1 })))
      .then((list: Array<RoomCacheData>): void => {
        if (!alive) return;

        const next: Record<number, CustomMessageV2> = {};

        list.forEach((data: RoomCacheData, index: number): void => {
          const raw: CustomMessageV2 | undefined = data.messages[data.messages.length - 1];

          if (raw) next[room.follows[index].ownerId] = raw;
        });
        setCached(next);
      });

    return (): void => {
      alive = false;
    };
  }, [room.follows]);

  if (room.follows.length === 0) {
    return (
      <div className="home-empty">
        还没有关注的成员。
        <Link to="/48/RoomMessage">到房间消息里搜索成员，点星标关注</Link>
        ，这里就会显示她们的新消息。
      </div>
    );
  }

  return (
    <div className="home-members">
      {
        room.follows.map((member: RoomMember): ReactElement => {
          const loaded: CustomMessageV2 | undefined = room.rooms[member.ownerId]?.items.at(-1)?.raw;
          const raw: CustomMessageV2 | undefined = loaded ?? cached[member.ownerId];
          const clock: RoomClock | undefined = raw ? roomClock(raw.msgTime, zone) : undefined;
          const team: { label: string; title: string } | undefined = teamOf(directory, member.ownerId);
          const memberPresence: MemberPresence | undefined = presence.byOwner[member.ownerId];

          return (
            <button key={ member.ownerId }
              className="home-member"
              type="button"
              onClick={ (): void => {
                openRoom(member);
                navigate('/48/RoomMessage');
              } }
            >
              <Badge count={ unread.counts[member.ownerId] ?? 0 } overflowCount={ 99 } size="small" offset={ [-4, 4] }>
                <PresenceDot visible={ true }
                  presence={ memberPresence }
                  size="md"
                >
                  <Avatar size={ 44 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
                </PresenceDot>
              </Badge>
              <span className="home-member-text">
                <b>
                  <span>{ member.name }</span>
                  { team ? <span className="room-team" title={ team.title }>{ team.label }</span> : null }
                  { clock ? <time title={ clock.full }>{ clock.date.slice(5) } { clock.time }</time> : null }
                </b>
                <small>{ raw ? previewOf(raw) : '进入房间后会显示最新的消息' }</small>
              </span>
            </button>
          );
        })
      }
    </div>
  );
}

/* 现在谁在直播 */
function LiveNow(props: {}): ReactElement {
  const dispatch: Dispatch = useDispatch();
  const liveList: Array<LiveInfo> = useSelector((state: { pocket48: { liveList: Array<LiveInfo> } }): Array<LiveInfo> => state.pocket48.liveList);
  const grabbing: boolean = useSelector(
    (state: { pocket48: { autoGrabTimer: number | null } }): boolean => typeof state.pocket48.autoGrabTimer === 'number');
  const [status, setStatus]: ['loading' | 'ready' | 'error', D<S<'loading' | 'ready' | 'error'>>] = useState<'loading' | 'ready' | 'error'>('loading');

  // 进首页时取一次直播列表（自动抓取在运行时它每分钟也会更新这份列表）
  useEffect(function(): () => void {
    let alive: boolean = true;

    requestLiveList('0', true).then((res: LiveData): void => {
      if (!alive) return;

      if (res.success && res.content?.liveList) {
        dispatch(setLiveList(res.content.liveList));
        setStatus('ready');
      } else {
        setStatus('error');
      }
    }).catch((err: unknown): void => {
      console.error(err);
      alive && setStatus('error');
    });

    return (): void => {
      alive = false;
    };
  }, []);

  return (
    <Fragment>
      <div className="home-live-status">
        <span className={ `shell-dot${ grabbing ? ' is-ok' : '' }` } />
        { grabbing ? '自动抓取运行中：选中的成员开播就会自动录。' : '自动抓取没有在运行。' }
        <Link to={ grabbing ? '/48/Pocket48Live' : '/48/LiveOptions' }>{ grabbing ? '查看' : '去配置' }</Link>
      </div>
      {
        liveList.length === 0 ? (
          <div className="home-empty">
            { status === 'loading' ? '正在看有谁在直播…' : (status === 'error' ? '直播列表没取到，可以到直播抓取页面刷新看看。' : '现在没有成员在直播。') }
          </div>
        ) : (
          <div className="home-lives">
            {
              liveList.slice(0, MAX_LIVE).map((item: LiveInfo): ReactElement => (
                <Link key={ item.liveId } className="home-live" to="/48/Pocket48Live" draggable={ false } title={ item.title }>
                  <Avatar shape="square" size={ 40 } src={ source(item.coverPath) } />
                  <span>
                    <b>{ item.userInfo.nickname }</b>
                    <small>{ item.title }</small>
                  </span>
                </Link>
              ))
            }
            { liveList.length > MAX_LIVE ? <Link className="home-live-more" to="/48/Pocket48Live">还有 { liveList.length - MAX_LIVE } 个…</Link> : null }
          </div>
        )
      }
    </Fragment>
  );
}

function showInFolder(filePath: string): void {
  if (fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  } else {
    shell.openPath(filePath.replace(/[\\/][^\\/]*$/, ''));
  }
}

/* 正在进行的任务，和最近结束的几个 */
function Tasks(props: {}): ReactElement {
  const tasks: Array<QueueTask> = useQueueTasks();
  const running: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status === 'running');
  const recent: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status !== 'running').slice(0, 3);

  if (tasks.length === 0) return <div className="home-empty">还没有下载或录制的任务。</div>;

  return (
    <Fragment>
      {
        running.slice(0, 3).map((task: QueueTask): ReactElement => (
          <div key={ task.id } className="home-task">
            <Tag className="mr-0 shrink-0">{ task.kind }</Tag>
            <Typography.Text className="grow" ellipsis={ true }>{ task.title }</Typography.Text>
            {
              task.percent !== undefined
                ? <Progress className="home-task-progress" percent={ Number(task.percent.toFixed(1)) } size="small" status="active" />
                : <Typography.Text type="secondary">{ task.detail }</Typography.Text>
            }
          </div>
        ))
      }
      {
        recent.map((task: QueueTask): ReactElement => (
          <div key={ task.id } className="home-task is-finished">
            <Tag className="mr-0 shrink-0">{ task.kind }</Tag>
            <Typography.Text className="grow" ellipsis={ true }>{ task.title }</Typography.Text>
            <Typography.Text type={ task.status === 'error' ? 'danger' : 'secondary' }>
              { task.status === 'done' ? '已完成' : (task.status === 'error' ? '失败' : '已停止') }
            </Typography.Text>
            { task.filePath ? <Button type="link" size="small" onClick={ (): void => showInFolder(task.filePath!) }>打开文件夹</Button> : null }
          </div>
        ))
      }
      <Button className="mt-[4px] px-0" type="link" size="small" onClick={ (): void => setQueueOpen(true) }>
        { running.length > 3 ? `查看全部 ${ running.length } 个进行中的任务` : '打开下载队列' }
      </Button>
    </Fragment>
  );
}

function HomeDashboard(props: {}): ReactElement {
  return (
    <div className="home">
      <header className="home-header">
        <h1>48tools</h1>
        <Tag bordered={ false }>{ document.title.replace(/^48tools\s*-\s*/, '') }</Tag>
      </header>

      <section>
        <h2>常用</h2>
        <div className="home-featured">
          { featured.map((item: ShellNavItem): ReactElement => <FeaturedCard key={ item.key } item={ item } />) }
        </div>
      </section>

      <section>
        <h2>关注的成员</h2>
        <FollowedMembers />
      </section>

      <section>
        <h2>正在直播</h2>
        <LiveNow />
      </section>

      <section>
        <h2>下载和录制</h2>
        <Tasks />
      </section>

      <section>
        <h2>设置</h2>
        <Space wrap={ true }>
          <ButtonLink linkProps={{ to: '/Settings' }} buttonProps={{ icon: <IconSettingOutlined /> }}>打开设置</ButtonLink>
          <Pocket48ProxyOption />
          <Button id="help-doc"
            icon={ <IconFileSyncOutlined /> }
            onClick={ (): void => safeOpenExternal('https://yzb1g5r02h.feishu.cn/docx/MxfydWlNaovZ5sxsbJ5crnAlnVb') }
          >
            使用手册
          </Button>
        </Space>
        <p className="home-empty mt-[8px]">其他平台的功能（B站、抖音、微博等）在左边的侧边栏里，也可以按 Ctrl+K 搜索。</p>
      </section>

      <section>
        <Collapse ghost={ true }
          items={ [{
            key: 'about',
            label: '关于原版 48tools 与赞助作者',
            children: (
              <div className="home-about">
                <p>
                  48tools 是段昊辰开发的免费软件，
                  <b>使用及传播均不收取任何费用</b>
                  。原版的最新版本在
                  <Button type="link"
                    size="small"
                    onClick={ (): void => safeOpenExternal('https://github.com/duan602728596/48tools/releases') }
                  >
                    https://github.com/duan602728596/48tools/releases
                  </Button>
                  下载。这个窗口是在原版基础上修改的自定义版本。如果你想要赞助原作者，请扫码打赏。
                </p>
                <Space size={ 8 }>
                  <Image className="cursor-pointer !w-[160px]" src={ imageUrlZfbAvif } />
                  <Image className="cursor-pointer !w-[160px]" src={ imageUrlWxAvif } />
                </Space>
              </div>
            )
          }] }
        />
      </section>
    </div>
  );
}

export default HomeDashboard;
