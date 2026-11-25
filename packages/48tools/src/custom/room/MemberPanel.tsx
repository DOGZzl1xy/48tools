import { useEffect, useRef, useState, type ReactElement, type RefObject, type ChangeEvent, type KeyboardEvent, type Dispatch as D, type SetStateAction as S } from 'react';
import { Avatar, Badge, Input, Spin, Tooltip } from 'antd';
import {
  SearchOutlined as IconSearchOutlined,
  StarOutlined as IconStarOutlined,
  StarFilled as IconStarFilled,
  MenuFoldOutlined as IconMenuFoldOutlined,
  MenuUnfoldOutlined as IconMenuUnfoldOutlined
} from '@ant-design/icons';
import { sleep } from '../common/util';
import { openRoom, searchMembers, toggleFollow, type RoomState, type RoomMember } from './roomStore';
import { useMemberDirectory, teamOf, type DirectoryState } from './memberDirectory';
import { searchDirectory, type DirectoryMember } from './memberSearch';
import type { UnreadState } from './unreadStore';
import { usePresenceState, presenceLabel, type MemberPresence, type PresenceState } from './presenceStore';
import PresenceDot from './PresenceDot';
import { useTimeZone } from '../time/appTime';

/**
 * 房间页面左边的成员栏：搜索成员，下面是关注列表（从 RoomPage 里拆出来的）。
 *   - 搜索可以输入中文名字、拼音（全拼，或者姓和名的首字母）、成员 ID、队伍（比如 NII）。
 *     有中文时用口袋48的搜索接口（结果带头像），同时在成员名单（./memberDirectory）里找；
 *     没有中文时只在成员名单里找，头像再用接口按名字补（只补前几个）
 *   - 每个成员名字后面显示队伍
 *   - 可以收起成一条只有头像的窄栏（窗口窄的时候给聊天内容腾地方）
 */
const AVATAR_LOOKUPS: number = 8; // 从名单里找到的成员，最多给前几个补头像
const avatarCache: Map<number, string> = new Map();

function hasMember(list: Array<RoomMember>, ownerId: number): boolean {
  return list.some((member: RoomMember): boolean => member.ownerId === ownerId);
}

function toRoomMember(item: DirectoryMember): RoomMember {
  return { ownerId: item.id, name: item.name, avatar: avatarCache.get(item.id) ?? '' };
}

/* 接口的结果在前（有头像），名单里多出来的接在后面 */
function mergeResults(fromApi: Array<RoomMember>, fromDirectory: Array<DirectoryMember>): Array<RoomMember> {
  const result: Array<RoomMember> = [...fromApi];

  for (const item of fromDirectory) hasMember(result, item.id) || result.push(toRoomMember(item));

  return result;
}

interface MemberRowProps {
  member: RoomMember;
  team?: { label: string; title: string };
  presence?: MemberPresence;
  active: boolean;
  followed: boolean;
  unread: number; // 未读消息数，0 就不显示气泡
  compact: boolean; // 成员栏收起时只画头像
  onOpen: () => void;
}

function MemberRow(props: MemberRowProps): ReactElement {
  const { member, team, presence, active, followed, unread, compact, onOpen }: MemberRowProps = props;
  const showDot: boolean = followed || presence !== undefined;
  const row: ReactElement = (
    <div className={ `room-member${ active ? ' is-active' : '' }` }
      role="button"
      tabIndex={ 0 }
      aria-label={ compact ? member.name : undefined }
      onClick={ onOpen }
      onKeyDown={ (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;

        event.preventDefault();
        onOpen();
      } }
    >
      <Badge className="room-unread" count={ unread } overflowCount={ 99 } size="small" offset={ [-3, 3] } title={ `${ unread } 条未读消息` }>
        <PresenceDot visible={ showDot }
          presence={ presence }
          size="sm"
          tooltip={ !compact }
        >
          <Avatar size={ 36 } src={ member.avatar || undefined }>{ member.name.slice(-2) }</Avatar>
        </PresenceDot>
      </Badge>
      {
        compact ? null : (
          <span className="room-member-name">
            <span>{ member.name }</span>
            { team ? <span className="room-team" title={ team.title }>{ team.label }</span> : null }
          </span>
        )
      }
      {
        compact ? null : (
          <Tooltip title={ followed ? '取消关注' : '关注（加到关注列表里）' } mouseEnterDelay={ 0.4 }>
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
        )
      }
    </div>
  );

  const compactTitle: string = [
    member.name,
    team?.label,
    showDot ? presenceLabel(presence) : undefined
  ].filter(Boolean).join(' · ');

  return compact
    ? <Tooltip title={ compactTitle } placement="right" mouseEnterDelay={ 0.3 }>{ row }</Tooltip>
    : row;
}

interface MemberPanelProps {
  state: RoomState;
  counts: UnreadState['counts'];
  loggedIn: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function MemberPanel(props: MemberPanelProps): ReactElement {
  const { state, counts, loggedIn, collapsed, onToggleCollapsed }: MemberPanelProps = props;
  const directory: DirectoryState = useMemberDirectory();
  const presence: PresenceState = usePresenceState();
  const zone: string = useTimeZone();
  const [keyword, setKeyword]: [string, D<S<string>>] = useState('');
  const [results, setResults]: [Array<RoomMember> | null, D<S<Array<RoomMember> | null>>] = useState<Array<RoomMember> | null>(null);
  const [searching, setSearching]: [boolean, D<S<boolean>>] = useState(false);
  const [error, setError]: [string, D<S<string>>] = useState('');
  const searchId: RefObject<number> = useRef(0);

  // 输入停下 0.4 秒后搜索
  useEffect(function(): (() => void) | void {
    const text: string = keyword.trim();
    const id: number = ++searchId.current; // 每次输入变化都换一个编号：之前还没回来的结果不再使用

    setError('');
    setSearching(false);

    if (text === '') {
      setResults(null);

      return;
    }

    const local: Array<DirectoryMember> = searchDirectory(directory.members, text);
    const hasChinese: boolean = /[一-龥]/.test(text);

    // 名单里找到的先显示出来
    setResults(local.map(toRoomMember));

    const timer: number = window.setTimeout(async (): Promise<void> => {
      setSearching(true);

      try {
        if (hasChinese) {
          const members: Array<RoomMember> = await searchMembers(text);

          for (const member of members) member.avatar && avatarCache.set(member.ownerId, member.avatar);

          if (id === searchId.current) setResults(mergeResults(members, local));
        } else {
          // 没有中文：接口搜不了，给名单里找到的前几个按名字补头像
          for (const item of local.filter((member: DirectoryMember): boolean => !avatarCache.has(member.id)).slice(0, AVATAR_LOOKUPS)) {
            if (id !== searchId.current) return;

            const found: RoomMember | undefined = (await searchMembers(item.name))
              .find((member: RoomMember): boolean => member.ownerId === item.id);

            found?.avatar && avatarCache.set(item.id, found.avatar);

            if (id === searchId.current) setResults(local.map(toRoomMember));

            await sleep(150);
          }
        }
      } catch (err) {
        // 名单里已经找到了的话，接口出错不用提示
        if (id === searchId.current && local.length === 0) setError(err instanceof Error ? err.message : '搜索失败');
      }

      if (id === searchId.current) setSearching(false);
    }, 400);

    return (): void => window.clearTimeout(timer);
  }, [keyword, directory]);

  const list: Array<RoomMember> = results ?? state.follows;

  return (
    <aside className={ `room-side${ collapsed ? ' is-collapsed' : '' }` }>
      <div className="room-side-top">
        {
          collapsed ? null : (
            <Input className="room-search"
              allowClear={ true }
              placeholder="名字 / 拼音 / 队伍"
              prefix={ <IconSearchOutlined /> }
              value={ keyword }
              disabled={ !loggedIn }
              onChange={ (event: ChangeEvent<HTMLInputElement>): void => setKeyword(event.target.value) }
            />
          )
        }
        <Tooltip title={ collapsed ? '展开成员栏（可以搜索成员）' : '收起成员栏' } placement={ collapsed ? 'right' : 'bottom' } mouseEnterDelay={ 0.4 }>
          <button className="room-side-toggle" type="button" aria-label={ collapsed ? '展开成员栏' : '收起成员栏' } onClick={ onToggleCollapsed }>
            { collapsed ? <IconMenuUnfoldOutlined /> : <IconMenuFoldOutlined /> }
          </button>
        </Tooltip>
      </div>
      {
        collapsed ? null : (
          <div className="room-side-title">
            { results ? '搜索结果' : '关注' }
            { searching ? <Spin size="small" /> : null }
          </div>
        )
      }
      <div className="room-side-list">
        {
          (collapsed ? state.follows : list).map((member: RoomMember): ReactElement => (
            <MemberRow key={ member.ownerId }
              member={ member }
              team={ teamOf(directory, member.ownerId) }
              presence={ presence.byOwner[member.ownerId] }
              active={ state.current?.ownerId === member.ownerId }
              followed={ hasMember(state.follows, member.ownerId) }
              unread={ hasMember(state.follows, member.ownerId) ? (counts[member.ownerId] ?? 0) : 0 }
              compact={ collapsed }
              onOpen={ (): void => {
                openRoom(member);
              } }
            />
          ))
        }
        {
          !collapsed && list.length === 0 && !searching ? (
            <p className="room-side-empty">
              { error || (results ? '没有找到这个成员' : '还没有关注的成员。在上面搜索成员，点名字旁边的星标就能加到这里。') }
            </p>
          ) : null
        }
      </div>
    </aside>
  );
}

export default MemberPanel;
