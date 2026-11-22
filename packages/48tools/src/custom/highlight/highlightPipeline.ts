import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { runFfmpeg, mediaDuration, detectSilences, readPcm, pickFonts, PCM_RATE } from './highlightFfmpeg';
import { downloadReplay, type DownloadProgress, type SegmentFetcher } from './highlightDownload';
import {
  geminiJson, findRequest, readFound, scriptRequest, readScript, coverRequest, HighlightStopped,
  type GeminiConfig, type LiveMeta
} from './highlightGemini';
import {
  parseLrc, planWindows, mergeHighlights, targetCount, safeFileName, postTitle, clock, AGY_WINDOW_LENGTH, AGY_WINDOW_OVERLAP,
  clipWindow, clipLengthProblem, clipLengthNote, CLIP_MIN_SECONDS, CLIP_MAX_SECONDS, RETRY_EXTRA_CONTEXT, type ClipWindow
} from './highlightTime';
import { tidyLines, buildSegments } from './highlightCut';
import { alignLines, envelopeOf, syllablePeaks } from './highlightAlign';
import { timeLinesByTokens, type TimedToken, type TokenTiming } from './highlightTokens';
import { fixHighlightTimes } from './highlightQuotes';
import { parseGlossary, glossaryPrompt, applyGlossary, type Glossary } from './highlightGlossary';
import {
  placeDanmu, buildVideoAss, renderFilter, buildCoverAss, coverFilter, LEFT_WIDTH, COVER_WIDTHS, type FontSet, type PlacedDanmu
} from './highlightAss';
import type { AudioWindow, CaptionLine, ClipScript, DanmuLine, Highlight, HighlightCount, Segment, Silence } from './highlightTypes';

/**
 * 录播自动切片：给一场直播的录播，自动剪出几个横屏短视频（左边直播画面，右上她说的话，右下弹幕），
 * 每个带封面、标题和简介。听音频、挑片段、写字幕都由 Gemini 做，剪和合成用 ffmpeg。
 *
 * 流程（runHighlight；第 1 步是 prepareHighlight，后面是 processHighlight）：
 *   1. 取录播地址和弹幕文件，把整场录播下载到工作文件夹（同时下 4 个分片，不重新编码，见 ./highlightDownload）
 *   2. 每半小时一段，音频和弹幕（只有时间和内容）交给 Gemini，找出可能成为爆点的片段和时间。
 *      Gemini 可以走按量付费的接口，也可以走本机的 agy（订阅额度，见 ./highlightAgy）；走 agy 时它说的时间不准，
 *      改用它引的原话到本地识别的结果里定位（见 ./highlightQuotes），所以要装本地打轴模型
 *   3. 各段的结果合在一起按分数排，决定做哪几个（用户选的数量，或者自动）
 *   4. 每个片段前后多留十几秒再交给 Gemini：出逐句字幕、每句留不留、重点词、三个不同风格的标题（第一个用在画面上）、简介、看点、除了主播还有谁是主角
 *   5. 用声音里的停顿和音节把每句话的时间对准（模型标的时间偶尔早一两秒，见 ./highlightAlign）；装了本地打轴模型时再用它认出来的每个字的时间（见 ./highlightTokens），按留下的句子剪掉沉默和无关的话，合成横屏视频；再从成片里挑一帧做封面（16:9 和 4:3 各一张）
 *   6. 成片、两张封面、说明（标题和简介）放进输出文件夹；工作文件夹用完删掉
 * 中途失败或停止时工作文件夹留着，重试时下载好的录播和已经问过 Gemini 的结果不用重来。
 *
 * 这个文件不碰界面、设置和下载队列（见 ./highlightTask），取录播信息的函数由调用的地方传进来，方便单独测试。
 */
export interface HighlightJob {
  liveId: string;
  member: string;      // 成员名字，写进提示和画面
  title: string;       // 直播标题
  date: string;        // 直播日期，画面右上角显示，例如 2026.11.15
  count: HighlightCount;
  autoScore?: number;  // count 是 'auto' 时，爆点分不低于它的才做；不填用默认的
  outDir: string;      // 成片放在这里
  workDir: string;     // 中间文件放在这里
  ffmpeg: string;
  gemini: GeminiConfig;
  glossary?: string;    // 专有词汇（本机那个文件的原文，见 ./glossaryFile、./highlightGlossary）
}

export interface HighlightDeps {
  /* 录播的地址和弹幕文件的地址 */
  liveInfo: (liveId: string) => Promise<{ playStreamPath: string; msgFilePath: string }>;
  /* 下载一个文本文件（弹幕、m3u8） */
  fetchText: (url: string) => Promise<string>;
  /* 下载录播的一个分片；不给的话让 ffmpeg 自己下载整场（只有一条连接，慢） */
  fetchSegment?: SegmentFetcher;
  /* 本地打轴：用本机的识别模型认出一段音频里每个字的时间；没装模型时返回 null（见 ./alignerPlugin） */
  recognize?: (audioFile: string, signal?: AbortSignal) => Promise<Array<TimedToken> | null>;
  fetchImpl?: typeof fetch;
}

/* 第 1 步的结果：下载好的录播和弹幕 */
export interface PreparedSource {
  source: string;
  danmu: Array<DanmuLine>;
}

export interface HighlightProgress {
  percent: number;
  detail: string;
}

export interface ClipResult {
  index: number;
  title: string;       // 模型取的短标题（画面和封面上用）
  postTitle: string;   // 发布时用的标题：【沈馨】短标题 | 20261115 直播切片（有其他主角时是【沈馨&徐佳琳】）
  otherTitles: Array<string>; // 另外两个风格的标题（也是发布用的完整写法），想换的时候用
  description: string;
  points: Array<string>;
  people: Array<string>; // 除了主播以外的主角（连麦的人、被认真讨论的成员）
  score: number;
  start: number;       // 在录播里的时间（秒）
  end: number;
  duration: number;    // 成片的长度（秒）
  timing: string;      // 字幕的时间是怎么来的（写在说明里）
  video: string;
  cover: string;       // 16:9 的封面
  cover43: string;     // 4:3 的封面
  text: string;
}

type ClipInfo = Omit<ClipResult, 'video' | 'cover' | 'cover43' | 'text'>;

export interface HighlightResult {
  clips: Array<ClipResult>;
  found: number;               // 一共找到几个爆点
  summary: string;
  skipped: Array<string>;      // 没做成的片段和原因
  infoFile?: string;           // 汇总说明
}

const COVER_CANDIDATES: number = 6;
const NEED_ALIGNER: string = '通过本机的 agy 做切片时，要先在「设置 → 录播切片」里安装「本地打轴模型」（agy 说的时间不准，要靠它定时间）';

/* 各步占总进度的多少 */
export const DOWNLOAD_END: number = 30;
const FIND_END: number = 45;

async function exists(file: string): Promise<boolean> {
  try {
    await fsP.access(file);

    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsP.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function base64Of(file: string): Promise<string> {
  return (await fsP.readFile(file)).toString('base64');
}

function checkStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HighlightStopped();
}

/* 封面候选：有重点词的那几句说到一半的时候（不够就用所有句子），均匀取几个 */
export function coverTimes(lines: Array<CaptionLine>, segments: Array<Segment>, total: number): Array<number> {
  const kept: Array<CaptionLine> = lines.filter((line: CaptionLine): boolean => line.keep);
  const strong: Array<CaptionLine> = kept.filter((line: CaptionLine): boolean => line.emphasis.length > 0);
  const pool: Array<number> = (strong.length >= 3 ? strong : kept)
    .map((line: CaptionLine): number | null => {
      const segment: Segment | undefined = segments.find((item: Segment): boolean => line.start >= item.start && line.start <= item.end);

      return segment ? Math.min(total - 0.2, segment.out + (line.start - segment.start) + 0.7) : null;
    })
    .filter((time: number | null): time is number => time !== null && time >= 0);

  if (pool.length === 0) return [Math.max(0, total / 2)];

  const count: number = Math.min(COVER_CANDIDATES, pool.length);

  return Array.from({ length: count }, (item: unknown, index: number): number => (
    pool[Math.floor((index * (pool.length - 1)) / Math.max(1, count - 1))]));
}

/* 成片旁边的说明文字：标题、简介、看点、在录播里的位置 */
export function clipInfoText(job: Pick<HighlightJob, 'member' | 'title' | 'date'>, clip: ClipInfo): string {
  return [
    `标题：${ clip.postTitle }`,
    ...(clip.otherTitles.length > 0 ? ['备选标题（另外两种风格，画面和封面上用的是上面那个）：', ...clip.otherTitles.map((title: string): string => `  ${ title }`)] : []),
    '',
    `简介：${ clip.description }`,
    '',
    `看点：${ clip.points.join(' / ') }`,
    '',
    `来源：${ job.member }「${ job.title }」${ job.date }，录播 ${ clock(clip.start) } ~ ${ clock(clip.end) }`,
    `成片长度：${ Math.round(clip.duration) } 秒，爆点分：${ clip.score }`,
    `字幕时间：${ clip.timing }`,
    ''
  ].join('\r\n');
}

/* 字幕、标题、简介、看点、人名里错的写法换成对的 */
function glossaryScript(script: ClipScript, glossary: Glossary): ClipScript {
  if (glossary.replacements.length === 0) return script;

  const fix: (text: string) => string = (text: string): string => applyGlossary(text, glossary);

  return {
    ...script,
    lines: script.lines.map((line: CaptionLine): CaptionLine => ({ ...line, text: fix(line.text), emphasis: line.emphasis.map(fix) })),
    title: fix(script.title),
    titles: script.titles?.map(fix),
    more: script.more?.map(fix),
    description: fix(script.description),
    points: script.points.map(fix),
    people: script.people?.map(fix)
  };
}

interface ClipContext {
  glossary: Glossary;
  job: HighlightJob;
  deps: HighlightDeps;
  signal?: AbortSignal;
  source: string;
  duration: number;
  danmu: Array<DanmuLine>;
  fonts: FontSet;
  meta: LiveMeta;
}

/* 一次「写字幕、对时间、定剪辑点」的结果 */
interface ClipCut {
  window: ClipWindow;          // 交给模型的是录播里的哪一段
  script: ClipScript;
  lines: Array<CaptionLine>;
  timing: string;              // 字幕的时间是怎么定的（写进说明）
  segments: Array<Segment>;
  total: number;               // 剪完多长（秒）
}

/**
 * 取一段音频，让模型逐句写字幕、决定留哪些句子，再把时间对准、定剪辑点
 * @param { ClipContext } context
 * @param { Highlight } highlight
 * @param { string } clipDir - 这个切片的工作文件夹
 * @param { ClipWindow } window - 录播里的哪一段
 * @param { string | undefined } note - 重做时告诉模型上次哪里不行（见 ./highlightTime 的 clipLengthNote）
 * @param { (stage: string, part: number) => void } report
 */
async function scriptAndCut(
  context: ClipContext, highlight: Highlight, clipDir: string, window: ClipWindow, note: string | undefined,
  report: (stage: string, part: number) => void
): Promise<ClipCut> {
  const { job, deps, signal, source, danmu, meta }: ClipContext = context;
  // 文件名带上这一段的位置：重做时换了范围，不会用到上一次的结果
  const key: string = `${ Math.round(window.start * 10) }-${ Math.round(window.length * 10) }${ note ? '-retry' : '' }`;
  const audio: string = path.join(clipDir, `audio-${ key }.mp3`);
  const scriptFile: string = path.join(clipDir, `script-${ key }.json`);

  // 这个片段的音频
  report('取音频', 0);
  await runFfmpeg(job.ffmpeg, [
    '-y', '-v', 'error', '-ss', window.start.toFixed(3), '-t', window.length.toFixed(3), '-i', source,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audio
  ], { signal });

  // 逐句字幕、留不留、标题、简介、看点
  report(note ? '重写字幕（长度不合要求）' : '写字幕', 0.05);

  let script: ClipScript | undefined = await readJsonFile<ClipScript>(scriptFile);

  if (!script) {
    const clipDanmu: Array<DanmuLine> = danmu.filter(
      (item: DanmuLine): boolean => item.time >= window.start && item.time < window.start + window.length);

    script = readScript(await geminiJson<unknown>(
      job.gemini, scriptRequest(meta, highlight, window.length, await base64Of(audio), clipDanmu, note), signal, deps.fetchImpl), highlight, job.member);
    await fsP.writeFile(scriptFile, JSON.stringify(script, null, 2));
  }

  // 专有词汇里「错 → 对」的替换（存下来的是 Gemini 的原文，每次用的时候换，改了词汇表重做也生效）
  script = glossaryScript(script, context.glossary);

  // 模型标的时间不稳（偶尔整段早一两秒），用声音里的停顿和音节把每句话对回去，再定剪辑点
  const silences: Array<Silence> = await detectSilences(job.ffmpeg, audio, signal);
  const peaks: Array<number> = syllablePeaks(envelopeOf(await readPcm(job.ffmpeg, audio, signal), PCM_RATE));
  let lines: Array<CaptionLine> = alignLines(tidyLines(script.lines, window.length), silences, peaks, window.length);
  let timing: string = 'Gemini 标的时间，用声音里的停顿和音节对过';

  // 装了本地打轴模型：用它认出来的每个字的时间。认不出来、对上的字太少、出错时保持上面的时间
  if (deps.recognize) {
    report('打轴', 0.3);

    try {
      const tokens: Array<TimedToken> | null = await deps.recognize(audio, signal);
      const byTokens: TokenTiming | null = tokens && tokens.length > 0 ? timeLinesByTokens(lines, tokens, window.length) : null;

      if (byTokens?.used) {
        lines = byTokens.lines;
        timing = `本地模型打轴（${ byTokens.total } 个字里对上 ${ byTokens.matched } 个）`;
      } else if (byTokens) {
        timing += `（本地模型只对上 ${ byTokens.matched }/${ byTokens.total } 个字，没有用）`;
      }
    } catch (err) {
      if (err instanceof HighlightStopped) throw err;

      console.warn('本地打轴失败，用 Gemini 给的时间', err);
      timing += '（本地打轴出错，没有用）';
    }
  }

  const { segments, total }: { segments: Array<Segment>; total: number } = buildSegments(lines, window.length);

  return { window, script, lines, timing, segments, total };
}

/**
 * 做一个切片。剪完的长度不在 45 秒到 5 分钟之间（重做一次也不行）时返回原因（字符串），换下一个爆点
 * @param { ClipContext } context
 * @param { Highlight } highlight
 * @param { number } index - 第几个成片（从 1 开始，用在文件名里）
 * @param { number } slot - 第几个候选（工作文件夹的名字）
 * @param { (stage: string, part: number) => void } report - 做到哪一步了；part 是这个切片完成了多少（0 ~ 1）
 */
async function makeClip(
  context: ClipContext, highlight: Highlight, index: number, slot: number, report: (stage: string, part: number) => void
): Promise<ClipResult | string> {
  const { job, signal, source, duration, danmu, fonts, deps }: ClipContext = context;
  const clipDir: string = path.join(job.workDir, `clip-${ slot }`);

  await fsP.mkdir(clipDir, { recursive: true });

  let cut: ClipCut = await scriptAndCut(context, highlight, clipDir, clipWindow(highlight, duration), undefined, report);
  const problem: 'short' | 'long' | null = clipLengthProblem(cut.total);

  // 剪完不到 45 秒或者超过 5 分钟：告诉模型实际剪出来多长，再做一次；太短时前后多给一些音频，好把铺垫和后续留下
  if (problem) {
    cut = await scriptAndCut(context, highlight, clipDir,
      problem === 'short' ? clipWindow(highlight, duration, RETRY_EXTRA_CONTEXT) : cut.window, clipLengthNote(problem, cut.total), report);
  }

  if (cut.segments.length === 0 || clipLengthProblem(cut.total)) {
    return `「${ highlight.title }」剪完是 ${ Math.round(cut.total) } 秒（要在 ${ CLIP_MIN_SECONDS } 秒到 ${ CLIP_MAX_SECONDS / 60 } 分钟之间），跳过`;
  }

  const { script, lines, timing, segments, total }: ClipCut = cut;
  const clipStart: number = cut.window.start;
  const clipLength: number = cut.window.length;

  // 合成
  const placed: Array<PlacedDanmu> = placeDanmu(danmu, clipStart, segments, total);

  await fsP.writeFile(path.join(clipDir, 'overlay.ass'), buildVideoAss({
    title: script.title,
    tag: `${ job.member }  ${ job.date }`.trim(),
    lines,
    segments,
    total,
    danmu: placed,
    fonts
  }));
  report('合成', 0.35);
  await runFfmpeg(job.ffmpeg, [
    '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    '-ss', clipStart.toFixed(3), '-t', clipLength.toFixed(3), '-i', source,
    '-filter_complex', renderFilter(segments, fonts),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', 'out.mp4'
  ], {
    cwd: clipDir,
    signal,
    onTime: (seconds: number): void => report('合成', 0.35 + (Math.min(1, seconds / total) * 0.5))
  });

  // 封面：几张候选里让模型挑一张；挑不出来就用第一张
  report('做封面', 0.87);

  const times: Array<number> = coverTimes(lines, segments, total);
  const candidates: Array<string> = [];

  for (const [order, time] of times.entries()) {
    const file: string = path.join(clipDir, `candidate-${ order + 1 }.jpg`);

    await runFfmpeg(job.ffmpeg, [
      '-y', '-v', 'error', '-ss', time.toFixed(2), '-i', 'out.mp4', '-frames:v', '1',
      '-vf', `crop=${ LEFT_WIDTH }:1080:0:0,scale=304:540`, '-q:v', '4', file
    ], { cwd: clipDir, signal });
    candidates.push(await base64Of(file));
  }

  let best: number = 1;

  if (candidates.length > 1) {
    try {
      const picked: { best?: number } = await geminiJson<{ best?: number }>(job.gemini, coverRequest(candidates), signal, deps.fetchImpl);

      if (Number.isInteger(picked.best) && picked.best! >= 1 && picked.best! <= candidates.length) best = picked.best!;
    } catch (err) {
      if (err instanceof HighlightStopped) throw err;

      console.warn('封面选图失败，用第一张', err);
    }
  }

  // 两个比例各做一张：wide 是 16:9，standard 是 4:3
  for (const [shape, width] of Object.entries(COVER_WIDTHS)) {
    await fsP.writeFile(path.join(clipDir, `cover-${ shape }.ass`), buildCoverAss({
      title: script.title,
      tag: `${ job.member }  直播切片  ${ job.date }`.trim(),
      points: script.points,
      fonts,
      width
    }));
    await runFfmpeg(job.ffmpeg, [
      '-y', '-v', 'error', '-ss', times[best - 1].toFixed(2), '-i', 'out.mp4',
      '-filter_complex', coverFilter(fonts, `cover-${ shape }.ass`, width),
      '-map', '[out]', '-frames:v', '1', '-q:v', '2', `cover-${ shape }.jpg`
    ], { cwd: clipDir, signal });
  }

  // 放进输出文件夹
  const name: string = `${ String(index).padStart(2, '0') }-${ safeFileName(script.title) }`;
  const info: ClipInfo = {
    index,
    title: script.title,
    postTitle: postTitle(job.member, job.date, script.title, script.people, script.more),
    otherTitles: (script.titles ?? []).filter((title: string): boolean => title !== script.title)
      .map((title: string): string => postTitle(job.member, job.date, title, script.people, script.more)),
    people: script.people ?? [],
    description: script.description,
    points: script.points,
    score: highlight.score,
    start: clipStart + segments[0].start,
    end: clipStart + segments[segments.length - 1].end,
    duration: total,
    timing
  };
  const result: ClipResult = {
    ...info,
    video: path.join(job.outDir, `${ name }.mp4`),
    cover: path.join(job.outDir, `${ name }-封面16比9.jpg`),
    cover43: path.join(job.outDir, `${ name }-封面4比3.jpg`),
    text: path.join(job.outDir, `${ name }.txt`)
  };

  await fsP.mkdir(job.outDir, { recursive: true });
  await fsP.copyFile(path.join(clipDir, 'out.mp4'), result.video);
  await fsP.copyFile(path.join(clipDir, 'cover-wide.jpg'), result.cover);
  await fsP.copyFile(path.join(clipDir, 'cover-standard.jpg'), result.cover43);
  await fsP.writeFile(result.text, clipInfoText(job, info));
  report('完成', 1);

  return result;
}

/**
 * 第 1 步：取录播地址和弹幕，把整场录播下载到工作文件夹。上次已经下载好的不重新下载。
 * 和后面的步骤分开，是为了前一场还在切的时候下一场可以先下载（见 ./highlightTask）
 * @param { HighlightJob } job
 * @param { HighlightDeps } deps
 * @param { (progress: HighlightProgress) => void } onProgress - 这一步占总进度的 0 ~ DOWNLOAD_END
 * @param { AbortSignal } [signal] - 用户点了停止
 */
export async function prepareHighlight(
  job: HighlightJob, deps: HighlightDeps, onProgress: (progress: HighlightProgress) => void, signal?: AbortSignal
): Promise<PreparedSource> {
  const source: string = path.join(job.workDir, 'source.mp4');
  const sourceDone: string = path.join(job.workDir, 'source.done');

  checkStopped(signal);
  await fsP.mkdir(job.workDir, { recursive: true });
  onProgress({ percent: 0, detail: '取录播地址…' });

  const info: { playStreamPath: string; msgFilePath: string } = await deps.liveInfo(job.liveId);

  if (!info.playStreamPath) throw new Error('这场直播没有录播地址（可能还没生成，或者已经被删除）');

  checkStopped(signal);

  let danmu: Array<DanmuLine> = [];

  if (info.msgFilePath) {
    try {
      danmu = parseLrc(await deps.fetchText(info.msgFilePath));
    } catch (err) {
      console.warn('弹幕文件下载失败，成片里不显示弹幕', err);
    }
  }

  if (!(await exists(sourceDone)) || !(await exists(source))) {
    let playlist: string | undefined;

    try {
      playlist = /\.m3u8(\?|$)/i.test(info.playStreamPath) ? await deps.fetchText(info.playStreamPath) : undefined;
    } catch { /* 读不到 m3u8 的内容就让 ffmpeg 自己下载，不显示百分比 */ }

    checkStopped(signal);
    await downloadReplay({
      ffmpeg: job.ffmpeg,
      url: info.playStreamPath,
      playlist,
      workDir: job.workDir,
      output: source,
      fetchSegment: deps.fetchSegment,
      signal,
      onProgress: (progress: DownloadProgress): void => onProgress({ percent: progress.part * DOWNLOAD_END, detail: progress.detail })
    });
    await fsP.writeFile(sourceDone, '');
  }

  onProgress({ percent: DOWNLOAD_END, detail: '录播下载好了' });

  return { source, danmu };
}

/**
 * 第 2 ~ 6 步：找爆点、写字幕、剪、合成、做封面
 * @param { HighlightJob } job
 * @param { HighlightDeps } deps
 * @param { PreparedSource } prepared - prepareHighlight 的结果
 * @param { (progress: HighlightProgress) => void } onProgress - 这几步占总进度的 DOWNLOAD_END ~ 100
 * @param { AbortSignal } [signal] - 用户点了停止
 */
export async function processHighlight(
  job: HighlightJob, deps: HighlightDeps, prepared: PreparedSource, onProgress: (progress: HighlightProgress) => void, signal?: AbortSignal
): Promise<HighlightResult> {
  const glossary: Glossary = parseGlossary(job.glossary);
  const meta: LiveMeta = { member: job.member, title: job.title, glossary: glossaryPrompt(glossary) };
  const { source, danmu }: PreparedSource = prepared;

  checkStopped(signal);

  const duration: number = await mediaDuration(job.ffmpeg, source, signal);

  // 2. 一段一段找爆点（走接口时半小时一段；走 agy 时 20 分钟一段、重叠 5 分钟）
  const viaAgy: boolean = job.gemini.via === 'agy';
  const windows: Array<AudioWindow> = viaAgy ? planWindows(duration, AGY_WINDOW_LENGTH, AGY_WINDOW_OVERLAP) : planWindows(duration);
  const all: Array<Highlight> = [];
  const summaries: Array<string> = [];
  const unlocated: Array<string> = []; // 走 agy 时在录音里找不到原话、没法定位的爆点

  // 通过 agy 问的时候它说的时间不准，要靠本地识别的结果按原话定位，所以必须装了本地打轴模型
  if (viaAgy && !deps.recognize) throw new Error(NEED_ALIGNER);

  for (const [order, window] of windows.entries()) {
    const label: string = `找爆点 ${ order + 1 }/${ windows.length }`;
    const cacheFile: string = path.join(job.workDir, `find-${ Math.round(window.start) }.json`);
    let found: { summary: string; highlights: Array<Highlight> } | undefined = await readJsonFile(cacheFile);

    onProgress({ percent: DOWNLOAD_END + ((order / windows.length) * (FIND_END - DOWNLOAD_END)), detail: `${ label }…` });

    if (!found) {
      const audio: string = path.join(job.workDir, `audio-${ Math.round(window.start) }.mp3`);

      await runFfmpeg(job.ffmpeg, [
        '-y', '-v', 'error', '-ss', window.start.toFixed(3), '-t', window.length.toFixed(3), '-i', source,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audio
      ], { signal });
      found = readFound(await geminiJson<unknown>(
        job.gemini, findRequest(meta, window, await base64Of(audio), danmu, viaAgy), signal, deps.fetchImpl), window);
      // 原话（quote、first、last）不换：要拿它们去本地识别的结果里找
      found = {
        summary: applyGlossary(found.summary, glossary),
        highlights: found.highlights.map((item: Highlight): Highlight => ({
          ...item, title: applyGlossary(item.title, glossary), cover: applyGlossary(item.cover, glossary), reason: applyGlossary(item.reason, glossary)
        }))
      };

      if (viaAgy) {
        onProgress({ percent: DOWNLOAD_END + (((order + 0.6) / windows.length) * (FIND_END - DOWNLOAD_END)), detail: `${ label }：按原话定位…` });

        const tokens: Array<TimedToken> | null = await deps.recognize!(audio, signal);

        if (!tokens) throw new Error(NEED_ALIGNER);

        // 本地识别的时间是这一段里的，爆点的时间是整场里的
        const absolute: Array<TimedToken> = tokens.map((token: TimedToken): TimedToken => ({ text: token.text, time: token.time + window.start }));
        const located: Array<Highlight> = [];

        for (const item of found.highlights) {
          const fixed: Highlight | null = fixHighlightTimes(item, absolute);

          if (fixed) {
            located.push({ ...fixed, end: Math.min(fixed.end, window.start + window.length) });
          } else {
            unlocated.push(`「${ item.title }」在录音里找不到它引的原话，没法定位，跳过`);
          }
        }

        found = { summary: found.summary, highlights: located };
      }

      await fsP.writeFile(cacheFile, JSON.stringify(found, null, 2));
      await fsP.rm(audio, { force: true });
    }

    all.push(...found.highlights);
    found.summary && summaries.push(found.summary);
  }

  // 3. 决定做哪几个
  const candidates: Array<Highlight> = mergeHighlights(all);
  const target: number = targetCount(candidates, job.count, duration, job.autoScore);
  const fonts: FontSet = await pickFonts(job.workDir);
  const context: ClipContext = {
    job, deps, signal, source, duration, danmu, meta, glossary,
    fonts: fonts.dir ? { ...fonts, dir: `../${ fonts.dir }` } : fonts // 合成时的当前文件夹是 clip-N
  };
  const clips: Array<ClipResult> = [];
  const skipped: Array<string> = [...unlocated];

  // 4 ~ 6. 一个一个做；某个剪完太短就换下一个候选
  for (const [slot, highlight] of candidates.entries()) {
    if (clips.length >= target) break;

    checkStopped(signal);

    const index: number = clips.length + 1;
    const base: number = FIND_END + (((index - 1) / target) * (100 - FIND_END));
    const made: ClipResult | string = await makeClip(context, highlight, index, slot + 1, (stage: string, part: number): void => {
      onProgress({ percent: base + ((part / target) * (100 - FIND_END)), detail: `第 ${ index }/${ target } 个：${ stage }` });
    });

    if (typeof made === 'string') {
      skipped.push(made);
    } else {
      clips.push(made);
    }
  }

  // 汇总说明；成功后删掉工作文件夹（里面有整场录播，很大）
  let infoFile: string | undefined;

  if (clips.length > 0) {
    infoFile = path.join(job.outDir, '切片说明.txt');
    await fsP.writeFile(infoFile, [
      `${ job.member }「${ job.title }」${ job.date }`,
      `录播长度 ${ clock(duration) }，找到 ${ candidates.length } 个爆点，做了 ${ clips.length } 个切片（模型 ${ job.gemini.model }）`,
      '',
      ...summaries.map((text: string, order: number): string => `第 ${ order + 1 } 段：${ text }`),
      '',
      ...clips.flatMap((clip: ClipResult): Array<string> => [
        `${ String(clip.index).padStart(2, '0') }. ${ clip.postTitle }（${ clock(clip.start) } ~ ${ clock(clip.end) }，${
          Math.round(clip.duration) } 秒，${ clip.score } 分）`,
        ...clip.otherTitles.map((title: string): string => `    备选：${ title }`),
        `    ${ clip.description }`,
        ''
      ]),
      ...(skipped.length > 0 ? ['没做成的：', ...skipped] : []),
      '没做的其他爆点：',
      ...candidates
        .filter((item: Highlight): boolean => !clips.some((clip: ClipResult): boolean => clip.start < item.end && clip.end > item.start))
        .map((item: Highlight): string => `    ${ clock(item.start) } ~ ${ clock(item.end) } ${ item.title }（${ item.score } 分）${ item.reason }`),
      ''
    ].join('\r\n'));
  }

  await fsP.rm(job.workDir, { recursive: true, force: true }).catch((): void => undefined);

  return { clips, found: candidates.length, summary: summaries.join(' '), skipped, infoFile };
}

/**
 * 给一场录播做自动切片：下载完接着切，中间不停
 * @param { HighlightJob } job
 * @param { HighlightDeps } deps
 * @param { (progress: HighlightProgress) => void } onProgress
 * @param { AbortSignal } [signal] - 用户点了停止
 */
export async function runHighlight(
  job: HighlightJob, deps: HighlightDeps, onProgress: (progress: HighlightProgress) => void, signal?: AbortSignal
): Promise<HighlightResult> {
  return processHighlight(job, deps, await prepareHighlight(job, deps, onProgress, signal), onProgress, signal);
}

/* 工作文件夹里有没有上次没做完留下的东西 */
export function hasLeftover(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, 'source.done'));
}
