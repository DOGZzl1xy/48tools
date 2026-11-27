/**
 * 合成时画面用显卡还是 CPU 编码（highlightEncoder）：
 *   - 参数：显卡是 h264_nvenc 加显卡解码，CPU 是 libx264、不加解码参数
 *   - 单元测试里默认 CPU（别的测试的结果各台机器才一样），环境变量可以强制
 *   - 显卡这一次失败了：立刻用 CPU 重做，切片不失败；连着两次以后都用 CPU
 *   - 本机有能用的显卡编码时，真的用显卡合成一小段，看得出是 h264、长度对
 * 本机没有 ffmpeg 时跳过要 ffmpeg 的那几个。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { decodeArgs, encodeArgs, pickEncoder, resetEncoderForTest, runEncode, type CodecArgs, type EncoderKind } from './highlightEncoder';
import { mediaDuration } from './highlightFfmpeg';

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

describe('合成用的编码器', (): void => {
  const saved: string | undefined = process.env.HIGHLIGHT_ENCODER;

  beforeEach((): void => {
    delete process.env.HIGHLIGHT_ENCODER;
    resetEncoderForTest();
  });

  afterAll((): void => {
    if (saved === undefined) delete process.env.HIGHLIGHT_ENCODER;
    else process.env.HIGHLIGHT_ENCODER = saved;

    resetEncoderForTest();
  });

  test('参数：显卡用 h264_nvenc 和显卡解码，CPU 用 libx264、不加解码参数；改标题的画质要求高一点', (): void => {
    expect(encodeArgs('gpu', 'render').join(' ')).toBe('-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 23 -b:v 0 -pix_fmt yuv420p');
    expect(encodeArgs('gpu', 'retitle').join(' ')).toContain('-cq 21');
    expect(encodeArgs('cpu', 'render').join(' ')).toBe('-c:v libx264 -preset medium -pix_fmt yuv420p -crf 20');
    expect(encodeArgs('cpu', 'retitle').join(' ')).toContain('-crf 18');
    expect(decodeArgs('gpu')).toEqual(['-hwaccel', 'cuda']);
    expect(decodeArgs('cpu')).toEqual([]);
  });

  test('单元测试里默认用 CPU；环境变量可以强制', async (): Promise<void> => {
    expect(await pickEncoder(FFMPEG)).toBe('cpu');

    process.env.HIGHLIGHT_ENCODER = 'cpu';
    expect(await pickEncoder('不存在的 ffmpeg')).toBe('cpu');
  });

  test('ffmpeg 用不了显卡编码（这里是根本找不到 ffmpeg）：试一次就知道，用 CPU', async (): Promise<void> => {
    const quiet: jest.SpyInstance = jest.spyOn(console, 'info').mockImplementation((): void => undefined);

    process.env.HIGHLIGHT_ENCODER = 'gpu'; // 让它真的去试
    expect(await pickEncoder(path.join(os.tmpdir(), '没有这个 ffmpeg.exe'))).toBe('cpu');
    quiet.mockRestore();
  });

  (hasFfmpeg ? test : test.skip)('显卡这一次没做成：马上用 CPU 重做，切片不失败', async (): Promise<void> => {
    process.env.HIGHLIGHT_ENCODER = 'gpu';

    if (await pickEncoder(FFMPEG) !== 'gpu') return; // 这台机器没有能用的显卡编码，没法测这一条

    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-'));
    const quiet: jest.SpyInstance = jest.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const used: Array<EncoderKind> = [];

    try {
      // 显卡那一遍故意多带一个它不认的参数，CPU 那一遍正常
      const kind: EncoderKind = await runEncode(FFMPEG, ({ encode }: CodecArgs): Array<string> => [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1',
        ...encode, ...(encode.includes('h264_nvenc') ? ['-preset', '没有这个预设'] : []), 'out.mp4'
      ], 'render', { cwd: dir, onEncoder: (now: EncoderKind): void => void used.push(now) });

      expect(kind).toBe('cpu');
      expect(used).toEqual(['gpu', 'cpu']);
      expect(fs.statSync(path.join(dir, 'out.mp4')).size).toBeGreaterThan(1_000);
    } finally {
      quiet.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  (hasFfmpeg ? test : test.skip)('本机有能用的显卡编码时：真的用显卡解码、编码做一小段', async (): Promise<void> => {
    process.env.HIGHLIGHT_ENCODER = 'gpu';

    if (await pickEncoder(FFMPEG) !== 'gpu') return;

    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-'));

    try {
      expect(spawnSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
        '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'source.mp4'
      ], { cwd: dir, windowsHide: true }).status).toBe(0);

      const kind: EncoderKind = await runEncode(FFMPEG, ({ encode, decode }: CodecArgs): Array<string> => [
        '-y', '-v', 'error', ...decode, '-ss', '1', '-t', '2', '-i', 'source.mp4',
        '-filter_complex', '[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1[vout]', '-map', '[vout]', '-map', '0:a', ...encode, '-c:a', 'aac', 'out.mp4'
      ], 'render', { cwd: dir });
      const about: string = String(spawnSync(FFMPEG, ['-hide_banner', '-i', 'out.mp4'], { cwd: dir, windowsHide: true }).stderr);

      expect(kind).toBe('gpu');
      expect(about).toMatch(/Video: h264.*1920x1080/);
      expect(Math.abs(await mediaDuration(FFMPEG, path.join(dir, 'out.mp4')) - 2)).toBeLessThan(0.3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
