/**
 * 录播自动切片：读 ffmpeg 打印的内容（静音）、封面候选的时间、说明文字。
 *
 * 最后一组测试是真的跑一遍（下载录播、问 Gemini、合成），平时跳过。要跑的话：
 *   HIGHLIGHT_LIVE_ID=<直播 ID> HIGHLIGHT_OUT=<输出文件夹> node --run test -- highlightPipeline
 * 可选：HIGHLIGHT_SOURCE=<已经下载好的录播文件>（省掉下载）、HIGHLIGHT_COUNT=<数量>（默认 1）、HIGHLIGHT_MODEL；
 *       HIGHLIGHT_VIA=agy 不走接口，走本机的 agy（要装了本地打轴模型）；
 *       HIGHLIGHT_ONLY=download 只下载录播（不问 Gemini、不花钱），下载好的留在「输出文件夹/.work」里，接着跑完整的会直接用它。
 * key 从仓库根目录的 local/pocket48.json 读（sttGeminiKey），完整跑会产生一点接口费用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as process from 'node:process';
import { parseSilences, mediaDuration } from './highlightFfmpeg';
import {
  coverTimes, clipInfoText, runHighlight, prepareHighlight, saveRadioCover,
  type HighlightResult, type HighlightProgress, type HighlightDeps, type HighlightJob, type PreparedSource
} from './highlightPipeline';
import { highlightDefaults } from './highlightGemini';
import { recognizeAudio } from './alignerRun';
import { defaultGlossary } from './highlightGlossary';
import type { TimedToken } from './highlightTokens';
import type { CaptionLine, Segment } from './highlightTypes';

describe('读 ffmpeg 打印的内容', (): void => {
  test('静音的时间段', (): void => {
    expect(parseSilences([
      '[silencedetect @ 000001] silence_start: -0.002',
      '[silencedetect @ 000001] silence_end: 1.5 | silence_duration: 1.502',
      'size=N/A time=00:00:10.00',
      '[silencedetect @ 000001] silence_start: 27.1',
      '[silencedetect @ 000001] silence_end: 28.47875 | silence_duration: 1.37875',
      '[silencedetect @ 000001] silence_start: 90.6'
    ].join('\r\n'))).toEqual([{ start: 0, end: 1.5 }, { start: 27.1, end: 28.47875 }]);
  });

});

describe('封面候选和说明文字', (): void => {
  const segments: Array<Segment> = [{ from: 0, to: 3, start: 10, end: 30, out: 0 }];

  function line(start: number, emphasis: Array<string>, keep: boolean = true): CaptionLine {
    return { start, end: start + 2, text: '一句话', keep, emphasis };
  }

  test('有重点词的句子够三句就只从它们里面取', (): void => {
    const times: Array<number> = coverTimes(
      [line(11, []), line(14, ['重点']), line(18, ['重点']), line(22, ['重点']), line(26, ['重点'], false)], segments, 20);

    expect(times.map((time: number): number => Number(time.toFixed(1)))).toEqual([4.7, 8.7, 12.7]);
  });

  test('不够就用所有留下的句子；一句都没有时取中间', (): void => {
    expect(coverTimes([line(11, []), line(14, ['重点'])], segments, 20)).toHaveLength(2);
    expect(coverTimes([], segments, 20)).toEqual([10]);
  });

  test('说明文字里有标题、简介、看点和在录播里的位置', (): void => {
    const text: string = clipInfoText({ member: '测试成员', title: '测试直播', date: '2026.11.15' }, {
      index: 1,
      title: '标题在这',
      postTitle: '【测试成员】标题在这 | 20261115 直播切片',
      otherTitles: ['【测试成员】第二个标题 | 20261115 直播切片', '【测试成员】第三个标题？ | 20261115 直播切片'],
      description: '第一句。第二句。',
      points: ['看点一', '看点二'],
      people: [],
      score: 9,
      start: 1_230,
      end: 1_335,
      duration: 74.6,
      timing: '本地模型打轴（100 个字里对上 90 个）'
    });

    expect(text).toContain('标题：【测试成员】标题在这 | 20261115 直播切片');
    expect(text).toContain('备选标题');
    expect(text).toContain('  【测试成员】第三个标题？ | 20261115 直播切片');
    expect(text).toContain('简介：第一句。第二句。');
    expect(text).toContain('看点：看点一 / 看点二');
    expect(text).toContain('录播 20:30 ~ 22:15');
    expect(text).toContain('成片长度：75 秒');
    expect(text).toContain('字幕时间：本地模型打轴（100 个字里对上 90 个）');
  });

  test('自己取的封面标题：说明里的标题还是 Gemini 的，不说画面和封面上用的是它', (): void => {
    const text: string = clipInfoText({ member: '测试成员', title: '测试直播', date: '2026.11.15' }, {
      index: 1, title: '我取的标题', ownTitle: true, postTitle: '【测试成员】模型的标题 | 20261115 直播切片', otherTitles: ['【测试成员】第二个 | 20261115 直播切片'],
      description: '', points: [], people: [], score: 9, start: 0, end: 60, duration: 60, timing: ''
    });

    expect(text).toContain('标题：【测试成员】模型的标题 | 20261115 直播切片');
    expect(text).toContain('备选标题（另外两种风格）：');
    expect(text).not.toContain('我取的标题');
    expect(text).not.toContain('画面和封面上用的是上面那个');
  });
});

describe('电台封面', (): void => {
  const base: Pick<HighlightDeps, 'liveInfo' | 'fetchText'> = {
    liveInfo: (): Promise<never> => Promise.reject(new Error('不该用')),
    fetchText: (): Promise<never> => Promise.reject(new Error('不该用'))
  };

  test('用这场直播的封面图，存到给的文件', async (): Promise<void> => {
    const saved: Array<[string, string]> = [];

    await saveRadioCover({
      ...base,
      fetchImage: (url: string, file: string): Promise<void> => {
        saved.push([url, file]);

        return Promise.resolve();
      }
    }, 'https://source3.48.cn/2026/1123/a.jpg', 'D:/下载/电台.jpg');

    expect(saved).toEqual([['https://source3.48.cn/2026/1123/a.jpg', 'D:/下载/电台.jpg']]);
  });

  test('没有封面图、下载失败时不报错（留着录播开头那一帧）', async (): Promise<void> => {
    let calls: number = 0;
    const deps: HighlightDeps = {
      ...base,
      fetchImage: (): Promise<void> => {
        calls += 1;

        return Promise.reject(new Error('不是图片：text/html'));
      }
    };
    const warn: jest.SpyInstance = jest.spyOn(console, 'warn').mockImplementation((): void => undefined);

    await expect(saveRadioCover(deps, undefined, 'D:/下载/电台.jpg')).resolves.toBeUndefined();
    await expect(saveRadioCover(deps, 'https://source3.48.cn/a.jpg', 'D:/下载/电台.jpg')).resolves.toBeUndefined();
    expect(calls).toBe(1);
    warn.mockRestore();
  });
});

const liveId: string | undefined = process.env.HIGHLIGHT_LIVE_ID;
const outDir: string | undefined = process.env.HIGHLIGHT_OUT;
const downloadOnly: boolean = process.env.HIGHLIGHT_ONLY === 'download';

(liveId && outDir ? describe : describe.skip)('真的跑一遍', (): void => {
  const workDir: string = path.join(outDir ?? '', '.work');
  const steps: Array<string> = [];
  let local: { sttGeminiKey?: string; proxy?: string } = {};
  let job: HighlightJob;

  const deps: HighlightDeps = {
    // 取录播信息：和程序里一样的接口，这里用 curl 走本机配置的代理
    liveInfo(id: string): Promise<{ playStreamPath: string; msgFilePath: string }> {
      const body: string = execFileSync('curl', [
        '-sS', '--max-time', '30', '-X', 'POST', 'https://pocketapi.48.cn/live/api/v1/live/getLiveOne',
        ...(local.proxy ? ['-x', local.proxy] : []),
        '-H', 'Content-Type: application/json;charset=utf-8',
        '-H', 'User-Agent: PocketFans201807/7.1.48 (iPhone; iOS 26.5.2; Scale/3.00)',
        '-H', `appInfo: ${ JSON.stringify({
          vendor: 'apple', deviceId: '9F3C5A7B-0000-4000-8000-9F3C5A7B1D2E', appVersion: '7.1.48', appBuild: '26102601',
          osVersion: '26.5.2', osType: 'ios', deviceName: 'iPhone17,1', os: 'ios'
        }) }`,
        '--data-binary', JSON.stringify({ liveId: id })
      ], { encoding: 'utf8' });
      const json: { content?: { playStreamPath: string; msgFilePath: string } } = JSON.parse(body);

      return Promise.resolve({ playStreamPath: json.content?.playStreamPath ?? '', msgFilePath: json.content?.msgFilePath ?? '' });
    },
    async fetchText(url: string): Promise<string> {
      return (await fetch(url)).text();
    },
    // 程序里用 got 下载分片（见 highlightTask），这里用 fetch，请求头一样
    async fetchSegment(uri: string, file: string, signal: AbortSignal): Promise<number> {
      const res: Response = await fetch(uri, { headers: { 'User-Agent': 'SNH48 ENGINE' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });

      if (!res.ok) throw new Error(`分片下载失败：${ res.status }`);

      const data: Buffer = Buffer.from(await res.arrayBuffer());

      fs.writeFileSync(file, data);

      return data.length;
    },
    // 这台电脑上装了本地打轴模型就用它（没装时返回 null）
    recognize: (file: string, signal?: AbortSignal): Promise<Array<TimedToken> | null> => recognizeAudio('ffmpeg', file, signal)
  };

  /* 进度：百分比和速度一直在变，同一步只打印一次；下载时每 10% 打印一次 */
  function report(progress: HighlightProgress): void {
    const step: string = progress.detail.startsWith('下载录播')
      ? `下载录播 ${ Math.floor(Number(/(\d+)%/.exec(progress.detail)?.[1] ?? 0) / 10) * 10 }`
      : progress.detail.replace(/\d+%/, '');

    if (steps[steps.length - 1] !== step) {
      steps.push(step);
      console.log(`${ progress.percent.toFixed(0) }% ${ progress.detail }`);
    }
  }

  beforeAll((): void => {
    local = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../local/pocket48.json'), 'utf8'));
    job = {
      liveId: liveId!,
      member: process.env.HIGHLIGHT_MEMBER ?? '测试成员',
      title: process.env.HIGHLIGHT_TITLE ?? '测试直播',
      date: process.env.HIGHLIGHT_DATE ?? '',
      count: process.env.HIGHLIGHT_COUNT === 'auto' ? 'auto' : Number(process.env.HIGHLIGHT_COUNT ?? 1),
      outDir: outDir!,
      workDir,
      ffmpeg: 'ffmpeg',
      glossary: defaultGlossary(),
      gemini: {
        apiKey: local.sttGeminiKey ?? '',
        model: process.env.HIGHLIGHT_MODEL ?? highlightDefaults.model,
        baseUrl: highlightDefaults.baseUrl,
        via: process.env.HIGHLIGHT_VIA === 'agy' ? 'agy' : 'api'
      }
    };
  });

  (downloadOnly ? test : test.skip)('只下载录播：同时下 4 个分片，合成一个文件，长度和 m3u8 里写的一样', async (): Promise<void> => {
    const started: number = Date.now();
    const prepared: PreparedSource = await prepareHighlight(job, deps, report);
    const info: { playStreamPath: string } = await deps.liveInfo(liveId!);
    const expected: number = Array.from((await deps.fetchText(info.playStreamPath)).matchAll(/#EXTINF:\s*([\d.]+)/g))
      .reduce((sum: number, match: RegExpMatchArray): number => sum + Number(match[1]), 0);
    const duration: number = await mediaDuration('ffmpeg', prepared.source);
    const size: number = fs.statSync(prepared.source).size;

    console.log(`录播 ${ Math.round(duration) } 秒（m3u8 里是 ${ Math.round(expected) } 秒），${ (size / 1_048_576).toFixed(0) } MB，用了 ${
      Math.round((Date.now() - started) / 1_000) } 秒，弹幕 ${ prepared.danmu.length } 条`);
    expect(Math.abs(duration - expected)).toBeLessThan(5);
    expect(fs.existsSync(path.join(workDir, 'source.done'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'segments'))).toBe(false);
  }, 3_600_000);

  (downloadOnly ? test.skip : test)('下载、找爆点、出成片和封面', async (): Promise<void> => {
    const source: string | undefined = process.env.HIGHLIGHT_SOURCE;

    // 已经下载好的录播：放进工作文件夹，流程会当成上次下载好的接着做
    if (source && !fs.existsSync(path.join(workDir, 'source.done'))) {
      fs.mkdirSync(workDir, { recursive: true });
      fs.copyFileSync(source, path.join(workDir, 'source.mp4'));
      fs.writeFileSync(path.join(workDir, 'source.done'), '');
    }

    const result: HighlightResult = await runHighlight(job, deps, report);

    console.log(JSON.stringify(result, null, 2));
    expect(result.clips.length).toBeGreaterThan(0);

    for (const clip of result.clips) {
      expect(fs.statSync(clip.video).size).toBeGreaterThan(100_000);
      expect(fs.statSync(clip.cover).size).toBeGreaterThan(10_000);
      expect(fs.statSync(clip.cover43).size).toBeGreaterThan(10_000);
      expect(fs.readFileSync(clip.text, 'utf8')).toContain('简介：');
    }

    expect(fs.existsSync(workDir)).toBe(false);
  }, 3_600_000);
});
