import { createHash } from 'node:crypto';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { runFfmpeg } from './highlightFfmpeg';
import {
  buildCoverAss, buildVideoAss, coverFilter, frameFilter, pictureFrameFilter, COVER_WIDTHS, LEFT_WIDTH, type FontSet, type PlacedDanmu
} from './highlightAss';
import { buildStageCoverAss, stageCoverFilter, stageFrameFilter, STAGE_VIDEO, type StageInfo } from './highlightStageAss';
import { renderLiveCoverCanvas, renderRadioCoverCanvas, renderStageCoverCanvas } from './highlightGraphics';
import { resolveTeam } from './highlightTheme';
import { coverTag, draftCoverLines, draftPoints, draftSegments, fromOut, lookOf, videoTag } from './highlightDraft';
import type { ClipDraft, Highlight } from './highlightTypes';

/**
 * 切片的封面。写完标题、还没渲染时就要给人看真的封面，所以不从成片里取画面：写的时候从录播里取几帧，
 * 存在切片文件夹的 .covers 里；定标题时预览、渲染完的封面、渲染完再改标题，都从这几帧做，看到的和最后的是同一张。
 * Electron 渲染进程下由 ./highlightGraphics 用 Canvas 2D 生成定稿封面（公演 A / 电台 B / 直播 C3-A），
 * 无 DOM 的测试环境下自动回退到 FFmpeg + ASS。
 * 除了从录播里取的，还可以用别的图（用户 2026-11-26 要的）：自己上传的截图、播放时停在哪一帧就用哪一帧、电台封面库里的照片（./radioPhotos），
 * 记在草稿的 pictures 里，排在录播取的后面；用到的时候才照成片的样子排好（ensureFrame）。
 * 接入点：./highlightPipeline（写、渲染、改标题），./coverPreview（预览），./DraftPanel（加图）。
 */
const COVER_FOLDER: string = '.covers';
const COVER_STYLE_VERSION: string = 'v2';

export const LIBRARY_FOLDER: string = '封面库'; // 电台封面库（./radioPhotos）：切片保存位置下面的这个文件夹

export interface CoverJob {
  member: string;
  date: string;
  radio?: boolean;
  team?: string;
  teamColor?: string;
  stage?: StageInfo;
}

/* 一个切片的封面候选放在哪里 */
export function coverDir(outDir: string, key: string): string {
  return path.join(outDir, COVER_FOLDER, key);
}

export function coversRoot(outDir: string): string {
  return path.join(outDir, COVER_FOLDER);
}

/* 第几个候选的画面（1920×1080）和给人挑的小图 */
export function frameFile(dir: string, index: number): string {
  return path.join(dir, `frame-${ index + 1 }.jpg`);
}

export function thumbFile(dir: string, index: number): string {
  return path.join(dir, `thumb-${ index + 1 }.jpg`);
}

/* 做好的封面：16:9 和 4:3 */
export function coverFiles(dir: string): { wide: string; standard: string } {
  return { wide: path.join(dir, 'cover-wide.jpg'), standard: path.join(dir, 'cover-standard.jpg') };
}

/* ---------- 别的图（pictures） ---------- */
type Candidates = Pick<ClipDraft, 'frames' | 'pictures'>;

/* pictures 里的一项是哪个文件：coverDir 里的只记名字，封面库的记完整路径 */
export function picturePath(dir: string, entry: string): string {
  return path.isAbsolute(entry) ? entry : path.join(dir, entry);
}

/* 封面库里一张照片的小图：放在库里（几个切片共用） */
export function libraryThumb(file: string): string {
  return path.join(path.dirname(file), '.thumbs', path.basename(file));
}

function pictureId(entry: string): string {
  return path.isAbsolute(entry) ? `lib-${ createHash('sha1').update(entry.toLowerCase()).digest('hex').slice(0, 12) }` : path.parse(entry).name;
}

function pictureOf(draft: Candidates, index: number): string | undefined {
  return index >= draft.frames.length ? draft.pictures?.[index - draft.frames.length] : undefined;
}

/* 第几个候选给人挑的小图 */
export function candidateThumb(dir: string, draft: Candidates, index: number): string {
  const entry: string | undefined = pictureOf(draft, index);

  if (!entry) return thumbFile(dir, index);

  return path.isAbsolute(entry) ? libraryThumb(entry) : path.join(dir, `${ pictureId(entry) }.thumb.jpg`);
}

/* 第几个候选排好的整张（做封面用） */
export function candidateFrame(dir: string, draft: Candidates, index: number): string {
  const entry: string | undefined = pictureOf(draft, index);

  return entry ? path.join(dir, `${ pictureId(entry) }.frame.jpg`) : frameFile(dir, index);
}

/* 小图：直播、电台和录播取的一样大（竖的，左边那一块），公演是横的 */
export async function makePictureThumb(ffmpeg: string, picture: string, thumb: string, stage: boolean, signal?: AbortSignal): Promise<void> {
  const [width, height, color]: [number, number, string] = stage ? [480, 270, '0x101215'] : [304, 540, '0x1B2030'];

  await fsP.mkdir(path.dirname(thumb), { recursive: true });
  await runFfmpeg(ffmpeg, [
    '-y', '-v', 'error', '-i', picture,
    '-vf', `scale=${ width }:${ height }:force_original_aspect_ratio=decrease:flags=lanczos,pad=${ width }:${ height }:(ow-iw)/2:(oh-ih)/2:color=${ color },setsar=1`,
    '-frames:v', '1', '-q:v', '4', `${ thumb }.part.jpg`
  ], { signal });
  await fsP.rename(`${ thumb }.part.jpg`, thumb);
}

function exists(file: string): Promise<boolean> {
  return fsP.access(file).then((): boolean => true, (): boolean => false);
}

/* 是封面库里的照片（库在切片保存位置下面的「封面库」，见 ./radioPhotos） */
export function isLibraryFile(file: string): boolean {
  return path.resolve(file).split(path.sep).includes(LIBRARY_FOLDER);
}

/**
 * 自己选的一张图（上传的截图、封面库里的照片）当封面候选：封面库里的直接用（记完整路径），别的转成 jpg 存进 coverDir；做好小图
 * @return { Promise<string> } 记在草稿 pictures 里的
 */
export async function addPicture(ffmpeg: string, dir: string, file: string, stage: boolean, signal?: AbortSignal): Promise<string> {
  if (isLibraryFile(file)) {
    (await exists(libraryThumb(file))) || await makePictureThumb(ffmpeg, file, libraryThumb(file), stage, signal);

    return path.resolve(file);
  }

  const name: string = `picture-${ Date.now() }.jpg`;

  await fsP.mkdir(dir, { recursive: true });
  // 太大的照片缩一下（高最多 2160）；读不了的格式 ffmpeg 会报错
  await runFfmpeg(ffmpeg, [
    '-y', '-v', 'error', '-i', file, '-vf', 'scale=-2:\'2*trunc(min(ih,2160)/2)\':flags=lanczos', '-frames:v', '1', '-q:v', '2', path.join(dir, name)
  ], { signal });
  await makePictureThumb(ffmpeg, path.join(dir, name), candidateThumb(dir, { frames: [], pictures: [name] }, 0), stage, signal);

  return name;
}

/**
 * 播放录播时停在的那一帧当封面候选：原样存进 coverDir
 * @param { number } time - 录播文件里的时间（秒）
 * @return { Promise<string> } 记在草稿 pictures 里的
 */
export async function capturePicture(ffmpeg: string, dir: string, source: string, time: number, stage: boolean, signal?: AbortSignal): Promise<string> {
  const name: string = `picture-${ Date.now() }.jpg`;

  await fsP.mkdir(dir, { recursive: true });
  await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-ss', Math.max(0, time).toFixed(3), '-i', source, '-frames:v', '1', '-q:v', '2', path.join(dir, name)], { signal });
  await makePictureThumb(ffmpeg, path.join(dir, name), candidateThumb(dir, { frames: [], pictures: [name] }, 0), stage, signal);

  return name;
}

/**
 * 封面用的那一帧（排好的整张）。别的图第一次用的时候才排：直播、电台把第一个候选的左边换成这张图，公演直接放进画面那一块。
 * 这张图不在了（封面库里删了）时用第一个候选
 */
export async function ensureFrame(
  ffmpeg: string, dir: string, draft: Pick<ClipDraft, 'frames' | 'pictures' | 'frame'>, stage: boolean, signal?: AbortSignal
): Promise<string> {
  const entry: string | undefined = pictureOf(draft, draft.frame);

  if (!entry) return frameFile(dir, Math.min(draft.frame, Math.max(0, draft.frames.length - 1)));

  const out: string = candidateFrame(dir, draft, draft.frame);

  if (await exists(out)) return out;

  const picture: string = picturePath(dir, entry);

  if (!(await exists(picture))) {
    console.warn('封面用的图不在了，用第一个候选', picture);

    return frameFile(dir, 0);
  }

  await runFfmpeg(ffmpeg, stage
    ? ['-y', '-v', 'error', '-i', picture, '-filter_complex', stageFrameFilter(), '-map', '[out]', '-frames:v', '1', '-q:v', '2', `${ out }.part.jpg`]
    : ['-y', '-v', 'error', '-i', frameFile(dir, 0), '-i', picture, '-filter_complex', pictureFrameFilter(), '-map', '[out]', '-frames:v', '1', '-q:v', '2', `${ out }.part.jpg`],
  { signal });
  await fsP.rename(`${ out }.part.jpg`, out);

  return out;
}

interface FrameInput {
  ffmpeg: string;
  source: string;
  still?: Array<string>;     // 电台：当画面的那张图（ffmpeg 的输入参数）
  cwd: string;               // 字幕文件、字体放在这里
  outDir: string;            // 候选存到哪里（coverDir）
  job: CoverJob;
  draft: Pick<ClipDraft, 'start' | 'lines' | 'length' | 'whole' | 'frames'>;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
  signal?: AbortSignal;
}

/* 取封面候选：draft.frames 里的每个时间一帧 */
export async function makeFrames(input: FrameInput): Promise<void> {
  const { ffmpeg, source, still, cwd, outDir, job, draft, danmu, fonts, signal }: FrameInput = input;
  const { segments, total }: ReturnType<typeof draftSegments> = draftSegments(draft);

  // 重新写的时候：上一次的候选、封面都不要了
  await fsP.rm(outDir, { recursive: true, force: true });
  await fsP.mkdir(outDir, { recursive: true });

  if (!job.stage) {
    await fsP.writeFile(path.join(cwd, 'frame.ass'), buildVideoAss({
      title: '', tag: videoTag(job), lines: draft.lines, segments, total, danmu, fonts,
      radio: job.radio, team: job.team, teamColor: job.teamColor
    }));
  }

  for (const [index, time] of draft.frames.entries()) {
    const at: number = draft.start + fromOut(segments, time);
    const thumb: string = job.stage ? `crop=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:0:0,scale=480:270` : `crop=${ LEFT_WIDTH }:1080:0:0,scale=304:540`;

    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error', ...(still ?? ['-ss', at.toFixed(3), '-i', source]),
      '-filter_complex', `${ job.stage ? stageFrameFilter() : frameFilter(fonts, 'frame.ass', time) };[out]split[frame][small];[small]${ thumb }[thumb]`,
      '-map', '[frame]', '-frames:v', '1', '-q:v', '2', frameFile(outDir, index),
      '-map', '[thumb]', '-frames:v', '1', '-q:v', '4', thumbFile(outDir, index)
    ], { cwd, signal });
  }
}

interface CoverInput {
  ffmpeg: string;
  cwd: string;             // 字幕文件、字体放在这里
  dir: string;             // 封面候选、封面放在这里（coverDir）
  job: CoverJob;
  highlight: Highlight;
  draft: ClipDraft;
  fonts: FontSet;
  signal?: AbortSignal;
}

/* 这张封面是照什么做的（和上次一样就不用重做） */
function coverKey(input: Pick<CoverInput, 'job' | 'highlight' | 'draft'>): string {
  const { job, highlight, draft }: Pick<CoverInput, 'job' | 'highlight' | 'draft'> = input;
  const team: { code: string; color: string } = job.stage
    ? resolveTeam(job.stage.team, job.stage.teamColor)
    : resolveTeam(job.team, job.teamColor);

  return JSON.stringify([
    COVER_STYLE_VERSION,
    Boolean(job.radio),
    team.code,
    team.color,
    lookOf(draft),
    job.stage ? draftCoverLines(highlight, draft) : coverTag(job)
  ]);
}

let counter: number = 0;

/**
 * 照定好的标题、亮点、画面做封面，16:9 和 4:3 各一张。已经照这个做过的不重做
 * @return { Promise<{ wide: string; standard: string }> } 两张封面的文件
 */
export async function makeCovers(input: CoverInput): Promise<{ wide: string; standard: string }> {
  const { ffmpeg, cwd, dir, job, highlight, draft, fonts, signal }: CoverInput = input;
  const files: { wide: string; standard: string } = coverFiles(dir);
  const keyFile: string = path.join(dir, 'cover.json');
  const key: string = coverKey(input);

  if (await fsP.readFile(keyFile, 'utf8').catch((): string => '') === key) {
    const made: Array<boolean> = await Promise.all(Object.values(files).map((file: string): Promise<boolean> => fsP.access(file).then((): boolean => true, (): boolean => false)));

    if (made.every(Boolean)) return files;
  }

  await fsP.rm(keyFile, { force: true }); // 做到一半停了的不算做好

  const frame: string = await ensureFrame(ffmpeg, dir, draft, Boolean(job.stage), signal);
  const stageLines: Array<string> = job.stage ? draftCoverLines(highlight, draft) : [];
  const points: Array<string> = job.stage ? [] : draftPoints(draft);

  await Promise.all((Object.entries(COVER_WIDTHS) as Array<['wide' | 'standard', number]>).map(async ([shape, width]: ['wide' | 'standard', number]): Promise<void> => {
    const part: string = `${ files[shape] }.part.jpg`; // 做好了再换上去，看的人不会看到一半的图

    // 优先用 Chromium Canvas 2D 高质感出图（Electron 渲染进程）
    const rendered: Buffer | null = job.stage
      ? await renderStageCoverCanvas({ frameFile: frame, stage: job.stage, lines: stageLines, width })
      : (job.radio
        ? await renderRadioCoverCanvas({ frameFile: frame, meta: job, title: draft.title, points, width })
        : await renderLiveCoverCanvas({ frameFile: frame, meta: job, title: draft.title, points, width }));

    if (rendered) {
      await fsP.writeFile(part, rendered);
      await fsP.rename(part, files[shape]);

      return;
    }

    // 无 DOM 的 Node / Jest 环境回退到 FFmpeg + ASS
    const ass: string = `cover-${ counter++ }.ass`;

    await fsP.writeFile(path.join(cwd, ass), job.stage
      ? buildStageCoverAss({ stage: job.stage, lines: stageLines, fonts, width })
      : buildCoverAss({
        title: draft.title, tag: coverTag(job), member: job.member, date: job.date, radio: job.radio, team: job.team, teamColor: job.teamColor,
        points, fonts, width
      }));

    try {
      await runFfmpeg(ffmpeg, [
        '-y', '-v', 'error', '-i', frame,
        '-filter_complex', `[0:v]scale=out_range=tv,format=yuv420p[tv];${
          (job.stage ? stageCoverFilter(fonts, ass, width) : coverFilter(fonts, ass, width)).replace('[0:v]', '[tv]') }`,
        '-map', '[out]', '-frames:v', '1', '-q:v', '2', part
      ], { cwd, signal });
      await fsP.rename(part, files[shape]);
    } finally {
      await fsP.rm(path.join(cwd, ass), { force: true });
    }
  }));
  await fsP.writeFile(keyFile, key);

  return files;
}
