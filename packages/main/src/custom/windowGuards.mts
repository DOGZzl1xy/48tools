import {
  shell,
  type WebContents,
  type HandlerDetails,
  type WindowOpenHandlerResponse,
  type Event as ElectronEvent,
  type WebContentsWillNavigateEventParams
} from 'electron';

/**
 * 应用自己的窗口（主窗口、播放器窗口）开启了 nodeIntegration，不能让它们跳到外部网页或打开新的 Electron 窗口。
 *   - 新窗口：一律拒绝，http(s) 链接改用系统浏览器打开
 *   - 跳转：只允许同源（应用自己的页面），外部 http(s) 链接改用系统浏览器打开
 * 登录、验证码等需要加载外部网站的窗口不使用这个函数。
 * 接入点：ProcessWindow.mts、ipcListener/openPlayerHtml.mts 创建窗口后调用。
 */
function isHttpUrl(url: string): boolean {
  try {
    const { protocol }: URL = new URL(url);

    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/* 是否为应用自己的页面：file: 页面只允许同一个文件（所有 file: 地址的 origin 都是 "null"），其他按同源判断 */
function isAppPage(url: string, current: string): boolean {
  try {
    const target: URL = new URL(url);
    const page: URL = new URL(current);

    if (target.protocol === 'file:' || page.protocol === 'file:') {
      return target.protocol === page.protocol && target.pathname === page.pathname;
    }

    return target.origin === page.origin;
  } catch {
    return false;
  }
}

export function guardAppWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(function(details: HandlerDetails): WindowOpenHandlerResponse {
    if (isHttpUrl(details.url)) shell.openExternal(details.url);

    return { action: 'deny' };
  });

  contents.on('will-navigate', function(event: ElectronEvent<WebContentsWillNavigateEventParams>): void {
    const current: string = contents.getURL();

    if (current && isAppPage(event.url, current)) return;

    event.preventDefault();

    if (isHttpUrl(event.url)) shell.openExternal(event.url);
  });
}
