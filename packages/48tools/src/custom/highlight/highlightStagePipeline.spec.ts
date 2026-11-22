/**
 * 公演切片完整走一遍（不联网）：用本机的 ffmpeg 做一段测试录像，假的 Gemini 回答「一首歌 + 一个失误」，
 * 走真的剪、合成（左边画面、右边弹幕）、做两种封面，检查成片的长度、尺寸和发布标题。本机没有 ffmpeg 时跳过。
 * 唱歌、失误不写字幕，所以只会问两次：找片段、挑封面。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { processHighlight, type ClipResult, type HighlightDeps, type HighlightJob, type HighlightResult } from './highlightPipeline';
import { mediaDuration } from './highlightFfmpeg';
import type { DanmuLine } from './highlightTypes';

const FFMPEG: string = 'ffmpeg';
const hasFfmpeg: boolean = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;

function fakeGemini(asked: Array<string>): typeof fetch {
  return ((_url: string, init: { body: string }): Promise<Response> => {
    const prompt: string = JSON.parse(init.body).contents[0].parts[0].text ?? '';
    let answer: unknown;

    if (prompt.includes('公演的切片手')) {
      asked.push('find');
      answer = {
        summary: '开场的歌和一段 Unit。',
        highlights: [
          {
            kind: 'song', start: '00:20', end: '01:25', title: '原班人马回来了', cover: '回忆杀', cover_lines: ['原班人马', '【回来了】'],
            quote: '第一句歌词', reason: '少见的组合', score: 9, song: '《示例歌》', singers: ['甲', '乙']
          },
          {
            kind: 'mistake', start: '01:40', end: '02:00', title: '话筒没声了', cover: '话筒罢工', cover_lines: ['话筒【罢工了】'],
            quote: '我的话筒呢', reason: '大家都笑了', score: 8.5, song: '', singers: []
          }
        ]
      };
    } else if (prompt.includes('封面')) {
      asked.push('cover');
      answer = { best: 1 };
    } else {
      asked.push('other');
      answer = {};
    }

    return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 }));
  }) as unknown as typeof fetch;
}

/* ffmpeg -i 打印的画面尺寸 */
function videoSize(file: string): string {
  const log: string = String(spawnSync(FFMPEG, ['-hide_banner', '-i', file], { windowsHide: true }).stderr);

  return /Video: .*?, (\d{2,5}x\d{2,5})/.exec(log)?.[1] ?? '';
}

(hasFfmpeg ? describe : describe.skip)('公演切片完整走一遍', (): void => {
  let dir: string;

  beforeAll((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-pipeline-'));
  });

  afterAll((): void => {
    // STAGE_KEEP=<文件夹>：把做出来的成片和封面留下来看一眼
    if (process.env.STAGE_KEEP) fs.cpSync(dir, process.env.STAGE_KEEP, { recursive: true });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('唱歌整首保留、失误不剪；成片 1920×1080，两种封面，发布标题带队伍和公演名', async (): Promise<void> => {
    const workDir: string = path.join(dir, '.work');
    const source: string = path.join(workDir, 'source.mp4');

    fs.mkdirSync(workDir, { recursive: true });

    const made: ReturnType<typeof spawnSync> = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', '150', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source
    ], { windowsHide: true });

    expect(made.status).toBe(0);

    const danmu: Array<DanmuLine> = [
      { time: 30, nickname: '', message: '这个组合好绝' },
      { time: 32, nickname: '', message: '回来了回来了' },
      { time: 110, nickname: '', message: '哈哈哈哈话筒' }
    ];
    const asked: Array<string> = [];
    const job: HighlightJob = {
      liveId: 'stage-test',
      member: 'SNH48 TEAM X',
      title: '《示例公演》',
      date: '2026.11.21',
      count: 2,
      outDir: dir,
      workDir,
      ffmpeg: FFMPEG,
      gemini: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gemini.invalid', via: 'api' },
      members: '',
      stage: { team: 'X', teamColor: '#a9ca27', show: '《示例公演》', date: '2026.11.21' }
    };
    const deps: HighlightDeps = {
      liveInfo: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchText: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchImpl: fakeGemini(asked)
    };
    const result: HighlightResult = await processHighlight(job, deps, { source, danmu }, (): void => undefined);

    expect(asked.filter((item: string): boolean => item === 'other')).toEqual([]); // 不写字幕
    expect(result.clips.map((clip: { title: string }): string => clip.title)).toEqual(['原班人马回来了', '话筒没声了']);

    const [song, mistake]: Array<ClipResult> = result.clips;

    expect(song.postTitle).toBe('【SNH48 TEAM X｜甲&乙】原班人马回来了 | 《示例公演》 2026.11.21 公演切片');
    expect(song.points).toEqual(['《示例歌》', '甲、乙']);
    // 唱歌：前奏前 2 秒、结束后 4 秒；失误：前 1 秒、后 2 秒
    expect(Math.abs(await mediaDuration(FFMPEG, song.video) - 71)).toBeLessThan(1);
    expect(Math.abs(await mediaDuration(FFMPEG, mistake.video) - 23)).toBeLessThan(1);
    expect(videoSize(song.video)).toBe('1920x1080');
    expect(videoSize(song.cover)).toBe('1920x1080');
    expect(videoSize(song.cover43)).toBe('1440x1080');
    expect(fs.readFileSync(song.text, 'utf8')).toContain('公演切片');
    expect(fs.existsSync(workDir)).toBe(false); // 做完删掉工作文件夹
  }, 600_000);
});
