/**
 * 录播自动切片：读 ffmpeg 打印的内容（静音、m3u8 的时长）、封面候选的时间、说明文字。
 *
 * 最后一个测试是真的跑一遍（下载录播、问 Gemini、合成），平时跳过。要跑的话：
 *   HIGHLIGHT_LIVE_ID=<直播 ID> HIGHLIGHT_OUT=<输出文件夹> node --run test -- highlightPipeline
 * 可选：HIGHLIGHT_SOURCE=<已经下载好的录播文件>（省掉下载）、HIGHLIGHT_COUNT=<数量>（默认 1）、HIGHLIGHT_MODEL。
 * key 从仓库根目录的 local/pocket48.json 读（sttGeminiKey），会产生一点接口费用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as process from 'node:process';
import { parseSilences, m3u8Duration } from './highlightFfmpeg';
import { coverTimes, clipInfoText, runHighlight, type HighlightResult, type HighlightProgress } from './highlightPipeline';
import { highlightDefaults } from './highlightGemini';
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

  test('m3u8 各个分片的时长加起来', (): void => {
    expect(m3u8Duration('#EXTM3U\n#EXTINF:10.000,\na.ts\n#EXTINF: 9.5,\nb.ts\n#EXT-X-ENDLIST')).toBe(19.5);
    expect(m3u8Duration('<html>不是 m3u8</html>')).toBeUndefined();
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
      description: '第一句。第二句。',
      points: ['看点一', '看点二'],
      score: 9,
      start: 1_230,
      end: 1_335,
      duration: 74.6
    });

    expect(text).toContain('标题：【测试成员】标题在这 | 20261115 直播切片');
    expect(text).toContain('简介：第一句。第二句。');
    expect(text).toContain('看点：看点一 / 看点二');
    expect(text).toContain('录播 20:30 ~ 22:15');
    expect(text).toContain('成片长度：75 秒');
  });
});

const liveId: string | undefined = process.env.HIGHLIGHT_LIVE_ID;
const outDir: string | undefined = process.env.HIGHLIGHT_OUT;

(liveId && outDir ? describe : describe.skip)('真的跑一遍', (): void => {
  test('下载、找爆点、出成片和封面', async (): Promise<void> => {
    const local: { sttGeminiKey?: string; proxy?: string } = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../../../../local/pocket48.json'), 'utf8'));
    const workDir: string = path.join(outDir!, '.work');
    const source: string | undefined = process.env.HIGHLIGHT_SOURCE;
    const steps: Array<string> = [];

    // 已经下载好的录播：放进工作文件夹，流程会当成上次下载好的接着做
    if (source && !fs.existsSync(path.join(workDir, 'source.done'))) {
      fs.mkdirSync(workDir, { recursive: true });
      fs.copyFileSync(source, path.join(workDir, 'source.mp4'));
      fs.writeFileSync(path.join(workDir, 'source.done'), '');
    }

    const result: HighlightResult = await runHighlight({
      liveId: liveId!,
      member: process.env.HIGHLIGHT_MEMBER ?? '测试成员',
      title: process.env.HIGHLIGHT_TITLE ?? '测试直播',
      date: process.env.HIGHLIGHT_DATE ?? '',
      count: process.env.HIGHLIGHT_COUNT === 'auto' ? 'auto' : Number(process.env.HIGHLIGHT_COUNT ?? 1),
      outDir: outDir!,
      workDir,
      ffmpeg: 'ffmpeg',
      gemini: {
        apiKey: local.sttGeminiKey ?? '',
        model: process.env.HIGHLIGHT_MODEL ?? highlightDefaults.model,
        baseUrl: highlightDefaults.baseUrl
      }
    }, {
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
      }
    }, (progress: HighlightProgress): void => {
      const step: string = progress.detail.replace(/\d+%/, '');

      if (steps[steps.length - 1] !== step) {
        steps.push(step);
        console.log(`${ progress.percent.toFixed(0) }% ${ progress.detail }`);
      }
    });

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
