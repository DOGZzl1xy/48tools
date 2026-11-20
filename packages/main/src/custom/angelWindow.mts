import {
  BrowserWindow,
  ipcMain,
  nativeTheme,
  shell,
  type WebContents,
  type HandlerDetails,
  type WindowOpenHandlerResponse,
  type Input,
  type Event as ElectronEvent,
  type WebContentsWillNavigateEventParams
} from 'electron';
import { titleBarIcon } from '../utils.mjs';
import { processWindow } from '../ProcessWindow.mjs';
import { AngelChannel } from './angelChannel.js';

/**
 * 临时功能：守护天使推理的网页（https://angel.48tools.app）用程序自带的浏览器窗口打开，程序里不再另画一份页面。
 * 网页由 local/angel/site/publish.mjs 用程序在后台算好的结果（48tools/src/custom/angel/angelStore 导出的 digest）生成并部署。
 *   - 窗口只加载这个网站：不开 Node、开沙箱、用单独的会话（不带程序的 cookie 和请求改写）
 *   - 跳到别的网站、打开新窗口：交给系统浏览器（只限 http(s)）
 *   - 已经开着时再打开：拿到前面并刷新（拿到最新一次发布的结果）；F5 / Ctrl+R 也是刷新
 *   - 打不开（没联网）时显示一页说明，按 F5 重试
 *   - 主窗口真正关闭（不是藏到托盘）时一起关
 * 接入点：main.mts 启动时调用 registerAngelWindow；页面 48tools/src/custom/angel/AngelPage.tsx 发 AngelChannel.Open。
 * 游戏结束后和 48tools/src/custom/angel 一起删掉。
 */
const ANGEL_URL: string = 'https://angel.48tools.app/';
const ANGEL_ORIGIN: string = new URL(ANGEL_URL).origin;
let angelWin: BrowserWindow | null = null;

function isAngelPage(url: string): boolean {
  try {
    return new URL(url).origin === ANGEL_ORIGIN;
  } catch {
    return false;
  }
}

function openOutside(url: string): void {
  try {
    const { protocol }: URL = new URL(url);

    if (protocol === 'http:' || protocol === 'https:') shell.openExternal(url);
  } catch { /* 无效的链接 */ }
}

function failPage(reason: string): string {
  const text: string = reason.replace(/[<>&]/g, '');

  return `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>NII 守护天使推理</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.7 'Segoe UI','Microsoft YaHei',sans-serif">
<div style="text-align:center"><p style="font-size:18px;font-weight:600;margin:0 0 6px">打不开 angel.48tools.app</p>
<p style="margin:0;opacity:.65">${ text }。连上网后按 F5 重新打开。</p></div></body>`;
}

/* 网站页面就刷新（保留现在看的标签页）；说明页就重新打开网站 */
function reload(win: BrowserWindow): void {
  if (isAngelPage(win.webContents.getURL())) win.webContents.reload();
  else win.loadURL(ANGEL_URL);
}

function guard(win: BrowserWindow): void {
  const contents: WebContents = win.webContents;

  contents.setWindowOpenHandler(function(details: HandlerDetails): WindowOpenHandlerResponse {
    openOutside(details.url);

    return { action: 'deny' };
  });

  contents.on('will-navigate', function(event: ElectronEvent<WebContentsWillNavigateEventParams>): void {
    if (isAngelPage(event.url)) return;

    event.preventDefault();
    openOutside(event.url);
  });

  contents.on('did-fail-load', function(event: ElectronEvent, code: number, reason: string, url: string, isMainFrame: boolean): void {
    if (!isMainFrame || code === -3) return; // -3：被新的加载打断，不算失败

    win.loadURL(`data:text/html;charset=utf-8,${ encodeURIComponent(failPage(reason)) }`);
  });

  contents.on('before-input-event', function(event: ElectronEvent, input: Input): void {
    if (input.type !== 'keyDown') return;

    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      reload(win);
    }
  });
}

function openAngelWindow(): void {
  if (angelWin && !angelWin.isDestroyed()) {
    if (angelWin.isMinimized()) angelWin.restore();

    angelWin.show();
    angelWin.focus();
    reload(angelWin);

    return;
  }

  const win: BrowserWindow = new BrowserWindow({
    width: 1_180,
    height: 900,
    minWidth: 400,
    minHeight: 560,
    title: 'NII 守护天使推理',
    icon: titleBarIcon,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0c12' : '#f6f3f7', // 和网页的底色一致
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'angel',
      spellcheck: false
    }
  });
  const owner: BrowserWindow | null = processWindow;

  function closeWithOwner(): void {
    if (!win.isDestroyed()) win.close();
  }

  angelWin = win;
  guard(win);
  owner?.once('closed', closeWithOwner);
  win.once('closed', function(): void {
    if (angelWin === win) angelWin = null;

    if (owner && !owner.isDestroyed()) owner.removeListener('closed', closeWithOwner);
  });
  win.loadURL(ANGEL_URL);
}

export function registerAngelWindow(): void {
  ipcMain.removeAllListeners(AngelChannel.Open);
  ipcMain.on(AngelChannel.Open, function(): void {
    openAngelWindow();
  });
}
