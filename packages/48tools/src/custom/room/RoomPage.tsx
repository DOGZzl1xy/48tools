import { useEffect, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { useSelector } from 'react-redux';
import { Empty } from 'antd';
import { MessageOutlined as IconMessageOutlined } from '@ant-design/icons';
import './room.global.sass';
import Pocket48Login from '../../functionalComponents/Pocket48Login/Pocket48Login';
import { readJson, writeJson } from '../common/util';
import MemberPanel from './MemberPanel';
import ChatView from './ChatView';
import { loadMemberDirectory } from './memberDirectory';
import { useRoomState, openRoom, getLastRoom, type RoomState, type RoomMember, type RoomData } from './roomStore';
import { useUnreadState, setViewing, settleViewing, type UnreadState } from './unreadStore';

/**
 * 口袋房间消息的新页面（聊天软件的样子）：
 *   - 左边（./MemberPanel）：搜索成员（名字、拼音、ID、队伍都可以，结果带头像和队伍），关注列表。点成员进入房间，
 *     点星标关注 / 取消关注。可以收起成只有头像的窄栏
 *   - 右边（./ChatView）：这个成员在房间里发的消息，最新的在最下面；往上滚动会自动加载更早的消息
 *   - 房间打开时每分钟自动取一次最新消息；「更多」里可以导出 HTML / JSON、下载房间背景图（./roomExport）
 *   - 取到的消息存在本机（./roomCache）：下次打开先显示本地的，再补上新发的
 *   - 关注的成员有新消息时，头像上有一个带数字的气泡（./unreadStore、./unreadWatcher）；点进房间后清零，
 *     房间里用一条「以下是新消息」的线标出从哪里开始是没看过的
 *   - 标题栏上可以切换「只看成员 / 全部消息」。不管看的是哪一种，进入房间时两种都会取并存到本机
 *   - 成员的队伍（NII、SII……）来自成员名单（./memberDirectory）
 * 数据和接口说明见 ./roomStore。原版页面（pages/48/RoomMessage）保留不动。
 * 接入点：pages/48/Index.tsx 的 RoomMessage 路由。
 */
const SIDE_COLLAPSED_KEY: string = 'ROOM_SIDE_COLLAPSED';
const AUTO_COLLAPSE_WIDTH: number = 1_100; // 没有手动选过时，窗口比这个窄就先收起成员栏
const emptyRoomData: RoomData = { items: [], nextTime: 0, hasMore: true, loading: true, opened: false };

function initialSideCollapsed(): boolean {
  const saved: boolean | null = readJson<boolean | null>(SIDE_COLLAPSED_KEY, null);

  return typeof saved === 'boolean' ? saved : window.innerWidth < AUTO_COLLAPSE_WIDTH;
}

function hasMember(list: Array<RoomMember>, ownerId: number): boolean {
  return list.some((member: RoomMember): boolean => member.ownerId === ownerId);
}

function RoomPage(props: {}): ReactElement {
  const state: RoomState = useRoomState();
  const unread: UnreadState = useUnreadState();

  // 登录状态来自原版的登录模块（redux），登录 / 退出后这里会跟着变
  const token: string | undefined = useSelector(
    (s: { pocket48Login?: { userInfo?: { token?: string } | null } }): string | undefined => s.pocket48Login?.userInfo?.token);
  const loggedIn: boolean = Boolean(token);
  const [sideCollapsed, setSideCollapsed]: [boolean, D<S<boolean>>] = useState(initialSideCollapsed);

  function handleToggleSide(): void {
    writeJson(SIDE_COLLAPSED_KEY, !sideCollapsed);
    setSideCollapsed(!sideCollapsed);
  }

  // 成员名单（队伍、拼音）：一天更新一次
  useEffect(function(): void {
    loadMemberDirectory();
  }, []);

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
      <MemberPanel state={ state }
        counts={ unread.counts }
        loggedIn={ loggedIn }
        collapsed={ sideCollapsed && loggedIn }
        onToggleCollapsed={ handleToggleSide }
      />
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
