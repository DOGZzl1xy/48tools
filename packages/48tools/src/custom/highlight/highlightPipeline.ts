import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { runFfmpeg, mediaDuration, hasVideoStream, detectSilences, readPcm, pickFonts, pixelAt, PCM_RATE } from './highlightFfmpeg';
import { downloadReplay, type DownloadProgress, type SegmentFetcher } from './highlightDownload';
import {
  geminiJson, findRequest, readFound, scriptRequest, readScript, stageTitlesRequest, readTitles, coverRequest, HighlightStopped, ContentRefused,
  type GeminiConfig, type LiveMeta
} from './highlightGemini';
import {
  parseLrc, planWindows, mergeHighlights, targetCount, safeFileName, clock, AGY_WINDOW_LENGTH, AGY_WINDOW_OVERLAP, AUTO_SCORE,
  clipWindow, clipLengthProblem, clipLengthNote, CLIP_MIN_SECONDS, CLIP_MAX_SECONDS, RETRY_EXTRA_CONTEXT, type ClipWindow
} from './highlightTime';
import { tidyLines, buildSegments } from './highlightCut';
import { alignLines, envelopeOf, syllablePeaks } from './highlightAlign';
import { timeLinesByTokens, type TimedToken, type TokenTiming } from './highlightTokens';
import { fixHighlightTimes } from './highlightQuotes';
import { parseGlossary, glossaryPrompt, applyGlossary, type Glossary } from './highlightGlossary';
import { learnedPrompt } from '../learn/learnPrompt';
import {
  placeDanmu, buildVideoAss, renderFilter, buildTitleAss, titleStrip, retitleFilter, retitlePatchFilter, type FontSet, type Strip
} from './highlightAss';
import type {
  AudioWindow, CaptionLine, ClipDraft, ClipScript, DanmuLine, Highlight, HighlightCount, Segment, Silence, StageKind
} from './highlightTypes';
import {
  plainTitle, stageFindRequest, stageKindOf, stageClipWindow, stageLengthProblem, stageScript, stageSongTitle, stageQuota, type StageQuota
} from './highlightStage';
import { buildStageVideoAss, stageRenderFilter, buildStageTitleAss, stageTitleStrip, type StageInfo } from './highlightStageAss';
import { pack } from '../sync/packRegistry';
import { runEncode, ENCODER_NAME, type CodecArgs, type EncoderKind } from './highlightEncoder';
import { locateMistake, locateSong, lowBandLevels, type StageTiming } from './highlightStageTiming';
import { draftPoints, draftPostTitles, draftSegments, isOwnTitle, newDraft, shownTitle, videoTag } from './highlightDraft';
import { coverDir, frameFile, makeCovers, makeFrames, thumbFile } from './highlightCover';
import { sharpTimes } from './highlightSharp';
import { collectRadioPhotos, radioChoice, type MemberPhoto, type RadioPhotos } from './radioPhotos';
import {
  newShowInfo, readShowInfo, writeShowInfo, highlightOf, planCuts, readyToRender, withDraft, withResult, INFO_FILE, type ShowInfo, type ShowItem
} from './highlightShow';

/**
 * 录播自动切片：给一场直播的录播，自动剪出几个横屏短视频（左边直播画面，右上她说的话，右下弹幕），
 * 每个带封面、标题和简介。听音频、挑片段、写字幕都由 Gemini 做，剪和合成用 ffmpeg。
 * 电台也切（用户 2026-11-23 定的，找爆点的标准和视频直播一样，排版也一样）：录音没有画面，左边放电台封面（见 saveRadioCover、stillInput）。
 *
 * 停两次等人（用户 2026-11-23、2026-11-24 定的）：prepareHighlight、findHighlights 找到第 3 步，清单存在输出文件夹里（./highlightShow），等人挑；
 * 挑好以后 writeDrafts 做第 4 步，写好字幕、标题、亮点和封面候选，等人定；定好了 renderDrafts 做第 5、6 步，每个只渲染一次。
 * 渲染完又想改标题：retitleClip 只换成片上标题那一条、重做封面，不用再问 Gemini，也不用录播。
 * 流程：
 *   1. 取录播地址和弹幕文件，把整场录播下载到工作文件夹（同时下 4 个分片，不重新编码，见 ./highlightDownload）
 *   2. 每半小时一段，音频和弹幕（只有时间和内容）交给 Gemini，找出可能成为爆点的片段和时间。
 *      Gemini 可以走按量付费的接口，也可以走本机的 agy（订阅额度，见 ./highlightAgy）；走 agy 时它说的时间不准，
 *      改用它引的原话到本地识别的结果里定位（见 ./highlightQuotes），所以要装本地打轴模型
 *   3. 各段的结果合在一起按分数排，推荐哪几个（用户选的数量，或者自动），写好清单等人挑
 *   4. 每个片段前后多留十几秒再交给 Gemini：出逐句字幕、每句留不留、重点词、三个不同风格的标题、简介、看点、除了主播还有谁是主角；
 *      用声音里的停顿和音节把每句话的时间对准（模型标的时间偶尔早一两秒，见 ./highlightAlign），装了本地打轴模型时再用它认出来的每个字的时间
 *      （见 ./highlightTokens）；从录播里取几帧当封面候选（./highlightCover）
 *   5. 按留下的句子剪掉沉默和无关的话，合成横屏视频；照定好的标题、亮点、画面做封面（16:9 和 4:3 各一张）
 *   6. 成片、两张封面、说明（标题和简介）放进输出文件夹；工作文件夹用完删掉
 * 中途失败或停止时工作文件夹留着，重试时下载好的录播和已经问过 Gemini 的结果不用重来。等人挑的时候下载好的录播也留在工作文件夹里，切完才删。
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
  members?: string;     // 成员名单那一段提示（./highlightMembers 的 membersPrompt）
  learned?: string;     // 持续学习的背景文档（../learn/learnStore 的 readBackground），没有就不加
  stage?: StageInfo;    // 公演切片（B 站公演录像）：用公演版的提示、规则和排版（./highlightStage、./highlightStageAss）
  radio?: boolean;      // 电台：只下录音，成片左边放电台封面（见 saveRadioCover）
  team?: string;        // 直播/电台成员所属队伍（SII / NII / NIII / 预备生…），自动匹配团队色
  teamColor?: string;   // 队伍主色（留空时由 team 自动查表，预备生与未知队伍默认 SII 蓝）
  local?: { file: string; danmuFile?: string }; // 用本机已经下好的录播和弹幕（自动抓取），不再下载
}

export interface HighlightDeps {
  /* 录播的地址、弹幕文件的地址和这场直播的封面图（成员设置的那张，完整地址） */
  liveInfo: (liveId: string) => Promise<{ playStreamPath: string; msgFilePath: string; coverUrl?: string }>;
  /* 下载一个文本文件（弹幕、m3u8） */
  fetchText: (url: string) => Promise<string>;
  /* 下载一张图存成文件（电台封面）；不是图片时报错 */
  fetchImage?: (url: string, file: string, signal?: AbortSignal) => Promise<void>;
  /* 这场直播的成员以前直播、电台的封面和电台的轮播图（电台切片的封面库用，见 ./radioPhotos） */
  memberPhotos?: (liveId: string, signal?: AbortSignal) => Promise<Array<MemberPhoto>>;
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
  picture?: string;     // 电台：录音没有画面，成片和封面用这张图（电台封面，见 saveRadioCover）
}

/**
 * 电台封面：用这场直播的封面图（成员设置的那张，播放页上看到的就是它；用户 2026-11-23 定的）。
 * 录播的画面只是口袋48的占位图「成员暂时离开」，下载时先存了开头那一帧兜底；封面图取得到就盖掉它，取不到就留着那一帧
 * @param { HighlightDeps } deps
 * @param { string | undefined } coverUrl - liveInfo 给的封面图地址
 * @param { string } file - 存成这个文件
 * @param { AbortSignal } [signal]
 */
export async function saveRadioCover(deps: HighlightDeps, coverUrl: string | undefined, file: string, signal?: AbortSignal): Promise<void> {
  if (!coverUrl || !deps.fetchImage) return;

  try {
    await deps.fetchImage(coverUrl, file, signal);
  } catch (err) {
    if (signal?.aborted) throw new HighlightStopped();

    console.warn('电台封面没有下载下来，用录播开头那一帧', err);
  }
}

export interface HighlightProgress {
  percent: number;
  detail: string;
}

export interface ClipResult {
  index: number;
  title: string;       // 画面、封面、文件名上的标题：挑片的人自己取的，没取就用 Gemini 的
  ownTitle?: boolean;  // title 是挑片的人自己取的
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

export interface CutResult {
  clips: Array<ClipResult>;
  skipped: Array<string>;      // 没做成的片段和原因
}

export interface HighlightResult extends CutResult {
  found: number;               // 一共找到几个爆点
  summary: string;
  infoFile?: string;           // 汇总说明
}

const COVER_CANDIDATES: number = 6;  // 公演：按字幕时间、均匀取
const LIVE_CANDIDATES: number = 12;  // 直播：挑清楚的（见 ./highlightSharp）
const NEED_ALIGNER: string = '通过本机的 agy 做切片时，要先在「设置 → 录播切片」里安装「本地打轴模型」（agy 说的时间不准，要靠它定时间）';

/* 各步占总进度的多少 */
export const DOWNLOAD_END: number = 30;

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

  // 没有字幕（公演里唱歌、失误的片段）：均匀取几帧
  if (pool.length === 0) {
    return total > 20
      ? Array.from({ length: COVER_CANDIDATES }, (item: unknown, index: number): number => total * (0.12 + ((0.76 * index) / (COVER_CANDIDATES - 1))))
      : [Math.max(0, total / 2)];
  }

  const count: number = Math.min(COVER_CANDIDATES, pool.length);

  return Array.from({ length: count }, (item: unknown, index: number): number => (
    pool[Math.floor((index * (pool.length - 1)) / Math.max(1, count - 1))]));
}

/* 成片旁边的说明文字：标题、简介、看点、在录播里的位置 */
export function clipInfoText(job: Pick<HighlightJob, 'member' | 'title' | 'date'>, clip: ClipInfo): string {
  return [
    `标题：${ clip.postTitle }`,
    ...(clip.otherTitles.length > 0 ? [clip.ownTitle ? '备选标题（另外两种风格）：' : '备选标题（另外两种风格，画面和封面上用的是上面那个）：', ...clip.otherTitles.map((title: string): string => `  ${ title }`)] : []),
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

/* 切的时候用的：录播、弹幕、字体 */
interface CutContext {
  job: HighlightJob;
  signal?: AbortSignal;
  source: string;
  duration: number;
  danmu: Array<DanmuLine>;
  fonts: FontSet;
  still?: Array<string>;       // 素材没有画面（电台）：当画面的那个输入的 ffmpeg 参数（见 stillInput）
}

/* 写的时候还要问 Gemini */
interface ClipContext extends CutContext {
  glossary: Glossary;
  deps: HighlightDeps;
  meta: LiveMeta;
}

/**
 * 电台的录音没有画面：合成时用电台封面当画面，一直循环；没有这张图时用一块深色。
 * 返回加在录音后面的 ffmpeg 输入参数；素材有画面时返回 undefined
 */
async function stillInput(ffmpeg: string, prepared: PreparedSource, signal?: AbortSignal): Promise<Array<string> | undefined> {
  if (prepared.picture) return ['-loop', '1', '-framerate', '30', '-i', path.resolve(prepared.picture)];

  if (await hasVideoStream(ffmpeg, prepared.source, signal)) return undefined;

  return ['-f', 'lavfi', '-i', 'color=c=0x1B2030:s=720x1280:r=30'];
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

    const audioBase64: string = await base64Of(audio);
    const ask: (withDanmu: Array<DanmuLine>) => Promise<unknown> = (withDanmu: Array<DanmuLine>): Promise<unknown> => geminiJson<unknown>(
      job.gemini, scriptRequest(meta, highlight, window.length, audioBase64, withDanmu, note, job.stage), signal, deps.fetchImpl);
    let answer: unknown;

    try {
      answer = await ask(clipDanmu);
    } catch (err) {
      // 以内容为由被拒：敏感词多半在弹幕里，弹幕只是用来认人的，去掉再问一次（还不行由 writeClip 跳过这个片段）
      if (!(err instanceof ContentRefused) || clipDanmu.length === 0) throw err;

      answer = await ask([]);
    }

    script = readScript(answer, highlight, job.member);
    await fsP.writeFile(scriptFile, JSON.stringify(script, null, 2));
  }

  // 专有词汇里「错 → 对」的替换（存下来的是 Gemini 的原文，每次用的时候换，改了词汇表重做也生效）
  script = glossaryScript(script, context.glossary);

  // 【】只有公演的标题用（封面上刷荧光笔的记号）；直播、电台没让模型写，它自己写了就去掉
  if (!job.stage) script = { ...script, title: plainTitle(script.title), titles: script.titles?.map(plainTitle) };

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

/* 公演里唱歌、失误的片段写的东西：用找爆点时给的，再问 Gemini 要几个标题给人选（人自己取过的不算 Gemini 的）；问不到就只有原来的 */
async function stageClipScript(context: ClipContext, highlight: Highlight): Promise<ClipScript> {
  const { job, deps, signal, meta, glossary }: ClipContext = context;
  const script: ClipScript = stageScript(highlight);

  if (!job.stage) return script;

  try {
    const answer: { titles?: unknown } = await geminiJson<{ titles?: unknown }>(
      job.gemini, stageTitlesRequest(meta, highlight, job.stage), signal, deps.fetchImpl);
    const asked: Array<string> = readTitles(answer.titles).map((title: string): string => applyGlossary(title, glossary));
    const songTitle: string | undefined = stageSongTitle(highlight); // 唱歌的：「《歌名》」排第一个
    const titles: Array<string> = [
      ...(songTitle ? [songTitle] : []),
      ...readTitles(highlight.coverTitle ? asked : [highlight.title, ...asked]).filter((title: string): boolean => title !== songTitle)
    ];

    return titles.length > 0 ? { ...script, title: titles[0], titles } : script;
  } catch (err) {
    if (err instanceof HighlightStopped) throw err;

    console.warn('起标题失败，用找爆点时的', err);

    return script;
  }
}

/* 一个爆点的工作文件夹、封面候选的文件夹叫什么 */
function draftKey(highlight: Pick<Highlight, 'start'>): string {
  return String(Math.round(highlight.start));
}

function clipWorkDir(job: HighlightJob, highlight: Pick<Highlight, 'start'>): string {
  return path.join(job.workDir, `clip-${ draftKey(highlight) }`);
}

/**
 * 写一个切片：字幕、标题、亮点、封面候选，不渲染。剪完的长度不在 45 秒到 5 分钟之间（重做一次也不行）时返回原因（字符串）
 * @param { ClipContext } context
 * @param { Highlight } highlight
 * @param { (stage: string, part: number) => void } report - 做到哪一步了；part 是这个切片完成了多少（0 ~ 1）
 * @param { { pictures: Array<string>; pick?: string } } [photos] - 电台：封面库里给这个切片的几张照片，默认用哪张（见 ./radioPhotos 的 radioChoice）
 */
async function writeClip(
  context: ClipContext, highlight: Highlight, report: (stage: string, part: number) => void, photos?: { pictures: Array<string>; pick?: string }
): Promise<ClipDraft | string> {
  const { job, signal, source, duration, danmu, fonts, deps }: ClipContext = context;
  const key: string = draftKey(highlight);
  const clipDir: string = clipWorkDir(job, highlight);

  await fsP.mkdir(clipDir, { recursive: true });

  const kind: StageKind = job.stage ? stageKindOf(highlight) : 'mc';
  let cut: ClipCut;

  if (kind !== 'mc') {
    // 公演里唱歌、失误的片段：不写字幕，按找爆点时定好的起止（见 locateStageItem）整段保留（舞台上自己有歌词）
    const window: ClipWindow = stageClipWindow(highlight, duration);
    const problem: string | undefined = stageLengthProblem(kind, window.length);

    if (problem) return `「${ highlight.title }」${ problem }，跳过`;

    report('起标题', 0.1);
    cut = {
      window,
      script: await stageClipScript(context, highlight),
      lines: [],
      timing: `${ kind === 'song' ? '整首歌，没有字幕（舞台上有歌词）' : '失误的片段，没有字幕' }${ highlight.timing ? `；${ highlight.timing }` : '' }`,
      segments: [{ from: 0, to: -1, start: 0, end: window.length, out: 0 }],
      total: window.length
    };
  } else {
    try {
      cut = await scriptAndCut(context, highlight, clipDir, clipWindow(highlight, duration), undefined, report);

      const problem: 'short' | 'long' | null = clipLengthProblem(cut.total);

      // 剪完不到 45 秒或者超过 5 分钟：告诉模型实际剪出来多长，再做一次；太短时前后多给一些音频，好把铺垫和后续留下
      if (problem) {
        cut = await scriptAndCut(context, highlight, clipDir,
          problem === 'short' ? clipWindow(highlight, duration, RETRY_EXTRA_CONTEXT) : cut.window, clipLengthNote(problem, cut.total), report);
      }
    } catch (err) {
      // 去掉弹幕也被拒：跳过这个片段，换下一个候选（不让整场的切片停下来）
      if (err instanceof ContentRefused) return `「${ highlight.title }」写字幕时被模型以内容为由拒绝（${ err.message }），跳过`;

      throw err;
    }

    if (cut.segments.length === 0 || clipLengthProblem(cut.total)) {
      return `「${ highlight.title }」剪完是 ${ Math.round(cut.total) } 秒（要在 ${ CLIP_MIN_SECONDS } 秒到 ${ CLIP_MAX_SECONDS / 60 } 分钟之间），跳过`;
    }
  }

  // 封面候选：从录播里取几帧，让模型先挑一张（人可以换）。直播挑清楚的；电台的画面是同一张图，另外给封面库里的几张照片
  report('取封面', 0.75);

  let frames: Array<number> = [];

  if (!context.still && !job.stage) {
    try {
      frames = await sharpTimes({
        ffmpeg: job.ffmpeg, source, cwd: clipDir, start: cut.window.start, length: cut.window.length, segments: cut.segments, total: cut.total,
        count: LIVE_CANDIDATES, signal
      });
    } catch (err) {
      if (err instanceof HighlightStopped) throw err;

      console.warn('挑清楚的帧失败，按字幕的时间取', err);
    }
  }

  if (frames.length === 0) frames = coverTimes(cut.lines, cut.segments, cut.total).slice(0, context.still ? 1 : undefined);

  const pictures: Array<string> = photos?.pictures ?? [];
  const draft: ClipDraft = newDraft(highlight, {
    key,
    window: cut.window,
    script: cut.script,
    lines: cut.lines,
    timing: cut.timing,
    whole: kind !== 'mc',
    frames,
    pictures,
    frame: photos?.pick ? frames.length + Math.max(0, pictures.indexOf(photos.pick)) : 0
  });
  const covers: string = coverDir(job.outDir, key);

  await makeFrames({
    ffmpeg: job.ffmpeg, source, still: context.still, cwd: clipDir, outDir: covers, job, draft,
    danmu: placeDanmu(danmu, draft.start, cut.segments, cut.total), fonts, signal
  });

  if (draft.frames.length > 1) {
    report('挑封面', 0.85);

    try {
      const images: Array<string> = await Promise.all(draft.frames.map((_time: number, index: number): Promise<string> => base64Of(thumbFile(covers, index))));
      const picked: { best?: number } = await geminiJson<{ best?: number }>(job.gemini, coverRequest(images), signal, deps.fetchImpl);

      if (Number.isInteger(picked.best) && picked.best! >= 1 && picked.best! <= images.length) draft.frame = picked.best! - 1;
    } catch (err) {
      if (err instanceof HighlightStopped) throw err;

      console.warn('封面选图失败，用第一张', err);
    }
  }

  report('写好了', 1);

  return draft;
}

/* 做好的文件叫什么、说明里写什么 */
function clipResultOf(job: HighlightJob, highlight: Highlight, draft: ClipDraft, index: number): ClipResult {
  const { segments, total }: ReturnType<typeof draftSegments> = draftSegments(draft);
  const { post, others }: ReturnType<typeof draftPostTitles> = draftPostTitles(job, draft);
  const name: string = `${ String(index).padStart(2, '0') }-${ safeFileName(shownTitle(job, draft)) }`;

  return {
    index,
    title: shownTitle(job, draft),
    ...(isOwnTitle(draft) ? { ownTitle: true } : {}),
    postTitle: post,
    otherTitles: others,
    people: draft.people,
    description: draft.description,
    points: draftPoints(draft),
    score: highlight.score,
    start: draft.start + segments[0].start,
    end: draft.start + segments[segments.length - 1].end,
    duration: total,
    timing: draft.timing,
    video: path.join(job.outDir, `${ name }.mp4`),
    cover: path.join(job.outDir, `${ name }-封面16比9.jpg`),
    cover43: path.join(job.outDir, `${ name }-封面4比3.jpg`),
    text: path.join(job.outDir, `${ name }.txt`)
  };
}

/* 放进输出文件夹：成片（已经在那里、名字也没变的不动）、封面、说明；标题换了的话，原来编号的旧文件换掉 */
async function placeClip(job: HighlightJob, result: ClipResult, covers: { wide: string; standard: string }, video: string): Promise<void> {
  await fsP.mkdir(job.outDir, { recursive: true });

  const head: string = `${ String(result.index).padStart(2, '0') }-`;
  const before: Array<string> = (await fsP.readdir(job.outDir)).filter((name: string): boolean => name.startsWith(head));

  if (path.resolve(video) !== path.resolve(result.video)) {
    await fsP.copyFile(video, `${ result.video }.part`);
    await fsP.rename(`${ result.video }.part`, result.video);
  }

  await fsP.copyFile(covers.wide, result.cover);
  await fsP.copyFile(covers.standard, result.cover43);
  await fsP.writeFile(result.text, clipInfoText(job, result));

  const now: Set<string> = new Set([result.video, result.cover, result.cover43, result.text].map((file: string): string => path.basename(file)));

  for (const name of before) now.has(name) || await fsP.rm(path.join(job.outDir, name), { force: true });
}

/**
 * 渲染一个定好了的切片：剪、合成、做封面，放进输出文件夹
 * @param { CutContext } context
 * @param { Highlight } highlight
 * @param { ClipDraft } draft
 * @param { number } index - 第几个成片（从 1 开始，用在文件名里）
 * @param { (stage: string, part: number) => void } report
 */
async function renderClip(
  context: CutContext, highlight: Highlight, draft: ClipDraft, index: number, report: (stage: string, part: number) => void
): Promise<ClipResult> {
  const { job, signal, source, danmu, fonts }: CutContext = context;
  const clipDir: string = path.join(job.workDir, `clip-${ draft.key }`);
  const { segments, total }: ReturnType<typeof draftSegments> = draftSegments(draft);
  const shared: { title: string; lines: Array<CaptionLine>; segments: Array<Segment>; total: number; danmu: ReturnType<typeof placeDanmu>; fonts: FontSet } = {
    title: shownTitle(job, draft), lines: draft.lines, segments, total, danmu: placeDanmu(danmu, draft.start, segments, total), fonts
  };

  await fsP.mkdir(clipDir, { recursive: true });

  const backdropBuffer: Buffer | null = await pack().graphics.videoBackdrop(job, shownTitle(job, draft));
  const hasBackdrop: boolean = backdropBuffer !== null;
  const backdropArgs: Array<string> = [];
  let backdropInput: number | undefined;

  if (backdropBuffer) {
    await fsP.writeFile(path.join(clipDir, 'backdrop.png'), backdropBuffer);
    backdropInput = job.stage ? 1 : (context.still ? 2 : 1);
    backdropArgs.push('-loop', '1', '-framerate', '30', '-i', 'backdrop.png');
  }

  await fsP.writeFile(path.join(clipDir, 'overlay.ass'), job.stage
    ? buildStageVideoAss({ ...shared, stage: job.stage, backdrop: hasBackdrop })
    : buildVideoAss({ ...shared, tag: videoTag(job), radio: job.radio, team: job.team, teamColor: job.teamColor, backdrop: hasBackdrop }));
  // 画面优先用显卡编码，用不了（或者这一次失败了）用 CPU，见 ./highlightEncoder；进度里写着这次用的是哪个
  let stage: string = '合成';

  report(stage, 0);
  await runEncode(job.ffmpeg, ({ encode, decode }: CodecArgs): Array<string> => [
    '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    ...decode, '-ss', draft.start.toFixed(3), '-t', draft.length.toFixed(3), '-i', source, ...(context.still ?? []), ...backdropArgs,
    '-filter_complex', job.stage
      ? stageRenderFilter(segments, fonts, 'overlay.ass', backdropInput)
      : renderFilter(segments, fonts, 'overlay.ass', Boolean(context.still), backdropInput),
    '-map', '[vout]', '-map', '[aout]', ...encode,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', 'out.mp4'
  ], 'render', {
    cwd: clipDir,
    signal,
    onEncoder: (kind: EncoderKind): void => {
      stage = `合成（${ ENCODER_NAME[kind] }）`;
      report(stage, 0);
    },
    onTime: (seconds: number): void => report(stage, Math.min(1, seconds / total) * 0.95)
  });
  report('做封面', 0.95);

  const covers: string = coverDir(job.outDir, draft.key);

  // 封面候选没了（文件夹被删）：照写的时候那样再取一遍
  if (!(await exists(frameFile(covers, 0)))) {
    await makeFrames({ ffmpeg: job.ffmpeg, source, still: context.still, cwd: clipDir, outDir: covers, job, draft, danmu: shared.danmu, fonts, signal });
  }

  const result: ClipResult = clipResultOf(job, highlight, draft, index);

  await placeClip(job, result, await makeCovers({ ffmpeg: job.ffmpeg, cwd: clipDir, dir: covers, job, highlight, draft, fonts, signal }), path.join(clipDir, 'out.mp4'));
  await fsP.rm(clipDir, { recursive: true, force: true }).catch((): void => undefined);
  report('完成', 1);

  return result;
}

/**
 * 渲染完又改了标题、亮点、封面的画面：只换成片上标题那一条（底是纯色的，填回底色再写新的，声音不动），重做封面和说明。
 * 不用再问 Gemini，也不用录播；标题没变的话成片不动
 * @param { HighlightJob } job
 * @param { ShowItem } item - 做好了的，带草稿
 * @param { string } video - 现在的成片
 * @param { (progress: HighlightProgress) => void } onProgress - 0 ~ 100
 * @param { AbortSignal } [signal]
 */
export async function retitleClip(
  job: HighlightJob, item: ShowItem, video: string, onProgress: (progress: HighlightProgress) => void, signal?: AbortSignal
): Promise<ClipResult> {
  const { draft, clip }: ShowItem = item;

  if (!draft || !clip) throw new Error('这个切片没有留下草稿，没法只改标题');

  const highlight: Highlight = highlightOf(item);
  const workDir: string = path.join(job.workDir, `title-${ draft.key }`);

  checkStopped(signal);

  try {
    await fsP.mkdir(workDir, { recursive: true });

    const fonts: FontSet = await pickFonts(workDir);
    let file: string = video;

    if (shownTitle(job, draft) !== clip.title) {
      const total: number = await mediaDuration(job.ffmpeg, video, signal);
      const patch: { buffer: Buffer; rect: { x: number; y: number; w: number; h: number } } | null = await pack().graphics.retitlePatch(job, shownTitle(job, draft));

      onProgress({ percent: 1, detail: '换标题' });

      if (patch) {
        await fsP.writeFile(path.join(workDir, 'patch.png'), patch.buffer);
        await runEncode(job.ffmpeg, ({ encode, decode }: CodecArgs): Array<string> => [
          '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...decode, '-i', video, '-i', 'patch.png',
          '-filter_complex', retitlePatchFilter(patch.rect.x, patch.rect.y),
          '-map', '[vout]', '-map', '0:a', ...encode, '-c:a', 'copy', '-movflags', '+faststart', 'out.mp4'
        ], 'retitle', {
          cwd: workDir,
          signal,
          onTime: (seconds: number): void => onProgress({ percent: 1 + (Math.min(1, seconds / total) * 92), detail: '换标题' })
        });
      } else {
        const strip: Strip = job.stage ? stageTitleStrip() : titleStrip(videoTag(job));

        await fsP.writeFile(path.join(workDir, 'title.ass'), job.stage
          ? buildStageTitleAss({ stage: job.stage, title: shownTitle(job, draft), total: total + 1, fonts })
          : buildTitleAss({ title: shownTitle(job, draft), tag: videoTag(job), total: total + 1, fonts, radio: job.radio, team: job.team, teamColor: job.teamColor }));
        const filter: string = retitleFilter(strip, await pixelAt(job.ffmpeg, video, total / 2, strip.x + 2, strip.y + 2, signal), fonts, 'title.ass');

        await runEncode(job.ffmpeg, ({ encode, decode }: CodecArgs): Array<string> => [
          '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...decode, '-i', video,
          '-filter_complex', filter,
          '-map', '[vout]', '-map', '0:a', ...encode, '-c:a', 'copy', '-movflags', '+faststart', 'out.mp4'
        ], 'retitle', {
          cwd: workDir,
          signal,
          onTime: (seconds: number): void => onProgress({ percent: 1 + (Math.min(1, seconds / total) * 92), detail: '换标题' })
        });
      }

      file = path.join(workDir, 'out.mp4');
    }

    onProgress({ percent: 94, detail: '做封面' });

    const covers: { wide: string; standard: string } = await makeCovers({
      ffmpeg: job.ffmpeg, cwd: workDir, dir: coverDir(job.outDir, draft.key), job, highlight, draft, fonts, signal
    });
    const result: ClipResult = clipResultOf(job, highlight, draft, clip.index);

    await placeClip(job, result, covers, file);
    onProgress({ percent: 100, detail: '完成' });

    return result;
  } finally {
    await fsP.rm(workDir, { recursive: true, force: true }).catch((): void => undefined);
    await fsP.rmdir(job.workDir).catch((): void => undefined); // 里面没有录播了就删掉
  }
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
  const cover: string | undefined = job.radio ? path.join(job.workDir, 'cover.jpg') : undefined; // 电台：只下录音，另存封面

  checkStopped(signal);
  await fsP.mkdir(job.workDir, { recursive: true });
  onProgress({ percent: 0, detail: '取录播地址…' });

  const info: { playStreamPath: string; msgFilePath: string; coverUrl?: string } = await deps.liveInfo(job.liveId);

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
      cover,
      fetchSegment: deps.fetchSegment,
      signal,
      onProgress: (progress: DownloadProgress): void => onProgress({ percent: progress.part * DOWNLOAD_END, detail: progress.detail })
    });

    if (cover) await saveRadioCover(deps, info.coverUrl, cover, signal);

    await fsP.writeFile(sourceDone, '');
  }

  onProgress({ percent: DOWNLOAD_END, detail: '录播下载好了' });

  return { source, danmu, picture: cover && await exists(cover) ? cover : undefined };
}

/* 找爆点那一步一段的结果（存在工作文件夹的 find-N.json 里）；dropped 是没法定位、扔掉的片段和原因 */
interface FoundWindow {
  summary: string;
  highlights: Array<Highlight>;
  dropped?: Array<string>;
}

const SONG_LOOK_AROUND: number = 120; // 唱歌：模型给的时间前后各多看这么久的伴奏

/* 公演里的失误、唱歌：重新定起止（按弹幕的反应、伴奏，见 ./highlightStageTiming） */
async function locateStageItem(
  job: HighlightJob, source: string, duration: number, danmu: Array<DanmuLine>, item: Highlight, signal?: AbortSignal
): Promise<Highlight> {
  let timing: StageTiming;

  if (stageKindOf(item) === 'mistake') {
    timing = locateMistake(item, danmu, duration);
  } else {
    const from: number = Math.max(0, item.start - SONG_LOOK_AROUND);
    const to: number = Math.min(duration, item.end + SONG_LOOK_AROUND);
    const levels: Array<number> = await lowBandLevels(job.ffmpeg, source, from, to - from, path.join(job.workDir, 'lowband.pcm'), signal);

    timing = locateSong(item, levels, from, duration);
  }

  return { ...item, start: timing.start, end: timing.end, timing: timing.how };
}

/**
 * 推荐切哪几个（candidates 按分数从高到低排好）：公演的「自动」按 MC、唱歌、失误各算各的名额（./highlightStage 的 STAGE_QUOTA），别的取前几个
 * @return { Set<number> } 第几个候选
 */
export function recommend(job: Pick<HighlightJob, 'count' | 'autoScore' | 'stage'>, candidates: Array<Highlight>, duration: number): Set<number> {
  const quota: StageQuota | null = job.stage && job.count === 'auto' ? stageQuota(candidates, job.autoScore ?? AUTO_SCORE) : null;
  const target: number = quota ? quota.total : targetCount(candidates, job.count, duration, job.autoScore);
  const byKind: Record<StageKind, number> = { mc: 0, song: 0, mistake: 0 };
  const picked: Set<number> = new Set();

  for (const [order, item] of candidates.entries()) {
    if (picked.size >= target) break;

    const kind: StageKind = stageKindOf(item);

    // 这一类不够分，或者名额满了：看下一个候选
    if (quota && (item.score < quota.minScore[kind] || byKind[kind] >= quota.limit[kind])) continue;

    picked.add(order);
    byKind[kind]++;
  }

  return picked;
}

/**
 * 第 2、3 步：找爆点，写好清单（输出文件夹里的 爆点.json）等人挑。重新找一遍时，以前做好的切片会接过来
 * @param { HighlightJob } job
 * @param { HighlightDeps } deps
 * @param { PreparedSource } prepared - prepareHighlight 的结果
 * @param { (progress: HighlightProgress) => void } onProgress - 这一步占总进度的 DOWNLOAD_END ~ 100
 * @param { AbortSignal } [signal] - 用户点了停止
 */
export async function findHighlights(
  job: HighlightJob, deps: HighlightDeps, prepared: PreparedSource, onProgress: (progress: HighlightProgress) => void, signal?: AbortSignal
): Promise<ShowInfo> {
  const glossary: Glossary = parseGlossary(job.glossary);
  const meta: LiveMeta = { member: job.member, title: job.title, glossary: glossaryPrompt(glossary), members: job.members, learned: learnedPrompt(job.learned) };
  const { source, danmu }: PreparedSource = prepared;
  const cacheFiles: Array<string> = [];

  checkStopped(signal);
  // 找爆点、剪片段都往工作文件夹里写；用已经下好的录播切片时（自动抓取）前面没有下载这一步，文件夹还没建，
  // ffmpeg 会报「Error opening output files」（2026-11-23 曾昕妍、刘诗彤两场实际遇到）
  await fsP.mkdir(job.workDir, { recursive: true });

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
    let found: FoundWindow | undefined = await readJsonFile(cacheFile);

    cacheFiles.push(cacheFile);
    onProgress({ percent: DOWNLOAD_END + ((order / windows.length) * (100 - DOWNLOAD_END)), detail: `${ label }…` });

    if (!found) {
      const audio: string = path.join(job.workDir, `audio-${ Math.round(window.start) }.mp3`);

      await runFfmpeg(job.ffmpeg, [
        '-y', '-v', 'error', '-ss', window.start.toFixed(3), '-t', window.length.toFixed(3), '-i', source,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audio
      ], { signal });
      const audioBase64: string = await base64Of(audio);
      const ask: (withDanmu: Array<DanmuLine>) => Promise<unknown> = (withDanmu: Array<DanmuLine>): Promise<unknown> => geminiJson<unknown>(
        job.gemini, job.stage
          ? stageFindRequest(meta, window, audioBase64, withDanmu, viaAgy, job.stage)
          : findRequest(meta, window, audioBase64, withDanmu, viaAgy), signal, deps.fetchImpl);
      let refused: string | undefined;

      try {
        found = readFound(await ask(danmu), window);
      } catch (err) {
        if (!(err instanceof ContentRefused)) throw err;

        // 以内容为由被拒：多半是弹幕里的敏感词，去掉弹幕再问一次；还不行就跳过这一段
        try {
          found = readFound(await ask([]), window);
        } catch (again) {
          if (!(again instanceof ContentRefused)) throw again;

          refused = `${ label }被模型以内容为由拒绝（${ again.message }），这一段没有找爆点`;
          found = { summary: '', highlights: [] };
        }
      }
      // 原话（quote、first、last）不换：要拿它们去本地识别的结果里找
      found = {
        summary: applyGlossary(found.summary, glossary),
        highlights: found.highlights.map((item: Highlight): Highlight => ({
          ...item, title: applyGlossary(item.title, glossary), cover: applyGlossary(item.cover, glossary), reason: applyGlossary(item.reason, glossary)
        }))
      };

      // 公演里的失误、唱歌：按弹幕的反应、伴奏定起止（不按原话：唱歌时识别不准，歌词还可能唱两遍，见 ./highlightStageTiming）
      const located: Array<Highlight> = [];
      const dropped: Array<string> = refused ? [refused] : [];
      let tokens: Array<TimedToken> | null | undefined;

      if (viaAgy && found.highlights.some((item: Highlight): boolean => !job.stage || stageKindOf(item) === 'mc')) {
        onProgress({ percent: DOWNLOAD_END + (((order + 0.6) / windows.length) * (100 - DOWNLOAD_END)), detail: `${ label }：按原话定位…` });
        tokens = await deps.recognize!(audio, signal);

        if (!tokens) throw new Error(NEED_ALIGNER);
      }

      // 本地识别的时间是这一段里的，爆点的时间是整场里的
      const absolute: Array<TimedToken> = (tokens ?? []).map((token: TimedToken): TimedToken => ({ text: token.text, time: token.time + window.start }));

      for (const item of found.highlights) {
        if (job.stage && stageKindOf(item) !== 'mc') {
          located.push(await locateStageItem(job, source, duration, danmu, item, signal));
          continue;
        }

        if (!viaAgy) {
          located.push(item);
          continue;
        }

        const fixed: Highlight | null = fixHighlightTimes(item, absolute);

        if (fixed) {
          located.push({ ...fixed, end: Math.min(fixed.end, window.start + window.length) });
        } else {
          dropped.push(`「${ item.title }」在录音里找不到它引的原话，没法定位，跳过`);
        }
      }

      found = { summary: found.summary, highlights: located, dropped };
      await fsP.writeFile(cacheFile, JSON.stringify(found, null, 2));
      await fsP.rm(audio, { force: true });
    }

    unlocated.push(...(found.dropped ?? []));
    all.push(...found.highlights);
    found.summary && summaries.push(found.summary);
  }

  // 3. 推荐哪几个，写好清单
  const candidates: Array<Highlight> = mergeHighlights(all);
  const info: ShowInfo = newShowInfo(job, {
    model: job.gemini.model, duration, summaries, notes: unlocated, items: candidates, recommended: recommend(job, candidates, duration)
  }, await readShowInfo(job.outDir));

  await writeShowInfo(job.outDir, info);

  // 清单存好了，这些就没用了（留着的话重新找一遍时会直接用上次的结果）
  for (const file of cacheFiles) await fsP.rm(file, { force: true });

  // 一个都没找到：没有要切的，工作文件夹（里面有下载好的录播）不用留
  if (candidates.length === 0) await fsP.rm(job.workDir, { recursive: true, force: true }).catch((): void => undefined);
  // 找到了：下载好的录播留着，切的时候要用；里面什么都没有就删掉
  else await fsP.rmdir(job.workDir).catch((): void => undefined);

  return info;
}

async function cutContext(job: HighlightJob, prepared: PreparedSource, signal?: AbortSignal): Promise<CutContext> {
  checkStopped(signal);
  // 用已经下好的录播切片时（自动抓取）前面没有下载这一步，文件夹还没建，ffmpeg 会报「Error opening output files」（2026-11-23 实际遇到）
  await fsP.mkdir(job.workDir, { recursive: true });
  await fsP.mkdir(job.outDir, { recursive: true });

  const duration: number = await mediaDuration(job.ffmpeg, prepared.source, signal);
  const fonts: FontSet = await pickFonts(job.workDir);

  return {
    job, signal, source: prepared.source, duration, danmu: prepared.danmu,
    fonts: fonts.dir ? { ...fonts, dir: `../${ fonts.dir }` } : fonts, // 合成时的当前文件夹是 clip-N
    still: await stillInput(job.ffmpeg, prepared, signal)
  };
}

const WRITE_AT_ONCE: number = 3; // 同时写几个：时间主要花在等 Gemini 上

/* 同时做几个；有一个出错，别的都停下来，报那个错 */
async function together<T>(list: Array<T>, size: number, run: (item: T, signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const controller: AbortController = new AbortController();
  const queue: Array<T> = [...list];
  let failed: { err: unknown } | undefined;

  function handleAbort(): void {
    controller.abort();
  }

  signal?.addEventListener('abort', handleAbort, { once: true });

  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async (): Promise<void> => {
    while (queue.length > 0 && !controller.signal.aborted) {
      try {
        await run(queue.shift()!, controller.signal);
      } catch (err) {
        failed ??= { err };
        controller.abort();
      }
    }
  }));
  signal?.removeEventListener('abort', handleAbort);
  checkStopped(signal);

  if (failed) throw failed.err;
}

/**
 * 第 4 步：给挑好的（清单里 cut 的、还没有草稿的）写字幕、标题、亮点，取封面候选，不渲染。写好一个就记一个（onWritten），中途停了不会忘；
 * 某个剪完太短、被模型拒绝的，原因也交给 onWritten
 * @param { HighlightJob } job
 * @param { HighlightDeps } deps
 * @param { PreparedSource } prepared
 * @param { ShowInfo } info
 * @param { (progress: HighlightProgress) => void } onProgress - 0 ~ 100
 * @param { (item: ShowItem, draft: ClipDraft | string) => Promise<void> } onWritten
 * @param { AbortSignal } [signal] - 用户点了停止
 */
export async function writeDrafts(
  job: HighlightJob, deps: HighlightDeps, prepared: PreparedSource, info: ShowInfo,
  onProgress: (progress: HighlightProgress) => void, onWritten: (item: ShowItem, draft: ClipDraft | string) => Promise<void>, signal?: AbortSignal
): Promise<{ written: number; skipped: Array<string> }> {
  const glossary: Glossary = parseGlossary(job.glossary);
  const meta: LiveMeta = { member: job.member, title: job.title, glossary: glossaryPrompt(glossary), members: job.members, learned: learnedPrompt(job.learned) };
  const base: CutContext = await cutContext(job, prepared, signal);
  const list: Array<ShowItem> = info.items.filter((item: ShowItem): boolean => item.cut && !item.draft);
  const parts: Map<ShowItem, number> = new Map();
  const skipped: Array<string> = [];
  let written: number = 0;
  let recognizing: Promise<unknown> = Promise.resolve();
  let photos: RadioPhotos | undefined;

  // 电台：先把她以前的封面、照片存进封面库，交给 Gemini 排好；同一场的切片轮着用
  if (job.radio && list.length > 0) {
    onProgress({ percent: 0, detail: '整理封面库（她以前的封面和照片）…' });

    try {
      photos = await collectRadioPhotos({
        showDir: job.outDir, member: job.member, title: job.title, date: job.date, liveId: job.liveId, picture: prepared.picture, ffmpeg: job.ffmpeg,
        gemini: job.gemini, memberPhotos: deps.memberPhotos, fetchImage: deps.fetchImage, fetchImpl: deps.fetchImpl, signal
      });
    } catch (err) {
      if (err instanceof HighlightStopped) throw err;

      console.warn('封面库没整理好，电台只用这场的封面', err);
    }
  }

  const before: number = info.items.filter((item: ShowItem): boolean => item.draft !== undefined).length; // 之前写好的占了排在前面的照片

  // 本地识别很吃 CPU，一个一个来
  const recognize: HighlightDeps['recognize'] = deps.recognize && ((audio: string, stop?: AbortSignal): Promise<Array<TimedToken> | null> => {
    const next: Promise<Array<TimedToken> | null> = recognizing.then((): Promise<Array<TimedToken> | null> => deps.recognize!(audio, stop));

    recognizing = next.catch((): void => undefined);

    return next;
  });

  function report(item: ShowItem, stage: string, part: number): void {
    parts.set(item, part);

    const sum: number = Array.from(parts.values()).reduce((total: number, one: number): number => total + one, 0);

    onProgress({ percent: (sum / list.length) * 100, detail: `写标题 ${ written + skipped.length }/${ list.length }：「${ item.title }」${ stage }` });
  }

  await together(list, WRITE_AT_ONCE, async (item: ShowItem, stop: AbortSignal): Promise<void> => {
    const draft: ClipDraft | string = await writeClip({ ...base, signal: stop, deps: { ...deps, recognize }, meta, glossary }, highlightOf(item),
      (stage: string, part: number): void => report(item, stage, part), photos && radioChoice(photos, before + list.indexOf(item)));

    typeof draft === 'string' ? skipped.push(draft) : written++;
    // 问过 Gemini 的结果不留（写成的在草稿里）：没写成的改了说明再写、写好的「重新写」，都要真的再问一次
    await fsP.rm(clipWorkDir(job, item), { recursive: true, force: true }).catch((): void => undefined);
    await onWritten(item, draft);
    report(item, '写好了', 1);
  }, signal);

  return { written, skipped };
}

/**
 * 第 5、6 步：把定好了标题的（清单里 cut 的、有草稿的）渲染成切片。做完一个就记一个（onMade），中途停了不会忘。
 * 重切的用原来的编号，旧文件换掉
 * @param { HighlightJob } job
 * @param { PreparedSource } prepared
 * @param { ShowInfo } info
 * @param { (progress: HighlightProgress) => void } onProgress - 0 ~ 100
 * @param { (item: ShowItem, result: ClipResult) => Promise<void> } onMade
 * @param { AbortSignal } [signal] - 用户点了停止
 */
export async function renderDrafts(
  job: HighlightJob, prepared: PreparedSource, info: ShowInfo,
  onProgress: (progress: HighlightProgress) => void, onMade: (item: ShowItem, result: ClipResult) => Promise<void>, signal?: AbortSignal
): Promise<Array<ClipResult>> {
  const context: CutContext = await cutContext(job, prepared, signal);
  const plan: Array<{ item: ShowItem; index: number }> = planCuts(info, await fsP.readdir(job.outDir), readyToRender);
  const clips: Array<ClipResult> = [];

  for (const [order, { item, index }] of plan.entries()) {
    checkStopped(signal);

    const made: ClipResult = await renderClip(context, highlightOf(item), item.draft!, index, (stage: string, part: number): void => {
      onProgress({ percent: ((order + part) / plan.length) * 100, detail: `第 ${ order + 1 }/${ plan.length } 个：${ stage }` });
    });

    clips.push(made);
    await onMade(item, made);
  }

  return clips;
}

/**
 * 写完直接渲染，中间不停（程序里是写完等人定标题，这个给测试和检查脚本用）。全部做完删掉工作文件夹（里面可能有整场录播，很大）
 * @param { (item: ShowItem, result: ClipResult | string) => Promise<void> } onMade - 做完一个记一个；没做成的是原因
 */
export async function cutHighlights(
  job: HighlightJob, deps: HighlightDeps, prepared: PreparedSource, info: ShowInfo,
  onProgress: (progress: HighlightProgress) => void, onMade: (item: ShowItem, result: ClipResult | string) => Promise<void>, signal?: AbortSignal
): Promise<CutResult> {
  let now: ShowInfo = info;
  const { skipped }: { skipped: Array<string> } = await writeDrafts(job, deps, prepared, info,
    (progress: HighlightProgress): void => onProgress({ ...progress, percent: progress.percent / 2 }),
    async (item: ShowItem, draft: ClipDraft | string): Promise<void> => {
      now = withDraft(now, item, draft);

      if (typeof draft === 'string') await onMade(item, draft);
    }, signal);
  const clips: Array<ClipResult> = await renderDrafts(job, prepared, now,
    (progress: HighlightProgress): void => onProgress({ ...progress, percent: 50 + (progress.percent / 2) }), onMade, signal);

  await fsP.rm(job.workDir, { recursive: true, force: true }).catch((): void => undefined);

  return { clips, skipped };
}

/**
 * 找完直接切推荐的，中间不停（程序里是找完等人挑，这个给测试和检查脚本用）
 * @param { HighlightJob } job
 * @param { HighlightDeps } deps
 * @param { PreparedSource } prepared
 * @param { (progress: HighlightProgress) => void } onProgress
 * @param { AbortSignal } [signal]
 */
export async function processHighlight(
  job: HighlightJob, deps: HighlightDeps, prepared: PreparedSource, onProgress: (progress: HighlightProgress) => void, signal?: AbortSignal
): Promise<HighlightResult> {
  let info: ShowInfo = await findHighlights(job, deps, prepared, onProgress, signal);
  const { clips, skipped }: CutResult = await cutHighlights(job, deps, prepared, info, onProgress, async (item: ShowItem, result: ClipResult | string): Promise<void> => {
    info = withResult(info, item, result);
    await writeShowInfo(job.outDir, info);
  }, signal);

  await writeShowInfo(job.outDir, { ...info, status: 'done' });

  return {
    clips, skipped: [...info.notes, ...skipped], found: info.items.length, summary: info.summaries.join(' '),
    infoFile: path.join(job.outDir, INFO_FILE)
  };
}

/**
 * 下载、找爆点、切推荐的，中间不停（同上，给测试和检查脚本用）
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
