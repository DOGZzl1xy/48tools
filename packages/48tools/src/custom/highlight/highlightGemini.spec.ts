/* eslint-disable require-await */ // 假的 fetch 要返回 Promise，但里面没有什么可等的
/**
 * 录播自动切片里问 Gemini 的部分：提示里给了什么、结果怎么读、接口出错时怎么办。接口换成假的。
 */
import {
  geminiJson, findRequest, readFound, scriptRequest, readScript, coverRequest, cleanTitle,
  type GeminiConfig, type GeminiAsk
} from './highlightGemini';
import type { Highlight } from './highlightTypes';

const config: GeminiConfig = { apiKey: 'test-key', model: 'models/test-model', baseUrl: 'https://example.invalid/v1beta/' };
const ask: GeminiAsk = { parts: [{ text: '问题' }], schema: { type: 'OBJECT' } };
const highlight: Highlight = { start: 100, end: 160, title: '第一步的标题', cover: '封面的话', quote: '原话', reason: '理由', score: 9 };

function reply(data: unknown, status: number = 200): Response {
  const body: unknown = status === 200
    ? { candidates: [{ content: { parts: [{ text: '想了想', thought: true }, { text: JSON.stringify(data) }] }, finishReason: 'STOP' }] }
    : { error: { message: '出错了' } };

  return new Response(JSON.stringify(body), { status });
}

describe('geminiJson', (): void => {
  test('key 放在请求头里，地址里没有；返回解析好的 JSON（不算思考过程）', async (): Promise<void> => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake: typeof fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });

      return reply({ ok: 1 });
    }) as typeof fetch;

    await expect(geminiJson(config, ask, undefined, fake)).resolves.toEqual({ ok: 1 });
    expect(calls[0].url).toBe('https://example.invalid/v1beta/models/test-model:generateContent');
    expect(calls[0].url).not.toContain('test-key');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    expect(JSON.parse(calls[0].init.body as string).generationConfig.responseMimeType).toBe('application/json');
  });

  test('没有 key 时不发请求', async (): Promise<void> => {
    const fake: jest.Mock = jest.fn();

    await expect(geminiJson({ ...config, apiKey: ' ' }, ask, undefined, fake as unknown as typeof fetch)).rejects.toThrow('API key');
    expect(fake).not.toHaveBeenCalled();
  });

  test('key 不对（400 / 401）直接报错，不重试', async (): Promise<void> => {
    const fake: jest.Mock = jest.fn(async (): Promise<Response> => reply(null, 401));

    await expect(geminiJson(config, ask, undefined, fake as unknown as typeof fetch)).rejects.toThrow('API key 不对');
    expect(fake).toHaveBeenCalledTimes(1);
  });

  test('已经点了停止就不发请求', async (): Promise<void> => {
    const fake: jest.Mock = jest.fn();
    const controller: AbortController = new AbortController();

    controller.abort();
    await expect(geminiJson(config, ask, controller.signal, fake as unknown as typeof fetch)).rejects.toThrow('已停止');
    expect(fake).not.toHaveBeenCalled();
  });

  test('返回的不是 JSON 时再问一次', async (): Promise<void> => {
    let count: number = 0;
    const fake: typeof fetch = (async (): Promise<Response> => {
      count++;

      return count === 1
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '不是 JSON' }] } }] }))
        : reply({ ok: 2 });
    }) as typeof fetch;

    await expect(geminiJson(config, ask, undefined, fake)).resolves.toEqual({ ok: 2 });
    expect(count).toBe(2);
  });
});

describe('找爆点', (): void => {
  test('弹幕只给这一段里的，只有时间和内容，没有昵称', (): void => {
    const request: GeminiAsk = findRequest({ member: '测试成员', title: '测试直播' }, { start: 1_680, length: 1_800 }, 'QUJD', [
      { time: 100, nickname: '不在这一段的人', message: '太早了' },
      { time: 1_700, nickname: '某个粉丝的昵称', message: '哈哈哈哈' }
    ]);
    const prompt: string = request.parts[0].text!;

    expect(prompt).toContain('00:20 哈哈哈哈');
    expect(prompt).not.toContain('某个粉丝的昵称');
    expect(prompt).not.toContain('太早了');
    expect(prompt).toContain('28:00 到 58:00');
    expect(request.parts[1].inlineData).toEqual({ mimeType: 'audio/mp3', data: 'QUJD' });
  });

  test('结果里的时间换成整场录播里的秒数；时间不对、太短、没有标题的不要', (): void => {
    const found: ReturnType<typeof readFound> = readFound({
      summary: ' 聊了很多 ',
      highlights: [
        { start: '20:30', end: '22:18', title: '好的', cover: '', quote: '', reason: '', score: 9 },
        { start: '29:00', end: '35:00', title: '超出这一段的结尾', cover: '', quote: '', reason: '', score: 8 },
        { start: '大概中间', end: '10:00', title: '时间看不懂', score: 9 },
        { start: '05:00', end: '05:02', title: '太短', score: 9 },
        { start: '06:00', end: '07:00', title: ' ', score: 9 }
      ]
    }, { start: 1_680, length: 1_800 });

    expect(found.summary).toBe('聊了很多');
    expect(found.highlights.map((item: Highlight): Array<number | string> => [item.title, item.start, item.end])).toEqual([
      ['好的', 2_910, 3_018],
      ['超出这一段的结尾', 3_420, 3_480]
    ]);
  });

  test('返回的东西乱七八糟也不报错', (): void => {
    expect(readFound(null, { start: 0, length: 100 })).toEqual({ summary: '', highlights: [] });
    expect(readFound({ highlights: 'x' }, { start: 0, length: 100 }).highlights).toEqual([]);
  });
});

describe('片段的字幕、标题、简介', (): void => {
  test('提示里有主题和关键的那句话；弹幕没有昵称', (): void => {
    const prompt: string = scriptRequest({ member: '测试成员', title: '测试直播' }, highlight, 87.4, 'QUJD', [
      { time: 110, nickname: '某个粉丝的昵称', message: '右上角' }
    ]).parts[0].text!;

    expect(prompt).toContain('「第一步的标题」');
    expect(prompt).toContain('「原话」');
    expect(prompt).toContain('（87 秒）');
    expect(prompt).toContain('右上角');
    expect(prompt).not.toContain('某个粉丝的昵称');
  });

  test('读出句子、标题、简介、看点', (): void => {
    const script: ReturnType<typeof readScript> = readScript({
      lines: [{ start: 1.5, end: 3, text: '一句话', keep: true, emphasis: ['一句'] }, { start: '4', end: 5, text: '另一句' }],
      title: ' 新标题 ',
      description: '第一句。第二句。',
      points: ['看点一', ' ', '看点二']
    }, highlight);

    expect(script.title).toBe('新标题');
    expect(script.description).toBe('第一句。第二句。');
    expect(script.points).toEqual(['看点一', '看点二']);
    expect(script.lines).toEqual([
      { start: 1.5, end: 3, text: '一句话', keep: true, emphasis: ['一句'] },
      { start: 4, end: 5, text: '另一句', keep: false, emphasis: [] }
    ]);
  });

  test('标题结尾的标点和外面的括号去掉，中间的留着', (): void => {
    expect(cleanTitle(' 没小号只能用大号夸自己！ ')).toBe('没小号只能用大号夸自己');
    expect(cleanTitle('「忘切小号？用大号自吹好萌」')).toBe('忘切小号？用大号自吹好萌');
    expect(readScript({ lines: [], title: '卡凳还卡电梯有多社死？！' }, highlight).title).toBe('卡凳还卡电梯有多社死');
  });

  test('没给标题、简介、看点时用第一步的', (): void => {
    const script: ReturnType<typeof readScript> = readScript({ lines: [] }, highlight);

    expect([script.title, script.description, script.points]).toEqual(['第一步的标题', '理由', ['封面的话']]);
  });
});

describe('挑封面', (): void => {
  test('图片按顺序给，说明有几张', (): void => {
    const request: GeminiAsk = coverRequest(['AAA', 'BBB', 'CCC']);

    expect(request.parts[0].text).toContain('3 张截图');
    expect(request.parts.slice(1).map((part: GeminiAsk['parts'][number]): string | undefined => part.inlineData?.data)).toEqual(['AAA', 'BBB', 'CCC']);
  });
});
