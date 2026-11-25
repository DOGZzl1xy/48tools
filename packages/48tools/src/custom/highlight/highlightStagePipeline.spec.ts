/**
 * 公演切片完整走一遍（不联网）：用本机的 ffmpeg 做一段测试录像，假的 Gemini 回答「一首歌 + 一个失误」，
 * 走真的剪、合成（左边画面、右边弹幕）、做两种封面，检查成片的长度、尺寸和发布标题。本机没有 ffmpeg 时跳过。
 * 唱歌的起止按伴奏（测试录像里一段 80Hz 的声音）、失误按弹幕的反应重新定（./highlightStageTiming），模型给的时间故意偏一点。
 * 唱歌、失误不写字幕，只多问一次标题（这里答不出来，用找片段时的）。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { cutHighlights, findHighlights, processHighlight, type ClipResult, type HighlightDeps, type HighlightJob, type HighlightResult } from './highlightPipeline';
import { mediaDuration } from './highlightFfmpeg';
import { editItem, readShowInfoSync, withResult, type ShowInfo, type ShowItem } from './highlightShow';
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
            quote: '第一句歌词', reason: '少见的组合', score: 9, song: '《示例歌》', singers: ['甲', '乙'], reaction: ''
          },
          {
            kind: 'mistake', start: '01:40', end: '02:00', title: '话筒没声了', cover: '话筒罢工', cover_lines: ['话筒【罢工了】'],
            quote: '我的话筒呢', reason: '大家都笑了', score: 8.5, song: '', singers: [], reaction: '01:47'
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

    // 声音：一直有 330Hz（当成说话），18 ~ 83 秒另有 80Hz（当成伴奏，就是那首歌）
    const made: ReturnType<typeof spawnSync> = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15',
      '-f', 'lavfi', '-i', 'aevalsrc=exprs=0.1*sin(2*PI*330*t)+if(between(t\\,18\\,83)\\,0.5*sin(2*PI*80*t)\\,0):s=48000',
      '-t', '150', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source
    ], { windowsHide: true });

    expect(made.status).toBe(0);

    // 弹幕：平时每秒一条；106 ~ 114 秒话筒没声了，每秒多 4 条反应
    const danmu: Array<DanmuLine> = [
      ...Array.from({ length: 150 }, (_item: unknown, second: number): DanmuLine => ({ time: second + 0.5, nickname: '', message: `第${ second }条` })),
      { time: 30, nickname: '', message: '这个组合好绝' },
      { time: 32, nickname: '', message: '回来了回来了' },
      ...Array.from({ length: 32 }, (_item: unknown, index: number): DanmuLine => ({ time: 106 + (index / 4), nickname: '', message: '哈哈哈哈话筒' }))
    ].sort((a: DanmuLine, b: DanmuLine): number => a.time - b.time);
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
    // 唱歌按伴奏定起止（18 ~ 83 秒，模型说的是 20 ~ 85 秒），前奏前 2 秒、结束后 6 秒 → 16 ~ 89 秒；
    // 失误按弹幕：104 秒开始涨（10 秒里数到 3 秒的刷屏就算），往前 19 秒；116 秒回落，往后 6 秒；切的时候再前 1 秒、后 2 秒 → 84 ~ 124 秒
    expect(Math.abs(await mediaDuration(FFMPEG, song.video) - 73)).toBeLessThan(1.5);
    expect(Math.abs(await mediaDuration(FFMPEG, mistake.video) - 40)).toBeLessThan(1.5);
    expect(song.timing).toContain('按伴奏定的起止');
    expect(mistake.timing).toContain('按弹幕的反应定的时间');
    expect(videoSize(song.video)).toBe('1920x1080');
    expect(videoSize(song.cover)).toBe('1920x1080');
    expect(videoSize(song.cover43)).toBe('1440x1080');
    expect(fs.readFileSync(song.text, 'utf8')).toContain('公演切片');
    expect(fs.existsSync(workDir)).toBe(false); // 做完删掉工作文件夹
  }, 600_000);

  test('写字幕时以内容为由被拒：去掉弹幕再问一次；还被拒就跳过这个片段，接着做下一个，整场不停', async (): Promise<void> => {
    const workDir: string = path.join(dir, '.work-refused');
    const source: string = path.join(workDir, 'source.mp4');

    fs.mkdirSync(workDir, { recursive: true });
    expect(spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', '150', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source
    ], { windowsHide: true }).status).toBe(0);

    const danmu: Array<DanmuLine> = Array.from({ length: 150 }, (_item: unknown, second: number): DanmuLine => ({ time: second + 0.5, nickname: '', message: `第${ second }条` }));

    function mc(start: string, end: string, title: string, score: number): unknown {
      return { kind: 'mc', start, end, title, cover: title, cover_lines: [title], quote: '第一句', reason: '理由', score, song: '', singers: [], reaction: '' };
    }

    const script: unknown = {
      lines: Array.from({ length: 8 }, (_item: unknown, index: number): unknown => ({ start: 5 + (index * 7), end: 11 + (index * 7), text: `第${ index + 1 }句字幕`, keep: true, emphasis: [] })),
      titles: ['弹幕惹的祸'], more: [], description: '简介', points: ['看点'], people: []
    };
    const asked: Array<string> = [];

    function reply(answer: unknown): Promise<Response> {
      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })));
    }

    function blocked(): Promise<Response> {
      return Promise.resolve(new Response(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })));
    }

    const fake: typeof fetch = ((_url: string, init: { body: string }): Promise<Response> => {
      const prompt: string = JSON.parse(init.body).contents[0].parts[0].text ?? '';
      const withDanmu: string = prompt.includes('<弹幕>') ? '+弹幕' : '';

      if (prompt.includes('请找出值得单独剪出来')) return reply({ summary: 'MC', highlights: [mc('00:10', '01:00', '被拦的爆点', 9), mc('01:20', '02:20', '弹幕惹的祸', 8.5)] });

      if (prompt.includes('主题是：「被拦的爆点」')) {
        asked.push(`甲${ withDanmu }`);

        return blocked();
      }

      if (prompt.includes('主题是：「弹幕惹的祸」')) {
        asked.push(`乙${ withDanmu }`);

        return withDanmu ? blocked() : reply(script);
      }

      return reply({ best: 1 });
    }) as unknown as typeof fetch;
    const job: HighlightJob = {
      liveId: 'stage-refused', member: 'SNH48 TEAM X', title: '《示例公演》', date: '2026.11.21', count: 'auto', outDir: path.join(dir, 'refused'), workDir, ffmpeg: FFMPEG,
      gemini: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gemini.invalid', via: 'api' }, members: '',
      stage: { team: 'X', teamColor: '#a9ca27', show: '《示例公演》', date: '2026.11.21' }
    };
    const result: HighlightResult = await processHighlight(job, {
      liveInfo: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchText: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchImpl: fake
    }, { source, danmu }, (): void => undefined);

    // 几个一起写，先后不定
    expect(asked.filter((item: string): boolean => item.startsWith('甲'))).toEqual(['甲+弹幕', '甲']);
    expect(asked.filter((item: string): boolean => item.startsWith('乙'))).toEqual(['乙+弹幕', '乙']);
    expect(result.clips.map((clip: ClipResult): string => clip.title)).toEqual(['弹幕惹的祸']);
    expect(result.skipped.join('\n')).toContain('「被拦的爆点」写字幕时被模型以内容为由拒绝');
  }, 600_000);

  test('自己改了标题：画面、封面、文件名用改的，发布标题（.txt）用 Gemini 想的；MC 和唱歌都是', async (): Promise<void> => {
    const workDir: string = path.join(dir, '.work-own');
    const source: string = path.join(workDir, 'source.mp4');
    const outDir: string = path.join(dir, 'own');

    fs.mkdirSync(workDir, { recursive: true });
    expect(spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15',
      '-f', 'lavfi', '-i', 'aevalsrc=exprs=0.1*sin(2*PI*330*t)+if(between(t\\,80\\,145)\\,0.5*sin(2*PI*80*t)\\,0):s=48000',
      '-t', '150', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source
    ], { windowsHide: true }).status).toBe(0);

    const prompts: Array<string> = [];
    const fake: typeof fetch = ((_url: string, init: { body: string }): Promise<Response> => {
      const prompt: string = JSON.parse(init.body).contents[0].parts[0].text ?? '';
      let answer: unknown = { best: 1 };

      prompts.push(prompt);

      if (prompt.includes('请找出值得单独剪出来')) {
        answer = {
          summary: 'MC 和歌',
          highlights: [
            { kind: 'mc', start: '00:05', end: '01:05', title: '模型的MC', cover: '话', cover_lines: ['模型的大字'], quote: '第一句', reason: '理由', score: 9, song: '', singers: [], reaction: '' },
            { kind: 'song', start: '01:22', end: '02:24', title: '模型的歌', cover: '话', cover_lines: ['大字'], quote: '歌词', reason: '少见的组合', score: 9, song: '《示例歌》', singers: ['甲'], reaction: '' }
          ]
        };
      } else if (prompt.includes('逐句转写')) {
        answer = {
          lines: Array.from({ length: 8 }, (_item: unknown, index: number): unknown => ({ start: 5 + (index * 7), end: 11 + (index * 7), text: `第${ index + 1 }句字幕`, keep: true, emphasis: [] })),
          titles: ['模型另想的MC标题', '备选'], more: [], description: '简介', points: ['看点'], people: []
        };
      } else if (prompt.includes('内容是一首歌')) {
        answer = { titles: ['模型另想的歌标题', '歌的备选'] };
      }

      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })));
    }) as unknown as typeof fetch;
    const job: HighlightJob = {
      liveId: 'stage-own', member: 'SNH48 TEAM X', title: '《示例公演》', date: '2026.11.21', count: 'auto', outDir, workDir, ffmpeg: FFMPEG,
      gemini: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gemini.invalid', via: 'api' }, members: '',
      stage: { team: 'X', teamColor: '#a9ca27', show: '《示例公演》', date: '2026.11.21' }
    };
    const deps: HighlightDeps = {
      liveInfo: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchText: (): Promise<never> => Promise.reject(new Error('不该下载')),
      fetchImpl: fake
    };
    let info: ShowInfo = await findHighlights(job, deps, { source, danmu: [] }, (): void => undefined);

    info = { ...info, items: info.items.map((item: ShowItem): ShowItem => ({ ...editItem(item, { title: item.kind === 'song' ? '我取的歌标题' : '我取的MC标题' }), cut: true })) };

    const clips: Array<ClipResult> = (await cutHighlights(job, deps, { source, danmu: [] }, info, (): void => undefined, (item: ShowItem, result: ClipResult | string): Promise<void> => {
      info = withResult(info, item, result);

      return Promise.resolve();
    })).clips;
    const mc: ClipResult = clips.find((clip: ClipResult): boolean => clip.title === '我取的MC标题')!;
    const song: ClipResult = clips.find((clip: ClipResult): boolean => clip.title === '我取的歌标题')!;

    for (const [clip, name, post] of [[mc, '我取的MC标题', '模型另想的MC标题'], [song, '我取的歌标题', '模型另想的歌标题']] as Array<[ClipResult, string, string]>) {
      const text: string = fs.readFileSync(clip.text, 'utf8');

      expect(path.basename(clip.video)).toContain(name);
      expect(fs.existsSync(clip.cover)).toBe(true);
      expect(clip.postTitle).toContain(post);
      expect(text).toContain(`标题：${ clip.postTitle }`);
      expect(text).not.toContain(name);
    }

    expect(song.otherTitles[0]).toContain('歌的备选');
    expect(prompts.find((prompt: string): boolean => prompt.includes('逐句转写'))).toContain('挑片的人已经取好了：「我取的MC标题」');
    expect(info.items.map((item: ShowItem): string | undefined => item.clip?.title).sort()).toEqual(['我取的MC标题', '我取的歌标题']);
  }, 600_000);

  test('找爆点：找到了就停下来等人挑，录播留着；一个都没找到就不留', async (): Promise<void> => {
    for (const found of [true, false]) {
      const workDir: string = path.join(dir, `.work-find-${ found }`);
      const source: string = path.join(workDir, 'source.mp4');

      fs.mkdirSync(workDir, { recursive: true });
      expect(spawnSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
        '-t', '100', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', source
      ], { windowsHide: true }).status).toBe(0);

      const answer: unknown = { summary: '聊天', highlights: found ? [{ start: '00:10', end: '01:10', title: '爆点', cover: '', quote: '', reason: '说明', score: 9 }] : [] };
      const job: HighlightJob = {
        liveId: 'find', member: 'SNH48 测试成员', title: '测试', date: '2026.11.23', count: 'auto', outDir: path.join(dir, `find-${ found }`), workDir, ffmpeg: FFMPEG,
        gemini: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gemini.invalid', via: 'api' }
      };
      const info: ShowInfo = await findHighlights(job, {
        liveInfo: (): Promise<never> => Promise.reject(new Error('不该下载')),
        fetchText: (): Promise<never> => Promise.reject(new Error('不该下载')),
        fetchImpl: ((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })))) as unknown as typeof fetch
      }, { source, danmu: [] }, (): void => undefined);

      expect(info.status).toBe(found ? 'waiting' : 'done');
      expect(readShowInfoSync(job.outDir)).toEqual(info);
      expect(fs.existsSync(source)).toBe(found);
      expect(fs.existsSync(workDir)).toBe(found);
    }
  }, 120_000);
});
