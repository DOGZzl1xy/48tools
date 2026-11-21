/* eslint-disable require-await */ // 假的下载函数要返回 Promise，但有的里面没有什么可等的
/**
 * 录播自动切片下载录播的部分：读 m3u8、同时下几个分片、接着上次的下、失败重试、中途停止。
 * 分片用假的下载函数（往文件里写几个字），合成 mp4 那一步要 ffmpeg，在 highlightPipeline.spec 的真实测试里跑。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlaylist, downloadSegments, type ReplayPlaylist, type DownloadProgress, type SegmentFetcher } from './highlightDownload';
import { HighlightStopped } from './highlightGemini';

const BASE: string = 'https://example.invalid/live/2026/a.m3u8?x=1';

function playlistOf(count: number): ReplayPlaylist {
  const lines: Array<string> = ['#EXTM3U', '#EXT-X-TARGETDURATION:6'];

  for (let index: number = 0; index < count; index++) lines.push('#EXTINF:6.000,', `/fragments/${ index }.ts`);

  lines.push('#EXT-X-ENDLIST');

  return readPlaylist(lines.join('\n'), BASE)!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

describe('读 m3u8', (): void => {
  test('相对地址补全，时长读出来，本机的 m3u8 里地址换成文件名、其他行留着', (): void => {
    const playlist: ReplayPlaylist | undefined = readPlaylist([
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-DISCONTINUITY', '#EXTINF:6.000,', '/fragments/a/1.ts',
      '#EXTINF: 4.5,', 'https://other.invalid/2.ts', '', '#EXT-X-ENDLIST'
    ].join('\r\n'), BASE);

    expect(playlist?.segments).toEqual([
      { uri: 'https://example.invalid/fragments/a/1.ts', duration: 6, file: '000000.ts' },
      { uri: 'https://other.invalid/2.ts', duration: 4.5, file: '000001.ts' }
    ]);
    expect(playlist?.local).toBe(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-DISCONTINUITY\n#EXTINF:6.000,\n000000.ts\n#EXTINF: 4.5,\n000001.ts\n#EXT-X-ENDLIST\n');
  });

  test('不是 m3u8、没有分片、加密的、多码率目录：返回 undefined（交给 ffmpeg 自己下载）', (): void => {
    expect(readPlaylist('<html>不是 m3u8</html>', BASE)).toBeUndefined();
    expect(readPlaylist('#EXTM3U\n#EXT-X-ENDLIST', BASE)).toBeUndefined();
    expect(readPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\n1.ts', BASE)).toBeUndefined();
    expect(readPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8', BASE)).toBeUndefined();
  });
});

describe('下载分片', (): void => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'highlight-download-'));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('同时最多下 4 个，全部按顺序放好，进度一直往前走并且带速度', async (): Promise<void> => {
    const playlist: ReplayPlaylist = playlistOf(10);
    const progress: Array<DownloadProgress> = [];
    let running: number = 0;
    let most: number = 0;
    const fetchSegment: SegmentFetcher = async (uri: string, file: string): Promise<number> => {
      most = Math.max(most, ++running);
      await sleep(15);
      fs.writeFileSync(file, uri);
      running--;

      return uri.length;
    };

    await downloadSegments({ onProgress: (item: DownloadProgress): number => progress.push(item) }, playlist, fetchSegment, dir);

    expect(most).toBe(4);
    expect(fs.readdirSync(dir).sort()).toEqual(playlist.segments.map((item: { file: string }): string => item.file));
    expect(fs.readFileSync(path.join(dir, '000009.ts'), 'utf8')).toBe('https://example.invalid/fragments/9.ts');
    expect(progress.map((item: DownloadProgress): number => item.part)).toEqual(
      [...progress].map((item: DownloadProgress): number => item.part).sort((a: number, b: number): number => a - b));
    expect(progress[progress.length - 1].part).toBeCloseTo(0.97);
    expect(progress[progress.length - 1].detail).toMatch(/^下载录播 100% · .+\/s · .*已下载 380 B$/);
    expect(progress[4].detail).toMatch(/^下载录播 50% · .+\/s · 剩余 /);
  });

  test('上次下好的不重新下', async (): Promise<void> => {
    const playlist: ReplayPlaylist = playlistOf(6);
    const fetched: Array<string> = [];
    const progress: Array<DownloadProgress> = [];

    fs.writeFileSync(path.join(dir, '000000.ts'), 'a');
    fs.writeFileSync(path.join(dir, '000001.ts'), 'b');
    fs.writeFileSync(path.join(dir, '000003.ts'), 'd'); // 中间缺了第 3 个，后面的都要重新下
    await downloadSegments({ onProgress: (item: DownloadProgress): number => progress.push(item) }, playlist,
      async (uri: string, file: string): Promise<number> => {
        fetched.push(path.basename(new URL(uri).pathname));
        fs.writeFileSync(file, 'x');

        return 1;
      }, dir);

    expect(fetched.sort()).toEqual(['2.ts', '3.ts', '4.ts', '5.ts']);
    expect(progress[0].detail).toContain('接着上次的下，已下载 2/6 个分片');
    expect(fs.readFileSync(path.join(dir, '000001.ts'), 'utf8')).toBe('b');
  });

  test('某个分片失败了会重试，进度里说明在重试', async (): Promise<void> => {
    const playlist: ReplayPlaylist = playlistOf(3);
    const progress: Array<DownloadProgress> = [];
    let failed: boolean = false;

    await downloadSegments({ onProgress: (item: DownloadProgress): number => progress.push(item) }, playlist,
      async (uri: string, file: string): Promise<number> => {
        if (uri.endsWith('/1.ts') && !failed) {
          failed = true;

          throw new Error('断了');
        }

        fs.writeFileSync(file, 'x');

        return 1;
      }, dir);

    expect(fs.readdirSync(dir)).toHaveLength(3);
    expect(progress.some((item: DownloadProgress): boolean => item.detail.includes('正在重试（第 1 次）'))).toBe(true);
  }, 10_000);

  test('中途点停止：报「已停止」，不再下新的分片，下好的留着', async (): Promise<void> => {
    const playlist: ReplayPlaylist = playlistOf(40);
    const controller: AbortController = new AbortController();
    let started: number = 0;
    const fetchSegment: SegmentFetcher = async (uri: string, file: string, signal: AbortSignal): Promise<number> => {
      started++;
      await sleep(10);

      if (signal.aborted) throw new Error('aborted');

      fs.writeFileSync(file, 'x');

      return 1;
    };

    await expect(downloadSegments({
      signal: controller.signal,
      onProgress(item: DownloadProgress): void {
        item.detail.startsWith('下载录播 25%') && controller.abort();
      }
    }, playlist, fetchSegment, dir)).rejects.toBeInstanceOf(HighlightStopped);

    const count: number = started;
    const files: Array<string> = fs.readdirSync(dir);

    await sleep(50);
    expect(started).toBe(count);
    expect(count).toBeLessThan(20);
    expect(files.filter((name: string): boolean => /^\d{6}\.ts$/.test(name)).length).toBeGreaterThanOrEqual(10);
    expect(fs.readdirSync(dir).some((name: string): boolean => name.startsWith('_prefetch_'))).toBe(false);
  });
});
