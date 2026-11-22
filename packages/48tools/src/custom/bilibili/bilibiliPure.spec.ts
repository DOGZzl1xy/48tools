/**
 * B 站公演录制里和网络无关的部分：WBI 签名、弹幕包的编码解码、什么时候查、录哪些队。
 */
import * as zlib from 'node:zlib';
import { wbiKeyOf, mixinKeyOf, signWbi } from './biliWbi';
import { encodePacket, decodeFrame, commentOf, OP_MESSAGE, OP_AUTH_REPLY, type Decompress } from './biliDanmuProtocol';
import { beijingClock, inWatchWindow, teamOfShow, liveWantedShows, showNameOf } from './gongyanSchedule';

const decompress: Decompress = { brotli: (b: Buffer): Buffer => zlib.brotliDecompressSync(b), inflate: (b: Buffer): Buffer => zlib.inflateSync(b) };

function frame(op: number, version: number, body: Buffer): Buffer {
  const head: Buffer = Buffer.alloc(16);

  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(version, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);

  return Buffer.concat([head, body]);
}

describe('WBI 签名', (): void => {
  test('从图片地址取 key，按表重排取 32 位，参数排序后加 wts 和 w_rid', (): void => {
    expect(wbiKeyOf('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe('7cd084941338484aae1ad9425b84077c');

    const mixin: string = mixinKeyOf('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');

    expect(mixin).toBe('ea1db124af3c7062474693fa704f4ff8'); // 公开文档里的例子
    expect(signWbi({ foo: '114', bar: '514', zab: 1919810 }, mixin, 1702204169))
      .toBe('bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
    expect(signWbi({ a: "x!'()*y" }, mixin, 1)).toContain('a=xy&');
  });
});

describe('弹幕包', (): void => {
  test('编码：16 字节头 + 正文', (): void => {
    const packet: Buffer = encodePacket(7, { roomid: 1 });

    expect(packet.readUInt32BE(0)).toBe(packet.length);
    expect(packet.readUInt32BE(8)).toBe(7);
    expect(JSON.parse(packet.subarray(16).toString())).toEqual({ roomid: 1 });
  });

  test('解码：brotli 压缩的里面有好几条消息；认证回复；坏的包跳过', (): void => {
    const inner: Buffer = Buffer.concat([
      frame(OP_MESSAGE, 0, Buffer.from(JSON.stringify({ cmd: 'DANMU_MSG', info: [[], '哈哈哈', [123, '路人甲']] }))),
      frame(OP_MESSAGE, 0, Buffer.from(JSON.stringify({ cmd: 'INTERACT_WORD_V2' }))),
      frame(OP_MESSAGE, 0, Buffer.from('{坏的'))
    ]);
    const decoded: ReturnType<typeof decodeFrame> = decodeFrame(Buffer.concat([
      frame(OP_MESSAGE, 3, zlib.brotliCompressSync(inner)),
      frame(OP_AUTH_REPLY, 1, Buffer.from('{"code":0}'))
    ]), decompress);

    expect(decoded.messages.map((m: Record<string, any>): string => m.cmd)).toEqual(['DANMU_MSG', 'INTERACT_WORD_V2']);
    expect(decoded.authReply).toBe('{"code":0}');
  });

  test('弹幕和醒目留言取出内容和昵称；其他消息不要', (): void => {
    expect(commentOf({ cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [[], ' 笑死\n了 ', [1, '路人甲']] })).toEqual({ text: '笑死 了', nickname: '路人甲', uid: 1, kind: 'danmu' });
    expect(commentOf({ cmd: 'SUPER_CHAT_MESSAGE', data: { message: '加油', uid: 2, user_info: { uname: '路人乙' } } }))
      .toEqual({ text: '加油', nickname: '路人乙', uid: 2, kind: 'superchat' });
    expect(commentOf({ cmd: 'SEND_GIFT', data: {} })).toBeNull();
    expect(commentOf({ cmd: 'DANMU_MSG', info: [[], '  ', [0, '']] })).toBeNull();
  });
});

describe('公演：什么时候查、录哪些队', (): void => {
  test('北京时间：本机时区不影响', (): void => {
    expect(beijingClock(new Date('2026-11-21T05:30:00Z'))).toEqual({ minutes: (13 * 60) + 30, day: '2026-11-21' });
    expect(beijingClock(new Date('2026-11-21T17:00:00Z'))).toEqual({ minutes: 60, day: '2026-11-22' });
  });

  test('只在 13:30、18:30（19:30）前后查', (): void => {
    expect(inWatchWindow(new Date('2026-11-21T05:25:00Z'))).toBe(true);  // 13:25
    expect(inWatchWindow(new Date('2026-11-21T07:00:00Z'))).toBe(false); // 15:00
    expect(inWatchWindow(new Date('2026-11-21T11:30:00Z'))).toBe(true);  // 19:30
    expect(inWatchWindow(new Date('2026-11-21T14:00:00Z'))).toBe(false); // 22:00
  });

  test('认队伍：Team X、NII、HII；GNZ48 的 NIII 不算 NII；标题里的 Fire X 不算 X 队', (): void => {
    expect(teamOfShow({ title: '《Fire X》2.0公演', subTitle: 'Team X 剧场公演' })).toBe('X');
    expect(teamOfShow({ title: '《你好朋友》公演', subTitle: 'TEAM NII 剧场公演' })).toBe('NII');
    expect(teamOfShow({ title: '某公演', subTitle: 'Team HII 剧场公演' })).toBe('HII');
    expect(teamOfShow({ title: '某公演', subTitle: 'Team NIII 剧场公演' })).toBeUndefined();
    expect(teamOfShow({ title: '《Fire X》2.0公演', subTitle: '剧场公演' })).toBeUndefined();
    expect(teamOfShow({ title: '某公演', subTitle: 'Team SII 剧场公演' })).toBe('SII');
  });

  test('公演名：去掉前面的队名和后面的「公演」', (): void => {
    expect(showNameOf('《Fire X》2.0公演')).toBe('《Fire X》2.0');
    expect(showNameOf('Team NII《示例》剧场公演')).toBe('《示例》');
    expect(showNameOf('X队《示例》公演 ')).toBe('《示例》');
    expect(showNameOf('公演')).toBe('公演');
  });

  test('正在直播、而且是 HII / NII / X 的才录', (): void => {
    const list: Array<{ liveId: string; title: string; subTitle: string; status: number }> = [
      { liveId: '1', title: 'A', subTitle: 'Team X 剧场公演', status: 2 },
      { liveId: '2', title: 'B', subTitle: 'Team SII 剧场公演', status: 2 },
      { liveId: '3', title: 'C', subTitle: 'Team NII 剧场公演', status: 1 },
      { liveId: '4', title: 'D', subTitle: 'Team HII 剧场公演', status: 2 }
    ];

    expect(liveWantedShows(list).map((show: { liveId: string; team: string }): string => `${ show.liveId }:${ show.team }`)).toEqual(['1:X', '4:HII']);
  });
});
