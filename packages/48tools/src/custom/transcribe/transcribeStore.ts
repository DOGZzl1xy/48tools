import { useSyncExternalStore } from 'react';
import type { CustomMessageV2 } from '@48tools-api/48';
import { getSettingOverrides, resolveSetting, type CustomSettings, type SttProvider } from '../settings/settingsStore';
import { getRoomState, type RoomState } from '../room/roomStore';
import { readRoomCacheBetween } from '../room/roomCache';
import { transcribeAudio, audioMimeType, sttDefaults, TranscribeError, type SttConfig } from './transcribeApi';
import { getTranscript, putTranscript, getAudio, putAudio, type AudioRecord, type TranscriptRecord } from './transcriptCache';
import { buildVoiceHints, hintWindow } from './voiceHints';

/**
 * 语音转文字的状态：每条语音（按标识）现在是「正在转 / 转好了 / 出错了」，界面（./VoiceMessage）订阅自己那一条。
 * 流程：点「转文字」→ 下载语音（已经存过就用本地的）→ 找出语音前后的文字当参考（./voiceHints，设置里可以关）
 * → 发给接口 → 文字和语音都存到本地（./transcriptCache）。
 * 以后再看到同一条语音，直接从本地读出文字，不再请求接口。
 */
export interface TranscriptState {
  status: 'loading' | 'done' | 'error';
  text?: string;
  error?: string;
  needConfig?: boolean; // 出错原因是还没配置好（显示「去设置」）
}
// 重新转一次时 text 保留上一次的文字：正在转、转失败时界面上仍然显示它

export interface VoiceSource {
  id: string;   // 语音的标识（md5 或地址）
  url: string;
  ext?: string; // 消息里写的格式，比如 aac
  time?: number;     // 这条语音消息的时间（毫秒）。有它才能找语音前后的文字当参考
  question?: string; // 翻牌的语音回答：粉丝的提问（也当参考）
  ownerId?: number;  // 这条语音在哪个成员的房间里（找参考内容时用；转写途中切到别的房间也不会找错）
  duration?: number; // 语音有多长（毫秒），消息里带了才有
}

const MAX_AUDIO_BYTES: number = 15 * 1024 * 1024; // 接口一次请求最多 20 MB，留些余量
const listeners: Set<() => void> = new Set();
const lookedUp: Set<string> = new Set(); // 已经查过本地缓存的语音，不重复查
let states: Record<string, TranscriptState> = {};

function setState(id: string, state: TranscriptState | undefined): void {
  const next: Record<string, TranscriptState> = { ...states };

  if (state) {
    next[id] = state;
  } else {
    delete next[id];
  }

  states = next;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

/* 某一条语音的转写状态；还没转过时是 undefined */
export function useTranscript(id: string): TranscriptState | undefined {
  return useSyncExternalStore(subscribe, (): TranscriptState | undefined => states[id]);
}

/* 根据设置算出现在用哪个接口、哪个 key、哪个模型 */
export function resolveSttConfig(saved: CustomSettings): SttConfig {
  const provider: SttProvider = resolveSetting(saved, 'sttProvider') === 'openai' ? 'openai' : 'gemini';
  const openai: boolean = provider === 'openai';

  return {
    provider,
    apiKey: resolveSetting(saved, openai ? 'sttOpenaiKey' : 'sttGeminiKey') ?? '',
    model: resolveSetting(saved, openai ? 'sttOpenaiModel' : 'sttGeminiModel') || sttDefaults[provider].model,
    baseUrl: resolveSetting(saved, openai ? 'sttOpenaiBaseUrl' : 'sttGeminiBaseUrl') || sttDefaults[provider].baseUrl
  };
}

/* 语音出现在屏幕上时调用：本地有转好的文字就直接显示 */
export async function loadCachedTranscript(id: string): Promise<void> {
  if (lookedUp.has(id)) return;

  lookedUp.add(id);

  const record: TranscriptRecord | undefined = await getTranscript(id);

  if (record && !states[id]) setState(id, { status: 'done', text: record.text });
}

async function download(url: string): Promise<ArrayBuffer> {
  let response: Response;

  try {
    response = await fetch(url);
  } catch {
    throw new TranscribeError('network', '语音下载失败，检查一下网络');
  }

  if (!response.ok) throw new TranscribeError('network', `语音下载失败（${ response.status }），可能已经失效`);

  const bytes: ArrayBuffer = await response.arrayBuffer();

  if (bytes.byteLength === 0) throw new TranscribeError('network', '语音下载下来是空的');

  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new TranscribeError('format', '这段语音太大了，不能转文字');

  return bytes;
}

/**
 * 找出这条语音的参考内容：正在看的房间里，语音前后那段时间的消息（本地缓存里的，加上已经加载到页面上的），
 * 交给 ./voiceHints 挑。设置里关掉了、或者找不到时返回空（照常只发语音）
 */
async function collectHints(voice: VoiceSource): Promise<Array<string>> {
  if (resolveSetting(getSettingOverrides(), 'sttHints') === false) return [];

  const room: RoomState = getRoomState();
  const ownerId: number | undefined = voice.ownerId ?? room.current?.ownerId;
  const messages: Array<CustomMessageV2> = [];

  if (voice.time !== undefined && ownerId !== undefined) {
    const from: number = voice.time - hintWindow.before;
    const to: number = voice.time + hintWindow.after;
    const [owner, all]: [Array<CustomMessageV2>, Array<CustomMessageV2>] = await Promise.all([
      readRoomCacheBetween('owner', ownerId, from, to),
      readRoomCacheBetween('all', ownerId, from, to)
    ]);

    messages.push(...owner, ...all);

    for (const data of [room.rooms[ownerId], room.allRooms[ownerId]]) {
      for (const item of data?.items ?? []) item.raw.msgTime >= from && item.raw.msgTime <= to && messages.push(item.raw);
    }
  }

  return buildVoiceHints({ time: voice.time ?? 0, messages, question: voice.question });
}

/* 点「转文字」/「重新转」 */
export async function requestTranscript(voice: VoiceSource): Promise<void> {
  const { id }: VoiceSource = voice;

  if (states[id]?.status === 'loading') return;

  const config: SttConfig = resolveSttConfig(getSettingOverrides());

  if (!config.apiKey.trim() || !config.model.trim() || !config.baseUrl.trim()) {
    setState(id, { status: 'error', error: '还没有配置语音转文字的接口', needConfig: true, text: states[id]?.text });

    return;
  }

  const previous: string | undefined = states[id]?.text; // 上一次转好的文字：这次失败了也不丢

  setState(id, { status: 'loading', text: previous });

  try {
    let audio: AudioRecord | undefined = await getAudio(id);

    if (!audio) {
      const mimeType: string = audioMimeType(voice.ext, voice.url);

      audio = { id, mimeType, bytes: await download(voice.url), savedAt: Date.now() };
      await putAudio(audio);
    }

    // 参考内容找不到不影响转写
    const hints: Array<string> = await collectHints(voice).catch((err: unknown): Array<string> => {
      console.error('读取语音前后的文字失败', err);

      return [];
    });
    const text: string = await transcribeAudio(config, audio, hints);

    await putTranscript({ id, text, model: config.model, createdAt: Date.now() });
    lookedUp.add(id);
    setState(id, { status: 'done', text });
  } catch (err) {
    if (!(err instanceof TranscribeError)) console.error(err);

    setState(id, {
      status: 'error',
      text: previous,
      error: err instanceof TranscribeError ? err.message : '转文字失败，请稍后再试',
      needConfig: err instanceof TranscribeError && err.code === 'config'
    });
  }
}

/* 本地存着的语音（原来的地址播放不了时用）。返回一个只在本机有效的临时地址，用完要 URL.revokeObjectURL */
export async function cachedAudioUrl(id: string): Promise<string | undefined> {
  const audio: AudioRecord | undefined = await getAudio(id);

  return audio ? URL.createObjectURL(new Blob([audio.bytes], { type: audio.mimeType })) : undefined;
}

/* 测试用：某一条语音现在的状态 */
export function getTranscriptStateForTest(id: string): TranscriptState | undefined {
  return states[id];
}

export function resetTranscribeStoreForTest(): void {
  states = {};
  lookedUp.clear();
}
