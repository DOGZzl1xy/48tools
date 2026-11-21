/**
 * 界面检查：启动一个测试窗口，把自定义的几个页面走一遍，确认关键的东西都在、没有报错，并给每个页面截一张图。
 * 以前每次改完界面都是临时写脚本来看，这里留一份放在仓库里。
 *
 * 用法（在仓库根目录）：
 *   1. 先构建：packages/main 里运行 `node --run dev`，packages/48tools 里运行 `node --run build`
 *   2. `node scripts/custom/uiCheck.mjs`
 * 截图保存在系统临时目录的 48tools-ui-check 文件夹里（运行结束时会打印路径）。
 *
 * 注意：
 *   - 用的是测试窗口自己的一份数据（%APPDATA%\Electron），不是平时用的 48tools 的数据；
 *     里面没有登录、没有关注成员时，房间相关的检查会标成「跳过」
 *   - 只看不改：不保存任何设置，不开始下载，不调用语音转文字的接口
 *   - 测试窗口也会按设置自动开始「自动抓取」；测试用的那份数据里配置了成员的话，检查期间可能会开始录制
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(os.tmpdir(), '48tools-ui-check');
const require = createRequire(path.join(REPO, 'package.json'));
const { _electron } = require('playwright-core');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const results = [];

function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(ok === null ? 'SKIP' : (ok ? 'PASS' : 'FAIL'), name, extra);
}

for (const file of ['packages/main/lib/main.mjs', 'packages/48tools/dist/index.html']) {
  if (!fs.existsSync(path.join(REPO, file))) {
    console.error(`找不到 ${ file }，先按文件开头的说明构建。`);
    process.exit(1);
  }
}

fs.mkdirSync(SHOTS, { recursive: true });

const app = await _electron.launch({
  executablePath: require('electron'),
  args: [path.join(REPO, 'packages/main/lib/main.mjs')],
  cwd: REPO,
  env: { ...process.env, NODE_ENV: 'development', TEST: 'true' }
});
const win = await app.firstWindow();

win.on('console', (message) => message.type() === 'error' && errors.push(message.text().slice(0, 300)));
win.on('pageerror', (error) => errors.push(`页面报错：${ String(error).slice(0, 300) }`));

async function go(hash, name, wait = 1500) {
  await win.evaluate((value) => (location.hash = value), hash);
  await sleep(wait);
  await win.screenshot({ path: path.join(SHOTS, `${ name }.png`) });
}

try {
  await win.waitForLoadState('load');
  await sleep(1500);

  // 首页
  await go('#/', 'home', 3000);
  check('首页：常用功能', (await win.locator('.home-card').count()) === 3);
  check('首页：正在直播这一块', (await win.locator('.home-live-status').count()) === 1);

  // 房间消息
  await go('#/48/RoomMessage', 'room', 4000);

  const messages = await win.locator('.room-message').count();

  if (messages === 0) {
    check('房间消息（没有登录或没有打开的房间）', null);
  } else {
    check('房间：打开时在最下面', (await win.locator('.room-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 5);
    check('房间：一次最多画 150 条', messages <= 150, `${ messages } 条`);
    check('房间：没有浏览器自带的播放条', (await win.locator('audio[controls]').count()) === 0);
    await win.locator('.room-scroll').evaluate((el) => (el.scrollTop -= 2500));
    await sleep(700);
    check('房间：往上翻后出现「回到底部」', (await win.locator('.room-jump.is-bottom').count()) === 1);
    await win.locator('.room-jump.is-bottom').click();
    await sleep(800);
    check('房间：点「回到底部」回到最下面', (await win.locator('.room-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 5);
    await win.locator('.room-chat-header button[aria-label="查找"]').click();
    await sleep(600);
    check('房间：查找面板', (await win.locator('.room-find').count()) === 1);
    await win.screenshot({ path: path.join(SHOTS, 'room-find.png') });
    await win.locator('.ant-drawer-close').last().click();
    await sleep(400);
  }

  // Ctrl+K
  await win.keyboard.press('Control+k');
  await sleep(500);
  await win.keyboard.type('设置');
  await sleep(400);
  check('Ctrl+K：能搜到设置', (await win.locator('.shell-palette-item.is-active').textContent())?.includes('设置') === true);
  await win.keyboard.press('Enter');
  await sleep(900);
  check('Ctrl+K：回车进入设置', (await win.evaluate(() => location.hash)).includes('Settings'));

  // 设置
  await win.screenshot({ path: path.join(SHOTS, 'settings.png') });
  check('设置：分区导航', (await win.locator('.settings-nav button').count()) >= 8);
  check('设置：明暗主题可以直接选', (await win.locator('#settings-look .ant-segmented-item').count()) >= 3);
  check('设置：录播切片', (await win.locator('#settings-highlight .settings-row').count()) === 5);

  // 自动抓取配置
  await go('#/48/LiveOptions', 'auto-grab');
  check('自动抓取配置：选成员的控件', (await win.locator('.settings .ant-select').count()) === 1);

  // 录播下载：进入时自己加载
  await go('#/48/Pocket48Record', 'record', 6000);
  check('录播下载：进入后自动加载列表', (await win.locator('.ant-table-tbody tr.ant-table-row').count()) > 0);

  // 自动切片：只打开对话框看一眼就取消，不开始任务。列表里可能全是电台（没有这一项），所以多试几行
  let highlightDialog = null;

  for (const button of (await win.locator('.ant-table-tbody button[aria-label="更多操作"]').all()).slice(0, 12)) {
    await button.click();
    await sleep(350);

    const item = win.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '自动切片' });

    if ((await item.count()) > 0) {
      await item.first().click();
      await sleep(700);
      highlightDialog = win.locator('.ant-modal', { hasText: '做几个切片' });
      break;
    }

    await win.keyboard.press('Escape');
    await sleep(200);
  }

  if (highlightDialog === null) {
    check('自动切片（列表前几行没有视频直播）', null);
  } else {
    check('自动切片：对话框', (await highlightDialog.count()) === 1);
    check('自动切片：可以选数量', (await highlightDialog.locator('.ant-segmented-item').count()) === 6);
    await win.screenshot({ path: path.join(SHOTS, 'highlight-dialog.png') });
    await highlightDialog.locator('.ant-modal-footer button').first().click(); // 取消
    await sleep(500);
    check('自动切片：取消后没有开始任务', (await win.locator('.ant-modal-wrap:visible').count()) === 0);
  }

  // 直播抓取
  await go('#/48/Pocket48Live', 'live', 2500);
  check('直播抓取：页面能打开', (await win.locator('.ant-table').count()) === 1);

  // 下载队列
  await win.locator('.shell-footer button.shell-item').first().click();
  await sleep(700);
  check('下载队列：能打开', (await win.locator('.ant-drawer-open').count()) > 0);
  check('下载队列：有「清除记录」', (await win.locator('.ant-drawer-open .ant-drawer-extra button', { hasText: '清除记录' }).count()) === 1);
  await win.screenshot({ path: path.join(SHOTS, 'queue.png') });
  await win.keyboard.press('Escape');
} catch (error) {
  check(`检查中途出错：${ String(error?.message ?? error).slice(0, 300) }`, false);
  await win.screenshot({ path: path.join(SHOTS, 'error.png') }).catch(() => undefined);
}

check('界面没有报错', errors.length === 0, errors.slice(0, 5).join(' | '));
await app.close();

const failed = results.filter((item) => item.ok === false).length;

console.log(`\n共 ${ results.length } 项，失败 ${ failed } 项，跳过 ${ results.filter((item) => item.ok === null).length } 项。截图在 ${ SHOTS }`);
process.exit(failed > 0 ? 1 : 0);
