/**
 * 直播封面候选挑清楚的帧：清晰度怎么算、每段挑哪一帧、剪掉的地方不要；本机有 ffmpeg 时拿一段一秒清楚一秒糊的录像真挑一次。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickSharp, samplesInClip, sharpness, sharpTimes, SAMPLE_FPS, type Sample } from './highlightSharp';
import type { Segment } from './highlightTypes';

const W: number = 180;
const H: number = 320;

function image(pixel: (x: number, y: number) => number): Uint8Array {
  const gray: Uint8Array = new Uint8Array(W * H);

  for (let y: number = 0; y < H; y++) for (let x: number = 0; x < W; x++) gray[(y * W) + x] = pixel(x, y);

  return gray;
}

describe('清晰度', (): void => {
  test('边缘锐利的比糊的分高；太暗的是 0', (): void => {
    const sharp: Uint8Array = image((x: number, y: number): number => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 220 : 60));
    const soft: Uint8Array = image((x: number, y: number): number => 140 + Math.round(60 * Math.sin(x / 9) * Math.sin(y / 9)));
    const dark: Uint8Array = image((x: number, y: number): number => ((x + y) % 2 === 0 ? 30 : 0));

    expect(sharpness(sharp)).toBeGreaterThan(sharpness(soft) * 10);
    expect(sharpness(dark)).toBe(0);
  });

  test('第几帧从 offset 开始读', (): void => {
    const two: Uint8Array = new Uint8Array(W * H * 2);

    two.set(image((): number => 128), 0);
    two.set(image((x: number): number => (x % 2 === 0 ? 220 : 60)), W * H);
    expect(sharpness(two, 0)).toBe(0);
    expect(sharpness(two, W * H)).toBeGreaterThan(1000);
  });
});

describe('挑哪几帧', (): void => {
  test('分成几段，每段挑分最高的；全是 0 分的段不要', (): void => {
    const samples: Array<Sample> = [
      { time: 1, score: 5 }, { time: 2, score: 9 }, { time: 3.5, score: 3 },
      { time: 6, score: 0 }, { time: 7, score: 0 },
      { time: 10, score: 1 }, { time: 11, score: 8 }
    ];

    expect(pickSharp(samples, 12, 3)).toEqual([2, 11]);
    expect(pickSharp(samples, 12, 2)).toEqual([2, 11]);
    expect(pickSharp([], 12, 3)).toEqual([]);
  });

  test('录播这一段里的时间换成成片里的；剪掉的地方、最后 0.2 秒不要', (): void => {
    // 留 0 ~ 2 秒和 4 ~ 6 秒，成片 4 秒
    const segments: Array<Segment> = [{ from: 0, to: 0, start: 0, end: 2, out: 0 }, { from: 1, to: 1, start: 4, end: 6, out: 2 }];
    const scores: Array<number> = Array.from({ length: 6 * SAMPLE_FPS }, (_item: unknown, index: number): number => index + 1);

    expect(samplesInClip(scores, segments, 4).map((sample: Sample): number => sample.time)).toEqual([0, 0.5, 1, 1.5, 2, 2, 2.5, 3, 3.5]);
  });
});

const hasFfmpeg: boolean = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

(hasFfmpeg ? describe : describe.skip)('真的录像', (): void => {
  let dir: string;

  beforeAll((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-'));
  });

  afterAll((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('一秒清楚一秒糊：挑出来的都在清楚的那几秒', async (): Promise<void> => {
    const source: string = path.join(dir, 'source.mp4');

    expect(spawnSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=20', '-t', '40',
      '-vf', 'gblur=sigma=12:enable=\'mod(floor(t),2)\'', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source
    ], { windowsHide: true }).status).toBe(0);

    // 录播里的 10 ~ 34 秒，剪掉中间 20 ~ 24 秒
    const segments: Array<Segment> = [{ from: 0, to: 0, start: 0, end: 10, out: 0 }, { from: 1, to: 1, start: 14, end: 24, out: 10 }];
    const times: Array<number> = await sharpTimes({ ffmpeg: 'ffmpeg', source, cwd: dir, start: 10, length: 24, segments, total: 20, count: 6 });

    expect(times).toHaveLength(6);

    for (const time of times) {
      const inSource: number = 10 + (time < 10 ? time : time + 4);

      expect(Math.floor(inSource + 0.01) % 2).toBe(0);
    }

    expect(fs.readdirSync(dir)).toEqual(['source.mp4']); // 临时文件删掉了
  }, 120_000);
});
