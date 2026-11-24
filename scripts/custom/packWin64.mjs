/**
 * 只打包 Windows 64 位版本，输出到 build/48tools-win64/48tools.exe（双击即可启动）。
 * 和原版 scripts/delivery.mjs 的步骤一样，区别：
 *   - 只编译 win64，不编译其他平台
 *   - 直接用 node_modules/electron/dist 里已经下载好的 Electron，不再联网下载
 *     （Electron 42 起安装依赖时不再自动下载程序本体，dist 不存在时这里会先下载一次）
 *   - 不下载网易云信 SDK（node-nim，口袋48房间消息用），和开发模式一样
 *   - 打包完成后恢复开发模式用的主进程代码（packages/main/lib）
 * 程序启动时会从 exe 所在目录往上找仓库的 local/（代理和 token），所以 local/ 不会被打进程序目录。
 * 用法：node scripts/custom/packWin64.mjs（打包前先关掉正在运行的 build/48tools-win64/48tools.exe）
 *       加 --skip-build 只重新打包，不重新编译；加 --skip-smoke 跳过打包后的启动检查
 * 打包时把当前提交号写进 resources/app/build-info.json（想知道程序是哪次提交打的包时看这个文件）。
 * 打包后会自动启动一次程序（约 10 秒，会闪一下窗口），确认启动时界面没有报错，再关掉。
 * 注意：electron-builder 第一次运行时会下载 winCodeSign（给 exe 设置图标），里面有 macOS 的符号链接，
 *       没有管理员权限 / 开发者模式时解压会失败。解决办法：用 7za 加 -xr!darwin 解压到
 *       %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0
 */
import path from 'node:path';
import fsP from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { rimraf } from 'rimraf';
import fse from 'fs-extra/esm';
import { glob } from 'glob';
import builder from 'electron-builder';
import { cwd, appDir, wwwDir, staticsDir, build, require } from '../utils.mjs';
import taskfile from '../taskfile.mjs';
import lernaJson from '../../lerna.json' with { type: 'json' };

const electronDist = path.join(cwd, 'node_modules/electron/dist');
const electronVersion = require('electron/package.json').version;
const outputDir = path.join(build, 'pack-win64');           // electron-builder 的输出目录
const unpackedDir = path.join(outputDir, 'win-unpacked');
const targetDir = path.join(build, '48tools-win64');         // 最终的程序目录

/* 执行 node --run <script>，失败时报错（原版的 command 不检查退出码） */
function runScript(script, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--run', script], { cwd: dir, stdio: 'inherit' });

    child.on('error', reject);
    child.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`${ path.relative(cwd, dir) }: node --run ${ script } 失败，退出码 ${ code }`));
    });
  });
}

/**
 * 确认 node_modules/electron/dist 里有 Electron 程序本体。
 * Electron 42 起，安装依赖（yarn install）不再自动下载它，要到第一次运行 electron 命令时才下载；
 * 重新安装依赖后直接打包的话 dist 还不存在，这里用 electron 自带的 install.js 下载一次。
 */
async function ensureElectronDist() {
  const exe = path.join(electronDist, 'electron.exe');

  if (await fse.pathExists(exe)) return;

  console.log(`⏳ 下载 Electron ${ electronVersion }（node_modules/electron/dist 还没有）`);
  execFileSync(process.execPath, [path.join(cwd, 'node_modules/electron/install.js')], { cwd, stdio: 'inherit' });

  if (!await fse.pathExists(exe)) throw new Error(`Electron 下载后仍然找不到 ${ exe }`);
}

/* 程序目录被占用（程序还开着）时提前报错，避免编译完才发现替换不了 */
async function checkTargetNotRunning() {
  const exe = path.join(targetDir, '48tools.exe');

  if (!await fse.pathExists(exe)) return;

  try {
    const handle = await fsP.open(exe, 'r+');

    await handle.close();
  } catch {
    throw new Error(`${ exe } 正在运行，请先关掉 48tools 再打包。`);
  }
}

/**
 * 检查界面代码里有没有「循环头部直接使用 node 模块」的写法。
 * 生产构建的 babel-plugin-delay-require 会把 node 模块的加载语句插到所在块的开头，
 * 写在 for/while 头部时加载语句会落进循环体，晚于头部执行，运行时会报 undefined（开发模式不会出现）。
 */
async function checkDelayRequireInLoopHead() {
  const files = await glob(path.join(cwd, 'packages/48tools/dist/**/*.js'), { windowsPathsNoEscape: true });
  const pattern = /(?:for|while)\((?:const |let |var )?[^{;]{0,200}globalThis\.__ELECTRON__DELAY_REQUIRE__\w+[^{]{0,120}\)\{/g;
  const found = [];

  for (const file of files) {
    const code = await fsP.readFile(file, { encoding: 'utf8' });

    for (const match of code.matchAll(pattern)) found.push(`${ path.basename(file) }: ${ match[0].slice(0, 160) }`);
  }

  if (found.length > 0) {
    throw new Error(`界面代码的循环头部直接用了 node 模块（打包后会报错），请先把它提到循环前面的变量里：\n${ found.join('\n') }`);
  }
}

/* 当前提交的信息，写进程序目录，窗口标题用 */
function gitBuildInfo() {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const date = new Date(Date.now() + (8 * 3_600_000)).toISOString().slice(0, 10); // 北京时间的日期，和电脑的时区无关

  try {
    return { commit: git(['rev-parse', '--short', 'HEAD']), date, dirty: git(['status', '--porcelain']) !== '' };
  } catch {
    return { date };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动检查：打开打包好的程序约 10 秒，界面控制台有报错就算失败，然后正常关闭（代理会跟着退出）。
 * 开发模式和打包后的代码不完全一样（见 checkDelayRequireInLoopHead），这一步用来发现只在打包后才出现的错误。
 */
async function smokeTest(exe) {
  const output = [];
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let exited = false;

  child.stdout.on('data', (data) => output.push(data.toString()));
  child.stderr.on('data', (data) => output.push(data.toString()));
  child.on('exit', () => (exited = true));
  await sleep(10_000);

  if (exited) throw new Error('启动检查失败：程序启动后自己退出了（是不是已经有一个 48tools 在运行？）');

  // 先让它正常退出（关闭窗口只会藏到托盘，所以用 --quit），不行再强制结束
  try {
    execFileSync(exe, ['--quit'], { cwd: path.dirname(exe), stdio: 'ignore', timeout: 15_000 });
  } catch { /* noop */ }

  for (let i = 0; i < 16 && !exited; i++) await sleep(500);

  if (!exited) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* noop */ }

    throw new Error('启动检查失败：程序没有响应 --quit（已经强制结束）。关闭窗口后程序会留在后台，--quit 是脚本让它退出的办法，不能坏');
  }

  const errors = output.join('').split(/\r?\n/)
    .filter((line) => /Uncaught|Minified React error|Cannot find module|is not defined|is not a function/.test(line));

  if (errors.length > 0) {
    throw new Error(`启动检查失败，界面有报错：\n${ errors.slice(0, 5).map((line) => line.slice(0, 300)).join('\n') }`);
  }
}

function builderConfig() {
  return {
    appId: '48tools',
    productName: '48tools',
    copyright: '段昊辰',
    files: [
      '**/*',
      '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
      '!**/node_modules/*/*.md',
      '!**/node_modules/*.d.ts',
      '!**/node_modules/*.{ts,tsx}',
      '!**/node_modules/.bin',
      '!**/*.map',
      '!**/{npm-debug.log,yarn.lock,.yarn-integrity,.yarn-metadata.json}',
      '!version.json',
      '!package-lock.json'
    ],
    win: {
      target: [{ target: 'dir', arch: 'x64' }],
      icon: path.join(staticsDir, 'titleBarIcon.ico')
    },
    includeSubNodeModules: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    electronVersion,
    electronDist,
    directories: {
      app: wwwDir,
      output: outputDir
    },
    asar: false
  };
}

/**
 * 把新打好的目录改名成最终的程序目录。
 * 刚生成的文件夹有时正被杀毒软件 / 索引服务扫描，改名会被系统拒绝（EPERM / EBUSY / EACCES），等一下再试就好。
 */
async function renameWithRetry(from, to, times = 20) {
  for (let i = 1; ; i++) {
    try {
      await fsP.rename(from, to);

      return;
    } catch (err) {
      if (i >= times || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;

      console.log(`⏳ 程序目录暂时被占用，${ i }/${ times } 次重试`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
}

async function packWin64() {
  await checkTargetNotRunning();
  await ensureElectronDist();

  // 1. 编译（--skip-build：直接用上次编译好的文件，只重新打包）
  if (process.argv.includes('--skip-build')) {
    console.log('⏳ 跳过编译，使用已有的编译结果');
  } else {
    console.log('⏳ 编译主进程、界面和帮助文档');
    await runScript('build', path.join(cwd, 'packages/main'));
    await runScript('build', path.join(cwd, 'packages/48tools'));
    await runScript('build', path.join(cwd, 'packages/help'));
  }

  await checkDelayRequireInLoopHead();

  // 2. 准备 www（和原版 unpack.mjs 一样）
  console.log('⏳ 准备打包目录');
  await Promise.all([rimraf(wwwDir), rimraf(outputDir)]);
  await taskfile();
  await fse.copy(appDir, wwwDir);

  const appPackageJson = await fse.readJSON(path.join(appDir, 'package.json'));

  await Promise.all([
    fsP.writeFile(path.join(wwwDir, 'package.json'), JSON.stringify(appPackageJson), { encoding: 'utf8' }),
    fsP.writeFile(path.join(wwwDir, 'build-info.json'), JSON.stringify(gitBuildInfo()), { encoding: 'utf8' }),
    fse.copy(path.join(cwd, 'packages/main/lib'), path.join(wwwDir, 'boot')),
    fse.copy(path.join(cwd, 'packages/48tools/dist'), path.join(wwwDir, 'view')),
    fse.copy(path.join(cwd, 'packages/help/dist'), path.join(wwwDir, 'help'))
  ]);

  // 3. 打包
  console.log(`⏳ 打包 win64（Electron ${ electronVersion }）`);
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget(),
    config: builderConfig()
  });

  // 4. 只保留中文语言包，写入版本号和许可文件
  const locales = await glob(path.join(unpackedDir, 'locales/*.pak'), { windowsPathsNoEscape: true });

  await Promise.all(locales.filter((file) => !/zh-CN/i.test(file)).map((file) => fse.remove(file)));
  await Promise.all([
    fsP.writeFile(path.join(unpackedDir, 'version'), `v${ lernaJson.version }`),
    fse.copy(path.join(cwd, 'LICENSE'), path.join(unpackedDir, 'LICENSE')),
    fse.copy(path.join(cwd, 'README.md'), path.join(unpackedDir, 'README.md'))
  ]);

  // 5. 替换旧的程序目录
  await checkTargetNotRunning();
  await rimraf(targetDir);
  await renameWithRetry(unpackedDir, targetDir);
  await Promise.all([rimraf(outputDir), rimraf(wwwDir)]);

  // 6. 恢复开发模式用的主进程代码
  console.log('⏳ 恢复开发模式的主进程代码');
  await runScript('dev', path.join(cwd, 'packages/main'));

  // 7. 启动检查
  if (!process.argv.includes('--skip-smoke')) {
    console.log('⏳ 启动检查（会打开程序约 10 秒）');
    await smokeTest(path.join(targetDir, '48tools.exe'));
  }

  console.log(`✅ 打包完成：${ path.join(targetDir, '48tools.exe') }`);
}

packWin64().catch((err) => {
  console.error('❌', err.message ?? err);
  process.exitCode = 1;
});
