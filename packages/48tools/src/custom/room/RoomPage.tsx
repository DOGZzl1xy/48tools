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
import { App, Avatar, Button, Dropdown, Empty, Input, Spin, Tooltip } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  SearchOutlined as IconSearchOutlined,
  StarOutlined as IconStarOutlined,
  StarFilled as IconStarFilled,
  ReloadOutlined as IconReloadOutlined,
  MoreOutlined as IconMoreOutlined,
  MessageOutlined as IconMessageOutlined
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
  loadMessages,
  searchMembers,
  toggleFollow,
  getLastRoom,
  type RoomState,
  type RoomMember,
  type RoomData,
  type RoomMessageItem
} from './roomStore';

/**
 * 口袋房间消息的新页面（聊天软件的样子）：
 *   - 左边：搜索成员（结果带头像），关注列表。点成员进入房间，点星标关注 / 取消关注
 *   - 右边：这个成员在房间里发的消息，最新的在最下面；往上滚动会自动加载更早的消息，不用再反复点「加载数据」
 *   - 房间打开时每分钟自动取一次最新消息；「更多」里可以导出 HTML / JSON、下载房间背景图（沿用原版的导出代码）
 * 数据和接口说明见 ./roomStore。原版页面（pages/48/RoomMessage）保留不动。
 * 接入点：pages/48/Index.tsx 的 RoomMessage 路由。
 */
const EXPORT_PAGE_SIZE: number = 1_000; // 导出 html 时每个文件多少条
const emptyRoomData: RoomData = { items: [], nextTime: 0, hasMore: true, loading: true, opened: false };

function hasMember(list: Array<RoomMember>, ownerId: number): boolean {
  return list.some((member: RoomMember): boolean => member.ownerId === ownerId);
}
const REFRESH_INTERVAL: number = 60_000;

interface MemberRowProps {
  member: RoomMember;
  active: boolean;
  followed: boolean;
  onOpen: () => void;
}

function MemberRow(props: MemberRowProps): ReactElement {
  const { member, active, followed, onOpen }: MemberRowProps = props;

  return (
    <div className={ `room-member${ active ? ' is-active' : '' }` }
      role="button"
      tabIndex={ 0 }
      onClick={ onOpen }
      onKeyDown={ (event: { key: string }): void => {
        event.key === 'Enter' && onOpen();
      } }
    >
      <Avatar size={ 36 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
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
function MemberPanel(props: { state: RoomState; loggedIn: boolean }): ReactElement {
  const { state, loggedIn }: { state: RoomState; loggedIn: boolean } = props;
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
              onOpen={ (): void => openRoom(member) }
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
function ChatView(props: { member: RoomMember; room: RoomData; followed: boolean }): ReactElement {
  const { member, room, followed }: { member: RoomMember; room: RoomData; followed: boolean } = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const scrollRef: RefObject<HTMLDivElement | null> = useRef(null);
  const contentRef: RefObject<HTMLDivElement | null> = useRef(null);
  const position: RefObject<{ ownerId: number; firstKey?: string; lastKey?: string; height: number; top: number; atBottom: boolean }>
    = useRef({ ownerId: 0, height: 0, top: 0, atBottom: true });
  const { items }: RoomData = room;

  /* 滚动到靠近顶部时，自动取更早的一批 */
  function loadOlderIfNeeded(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (el && room.opened && room.hasMore && !room.loading && !room.error && el.scrollTop < 400) {
      loadMessages(member, 'older');
    }
  }

  function handleScroll(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el) return;

    position.current.top = el.scrollTop;
    position.current.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
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

  // 内容不满一屏，或者刚好停在顶部时，继续取更早的消息
  useEffect(loadOlderIfNeeded, [items.length, room.loading, room.opened, member.ownerId]);

  // 图片加载完会把内容撑高：在底部时保持在底部
  useEffect(function(): () => void {
    const observer: ResizeObserver = new ResizeObserver((): void => {
      const el: HTMLDivElement | null = scrollRef.current;

      if (!el) return;

      if (position.current.atBottom) el.scrollTop = el.scrollHeight;

      position.current.height = el.scrollHeight;
      position.current.top = el.scrollTop;
    });

    contentRef.current && observer.observe(contentRef.current);

    return (): void => observer.disconnect();
  }, [member.ownerId]);

  // 房间打开时每分钟取一次最新消息
  useEffect(function(): () => void {
    const timer: number = window.setInterval((): void => {
      loadMessages(member, 'newest');
    }, REFRESH_INTERVAL);

    return (): void => window.clearInterval(timer);
  }, [member.ownerId]);

  /* 导出：沿用原版的格式和生成代码 */
  async function handleExport(type: 'html' | 'json'): Promise<void> {
    const raw: Array<RoomMessageItem['raw']> = items.map((item: RoomMessageItem): RoomMessageItem['raw'] => item.raw).reverse(); // 从新到旧

    try {
      const result: SaveDialogReturnValue = await showSaveDialog({
        defaultPath: getFilePath({
          typeTitle: `口袋48房间消息(${ type })`,
          infoArray: [type, member.name, member.ownerId]
        })
      });

      if (result.canceled || !result.filePath) return;

      messageApi.info('正在保存…');

      if (!fs.existsSync(result.filePath)) await fsP.mkdir(result.filePath);

      const time: string = dayjs().format('YYYY-MM-DD HH:mm:ss');
      const pageSize: number = type === 'html' ? EXPORT_PAGE_SIZE : 3_000;
      let page: number = 1;

      for (let i: number = 0; i < raw.length; i += pageSize) {
        const data: Array<SendDataItem> = formatSendData(raw.slice(i, i + pageSize));

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

  return (
    <section className="room-chat">
      <header className="room-chat-header">
        <Avatar size={ 36 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
        <div className="room-chat-title">
          <b>{ member.name }</b>
          <small>
            已加载 { items.length } 条
            { room.opened && !room.hasMore ? ' · 已经是最早的消息' : '' }
          </small>
        </div>
        <Button type={ followed ? 'default' : 'primary' }
          icon={ followed ? <IconStarFilled /> : <IconStarOutlined /> }
          onClick={ (): void => toggleFollow(member) }
        >
          { followed ? '已关注' : '关注' }
        </Button>
        <Tooltip title="取最新消息（每分钟也会自动取一次）">
          <Button icon={ <IconReloadOutlined /> } loading={ room.loading } onClick={ (): Promise<void> => loadMessages(member, 'newest') } />
        </Tooltip>
        <Dropdown trigger={ ['click'] }
          placement="bottomRight"
          menu={{
            items: [
              { key: 'html', label: '导出已加载的消息（HTML）', disabled: items.length === 0 },
              { key: 'json', label: '导出已加载的消息（JSON）', disabled: items.length === 0 },
              { key: 'bg', label: '下载房间背景图' }
            ],
            onClick(info: { key: string }): void {
              info.key === 'bg' ? handleDownloadBackground() : handleExport(info.key as 'html' | 'json');
            }
          }}
        >
          <Button icon={ <IconMoreOutlined /> } aria-label="更多操作" />
        </Dropdown>
      </header>
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
                  <Button type="link" size="small" onClick={ (): Promise<void> => loadMessages(member, 'older') }>重试</Button>
                </Fragment>
              ) : null
            }
            { room.opened && !room.hasMore && !room.loading && items.length > 0 ? '没有更早的消息了' : null }
          </div>
          {
            items.map((item: RoomMessageItem): ReactElement => {
              const time: dayjs.Dayjs = dayjs(item.raw.msgTime);
              const day: string = time.format('YYYY年M月D日 dddd');
              const showDay: boolean = day !== lastDay;

              lastDay = day;

              return (
                <Fragment key={ item.key }>
                  { showDay ? <div className="room-day"><span>{ day }</span></div> : null }
                  <MessageBubble item={ item } time={ time.format('HH:mm') } />
                </Fragment>
              );
            })
          }
          { !room.opened && room.loading ? <div className="room-center"><Spin /></div> : null }
          {
            room.opened && items.length === 0 && !room.loading && !room.error
              ? <Empty className="pt-[60px]" description="这个房间还没有消息" />
              : null
          }
        </div>
      </div>
    </section>
  );
}

function RoomPage(props: {}): ReactElement {
  const state: RoomState = useRoomState();

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

  return (
    <div className="room">
      <MemberPanel state={ state } loggedIn={ loggedIn } />
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
              <ChatView member={ state.current }
                room={ state.rooms[state.current.ownerId] ?? emptyRoomData }
                followed={ hasMember(state.follows, state.current.ownerId) }
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
