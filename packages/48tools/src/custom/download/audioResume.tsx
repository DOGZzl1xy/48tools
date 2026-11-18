import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModalStaticFunctions } from 'antd/es/modal/confirm';
import { getDefaultSaveDir } from './defaultSaveDir';
import { partAacPath, type AudioResumeState } from './audioResumeState';

/**
 * 音频下载的断点续传（界面部分）：点「下载音频」时，如果默认下载文件夹里有这个录播没下完的记录，
 * 问用户要不要接着下。记录由 custom/download/audioExtract 在下载过程中写入（文件名.part.json）。
 * 接入点：Pocket48Record.tsx 的 handleDownloadM3u8Click。
 */
type ModalApi = Omit<ModalStaticFunctions, 'warn'>;

/* 在文件夹里找这个录播没下完的记录（有多个时取最新的） */
export function findAudioResume(dir: string | undefined, liveId: string): AudioResumeState | undefined {
  if (!dir) return undefined;

  let names: Array<string> = [];

  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }

  const stateNames: Array<string> = names.filter((name: string): boolean => name.endsWith('.part.json') && name.includes(liveId));
  let best: AudioResumeState | undefined;

  for (const name of stateNames) {
    try {
      const state: AudioResumeState = JSON.parse(fs.readFileSync(path.join(dir, name), { encoding: 'utf8' }));
      const aacSize: number = fs.statSync(partAacPath(state.filePath)).size;
      const usable: boolean = state.version === 1
        && state.liveId === liveId
        && state.nextIndex > 0
        && state.nextIndex < state.total
        && aacSize >= state.aacBytes
        && path.resolve(path.dirname(state.filePath)) === path.resolve(dir);

      if (usable && (!best || state.updatedAt > best.updatedAt)) best = state;
    } catch { /* 记录损坏或音频文件不在了 */ }
  }

  return best;
}

/**
 * 询问是否继续上次的下载
 * @return 要继续的文件路径；undefined：没有记录或用户选择重新下载；null：用户取消
 */
export function pickAudioResume(modalApi: ModalApi, liveId: string): Promise<string | undefined | null> {
  const state: AudioResumeState | undefined = findAudioResume(getDefaultSaveDir(), liveId);

  if (!state) return Promise.resolve(undefined);

  const percent: number = Math.floor(state.nextIndex / state.total * 100);

  return new Promise((resolve: (value: string | undefined | null) => void): void => {
    modalApi.confirm({
      title: '发现没下完的音频',
      content: (
        <div>
          <p>这个录播上次下载到了 { percent }%，要接着下载吗？</p>
          <p className="text-[12px] break-all opacity-70">{ path.basename(state.filePath) }</p>
        </div>
      ),
      okText: '接着下载',
      cancelText: '重新下载',
      closable: true,
      centered: true,
      onOk: (): void => resolve(state.filePath),
      onCancel(...args: Array<unknown>): void {
        // 点右上角的关闭或遮罩时 antd 会带参数调用，这种情况算取消；点「重新下载」按钮时没有参数
        resolve(args.length > 0 ? null : undefined);
      }
    });
  });
}
