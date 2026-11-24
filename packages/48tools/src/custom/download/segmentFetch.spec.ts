/**
 * 分片停住后从断点走代理补完。请求用假的流：按给的步骤出数据、停住、断开。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { fetchSegmentFile, STALL_MS } from './segmentFetch';

const DATA: Buffer = Buffer.from('0123456789abcdefghij'); // 一个分片，20 字节

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  send?: Buffer;             // 给多少数据
  then?: 'end' | 'stall' | 'abort'; // 给完以后：正常结束、停住不动、断开
  refuse?: number;           // 直接报 HTTP 错误
}

interface Call {
  viaProxy: boolean;
  range?: string;
}

function fakeStream(reply: Reply): Readable {
  const stream: PassThrough = new PassThrough();

  setTimeout((): void => {
    if (reply.refuse) {
      stream.destroy(Object.assign(new Error(`Response code ${ reply.refuse }`), { response: { statusCode: reply.refuse } }));

      return;
    }

    if (reply.headers) stream.emit('response', { statusCode: reply.status ?? 200, headers: reply.headers });

    reply.send && stream.write(reply.send);

    if (reply.then === 'abort') setTimeout((): unknown => stream.destroy(new Error('The server aborted pending request')), 20);

    if ((reply.then ?? 'end') === 'end') stream.end();
  }, 5);

  return stream;
}

const whole: Record<string, string> = { 'content-length': String(DATA.length) };

function rest(from: number, total: number = DATA.length): Reply {
  return { status: 206, headers: { 'content-range': `bytes ${ from }-${ total - 1 }/${ total }` }, send: DATA.subarray(from) };
}

describe('segmentFetch：停住的分片从断点走代理补', (): void => {
  let dir: string;
  let file: string;
  let calls: Array<Call>;
  let warn: jest.SpyInstance;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-fetch-'));
    file = path.join(dir, 'a.ts');
    calls = [];
    warn = jest.spyOn(console, 'warn').mockImplementation((): void => undefined);
  });

  afterEach((): void => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fetch(replies: { direct?: Reply; proxy?: Reply }, options: {
    attempt?: number; hasProxy?: boolean; signal?: AbortSignal; isStopped?(): boolean;
  } = {}): Promise<number> {
    return fetchSegmentFile({
      file,
      hasProxy: true,
      stall: 120,
      ...options,
      open(viaProxy: boolean, headers: Record<string, string>): Readable {
        calls.push({ viaProxy, range: headers.Range });

        return fakeStream((viaProxy ? replies.proxy : replies.direct) ?? { refuse: 500 });
      }
    });
  }

  test('10 秒没有新数据算停住', (): void => {
    expect(STALL_MS).toBe(10_000);
  });

  test('正常的分片只直连', async (): Promise<void> => {
    expect(await fetch({ direct: { headers: whole, send: DATA } })).toBe(20);
    expect(fs.readFileSync(file)).toEqual(DATA);
    expect(calls).toEqual([{ viaProxy: false, range: undefined }]);
  });

  test('停在中间：从断点走代理补完，拼起来一个字节都不差', async (): Promise<void> => {
    expect(await fetch({ direct: { headers: whole, send: DATA.subarray(0, 8), then: 'stall' }, proxy: rest(8) })).toBe(20);
    expect(fs.readFileSync(file)).toEqual(DATA);
    expect(calls).toEqual([{ viaProxy: false, range: undefined }, { viaProxy: true, range: 'bytes=8-' }]);
  });

  test('一直等不到响应：整个走代理', async (): Promise<void> => {
    expect(await fetch({ direct: { then: 'stall' }, proxy: { headers: whole, send: DATA } })).toBe(20);
    expect(fs.readFileSync(file)).toEqual(DATA);
    expect(calls[1]).toEqual({ viaProxy: true, range: undefined });
  });

  test('服务器半路断开：也从断点走代理补', async (): Promise<void> => {
    expect(await fetch({ direct: { headers: whole, send: DATA.subarray(0, 15), then: 'abort' }, proxy: rest(15) })).toBe(20);
    expect(fs.readFileSync(file)).toEqual(DATA);
  });

  test('没报错但是少了一截：核对大小发现，走代理补', async (): Promise<void> => {
    expect(await fetch({ direct: { headers: whole, send: DATA.subarray(0, 12) }, proxy: rest(12) })).toBe(20);
    expect(fs.readFileSync(file)).toEqual(DATA);
  });

  test('数据都收到了、只是连接没有结束：不用补', async (): Promise<void> => {
    expect(await fetch({ direct: { headers: whole, send: DATA, then: 'stall' } })).toBe(20);
    expect(calls).toHaveLength(1);
  });

  test('代理不认断点、给了整个：从头写', async (): Promise<void> => {
    expect(await fetch({ direct: { headers: whole, send: DATA.subarray(0, 8), then: 'stall' }, proxy: { headers: whole, send: DATA } })).toBe(20);
    expect(fs.readFileSync(file)).toEqual(DATA);
  });

  test('补完大小对不上：报错，交给重试', async (): Promise<void> => {
    await expect(fetch({
      direct: { headers: whole, send: DATA.subarray(0, 8), then: 'stall' },
      proxy: { status: 206, headers: { 'content-range': 'bytes 8-19/20' }, send: DATA.subarray(8, 15) }
    })).rejects.toThrow('分片没有下完整（15/20）');
    await expect(fetch({
      direct: { headers: whole, send: DATA.subarray(0, 8), then: 'stall' }, proxy: rest(8, 30)
    })).rejects.toThrow('两边的大小不一样（20 和 30）');
    await expect(fetch({
      direct: { headers: whole, send: DATA.subarray(0, 8), then: 'stall' }, proxy: rest(9)
    })).rejects.toThrow('续传的位置不对');
  });

  test('没有代理：不管停住，照旧等服务器断开再报错', async (): Promise<void> => {
    await expect(fetch({ direct: { headers: whole, send: DATA.subarray(0, 8), then: 'abort' } }, { hasProxy: false })).rejects.toThrow('aborted');
    expect(calls).toEqual([{ viaProxy: false, range: undefined }]);
  });

  test('录播没了（404）：不走代理；服务器出错（502）：走代理', async (): Promise<void> => {
    await expect(fetch({ direct: { refuse: 404 }, proxy: { headers: whole, send: DATA } })).rejects.toThrow('404');
    expect(calls).toHaveLength(1);
    expect(await fetch({ direct: { refuse: 502 }, proxy: { headers: whole, send: DATA } })).toBe(20);
  });

  test('第三次起整个走代理', async (): Promise<void> => {
    expect(await fetch({ proxy: { headers: whole, send: DATA } }, { attempt: 2 })).toBe(20);
    expect(calls).toEqual([{ viaProxy: true, range: undefined }]);
  });

  test('停止下载：马上断开，不再改走代理', async (): Promise<void> => {
    const controller: AbortController = new AbortController();

    setTimeout((): void => controller.abort(), 40);
    await expect(fetch({ direct: { headers: whole, send: DATA.subarray(0, 8), then: 'stall' }, proxy: rest(8) }, { signal: controller.signal })).rejects.toThrow('已停止下载');
    await expect(fetch({ direct: { headers: whole, send: DATA.subarray(0, 8), then: 'abort' }, proxy: rest(8) }, { isStopped: (): boolean => true })).rejects.toThrow('aborted');
    expect(calls.filter((call: Call): boolean => call.viaProxy)).toHaveLength(0);
  });

  test('空的分片报错', async (): Promise<void> => {
    await expect(fetch({ direct: { headers: {} } })).rejects.toThrow('空的');
  });
});
