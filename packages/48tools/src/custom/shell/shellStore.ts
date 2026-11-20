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

/**
 * 侧边栏跟着窗口宽度变：窗口拖窄到 AUTO_COLLAPSE_WIDTH 以下时自动收起（不管以前有没有手动选过），
 * 拖宽回来时恢复成手动选的样子（没选过就是展开）。窄的时候仍然可以手动展开，只是下次再跨过这个宽度时又会跟着变。
 */
if (typeof window !== 'undefined') {
  let narrow: boolean = window.innerWidth < AUTO_COLLAPSE_WIDTH;

  window.addEventListener('resize', function(): void {
    const next: boolean = window.innerWidth < AUTO_COLLAPSE_WIDTH;

    if (next === narrow) return;

    narrow = next;

    let saved: string | null = null;

    try {
      saved = localStorage.getItem(COLLAPSED_KEY);
    } catch { /* noop */ }

    const collapsed: boolean = narrow || saved === '1';

    if (collapsed !== state.collapsed) setState({ collapsed });
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
