/* eslint-disable require-await */ // 假的 fetch 要返回 Promise，但里面没有什么可等的
/**
 * 录播自动切片里问 Gemini 的部分：提示里给了什么、结果怎么读、接口出错时怎么办。接口换成假的。
 */
import {
  geminiJson, findRequest, readFound, scriptRequest, readScript, stageTitlesRequest, readTitles, quoteTitle, isQuoteTitle, ownTitleFirst, coverRequest, cleanTitle, ContentRefused, pronoun,
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

  test('以内容为由拦下（blockReason、finishReason 是 SAFETY 这类）：报 ContentRefused，不重试', async (): Promise<void> => {
    const blocked: jest.Mock = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })));
    const safety: jest.Mock = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })));

    await expect(geminiJson(config, ask, undefined, blocked as unknown as typeof fetch)).rejects.toThrow(ContentRefused);
    expect(blocked).toHaveBeenCalledTimes(1);
    await expect(geminiJson(config, ask, undefined, safety as unknown as typeof fetch)).rejects.toThrow(ContentRefused);
    expect(safety).toHaveBeenCalledTimes(1);
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

  test('礼物消息不发；弹幕扎堆的时刻单独列出来', (): void => {
    const danmu: Array<{ time: number; nickname: string; message: string }> = [
      { time: 50, nickname: '甲', message: '送给SNH48-测试成员 1个荧光棒-SII' },
      ...['爆', '爆', '？？？', '哈哈哈哈', '典', '绷不住了'].map((message: string, index: number): { time: number; nickname: string; message: string } => (
        { time: 600 + index, nickname: '乙', message }))
    ];
    const prompt: string = findRequest({ member: '测试成员', title: '测试直播' }, { start: 0, length: 1_800 }, 'QUJD', danmu).parts[0].text!;

    expect(prompt).not.toContain('荧光棒');
    expect(prompt).toContain('<弹幕热度>');
    expect(prompt).toContain('10:00 起的 30 秒：6 条弹幕');
    expect(prompt).not.toContain('first、last');
  });

  test('走 agy 时多要开头、结尾的原话，读结果时带上', (): void => {
    const request: GeminiAsk = findRequest({ member: '测试成员', title: '测试直播' }, { start: 0, length: 1_800 }, 'QUJD', [], true);
    const found: ReturnType<typeof readFound> = readFound({
      summary: '', highlights: [{ start: '01:00', end: '02:00', title: '标题', score: 8, quote: '关键的话', first: ' 开头的话 ', last: '结尾的话' }]
    }, { start: 0, length: 1_800 });

    expect(request.parts[0].text).toContain('first、last');
    expect(JSON.stringify(request.schema)).toContain('"first"');
    expect([found.highlights[0].first, found.highlights[0].last]).toEqual(['开头的话', '结尾的话']);
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

  test('公演的失误：抄来的弹幕时间换成整场里的秒数；空的、看不懂的不要', (): void => {
    const found: ReturnType<typeof readFound> = readFound({
      summary: '',
      highlights: [
        { kind: 'mistake', start: '05:00', end: '06:00', title: '停音乐了', score: 9, reaction: '05:32' },
        { kind: 'mc', start: '08:00', end: '09:00', title: '聊天', score: 8, reaction: '' },
        { kind: 'mistake', start: '10:00', end: '11:00', title: '看不懂', score: 8, reaction: '大概十分钟' }
      ]
    }, { start: 1_800, length: 1_200 });

    expect(found.highlights.map((item: Highlight): number | undefined => item.reaction)).toEqual([2_132, undefined, undefined]);
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

  test('称呼的规则（提示词包里有的话）附在找片段和写字幕的提示后面', (): void => {
    const meta: { member: string; title: string } = { member: '测试成员', title: '测试直播' };

    expect(scriptRequest(meta, highlight, 60, 'QUJD', []).parts[0].text).toContain(pronoun());
    expect(findRequest(meta, { start: 0, length: 600 }, 'QUJD', []).parts[0].text).toContain(pronoun());
  });

  test('读出句子、标题、简介、看点', (): void => {
    const script: ReturnType<typeof readScript> = readScript({
      lines: [{ start: 1.5, end: 3, text: '一句话', keep: true, emphasis: ['一句'] }, { start: '4', end: 5, text: '另一句' }],
      titles: [' 新标题 ', '第二个标题。', '新标题', '', '第三个标题？', '第四个不要'],
      description: '第一句。第二句。',
      points: ['看点一', ' ', '看点二']
    }, highlight);

    expect(script.title).toBe('新标题');
    expect(script.titles).toEqual(['新标题', '第二个标题', '第三个标题？']);
    expect(script.more).toEqual([]);
    expect(script.description).toBe('第一句。第二句。');
    expect(script.points).toEqual(['看点一', '看点二']);
    expect(script.lines).toEqual([
      { start: 1.5, end: 3, text: '一句话', keep: true, emphasis: ['一句'] },
      { start: 4, end: 5, text: '另一句', keep: false, emphasis: [] }
    ]);
  });

  test('标题结尾的句号感叹号和外面的书名号去掉；中间的标点、结尾的问号和括号吐槽留着', (): void => {
    expect(cleanTitle(' 没小号只能用大号夸自己！ ')).toBe('没小号只能用大号夸自己');
    expect(cleanTitle('「忘切小号？用大号自吹好萌」')).toBe('忘切小号？用大号自吹好萌');
    expect(cleanTitle('北大不比北芭差（bushi）。')).toBe('北大不比北芭差（bushi）');
    expect(cleanTitle('这算不算一种自产自销?')).toBe('这算不算一种自产自销？');
    // 【】：整个包起来的是模型加的包装，去掉；标题中间的是公演封面上刷荧光笔的记号，留着；不成对的去掉
    expect(cleanTitle('【整个包起来】')).toBe('整个包起来');
    expect(cleanTitle('娜姐【耳朵红了】')).toBe('娜姐【耳朵红了】');
    expect(cleanTitle('【撞号】现场争姐一。')).toBe('【撞号】现场争姐一');
    expect(cleanTitle('娜姐【耳朵红了')).toBe('娜姐耳朵红了');
    expect(readScript({ lines: [], title: '卡凳还卡电梯有多社死？！' }, highlight).title).toBe('卡凳还卡电梯有多社死？');
  });

  test('片段里另外的爆点：最多两个，不和标题重复', (): void => {
    const script: ReturnType<typeof readScript> = readScript({
      lines: [], titles: ['全队全是萝莉', '第二个'], more: ['傻瓜也是瓜。', '全队全是萝莉', ' ', '铁T认证', '第三个不要']
    }, highlight);

    expect(script.more).toEqual(['傻瓜也是瓜', '铁T认证']);
  });

  test('没给标题、简介、看点时用第一步的', (): void => {
    const script: ReturnType<typeof readScript> = readScript({ lines: [] }, highlight);

    expect([script.title, script.titles, script.description, script.points, script.people]).toEqual(['第一步的标题', ['第一步的标题'], '理由', ['封面的话'], []]);
  });

  test('其他主角：提示里要 people；读结果时去掉主播自己', (): void => {
    const prompt: string = scriptRequest({ member: '测试成员', title: '测试直播' }, highlight, 60, 'QUJD', []).parts[0].text!;

    expect(prompt).toContain('people');
    expect(readScript({ lines: [], people: ['测试成员', 'SNH48-成员乙'] }, highlight, 'SNH48 测试成员').people).toEqual(['成员乙']);
  });

  test('改过的标题和说明交给写字幕那一步', (): void => {
    const script: (item: Highlight) => string = (item: Highlight): string => scriptRequest({ member: 'SNH48 测试成员', title: '测试' }, item, 60, '', []).parts[0].text ?? '';

    expect(script({ ...highlight, title: '改过的标题', reason: '她说的是乙', edited: true })).toContain('主题是：「改过的标题」');
    expect(script({ ...highlight, title: '改过的标题', reason: '她说的是乙', edited: true })).toContain('「她说的是乙」');
  });

  test('没给标题：从原话里截一小段，字不变；连原话都没有的不要', (): void => {
    expect(quoteTitle('我不是，我没有，你别瞎说啊我跟你讲')).toBe('我不是我没有');
    expect(quoteTitle('「你怎么不去当阿凡达呢？」')).toBe('你怎么不去当阿凡达呢');
    expect(quoteTitle('一二三四五六七八九十一二三四五六七八九十')).toBe('一二三四五六七八九十一二三四五六');
    expect(quoteTitle(' ')).toBe('');

    const at: { start: string; end: string; reason: string; score: number } = { start: '00:10', end: '01:10', reason: '', score: 8 };
    const titles: Array<string> = readFound({
      highlights: [{ ...at, title: '', quote: '我要退网了，真的' }, { ...at, title: '', quote: '' }, { ...at, title: '', quote: '第一句歌词', kind: 'song' }]
    }, { start: 0, length: 600 }).highlights.map((item: Highlight): string => item.title);

    expect(titles).toEqual(['我要退网了真的']);
  });

  test('截原话的标题不放第一个：后面有自己想的就换到前面，全是原话的不动', (): void => {
    const spoken: string = '然后我就说，你急什么呀又没说你，她就不说话了';

    expect(isQuoteTitle('你急什么呀又没说你', spoken)).toBe(true);
    expect(isQuoteTitle('你急什么呀，又没说她', spoken)).toBe(true);      // 8 个字以上容许错一个字
    expect(isQuoteTitle('你急什么又没说她', spoken)).toBe(false);          // 少了字、又错了字
    expect(isQuoteTitle('不说话', spoken)).toBe(false);                    // 太短的不算
    expect(isQuoteTitle('她就不说话了', spoken)).toBe(true);
    expect(isQuoteTitle('她就不讲话了', spoken)).toBe(false);
    expect(isQuoteTitle('她就不说话了后来呢然后呢', '她就不说话了')).toBe(false);

    expect(ownTitleFirst(['你急什么呀又没说你', '全队最急的人', '又没说你'], [spoken])).toEqual(['全队最急的人', '你急什么呀又没说你', '又没说你']);
    expect(ownTitleFirst(['全队最急的人', '你急什么呀又没说你'], [spoken])).toEqual(['全队最急的人', '你急什么呀又没说你']);
    expect(ownTitleFirst(['你急什么呀又没说你', '她就不说话了'], [spoken])).toEqual(['你急什么呀又没说你', '她就不说话了']);
    expect(ownTitleFirst([], [spoken])).toEqual([]);

    // 写字幕的结果：原话跨两句字幕也认得出；字幕里没有、只在最关键的那句话里的也认
    const line: { start: number; end: number; keep: boolean } = { start: 0, end: 1, keep: true };
    const script: ReturnType<typeof readScript> = readScript({
      lines: [{ ...line, text: '你急什么呀' }, { ...line, text: '又没说你' }], titles: ['你急什么呀又没说你', '我已经说服了我自己', '全队最急的人']
    }, { ...highlight, quote: '我已经说服了我自己，真的' });

    expect([script.title, script.titles]).toEqual(['全队最急的人', ['全队最急的人', '你急什么呀又没说你', '我已经说服了我自己']]);
  });

  test('公演唱歌、失误的片段只问标题：说清楚是哪首歌、谁唱的，带上说明和自己取的封面标题', (): void => {
    const stage: Parameters<typeof stageTitlesRequest>[2] = { team: 'X', teamColor: '#a9ca27', show: '《示例公演》', date: '2026.11.21' };
    const meta: { member: string; title: string } = { member: 'SNH48 TEAM X', title: '《示例公演》' };
    const song: Highlight = { ...highlight, kind: 'song', song: '《示例歌》', singers: ['甲', '乙'], coverTitle: '我取的标题' };
    const prompt: string = stageTitlesRequest(meta, song, stage).parts[0].text!;

    expect(prompt).toContain('一首歌《示例歌》，演唱的是甲、乙');
    expect(prompt).toContain('说明是：「理由」');
    expect(prompt).toContain('「我取的标题」');
    expect(stageTitlesRequest(meta, { ...song, kind: 'mistake' }, stage).parts[0].text).toContain('表演中的一个失误或意外');
    expect(readTitles([' 一。', '一', '', '二', '三', '四'])).toEqual(['一', '二', '三']);
    expect(readTitles(undefined)).toEqual([]);
  });

  test('剪完长度不对、重做时把原因告诉模型', (): void => {
    const prompt: string = scriptRequest({ member: '测试成员', title: '测试直播' }, highlight, 150, 'QUJD', [], '上一次剪出来只有 31 秒').parts[0].text!;

    expect(prompt).toContain('注意：上一次剪出来只有 31 秒');
  });
});

describe('挑封面', (): void => {
  test('图片按顺序给，说明有几张', (): void => {
    const request: GeminiAsk = coverRequest(['AAA', 'BBB', 'CCC']);

    expect(request.parts[0].text).toContain('3 张截图');
    expect(request.parts.slice(1).map((part: GeminiAsk['parts'][number]): string | undefined => part.inlineData?.data)).toEqual(['AAA', 'BBB', 'CCC']);
  });
});
