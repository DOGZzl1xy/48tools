// @ts-expect-error
import got from 'got';
import { getBilibiliCookie } from '../../utils/utils';
import { wbiKeyOf, mixinKeyOf, signWbi } from './biliWbi';

/**
 * B 站直播用到的几个接口（都走 Node 的 got，带上「B 站登录」存的 cookie；没登录时现取一个匿名的 buvid3）。
 *   - roomInfo：房间信息（实际房间号、是否在直播、标题、封面）
 *   - playUrl：直播流地址（登录后能拿到原画；没登录只给超清）
 *   - danmuConnect：弹幕服务器的地址和 token（要 WBI 签名，否则 -352）
 * 接入点：./gongyanRecorder、./biliDanmuRecorder、./gongyanWatcher。
 */
const UA: string = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WBI_TTL: number = 60 * 60_000;

let anonymousBuvid: string | undefined;
let wbiCache: { key: string; uid: number; at: number } | undefined;

async function getJson<T>(url: string, cookie: string, referer: string = 'https://live.bilibili.com/'): Promise<T> {
  const res: { body: T } = await got(url, {
    responseType: 'json',
    timeout: { request: 15_000 },
    headers: { 'User-Agent': UA, Referer: referer, ...(cookie ? { Cookie: cookie } : {}) }
  });

  return res.body;
}

/* 请求时带的 cookie：登录了就用登录的（里面有 buvid3）；没有 buvid3 时补一个匿名的 */
export async function biliCookie(): Promise<string> {
  const login: string = getBilibiliCookie() ?? '';

  if (/(^|;\s*)buvid3=/.test(login)) return login;

  if (!anonymousBuvid) {
    try {
      const res: { data?: { b_3?: string } } = await getJson('https://api.bilibili.com/x/frontend/finger/spi', '');

      anonymousBuvid = res?.data?.b_3;
    } catch { /* 取不到就不带 */ }
  }

  return [login, anonymousBuvid ? `buvid3=${ anonymousBuvid }` : ''].filter(Boolean).join('; ');
}

export function buvidOf(cookie: string): string {
  return /(?:^|;\s*)buvid3=([^;]+)/.exec(cookie)?.[1] ?? '';
}

export interface BiliRoomInfo {
  roomId: number;     // 实际房间号
  live: boolean;      // live_status 1：直播中（2 是轮播，不算）
  title: string;
  cover: string;      // 直播间封面
  keyframe: string;   // 直播画面的截图
}

export async function roomInfo(room: number | string): Promise<BiliRoomInfo> {
  const res: { code: number; message?: string; data?: Record<string, any> } = await getJson(
    `https://api.live.bilibili.com/room/v1/Room/get_info?id=${ room }`, await biliCookie());

  if (res.code !== 0 || !res.data) throw new Error(`B 站房间信息取不到：${ res.message ?? res.code }`);

  return {
    roomId: Number(res.data.room_id),
    live: Number(res.data.live_status) === 1,
    title: String(res.data.title ?? ''),
    cover: String(res.data.user_cover ?? ''),
    keyframe: String(res.data.keyframe ?? '')
  };
}

/* 直播流地址：要 flv（边录边写，中途断了文件也能用），优先 avc，画质要最高的 */
export async function playUrl(roomId: number): Promise<{ url: string; qn: number }> {
  const res: { code: number; message?: string; data?: Record<string, any> } = await getJson(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${ roomId }`
      + '&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8&dolby=5&panorama=1',
    await biliCookie(), `https://live.bilibili.com/${ roomId }`);
  const streams: Array<any> = res?.data?.playurl_info?.playurl?.stream ?? [];
  const codecs: Array<any> = streams
    .filter((stream: any): boolean => stream.protocol_name === 'http_stream')
    .flatMap((stream: any): Array<any> => stream.format ?? [])
    .filter((format: any): boolean => format.format_name === 'flv')
    .flatMap((format: any): Array<any> => format.codec ?? [])
    .sort((a: any, b: any): number => Number(a.codec_name !== 'avc') - Number(b.codec_name !== 'avc') || Number(b.current_qn) - Number(a.current_qn));
  const codec: any = codecs[0];
  const host: any = codec?.url_info?.[0];

  if (!codec || !host) throw new Error(`B 站直播地址取不到：${ res?.message ?? res?.code }`);

  return { url: `${ host.host }${ codec.base_url }${ host.extra }`, qn: Number(codec.current_qn) };
}

/* WBI 的 mixin key（一小时更新一次）和登录的 uid（没登录是 0） */
async function wbi(cookie: string): Promise<{ key: string; uid: number }> {
  if (wbiCache && Date.now() - wbiCache.at < WBI_TTL) return wbiCache;

  const nav: { data?: { isLogin?: boolean; mid?: number; wbi_img?: { img_url?: string; sub_url?: string } } } = await getJson(
    'https://api.bilibili.com/x/web-interface/nav', cookie, 'https://www.bilibili.com/');
  const key: string = mixinKeyOf(wbiKeyOf(nav?.data?.wbi_img?.img_url), wbiKeyOf(nav?.data?.wbi_img?.sub_url));

  if (key.length !== 32) throw new Error('B 站 WBI 签名的 key 取不到');

  wbiCache = { key, uid: nav?.data?.isLogin ? Number(nav.data.mid) || 0 : 0, at: Date.now() };

  return wbiCache;
}

export interface DanmuConnectInfo {
  hosts: Array<string>;
  token: string;
  uid: number;
  buvid: string;
}

export async function danmuConnect(roomId: number): Promise<DanmuConnectInfo> {
  const cookie: string = await biliCookie();
  const { key, uid }: { key: string; uid: number } = await wbi(cookie);
  const res: { code: number; message?: string; data?: { token?: string; host_list?: Array<{ host: string }> } } = await getJson(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${ signWbi({ id: roomId, type: 0, web_location: '444.8' }, key) }`,
    cookie, `https://live.bilibili.com/${ roomId }`);

  if (res.code !== 0 || !res.data?.token) {
    wbiCache = undefined; // key 可能换了，下次重新取

    throw new Error(`B 站弹幕服务器取不到：${ res.message ?? res.code }`);
  }

  return {
    hosts: (res.data.host_list ?? []).map((item: { host: string }): string => item.host).filter(Boolean),
    token: res.data.token,
    uid,
    buvid: buvidOf(cookie)
  };
}
