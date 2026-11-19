import { useSyncExternalStore } from 'react';
import { getPocket48LocalConfig } from '../pocket48Proxy/pocket48Proxy';

/**
 * 「设置」页面里可以改的选项。
 * 值保存在 localStorage（CUSTOM_SETTINGS）；没有在界面上改过的选项，用 local/pocket48.json 里的值，再没有就用默认值。
 * 也就是：界面上的设置 > local/pocket48.json > 默认值。
 */
export type LiveRecordFormat = 'flv' | 'mp4' | 'mp4-compress';

export interface CustomSettings {
  downloadDir?: string;               // 保存文件时默认打开的文件夹
  liveRecordDir?: string;             // 直播自动录制保存的文件夹（不设置就用 downloadDir）
  liveRecordFormat?: LiveRecordFormat; // 直播录完后的格式
  accentColor?: string;               // 主题色
}

const STORAGE_KEY: string = 'CUSTOM_SETTINGS';
const listeners: Set<() => void> = new Set();

function read(): CustomSettings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');

    return saved && typeof saved === 'object' ? saved as CustomSettings : {};
  } catch {
    return {};
  }
}

let overrides: CustomSettings = typeof localStorage === 'undefined' ? {} : read();

/* 界面上保存的设置（不含 local/pocket48.json 的值） */
export function getSettingOverrides(): CustomSettings {
  return overrides;
}

/**
 * 根据界面上保存的设置算出某个选项生效的值。
 * 界面组件里用这个（把 useSettingOverrides() 的结果传进来），这样设置变化时会重新计算
 */
export function resolveSetting<K extends keyof CustomSettings>(saved: CustomSettings, key: K): CustomSettings[K] {
  const value: CustomSettings[K] = saved[key];

  if (value !== undefined && value !== '') return value;

  if (key === 'accentColor') return undefined;

  return (getPocket48LocalConfig() as CustomSettings)[key];
}

/* 某个选项当前生效的值（界面以外的代码用） */
export function getSetting<K extends keyof CustomSettings>(key: K): CustomSettings[K] {
  return resolveSetting(overrides, key);
}

/* 修改设置；传 undefined 表示恢复成 local/pocket48.json 的值或默认值 */
export function setSetting<K extends keyof CustomSettings>(key: K, value: CustomSettings[K]): void {
  const next: CustomSettings = { ...overrides };

  if (value === undefined || value === '') {
    delete next[key];
  } else {
    next[key] = value;
  }

  overrides = next;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* noop */ }

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

/* React 里读取设置（设置变化时重新渲染） */
export function useSettingOverrides(): CustomSettings {
  return useSyncExternalStore(subscribe, getSettingOverrides);
}

/* 可选的主题色；第一个是默认值 */
export const accentColors: Array<{ name: string; light: string; dark: string }> = [
  { name: '青色', light: '#08979c', dark: '#13c2c2' },
  { name: '蓝色', light: '#2563eb', dark: '#4b8bff' },
  { name: '靛蓝', light: '#4f46e5', dark: '#7c83ff' },
  { name: '紫色', light: '#7c3aed', dark: '#a78bfa' },
  { name: '粉色', light: '#db2777', dark: '#f472b6' },
  { name: '橙色', light: '#ea580c', dark: '#fb923c' },
  { name: '绿色', light: '#16a34a', dark: '#4ade80' }
];

/* 当前主题色在明 / 暗模式下的颜色 */
export function accentColorOf(name: string | undefined, isDark: boolean | undefined): string {
  const accent: { light: string; dark: string } = accentColors.find((item: { name: string }): boolean => item.name === name) ?? accentColors[0];

  return isDark ? accent.dark : accent.light;
}
