import { useSyncExternalStore } from 'react';
import type { HighlightRecord } from './highlightTask';

/**
 * 「自动切片」对话框现在是给哪一场录播开的（没开就是 null）。
 * 放在组件外面：录播列表里点菜单的地方只要调 openHighlightDialog，对话框本身由应用外壳渲染一次。
 */
let current: HighlightRecord | null = null;
const listeners: Set<() => void> = new Set();

function set(record: HighlightRecord | null): void {
  current = record;

  for (const listener of listeners) listener();
}

export function openHighlightDialog(record: HighlightRecord): void {
  set(record);
}

export function closeHighlightDialog(): void {
  set(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

function getRecord(): HighlightRecord | null {
  return current;
}

export function useHighlightDialogRecord(): HighlightRecord | null {
  return useSyncExternalStore(subscribe, getRecord);
}
