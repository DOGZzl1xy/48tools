import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { useSyncExternalStore } from 'react';
// @ts-expect-error
import got from 'got';
import {
  alignerDir, isAlignerInstalled, runTool,
  ALIGNER_RUNTIME, ALIGNER_MODEL, ALIGNER_MARKER, ALIGNER_EXE, ALIGNER_MODEL_FILE, ALIGNER_TOKENS_FILE
} from './alignerRun';

/**
 * 录播自动切片的「本地打轴」插件的安装和卸载。插件是一个可选安装的本地语音识别模型，用来给字幕定时间（见 ./highlightTokens）；
 * 装在哪、怎么调用见 ./alignerRun。
 * 不装也能用（字幕时间由 Gemini 给、再用停顿和音节对一遍，见 ./highlightAlign）；装了以后时间更准、每次结果都一样。
 *
 * 装的是什么（都从 github.com/k2-fsa/sherpa-onnx 的发布页下载，下载后核对 SHA-256）：
 *   - 运行程序：sherpa-onnx 的 Windows 命令行工具，只留 sherpa-onnx-offline.exe 和它要的 dll（约 21MB）
 *   - 模型：SenseVoice 小模型的 int8 版（中文 / 粤语 / 英语 / 日语 / 韩语，约 230MB）
 * 卸载就是删掉插件的文件夹。
 *
 * 接入点：./AlignerOption（设置页里的安装 / 卸载）。
 */
interface AlignerPart {
  folder: 'runtime' | 'model'; // 解压到插件文件夹下面的哪个子文件夹
  label: string;
  name: string;                // 压缩包里最外层文件夹的名字
  url: string;
  sha256: string;
  size: number;                // 压缩包的字节数，算下载进度用
}

const RELEASES: string = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const PARTS: Array<AlignerPart> = [
  {
    folder: 'runtime',
    label: '运行程序',
    name: ALIGNER_RUNTIME,
    url: `${ RELEASES }/v2.0.2/${ ALIGNER_RUNTIME }.tar.bz2`,
    sha256: '6a71d5ef016e544026d6505486d9fa42177ad989238adc6e4bd2eebfb6947416',
    size: 26_896_305
  },
  {
    folder: 'model',
    label: '模型',
    name: ALIGNER_MODEL,
    url: `${ RELEASES }/asr-models/${ ALIGNER_MODEL }.tar.bz2`,
    sha256: '7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63',
    size: 165_783_878
  }
];
const TOTAL_BYTES: number = PARTS.reduce((sum: number, part: AlignerPart): number => sum + part.size, 0);
const MARKER_VERSION: number = 1;
const KEEP_IN_BIN: Array<string> = ['sherpa-onnx-offline.exe', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'];

export const ALIGNER_DOWNLOAD_MB: number = Math.round(TOTAL_BYTES / 1_048_576);
export const ALIGNER_DISK_MB: number = 250;

/* ---------- 安装的状态（设置页显示用） ---------- */
export interface AlignerState {
  installed: boolean;
  busy: boolean;      // 正在安装或卸载
  percent: number;    // 安装进度 0 ~ 100
  detail: string;
  error?: string;
}

let state: AlignerState = { installed: false, busy: false, percent: 0, detail: '' };
let checked: boolean = false;
let installing: AbortController | null = null;
const listeners: Set<() => void> = new Set();

function setState(patch: Partial<AlignerState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

function getState(): AlignerState {
  // 第一次用到时看一眼硬盘上装没装
  if (!checked) {
    checked = true;
    state = { ...state, installed: isAlignerInstalled() };
  }

  return state;
}

export function useAlignerState(): AlignerState {
  return useSyncExternalStore(subscribe, getState);
}

/* ---------- 安装、卸载 ---------- */

/* 下载一个压缩包，边下边算 SHA-256；对不上就删掉并报错 */
async function download(part: AlignerPart, file: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<void> {
  const hash: Hash = createHash('sha256');
  const request: NodeJS.ReadableStream = got.stream(part.url, { timeout: { lookup: 20_000, connect: 20_000, response: 60_000, socket: 60_000 } });

  request.on('data', (chunk: Buffer): void => {
    hash.update(chunk);
    onBytes(chunk.length);
  });
  await pipeline(request, fs.createWriteStream(file), { signal });

  if (hash.digest('hex') !== part.sha256) {
    await fsP.rm(file, { force: true });

    throw new Error(`下载的文件和预期的不一样（${ path.basename(part.url) } 的 SHA-256 对不上），已经删掉。可能是下载不完整，请再试一次`);
  }
}

/* Windows 自带的 tar（能解 .tar.bz2） */
function tarExe(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * 安装：下载两个压缩包、核对、解压、删掉用不到的文件。进度通过 useAlignerState 看；中途可以 cancelAlignerInstall
 */
export async function installAligner(): Promise<void> {
  if (state.busy) return;

  const dir: string = alignerDir();
  const downloadDir: string = path.join(dir, 'download');
  const controller: AbortController = new AbortController();
  let done: number = 0;
  let lastShown: number = 0;

  installing = controller;
  setState({ busy: true, percent: 0, detail: '准备下载…', error: undefined });

  try {
    await fsP.rm(path.join(dir, ALIGNER_MARKER), { force: true });
    await fsP.mkdir(downloadDir, { recursive: true });

    for (const part of PARTS) {
      await download(part, path.join(downloadDir, `${ part.folder }.tar.bz2`), controller.signal, (bytes: number): void => {
        done += bytes;

        // 下载占 90%；不用每个数据块都刷新界面
        if (done - lastShown > 1_000_000 || done >= TOTAL_BYTES) {
          lastShown = done;
          setState({
            percent: Math.min(90, (done / TOTAL_BYTES) * 90),
            detail: `下载${ part.label } ${ (done / 1_048_576).toFixed(0) } / ${ (TOTAL_BYTES / 1_048_576).toFixed(0) } MB`
          });
        }
      });
    }

    for (const [order, part] of PARTS.entries()) {
      setState({ percent: 90 + (order * 4), detail: `解压${ part.label }…` });
      await fsP.rm(path.join(dir, part.folder), { recursive: true, force: true });
      await fsP.mkdir(path.join(dir, part.folder), { recursive: true });
      // 当前文件夹设成插件文件夹、参数用相对路径（和 alignerRun 里一样的道理）
      await runTool(tarExe(), ['-xjf', path.join('download', `${ part.folder }.tar.bz2`), '-C', part.folder], dir, controller.signal);
    }

    // 运行程序的压缩包里有几十个别的工具和开发用的库，只留用得到的
    setState({ percent: 98, detail: '整理文件…' });

    const runtimeDir: string = path.join(dir, 'runtime', ALIGNER_RUNTIME);

    for (const name of await fsP.readdir(path.join(runtimeDir, 'bin'))) {
      if (!KEEP_IN_BIN.includes(name)) await fsP.rm(path.join(runtimeDir, 'bin', name), { recursive: true, force: true });
    }

    await fsP.rm(path.join(runtimeDir, 'lib'), { recursive: true, force: true });
    await fsP.rm(path.join(runtimeDir, 'include'), { recursive: true, force: true });
    await fsP.rm(path.join(dir, 'model', ALIGNER_MODEL, 'test_wavs'), { recursive: true, force: true });
    await fsP.rm(downloadDir, { recursive: true, force: true });

    if (![ALIGNER_EXE, ALIGNER_MODEL_FILE, ALIGNER_TOKENS_FILE].every((file: string): boolean => fs.existsSync(path.join(dir, file)))) {
      throw new Error('解压出来的文件不全');
    }

    await fsP.writeFile(path.join(dir, ALIGNER_MARKER), JSON.stringify({
      version: MARKER_VERSION, runtime: ALIGNER_RUNTIME, model: ALIGNER_MODEL, installedAt: new Date().toISOString()
    }));
    setState({ installed: true, busy: false, percent: 100, detail: '' });
  } catch (err) {
    await fsP.rm(downloadDir, { recursive: true, force: true }).catch((): void => undefined);
    setState({
      installed: isAlignerInstalled(),
      busy: false,
      percent: 0,
      detail: '',
      error: controller.signal.aborted ? undefined : (err instanceof Error ? err.message : String(err))
    });
  } finally {
    installing = null;
  }
}

export function cancelAlignerInstall(): void {
  installing?.abort();
}

/* 卸载：删掉整个插件文件夹 */
export async function uninstallAligner(): Promise<void> {
  if (state.busy) return;

  setState({ busy: true, detail: '正在卸载…', error: undefined });

  try {
    await fsP.rm(alignerDir(), { recursive: true, force: true });
    setState({ installed: false, busy: false, percent: 0, detail: '' });
  } catch (err) {
    setState({ installed: isAlignerInstalled(), busy: false, detail: '', error: `卸载失败：${ err instanceof Error ? err.message : String(err) }` });
  }
}
