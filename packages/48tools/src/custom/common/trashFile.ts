import { ipcRenderer } from 'electron';
import { TrashChannel } from '@48tools/main/src/custom/trashChannel';

/* 把一个文件放进回收站（要在主进程里做，见 packages/main/src/custom/trashFile）；文件被占用等放不进去时报错 */
export async function trashFile(file: string): Promise<void> {
  await ipcRenderer.invoke(TrashChannel.Trash, file);
}
