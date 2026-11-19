import type { ReactElement } from 'react';
import { useRoomState, type RoomState, type RoomMember } from './roomStore';
import { useUnreadState, totalUnread, unreadText, type UnreadState } from './unreadStore';

/**
 * 侧边栏「房间消息」上的数字：所有关注成员的未读消息加起来有多少条。没有未读时不显示。
 * 接入点：custom/shell/AppShell.tsx 的 NavLinkItem。
 */
function RoomUnreadBadge(props: {}): ReactElement | null {
  const { follows }: RoomState = useRoomState();
  const { counts }: UnreadState = useUnreadState();
  const total: number = totalUnread(counts, follows.map((member: RoomMember): number => member.ownerId));

  if (total <= 0) return null;

  return <span className="shell-item-badge is-unread" aria-label={ `${ total } 条未读消息` }>{ unreadText(total) }</span>;
}

export default RoomUnreadBadge;
