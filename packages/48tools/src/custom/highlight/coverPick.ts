import { getFFmpeg } from '../../utils/utils';
import { showOpenDialog } from '../../utils/remote/dialog';
import { addPicture, capturePicture, coverDir } from './highlightCover';
import type { ShowInfo } from './highlightShow';
import type { ClipDraft } from './highlightTypes';

/**
 * 定标题时换封面的图（用户 2026-11-26 要的）：上传一张截图、从电台封面库里选、播放时停在哪一帧就用哪一帧。
 * 图存好、小图做好以后返回记在草稿 pictures 里的那一项（./highlightCover 的 addPicture、capturePicture），由 ./DraftPanel 记进草稿。
 */
export const IMAGE_EXTENSIONS: Array<string> = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

/* 选一张图；没选是 undefined */
export async function chooseImage(defaultPath?: string): Promise<string | undefined> {
  const result: { canceled: boolean; filePaths?: Array<string> } = await showOpenDialog({
    title: '选一张图做封面',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
    defaultPath
  });

  return result.canceled ? undefined : result.filePaths?.[0];
}

export function isImageFile(file: string): boolean {
  return new RegExp(`\\.(${ IMAGE_EXTENSIONS.join('|') })$`, 'i').test(file);
}

/* 一张图当封面候选 */
export function addPictureFile(dir: string, info: ShowInfo, draft: ClipDraft, file: string): Promise<string> {
  return addPicture(getFFmpeg(), coverDir(dir, draft.key), file, Boolean(info.stage));
}

/* 录播里的这一刻（录播文件里的秒）当封面候选 */
export function captureFrame(dir: string, info: ShowInfo, draft: ClipDraft, source: string, time: number): Promise<string> {
  return capturePicture(getFFmpeg(), coverDir(dir, draft.key), source, time, Boolean(info.stage));
}
