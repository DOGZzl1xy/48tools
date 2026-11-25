import type { ReactElement, ReactNode } from 'react';
import { Tooltip } from 'antd';
import { presenceLabel, type MemberPresence, type PresenceStatus } from './presenceStore';

/**
 * 头像右下角的在线状态圆点：
 *   - online：主题色实心圆点（带柔和微光 + 贴合底色的描边）
 *   - offline：中性灰实心圆点
 *   - unknown（stale=true / link.connected=false / 未同步）：灰色空心环，不误标为离线
 *   - 放在头像右下角，与右上角的未读消息气泡互不遮挡
 *   - 鼠标放上去只显示「在线 / 离线 / 状态未知」，不带时间
 */
export interface PresenceDotProps {
  visible?: boolean;
  presence?: MemberPresence;
  size?: 'sm' | 'md'; // sm：36px 头像（成员栏、标题栏）；md：44px 头像（首页关注卡片）
  tooltip?: boolean;  // 收起成窄栏时外层已有整行提示，这里关掉避免叠两个 tooltip
  children: ReactNode;
}

function PresenceDot(props: PresenceDotProps): ReactElement {
  const { visible = true, presence, size = 'sm', tooltip = true, children }: PresenceDotProps = props;

  if (!visible) return <span className="room-avatar-presence">{ children }</span>;

  const status: PresenceStatus = presence?.status ?? 'unknown';
  const label: string = presenceLabel(presence);
  const dot: ReactElement = (
    <span className={ `room-presence-dot is-${ size } is-${ status }` }
      aria-label={ label }
    />
  );

  return (
    <span className="room-avatar-presence">
      { children }
      { tooltip ? <Tooltip title={ label } mouseEnterDelay={ 0.35 }>{ dot }</Tooltip> : dot }
    </span>
  );
}

export default PresenceDot;
