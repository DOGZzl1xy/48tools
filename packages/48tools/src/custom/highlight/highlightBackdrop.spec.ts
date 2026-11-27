/**
 * 成片的底图走 Canvas 的那条路（程序里实际走的）：底图是一张一直循环的 PNG，交给 ffmpeg 和画面、字幕合成。
 * 测试环境里没有 Canvas，别的测试走的都是回退的纯色底，所以这里用一张 ffmpeg 做的纯色 PNG 当底图，真的合成一次：
 *   - 成片的长度是剪出来的长度（循环的底图不会让它停不下来）
 *   - 底图露出来的地方是底图的颜色，放画面的地方是画面
 *   - 改标题的补丁只盖住那一块，声音不动
 * 本机没有 ffmpeg 时跳过。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildVideoAss, renderFilter, retitlePatchFilter, LEFT_WIDTH, type FontSet } from './highlightAss';
import { buildStageVideoAss, stageRenderFilter, STAGE_VIDEO } from './highlightStageAss';
import { mediaDuration, pickFonts } from './highlightFfmpeg';
import type { Segment } from './highlightTypes';

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;
const ENCODE: Array<string> = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
const segments: Array<Segment> = [
  { from: 1, to: 3, start: 1, end: 3, out: 0 },
  { from: 5, to: 6.5, start: 5, end: 6.5, out: 2 }
];
const TOTAL: number = 3.5;

(hasFfmpeg ? describe : describe.skip)('成片叠在 Canvas 画的底图上', (): void => {
  let dir: string;
  let fonts: FontSet;

  function run(args: Array<string>): SpawnSyncReturns<Buffer> {
    return spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd: dir, windowsHide: true, maxBuffer: 100_000_000, timeout: 90_000 // 停不下来的话 90 秒后算失败
    });
  }

  /* 一帧里某一块的平均亮度 */
  function brightness(file: string, time: number, crop: string): number {
    const out: Buffer = run([
      ...(time > 0 ? ['-ss', String(time)] : []), '-i', file, '-frames:v', '1', '-vf', `crop=${ crop }`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'
    ]).stdout;

    return out.reduce((sum: number, value: number): number => sum + value, 0) / out.length;
  }

  function audioHash(file: string): string {
    return String(run(['-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).stdout);
  }

  beforeAll(async (): Promise<void> => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdrop-'));
    fonts = await pickFonts(dir);
    expect(run([
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'source.mp4'
    ]).status).toBe(0);
    // 底图：一张很亮的纯色图（真的底图是 Canvas 画的，这里只看它有没有被用上）
    expect(run(['-f', 'lavfi', '-i', 'color=c=0xf0f0f0:s=1920x1080', '-frames:v', '1', 'backdrop.png']).status).toBe(0);
    // 改标题的补丁：一小块很暗的图
    expect(run(['-f', 'lavfi', '-i', 'color=c=0x101010:s=400x100', '-frames:v', '1', 'patch.png']).status).toBe(0);
  }, 120_000);

  afterAll((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('直播：右边是底图，左边是画面；长度是剪出来的长度；改标题只换补丁那一块', async (): Promise<void> => {
    fs.writeFileSync(path.join(dir, 'overlay.ass'), buildVideoAss({
      title: '测试标题', tag: '', lines: [], segments, total: TOTAL, danmu: [], fonts, backdrop: true
    }));

    const made: SpawnSyncReturns<Buffer> = run([
      '-i', 'source.mp4', '-loop', '1', '-framerate', '30', '-i', 'backdrop.png',
      '-filter_complex', renderFilter(segments, fonts, 'overlay.ass', false, 1),
      '-map', '[vout]', '-map', '[aout]', ...ENCODE, 'live.mp4'
    ]);

    expect(String(made.stderr)).toBe('');
    expect(made.status).toBe(0);
    expect(Math.abs(await mediaDuration(FFMPEG, path.join(dir, 'live.mp4')) - TOTAL)).toBeLessThan(0.3);
    expect(brightness('live.mp4', 1, `60:60:${ LEFT_WIDTH + 600 }:900`)).toBeGreaterThan(220); // 右边空着的地方：底图
    expect(brightness('live.mp4', 1, `60:60:${ LEFT_WIDTH / 2 }:500`)).toBeLessThan(200);      // 左边：画面，不是底图

    const patched: SpawnSyncReturns<Buffer> = run([
      '-i', 'live.mp4', '-i', 'patch.png', '-filter_complex', retitlePatchFilter(LEFT_WIDTH + 100, 20),
      '-map', '[vout]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', 'retitled.mp4'
    ]);

    expect(String(patched.stderr)).toBe('');
    expect(patched.status).toBe(0);
    expect(Math.abs(await mediaDuration(FFMPEG, path.join(dir, 'retitled.mp4')) - TOTAL)).toBeLessThan(0.3);
    expect(brightness('retitled.mp4', 1, `60:60:${ LEFT_WIDTH + 200 }:40`)).toBeLessThan(40);     // 补丁盖住的地方
    expect(brightness('retitled.mp4', 1, `60:60:${ LEFT_WIDTH + 600 }:900`)).toBeGreaterThan(220); // 别的地方没动
    expect(audioHash('retitled.mp4')).toBe(audioHash('live.mp4'));
  }, 180_000);

  test('公演：画面在左上，右边一栏和下面是底图；长度是剪出来的长度', async (): Promise<void> => {
    fs.writeFileSync(path.join(dir, 'stage.ass'), buildStageVideoAss({
      stage: { team: 'NII', teamColor: '#af83bb', show: '《测试公演》', date: '2026.11.26' },
      title: '测试标题', lines: [], segments, total: TOTAL, danmu: [], fonts, backdrop: true
    }));

    const made: SpawnSyncReturns<Buffer> = run([
      '-i', 'source.mp4', '-loop', '1', '-framerate', '30', '-i', 'backdrop.png',
      '-filter_complex', stageRenderFilter(segments, fonts, 'stage.ass', 1),
      '-map', '[vout]', '-map', '[aout]', ...ENCODE, 'stage.mp4'
    ]);

    expect(String(made.stderr)).toBe('');
    expect(made.status).toBe(0);
    expect(Math.abs(await mediaDuration(FFMPEG, path.join(dir, 'stage.mp4')) - TOTAL)).toBeLessThan(0.3);
    expect(brightness('stage.mp4', 1, `60:60:${ STAGE_VIDEO.width + 200 }:700`)).toBeGreaterThan(220); // 右边一栏：底图
    expect(brightness('stage.mp4', 1, `60:60:200:${ STAGE_VIDEO.height + 150 }`)).toBeGreaterThan(220); // 画面下面：底图
    expect(brightness('stage.mp4', 1, `60:60:${ STAGE_VIDEO.width / 2 }:400`)).toBeLessThan(200);      // 画面
  }, 180_000);
});
