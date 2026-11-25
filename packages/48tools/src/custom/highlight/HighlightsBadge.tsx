import { useEffect, type ReactElement } from 'react';
import './pickTask'; // 告诉 ./showStore 要看哪些文件夹
import { refreshShows, useShowState, waitingCount, type Show } from './showStore';

/**
 * 侧边栏「切片」上的数字：有几场找好了爆点等你挑、写好了标题等你定。没有时不显示。
 * 接入点：custom/shell/AppShell.tsx 的 NavLinkItem。
 */
function HighlightsBadge(props: {}): ReactElement | null {
  const { shows }: { shows: Array<Show> } = useShowState();
  const count: number = waitingCount(shows);

  useEffect(function(): void {
    refreshShows();
  }, []);

  return count > 0 ? <span className="shell-item-badge" aria-label={ `${ count } 场等你挑爆点或者定标题` }>{ count }</span> : null;
}

export default HighlightsBadge;
