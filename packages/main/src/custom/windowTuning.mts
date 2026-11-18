import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/**
 * 主窗口的几项调整：
 *   - 默认宽度加大到 1280（新界面多了侧边栏），最小尺寸不变
 *   - 先隐藏，页面第一次画好之后再显示，并把窗口底色设成和界面一致：启动时不再先闪一下白屏
 *   - backgroundThrottling 关闭：窗口最小化 / 被遮住时，定时器不被浏览器降频。
 *     自动抓取靠定时器轮询，降频后可能晚一分钟才发现直播
 *   - v8CacheOptions 设为 bypassHeatCheck：第一次运行就缓存编译好的脚本，之后启动少做一遍编译
 *   - 关闭拼写检查（输入框都是成员名、地址，用不上）
 * 颜色要和 packages/48tools/src/custom/theme/modernTheme.ts 的窗口底色一致。
 * 接入点：ProcessWindow.mts 创建主窗口的地方。
 */
const BG_LIGHT: string = '#f3f4f6';
const BG_DARK: string = '#0b0d10';

export function tuneWindowOptions(options: BrowserWindowConstructorOptions, isDark: boolean): BrowserWindowConstructorOptions {
  return {
    ...options,
    width: Math.max(options.width ?? 0, 1_280),
    show: false,
    backgroundColor: isDark ? BG_DARK : BG_LIGHT,
    webPreferences: {
      ...options.webPreferences,
      backgroundThrottling: false,
      v8CacheOptions: 'bypassHeatCheck',
      spellcheck: false
    }
  };
}

/* 页面画好后再显示窗口；万一一直没画好，3 秒后也显示出来 */
export function showWhenReady(win: BrowserWindow): void {
  let shown: boolean = false;

  function show(): void {
    if (shown || win.isDestroyed()) return;

    shown = true;
    win.show();
  }

  win.once('ready-to-show', show);
  setTimeout(show, 3_000);
}
