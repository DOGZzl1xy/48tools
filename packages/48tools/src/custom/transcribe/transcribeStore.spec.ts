/* eslint-disable require-await */ // 假的接口函数要返回 Promise，但里面没有什么可等的
/**
 * 语音转文字的状态（transcribeStore）：接口、缓存、设置、房间数据都换成假的，只测状态怎么变：
 * 没配置时提示去设置、转好后存下来、同一条不重复请求、重新转失败时上一次的文字还在、参考内容按语音所在的房间找。
 */
const settings: Record<string, unknown> = {};
const transcripts: Map<string, { id: string; text: string }> = new Map();
const audios: Map<string, object> = new Map();
const cacheReads: Array<number> = [];
let apiCalls: Array<{ hints: Array<string> }> = [];
let apiResult: () => Promise<string> = async (): Promise<string> => '你好';

jest.mock('../settings/settingsStore', (): object => ({
  getSettingOverrides: (): object => settings,
  resolveSetting: (saved: Record<string, unknown>, key: string): unknown => saved[key]
}));
jest.mock('../room/roomStore', (): object => ({
  getRoomState: (): object => ({ current: { ownerId: 1 }, rooms: {}, allRooms: {} })
}));
jest.mock('../room/roomCache', (): object => ({
  readRoomCacheBetween: jest.fn(async (stream: string, ownerId: number): Promise<Array<unknown>> => {
    cacheReads.push(ownerId);

    return [];
  })
}));
jest.mock('./transcriptCache', (): object => ({
  getTranscript: jest.fn(async (id: string): Promise<unknown> => transcripts.get(id)),
  putTranscript: jest.fn(async (record: { id: string; text: string }): Promise<void> => {
    transcripts.set(record.id, record);
  }),
  getAudio: jest.fn(async (id: string): Promise<unknown> => audios.get(id)),
  putAudio: jest.fn(async (record: { id: string }): Promise<void> => {
    audios.set(record.id, record);
  })
}));
jest.mock('./voiceHints', (): object => ({
  hintWindow: { before: 1_000, after: 1_000 },
  buildVoiceHints: (source: { question?: string }): Array<string> => (source.question ? [`翻牌提问：${ source.question }`] : [])
}));
jest.mock('./transcribeApi', (): object => {
  class TranscribeError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  return {
    TranscribeError,
    sttDefaults: { gemini: { model: 'default-model', baseUrl: 'https://example.com' }, openai: { model: '', baseUrl: '' } },
    audioMimeType: (): string => 'audio/aac',
    transcribeAudio: jest.fn((config: unknown, audio: unknown, hints: Array<string>): Promise<string> => {
      apiCalls.push({ hints });

      return apiResult();
    })
  };
});

import { requestTranscript, loadCachedTranscript, resetTranscribeStoreForTest, getTranscriptStateForTest } from './transcribeStore';

const stateOf: typeof getTranscriptStateForTest = getTranscriptStateForTest;

describe('transcribeStore', function(): void {
  beforeEach(function(): void {
    resetTranscribeStoreForTest();
    for (const key of Object.keys(settings)) delete settings[key];
    transcripts.clear();
    audios.clear();
    cacheReads.length = 0;
    apiCalls = [];
    apiResult = async (): Promise<string> => '你好';
    globalThis.fetch = jest.fn(async (): Promise<object> => ({ ok: true, arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(8) })) as unknown as typeof fetch;
  });

  test('without a key it asks to open the settings and sends nothing', async function(): Promise<void> {
    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac' });

    expect(stateOf('a')).toMatchObject({ status: 'error', needConfig: true });
    expect(apiCalls).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a finished transcript is saved, and the audio is downloaded only once', async function(): Promise<void> {
    settings.sttGeminiKey = 'key';
    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac', time: 5_000, question: '在听什么歌' });

    expect(stateOf('a')).toEqual({ status: 'done', text: '你好' });
    expect(transcripts.get('a')?.text).toBe('你好');
    expect(apiCalls[0].hints).toEqual(['翻牌提问：在听什么歌']);

    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac' }); // 重新转：语音用本地存的
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(apiCalls).toHaveLength(2);
  });

  test('when redoing fails, the previous text is still there', async function(): Promise<void> {
    settings.sttGeminiKey = 'key';
    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac' });

    const errorLog: jest.SpyInstance = jest.spyOn(console, 'error').mockImplementation((): void => undefined);

    apiResult = async (): Promise<string> => {
      throw new Error('接口出错');
    };
    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac' });
    errorLog.mockRestore();

    expect(stateOf('a')).toMatchObject({ status: 'error', text: '你好', error: '转文字失败，请稍后再试' });
    expect(transcripts.get('a')?.text).toBe('你好'); // 本地存的也没被改掉
  });

  test('reference text is read from the room the voice belongs to, not the room on screen', async function(): Promise<void> {
    settings.sttGeminiKey = 'key';
    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac', time: 5_000, ownerId: 42 });
    expect(cacheReads).toEqual([42, 42]);

    cacheReads.length = 0;
    await requestTranscript({ id: 'b', url: 'https://example.com/b.aac', time: 5_000 });
    expect(cacheReads).toEqual([1, 1]); // 没给房间时用正在看的那个
  });

  test('hints can be turned off', async function(): Promise<void> {
    settings.sttGeminiKey = 'key';
    settings.sttHints = false;
    await requestTranscript({ id: 'a', url: 'https://example.com/a.aac', time: 5_000, question: '在听什么歌' });

    expect(apiCalls[0].hints).toEqual([]);
    expect(cacheReads).toEqual([]);
  });

  test('a cached transcript shows up without any request', async function(): Promise<void> {
    transcripts.set('c', { id: 'c', text: '存着的文字' });
    await loadCachedTranscript('c');

    expect(stateOf('c')).toEqual({ status: 'done', text: '存着的文字' });
    expect(apiCalls).toHaveLength(0);
  });
});
