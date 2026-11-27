/**
 * 把个性化设置的「内容包」打出来并签名（见 packages/48tools/src/custom/sync）：
 *
 *   node scripts/custom/buildPack.mjs [--days 3650]
 *
 * 输入：packages/48tools/src/custom/private/pack.ts（内容包的入口）和它用到的文件；
 *       local/专有词汇.txt（有的话作为配置里的专有词汇一起打进去）。
 * 输出：local/pack/out/pack.cjs（包文件）和 manifest.json（说明和签名）。把这两个文件放到同步服务器上，
 *       或者在 local/pocket48.json 里把 packDir 指到这个文件夹，程序直接读它。
 * 签名：Ed25519。私钥在 local/pack/signing-key.pem（第一次运行时生成；只留在这台电脑上，自己备份，不要放到服务器上），
 *       公钥在 local/pack/signing-key.pub.txt，要写进每台设备的 local/pocket48.json 的 packPublicKey。
 *
 * 包文件是自带依赖的一个 CommonJS 文件：从入口开始，把用到的本仓库的 .ts 文件一个个转成 JS 装进去
 *（只去掉类型，不做别的变换），node 自带的模块运行时再取。用到 npm 包会报错：包里不能依赖程序装了什么。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(import.meta.url)(path.join(root, 'node_modules/typescript'));
const entry = path.join(root, 'packages/48tools/src/custom/private/pack.ts');
const packDir = path.join(root, 'local/pack');
const outDir = path.join(packDir, 'out');
const keyFile = path.join(packDir, 'signing-key.pem');
const pubFile = path.join(packDir, 'signing-key.pub.txt');
const glossaryFile = path.join(root, 'local/专有词汇.txt');
const PACK_API = 1; // 和 packages/48tools/src/custom/sync/packTypes.ts 的 PACK_API 一致
const MANIFEST_KEYS = ['api', 'version', 'sha256', 'size', 'createdAt', 'expiresAt']; // 和 packVerify.ts 的 manifestText 一致

function resolveImport(from, spec) {
  const base = path.resolve(path.dirname(from), spec);

  for (const file of [`${ base }.ts`, `${ base }.tsx`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }

  throw new Error(`${ path.relative(root, from) } 里的 ${ spec } 找不到`);
}

/* 从入口开始，把用到的文件都转成 JS */
function bundle() {
  const modules = new Map(); // 文件 → { id, code, deps: { 写法: id } }
  const queue = [entry];
  const idOf = (file) => path.relative(root, file).replace(/\\/g, '/');

  while (queue.length > 0) {
    const file = queue.pop();

    if (modules.has(file)) continue;

    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    });
    const deps = {};

    for (const match of outputText.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
      const spec = match[2];

      if (spec.startsWith('.')) {
        const target = resolveImport(file, spec);

        deps[spec] = idOf(target);
        queue.push(target);
      } else if (!spec.startsWith('node:')) {
        throw new Error(`${ idOf(file) } 用了 ${ spec }：内容包里只能用本仓库的文件和 node: 开头的自带模块`);
      }
    }

    modules.set(file, { id: idOf(file), code: outputText, deps });
  }

  const glossary = fs.existsSync(glossaryFile) ? fs.readFileSync(glossaryFile, 'utf8').replace(/^﻿/, '') : undefined;
  const parts = Array.from(modules.values()).sort((a, b) => a.id.localeCompare(b.id)).map((item) =>
    `${ JSON.stringify(item.id) }: [function(module, exports, require) {\n${ item.code }\n}, ${ JSON.stringify(item.deps) }]`);

  return `/* 48tools 个性化设置内容包 */
'use strict';
(function(nodeRequire) {
  const defs = {
${ parts.join(',\n') }
  };
  const loaded = {};

  function load(id) {
    if (loaded[id]) return loaded[id].exports;

    const mod = loaded[id] = { exports: {} };
    const [run, deps] = defs[id];

    run(mod, mod.exports, function(spec) {
      return spec in deps ? load(deps[spec]) : nodeRequire(spec);
    });

    return mod.exports;
  }

  const content = load(${ JSON.stringify(idOf(entry)) }).default;
  const glossary = ${ JSON.stringify(glossary) };

  module.exports = Object.assign({}, content, { config: Object.assign({}, content.config, glossary === undefined ? {} : { glossary: glossary }) });
})(require);
`;
}

/* 私钥：没有就生成一对 */
function signingKey() {
  if (!fs.existsSync(keyFile)) {
    const pair = crypto.generateKeyPairSync('ed25519');

    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`🔑 生成了一对新的签名密钥：私钥在 ${ path.relative(root, keyFile) }（只留在这台电脑上，自己备份）`);
  }

  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');

  fs.writeFileSync(pubFile, `${ publicKey }\n`);

  return { privateKey, publicKey };
}

function main() {
  if (!fs.existsSync(entry)) throw new Error(`没有 ${ path.relative(root, entry) }：这台电脑上没有内容包的源文件`);

  const daysAt = process.argv.indexOf('--days');
  const days = daysAt > 0 ? Number(process.argv[daysAt + 1]) : 3_650; // 签名默认管 10 年

  if (!Number.isFinite(days) || days <= 0) throw new Error('--days 后面要跟天数');

  const code = Buffer.from(bundle(), 'utf8');
  const now = new Date();
  const manifest = {
    api: PACK_API,
    version: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    sha256: crypto.createHash('sha256').update(code).digest('hex'),
    size: code.length,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (days * 86_400_000)).toISOString()
  };
  const { privateKey, publicKey } = signingKey();
  const text = JSON.stringify(MANIFEST_KEYS.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
  const signature = crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pack.cjs'), code);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ manifest, signature }, null, 2));
  console.log(`✅ 内容包：${ path.relative(root, outDir) }（${ (code.length / 1024).toFixed(0) } KB，版本 ${ manifest.version }，签名到 ${ manifest.expiresAt.slice(0, 10) }）`);
  console.log(`   公钥（写进 local/pocket48.json 的 packPublicKey）在 ${ path.relative(root, pubFile) }，开头是 ${ publicKey.slice(0, 16) }…`);
}

try {
  main();
} catch (err) {
  console.error(`❌ ${ err.message }`);
  process.exitCode = 1;
}
