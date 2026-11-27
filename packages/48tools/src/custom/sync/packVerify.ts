import * as crypto from 'node:crypto';
import { PACK_API, type PackManifest, type SignedManifest } from './packTypes';

/**
 * 内容包的校验（纯计算）：包是会被程序直接运行的代码，所以装上之前要过两关——
 *   1. 说明（manifest）上的签名是用自己的私钥签的（Ed25519）：私钥只在打包的那台电脑上，服务器上没有，
 *      服务器就算被人动了手脚，换上去的包也过不了这一关
 *   2. 包文件的 SHA-256 和说明里写的一样：下载不完整、缓存坏了都能发现
 * 公钥写在本机的配置里（local/pocket48.json 的 packPublicKey）。
 */
const KEYS: Array<keyof PackManifest> = ['api', 'version', 'sha256', 'size', 'createdAt', 'expiresAt'];

/* 签名签的是这段文字：字段按固定的顺序排，打包的脚本（scripts/custom/buildPack.mjs）也是这样排的 */
export function manifestText(manifest: PackManifest): string {
  return JSON.stringify(KEYS.filter((key: keyof PackManifest): boolean => manifest[key] !== undefined)
    .map((key: keyof PackManifest): [string, unknown] => [key, manifest[key]]));
}

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/* 公钥可以是 PEM，也可以是一行 base64（SPKI 的 DER，打包脚本给出的就是这种） */
export function readPublicKey(text: string): crypto.KeyObject {
  const value: string = text.trim();

  return value.startsWith('-----')
    ? crypto.createPublicKey(value)
    : crypto.createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

export type PackCheck = { ok: true; expired: boolean } | { ok: false; reason: string };

/**
 * 这个包能不能装
 * @param { SignedManifest } signed - 说明和签名
 * @param { Buffer } code - 包文件
 * @param { string } publicKey
 * @param { number } now - 现在的时间（毫秒）
 */
export function checkPack(signed: SignedManifest, code: Buffer, publicKey: string, now: number): PackCheck {
  const manifest: PackManifest | undefined = signed?.manifest;

  if (!manifest || typeof signed.signature !== 'string' || typeof manifest.sha256 !== 'string') return { ok: false, reason: '说明文件不完整' };

  let key: crypto.KeyObject;

  try {
    key = readPublicKey(publicKey);
  } catch {
    return { ok: false, reason: '本机配置里的公钥读不出来' };
  }

  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: '本机配置里的公钥不是 Ed25519 的' };

  let signedByMe: boolean = false;

  try {
    signedByMe = crypto.verify(null, Buffer.from(manifestText(manifest), 'utf8'), key, Buffer.from(signed.signature, 'base64'));
  } catch {
    signedByMe = false;
  }

  if (!signedByMe) return { ok: false, reason: '签名不对（不是用自己的私钥签的，或者说明被改过）' };

  if (manifest.api !== PACK_API) return { ok: false, reason: `这个包是给另一个版本的程序用的（包 ${ manifest.api }，程序 ${ PACK_API }）` };

  if (code.length !== manifest.size || sha256Hex(code) !== manifest.sha256.toLowerCase()) return { ok: false, reason: '文件和说明里的校验码对不上（下载不完整或者被改过）' };

  const expires: number = manifest.expiresAt ? Date.parse(manifest.expiresAt) : NaN;

  return { ok: true, expired: Number.isFinite(expires) && now > expires };
}
