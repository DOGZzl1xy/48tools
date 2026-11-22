/**
 * B 站直播弹幕服务器的包格式（WebSocket 二进制帧）：
 *   16 字节的头（总长度 4、头长度 2 = 16、协议版本 2、操作码 4、序号 4，都是大端），后面是正文
 *   操作码：2 心跳、3 心跳回复（人气）、5 消息、7 认证、8 认证回复
 *   协议版本：0 / 1 正文是 JSON，2 zlib 压缩，3 brotli 压缩（解压后又是若干个包）
 * 这里只有和网络无关的编码解码，方便测试；连接、重连、写文件在 ./biliDanmuRecorder。
 */
export const OP_HEARTBEAT: number = 2;
export const OP_MESSAGE: number = 5;
export const OP_AUTH: number = 7;
export const OP_AUTH_REPLY: number = 8;

export function encodePacket(op: number, body: unknown): Buffer {
  const data: Buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const head: Buffer = Buffer.alloc(16);

  head.writeUInt32BE(16 + data.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);

  return Buffer.concat([head, data]);
}

export interface Decompress {
  brotli(data: Buffer): Buffer;
  inflate(data: Buffer): Buffer;
}

export interface DecodedFrame {
  messages: Array<Record<string, any>>; // 操作码 5 的消息（已经解析成 JSON）
  authReply?: string;                   // 认证回复
}

/* 解一帧：压缩的包解压后递归解；坏的部分跳过 */
export function decodeFrame(buf: Buffer, decompress: Decompress, out: DecodedFrame = { messages: [] }): DecodedFrame {
  let offset: number = 0;

  while (offset + 16 <= buf.length) {
    const length: number = buf.readUInt32BE(offset);
    const headLength: number = buf.readUInt16BE(offset + 4) || 16;
    const version: number = buf.readUInt16BE(offset + 6);
    const op: number = buf.readUInt32BE(offset + 8);

    if (length < headLength || offset + length > buf.length) break;

    const body: Buffer = buf.subarray(offset + headLength, offset + length);

    try {
      if (op === OP_MESSAGE && version === 3) {
        decodeFrame(decompress.brotli(body), decompress, out);
      } else if (op === OP_MESSAGE && version === 2) {
        decodeFrame(decompress.inflate(body), decompress, out);
      } else if (op === OP_MESSAGE) {
        const message: unknown = JSON.parse(body.toString('utf8'));

        if (message && typeof message === 'object') out.messages.push(message as Record<string, any>);
      } else if (op === OP_AUTH_REPLY) {
        out.authReply = body.toString('utf8');
      }
    } catch { /* 坏的包不管 */ }

    offset += length;
  }

  return out;
}

export interface LiveComment {
  text: string;
  nickname: string;  // 没登录时是空的或者打了码
  uid: number;
  kind: 'danmu' | 'superchat';
}

/* 弹幕（DANMU_MSG）和醒目留言（SUPER_CHAT_MESSAGE）；其他消息（进场、礼物、人气）返回 null */
export function commentOf(message: Record<string, any>): LiveComment | null {
  const cmd: string = String(message?.cmd ?? '').split(':')[0];

  if (cmd === 'DANMU_MSG' && Array.isArray(message.info)) {
    const text: string = String(message.info[1] ?? '').replace(/[\r\n\t]+/g, ' ').trim();

    if (!text) return null;

    return { text, nickname: String(message.info[2]?.[1] ?? '').replace(/[\r\n\t]+/g, ' ').trim(), uid: Number(message.info[2]?.[0]) || 0, kind: 'danmu' };
  }

  if (cmd === 'SUPER_CHAT_MESSAGE' && message.data) {
    const text: string = String(message.data.message ?? '').replace(/[\r\n\t]+/g, ' ').trim();

    if (!text) return null;

    return { text, nickname: String(message.data.user_info?.uname ?? '').trim(), uid: Number(message.data.uid) || 0, kind: 'superchat' };
  }

  return null;
}
