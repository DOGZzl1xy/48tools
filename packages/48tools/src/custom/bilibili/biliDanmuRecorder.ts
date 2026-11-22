import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { encodePacket, decodeFrame, commentOf, OP_AUTH, OP_HEARTBEAT, type Decompress, type LiveComment } from './biliDanmuProtocol';
import { danmuConnect, type DanmuConnectInfo } from './biliApi';

/**
 * 录 B 站直播间的弹幕：连弹幕服务器（浏览器自带的 WebSocket，界面进程里就能用），收到的弹幕和醒目留言写进一个文件，
 * 格式和口袋48录播的弹幕文件一样（[00:05:43.453]昵称\t内容，时间从开始录制算），切片时直接读（highlight/highlightTime 的 parseLrc）。
 *   - 每 30 秒发一次心跳；70 秒什么都没收到、或者连接断了就重连（越来越慢，最多一分钟一次），一直到停止
 *   - 攒两秒写一次文件
 *   - 没登录 B 站时收得到弹幕内容，但看不到昵称（B 站的规定）
 * 接入点：./gongyanRecorder。
 */
export interface SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface DanmuRecorderOptions {
  roomId: number;               // 实际房间号
  file: string;                 // 写到哪个文件
  startedAt: number;            // 录制开始的时间（毫秒），弹幕的时间从这里算
  onCount?(count: number): void;
  // 测试用
  connectInfo?(roomId: number): Promise<DanmuConnectInfo>;
  createSocket?(url: string): SocketLike;
  now?(): number;
}

const HEARTBEAT_MS: number = 30_000;
const SILENT_MS: number = 70_000;
const FLUSH_MS: number = 2_000;
const RETRY_MS: Array<number> = [2_000, 5_000, 15_000, 30_000, 60_000];
const FALLBACK_HOST: string = 'broadcastlv.chat.bilibili.com';
const decompress: Decompress = {
  brotli: (data: Buffer): Buffer => zlib.brotliDecompressSync(data),
  inflate: (data: Buffer): Buffer => zlib.inflateSync(data)
};

/* 毫秒写成 [00:05:43.453] */
export function lrcTime(ms: number): string {
  const total: number = Math.max(0, Math.round(ms));
  const pad: (n: number, w?: number) => string = (n: number, w: number = 2): string => String(n).padStart(w, '0');

  return `[${ pad(Math.floor(total / 3_600_000)) }:${ pad(Math.floor((total % 3_600_000) / 60_000)) }:${ pad(Math.floor((total % 60_000) / 1_000)) }.${ pad(total % 1_000, 3) }]`;
}

/* 一行弹幕；昵称、内容里的换行和制表符换成空格（不然会把一行拆坏） */
export function lrcLine(comment: LiveComment, offset: number): string {
  const clean: (value: string) => string = (value: string): string => value.replace(/[\t\r\n]+/g, ' ').trim();
  const text: string = clean(comment.text);

  return `${ lrcTime(offset) }${ clean(comment.nickname) }\t${ comment.kind === 'superchat' ? `【醒目留言】${ text }` : text }\n`;
}

export class BiliDanmuRecorder {
  private options: DanmuRecorderOptions;
  private socket: SocketLike | undefined;
  private pending: Array<string> = [];
  private count: number = 0;
  private reported: number = 0;
  private failures: number = 0;
  private lastSeen: number = 0;
  private stopped: boolean = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DanmuRecorderOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    this.stopped = false;
    this.timers.push(setInterval((): void => this.flush(), FLUSH_MS));
    this.timers.push(setInterval((): void => this.tick(), HEARTBEAT_MS));
    void this.connect();
  }

  /* 停止：写完剩下的，返回一共存了多少条 */
  stop(): number {
    this.stopped = true;
    this.timers.forEach((timer: ReturnType<typeof setInterval>): void => clearInterval(timer));
    this.timers = [];
    clearTimeout(this.retryTimer);
    this.closeSocket();
    this.flush();

    return this.count;
  }

  private closeSocket(): void {
    const socket: SocketLike | undefined = this.socket;

    this.socket = undefined;

    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;

      try {
        socket.close();
      } catch { /* noop */ }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let info: DanmuConnectInfo;

    try {
      info = await (this.options.connectInfo ?? danmuConnect)(this.options.roomId);
    } catch (err) {
      console.warn('B 站弹幕：取不到服务器地址，稍后再试', err);
      this.retryLater();

      return;
    }

    if (this.stopped) return;

    const host: string = info.hosts[this.failures % Math.max(1, info.hosts.length)] ?? FALLBACK_HOST;
    const socket: SocketLike = this.options.createSocket?.(`wss://${ host }/sub`) ?? (new WebSocket(`wss://${ host }/sub`) as unknown as SocketLike);

    this.closeSocket();
    this.socket = socket;
    this.lastSeen = this.now();
    socket.binaryType = 'arraybuffer';
    socket.onopen = (): void => {
      socket.send(encodePacket(OP_AUTH, { uid: info.uid, roomid: this.options.roomId, protover: 3, buvid: info.buvid, platform: 'web', type: 2, key: info.token }));
      socket.send(encodePacket(OP_HEARTBEAT, '[object Object]'));
    };
    socket.onmessage = (event: { data: ArrayBuffer }): void => this.receive(Buffer.from(event.data));
    socket.onclose = (): void => {
      if (this.socket === socket) this.retryLater();
    };
    socket.onerror = (): void => {
      if (this.socket === socket) this.retryLater();
    };
  }

  private retryLater(): void {
    if (this.stopped || this.retryTimer) return;

    this.closeSocket();

    const delay: number = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];

    this.failures += 1;
    this.retryTimer = setTimeout((): void => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  /* 每 30 秒：发心跳；太久什么都没收到就重连 */
  private tick(): void {
    if (this.stopped || !this.socket) return;

    if (this.now() - this.lastSeen > SILENT_MS) {
      this.retryLater();

      return;
    }

    try {
      this.socket.send(encodePacket(OP_HEARTBEAT, '[object Object]'));
    } catch {
      this.retryLater();
    }
  }

  private receive(data: Buffer): void {
    this.lastSeen = this.now();

    const { messages, authReply }: ReturnType<typeof decodeFrame> = decodeFrame(data, decompress);

    if (authReply) this.failures = 0; // 连上了

    const offset: number = this.now() - this.options.startedAt;

    for (const message of messages) {
      const comment: LiveComment | null = commentOf(message);

      if (!comment) continue;

      this.pending.push(lrcLine(comment, offset));
      this.count += 1;
    }
  }

  flush(): void {
    if (this.pending.length > 0) {
      try {
        fs.appendFileSync(this.options.file, this.pending.join(''), { encoding: 'utf8' });
        this.pending = [];
      } catch (err) {
        console.error('B 站弹幕：写文件失败', err); // 留着下次再写
      }
    }

    if (this.count !== this.reported) {
      this.reported = this.count;
      this.options.onCount?.(this.count);
    }
  }
}
