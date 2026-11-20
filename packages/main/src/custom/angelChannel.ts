/* 守护天使网页窗口的 ipc 通道名（临时功能）。主进程（./angelWindow）和页面（48tools/src/custom/angel/AngelPage）共用 */
export const enum AngelChannel {
  Open = 'custom:angel:open' // 打开窗口；已经开着就拿到前面并刷新
}
