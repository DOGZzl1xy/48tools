/**
 * 个性化设置的同步：内容包要过签名和校验码两关才装；没有新的不重复下载；连不上服务器时用上次存的；
 * 没通过校验的不装，接着用现在的。服务器换成假的，密钥是测试里现生成的。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPackStatus, resetPackSync, syncPack, type PackStatus, type PackSyncDeps } from './packSync';
import { isBuiltinPack, pack, packVersion } from './packRegistry';
import { checkPack, manifestText, sha256Hex } from './packVerify';
import { PACK_API, type PackManifest, type SignedManifest } from './packTypes';

const pair: crypto.KeyPairKeyObjectResult = crypto.generateKeyPairSync('ed25519');
const other: crypto.KeyPairKeyObjectResult = crypto.generateKeyPairSync('ed25519');
const publicKey: string = (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
const NOW: number = Date.UTC(2026, 10, 27);

/* 一个最小的内容包：只改一项配置 */
function packCode(tag: string): string {
  return `module.exports = { config: { stageTeamTags: { X: ${ JSON.stringify(tag) } } } };\n`;
}

function sign(code: string, change: Partial<PackManifest> = {}, key: crypto.KeyObject = pair.privateKey): SignedManifest {
  const bytes: Buffer = Buffer.from(code, 'utf8');
  const manifest: PackManifest = {
    api: PACK_API, version: 'v1', sha256: sha256Hex(bytes), size: bytes.length, createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + (365 * 86_400_000)).toISOString(), ...change
  };

  return { manifest, signature: crypto.sign(null, Buffer.from(manifestText(manifest), 'utf8'), key).toString('base64') };
}

describe('checkPack', (): void => {
  const code: string = packCode('甲队');

  test('签名、校验码、接口版本都对才算通过；过了期只是标出来', (): void => {
    expect(checkPack(sign(code), Buffer.from(code), publicKey, NOW)).toEqual({ ok: true, expired: false });
    expect(checkPack(sign(code), Buffer.from(code), publicKey, NOW + (400 * 86_400_000))).toEqual({ ok: true, expired: true });
    // PEM 写法的公钥也认
    expect(checkPack(sign(code), Buffer.from(code), pair.publicKey.export({ type: 'spki', format: 'pem' }) as string, NOW)).toMatchObject({ ok: true });
  });

  test('别人签的、说明被改过、文件被改过、给别的版本用的，都不通过', (): void => {
    const signed: SignedManifest = sign(code);

    expect(checkPack(sign(code, {}, other.privateKey), Buffer.from(code), publicKey, NOW)).toMatchObject({ ok: false });
    expect(checkPack({ ...signed, manifest: { ...signed.manifest, expiresAt: '2099-01-01T00:00:00.000Z' } }, Buffer.from(code), publicKey, NOW)).toMatchObject({ ok: false });
    expect(checkPack(signed, Buffer.from(packCode('乙队')), publicKey, NOW)).toMatchObject({ ok: false });
    expect(checkPack(sign(code, { api: PACK_API + 1 }), Buffer.from(code), publicKey, NOW)).toMatchObject({ ok: false });
    expect(checkPack(signed, Buffer.from(code), 'not a key', NOW)).toMatchObject({ ok: false });
    // 只认 Ed25519 的公钥
    expect(checkPack(signed, Buffer.from(code), crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }) as string, NOW))
      .toEqual({ ok: false, reason: '本机配置里的公钥不是 Ed25519 的' });
    expect(checkPack({} as SignedManifest, Buffer.from(code), publicKey, NOW)).toMatchObject({ ok: false });
  });
});

describe('syncPack', (): void => {
  let dir: string;
  let server: { signed: SignedManifest; code: string } | Error;
  let calls: { manifest: number; code: number };
  let deps: PackSyncDeps;
  const tag: () => string | undefined = (): string | undefined => pack().config.stageTeamTags.X;

  function serve(code: string, change: Partial<PackManifest> = {}, key?: crypto.KeyObject): void {
    server = { signed: sign(code, change, key), code };
  }

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-sync-'));
    calls = { manifest: 0, code: 0 };
    serve(packCode('甲队'));
    resetPackSync();
    deps = {
      publicKey: (): string => publicKey,
      folder: (): undefined => undefined,
      canFetch: (): boolean => true,
      fetchManifest(): Promise<SignedManifest> {
        calls.manifest++;

        return server instanceof Error ? Promise.reject(server) : Promise.resolve(server.signed);
      },
      fetchCode(): Promise<string> {
        calls.code++;

        return server instanceof Error ? Promise.reject(server) : Promise.resolve(server.code);
      },
      cacheDir: (): string => path.join(dir, 'cache'),
      load: (file: string): unknown => require(file),
      now: (): number => NOW
    };
  });

  afterEach((): void => {
    resetPackSync();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('没配公钥：不启用，也不去问服务器', async (): Promise<void> => {
    expect(await syncPack({ ...deps, publicKey: (): undefined => undefined })).toEqual({ state: 'off' });
    expect(calls.manifest).toBe(0);
    expect(isBuiltinPack()).toBe(true);
  });

  test('第一次：下载、校验、存在本机、装上；没有新的时候不再下载', async (): Promise<void> => {
    expect(await syncPack(deps)).toMatchObject({ state: 'verified', source: 'server', version: 'v1', expired: false });
    expect(tag()).toBe('甲队');
    expect(pack().config.gongyanTeams.length).toBeGreaterThan(0); // 包里没给的项还是默认的
    expect(fs.readdirSync(path.join(dir, 'cache')).sort()).toEqual(['manifest.json', expect.stringMatching(/^pack-[0-9a-f]{16}\.cjs$/)]);

    expect(await syncPack(deps)).toMatchObject({ state: 'verified', version: 'v1' });
    expect(calls).toEqual({ manifest: 2, code: 1 });
  });

  test('服务器上换了一版：下载新的装上，旧的文件删掉', async (): Promise<void> => {
    await syncPack(deps);
    serve(packCode('乙队'), { version: 'v2' });
    expect(await syncPack(deps)).toMatchObject({ state: 'verified', version: 'v2' });
    expect(tag()).toBe('乙队');
    expect(fs.readdirSync(path.join(dir, 'cache')).filter((name: string): boolean => name.endsWith('.cjs'))).toHaveLength(1);
  });

  test('服务器上的包不是自己签的：不装，用自带的；之前装过一版的接着用那一版', async (): Promise<void> => {
    serve(packCode('坏的'), {}, other.privateKey);
    expect(await syncPack(deps)).toMatchObject({ state: 'rejected', message: expect.stringContaining('签名不对') });
    expect(isBuiltinPack()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cache'))).toBe(false); // 没通过的不存

    serve(packCode('甲队'));
    await syncPack(deps);
    serve(packCode('坏的'), { version: 'v9' }, other.privateKey);
    expect(await syncPack(deps)).toMatchObject({ state: 'verified', version: 'v1', message: expect.stringContaining('签名不对') });
    expect(tag()).toBe('甲队');
  });

  test('文件和说明对不上（被改过、没下完）：不装', async (): Promise<void> => {
    serve(packCode('甲队'));
    (server as { code: string }).code = packCode('被换掉的');
    expect(await syncPack(deps)).toMatchObject({ state: 'rejected', message: expect.stringContaining('校验码对不上') });
    expect(isBuiltinPack()).toBe(true);
  });

  test('连不上服务器：用上次存在本机的；一次都没同步过就用自带的', async (): Promise<void> => {
    server = new Error('连接被拒绝');
    expect(await syncPack(deps)).toMatchObject({ state: 'rejected', message: expect.stringContaining('没连上同步服务') });
    expect(isBuiltinPack()).toBe(true);

    serve(packCode('甲队'));
    await syncPack(deps);
    resetPackSync(); // 程序重启
    server = new Error('连接被拒绝');
    expect(await syncPack(deps)).toMatchObject({ state: 'verified', source: 'cache', version: 'v1', message: expect.stringContaining('接着用上次同步的') });
    expect(tag()).toBe('甲队');
  });

  test('本机存的那一份被改过：不装', async (): Promise<void> => {
    await syncPack(deps);

    const file: string = path.join(dir, 'cache', fs.readdirSync(path.join(dir, 'cache')).find((name: string): boolean => name.endsWith('.cjs'))!);

    fs.writeFileSync(file, packCode('被换掉的'));
    resetPackSync();
    server = new Error('连接被拒绝');
    await syncPack(deps);
    expect(isBuiltinPack()).toBe(true);
    expect(getPackStatus().state).toBe('rejected');
  });

  test('服务器给的比现在装着的还旧（就算签名是对的）：不换', async (): Promise<void> => {
    serve(packCode('新的'), { version: 'v2', createdAt: new Date(NOW).toISOString() });
    await syncPack(deps);
    serve(packCode('以前的'), { version: 'v1', createdAt: new Date(NOW - 86_400_000).toISOString() });
    expect(await syncPack(deps)).toMatchObject({ state: 'verified', version: 'v2', message: expect.stringContaining('比现在装着的旧') });
    expect(tag()).toBe('新的');
    expect(calls.code).toBe(1); // 旧的那一版连下载都不下
  });

  test('正在同步时再点一次：不重复下载，等的是同一次', async (): Promise<void> => {
    const [first, second]: Array<PackStatus> = await Promise.all([syncPack(deps), syncPack(deps)]);

    expect(first).toBe(second);
    expect(calls).toEqual({ manifest: 1, code: 1 });
    expect(packVersion()).toMatch(/^[0-9a-f]{12}$/); // 装着的是哪一份（封面照它记）
  });

  test('签名过了期：照样用，状态里标出来', async (): Promise<void> => {
    serve(packCode('甲队'), { expiresAt: new Date(NOW - 86_400_000).toISOString() });
    expect(await syncPack(deps)).toMatchObject({ state: 'verified', expired: true });
    expect(tag()).toBe('甲队');
  });

  test('直接读一个文件夹（打包脚本的输出）：不问服务器', async (): Promise<void> => {
    const folder: string = path.join(dir, 'out');
    const code: string = packCode('文件夹里的');

    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'pack.cjs'), code);
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(sign(code, { version: 'local' })));
    expect(await syncPack({ ...deps, folder: (): string => folder })).toMatchObject({ state: 'verified', source: 'folder', version: 'local' });
    expect(tag()).toBe('文件夹里的');
    expect(calls.manifest).toBe(0);
  });
});
