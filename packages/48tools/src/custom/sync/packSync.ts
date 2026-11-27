import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { getLocalConfigRoot, getPocket48LocalConfig, type Pocket48LocalConfig } from '../pocket48Proxy/pocket48Proxy';
import { getPresenceConfig, requestPresenceJson, type PresenceClientConfig } from '../room/presenceApi';
import { installPack, resetPack } from './packRegistry';
import { checkPack, type PackCheck } from './packVerify';
import type { PackContent, PackManifest, SignedManifest } from './packTypes';

/**
 * 个性化设置的多端同步：切片的提示词、排版、配色和几项配置打成一个签了名的「内容包」，放在自己的服务器上；
 * 每台设备启动时取一次，校验通过（见 ./packVerify）后存在本机、装上（./packRegistry），以后每 10 分钟看一眼有没有新的。
 *   - 服务器和在线状态用的是同一个（local/pocket48.json 的 presenceUrl、presenceKey、证书指纹），接口是 GET /pack/manifest、GET /pack/file
 *   - 也可以不经过服务器，直接读本机的一个文件夹（packDir，里面是打包脚本的输出）：还没放到服务器上时这样用
 *   - 没配公钥（packPublicKey）就整个不启用，用程序自带的默认内容
 *   - 连不上服务器时用上次存下来的；一次都没同步过就用自带的
 *   - 包没通过校验时不装，接着用现在的，设置页里写着原因
 */
export interface PackStatus {
  state: 'off' | 'builtin' | 'verified' | 'rejected';
  source?: 'cache' | 'server' | 'folder';
  version?: string;
  expiresAt?: string;
  expired?: boolean;
  checkedAt?: number;   // 上一次问服务器（或者看文件夹）是什么时候
  message?: string;     // 没同步成、没通过校验的原因
}

export interface PackSyncDeps {
  publicKey: () => string | undefined;
  folder: () => string | undefined;                      // 直接读这个文件夹（packDir）
  canFetch: () => boolean;                               // 配了服务器没有
  fetchManifest: () => Promise<SignedManifest>;
  fetchCode: () => Promise<string>;
  cacheDir: () => string;
  load: (file: string) => unknown;                       // 运行包文件，拿到它给出的内容
  now: () => number;
}

const MANIFEST_FILE: string = 'manifest.json';
const CHECK_EVERY: number = 10 * 60_000; // 说明文件只有几百字节，10 分钟问一次，新的包最晚 10 分钟到各台设备

let status: PackStatus = { state: 'off' };
let installed: string | undefined; // 现在装着的那一版的 sha256
let installedAt: number = 0;       // 它是什么时候打的包（说明里的 createdAt）
let running: Promise<PackStatus> | undefined;
const listeners: Set<() => void> = new Set();

export function getPackStatus(): PackStatus {
  return status;
}

export function onPackStatus(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => void listeners.delete(listener);
}

function setStatus(next: PackStatus): void {
  status = next;
  listeners.forEach((listener: () => void): void => listener());
}

function packFile(dir: string, manifest: PackManifest): string {
  return path.join(dir, `pack-${ manifest.sha256.slice(0, 16) }.cjs`);
}

/* 校验通过就装上；通过不了返回原因 */
function install(signed: SignedManifest, code: Buffer, file: string, source: PackStatus['source'], deps: PackSyncDeps): PackCheck {
  const check: PackCheck = checkPack(signed, code, deps.publicKey() ?? '', deps.now());

  if (!check.ok) return check;

  if (installed !== signed.manifest.sha256) {
    try {
      installPack(deps.load(file) as PackContent, signed.manifest.sha256.slice(0, 12));
    } catch (err) {
      return { ok: false, reason: `包运行不了：${ (err as Error)?.message ?? err }` };
    }

    installed = signed.manifest.sha256;
    installedAt = Date.parse(signed.manifest.createdAt) || 0;
  }

  setStatus({
    state: 'verified', source, version: signed.manifest.version, expiresAt: signed.manifest.expiresAt, expired: check.expired, checkedAt: deps.now()
  });

  return check;
}

function reject(reason: string, deps: PackSyncDeps): void {
  // 已经装着一版的接着用，只把原因记下来
  setStatus({ ...(installed ? status : { state: 'rejected' }), message: reason, checkedAt: deps.now() } as PackStatus);
}

async function readSigned(dir: string): Promise<SignedManifest | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(dir, MANIFEST_FILE), 'utf8')) as SignedManifest;
  } catch {
    return undefined;
  }
}

/* 从一个文件夹里装（上次存下来的，或者 packDir） */
async function installFromDir(dir: string, source: PackStatus['source'], deps: PackSyncDeps): Promise<boolean> {
  const signed: SignedManifest | undefined = await readSigned(dir);

  if (!signed?.manifest?.sha256) return false;

  // 打包脚本的输出叫 pack.cjs；存下来的带着校验码，换了一版就是另一个文件
  const file: string | undefined = [packFile(dir, signed.manifest), path.join(dir, 'pack.cjs')].find((item: string): boolean => fs.existsSync(item));

  if (!file) return false;

  const check: PackCheck = install(signed, await fs.promises.readFile(file), file, source, deps);

  if (!check.ok) reject(`${ source === 'cache' ? '本机存的' : '文件夹里的' }内容包没有通过校验：${ check.reason }`, deps);

  return check.ok;
}

async function saveToCache(dir: string, signed: SignedManifest, code: Buffer): Promise<string> {
  const file: string = packFile(dir, signed.manifest);

  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(`${ file }.part`, code);
  await fs.promises.rename(`${ file }.part`, file);
  await fs.promises.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(signed), 'utf8');

  // 旧的几版不留（先取出来再循环：打包后循环头部不能直接用 node 模块，见 custom/README.md）
  const names: Array<string> = await fs.promises.readdir(dir);

  for (const name of names) {
    if (/^pack-[0-9a-f]+\.cjs$/.test(name) && path.join(dir, name) !== file) await fs.promises.rm(path.join(dir, name), { force: true });
  }

  return file;
}

/* 同步一次：先把本机有的装上（文件夹 / 上次存的），再问服务器有没有新的 */
async function syncOnce(deps: PackSyncDeps): Promise<PackStatus> {
  if (!deps.publicKey()) {
    setStatus({ state: 'off' });

    return status;
  }

  if (status.state === 'off') setStatus({ state: 'builtin' });

  const folder: string | undefined = deps.folder();

  if (folder) {
    const before: number | undefined = status.checkedAt;

    // 校验没过的已经记了原因；什么都没记就是文件夹里没有东西
    if (!await installFromDir(folder, 'folder', deps) && status.checkedAt === before) reject('文件夹里没有内容包（要有 manifest.json 和 pack.cjs）', deps);

    return status;
  }

  if (!installed) await installFromDir(deps.cacheDir(), 'cache', deps);

  if (!deps.canFetch()) return status;

  try {
    const signed: SignedManifest = await deps.fetchManifest();

    if (signed?.manifest?.sha256 && signed.manifest.sha256 === installed) {
      // 没有新的：只更新「什么时候看过」和到期的状态（到期时间用装上时验过的那个，这次的说明还没验）
      const expires: number = status.expiresAt ? Date.parse(status.expiresAt) : NaN;

      setStatus({ ...status, message: undefined, expired: Number.isFinite(expires) && deps.now() > expires, checkedAt: deps.now() });

      return status;
    }

    // 服务器给的比现在装着的还旧：不换（签名是对的旧包也不行，免得被人拿以前的一版顶回来）
    if (installed && (Date.parse(signed?.manifest?.createdAt) || 0) < installedAt) {
      reject('服务器上的内容包比现在装着的旧，没有换', deps);

      return status;
    }

    const code: Buffer = Buffer.from(await deps.fetchCode(), 'utf8');
    const first: PackCheck = checkPack(signed, code, deps.publicKey() ?? '', deps.now());

    if (!first.ok) {
      reject(`服务器上的内容包没有通过校验：${ first.reason }`, deps);

      return status;
    }

    const check: PackCheck = install(signed, code, await saveToCache(deps.cacheDir(), signed, code), 'server', deps);

    if (!check.ok) reject(check.reason, deps);
  } catch (err) {
    reject(`没连上同步服务（${ (err as Error)?.message ?? err }）${ installed ? '，接着用上次同步的' : '' }`, deps);
  }

  return status;
}

/**
 * 同步一次。正在同步时再调（定时的那一次和设置页的「立即同步」撞上）不会重复下载，等的是同一次的结果
 * @return { Promise<PackStatus> }
 */
export function syncPack(deps: PackSyncDeps): Promise<PackStatus> {
  running ??= syncOnce(deps).finally((): void => {
    running = undefined;
  });

  return running;
}

/* ---------- 程序里实际用的那一套 ---------- */
function localConfig(): Pocket48LocalConfig {
  return getPocket48LocalConfig();
}

export function packCacheDir(): string {
  const root: string | undefined = getLocalConfigRoot();

  return root ? path.join(root, 'local', 'pack-cache') : path.join(process.env.APPDATA || os.homedir(), '48tools-custom', 'pack-cache');
}

function presence(): PresenceClientConfig {
  const config: PresenceClientConfig | undefined = getPresenceConfig();

  if (!config) throw new Error('没有配置同步服务');

  return config;
}

export const packSyncDeps: PackSyncDeps = {
  publicKey: (): string | undefined => (localConfig().packPublicKey ?? '').trim() || undefined,
  folder(): string | undefined {
    const dir: string = (localConfig().packDir ?? '').trim();
    const root: string | undefined = getLocalConfigRoot();

    return dir ? (path.isAbsolute(dir) || !root ? dir : path.join(root, dir)) : undefined;
  },
  canFetch: (): boolean => getPresenceConfig() !== undefined,
  fetchManifest: (): Promise<SignedManifest> => requestPresenceJson<SignedManifest>('GET', '/pack/manifest', { config: presence() }),
  fetchCode: async (): Promise<string> => (await requestPresenceJson<{ code: string }>('GET', '/pack/file', { config: presence(), timeoutMs: 60_000 })).code,
  cacheDir: packCacheDir,
  load: (file: string): unknown => (globalThis as unknown as { require: (id: string) => unknown }).require(file),
  now: (): number => Date.now()
};

let timer: ReturnType<typeof setInterval> | undefined;

/* 程序启动时调一次（shell/AppShell）：同步一次，以后每 10 分钟再看 */
export function startPackSync(): void {
  if (timer) return;

  void syncPack(packSyncDeps);
  timer = setInterval((): void => void syncPack(packSyncDeps), CHECK_EVERY);
}

/* 测试用：回到什么都没装的状态 */
export function resetPackSync(): void {
  installed = undefined;
  installedAt = 0;
  resetPack();
  setStatus({ state: 'off' });
}
