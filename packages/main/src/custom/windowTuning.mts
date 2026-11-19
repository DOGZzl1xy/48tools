import { platform } from 'node:process';
import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions, type TitleBarOverlayOptions } from 'electron';

/**
 * 主窗口的几项调整：
 *   - 默认宽度加大到 1280（新界面多了侧边栏），最小尺寸不变
 *   - 先隐藏，页面第一次画好之后再显示，并把窗口底色设成和界面一致：启动时不再先闪一下白屏
 *   - backgroundThrottling 关闭：窗口最小化 / 被遮住时，定时器不被浏览器降频。
 *     自动抓取靠定时器轮询，降频后可能晚一分钟才发现直播
 *   - v8CacheOptions 设为 bypassHeatCheck：第一次运行就缓存编译好的脚本，之后启动少做一遍编译
 *   - 关闭拼写检查（输入框都是成员名、地址，用不上）
 *   - Windows 上隐藏系统标题栏，由界面自己画（custom/shell/AppShell 的标题栏），右上角的最小化 / 最大化 / 关闭
 *     仍然是系统按钮。原因：部分 Windows 版本在暗色模式下不显示系统标题栏里的标题文字
 * 颜色要和 packages/48tools/src/custom/theme/modernTheme.ts 的窗口底色一致。
 * 接入点：ProcessWindow.mts 创建主窗口的地方。
 */
const BG_LIGHT: string = '#f3f4f6';
const BG_DARK: string = '#0b0d10';

export const TITLE_BAR_HEIGHT: number = 38;

function overlayOptions(isDark: boolean): TitleBarOverlayOptions {
  return {
    color: isDark ? BG_DARK : BG_LIGHT,
    symbolColor: isDark ? '#e5e7eb' : '#1f2937',
    height: TITLE_BAR_HEIGHT
  };
}

export function tuneWindowOptions(options: BrowserWindowConstructorOptions, isDark: boolean): BrowserWindowConstructorOptions {
  return {
    ...options,
    width: Math.max(options.width ?? 0, 1_280),
    show: false,
    backgroundColor: isDark ? BG_DARK : BG_LIGHT,
    ...(platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: overlayOptions(isDark) } : {}),
    webPreferences: {
      ...options.webPreferences,
      backgroundThrottling: false,
      v8CacheOptions: 'bypassHeatCheck',
      spellcheck: false
    }
  };
}

/* 页面画好后再显示窗口；万一一直没画好，3 秒后也显示出来。切换明暗主题时同步右上角系统按钮的颜色 */
export function showWhenReady(win: BrowserWindow): void {
  let shown: boolean = false;

  function show(): void {
    if (shown || win.isDestroyed()) return;

    shown = true;
    win.show();
  }

  function handleThemeUpdated(): void {
    if (win.isDestroyed()) return;

    try {
      win.setTitleBarOverlay(overlayOptions(nativeTheme.shouldUseDarkColors));
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT);
    } catch { /* 没有启用标题栏覆盖层的平台 */ }
  }

  win.once('ready-to-show', show);
  setTimeout(show, 3_000);

  if (platform === 'win32') {
    nativeTheme.on('updated', handleThemeUpdated);
    win.once('closed', (): void => {
      nativeTheme.off('updated', handleThemeUpdated);
    });
  }
}
