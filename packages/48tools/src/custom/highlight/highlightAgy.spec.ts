/**
 * 录播自动切片里走本机 agy 的部分：格式说明怎么转、音频和图片怎么变成文件、怎么读它的回答。不真的运行 agy。
 */
import { toJsonSchema, agyInput, firstJson, readAgyResult, type AgyAsk } from './highlightAgy';

function result(response: unknown, status: string = 'SUCCESS'): string {
  return [
    '{"event":"init","init":{"model":"test"}}',
    '不是 JSON 的一行',
    JSON.stringify({ event: 'step_update', step_update: { text_delta: '…' } }),
    JSON.stringify({ event: 'result', result: { status, response } })
  ].join('\n');
}

describe('toJsonSchema', (): void => {
  test('类型从大写变成小写，别的不动', (): void => {
    expect(toJsonSchema({
      type: 'OBJECT',
      properties: { list: { type: 'ARRAY', items: { type: 'STRING' } }, score: { type: 'NUMBER' }, type: { type: 'BOOLEAN' } },
      required: ['list']
    })).toEqual({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string' } }, score: { type: 'number' }, type: { type: 'boolean' } },
      required: ['list']
    });
  });
});

describe('agyInput', (): void => {
  const ask: AgyAsk = {
    parts: [
      { text: '请听这段音频' },
      { inlineData: { mimeType: 'audio/mp3', data: 'QUJD' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAA' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BBB' } }
    ],
    schema: { type: 'OBJECT', properties: { best: { type: 'INTEGER' } }, required: ['best'] }
  };

  test('音频、图片变成文件，提示里说明文件名、只许读这些文件', (): void => {
    const input: ReturnType<typeof agyInput> = agyInput(ask);

    expect(input.files).toEqual([{ name: 'audio-1.mp3', data: 'QUJD' }, { name: 'image-1.jpg', data: 'AAA' }, { name: 'image-2.jpg', data: 'BBB' }]);
    expect(input.prompt.startsWith('请听这段音频')).toBe(true);
    expect(input.prompt).toContain('当前文件夹里的 audio-1.mp3');
    expect(input.prompt).toContain('image-1.jpg、image-2.jpg（按这个顺序是第 1 到第 2 张）');
    expect(input.prompt).toContain('不要运行任何命令');
  });

  test('要的格式写在提示的最后（小写类型的 JSON Schema）', (): void => {
    expect(agyInput(ask).prompt.endsWith('{"type":"object","properties":{"best":{"type":"integer"}},"required":["best"]}')).toBe(true);
  });

  test('没有文件时不提文件', (): void => {
    const input: ReturnType<typeof agyInput> = agyInput({ parts: [{ text: '只有文字' }], schema: { type: 'OBJECT' } });

    expect(input.files).toEqual([]);
    expect(input.prompt).not.toContain('读文件');
  });
});

describe('firstJson', (): void => {
  test('只取第一个完整的 JSON：后面再跟一个 JSON、一句话、代码块标记都不影响', (): void => {
    expect(firstJson('{"a": [1, 2], "b": {"c": "x"}}\n{"a": ["废话"]}')).toBe('{"a": [1, 2], "b": {"c": "x"}}');
    expect(firstJson('```json\n{"a": 1}\n```\n以上是结果')).toBe('{"a": 1}');
    expect(firstJson('好的：[{"a": 1}, {"a": 2}] 完毕')).toBe('[{"a": 1}, {"a": 2}]');
  });

  test('字符串里的括号和引号不算', (): void => {
    expect(firstJson('{"text": "她说 \\"}{\\" 然后笑了 ]"} 多余的 }')).toBe('{"text": "她说 \\"}{\\" 然后笑了 ]"}');
  });

  test('没有 JSON、JSON 没写完：null', (): void => {
    expect(firstJson('没有')).toBeNull();
    expect(firstJson('{"a": [1, 2')).toBeNull();
  });
});

describe('readAgyResult', (): void => {
  test('读最后那个 result 事件里的回答', (): void => {
    expect(readAgyResult(result('{"ok": 1}'))).toEqual({ ok: 1 });
    expect(readAgyResult(result({ ok: 2 }))).toEqual({ ok: 2 });
  });

  test('回答后面跟着第二个 JSON（agy 自己加的总结）：用第一个', (): void => {
    expect(readAgyResult(result('{"titles": ["真的标题"]}\n{"titles": ["对任务的总结"]}\n'))).toEqual({ titles: ['真的标题'] });
  });

  test('没成功、没有结果、不是 JSON：报错', (): void => {
    expect((): unknown => readAgyResult(result('', 'ERROR'))).toThrow('agy 没有成功（ERROR）');
    expect((): unknown => readAgyResult('{"event":"init"}')).toThrow('agy 没有返回结果');
    expect((): unknown => readAgyResult(result('抱歉，我听不了这个音频'))).toThrow('格式不对');
  });
});
