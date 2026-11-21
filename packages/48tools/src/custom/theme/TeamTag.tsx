import type { ReactElement, ReactNode } from 'react';
import { Tag } from 'antd';
import classNames from 'classnames';
import type { Team } from './accent';

/**
 * 用团队色区分类别的标签（SII 蓝、NII 紫、HII 橙、X 绿，见 ./accent）。
 * antd 的 Tag 直接传颜色时是实心底加白字，浅的团队色上白字看不清，所以用浅色的底和加深的字（样式在 ./theme.global.sass）。
 * 接入点：pages/48/components/LiveType（直播类型）、pages/PlayerWindow/LiveInfo（录屏）、functionalComponents/WeiboLogin/LoginTable。
 */
function TeamTag(props: { team: Team; className?: string; children: ReactNode }): ReactElement {
  return <Tag className={ classNames(`team-tag-${ props.team }`, props.className) }>{ props.children }</Tag>;
}

export default TeamTag;
