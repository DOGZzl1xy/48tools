import * as path from 'node:path';
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { TrashChannel } from './trashChannel.js';

/**
 * 把文件放进回收站。界面里也有 shell.trashItem，但在 Windows 上会报「Failed to create FileOperation instance」
 * （回收站的接口只能在主进程里用，2026-11-23 实测），所以放在这里。
 * 接入点：packages/main/src/main.mts 启动时调用 registerTrash；界面用 48tools/src/custom/common/trashFile。
 */
async function trash(_event: IpcMainInvokeEvent, file: unknown): Promise<void> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('要删的文件不对');

  await shell.trashItem(path.normalize(file));
}

export function registerTrash(): void {
  ipcMain.removeHandler(TrashChannel.Trash);
  ipcMain.handle(TrashChannel.Trash, trash);
}
