import type { WebContents, Event as ElectronEvent, Input } from 'electron';

/**
 * 开发模式的快捷键（应用去掉了顶部菜单，默认的刷新、开发者工具快捷键都不可用）：
 *   - F5 / Ctrl+R：刷新页面
 *   - F12 / Ctrl+Shift+I：打开或关闭开发者工具
 * 接入点：ProcessWindow.mts、ipcListener/openPlayerHtml.mts 在开发模式下调用。
 */
export function registerDevShortcuts(contents: WebContents): void {
  contents.on('before-input-event', function(event: ElectronEvent, input: Input): void {
    if (input.type !== 'keyDown') return;

    const key: string = input.key.toLowerCase();
    const ctrl: boolean = input.control || input.meta;

    if (key === 'f5' || (ctrl && !input.shift && key === 'r')) {
      event.preventDefault();
      contents.reload();
    } else if (key === 'f12' || (ctrl && input.shift && key === 'i')) {
      event.preventDefault();
      contents.toggleDevTools();
    }
  });
}
