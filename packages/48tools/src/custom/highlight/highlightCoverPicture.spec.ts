/**
 * 封面换成别的图：上传的截图（转成 jpg、太大的缩小）、播放时选的一帧、封面库里的照片（不复制），排进封面那一帧，做出来的封面用它。
 * 直播把左边的画面换掉，公演放进画面那一块。本机没有 ffmpeg 时跳过。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addPicture, candidateFrame, candidateThumb, capturePicture, ensureFrame, frameFile, isLibraryFile, libraryThumb, makeCovers, picturePath
} from './highlightCover';
import { candidateCount, lookOf, pickPicture } from './highlightDraft';
import { pickFonts } from './highlightFfmpeg';
import type { ClipDraft } from './highlightTypes';

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

function ffmpeg(args: Array<string>): number | null {
  return spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { windowsHide: true }).status;
}

function colorAt(file: string, crop: string): Array<number> {
  return Array.from(spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `crop=${ crop },scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { windowsHide: true }).stdout);
}

function sizeOf(file: string): string {
  return spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { windowsHide: true }).stdout.toString().trim();
}

const draft: ClipDraft = {
  key: '1', basis: '', start: 0, length: 60, lines: [], timing: '', titles: ['标题'], more: [], description: '', points: ['亮点'], people: [],
  frames: [3, 9], title: '标题', frame: 0
};

describe('草稿里的别的图', (): void => {
  test('排在录播取的后面；加过的再选就是选上，不重复加；换了图封面要重做', (): void => {
    const one: ClipDraft = pickPicture(draft, 'picture-1.jpg');
    const two: ClipDraft = pickPicture(one, 'D:\\库\\a.jpg');

    expect(one).toMatchObject({ pictures: ['picture-1.jpg'], frame: 2 });
    expect(two).toMatchObject({ pictures: ['picture-1.jpg', 'D:\\库\\a.jpg'], frame: 3 });
    expect(candidateCount(two)).toBe(4);
    expect(pickPicture(two, 'picture-1.jpg')).toMatchObject({ pictures: ['picture-1.jpg', 'D:\\库\\a.jpg'], frame: 2 });
    expect(lookOf(one)).not.toBe(lookOf(draft));
  });

  test('小图和排好的那一帧放在哪里：录播取的照旧，上传的在切片的封面文件夹，封面库的小图在库里', (): void => {
    const dir: string = path.join('D:', 'show', '.covers', '1');
    const library: string = path.join('D:', '录播切片', '封面库', '成员', 'a.jpg');
    const both: ClipDraft = pickPicture(pickPicture(draft, 'picture-1.jpg'), library);

    expect(candidateThumb(dir, both, 1)).toBe(path.join(dir, 'thumb-2.jpg'));
    expect(candidateThumb(dir, both, 2)).toBe(path.join(dir, 'picture-1.thumb.jpg'));
    expect(candidateThumb(dir, both, 3)).toBe(libraryThumb(library));
    expect(libraryThumb(library)).toBe(path.join('D:', '录播切片', '封面库', '成员', '.thumbs', 'a.jpg'));
    expect(candidateFrame(dir, both, 0)).toBe(frameFile(dir, 0));
    expect(candidateFrame(dir, both, 2)).toBe(path.join(dir, 'picture-1.frame.jpg'));
    expect(path.dirname(candidateFrame(dir, both, 3))).toBe(dir); // 每个切片右边不一样，排好的放在自己这里
    expect(picturePath(dir, 'picture-1.jpg')).toBe(path.join(dir, 'picture-1.jpg'));
    expect(picturePath(dir, library)).toBe(library);
    expect(isLibraryFile(library)).toBe(true);
    expect(isLibraryFile(path.join('D:', '下载', 'a.jpg'))).toBe(false);
  });
});

(hasFfmpeg ? describe : describe.skip)('真的做图', (): void => {
  let dir: string;
  let covers: string;

  beforeAll((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-picture-'));
    covers = path.join(dir, '.covers', '1');
    fs.mkdirSync(covers, { recursive: true });

    // 录播取的两帧：整张灰的
    for (const index of [0, 1]) {
      expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=1920x1080', '-frames:v', '1', frameFile(covers, index)])).toBe(0);
    }
  });

  afterAll((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('上传的 png 转成 jpg、很大的缩小，做好竖的小图；封面左边换成它，封面照它做', async (): Promise<void> => {
    const upload: string = path.join(dir, '截图.png');

    expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=1500x3000', '-frames:v', '1', upload])).toBe(0);

    const entry: string = await addPicture(FFMPEG, covers, upload, false);
    const picked: ClipDraft = pickPicture(draft, entry);

    expect(entry).toMatch(/^picture-\d+\.jpg$/);
    expect(sizeOf(path.join(covers, entry))).toBe('1080,2160');
    expect(sizeOf(candidateThumb(covers, picked, 2))).toBe('304,540');

    const frame: string = await ensureFrame(FFMPEG, covers, picked, false);
    const [r, , b]: Array<number> = colorAt(frame, '300:600:150:240');

    expect(frame).toBe(candidateFrame(covers, picked, 2));
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);
    expect(colorAt(frame, '600:600:1000:200')[0]).toBeGreaterThan(100); // 右边还是原来的灰

    fs.mkdirSync(path.join(dir, 'work'));

    const made: { wide: string } = await makeCovers({
      ffmpeg: FFMPEG, cwd: path.join(dir, 'work'), dir: covers, job: { member: 'SNH48 成员', date: '2026.11.26' },
      highlight: { start: 0, end: 60, title: '标题', cover: '', quote: '', reason: '', score: 9 }, draft: picked, fonts: await pickFonts(path.join(dir, 'work'))
    });

    expect(colorAt(made.wide, '300:600:150:240')[2]).toBeGreaterThan(200);
  }, 120_000);

  test('封面库的照片不复制，小图做在库里；照片被删了用第一个候选', async (): Promise<void> => {
    const library: string = path.join(dir, '封面库', '成员');
    const photo: string = path.join(library, '2026-11-20 20.00 电台.jpg');

    fs.mkdirSync(library, { recursive: true });
    expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=600x800', '-frames:v', '1', photo])).toBe(0);

    const entry: string = await addPicture(FFMPEG, covers, photo, false);

    expect(entry).toBe(path.resolve(photo));
    expect(fs.existsSync(libraryThumb(photo))).toBe(true);
    expect(fs.readdirSync(covers).some((name: string): boolean => name.includes('电台'))).toBe(false);

    fs.rmSync(photo);
    expect(await ensureFrame(FFMPEG, covers, pickPicture(draft, entry), false)).toBe(frameFile(covers, 0));
  }, 60_000);

  test('播放时选的一帧：录播里那一刻原样存下来', async (): Promise<void> => {
    const source: string = path.join(dir, 'source.mp4');

    // 前 2 秒红，后 2 秒黄
    expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=540x960:d=2', '-f', 'lavfi', '-i', 'color=c=yellow:s=540x960:d=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source])).toBe(0);

    const entry: string = await capturePicture(FFMPEG, covers, source, 3, false);
    const [r, g, b]: Array<number> = colorAt(path.join(covers, entry), '100:100:200:400');

    expect(sizeOf(path.join(covers, entry))).toBe('540,960');
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
  }, 60_000);

  test('公演：图放进画面那一块（左上 1440×810），整张还是 1920×1080', async (): Promise<void> => {
    const upload: string = path.join(dir, 'stage.jpg');

    expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=1920x1080', '-frames:v', '1', upload])).toBe(0);

    const stageCovers: string = path.join(dir, '.covers', 'stage');

    fs.mkdirSync(stageCovers, { recursive: true });

    const picked: ClipDraft = pickPicture(draft, await addPicture(FFMPEG, stageCovers, upload, true));
    const frame: string = await ensureFrame(FFMPEG, stageCovers, picked, true);

    expect(sizeOf(candidateThumb(stageCovers, picked, 2))).toBe('480,270');
    expect(sizeOf(frame)).toBe('1920,1080');
    expect(colorAt(frame, '1000:600:200:100')[0]).toBeGreaterThan(200);
    expect(colorAt(frame, '300:200:1550:850')[0]).toBeLessThan(60); // 画面外面是深色
  }, 60_000);
});
