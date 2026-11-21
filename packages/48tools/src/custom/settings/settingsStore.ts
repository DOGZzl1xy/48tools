import { useSyncExternalStore } from 'react';
import { getPocket48LocalConfig } from '../pocket48Proxy/pocket48Proxy';
import { readJson, writeJson } from '../common/util';
import { sealSecret, openSecret } from './secretBox';

/**
 * 「设置」页面里可以改的选项。
 * 值保存在 localStorage（CUSTOM_SETTINGS）；没有在界面上改过的选项，用 local/pocket48.json 里的值，再没有就用默认值。
 * 也就是：界面上的设置 > local/pocket48.json > 默认值。
 * API key（SECRET_KEYS）存进 localStorage 之前会用系统的加密功能加密（./secretBox），内存里用的是明文。
 */
export type LiveRecordFormat = 'flv' | 'mp4' | 'mp4-compress';
export type SttProvider = 'gemini' | 'openai'; // 语音转文字用哪种接口（见 custom/transcribe）

export interface CustomSettings {
  downloadDir?: string;               // 保存文件时默认打开的文件夹
  liveRecordDir?: string;             // 直播自动录制保存的文件夹（不设置就用 downloadDir）
  liveRecordFormat?: LiveRecordFormat; // 直播录完后的格式
  accentColor?: string;               // 主题色
  sttProvider?: SttProvider;          // 语音转文字：接口类型
  sttGeminiKey?: string;              // 语音转文字：Google Gemini 的 API key（两种接口各存各的，切换类型时不会把 key 发给别的服务商）
  sttGeminiModel?: string;
  sttGeminiBaseUrl?: string;
  sttOpenaiKey?: string;              // 语音转文字：OpenAI 兼容接口的 API key
  sttOpenaiModel?: string;
  sttOpenaiBaseUrl?: string;
  sttHints?: boolean;                 // 语音转文字：把语音前后的文字一起发给接口当参考（默认开，只有关掉时才保存成 false）
  roomBeijingTime?: boolean;          // 房间消息的时间按北京时间显示（默认按这台电脑的时区）
  autoGrabAutoStart?: boolean;        // 程序启动后自动开始「自动抓取」（默认开，只有关掉时才保存成 false）
  autoGrabMode?: AutoGrabMode;        // 自动抓取用哪种方式录（上次手动开始时选的；默认 flv）
  highlightModel?: string;            // 录播切片：用哪个 Gemini 模型（key 和接口地址用语音转文字里 Gemini 的那一份）
  highlightDir?: string;              // 录播切片：保存的文件夹（不设置就用 downloadDir 下面的「录播切片」）
  highlightAutoScore?: number;        // 录播切片：选「自动」时，爆点分不低于它的才做（不设置用默认的 8.5）
  highlightCount?: number;            // 录播切片：上次选的数量（没选过或选了「自动」时不保存）
}

export type AutoGrabMode = 'flv' | 'ts' | 'backup';

/* 需要加密保存的选项 */
const SECRET_KEYS: Array<keyof CustomSettings> = ['sttGeminiKey', 'sttOpenaiKey'];

const STORAGE_KEY: string = 'CUSTOM_SETTINGS';
const listeners: Set<() => void> = new Set();

/* 存进 localStorage 的样子：API key 换成加密后的内容 */
function seal(settings: CustomSettings): CustomSettings {
  const sealed: Record<string, unknown> = { ...settings };

  for (const key of SECRET_KEYS) {
    if (typeof sealed[key] === 'string') sealed[key] = sealSecret(sealed[key] as string);
  }

  return sealed as CustomSettings;
}

function read(): CustomSettings {
  const saved: unknown = readJson<unknown>(STORAGE_KEY, {});

  if (!saved || typeof saved !== 'object') return {};

  const settings: Record<string, unknown> = { ...saved as CustomSettings };
  let migrate: boolean = false;

  for (const key of SECRET_KEYS) {
    const value: unknown = settings[key];

    if (typeof value !== 'string') continue;

    const opened: { text?: string; sealed: boolean } = openSecret(value);

    if (opened.text === undefined) {
      delete settings[key]; // 解不开（换了电脑或 Windows 用户）：当成没填，需要重新填一次
    } else {
      settings[key] = opened.text;
      migrate ||= !opened.sealed; // 以前明文保存的：这次加密后存回去
    }
  }

  migrate && writeJson(STORAGE_KEY, seal(settings as CustomSettings));

  return settings as CustomSettings;
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

  writeJson(STORAGE_KEY, seal(next));

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
