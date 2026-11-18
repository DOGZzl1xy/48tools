import { useSyncExternalStore } from 'react';

/**
 * 应用外壳（侧边栏布局）的界面状态：侧边栏是否收起、下载队列和快速跳转面板是否打开。
 * 放在组件外面，这样侧边栏、首页、快捷键都能读写同一份状态。
 */
export interface ShellState {
  collapsed: boolean;   // 侧边栏收起成图标栏
  queueOpen: boolean;   // 下载队列抽屉
  paletteOpen: boolean; // 快速跳转（Ctrl+K）
}

const COLLAPSED_KEY: string = 'SHELL_SIDEBAR_COLLAPSED';
const AUTO_COLLAPSE_WIDTH: number = 1080; // 窗口比这个窄时默认收起侧边栏

function initialCollapsed(): boolean {
  try {
    const saved: string | null = localStorage.getItem(COLLAPSED_KEY);

    if (saved !== null) return saved === '1';
  } catch { /* noop */ }

  return typeof window !== 'undefined' && window.innerWidth < AUTO_COLLAPSE_WIDTH;
}

let state: ShellState = { collapsed: initialCollapsed(), queueOpen: false, paletteOpen: false };
const listeners: Set<() => void> = new Set();

function setState(patch: Partial<ShellState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
}

export function getShellState(): ShellState {
  return state;
}

export function toggleSidebar(): void {
  const collapsed: boolean = !state.collapsed;

  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch { /* noop */ }

  setState({ collapsed });
}

export function setQueueOpen(queueOpen: boolean): void {
  setState({ queueOpen });
}

export function setPaletteOpen(paletteOpen: boolean): void {
  setState({ paletteOpen });
}

/* 没有手动收起 / 展开过的时候，侧边栏跟着窗口宽度自动收起或展开 */
if (typeof window !== 'undefined') {
  window.addEventListener('resize', function(): void {
    let hasPreference: boolean = false;

    try {
      hasPreference = localStorage.getItem(COLLAPSED_KEY) !== null;
    } catch { /* noop */ }

    const collapsed: boolean = window.innerWidth < AUTO_COLLAPSE_WIDTH;

    if (!hasPreference && collapsed !== state.collapsed) setState({ collapsed });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

export function useShellState(): ShellState {
  return useSyncExternalStore(subscribe, getShellState);
}
