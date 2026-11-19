/* 「关闭窗口后留在后台」用到的 ipc 通道名。主进程（./backgroundTray）和设置页面（48tools/src/custom/settings/BackgroundOption）共用 */
export const enum BackgroundChannel {
  Get = 'custom:background:get',         // 取得现在的状态：{ supported, enabled }
  Set = 'custom:background:set',         // 打开 / 关闭，返回新的状态
  Quit = 'custom:background:quit',       // 退出程序
  Changed = 'custom:background:changed'  // 主进程通知页面：在托盘菜单里改了开关
}
