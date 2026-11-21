import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { runFfmpeg } from './highlightFfmpeg';
import { HighlightStopped } from './highlightGemini';
import { parseRecognizerOutput, parseRecognizerFiles, type TimedToken } from './highlightTokens';

/**
 * 「本地打轴」插件里和使用有关的部分：插件装在哪、装没装、怎么调用它识别一段音频。
 * 安装和卸载在 ./alignerPlugin（那边要联网下载，这边不联网，测试里可以直接用）。
 *
 * 插件装在 %LOCALAPPDATA%\48tools-plugins\aligner 里（不在程序文件夹里，重新打包、升级都不用重装）：
 *   runtime\<运行程序的名字>\bin\sherpa-onnx-offline.exe 和它要的 dll
 *   model\<模型的名字>\model.int8.onnx、tokens.txt
 *   installed.json   装完才写，用来判断装没装好
 * 用的时候像 ffmpeg 一样当成外部程序调用：给它一个 16kHz 的 wav，它在标准输出里打印一行 JSON（每个字和它开始的时间）。
 */
export const ALIGNER_RUNTIME: string = 'sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-no-tts';
export const ALIGNER_MODEL: string = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';
export const ALIGNER_MARKER: string = 'installed.json';

/* 下面这些都是相对于插件文件夹的路径。调用识别程序时当前文件夹设成插件文件夹、参数全用相对路径，用户名里有中文也不会出问题 */
export const ALIGNER_EXE: string = path.join('runtime', ALIGNER_RUNTIME, 'bin', 'sherpa-onnx-offline.exe');
export const ALIGNER_MODEL_FILE: string = path.join('model', ALIGNER_MODEL, 'model.int8.onnx');
export const ALIGNER_TOKENS_FILE: string = path.join('model', ALIGNER_MODEL, 'tokens.txt');
const WORK_FOLDER: string = 'work';

export function alignerDir(): string {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), '48tools-plugins', 'aligner');
}

export function isAlignerInstalled(): boolean {
  const dir: string = alignerDir();

  return [ALIGNER_MARKER, ALIGNER_EXE, ALIGNER_MODEL_FILE, ALIGNER_TOKENS_FILE].every((file: string): boolean => fs.existsSync(path.join(dir, file)));
}

/**
 * 运行一个外部程序，返回它的标准输出
 * @param { string } command
 * @param { Array<string> } args
 * @param { string } cwd
 * @param { AbortSignal } [signal] - 中止时结束这个程序，报 HighlightStopped
 */
export function runTool(command: string, args: Array<string>, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve: (stdout: string) => void, reject: (reason: Error) => void): void => {
    if (signal?.aborted) {
      reject(new HighlightStopped());

      return;
    }

    const child: ChildProcessWithoutNullStreams = spawn(command, args, { cwd, windowsHide: true });
    const out: Array<Buffer> = [];
    let err: string = '';

    function handleAbort(): void {
      child.kill();
    }

    signal?.addEventListener('abort', handleAbort, { once: true });
    child.stdout.on('data', (data: Buffer): number => out.push(data));
    child.stderr.on('data', (data: Buffer): void => {
      err = (err + data.toString('utf8')).slice(-4_000);
    });
    child.on('error', (error: Error): void => {
      signal?.removeEventListener('abort', handleAbort);
      reject(error);
    });
    child.on('close', (code: number | null): void => {
      signal?.removeEventListener('abort', handleAbort);

      if (signal?.aborted) {
        reject(new HighlightStopped());
      } else if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        reject(new Error(`${ path.basename(command) } 出错（退出码 ${ code }）：${ err.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? '' }`));
      }
    });
  });
}

let counter: number = 0;
const CHUNK_SECONDS: number = 30;  // 长音频切成这么长的小段分别识别（模型是按 30 秒以内的话训练的，太长会漏）
const LONG_SECONDS: number = 300;  // 超过这么长才切；几分钟的片段整段识别更准（不会把一个字切成两半）
const WAV_HEADER: number = 44;
const WAV_BYTES_PER_SECOND: number = 16_000 * 2;
const FILES_PER_RUN: number = 80;

function recognizerArgs(files: Array<string>): Array<string> {
  return [
    `--tokens=${ ALIGNER_TOKENS_FILE }`,
    `--sense-voice-model=${ ALIGNER_MODEL_FILE }`,
    '--sense-voice-language=zh',
    '--sense-voice-use-itn=false',
    `--num-threads=${ Math.max(1, Math.min(4, os.cpus().length - 1)) }`,
    ...files
  ];
}

/**
 * 用本地模型识别一段音频（几分钟的片段，或者半小时的一整段），返回每个字和它开始的时间；没装插件时返回 null
 * @param { string } ffmpeg
 * @param { string } audioFile - 任意格式的音频文件
 * @param { AbortSignal } [signal]
 */
export async function recognizeAudio(ffmpeg: string, audioFile: string, signal?: AbortSignal): Promise<Array<TimedToken> | null> {
  if (!isAlignerInstalled()) return null;

  const dir: string = alignerDir();
  const wav: string = path.join(WORK_FOLDER, `${ process.pid }-${ Date.now() }-${ counter++ }.wav`);

  await fsP.mkdir(path.join(dir, WORK_FOLDER), { recursive: true });

  try {
    await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', audioFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path.join(dir, wav)], { signal });

    // 几分钟以内的整段识别
    if ((await fsP.stat(path.join(dir, wav))).size <= WAV_HEADER + (LONG_SECONDS * WAV_BYTES_PER_SECOND)) {
      return parseRecognizerOutput(await runTool(path.join(dir, ALIGNER_EXE), recognizerArgs([wav]), dir, signal));
    }

    // 长音频（找爆点时的半小时一段）：切成 30 秒的小段，一次交给识别程序几十个文件，再把每段的时间加上它在整段里的位置
    const chunkDir: string = wav.replace(/\.wav$/, '');

    await fsP.mkdir(path.join(dir, chunkDir), { recursive: true });

    try {
      await runFfmpeg(ffmpeg, [
        '-y', '-v', 'error', '-i', path.join(dir, wav), '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c:a', 'pcm_s16le',
        path.join(dir, chunkDir, '%05d.wav')
      ], { signal });

      const names: Array<string> = (await fsP.readdir(path.join(dir, chunkDir))).filter((name: string): boolean => name.endsWith('.wav')).sort();
      const tokens: Array<TimedToken> = [];
      let offset: number = 0;

      for (let from: number = 0; from < names.length; from += FILES_PER_RUN) {
        const batch: Array<string> = names.slice(from, from + FILES_PER_RUN);
        const results: Array<Array<TimedToken>> = parseRecognizerFiles(await runTool(
          path.join(dir, ALIGNER_EXE), recognizerArgs(batch.map((name: string): string => path.join(chunkDir, name))), dir, signal));

        if (results.length !== batch.length) throw new Error(`本地识别的结果数量不对（给了 ${ batch.length } 段，回来 ${ results.length } 段）`);

        for (const [order, name] of batch.entries()) {
          for (const token of results[order]) tokens.push({ text: token.text, time: offset + token.time });

          // 这一小段实际有多长，从文件大小算（切的地方不一定正好是 30 秒）
          offset += ((await fsP.stat(path.join(dir, chunkDir, name))).size - WAV_HEADER) / WAV_BYTES_PER_SECOND;
        }
      }

      return tokens;
    } finally {
      await fsP.rm(path.join(dir, chunkDir), { recursive: true, force: true });
    }
  } finally {
    await fsP.rm(path.join(dir, wav), { force: true });
  }
}
