import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type PropsWithChildren,
  type RefObject,
  type Dispatch as D,
  type SetStateAction as S
} from 'react';
import { Link, useLocation, type Location } from 'react-router';
import { useSelector } from 'react-redux';
import { App, Tooltip, theme, type GlobalToken } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  HomeOutlined as IconHomeOutlined,
  DownloadOutlined as IconDownloadOutlined,
  SearchOutlined as IconSearchOutlined,
  MenuFoldOutlined as IconMenuFoldOutlined,
  MenuUnfoldOutlined as IconMenuUnfoldOutlined,
  DownOutlined as IconDownOutlined,
  SettingOutlined as IconSettingOutlined
} from '@ant-design/icons';
import './shell.global.sass';
import { shellNavGroups, findNavItem, type ShellNavGroup, type ShellNavItem } from './navConfig';
import { useShellState, toggleSidebar, setQueueOpen, setPaletteOpen, type ShellState } from './shellStore';
import CommandPalette from './CommandPalette';
import DownloadQueuePanel from '../downloadQueue/DownloadQueuePanel';
import HighlightDialog from '../highlight/HighlightDialog';
import { useQueueTasks, type QueueTask } from '../downloadQueue/downloadQueue';
import { useProxyState, proxyStateText } from '../pocket48Proxy/useProxyState';
import type { ProxyState } from '../pocket48Api/apiErrorText';
import RoomUnreadBadge from '../room/RoomUnreadBadge';
import { startUnreadWatcher } from '../room/unreadWatcher';
import { startAngelWatcher } from '../angel/angelStore'; // 临时功能：守护天使推理
import { autoStartAutoGrab } from '../live/autoGrabRunner';
import { resumeAutoClips } from '../live/autoClip';
import { startGongyanWatcher } from '../bilibili/gongyanWatcher';
import { purgeOldAudio } from '../transcribe/transcriptCache';

/**
 * 应用外壳：左边是常驻的侧边栏（所有功能、下载队列、代理状态），右边是页面内容。
 * 原来要先回首页再进别的功能，现在可以直接在侧边栏切换；Ctrl+K 可以搜索功能，Ctrl+B 收起 / 展开侧边栏。
 * 页面本身不用改，仍然由原来的路由渲染。
 * 关注成员的房间新消息也在这里启动后台检查（custom/room/unreadWatcher），「房间消息」上显示未读总数。
 * 程序启动后还会在这里：自动开始「自动抓取」（custom/live/autoGrabRunner，运行时「直播抓取」上有一个绿点）、
 * 清理 6 个月以前存下来的语音文件（custom/transcribe/transcriptCache）。
 * 接入点：src/index.tsx 用 <AppShell> 包住 <Routers />。
 */
const CLOSED_GROUPS_KEY: string = 'SHELL_CLOSED_GROUPS';
const ROOM_NAV_KEY: string = '48-room-message';
const LIVE_NAV_KEY: string = 'pocket48-live';
const AUTO_GRAB_DELAY: number = 6_000;   // 启动后等几秒再开始自动抓取（等登录状态、代理、数据库准备好）
const AUDIO_PURGE_DELAY: number = 30_000;
let startupDone: boolean = false;         // 启动时要做的事只做一次（开发模式下组件会挂载两次）

function readClosedGroups(): Array<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CLOSED_GROUPS_KEY) ?? 'null');

    if (Array.isArray(saved)) return saved.filter((item: unknown): item is string => typeof item === 'string');
  } catch { /* noop */ }

  return ['video', 'social', 'tools']; // 默认只展开口袋48
}

/* 把 antd 主题里的颜色变成 CSS 变量，样式表（shell.global.sass）里统一使用 */
function shellVars(token: GlobalToken): Record<string, string> {
  return {
    '--shell-bg': token.colorBgLayout,
    '--shell-surface': token.colorBgContainer,
    '--shell-border': token.colorBorderSecondary,
    '--shell-text': token.colorText,
    '--shell-text-secondary': token.colorTextSecondary,
    '--shell-text-tertiary': token.colorTextTertiary,
    '--shell-hover': token.colorFillTertiary,
    '--shell-active-bg': token.colorPrimaryBg,
    '--shell-primary': token.colorPrimary,
    '--shell-danger': token.colorError,
    '--shell-success': token.colorSuccess,
    '--shell-scrollbar': token.colorFill
  };
}

function NavLinkItem(props: { item: ShellNavItem; active: boolean; collapsed: boolean; grabbing?: boolean }): ReactElement {
  const { item, active, collapsed, grabbing }: { item: ShellNavItem; active: boolean; collapsed: boolean; grabbing?: boolean } = props;
  const link: ReactElement = (
    <Link className={ `shell-item${ active ? ' is-active' : '' }` }
      to={ item.to }
      aria-current={ active ? 'page' : undefined }
      draggable={ false }
    >
      { item.icon }
      <span className="shell-item-label">{ item.label }</span>
      { item.key === ROOM_NAV_KEY ? <RoomUnreadBadge /> : null }
      { item.key === LIVE_NAV_KEY && grabbing ? <span className="shell-item-live" title="自动抓取运行中" /> : null }
    </Link>
  );

  return collapsed
    ? <Tooltip title={ grabbing ? `${ item.title }（自动抓取运行中）` : item.title } placement="right" mouseEnterDelay={ 0.3 }>{ link }</Tooltip>
    : link;
}

function AppShell(props: Required<PropsWithChildren>): ReactElement {
  const { token }: { token: GlobalToken } = theme.useToken();
  const { message: messageApi }: useAppProps = App.useApp();
  const grabbing: boolean = useSelector(
    (s: { pocket48?: { autoGrabTimer?: number | null } }): boolean => typeof s.pocket48?.autoGrabTimer === 'number');
  const location: Location = useLocation();
  const { collapsed }: ShellState = useShellState();
  const tasks: Array<QueueTask> = useQueueTasks();
  const proxyState: ProxyState | undefined = useProxyState();
  const [closedGroups, setClosedGroups]: [Array<string>, D<S<Array<string>>>] = useState(readClosedGroups);
  const mainRef: RefObject<HTMLElement | null> = useRef(null);
  const pageRef: RefObject<HTMLDivElement | null> = useRef(null);
  const activeItem: ShellNavItem | undefined = findNavItem(location.pathname);
  const running: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status === 'running');
  const withPercent: Array<QueueTask> = running.filter((task: QueueTask): boolean => task.percent !== undefined);
  const averagePercent: number | undefined = withPercent.length > 0
    ? withPercent.reduce((sum: number, task: QueueTask): number => sum + (task.percent ?? 0), 0) / withPercent.length
    : undefined;

  function handleToggleGroup(key: string): void {
    setClosedGroups((prev: Array<string>): Array<string> => {
      const next: Array<string> = prev.includes(key) ? prev.filter((item: string): boolean => item !== key) : [...prev, key];

      try {
        localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify(next));
      } catch { /* noop */ }

      return next;
    });
  }

  // 颜色变量写到 :root 上：弹窗、抽屉渲染在 body 下面，也要能用到
  useLayoutEffect(function(): void {
    for (const [name, value] of Object.entries(shellVars(token))) {
      document.documentElement.style.setProperty(name, value);
    }
  }, [token]);

  // 切换页面：回到顶部，内容轻轻淡入（不重新挂载页面，只播放动画）
  useLayoutEffect(function(): void {
    mainRef.current?.scrollTo({ top: 0 });

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    pageRef.current?.animate([
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'none' }
    ], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }, [location.pathname]);

  // 当前功能在侧边栏里看不到时（列表比较长），滚动到能看到的位置
  useEffect(function(): void {
    document.querySelector('.shell-nav .shell-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [location.pathname, collapsed]);

  // 后台检查关注成员的房间有没有新消息（只启动一次，程序开着就一直检查）
  useEffect(startUnreadWatcher, []);

  // 临时功能：守护天使推理每 12 小时在后台更新一次（custom/angel）
  useEffect(startAngelWatcher, []);

  // 启动后：自动开始自动抓取（设置里可以关），清理很久以前存的语音文件
  useEffect(function(): void {
    if (startupDone) return;

    startupDone = true;
    window.setTimeout((): unknown => autoStartAutoGrab(messageApi), AUTO_GRAB_DELAY);
    window.setTimeout(resumeAutoClips, AUTO_GRAB_DELAY); // 「自动抓取并切片」上次没做完的接着做
    window.setTimeout(startGongyanWatcher, AUTO_GRAB_DELAY); // B 站公演自动录制并切片（custom/bilibili）
    window.setTimeout(purgeOldAudio, AUDIO_PURGE_DELAY);
  }, []);

  // 快捷键：Ctrl+K 快速跳转，Ctrl+B 收起 / 展开侧边栏
  useEffect(function(): () => void {
    function handleKeydown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;

      const key: string = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
    }

    window.addEventListener('keydown', handleKeydown);

    return (): void => window.removeEventListener('keydown', handleKeydown);
  }, []);

  // 主进程隐藏了系统标题栏（Windows）时，由这里画标题栏
  const hasTitleBar: boolean = Boolean((navigator as Navigator & { windowControlsOverlay?: { visible: boolean } }).windowControlsOverlay?.visible);
  const queueLabel: string = running.length > 0 ? `下载队列（进行中 ${ running.length }）` : '下载队列';
  const queueButton: ReactElement = (
    <button className="shell-item" type="button" onClick={ (): void => setQueueOpen(true) }>
      <IconDownloadOutlined />
      <span className="shell-item-label">下载队列</span>
      { running.length > 0 ? <span className="shell-item-badge">{ running.length }</span> : null }
      {
        averagePercent !== undefined
          ? <span className="shell-item-progress"><i style={{ width: `${ averagePercent }%` }} /></span>
          : null
      }
    </button>
  );
  const proxyRow: ReactElement | null = proxyState ? (
    <div className="shell-item" style={{ cursor: 'default' }}>
      <span className={ `shell-dot${ proxyState === 'ok' ? ' is-ok' : (proxyState === 'down' ? ' is-down' : '') }` } />
      <span className="shell-item-label">{ proxyState === 'ok' ? '口袋48代理运行中' : (proxyState === 'down' ? '口袋48代理未运行' : '口袋48直连') }</span>
    </div>
  ) : null;

  const collapseButton: ReactElement = (
    <Tooltip title={ collapsed ? '展开侧边栏（Ctrl+B）' : '收起侧边栏（Ctrl+B）' }
      placement={ hasTitleBar ? 'bottom' : 'right' }
      mouseEnterDelay={ 0.4 }
    >
      <button className="shell-icon-button" type="button" aria-label="收起或展开侧边栏" onClick={ toggleSidebar }>
        { collapsed ? <IconMenuUnfoldOutlined /> : <IconMenuFoldOutlined /> }
      </button>
    </Tooltip>
  );

  return (
    <div className={ `shell${ hasTitleBar ? ' has-titlebar' : '' }` }>
      {
        hasTitleBar ? (
          <header className="shell-titlebar">
            { collapseButton }
            <span className="shell-titlebar-title">{ document.title }</span>
          </header>
        ) : null
      }
      <div className="shell-body">
        <aside className={ `shell-sidebar${ collapsed ? ' is-collapsed' : '' }` }>
          {
            hasTitleBar ? null : (
              <div className="shell-brand">
                <span className="shell-brand-name">
                  48tools
                  <small>custom</small>
                </span>
                { collapseButton }
              </div>
            )
          }
          <Tooltip title={ collapsed ? '搜索功能（Ctrl+K）' : undefined } placement="right">
            <button className="shell-search" type="button" onClick={ (): void => setPaletteOpen(true) }>
              <IconSearchOutlined />
              <span>搜索功能</span>
              <kbd>Ctrl K</kbd>
            </button>
          </Tooltip>
          <nav className="shell-nav">
            <NavLinkItem item={{ key: 'home', label: '主页', title: '主页', to: '/', icon: <IconHomeOutlined /> }}
              active={ location.pathname === '/' }
              collapsed={ collapsed }
            />
            {
              shellNavGroups.map((group: ShellNavGroup): ReactElement => {
                const closed: boolean = closedGroups.includes(group.key) && !collapsed
                && !group.items.some((item: ShellNavItem): boolean => item === activeItem); // 当前页面所在的组保持展开

                return (
                  <div key={ group.key } className="shell-group">
                    <button className={ `shell-group-title${ closed ? ' is-closed' : '' }` }
                      type="button"
                      aria-expanded={ !closed }
                      onClick={ (): void => handleToggleGroup(group.key) }
                    >
                      { group.title }
                      <IconDownOutlined />
                    </button>
                    {
                      closed ? null : group.items.map((item: ShellNavItem): ReactElement => (
                        <NavLinkItem key={ item.key } item={ item } active={ item === activeItem } collapsed={ collapsed } grabbing={ grabbing } />
                      ))
                    }
                  </div>
                );
              })
            }
          </nav>
          <div className="shell-footer">
            { collapsed ? <Tooltip title={ queueLabel } placement="right">{ queueButton }</Tooltip> : queueButton }
            <NavLinkItem item={{ key: 'settings', label: '设置', title: '设置', to: '/Settings', icon: <IconSettingOutlined /> }}
              active={ location.pathname.startsWith('/Settings') }
              collapsed={ collapsed }
            />
            {
              proxyRow && collapsed
                ? <Tooltip title={ proxyState ? proxyStateText[proxyState] : undefined } placement="right">{ proxyRow }</Tooltip>
                : proxyRow
            }
          </div>
        </aside>
        <main ref={ mainRef } className="shell-main">
          <div ref={ pageRef } className="shell-page">{ props.children }</div>
        </main>
      </div>
      <DownloadQueuePanel />
      <HighlightDialog />
      <CommandPalette />
    </div>
  );
}

export default AppShell;
