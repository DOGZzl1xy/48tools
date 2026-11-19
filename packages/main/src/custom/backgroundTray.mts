import * as fs from 'node:fs';
import * as path from 'node:path';
import { platform } from 'node:process';
import { app, ipcMain, Menu, Tray, nativeImage, type BrowserWindow, type NativeImage, type Event as ElectronEvent } from 'electron';
import { isTest, titleBarIcon } from '../utils.mjs';
import { BackgroundChannel } from './backgroundChannel.js';

/**
 * 关闭窗口后留在后台运行（Windows 右下角的系统托盘）。
 * 原来点窗口右上角的 × 就是退出程序，正在进行的直播抓取、下载、房间新消息检查都会停。
 * 现在点 × 只是把窗口藏起来，程序继续运行；托盘里有一个 48tools 图标：
 *   - 单击图标：把窗口显示出来（再双击一次桌面上的快捷方式也可以）
 *   - 右键图标：显示主窗口 / 关闭窗口后留在后台（可以关掉，关掉后 × 就恢复成退出）/ 退出 48tools
 * 真正退出的三种办法：托盘菜单里的「退出 48tools」、设置页面里的「退出程序」、命令行 `48tools.exe --quit`（见 ./singleInstance）。
 * 窗口藏起来后页面仍然在运行，定时器不会被降频（./windowTuning 里关掉了 backgroundThrottling）。
 * 「留在后台」这个开关存在程序配置目录的 custom-main.json 里，默认打开。
 * 自动化测试（TEST=true）时不启用。
 * 接入点：ProcessWindow.mts 创建主窗口之后调用 keepInBackground。
 */
const supported: boolean = platform === 'win32' && !isTest;
let enabled: boolean = true;
let quitting: boolean = false;
let tipShown: boolean = false;
let tray: Tray | null = null;
let appHooked: boolean = false;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'custom-main.json');
}

function readEnabled(): boolean {
  try {
    const saved: { keepInBackground?: unknown } = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));

    return saved.keepInBackground !== false;
  } catch {
    return true; // 没有保存过：默认留在后台
  }
}

function saveEnabled(): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ keepInBackground: enabled }, null, 2));
  } catch (err) {
    console.error('保存「留在后台」设置失败', err);
  }
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;

  if (win.isMinimized()) win.restore();

  win.show();
  win.focus();
}

function quitApp(): void {
  quitting = true;
  app.quit();
}

function setEnabled(win: BrowserWindow, value: boolean): void {
  enabled = value;
  saveEnabled();

  if (!win.isDestroyed()) win.webContents.send(BackgroundChannel.Changed, enabled);
}

function refreshTrayMenu(win: BrowserWindow): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: (): void => showWindow(win) },
    { type: 'separator' },
    {
      label: '关闭窗口后留在后台',
      type: 'checkbox',
      checked: enabled,
      click: (): void => setEnabled(win, !enabled) // 菜单项自己会切换打勾的状态，不用重建菜单
    },
    { type: 'separator' },
    { label: '退出 48tools', click: quitApp }
  ]));
}

/* 第一次藏到后台时提示一下，免得以为程序已经退出了 */
function showTipOnce(): void {
  if (tipShown || !tray) return;

  tipShown = true;

  try {
    tray.displayBalloon({
      title: '48tools 还在后台运行',
      content: '直播抓取、下载和房间新消息检查会继续。单击这个图标打开窗口，右键可以退出。'
    });
  } catch { /* 提示出不来不影响使用 */ }
}

export function keepInBackground(win: BrowserWindow): void {
  // 设置页面要用这几个接口；不支持的平台 / 测试时返回「没有这个功能」
  for (const channel of [BackgroundChannel.Get, BackgroundChannel.Set, BackgroundChannel.Quit]) ipcMain.removeHandler(channel);

  ipcMain.handle(BackgroundChannel.Get, (): { supported: boolean; enabled: boolean } => ({ supported, enabled: supported && enabled }));
  ipcMain.handle(BackgroundChannel.Set, (event: unknown, value: unknown): boolean => {
    if (supported) {
      setEnabled(win, value === true);
      refreshTrayMenu(win); // 在设置页面里改的：托盘菜单的打勾状态要跟着变
    }

    return supported && enabled;
  });
  ipcMain.handle(BackgroundChannel.Quit, quitApp);

  if (!supported) return;

  enabled = readEnabled();

  if (!appHooked) {
    appHooked = true;
    app.on('before-quit', (): void => {
      quitting = true;
    });
  }

  const icon: NativeImage = nativeImage.createFromPath(titleBarIcon ?? '');

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('48tools');
  tray.on('click', (): void => showWindow(win));
  refreshTrayMenu(win);

  win.on('close', (event: ElectronEvent): void => {
    if (quitting || !enabled) return;

    event.preventDefault();
    win.hide();
    showTipOnce();
  });

  // Windows 关机 / 注销时不要拦着
  win.on('session-end', (): void => {
    quitting = true;
  });

  win.once('closed', (): void => {
    tray?.destroy();
    tray = null;
  });
}
