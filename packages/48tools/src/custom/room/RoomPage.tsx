import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import type { SaveDialogReturnValue } from 'electron';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type ChangeEvent,
  type Dispatch as D,
  type SetStateAction as S
} from 'react';
import { useSelector } from 'react-redux';
import { App, Avatar, Badge, Button, Dropdown, Empty, Input, Segmented, Spin, Tooltip } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  SearchOutlined as IconSearchOutlined,
  StarOutlined as IconStarOutlined,
  StarFilled as IconStarFilled,
  ReloadOutlined as IconReloadOutlined,
  MoreOutlined as IconMoreOutlined,
  MessageOutlined as IconMessageOutlined,
  ArrowUpOutlined as IconArrowUpOutlined
} from '@ant-design/icons';
import * as dayjs from 'dayjs';
import { requestRoomInfo, requestDownloadFileByStream, type RoomInfo } from '@48tools-api/48';
import './room.global.sass';
import Pocket48Login from '../../functionalComponents/Pocket48Login/Pocket48Login';
import { formatSendData } from '../../pages/48/RoomMessage/utils/formatData';
import createHtml from '../../pages/48/RoomMessage/utils/createHtml';
import { showSaveDialog } from '../../utils/remote/dialog';
import { getFilePath } from '../../utils/utils';
import { source } from '../../utils/snh48';
import type { SendDataItem } from '../../pages/48/types';
import MessageBubble from './MessageBubble';
import {
  useRoomState,
  openRoom,
  loadOlder,
  syncNewest,
  resetRoomCache,
  setMode,
  readAllCached,
  searchMembers,
  toggleFollow,
  getLastRoom,
  type RoomState,
  type RoomMember,
  type RoomData,
  type RoomMessageItem,
  type RoomStream
} from './roomStore';
import { useUnreadState, setViewing, settleViewing, type UnreadState } from './unreadStore';

/**
 * 口袋房间消息的新页面（聊天软件的样子）：
 *   - 左边：搜索成员（结果带头像），关注列表。点成员进入房间，点星标关注 / 取消关注
 *   - 右边：这个成员在房间里发的消息，最新的在最下面；往上滚动会自动加载更早的消息，不用再反复点「加载数据」
 *   - 房间打开时每分钟自动取一次最新消息；「更多」里可以导出 HTML / JSON、下载房间背景图（沿用原版的导出代码）
 *   - 取到的消息存在本机（./roomCache）：下次打开先显示本地的，再补上新发的。本地消息很多时只先画最近的一部分，
 *     往上滚动再逐步画出更早的，画完本地的才去网络取
 *   - 关注的成员有新消息时，头像上有一个带数字的气泡（./unreadStore、./unreadWatcher）；点进房间后清零，
 *     房间里用一条「以下是新消息」的线标出从哪里开始是没看过的；这条线不在屏幕里（在上面）时，
 *     右上角有一个「N 条新消息」的按钮，点一下跳到第一条新消息
 *   - 标题栏上可以切换「只看成员 / 全部消息」。全部消息包括粉丝发的（名字显示在消息上面），这时成员的消息用主题色标出来。
 *     不管看的是哪一种，进入房间时两种都会取并存到本机
 * 数据和接口说明见 ./roomStore。原版页面（pages/48/RoomMessage）保留不动。
 * 接入点：pages/48/Index.tsx 的 RoomMessage 路由。
 */
const EXPORT_PAGE_SIZE: number = 1_000; // 导出 html 时每个文件多少条
const emptyRoomData: RoomData = { items: [], nextTime: 0, hasMore: true, loading: true, opened: false };

function hasMember(list: Array<RoomMember>, ownerId: number): boolean {
  return list.some((member: RoomMember): boolean => member.ownerId === ownerId);
}
const REFRESH_INTERVAL: number = 60_000;
const RENDER_FIRST: number = 150; // 打开房间时先画最近的多少条
const RENDER_STEP: number = 150;  // 往上滚动时每次多画多少条
const modeOptions: Array<{ label: string; value: RoomStream }> = [
  { label: '只看成员', value: 'owner' },
  { label: '全部消息', value: 'all' }
];

interface MemberRowProps {
  member: RoomMember;
  active: boolean;
  followed: boolean;
  unread: number; // 未读消息数，0 就不显示气泡
  onOpen: () => void;
}

function MemberRow(props: MemberRowProps): ReactElement {
  const { member, active, followed, unread, onOpen }: MemberRowProps = props;

  return (
    <div className={ `room-member${ active ? ' is-active' : '' }` }
      role="button"
      tabIndex={ 0 }
      onClick={ onOpen }
      onKeyDown={ (event: { key: string }): void => {
        event.key === 'Enter' && onOpen();
      } }
    >
      <Badge className="room-unread" count={ unread } overflowCount={ 99 } size="small" offset={ [-3, 3] } title={ `${ unread } 条未读消息` }>
        <Avatar size={ 36 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
      </Badge>
      <span className="room-member-name">{ member.name }</span>
      <Tooltip title={ followed ? '取消关注' : '关注（加到下面的列表里）' } mouseEnterDelay={ 0.4 }>
        <button className={ `room-star${ followed ? ' is-on' : '' }` }
          type="button"
          aria-label={ followed ? '取消关注' : '关注' }
          onClick={ (event: { stopPropagation: () => void }): void => {
            event.stopPropagation();
            toggleFollow(member);
          } }
        >
          { followed ? <IconStarFilled /> : <IconStarOutlined /> }
        </button>
      </Tooltip>
    </div>
  );
}

/* 左边：搜索 + 关注列表 */
function MemberPanel(props: { state: RoomState; counts: UnreadState['counts']; loggedIn: boolean }): ReactElement {
  const { state, counts, loggedIn }: { state: RoomState; counts: UnreadState['counts']; loggedIn: boolean } = props;
  const [keyword, setKeyword]: [string, D<S<string>>] = useState('');
  const [results, setResults]: [Array<RoomMember> | null, D<S<Array<RoomMember> | null>>] = useState(null);
  const [searching, setSearching]: [boolean, D<S<boolean>>] = useState(false);
  const [error, setError]: [string, D<S<string>>] = useState('');
  const searchId: RefObject<number> = useRef(0);

  // 输入停下 0.5 秒后搜索（接口只支持中文名字）
  useEffect(function(): (() => void) | void {
    const text: string = keyword.trim();

    setError('');

    if (text === '') {
      setResults(null);
      setSearching(false);

      return;
    }

    if (!/[一-鿿]/.test(text)) {
      setResults([]);
      setError('请输入成员的中文名字');

      return;
    }

    const id: number = ++searchId.current;
    const timer: number = window.setTimeout(async (): Promise<void> => {
      setSearching(true);

      try {
        const members: Array<RoomMember> = await searchMembers(text);

        if (id === searchId.current) setResults(members);
      } catch (err) {
        if (id === searchId.current) {
          setResults([]);
          setError(err instanceof Error ? err.message : '搜索失败');
        }
      }

      if (id === searchId.current) setSearching(false);
    }, 500);

    return (): void => window.clearTimeout(timer);
  }, [keyword]);

  const list: Array<RoomMember> = results ?? state.follows;

  return (
    <aside className="room-side">
      <Input className="room-search"
        allowClear={ true }
        placeholder="搜索成员"
        prefix={ <IconSearchOutlined /> }
        value={ keyword }
        disabled={ !loggedIn }
        onChange={ (event: ChangeEvent<HTMLInputElement>): void => setKeyword(event.target.value) }
      />
      <div className="room-side-title">
        { results ? '搜索结果' : '关注' }
        { searching ? <Spin size="small" /> : null }
      </div>
      <div className="room-side-list">
        {
          list.map((member: RoomMember): ReactElement => (
            <MemberRow key={ member.ownerId }
              member={ member }
              active={ state.current?.ownerId === member.ownerId }
              followed={ hasMember(state.follows, member.ownerId) }
              unread={ hasMember(state.follows, member.ownerId) ? (counts[member.ownerId] ?? 0) : 0 }
              onOpen={ (): void => {
                openRoom(member);
              } }
            />
          ))
        }
        {
          list.length === 0 && !searching ? (
            <p className="room-side-empty">
              { error || (results ? '没有找到这个成员' : '还没有关注的成员。在上面搜索成员，点名字旁边的星标就能加到这里。') }
            </p>
          ) : null
        }
      </div>
    </aside>
  );
}

/* 右边：一个房间的消息 */
interface ChatViewProps {
  member: RoomMember;
  room: RoomData;   // 现在看的这一路消息
  mode: RoomStream; // 只看成员 / 全部消息
  followed: boolean;
  divider?: number;
}

/* 换房间、切换「只看成员 / 全部消息」时这个组件会整个重新挂载（RoomPage 里给了 key），所以里面的滚动位置等都从头开始 */
function ChatView(props: ChatViewProps): ReactElement {
  const { member, room, mode, followed, divider }: ChatViewProps = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const scrollRef: RefObject<HTMLDivElement | null> = useRef(null);
  const contentRef: RefObject<HTMLDivElement | null> = useRef(null);
  const position: RefObject<{ ownerId: number; firstKey?: string; lastKey?: string; height: number; top: number; atBottom: boolean }>
    = useRef({ ownerId: 0, height: 0, top: 0, atBottom: true });
  const [renderCount, setRenderCount]: [number, D<S<number>>] = useState(RENDER_FIRST);
  const allItems: Array<RoomMessageItem> = room.items;
  const items: Array<RoomMessageItem> = allItems.length > renderCount ? allItems.slice(allItems.length - renderCount) : allItems;

  // 「以下是新消息」画在哪条消息上面：进入房间时没看过的第一条。它前面要有已经看过的消息才画，
  // 不然更早的消息加载出来时这条线会跟着跳
  const dividerIndex: number = divider === undefined
    ? -1
    : allItems.findIndex((item: RoomMessageItem): boolean => item.raw.msgTime > divider);
  const dividerKey: string | undefined = dividerIndex > 0 ? allItems[dividerIndex].key : undefined;
  const newCount: number = dividerIndex > 0 ? allItems.length - dividerIndex : 0;

  // 「N 条新消息」按钮：分隔线在屏幕上方（或者还没画出来）时显示；点过，或者自己往上滚到看见分隔线之后就不再显示
  const dividerRef: RefObject<HTMLDivElement | null> = useRef(null);
  const [dividerAbove, setDividerAbove]: [boolean, D<S<boolean>>] = useState(false);
  const [seenDivider, setSeenDivider]: [number | undefined, D<S<number | undefined>>] = useState(undefined);
  const [jumpPending, setJumpPending]: [boolean, D<S<boolean>>] = useState(false);
  const showJump: boolean = dividerKey !== undefined && seenDivider !== divider && dividerAbove;

  function isDividerAbove(): boolean {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el || dividerKey === undefined) return false;

    // 分隔线还没画出来：它在已经画出来的消息更上面
    if (!dividerRef.current) return true;

    return dividerRef.current.getBoundingClientRect().top < el.getBoundingClientRect().top;
  }

  function updateDividerAbove(): void {
    const next: boolean = isDividerAbove();

    setDividerAbove((prev: boolean): boolean => (prev === next ? prev : next));
  }

  function scrollToDivider(smooth: boolean): void {
    const el: HTMLDivElement | null = scrollRef.current;
    const line: HTMLDivElement | null = dividerRef.current;

    if (!el || !line) return;

    el.scrollTo({
      top: el.scrollTop + line.getBoundingClientRect().top - el.getBoundingClientRect().top - 12,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }

  function handleJumpClick(): void {
    if (dividerIndex <= 0) return;

    position.current.atBottom = false;
    setSeenDivider(divider);

    if (dividerRef.current) {
      scrollToDivider(true);
    } else {
      // 第一条新消息还没画出来：先画到那里，画好后再跳（见下面的 useLayoutEffect）
      setRenderCount(allItems.length - dividerIndex + 10);
      setJumpPending(true);
    }
  }

  /* 滚动到靠近顶部时：本地还有没画出来的就先画出来，都画完了再去取更早的一批 */
  function loadOlderIfNeeded(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el || !room.opened || el.scrollTop >= 400) return;

    if (allItems.length > renderCount) {
      setRenderCount((prev: number): number => prev + RENDER_STEP);
    } else if ((room.cacheMore || room.hasMore) && !room.loading && !room.error) {
      loadOlder(member, mode);
    }
  }

  function handleScroll(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el) return;

    // 只有用户自己往上滚，才算离开了底部。图片加载把内容撑高时也会触发滚动事件，这时位置没有往上走，
    // 不能当成离开底部，否则就不会再自动贴到底部了
    if (el.scrollTop < position.current.top - 4) {
      position.current.atBottom = false;

      // 自己往上滚到看见分隔线了：「N 条新消息」按钮不用再出现
      if (divider !== undefined && dividerRef.current && !isDividerAbove()) setSeenDivider(divider);
    } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
      position.current.atBottom = true;
    }

    position.current.top = el.scrollTop;
    updateDividerAbove();
    loadOlderIfNeeded();
  }

  // 消息变化后保持阅读位置：换房间 / 第一次加载滚到底；上面加了更早的消息时不跳动；在底部时来了新消息跟着滚到底
  useLayoutEffect(function(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el) return;

    const prev: typeof position.current = position.current;
    const firstKey: string | undefined = items[0]?.key;
    const lastKey: string | undefined = items[items.length - 1]?.key;

    if (prev.ownerId !== member.ownerId || prev.firstKey === undefined) {
      el.scrollTop = el.scrollHeight;
    } else if (firstKey !== prev.firstKey) {
      el.scrollTop = prev.top + (el.scrollHeight - prev.height);
    } else if (lastKey !== prev.lastKey && prev.atBottom) {
      el.scrollTop = el.scrollHeight;
    }

    position.current = {
      ownerId: member.ownerId,
      firstKey,
      lastKey,
      height: el.scrollHeight,
      top: el.scrollTop,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 60
    };
  }, [items, member.ownerId]);

  // 第一条新消息画出来之后跳过去
  useLayoutEffect(function(): void {
    if (!jumpPending || !dividerRef.current) return;

    scrollToDivider(false);
    position.current.atBottom = false; // 上面那个保持位置的 effect 刚把它算成「在底部」，跳走之后不是了
    setJumpPending(false);
  }, [jumpPending, items]);

  // 消息或分隔线变化后，重新看一下分隔线是不是在屏幕上方
  useLayoutEffect(updateDividerAbove, [items, dividerKey, member.ownerId]);

  // 内容不满一屏，或者刚好停在顶部时，继续取更早的消息
  useEffect(loadOlderIfNeeded, [items.length, allItems.length, room.loading, room.opened, member.ownerId]);

  // 换房间时重新从最近的一部分开始画
  useEffect(function(): void {
    setRenderCount(RENDER_FIRST);
  }, [member.ownerId]);

  // 图片加载完会把内容撑高：在底部时保持在底部
  useEffect(function(): () => void {
    const observer: ResizeObserver = new ResizeObserver((): void => {
      const el: HTMLDivElement | null = scrollRef.current;

      if (!el) return;

      if (position.current.atBottom) el.scrollTop = el.scrollHeight;

      position.current.height = el.scrollHeight;
      position.current.top = el.scrollTop;
      updateDividerAbove(); // 图片把新消息撑高后，分隔线可能被顶到屏幕上方
    });

    contentRef.current && observer.observe(contentRef.current);

    return (): void => observer.disconnect();
  }, [member.ownerId, dividerKey]);

  function refreshBoth(): void {
    syncNewest(member, 'owner');
    syncNewest(member, 'all');
  }

  // 房间打开时每分钟取一次最新消息（两路都取：没在看的那一路也顺便存进本地缓存）
  useEffect(function(): () => void {
    const timer: number = window.setInterval(refreshBoth, REFRESH_INTERVAL);

    return (): void => window.clearInterval(timer);
  }, [member.ownerId]);

  /* 导出：沿用原版的格式和生成代码。导出的是本地已有的全部消息（本地缓存 + 这次加载的），不只是画出来的这些 */
  async function handleExport(type: 'html' | 'json'): Promise<void> {
    try {
      const raw: Array<RoomMessageItem['raw']> = await readAllCached(member, mode); // 从新到旧

      const result: SaveDialogReturnValue = await showSaveDialog({
        defaultPath: getFilePath({
          typeTitle: `口袋48房间消息(${ type })`,
          infoArray: [type, member.name, member.ownerId, ...(mode === 'all' ? ['全部消息'] : [])]
        })
      });

      if (result.canceled || !result.filePath) return;

      messageApi.info('正在保存…');

      if (!fs.existsSync(result.filePath)) await fsP.mkdir(result.filePath);

      const time: string = dayjs().format('YYYY-MM-DD HH:mm:ss');
      const pageSize: number = type === 'html' ? EXPORT_PAGE_SIZE : 3_000;
      let page: number = 1;

      for (let i: number = 0; i < raw.length; i += pageSize) {
        const data: Array<SendDataItem> = formatSendData(raw.slice(i, i + pageSize), mode === 'all');

        if (type === 'html') {
          await createHtml({ data, filePath: result.filePath, page, length: raw.length, time });
        } else {
          await fsP.writeFile(path.join(result.filePath, `${ page }.json`), JSON.stringify({ message: data }, null, 2), { encoding: 'utf8' });
        }

        page++;
      }

      messageApi.success(`已导出 ${ raw.length } 条消息`);
    } catch (err) {
      console.error(err);
      messageApi.error('导出失败');
    }
  }

  async function handleDownloadBackground(): Promise<void> {
    try {
      const res: RoomInfo | undefined = room.channelId ? await requestRoomInfo(room.channelId) : undefined;
      const bgUrl: string | undefined = res?.content?.userChatConfig?.bgImg;

      if (!bgUrl) {
        messageApi.warning('没有获取到房间背景图');

        return;
      }

      const parsed: path.ParsedPath = path.parse(bgUrl);
      const result: SaveDialogReturnValue = await showSaveDialog({
        defaultPath: getFilePath({ typeTitle: '口袋48房间背景图片下载', infoArray: [parsed.name], ext: parsed.ext })
      });

      if (result.canceled || !result.filePath) return;

      await requestDownloadFileByStream(source(bgUrl), result.filePath);
      messageApi.success('背景图片下载完成');
    } catch (err) {
      console.error(err);
      messageApi.error('背景图片下载失败');
    }
  }

  let lastDay: string = '';
  let lastSender: number | undefined;
  let lastTime: number = 0;

  return (
    <section className="room-chat">
      <header className="room-chat-header">
        <Avatar size={ 36 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
        <div className="room-chat-title">
          <b>{ member.name }</b>
          <small>
            已加载 { allItems.length } 条
            { room.fromCache ? ' · 含本地缓存' : '' }
            { room.syncing ? ' · 正在取新消息…' : '' }
            { room.opened && !room.hasMore && !room.cacheMore ? ' · 已经是最早的消息' : '' }
          </small>
        </div>
        <Segmented options={ modeOptions } value={ mode } onChange={ setMode } />
        <Button type={ followed ? 'default' : 'primary' }
          icon={ followed ? <IconStarFilled /> : <IconStarOutlined /> }
          onClick={ (): void => toggleFollow(member) }
        >
          { followed ? '已关注' : '关注' }
        </Button>
        <Tooltip title="取最新消息（每分钟也会自动取一次）">
          <Button icon={ <IconReloadOutlined /> }
            loading={ room.loading || room.syncing }
            onClick={ refreshBoth }
          />
        </Tooltip>
        <Dropdown trigger={ ['click'] }
          placement="bottomRight"
          menu={{
            items: [
              { key: 'html', label: mode === 'all' ? '导出本地已有的全部消息（HTML）' : '导出本地已有的成员消息（HTML）', disabled: allItems.length === 0 },
              { key: 'json', label: mode === 'all' ? '导出本地已有的全部消息（JSON）' : '导出本地已有的成员消息（JSON）', disabled: allItems.length === 0 },
              { key: 'bg', label: '下载房间背景图' },
              { type: 'divider' },
              { key: 'reset', label: '清除这个房间的本地缓存并重新加载', danger: true }
            ],
            onClick(info: { key: string }): void {
              if (info.key === 'bg') {
                handleDownloadBackground();
              } else if (info.key === 'reset') {
                setRenderCount(RENDER_FIRST);
                resetRoomCache(member);
              } else {
                handleExport(info.key as 'html' | 'json');
              }
            }
          }}
        >
          <Button icon={ <IconMoreOutlined /> } aria-label="更多操作" />
        </Dropdown>
      </header>
      <div className="room-scroll-wrap">
        <div ref={ scrollRef } className="room-scroll" onScroll={ handleScroll }>
          <div ref={ contentRef } className="room-content">
            <div className="room-status">
              {
                room.loading && room.opened ? <Spin size="small" /> : null
              }
              {
                room.error ? (
                  <Fragment>
                    加载失败：{ room.error }
                    <Button type="link" size="small" onClick={ (): Promise<void> => loadOlder(member, mode) }>重试</Button>
                  </Fragment>
                ) : null
              }
              { room.opened && !room.hasMore && !room.cacheMore && !room.loading && allItems.length > 0 && items.length === allItems.length ? '没有更早的消息了' : null }
            </div>
            {
              items.map((item: RoomMessageItem): ReactElement => {
                const time: dayjs.Dayjs = dayjs(item.raw.msgTime);
                const day: string = time.format('YYYY年M月D日 dddd');
                const showDay: boolean = day !== lastDay;
                const senderId: number | undefined = item.message.user?.userId;
                const isMember: boolean = item.message.user?.roleId === 3; // 成员（房主，或者来串门的别的成员）；其他的是粉丝
                // 每条消息左边都有头像；只有同一个人在 2 分钟内连着发的几条，才省略后面几条的头像
                const showAvatar: boolean = showDay || senderId !== lastSender || item.raw.msgTime - lastTime > 120_000;

                lastDay = day;
                lastSender = senderId;
                lastTime = item.raw.msgTime;

                return (
                  <Fragment key={ item.key }>
                    { showDay ? <div className="room-day"><span>{ day }</span></div> : null }
                    { item.key === dividerKey ? <div ref={ dividerRef } className="room-new"><span>以下是新消息</span></div> : null }
                    <MessageBubble item={ item }
                      time={ time.format('HH:mm') }
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
              room.opened && allItems.length === 0 && !room.loading && !room.error
                ? <Empty className="pt-[60px]" description="这个房间还没有消息" />
                : null
            }
          </div>
        </div>
        {
          showJump ? (
            <button className="room-jump" type="button" onClick={ handleJumpClick }>
              <IconArrowUpOutlined />
              { newCount } 条新消息
            </button>
          ) : null
        }
      </div>
    </section>
  );
}

function RoomPage(props: {}): ReactElement {
  const state: RoomState = useRoomState();
  const unread: UnreadState = useUnreadState();

  // 登录状态来自原版的登录模块（redux），登录 / 退出后这里会跟着变
  const token: string | undefined = useSelector(
    (s: { pocket48Login?: { userInfo?: { token?: string } | null } }): string | undefined => s.pocket48Login?.userInfo?.token);
  const loggedIn: boolean = Boolean(token);

  // 进入页面时恢复上次打开的房间
  useEffect(function(): void {
    if (!loggedIn || state.current) return;

    const last: RoomMember | undefined = getLastRoom() ?? state.follows[0];

    last && openRoom(last);
  }, [loggedIn]);

  const currentId: number | undefined = loggedIn ? state.current?.ownerId : undefined;
  const ownerRoom: RoomData | undefined = currentId === undefined ? undefined : state.rooms[currentId];
  const ownerSettled: boolean = Boolean(ownerRoom?.opened && !ownerRoom.loading && !ownerRoom.syncing);

  // 告诉未读统计：现在正在看这个房间（这个房间的未读清零，看着的时候来的新消息直接算已读）
  useEffect(function(): (() => void) | void {
    if (currentId === undefined) return;

    setViewing(currentId);

    return (): void => setViewing(undefined);
  }, [currentId]);

  // 成员消息的第一批取完之后，再来的新消息就不画「以下是新消息」了
  useEffect(function(): void {
    if (currentId !== undefined && ownerSettled) settleViewing(currentId);
  }, [currentId, ownerSettled]);

  return (
    <div className="room">
      <MemberPanel state={ state } counts={ unread.counts } loggedIn={ loggedIn } />
      {
        !loggedIn ? (
          <section className="room-chat room-center">
            <Empty image={ <IconMessageOutlined className="text-[48px] opacity-40" /> }
              description="房间消息需要登录口袋48账号"
            >
              <Pocket48Login />
            </Empty>
          </section>
        ) : (
          state.current
            ? (
              <ChatView key={ state.current.ownerId + ':' + state.mode }
                member={ state.current }
                room={ (state.mode === 'all' ? state.allRooms : state.rooms)[state.current.ownerId] ?? emptyRoomData }
                mode={ state.mode }
                followed={ hasMember(state.follows, state.current.ownerId) }
                divider={ unread.dividers[state.current.ownerId] }
              />
            )
            : (
              <section className="room-chat room-center">
                <Empty image={ <IconMessageOutlined className="text-[48px] opacity-40" /> }
                  description="在左边搜索成员，或者从关注列表里选一个"
                />
              </section>
            )
        )
      }
    </div>
  );
}

export default RoomPage;
