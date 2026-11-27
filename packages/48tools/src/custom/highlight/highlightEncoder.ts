import * as process from 'node:process';
import { runFfmpeg, type RunOptions } from './highlightFfmpeg';
import { HighlightStopped } from './highlightGemini';

/**
 * 合成成片时画面用什么编码：优先用显卡（NVIDIA 的 h264_nvenc），用不了再用 CPU（libx264）。
 * 用户 2026-11-27 要的。以前一直是 CPU：2026-11-23 量过一次（62 秒的公演切片，CPU 29.9 秒、显卡 5.9 秒，画质 SSIM 一样），
 * 当时只问了一句要不要换，没有做，公演一次渲染十几个时很慢。
 *
 * 怎么知道显卡能不能用：ffmpeg 列得出 h264_nvenc 不代表真的能用（没有 N 卡、驱动太旧时一开始编码就报错），
 * 所以真的编几帧试一下，结果这次运行里记着（每个 ffmpeg 试一次）。
 * 试的时候能用、真合成时却失败了：这一次立刻改用 CPU 重做，不让切片失败；连着两次这样，这次运行后面都用 CPU。
 * 画质对应：CPU 的 crf 20 ≈ 显卡的 cq 23（渲染），crf 18 ≈ cq 21（改标题时整段再编一次，要求高一点）。显卡编出来的文件大一些。
 * 用显卡时录播的解码也交给显卡（-hwaccel cuda；解不了时 ffmpeg 自己会退回 CPU 解码）。缩放、叠底图、压字幕、响度这些滤镜还在 CPU 上：
 * 字幕（libass）只能在 CPU 上画，为了它来回搬画面不划算。
 * 2026-11-27 在这台机器上量的（8 线程的 CPU + RTX 5060 Ti，60 秒的公演切片，照成片的滤镜）：
 *   CPU 编码：用时 39.4 秒，占 CPU 225 秒，47 MB
 *   显卡编码：用时 13.0 秒，占 CPU 63 秒，77 MB
 *   显卡编码 + 显卡解码：用时 12.6 秒，占 CPU 43 秒，77 MB
 *
 * 环境变量 HIGHLIGHT_ENCODER=cpu / gpu 可以强制指定。单元测试里默认用 CPU（各台机器的结果才一样），
 * 只有 ./highlightEncoder.spec 真的去试显卡。
 * 接入点：./highlightPipeline（renderClip、retitleClip）。别处的压缩（直播录制转码、公演录像接起来时重编）没有动，还是 CPU。
 */
export type EncoderKind = 'gpu' | 'cpu';
export type EncodeQuality = 'render' | 'retitle';

const GPU_QUALITY: Record<EncodeQuality, string> = { render: '23', retitle: '21' };
const CPU_QUALITY: Record<EncodeQuality, string> = { render: '20', retitle: '18' };
const GPU_FAILURES_ALLOWED: number = 2;

export const ENCODER_NAME: Record<EncoderKind, string> = { gpu: '显卡', cpu: 'CPU' };

/* 解码的参数（放在要解码的那个 -i 前面） */
export function decodeArgs(kind: EncoderKind): Array<string> {
  return kind === 'gpu' ? ['-hwaccel', 'cuda'] : [];
}

/* 画面编码的参数（放在 -map 后面、声音的参数前面） */
export function encodeArgs(kind: EncoderKind, quality: EncodeQuality): Array<string> {
  return kind === 'gpu'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', GPU_QUALITY[quality], '-b:v', '0', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-crf', CPU_QUALITY[quality]];
}

const probes: Map<string, Promise<EncoderKind>> = new Map();
let gpuFailures: number = 0;

/* 强制用哪个（环境变量），没指定时返回 undefined；单元测试里默认 CPU */
function forcedEncoder(): EncoderKind | undefined {
  const wanted: string | undefined = process.env.HIGHLIGHT_ENCODER?.toLowerCase();

  if (wanted === 'cpu' || wanted === 'gpu') return wanted;

  return process.env.JEST_WORKER_ID === undefined ? undefined : 'cpu';
}

/* 真的用显卡编几帧，看能不能用 */
async function probeGpu(ffmpeg: string): Promise<EncoderKind> {
  try {
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30', '-frames:v', '5',
      ...encodeArgs('gpu', 'render'), '-f', 'null', '-'
    ]);

    return 'gpu';
  } catch (err) {
    console.info('显卡编码用不了，切片合成用 CPU：', err instanceof Error ? err.message : err);

    return 'cpu';
  }
}

/* 这个 ffmpeg 合成时用显卡还是 CPU（试一次，这次运行里记着） */
export function pickEncoder(ffmpeg: string): Promise<EncoderKind> {
  const forced: EncoderKind | undefined = forcedEncoder();

  if (forced === 'cpu') return Promise.resolve('cpu');

  if (gpuFailures >= GPU_FAILURES_ALLOWED && forced !== 'gpu') return Promise.resolve('cpu');

  let probe: Promise<EncoderKind> | undefined = probes.get(ffmpeg);

  if (!probe) {
    probe = probeGpu(ffmpeg);
    probes.set(ffmpeg, probe);
  }

  return probe;
}

/* 交给 build 的两段参数：decode 放在录播的 -i 前面，encode 放在 -map 后面 */
export interface CodecArgs {
  encode: Array<string>;
  decode: Array<string>;
}

function codecArgs(kind: EncoderKind, quality: EncodeQuality): CodecArgs {
  return { encode: encodeArgs(kind, quality), decode: decodeArgs(kind) };
}

export interface EncodeOptions extends RunOptions {
  onEncoder?: (kind: EncoderKind) => void; // 这一次用的是哪个（开始时告诉一次；显卡失败改用 CPU 时再告诉一次）
}

/**
 * 跑一次要编码画面的 ffmpeg：优先显卡，显卡失败了这一次改用 CPU 重做
 * @param { string } ffmpeg
 * @param { (codec: CodecArgs) => Array<string> } build - 给它解码、编码的参数，返回完整的 ffmpeg 参数
 * @param { EncodeQuality } quality
 * @param { EncodeOptions } [options]
 * @return { Promise<EncoderKind> } 最后是用哪个做成的
 */
export async function runEncode(
  ffmpeg: string, build: (codec: CodecArgs) => Array<string>, quality: EncodeQuality, options: EncodeOptions = {}
): Promise<EncoderKind> {
  const { onEncoder, ...run }: EncodeOptions = options;
  const kind: EncoderKind = await pickEncoder(ffmpeg);

  onEncoder?.(kind);

  if (kind === 'gpu') {
    try {
      await runFfmpeg(ffmpeg, build(codecArgs('gpu', quality)), run);
      gpuFailures = 0; // 「连着」失败才算：中间成功过就重新数

      return 'gpu';
    } catch (err) {
      if (err instanceof HighlightStopped) throw err;

      console.warn('显卡编码没成功，这一次改用 CPU 重做：', err instanceof Error ? err.message : err);
      onEncoder?.('cpu');
      await runFfmpeg(ffmpeg, build(codecArgs('cpu', quality)), run); // CPU 也不行就是别的问题，照常报错
      gpuFailures++; // CPU 做成了，说明问题出在显卡编码上

      return 'cpu';
    }
  }

  await runFfmpeg(ffmpeg, build(codecArgs('cpu', quality)), run);

  return 'cpu';
}

/* 测试用 */
export function resetEncoderForTest(): void {
  probes.clear();
  gpuFailures = 0;
}
