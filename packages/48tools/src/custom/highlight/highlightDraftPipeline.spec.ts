/**
 * 直播切片从写标题到渲染、改标题完整走一遍（不联网）：用本机的 ffmpeg 做一段测试录播，假的 Gemini 写字幕和标题。
 *   - 写：不渲染，留下草稿、封面候选和小图；几个同时写，写一个记一个
 *   - 定：改标题、亮点、换一帧、改字幕
 *   - 渲染：一次，画面、封面、文件名照定的
 *   - 改标题：只换标题那一条，别的画面、声音不动，旧文件换掉
 * 本机没有 ffmpeg 时跳过。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { renderDrafts, retitleClip, writeDrafts, type ClipResult, type HighlightDeps, type HighlightJob, type HighlightProgress } from './highlightPipeline';
import { coverDir, coverFiles, frameFile, makeCovers, thumbFile } from './highlightCover';
import { editLine, editPoint, pickTitle } from './highlightDraft';
import { highlightOf, isRestyled, newShowInfo, withDraft, withResult, type ShowInfo, type ShowItem } from './highlightShow';
import { mediaDuration, pickFonts, pixelAt } from './highlightFfmpeg';
import { titleStrip, type Strip } from './highlightAss';
import type { ClipDraft } from './highlightTypes';
import { askKind } from './specAsk';

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

function run(args: Array<string>): SpawnSyncReturns<Buffer> {
  return spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 100_000_000 });
}

/* 一帧里某一块的像素 */
function pixels(file: string, time: number, crop: string): Buffer {
  return run([...(time > 0 ? ['-ss', String(time)] : []), '-i', file, '-frames:v', '1', '-vf', `crop=${ crop }`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']).stdout;
}

function difference(a: Buffer, b: Buffer): number {
  return a.reduce((sum: number, value: number, index: number): number => sum + Math.abs(value - b[index]), 0) / a.length;
}

function audioHash(file: string): string {
  return String(run(['-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).stdout);
}

(hasFfmpeg ? describe : describe.skip)('直播切片：写标题、渲染、改标题', (): void => {
  let dir: string;
  let source: string;

  beforeAll((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-pipeline-'));
    source = path.join(dir, 'source.mp4');
    expect(run([
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', '220', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
    ]).status).toBe(0);
  });

  afterAll((): void => {
    // DRAFT_KEEP=<文件夹>：把做出来的成片和封面留下来看一眼
    if (process.env.DRAFT_KEEP) fs.cpSync(dir, process.env.DRAFT_KEEP, { recursive: true });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('写完停下来不渲染；定好了渲染一次；改标题只换标题那一条', async (): Promise<void> => {
    const outDir: string = path.join(dir, 'out');
    const job: HighlightJob = {
      liveId: 'draft', member: 'SNH48 测试成员', title: '测试', date: '2026.11.24', count: 'auto', outDir, workDir: path.join(outDir, '.work'), ffmpeg: FFMPEG,
      gemini: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gemini.invalid', via: 'api' }
    };
    let asking: number = 0;
    let atOnce: number = 0;
    const fake: typeof fetch = (async (_url: string, init: { body: string }): Promise<Response> => {
      const prompt: string = JSON.parse(init.body).contents[0].parts[0].text ?? '';
      let answer: unknown = { best: 2 };

      if (askKind(init) === 'script') {
        asking++;
        atOnce = Math.max(atOnce, asking);
        // 等久一点：三个请求不是同一刻发出的（各自先要截音频），机器忙的时候 300 毫秒里碰不到一起
        await new Promise<void>((resolve: () => void): void => void setTimeout(resolve, 2_000));
        asking--;
        answer = {
          // 第三个爆点只留一句：太短，写不成
          lines: Array.from({ length: 8 }, (_item: unknown, index: number): unknown => ({
            start: 5 + (index * 7), end: 11 + (index * 7), text: `第${ index + 1 }句字幕`, keep: !prompt.includes('太短的') || index === 0, emphasis: []
          })),
          titles: ['模型的标题一', '模型的标题二', '模型的标题三'], more: [], description: '简介。', points: ['亮点一', '亮点二'], people: []
        };
      }

      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
    }) as unknown as typeof fetch;
    const deps: HighlightDeps = {
      liveInfo: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchText: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchImpl: fake
    };
    const prepared: { source: string; danmu: Array<{ time: number; nickname: string; message: string }> } = {
      source, danmu: Array.from({ length: 220 }, (_item: unknown, second: number): { time: number; nickname: string; message: string } => ({ time: second + 0.5, nickname: '某人', message: `第${ second }条` }))
    };
    let info: ShowInfo = newShowInfo(job, {
      model: 'test-model', duration: 220, summaries: [], notes: [], recommended: new Set([0, 1, 2]),
      items: ['甲', '乙', '太短的'].map((title: string, at: number): ShowItem => ({
        start: 20 + (at * 60), end: 70 + (at * 60), title, cover: '', quote: '', reason: '说明', score: 9
      } as ShowItem))
    });
    const progress: Array<HighlightProgress> = [];
    const order: Array<string> = [];

    // 写
    const result: { written: number; skipped: Array<string> } = await writeDrafts(job, deps, prepared, info, (one: HighlightProgress): void => void progress.push(one),
      (item: ShowItem, written: ClipDraft | string): Promise<void> => {
        order.push(item.title);
        info = withDraft(info, item, written);

        return Promise.resolve();
      });

    expect(result.written).toBe(2);
    expect(result.skipped.join()).toContain('「太短的」剪完是');
    expect(order.sort()).toEqual(['乙', '太短的', '甲'].sort());
    expect(atOnce).toBe(3); // 三个一起问
    expect(progress.at(-1)?.percent).toBeCloseTo(100, 0);
    expect(fs.readdirSync(outDir).filter((name: string): boolean => name.endsWith('.mp4'))).toEqual([]); // 没有渲染

    const draft: ClipDraft = info.items[0].draft!;
    const covers: string = coverDir(outDir, draft.key);

    expect(draft).toMatchObject({ title: '模型的标题一', frame: 1, points: ['亮点一', '亮点二'] });
    expect(draft.frames.length).toBeGreaterThan(2);

    for (const index of draft.frames.keys()) {
      expect(pixels(frameFile(covers, index), 0, '1920:1080:0:0')).toHaveLength(1_920 * 1_080);
      expect(pixels(thumbFile(covers, index), 0, '304:540:0:0')).toHaveLength(304 * 540);
    }

    // 每一帧是成片里那一刻的画面，不是同一张
    expect(difference(pixels(thumbFile(covers, 0), 0, '304:540:0:0'), pixels(thumbFile(covers, 2), 0, '304:540:0:0'))).toBeGreaterThan(1);

    // 定
    const edited: ClipDraft = { ...editLine(editPoint(pickTitle(draft, '我取的标题'), 0, '改过的亮点'), 1, ''), frame: 0 };

    info = { ...info, items: info.items.map((item: ShowItem, at: number): ShowItem => (at === 0 ? { ...item, draft: edited } : { ...item, cut: false })) };

    // 预览的封面，渲染完用的是同一张
    fs.mkdirSync(path.join(dir, 'fonts-preview'));

    const preview: { wide: string; standard: string } = await makeCovers({
      ffmpeg: FFMPEG, cwd: path.join(dir, 'fonts-preview'), dir: covers, job, highlight: highlightOf(info.items[0]), draft: edited,
      fonts: await pickFonts(path.join(dir, 'fonts-preview'))
    });
    const previewed: Buffer = fs.readFileSync(preview.wide);

    expect(preview).toEqual(coverFiles(covers));
    // 标题是纯白的，不发灰（看右边整块：标题具体在哪随排版变）
    expect(pixels(preview.wide, 0, '1312:1080:608:0').reduce((most: number, value: number): number => Math.max(most, value), 0)).toBeGreaterThan(250);

    // 渲染
    let clips: Array<ClipResult> = await renderDrafts(job, prepared, info, (): void => undefined, (item: ShowItem, one: ClipResult): Promise<void> => {
      info = withResult(info, item, one);

      return Promise.resolve();
    });

    expect(clips.map((clip: ClipResult): string => path.basename(clip.video))).toEqual(['01-我取的标题.mp4']);
    expect(Math.abs(await mediaDuration(FFMPEG, clips[0].video) - clips[0].duration)).toBeLessThan(0.5);
    expect(fs.readFileSync(clips[0].cover).equals(previewed)).toBe(true);
    expect(fs.readFileSync(clips[0].text, 'utf8')).toContain('标题：【测试成员】模型的标题一 | 20261124 直播切片');
    expect(fs.readFileSync(clips[0].text, 'utf8')).toContain('看点：改过的亮点 / 亮点二');
    expect(info.items[0]).toMatchObject({ cut: false, clip: { index: 1, title: '我取的标题' }, draft: { title: '我取的标题' } });
    expect(isRestyled(info.items[0])).toBe(false);

    // 改标题：没有录播也能改
    const before: string = path.join(dir, 'before.mp4');

    fs.copyFileSync(clips[0].video, before);
    info = { ...info, items: info.items.map((item: ShowItem, at: number): ShowItem => (at === 0 ? { ...item, draft: pickTitle(item.draft!, '换成这个新标题') } : item)) };
    expect(isRestyled(info.items[0])).toBe(true);
    clips = [await retitleClip(job, info.items[0], clips[0].video, (): void => undefined)];
    info = withResult(info, info.items[0], clips[0]);

    const strip: Strip = titleStrip('SNH48 测试成员  2026.11.24');
    const names: Array<string> = fs.readdirSync(outDir).filter((name: string): boolean => name.startsWith('01-')).sort();

    expect(names).toEqual(['01-换成这个新标题-封面16比9.jpg', '01-换成这个新标题-封面4比3.jpg', '01-换成这个新标题.mp4', '01-换成这个新标题.txt'].sort());
    expect(isRestyled(info.items[0])).toBe(false);
    expect(audioHash(clips[0].video)).toBe(audioHash(before));
    expect(difference(pixels(clips[0].video, 10, `${ strip.w }:${ strip.h }:${ strip.x }:${ strip.y }`), pixels(before, 10, `${ strip.w }:${ strip.h }:${ strip.x }:${ strip.y }`))).toBeGreaterThan(3);

    // 别的地方不动：直播画面、字幕和弹幕、成员名字
    for (const crop of ['608:1080:0:0', '1312:900:608:180', `${ 1_920 - strip.x - strip.w }:140:${ strip.x + strip.w }:0`]) {
      expect(difference(pixels(clips[0].video, 10, crop), pixels(before, 10, crop))).toBeLessThan(1.5);
    }

    // 底色填得和旁边一样
    expect(await pixelAt(FFMPEG, clips[0].video, 10, strip.x + strip.w - 4, strip.y + 2)).toEqual(await pixelAt(FFMPEG, clips[0].video, 10, strip.x + strip.w - 4, strip.y - 10));

    // 只改亮点：成片不动，封面换掉
    const kept: Buffer = fs.readFileSync(clips[0].video);
    const oldCover: Buffer = fs.readFileSync(clips[0].cover);

    info = { ...info, items: info.items.map((item: ShowItem, at: number): ShowItem => (at === 0 ? { ...item, draft: editPoint(item.draft!, 1, undefined) } : item)) };
    clips = [await retitleClip(job, info.items[0], clips[0].video, (): void => undefined)];
    expect(fs.readFileSync(clips[0].video).equals(kept)).toBe(true);
    expect(fs.readFileSync(clips[0].cover).equals(oldCover)).toBe(false);
    expect(fs.existsSync(job.workDir) && fs.readdirSync(job.workDir).some((name: string): boolean => name.startsWith('title-'))).toBe(false);
  }, 600_000);
});
