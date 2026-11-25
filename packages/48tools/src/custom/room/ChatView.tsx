import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Avatar, Button, Dropdown, Empty, Segmented, Spin, Tooltip } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  StarOutlined as IconStarOutlined,
  StarFilled as IconStarFilled,
  ReloadOutlined as IconReloadOutlined,
  MoreOutlined as IconMoreOutlined,
  SearchOutlined as IconSearchOutlined,
  ArrowUpOutlined as IconArrowUpOutlined,
  ArrowDownOutlined as IconArrowDownOutlined
} from '@ant-design/icons';
import type { CustomMessageV2 } from '@48tools-api/48';
import MessageBubble from './MessageBubble';
import PresenceDot from './PresenceDot';
import RoomSearch from './RoomSearch';
import { useChatScroll, type ChatScroll } from './useChatScroll';
import { exportRoom, downloadRoomBackground } from './roomExport';
import { roomClock, type RoomClock } from './roomTime';
import { useMemberDirectory, teamOf, type DirectoryState } from './memberDirectory';
import { teamLabel } from './memberSearch';
import { useTimeZone } from '../time/appTime';
import {
  usePresenceState,
  loadPresenceHistory,
  mergeChatTimeline,
  presenceLabel,
  presenceReason,
  type ChatTimelineItem,
  type MemberPresence,
  type PresenceEvent,
  type PresenceState
} from './presenceStore';
import {
  loadOlder,
  loadBackTo,
  syncNewest,
  resetRoomCache,
  setMode,
  toggleFollow,
  keyOf,
  type RoomMember,
  type RoomData,
  type RoomMessageItem,
  type RoomStream
} from './roomStore';

/**
 * 房间页面右边：一个房间的消息（从 RoomPage 里拆出来的）。
 * 标题栏：成员（名字后面是队伍）、「只看成员 / 全部消息」、关注、查找、刷新、更多（导出、背景图、清除缓存）。
 * 消息列表的滚动（只画一段、保持阅读位置、跳到某一条）在 ./useChatScroll；导出在 ./roomExport；查找面板是 ./RoomSearch。
 * 列表上面浮着两个按钮：右上「N 条新消息」（跳到「以下是新消息」那条线），右下「回到底部」。
 * 换房间、切换「只看成员 / 全部消息」时这个组件会整个重新挂载（RoomPage 里给了 key），所以滚动位置等都从头开始。
 */
const REFRESH_INTERVAL: number = 60_000;
const modeOptions: Array<{ label: string; value: RoomStream }> = [
  { label: '只看成员', value: 'owner' },
  { label: '全部消息', value: 'all' }
];

interface ChatViewProps {
  member: RoomMember;
  room: RoomData;   // 现在看的这一路消息
  mode: RoomStream; // 只看成员 / 全部消息
  followed: boolean;
  divider?: number; // 「以下是新消息」画在这个时间之后的第一条上面
}

function ChatView(props: ChatViewProps): ReactElement {
  const { member, room, mode, followed, divider }: ChatViewProps = props;
  const { message: messageApi, modal: modalApi }: useAppProps = App.useApp();
  const directory: DirectoryState = useMemberDirectory();
  const presence: PresenceState = usePresenceState();
  const zone: string = useTimeZone();
  const allItems: Array<RoomMessageItem> = room.items;
  const memberPresence: MemberPresence | undefined = presence.byOwner[member.ownerId];
  const memberEvents: Array<PresenceEvent> | undefined = presence.events[member.ownerId];
  // 标题里显示当前状态（在线 / 离线 / 状态未知）：配置了在线状态服务，而且是关注的成员（或者已经有她的状态）
  const showPresence: boolean = presence.service.configured && (followed || memberPresence !== undefined);
  const reachedStart: boolean = room.opened && !room.hasMore && !room.cacheMore;
  const timelineItems: Array<ChatTimelineItem> = useMemo(
    (): Array<ChatTimelineItem> => mergeChatTimeline(allItems, memberEvents ?? [], reachedStart),
    [allItems, memberEvents, reachedStart]
  );
  const newestMessageKey: string | undefined = allItems[allItems.length - 1]?.key;
  const chat: ChatScroll<ChatTimelineItem> = useChatScroll<ChatTimelineItem>({
    allItems: timelineItems,
    newestMessageKey,
    ready: room.opened,
    canLoadOlder: Boolean(room.cacheMore || room.hasMore) && !room.loading && !room.error,
    onLoadOlder(): void {
      loadOlder(member, mode);
    }
  });
  const { items }: ChatScroll<ChatTimelineItem> = chat;
  const [searchOpen, setSearchOpen]: [boolean, D<S<boolean>>] = useState(false);
  const [target, setTarget]: [string | undefined, D<S<string | undefined>>] = useState<string | undefined>(undefined); // 等着跳过去的那一条
  const memberTeam: { label: string; title: string } | undefined = teamOf(directory, member.ownerId);

  // 进入房间时读取本机缓存的上下线记录（只读一次，不影响未读数）
  useEffect(function(): void {
    void loadPresenceHistory(member.ownerId);
  }, [member.ownerId]);

  // 「以下是新消息」画在哪条真实消息上面：进入房间时没看过的第一条（上下线记录不算消息，不挂分隔线）
  const dividerMsgIndex: number = divider === undefined
    ? -1
    : allItems.findIndex((item: RoomMessageItem): boolean => item.raw.msgTime > divider);
  const dividerKey: string | undefined = dividerMsgIndex > 0 ? allItems[dividerMsgIndex].key : undefined;
  const dividerTimelineIndex: number = dividerKey === undefined
    ? -1
    : timelineItems.findIndex((entry: ChatTimelineItem): boolean => entry.key === dividerKey);
  const newCount: number = dividerMsgIndex > 0 ? allItems.length - dividerMsgIndex : 0;

  // 「N 条新消息」按钮：分隔线在屏幕上方（或者在还没画出来的更上面）时显示；点过，或者自己往上滚到看见分隔线之后就不再显示
  const dividerRef: RefObject<HTMLDivElement | null> = useRef(null);
  const [dividerAbove, setDividerAbove]: [boolean, D<S<boolean>>] = useState(false);
  const [seenDivider, setSeenDivider]: [number | undefined, D<S<number | undefined>>] = useState<number | undefined>(undefined);
  const showJump: boolean = dividerKey !== undefined && seenDivider !== divider && dividerAbove;

  function isDividerAbove(): boolean {
    const el: HTMLDivElement | null = chat.scrollRef.current;

    if (!el || dividerKey === undefined) return false;

    // 分隔线没画出来：看它是在画出来的这一段的上面还是下面
    if (!dividerRef.current) return dividerTimelineIndex >= 0 && dividerTimelineIndex < chat.start;

    return dividerRef.current.getBoundingClientRect().top < el.getBoundingClientRect().top;
  }

  function updateDividerAbove(): void {
    const next: boolean = isDividerAbove();

    setDividerAbove((prev: boolean): boolean => (prev === next ? prev : next));
  }

  function handleScroll(): void {
    // 自己往上滚到看见分隔线了：「N 条新消息」按钮不用再出现
    if (chat.onScroll() === 'up' && divider !== undefined && dividerRef.current && !isDividerAbove()) setSeenDivider(divider);

    updateDividerAbove();
  }

  function handleNewClick(): void {
    if (dividerKey === undefined) return;

    setSeenDivider(divider);
    chat.jumpTo(dividerKey, 'start');
  }

  /* 从查找面板跳到一条消息：先把那里到现在的消息都读进来，再滚过去 */
  async function handleJump(raw: CustomMessageV2): Promise<void> {
    const loaded: boolean = await loadBackTo(member, mode, raw.msgTime);

    if (!loaded) {
      messageApi.warning('这条消息现在读不出来，稍后再试');

      return;
    }

    setTarget(keyOf(raw));
  }

  // 要跳的那一条已经在列表里了：跳过去
  useEffect(function(): void {
    if (target === undefined || !allItems.some((item: RoomMessageItem): boolean => item.key === target)) return;

    chat.jumpTo(target, 'center');
    setTarget(undefined);
  }, [target, allItems]);

  // 消息或分隔线变化后，重新看一下分隔线是不是在屏幕上方
  useLayoutEffect(updateDividerAbove, [items, dividerKey]);

  function refreshBoth(): void {
    syncNewest(member, 'owner');
    syncNewest(member, 'all');
  }

  // 房间打开时每分钟取一次最新消息（两路都取：没在看的那一路也顺便存进本地缓存）
  useEffect(function(): () => void {
    const timer: number = window.setInterval(refreshBoth, REFRESH_INTERVAL);

    return (): void => window.clearInterval(timer);
  }, [member.ownerId]);

  function handleResetClick(): void {
    modalApi.confirm({
      title: `清除 ${ member.name } 房间的本地缓存？`,
      content: '本机存下来的这个房间的消息（成员的和全部的）都会删掉，然后重新从网络加载最新的一批。更早的消息要重新往上翻才会再存下来。语音转好的文字不受影响。',
      okText: '清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      centered: true,
      onOk(): void {
        chat.reset();
        resetRoomCache(member);
      }
    });
  }

  function handleMenuClick(info: { key: string }): void {
    if (info.key === 'bg') {
      downloadRoomBackground(room.channelId, messageApi);
    } else if (info.key === 'reset') {
      handleResetClick();
    } else {
      exportRoom(member, mode, info.key as 'html' | 'json', messageApi);
    }
  }

  const exportName: string = mode === 'all' ? '全部消息' : '成员消息';
  let lastDay: string = '';
  let lastSender: number | undefined;
  let lastTime: number = 0;

  return (
    <section className="room-chat">
      <header className="room-chat-header">
        <PresenceDot visible={ showPresence }
          presence={ memberPresence }
          size="sm"
        >
          <Avatar size={ 36 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
        </PresenceDot>
        <div className="room-chat-title">
          <b>
            <span>{ member.name }</span>
            { memberTeam ? <span className="room-team" title={ memberTeam.title }>{ memberTeam.label }</span> : null }
          </b>
          <small>
            {
              showPresence ? (
                <span className={ `room-chat-status is-${ memberPresence?.status ?? 'unknown' }` }
                  title={ presenceReason(memberPresence, presence.service, presence.unresolved[member.ownerId]) }
                >
                  { presenceLabel(memberPresence, zone, presence.service) }
                </span>
              ) : null
            }
            { showPresence ? ' · ' : null }
            已加载 { allItems.length } 条
            { room.fromCache ? ' · 含本地缓存' : '' }
            { room.syncing ? ' · 正在取新消息…' : '' }
            { room.opened && !room.hasMore && !room.cacheMore ? ' · 已经是最早的消息' : '' }
          </small>
        </div>
        <Segmented options={ modeOptions } value={ mode } onChange={ setMode } />
        <Tooltip title={ followed ? '已关注（点一下取消）' : '关注（加到左边的关注列表）' } placement="bottom">
          <Button className={ followed ? 'room-follow is-on' : 'room-follow' }
            icon={ followed ? <IconStarFilled /> : <IconStarOutlined /> }
            aria-label={ followed ? '取消关注' : '关注' }
            onClick={ (): void => toggleFollow(member) }
          />
        </Tooltip>
        <Tooltip title="查找：搜索消息，或者跳到某一天" placement="bottom">
          <Button icon={ <IconSearchOutlined /> } aria-label="查找" onClick={ (): void => setSearchOpen(true) } />
        </Tooltip>
        <Tooltip title="取最新消息（每分钟也会自动取一次）" placement="bottom">
          <Button icon={ <IconReloadOutlined /> } loading={ room.loading || room.syncing } aria-label="取最新消息" onClick={ refreshBoth } />
        </Tooltip>
        <Dropdown trigger={ ['click'] }
          placement="bottomRight"
          menu={{
            items: [
              { key: 'html', label: `导出本地已有的${ exportName }（HTML）`, disabled: allItems.length === 0 },
              { key: 'json', label: `导出本地已有的${ exportName }（JSON）`, disabled: allItems.length === 0 },
              { key: 'bg', label: '下载房间背景图' },
              { type: 'divider' },
              { key: 'reset', label: '清除这个房间的本地缓存…', danger: true }
            ],
            onClick: handleMenuClick
          }}
        >
          <Button icon={ <IconMoreOutlined /> } aria-label="更多操作" />
        </Dropdown>
      </header>
      <div className="room-scroll-wrap">
        <div ref={ chat.scrollRef } className="room-scroll" onScroll={ handleScroll }>
          <div ref={ chat.contentRef } className="room-content">
            <div className="room-status">
              { room.loading && room.opened ? <Spin size="small" /> : null }
              {
                room.error ? (
                  <Fragment>
                    加载失败：{ room.error }
                    <Button type="link" size="small" onClick={ (): Promise<void> => loadOlder(member, mode) }>重试</Button>
                  </Fragment>
                ) : null
              }
              { room.opened && !room.hasMore && !room.cacheMore && !room.loading && allItems.length > 0 && chat.start === 0 ? '没有更早的消息了' : null }
            </div>
            {
              items.map((entry: ChatTimelineItem): ReactElement => {
                const clock: RoomClock = roomClock(entry.time, zone);
                const showDay: boolean = clock.day !== lastDay;

                lastDay = clock.day;

                if (entry.kind === 'presence') {
                  lastSender = undefined;
                  lastTime = entry.time;

                  const isOnline: boolean = entry.event.kind === 'online';

                  return (
                    <Fragment key={ entry.key }>
                      { showDay ? <div className="room-day"><span>{ clock.day }</span></div> : null }
                      <div className={ `room-presence-event${ isOnline ? ' is-online' : ' is-offline' }` }
                        data-key={ entry.key }
                      >
                        <span className="room-presence-event-dot" aria-hidden="true" />
                        <span>{ member.name } { isOnline ? '上线' : '下线' }</span>
                        <time title={ clock.full }>{ clock.time }</time>
                      </div>
                    </Fragment>
                  );
                }

                const item: RoomMessageItem = entry.item;
                const senderId: number | undefined = item.message.user?.userId;
                const isMember: boolean = item.message.user?.roleId === 3; // 成员（房主，或者来串门的别的成员）；其他的是粉丝
                // 每条消息左边都有头像；只有同一个人在 2 分钟内连着发的几条，才省略后面几条的头像
                const showAvatar: boolean = showDay || senderId !== lastSender || item.raw.msgTime - lastTime > 120_000;

                lastSender = senderId;
                lastTime = item.raw.msgTime;

                return (
                  <Fragment key={ item.key }>
                    { showDay ? <div className="room-day"><span>{ clock.day }</span></div> : null }
                    { item.key === dividerKey ? <div ref={ dividerRef } className="room-new"><span>以下是新消息</span></div> : null }
                    <MessageBubble item={ item }
                      time={ clock.time }
                      fullTime={ clock.full }
                      ownerId={ member.ownerId }
                      team={ isMember ? (teamLabel(directory.byId[Number(senderId)]?.team) || undefined) : undefined }
                      flash={ item.key === chat.flashKey }
                      showAvatar={ showAvatar }
                      sender={ isMember ? (Number(senderId) === member.ownerId ? 'owner' : 'guest') : 'fan' }
                      highlight={ mode === 'all' && isMember }
                    />
                  </Fragment>
                );
              })
            }
            { !room.opened && room.loading ? <div className="room-center"><Spin /></div> : null }
            {
              room.opened && timelineItems.length === 0 && !room.loading && !room.error
                ? <Empty className="pt-[60px]" description="这个房间还没有消息" />
                : null
            }
          </div>
        </div>
        {
          showJump ? (
            <button className="room-jump" type="button" onClick={ handleNewClick }>
              <IconArrowUpOutlined />
              { newCount } 条新消息
            </button>
          ) : null
        }
        {
          chat.away ? (
            <button className={ `room-jump is-bottom${ chat.newBelow ? ' is-new' : '' }` } type="button" onClick={ chat.toBottom }>
              <IconArrowDownOutlined />
              { chat.newBelow ? '有新消息' : '回到底部' }
            </button>
          ) : null
        }
      </div>
      <RoomSearch open={ searchOpen }
        member={ member }
        mode={ mode }
        zone={ zone }
        onJump={ handleJump }
        onClose={ (): void => setSearchOpen(false) }
      />
    </section>
  );
}

export default ChatView;
