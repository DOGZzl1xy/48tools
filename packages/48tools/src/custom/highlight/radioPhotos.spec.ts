/**
 * 电台切片的封面库：照片存成什么名字、下载过的不再下载、内容一样的只留一张、Gemini 排的序怎么读、同一场的切片轮着用；
 * 本机有 ffmpeg 时把电台写标题完整走一遍（假的照片来源、假的 Gemini）。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  imageLook, libraryDir, libraryFiles, lookDistance, photoName, radioChoice, readRank, saveToLibrary, LOOK_HEIGHT, LOOK_WIDTH, type MemberPhoto, type RadioPhotos
} from './radioPhotos';
import { writeDrafts, type HighlightDeps, type HighlightJob } from './highlightPipeline';
import { coverDir, ensureFrame, libraryThumb } from './highlightCover';
import { newShowInfo, withDraft, type ShowInfo, type ShowItem } from './highlightShow';
import type { ClipDraft } from './highlightTypes';

describe('封面库', (): void => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-photos-'));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('放在切片保存位置下面的「封面库/成员名」；名字是北京时间、哪来的、标题', (): void => {
    expect(libraryDir(path.join('D:', '录播切片', 'SNH48-成员甲_标题_2026-11-25_1'), 'SNH48 成员甲')).toBe(path.join('D:', '录播切片', '封面库', 'SNH48 成员甲'));
    expect(photoName('2026-11-25 22.17', '电台', '晚上好/聊聊天?')).toBe('2026-11-25 22.17 电台 晚上好 聊聊天.jpg');
    expect(photoName('2026-11-20 08.05', '直播')).toBe('2026-11-20 08.05 直播.jpg');
  });

  test('下载过的不再下载，内容一样的只留一张，下载失败的下次再试；这场电台自己的封面也放进去', async (): Promise<void> => {
    const bytes: Record<string, string> = { a: 'AAAA', b: 'BBBB', c: 'AAAA' }; // c 和 a 一样
    const fetched: Array<string> = [];
    let failB: boolean = true;

    async function fetchImage(url: string, file: string): Promise<void> {
      fetched.push(url);

      if (url.endsWith('b') && failB) throw new Error('断了');

      await fs.promises.writeFile(file, bytes[url.slice(-1)].repeat(400));
    }

    const at: (day: number) => number = (day: number): number => Date.UTC(2026, 10, day, 12, 0); // 北京时间 20:00
    const photos: Array<MemberPhoto> = [
      { url: 'https://x/a', time: at(20), kind: '直播', title: '早' },
      { url: 'https://x/b', time: at(22), kind: '电台', title: '晚' },
      { url: 'https://x/c', time: at(21), kind: '电台' },
      { url: 'https://x/a', time: at(20), kind: '直播', title: '早' }
    ];
    const own: string = path.join(dir, '别处', 'own.jpg'); // 本机的电台封面不在库里

    fs.mkdirSync(path.dirname(own));
    fs.writeFileSync(own, 'AAAA'.repeat(400)); // 和 a 一样

    const ownFile: string | undefined = await saveToLibrary({ dir, photos, own: { file: own, when: '2026-11-25', title: '这场' }, fetchImage });

    expect(fetched.sort()).toEqual(['https://x/a', 'https://x/b', 'https://x/c']);
    expect(ownFile).toBe(path.join(dir, '2026-11-20 20.00 直播 早.jpg'));
    expect((await libraryFiles(dir)).map((file: string): string => path.basename(file))).toEqual(['2026-11-20 20.00 直播 早.jpg']);

    // 再来一次：a、c 下载过了不再下载，b 上次失败了这次再试
    failB = false;
    fetched.length = 0;
    await saveToLibrary({ dir, photos, fetchImage });
    expect(fetched).toEqual(['https://x/b']);
    expect((await libraryFiles(dir)).map((file: string): string => path.basename(file))).toEqual(['2026-11-22 20.00 电台 晚.jpg', '2026-11-20 20.00 直播 早.jpg']);
  });

  test('自己放进去的图也算，按改动时间排', async (): Promise<void> => {
    fs.writeFileSync(path.join(dir, '2026-11-01 10.00 直播 旧.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '我放的.png'), 'x');
    fs.writeFileSync(path.join(dir, '.index.json'), '{}');
    fs.writeFileSync(path.join(dir, '说明.txt'), 'x');

    expect((await libraryFiles(dir)).map((file: string): string => path.basename(file))).toEqual(['我放的.png', '2026-11-01 10.00 直播 旧.jpg']);
    expect(await libraryFiles(path.join(dir, '没有'))).toEqual([]);
  });
});

describe('看起来一样', (): void => {
  test('9×8 的灰度图：每行相邻两个比谁亮，64 位；差几位', (): void => {
    const ramp: Uint8Array = new Uint8Array(LOOK_WIDTH * LOOK_HEIGHT).map((_v: number, i: number): number => (i % LOOK_WIDTH) * 20); // 每行越往右越亮
    const flat: Uint8Array = new Uint8Array(LOOK_WIDTH * LOOK_HEIGHT).fill(100);

    expect(imageLook(ramp)).toBe('ffffffffffffffff');
    expect(imageLook(flat)).toBe('0000000000000000');
    expect(lookDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(lookDistance('00000000000000f0', '0000000000000010')).toBe(3);
  });
});

describe('排序和轮着用', (): void => {
  const files: Array<string> = ['/库/a.jpg', '/库/b.jpg', '/库/c.jpg', '/库/d.jpg'];

  test('Gemini 说的第几张换成文件；不在范围里的、重复的、不是整数的不要', (): void => {
    expect(readRank([3, 1, 3, 99, 0, 1.5, 'x'], files)).toEqual(['/库/c.jpg', '/库/a.jpg']);
    expect(readRank('3', files)).toEqual([]);
  });

  test('同一场的切片按排好的顺序轮着用；这场电台自己的封面排到了就用它（不放进别的图里）', (): void => {
    const photos: RadioPhotos = { files, ranked: ['/库/b.jpg', '/库/a.jpg', '/库/d.jpg'], own: '/库/a.jpg' };

    expect(radioChoice(photos, 0)).toEqual({ pictures: ['/库/b.jpg', '/库/d.jpg'], pick: '/库/b.jpg' });
    expect(radioChoice(photos, 1)).toEqual({ pictures: ['/库/b.jpg', '/库/d.jpg'], pick: undefined });
    expect(radioChoice(photos, 2).pick).toBe('/库/d.jpg');
    expect(radioChoice(photos, 3).pick).toBe('/库/b.jpg');
  });

  test('没排成：给最近的几张，默认用这场电台自己的封面', (): void => {
    expect(radioChoice({ files, ranked: [], own: '/库/c.jpg' }, 1)).toEqual({ pictures: ['/库/a.jpg', '/库/b.jpg', '/库/d.jpg'], pick: undefined });
  });
});

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

function ffmpeg(args: Array<string>): number | null {
  return spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { windowsHide: true }).status;
}

/* 一张图某一块的平均颜色（RGB） */
function colorAt(file: string, crop: string): Array<number> {
  const raw: Buffer = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `crop=${ crop },scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true }).stdout;

  return Array.from(raw);
}

(hasFfmpeg ? describe : describe.skip)('电台写标题：封面库', (): void => {
  let dir: string;

  beforeAll((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-write-'));
  });

  afterAll((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('同一张照片压得不一样、大小不一样也只留一张；删掉的不再放回来；别的照片照样放', async (): Promise<void> => {
    const library: string = path.join(dir, '去重');
    const files: Record<string, string> = {};

    // 同一张图（彩色测试图）存成高质量的大图、低质量的小图；另一张是别的图
    for (const [name, args] of [
      ['big', ['-f', 'lavfi', '-i', 'testsrc2=size=900x1200', '-frames:v', '1', '-q:v', '2']],
      ['small', ['-f', 'lavfi', '-i', 'testsrc2=size=900x1200', '-frames:v', '1', '-vf', 'scale=450:600', '-q:v', '12']],
      ['other', ['-f', 'lavfi', '-i', 'mandelbrot=size=900x1200', '-frames:v', '1']]
    ] as Array<[string, Array<string>]>) {
      files[name] = path.join(dir, `${ name }.jpg`);
      expect(ffmpeg([...args, files[name]])).toBe(0);
    }

    const at: number = Date.UTC(2026, 10, 20, 12, 0);
    const photo: (name: string, title: string) => MemberPhoto = (name: string, title: string): MemberPhoto => ({ url: `https://x/${ name }`, time: at, kind: '直播', title });
    const fetchImage: (url: string, file: string) => Promise<void> = (url: string, file: string): Promise<void> => fs.promises.copyFile(files[url.split('/').at(-1)!], file);

    await saveToLibrary({ dir: library, photos: [photo('big', '大'), photo('small', '小'), photo('other', '别的')], fetchImage, ffmpeg: FFMPEG });
    expect((await libraryFiles(library)).map((file: string): string => path.basename(file)).sort()).toEqual(['2026-11-20 20.00 直播 别的.jpg', '2026-11-20 20.00 直播 大.jpg']);

    // 删掉「大」以后，又来一个一样的：不放回来
    fs.rmSync(path.join(library, '2026-11-20 20.00 直播 大.jpg'));
    files.again = files.small;
    await saveToLibrary({ dir: library, photos: [photo('again', '又一次')], fetchImage, ffmpeg: FFMPEG });
    expect((await libraryFiles(library)).map((file: string): string => path.basename(file))).toEqual(['2026-11-20 20.00 直播 别的.jpg']);
  }, 60_000);

  test('先整理封面库、交给 Gemini 排；每个切片给几张照片，默认的轮着用；选了库里的照片，封面左边换成它', async (): Promise<void> => {
    const source: string = path.join(dir, 'source.m4a');
    const images: Record<string, string> = {};

    expect(ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '200', '-c:a', 'aac', source])).toBe(0);

    // 纯色的图「看起来」都一样（没有明暗变化），各加一道位置不同的白条
    for (const [name, color, stripe] of [['own', 'red', 150], ['blue', 'blue', 520], ['green', 'green', 300], ['same', 'red', 150]] as Array<[string, string, number]>) {
      images[name] = path.join(dir, `${ name }.jpg`);
      expect(ffmpeg(['-f', 'lavfi', '-i', `color=c=${ color }:s=600x800`, '-vf', `drawbox=x=${ stripe }:y=0:w=80:h=800:color=white:t=fill`, '-frames:v', '1', images[name]])).toBe(0);
    }

    const outDir: string = path.join(dir, '录播切片', 'SNH48-测试成员_电台_2026-11-25_9');
    const job: HighlightJob = {
      liveId: '9', member: 'SNH48 测试成员', title: '电台', date: '2026.11.25', count: 'auto', outDir, workDir: path.join(outDir, '.work'), ffmpeg: FFMPEG,
      gemini: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gemini.invalid', via: 'api' }, radio: true
    };
    let ranked: number = 0;
    const fake: typeof fetch = ((_url: string, init: { body: string }): Promise<Response> => {
      const parts: Array<{ text?: string }> = JSON.parse(init.body).contents[0].parts;
      const prompt: string = parts[0].text ?? '';
      let answer: unknown = {};

      if (prompt.includes('挑封面照片')) {
        ranked++;
        // 库里新的在前：蓝（11-24）、绿（11-23）、红（这场自己的，11-25 那张是同样的红，留的是 11-22 的名字）
        answer = { order: [1, 3, 2], reason: '' };
      } else if (prompt.includes('逐句转写')) {
        answer = {
          lines: Array.from({ length: 8 }, (_item: unknown, index: number): unknown => ({ start: 5 + (index * 7), end: 11 + (index * 7), text: `第${ index + 1 }句`, keep: true, emphasis: [] })),
          titles: ['标题一', '标题二', '标题三'], more: [], description: '简介。', points: ['亮点'], people: []
        };
      }

      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })));
    }) as unknown as typeof fetch;
    const at: (day: number) => number = (day: number): number => Date.UTC(2026, 10, day, 12, 0);
    const deps: HighlightDeps = {
      liveInfo: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchText: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchImpl: fake,
      memberPhotos: (): Promise<Array<MemberPhoto>> => Promise.resolve([
        { url: 'https://x/blue', time: at(24), kind: '电台', title: '蓝' },
        { url: 'https://x/green', time: at(23), kind: '电台', title: '绿' },
        { url: 'https://x/same', time: at(22), kind: '直播', title: '红' }
      ]),
      fetchImage: (url: string, file: string): Promise<void> => fs.promises.copyFile(images[url.split('/').at(-1)!], file)
    };
    let info: ShowInfo = newShowInfo(job, {
      model: 'test-model', duration: 200, summaries: [], notes: [], recommended: new Set([0, 1, 2]),
      items: ['甲', '乙', '丙'].map((title: string, order: number): ShowItem => ({ start: 10 + (order * 60), end: 60 + (order * 60), title, cover: '', quote: '', reason: '说明', score: 9 } as ShowItem))
    });

    const result: { written: number } = await writeDrafts(job, deps, { source, danmu: [], picture: images.own }, info, (): void => undefined,
      (item: ShowItem, draft: ClipDraft | string): Promise<void> => {
        info = withDraft(info, item, draft);

        return Promise.resolve();
      });

    expect(result.written).toBe(3);
    expect(ranked).toBe(1); // 一场只排一次

    const library: string = libraryDir(outDir, job.member);
    const names: Array<string> = (await libraryFiles(library)).map((file: string): string => path.basename(file));

    expect(names).toEqual(['2026-11-24 20.00 电台 蓝.jpg', '2026-11-23 20.00 电台 绿.jpg', '2026-11-22 20.00 直播 红.jpg']);
    expect(fs.existsSync(path.join(library, '.index.json'))).toBe(true);

    for (const name of names) expect(fs.existsSync(libraryThumb(path.join(library, name)))).toBe(true);

    // 这场自己的封面（红）和库里的「直播 红」是同一张：不放进别的图里；排序是 蓝、红、绿，三个切片轮着用
    const drafts: Array<ClipDraft> = info.items.map((item: ShowItem): ClipDraft => item.draft!);
    const blue: string = path.join(library, names[0]);
    const green: string = path.join(library, names[1]);

    for (const draft of drafts) expect(draft).toMatchObject({ frames: [expect.any(Number)], pictures: [blue, green] });

    expect(drafts.map((draft: ClipDraft): number => draft.frame)).toEqual([1, 0, 2]);

    // 第一个用库里的蓝色：封面那一帧左边是蓝的，右边还是原来那一帧
    const covers: string = coverDir(outDir, drafts[0].key);
    const frame: string = await ensureFrame(FFMPEG, covers, drafts[0], false);
    const [r, g, b]: Array<number> = colorAt(frame, '400:600:100:240');

    expect(b).toBeGreaterThan(180);
    expect(r + g).toBeLessThan(80);
    const right: Array<number> = colorAt(path.join(covers, 'frame-1.jpg'), '1200:400:700:100');

    colorAt(frame, '1200:400:700:100').forEach((value: number, channel: number): void => expect(Math.abs(value - right[channel])).toBeLessThan(5)); // 重新压一次 jpg，差一两个色阶
  }, 300_000);
});
