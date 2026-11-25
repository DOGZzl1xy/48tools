import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { runFfmpeg } from './highlightFfmpeg';
import { buildCoverAss, buildVideoAss, coverFilter, frameFilter, COVER_WIDTHS, LEFT_WIDTH, type FontSet, type PlacedDanmu } from './highlightAss';
import { buildStageCoverAss, stageCoverFilter, stageFrameFilter, STAGE_VIDEO, type StageInfo } from './highlightStageAss';
import { coverTag, draftCoverLines, draftPoints, draftSegments, fromOut, lookOf, videoTag } from './highlightDraft';
import type { ClipDraft, Highlight } from './highlightTypes';

/**
 * 切片的封面。写完标题、还没渲染时就要给人看真的封面，所以不从成片里取画面：写的时候从录播里取几帧，
 * 照成片的样子排好（左边画面，右边那一刻的字幕和弹幕，没有标题），存在切片文件夹的 .covers 里；
 * 定标题时预览、渲染完的封面、渲染完再改标题，都从这几帧做，看到的和最后的是同一张。
 * 接入点：./highlightPipeline（写、渲染、改标题），./coverPreview（预览）。
 */
const COVER_FOLDER: string = '.covers';

export interface CoverJob {
  member: string;
  date: string;
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
      title: '', tag: videoTag(job), lines: draft.lines, segments, total, danmu, fonts
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

  return JSON.stringify([lookOf(draft), job.stage ? draftCoverLines(highlight, draft) : coverTag(job)]);
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
  await Promise.all((Object.entries(COVER_WIDTHS) as Array<['wide' | 'standard', number]>).map(async ([shape, width]: ['wide' | 'standard', number]): Promise<void> => {
    const ass: string = `cover-${ counter++ }.ass`;
    const part: string = `${ files[shape] }.part.jpg`; // 做好了再换上去，看的人不会看到一半的图

    await fsP.writeFile(path.join(cwd, ass), job.stage
      ? buildStageCoverAss({ stage: job.stage, lines: draftCoverLines(highlight, draft), fonts, width })
      : buildCoverAss({ title: draft.title, tag: coverTag(job), points: draftPoints(draft), fonts, width }));

    try {
      await runFfmpeg(ffmpeg, [
        '-y', '-v', 'error', '-i', frameFile(dir, draft.frame),
        // 候选是 jpg（全范围的颜色），先转成和成片一样的标准范围，不然白字会发灰
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
