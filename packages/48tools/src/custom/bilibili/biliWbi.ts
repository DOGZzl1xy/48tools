import { createHash } from 'node:crypto';

/**
 * B 站接口的 WBI 签名（不签名时 getDanmuInfo 等接口返回 -352 风控）。
 * 做法和网页端一样：nav 接口给出 img_key、sub_key（两个图片地址的文件名），拼起来按固定的表重排、取前 32 位当 mixin key；
 * 请求参数加上 wts（秒）后按名字排好序，去掉 !'()* 这几个字符，拼成查询串，末尾接 mixin key 取 md5 得到 w_rid。
 * 接入点：./biliApi。
 */
const MIXIN_TABLE: Array<number> = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

/* 图片地址 → 文件名（不带扩展名） */
export function wbiKeyOf(url: string | undefined): string {
  return String(url ?? '').split('/').pop()?.split('.')[0] ?? '';
}

export function mixinKeyOf(imgKey: string, subKey: string): string {
  const raw: string = imgKey + subKey;

  return MIXIN_TABLE.map((index: number): string => raw[index] ?? '').join('').slice(0, 32);
}

/**
 * 签好名的查询串（不带 ?）
 * @param { Record<string, string | number> } params
 * @param { string } mixinKey
 * @param { number } wts - 秒；测试时传固定值
 */
export function signWbi(params: Record<string, string | number>, mixinKey: string, wts: number = Math.floor(Date.now() / 1000)): string {
  const all: Record<string, string | number> = { ...params, wts };
  const query: string = Object.keys(all).sort()
    .map((key: string): string => `${ encodeURIComponent(key) }=${ encodeURIComponent(String(all[key]).replace(/[!'()*]/g, '')) }`)
    .join('&');

  return `${ query }&w_rid=${ createHash('md5').update(query + mixinKey).digest('hex') }`;
}
