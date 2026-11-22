/**
 * 公演录像接起来：用本机的 ffmpeg 现做几段 ts（和录直播存的一样），接成一个 mp4，弹幕对到接起来的时间上。
 * 本机没有 ffmpeg 时跳过。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { concatLine, streamSignature, partStart, prepareGongyanSource } from './gongyanSource';
import { mediaDuration } from '../highlight/highlightFfmpeg';
import type { GongyanManifest } from './gongyanRecorder';

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

/* 做一段录像：测试画面 + 正弦波，ts（录制存的格式）或者边录边写、不写时长的 flv */
function makePart(file: string, seconds: number, size: string = '320x180'): void {
  const format: Array<string> = file.endsWith('.flv') ? ['-f', 'flv', '-flvflags', 'no_duration_filesize'] : ['-f', 'mpegts'];

  const res: ReturnType<typeof spawnSync> = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${ size }:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    ...format, '-y', file
  ], { windowsHide: true });

  if (res.status !== 0) throw new Error(String(res.stderr));
}

describe('公演录像：小工具', (): void => {
  test('concat 列表里的文件名：反斜杠换成斜杠，单引号转义', (): void => {
    expect(concatLine('C:\\录像\\it\'s.flv')).toBe('file \'C:/录像/it\'\\\'\'s.flv\'');
  });

  test('画面和声音的参数', (): void => {
    const log: string = `Input #0, flv, from 'a.flv':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp`;

    expect(streamSignature(log)).toBe('h264 1920x1080 aac 48000');
    expect(streamSignature('')).toBe('no-video no-audio');
  });

  test('一段的画面从什么时候开始：录到的比经过的长，多出来的是连上时发来的缓存，画面从更早开始；最多算 10 秒', (): void => {
    expect(partStart({ file: 'a', start: 100_000, end: 140_000 }, 42.5)).toBe(97_500);
    expect(partStart({ file: 'a', start: 100_000, end: 140_000 }, 30)).toBe(100_000); // 卡了一阵才断开
    expect(partStart({ file: 'a', start: 100_000, end: 110_000 }, 40)).toBe(90_000);
    expect(partStart({ file: 'a', start: 100_000 }, 40)).toBe(100_000);              // 还没写结束时间
  });
});

(hasFfmpeg ? describe : describe.skip)('公演录像：真的接一遍', (): void => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gongyan-source-'));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function manifestOf(startedAt: number, parts: Array<{ file: string; start: number }>): GongyanManifest {
    return {
      version: 1,
      room: 1,
      show: { liveId: 't', title: '《示例》公演', subTitle: 'Team X 剧场公演', team: 'X', day: '2026-11-21' },
      biliTitle: '',
      cover: '',
      startedAt,
      parts,
      danmu: 'danmu.lrc'
    };
  }

  test('两段（中间断了 4 秒）：接成 12 秒的 mp4；空档里的弹幕不要，后一段的往前挪；太短的一段不要；再做一次直接用做好的', async (): Promise<void> => {
    makePart(path.join(dir, 'part-01.ts'), 6);
    makePart(path.join(dir, 'part-02.ts'), 6);
    makePart(path.join(dir, 'part-03.ts'), 3); // 刚连上就断了
    fs.writeFileSync(path.join(dir, 'danmu.lrc'), [
      '[00:00:03.000]\t第一段',
      '[00:00:08.000]\t空档里',
      '[00:00:11.000]\t第二段',
      '[00:00:21.000]\t太短的那段'
    ].join('\n'));

    const startedAt: number = 1_000_000;
    const manifest: GongyanManifest = manifestOf(startedAt, [
      { file: 'part-01.ts', start: startedAt },
      { file: 'missing.flv', start: startedAt + 6_000 },
      { file: 'part-02.ts', start: startedAt + 10_000 },
      { file: 'part-03.ts', start: startedAt + 20_000 }
    ]);
    const workDir: string = path.join(dir, '切片', '.work');
    const progress: Array<number> = [];
    const result: Awaited<ReturnType<typeof prepareGongyanSource>> = await prepareGongyanSource({
      ffmpeg: FFMPEG, dir, manifest, workDir, progressEnd: 30, onProgress: ({ percent }: { percent: number }): unknown => progress.push(percent)
    });

    expect(result.parts).toBe(2);
    expect(Math.abs(await mediaDuration(FFMPEG, result.source) - 12)).toBeLessThan(0.3);
    expect(result.danmu.map((item: { time: number; message: string }): string => `${ item.time.toFixed(1) } ${ item.message }`))
      .toEqual(['3.0 第一段', '7.0 第二段']);
    expect(progress[progress.length - 1]).toBe(30);

    const made: number = fs.statSync(result.source).mtimeMs;

    await prepareGongyanSource({ ffmpeg: FFMPEG, dir, manifest, workDir, progressEnd: 30, onProgress: (): void => undefined });
    expect(fs.statSync(result.source).mtimeMs).toBe(made);
  }, 120_000);

  test('两段的分辨率不一样：重新编码，长度还是对的', async (): Promise<void> => {
    makePart(path.join(dir, 'part-01.ts'), 6, '320x180');
    makePart(path.join(dir, 'part-02.ts'), 6, '640x360');

    const result: Awaited<ReturnType<typeof prepareGongyanSource>> = await prepareGongyanSource({
      ffmpeg: FFMPEG,
      dir,
      manifest: manifestOf(0, [{ file: 'part-01.ts', start: 0 }, { file: 'part-02.ts', start: 6_000 }]),
      workDir: path.join(dir, '.work'),
      progressEnd: 30,
      onProgress: (): void => undefined
    });

    expect(Math.abs(await mediaDuration(FFMPEG, result.source) - 12)).toBeLessThan(0.3);
    expect(result.danmu).toEqual([]); // 没有弹幕文件
  }, 120_000);

  test('断线、停止时结尾写了一半：ts 照样接得上；flv 先整理一遍再接，长度都是对的', async (): Promise<void> => {
    function cutTail(file: string, bytes: number): void {
      const data: Buffer = fs.readFileSync(file);

      fs.writeFileSync(file, data.subarray(0, data.length - bytes));
    }

    for (const ext of ['ts', 'flv']) {
      const a: string = path.join(dir, `a.${ ext }`);
      const b: string = path.join(dir, `b.${ ext }`);
      const workDir: string = path.join(dir, `.work-${ ext }`);

      makePart(a, 8);
      makePart(b, 8);
      cutTail(a, 777);
      cutTail(b, 777);

      const result: Awaited<ReturnType<typeof prepareGongyanSource>> = await prepareGongyanSource({
        ffmpeg: FFMPEG,
        dir,
        manifest: manifestOf(0, [{ file: `a.${ ext }`, start: 0 }, { file: `b.${ ext }`, start: 8_000 }]),
        workDir,
        progressEnd: 30,
        onProgress: (): void => undefined
      });

      expect(Math.abs(await mediaDuration(FFMPEG, result.source) - 16)).toBeLessThan(0.6);
      expect(fs.readdirSync(workDir).filter((name: string): boolean => name.startsWith('clean-'))).toEqual([]); // 整理用的文件删掉了
    }
  }, 120_000);

  test('一段能用的都没有：报错', async (): Promise<void> => {
    await expect(prepareGongyanSource({
      ffmpeg: FFMPEG, dir, manifest: manifestOf(0, [{ file: 'none.flv', start: 0 }]), workDir: path.join(dir, '.work'), progressEnd: 30, onProgress: (): void => undefined
    })).rejects.toThrow('没有录到能用的录像');
  });
});
