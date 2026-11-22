/**
 * 录 B 站弹幕：用假的连接测连上后发认证、收到弹幕写进文件（和口袋48弹幕文件一样的格式）、断了会重连。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BiliDanmuRecorder, lrcLine, lrcTime, type SocketLike } from './biliDanmuRecorder';
import { OP_AUTH, OP_MESSAGE } from './biliDanmuProtocol';
import { parseLrc } from '../highlight/highlightTime';
import type { DanmuConnectInfo } from './biliApi';

jest.mock('./biliApi', (): unknown => ({ danmuConnect: jest.fn() })); // 真的那个要联网（got），测试里用 connectInfo 代替

class FakeSocket implements SocketLike {
  binaryType: string = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Buffer> = [];
  closed: boolean = false;

  constructor(public url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(Buffer.from(data));
  }

  close(): void {
    this.closed = true;
  }
}

function frame(op: number, body: unknown): ArrayBuffer {
  const json: Buffer = Buffer.from(JSON.stringify(body));
  const head: Buffer = Buffer.alloc(16);

  head.writeUInt32BE(16 + json.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(0, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);

  const all: Buffer = Buffer.concat([head, json]);
  const out: ArrayBuffer = new ArrayBuffer(all.length);

  new Uint8Array(out).set(all);

  return out;
}

const info: DanmuConnectInfo = { hosts: ['a.example', 'b.example'], token: 'TOKEN', uid: 0, buvid: 'BUVID' };

describe('B 站弹幕录制', (): void => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-danmu-'));
    jest.useFakeTimers();
  });

  afterEach((): void => {
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('时间和一行的格式；换行、制表符不会把一行拆坏', (): void => {
    expect(lrcTime(3_723_045)).toBe('[01:02:03.045]');
    expect(lrcLine({ text: '哈\t哈\n哈', nickname: '路\t人', uid: 1, kind: 'danmu' }, 1_500)).toBe('[00:00:01.500]路 人\t哈 哈 哈\n');
    expect(lrcLine({ text: '加油', nickname: '', uid: 1, kind: 'superchat' }, 0)).toBe('[00:00:00.000]\t【醒目留言】加油\n');
  });

  test('连上后发认证；收到的弹幕写进文件，parseLrc 读得回来；断了换一个服务器重连', async (): Promise<void> => {
    const sockets: Array<FakeSocket> = [];
    let now: number = 10_000;
    const file: string = path.join(dir, 'danmu.lrc');
    const counts: Array<number> = [];
    const recorder: BiliDanmuRecorder = new BiliDanmuRecorder({
      roomId: 63727,
      file,
      startedAt: 10_000,
      onCount: (count: number): unknown => counts.push(count),
      connectInfo: (): Promise<DanmuConnectInfo> => Promise.resolve(info),
      createSocket(url: string): SocketLike {
        const socket: FakeSocket = new FakeSocket(url);

        sockets.push(socket);

        return socket;
      },
      now: (): number => now
    });

    recorder.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(sockets.map((s: FakeSocket): string => s.url)).toEqual(['wss://a.example/sub']);

    sockets[0].onopen?.();

    const auth: Buffer = sockets[0].sent[0];

    expect(auth.readUInt32BE(8)).toBe(OP_AUTH);
    expect(JSON.parse(auth.subarray(16).toString())).toMatchObject({ roomid: 63727, key: 'TOKEN', buvid: 'BUVID', protover: 3 });

    now = 75_500; // 开始录 65.5 秒后
    sockets[0].onmessage?.({ data: frame(OP_MESSAGE, { cmd: 'DANMU_MSG', info: [[], '笑死', [1, '']] }) });
    sockets[0].onmessage?.({ data: frame(OP_MESSAGE, { cmd: 'SEND_GIFT', data: {} }) });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(parseLrc(fs.readFileSync(file, 'utf8'))).toEqual([{ time: 65.5, nickname: '', message: '笑死' }]);
    expect(counts).toEqual([1]);

    // 断了：2 秒后重连，换下一个服务器
    sockets[0].onclose?.();
    expect(sockets[0].closed).toBe(true);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(sockets.map((s: FakeSocket): string => s.url)).toEqual(['wss://a.example/sub', 'wss://b.example/sub']);

    expect(recorder.stop()).toBe(1);
    expect(sockets[1].closed).toBe(true);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2); // 停止以后不再连
  });

  test('70 秒什么都没收到就重连', async (): Promise<void> => {
    const sockets: Array<FakeSocket> = [];
    let now: number = 0;
    const recorder: BiliDanmuRecorder = new BiliDanmuRecorder({
      roomId: 1,
      file: path.join(dir, 'danmu.lrc'),
      startedAt: 0,
      connectInfo: (): Promise<DanmuConnectInfo> => Promise.resolve(info),
      createSocket(url: string): SocketLike {
        const socket: FakeSocket = new FakeSocket(url);

        sockets.push(socket);

        return socket;
      },
      now: (): number => now
    });

    recorder.start();
    await jest.advanceTimersByTimeAsync(0);
    now = 90_000;
    await jest.advanceTimersByTimeAsync(30_000); // 心跳时发现太久没收到
    await jest.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    recorder.stop();
  });
});
