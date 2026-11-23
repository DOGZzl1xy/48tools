/* 把文件放进回收站用到的 ipc 通道名。主进程（./trashFile）和界面（48tools/src/custom/common/trashFile）共用 */
export const enum TrashChannel {
  Trash = 'custom:trash' // 文件的完整路径 → 放好了；失败时报错
}
