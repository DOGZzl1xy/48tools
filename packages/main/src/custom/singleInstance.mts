import { env, argv } from 'node:process';
import { app, type BrowserWindow } from 'electron';

const QUIT_FLAG: string = '--quit';

/**
 * 只允许运行一个 48tools。
 * 原来可以同时开两个：先开的那个退出时会把口袋48代理一起关掉，另一个就会 403；两个窗口还会各自录制同一场直播。
 * 现在第二次双击不会再开新程序，而是把已经打开的窗口调到前面。
 * 用 `48tools.exe --quit` 可以让已经在运行的 48tools 正常退出（关闭窗口后程序会留在后台，见 ./backgroundTray，
 * 脚本需要一个不用点托盘菜单的退出办法，打包脚本的启动检查就用它）。
 * 自动化测试（TEST=true）时不限制。
 * 接入点：main.mts（应用启动前调用，返回 false 时不要再创建窗口）。
 * @param { () => BrowserWindow | null } getWindow - 取得主窗口
 * @return { boolean } 当前进程是否可以继续启动
 */
export function ensureSingleInstance(getWindow: () => BrowserWindow | null): boolean {
  if (env.TEST === 'true') return true;

  if (!app.requestSingleInstanceLock()) {
    app.quit();

    return false;
  }

  // 带 --quit 启动，但没有正在运行的 48tools：没有什么要退出的，自己也不用启动
  if (argv.includes(QUIT_FLAG)) {
    app.quit();

    return false;
  }

  app.on('second-instance', function(event: unknown, commandLine: Array<string>): void {
    if (commandLine.includes(QUIT_FLAG)) {
      app.quit();

      return;
    }

    const win: BrowserWindow | null = getWindow();

    if (!win) return;

    if (win.isMinimized()) win.restore();

    win.show();
    win.focus();
  });

  return true;
}
