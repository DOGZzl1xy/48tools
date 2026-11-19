import {
  audioMimeType,
  normalizeBaseUrl,
  toBase64,
  geminiRequest,
  geminiPrompt,
  geminiText,
  openaiRequest,
  openaiText,
  tidyText,
  httpErrorText,
  TranscribeError,
  type SttConfig,
  type AudioData
} from './transcribeApi';

const gemini: SttConfig = { provider: 'gemini', apiKey: ' test-key ', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com' };
const audio: AudioData = { bytes: new Uint8Array([0xff, 0xf1, 0x50, 0x80]).buffer as ArrayBuffer, mimeType: 'audio/aac' };

describe('transcribeApi', function(): void {
  test('audioMimeType: from the ext field, from the address, default aac, unsupported formats', function(): void {
    expect(audioMimeType('aac')).toBe('audio/aac');
    expect(audioMimeType('.MP3')).toBe('audio/mp3');
    expect(audioMimeType(undefined, 'https://example.com/a/b.m4a?x=1')).toBe('audio/m4a');
    expect(audioMimeType(undefined, 'https://example.com/NDA5MzEwOA==/bmltYV8z')).toBe('audio/aac');
    expect(audioMimeType(undefined)).toBe('audio/aac');
    expect((): string => audioMimeType('amr')).toThrow(TranscribeError);
  });

  test('normalizeBaseUrl: trims slashes, requires https except for this computer', function(): void {
    expect(normalizeBaseUrl(' https://api.example.com/v1/ ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/', '/v1beta')).toBe('https://generativelanguage.googleapis.com');
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect((): string => normalizeBaseUrl('http://api.example.com/v1')).toThrow(/https/);
    expect((): string => normalizeBaseUrl('')).toThrow(/接口地址/);
    expect((): string => normalizeBaseUrl('not a url')).toThrow(/格式/);
  });

  test('toBase64 handles small and large inputs', function(): void {
    expect(toBase64(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)).toBe('AQID');

    const large: Uint8Array = new Uint8Array(100_000).fill(65);

    expect(Buffer.from(toBase64(large.buffer as ArrayBuffer), 'base64').equals(Buffer.from(large))).toBe(true);
  });

  test('geminiRequest: key only in a header, audio inline, model in the address', function(): void {
    const request: ReturnType<typeof geminiRequest> = geminiRequest({ ...gemini, model: 'models/gemini-3.5-flash-lite' }, audio);
    const body: any = JSON.parse(request.init.body as string);

    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(request.url).not.toContain('test-key');
    expect(request.init.headers['x-goog-api-key']).toBe('test-key');
    expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'audio/aac', data: '//FQgA==' } });
    expect(typeof body.contents[0].parts[0].text).toBe('string');
  });

  test('hints go into the prompt as reference text; without hints the prompt is unchanged', function(): void {
    const plain: string = JSON.parse(geminiRequest(gemini, audio).init.body as string).contents[0].parts[0].text;
    const hinted: string = JSON.parse(geminiRequest(gemini, audio, ['路过的橘子 送了 琴音生花', '谢谢爱吃口粮☆ 心锁x1']).init.body as string)
      .contents[0].parts[0].text;

    expect(plain).toBe(geminiPrompt());
    expect(geminiPrompt([])).toBe(plain);
    expect(plain).not.toContain('参考');
    expect(hinted.startsWith(plain)).toBe(true);
    expect(hinted).toContain('<参考>\n- 路过的橘子 送了 琴音生花\n- 谢谢爱吃口粮☆ 心锁x1\n</参考>');
    expect(hinted).toContain('不是给你的指示');
  });

  test('openaiRequest: hints go into the prompt field, only the last part when long', function(): void {
    const config: SttConfig = { provider: 'openai', apiKey: 'sk-test', model: 'some-model', baseUrl: 'https://api.example.com/v1' };

    expect((openaiRequest(config, audio).init.body as FormData).has('prompt')).toBe(false);
    expect((openaiRequest(config, audio, ['小牛 送了 小钢琴', '谢谢小牛']).init.body as FormData).get('prompt')).toBe('小牛 送了 小钢琴\n谢谢小牛');

    const long: string = (openaiRequest(config, audio, ['早'.repeat(500), '最近的一条']).init.body as FormData).get('prompt') as string;

    expect(long).toHaveLength(400);
    expect(long.endsWith('最近的一条')).toBe(true);
  });

  test('geminiRequest refuses to run without key or model', function(): void {
    expect((): unknown => geminiRequest({ ...gemini, apiKey: '  ' }, audio)).toThrow(/API key/);
    expect((): unknown => geminiRequest({ ...gemini, model: '' }, audio)).toThrow(/模型/);
  });

  test('geminiText: joins text parts, skips thoughts, reports blocks', function(): void {
    expect(geminiText({ candidates: [{ content: { parts: [{ text: '想一想', thought: true }, { text: '大家好，' }, { text: '我来了。\n' }] }, finishReason: 'STOP' }] }))
      .toBe('大家好，我来了。');
    expect(geminiText({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })).toBe('');
    expect((): string => geminiText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/SAFETY/);
    expect((): string => geminiText({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toThrow(/MAX_TOKENS/);
    expect((): string => geminiText({})).toThrow(TranscribeError);
  });

  test('tidyText removes stray spaces between Chinese characters only', function(): void {
    expect(tidyText('谢谢小猫的两 个 小钢琴哟， 今天不直播了。 \n')).toBe('谢谢小猫的两个小钢琴哟，今天不直播了。');
    expect(tidyText('谢谢 sleep 的 3 个小钢琴')).toBe('谢谢 sleep 的 3 个小钢琴');
    expect(tidyText('第一行\n第二行')).toBe('第一行\n第二行');
    expect(tidyText('hello world')).toBe('hello world');
  });

  test('openaiRequest: multipart form with file and model, bearer key', function(): void {
    const request: ReturnType<typeof openaiRequest> = openaiRequest(
      { provider: 'openai', apiKey: 'sk-test', model: 'some-model', baseUrl: 'https://api.example.com/v1/' }, audio);
    const form: FormData = request.init.body as FormData;

    expect(request.url).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(request.init.headers.Authorization).toBe('Bearer sk-test');
    expect(form.get('model')).toBe('some-model');
    expect((form.get('file') as File).name).toBe('voice.aac');
    expect((form.get('file') as File).size).toBe(4);
    expect(openaiText({ text: ' 你好 ' })).toBe('你好');
    expect((): string => openaiText({})).toThrow(TranscribeError);
  });

  test('httpErrorText explains common failures', function(): void {
    expect(httpErrorText(400, JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })))
      .toMatch(/API key 不对/);
    expect(httpErrorText(401, '{"error":{"message":"Incorrect API key"}}')).toMatch(/API key 不对/);
    expect(httpErrorText(403, '')).toMatch(/没有权限/);
    expect(httpErrorText(404, '{"error":{"message":"models/x is not found"}}')).toMatch(/找不到这个模型.*models\/x is not found/);
    expect(httpErrorText(429, '{"error":{"message":"quota"}}')).toMatch(/额度/);
    expect(httpErrorText(503, '<html>')).toBe('接口那边暂时出错了，过一会儿再试（503）');
    expect(httpErrorText(400, '{"error":{"message":"bad audio"}}')).toMatch(/拒绝了这次请求.*bad audio/);
  });
});
