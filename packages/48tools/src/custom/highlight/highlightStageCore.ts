import {
  textWidth, charWidth, subtitlesFilter, segmentFilters, wordBoundaries, LOUDNESS_FILTER, type FontSet, type PlacedDanmu, type Strip
} from './highlightAssCore';
import type { CaptionLine, Segment } from './highlightTypes';

/**
 * 公演切片的画面：和「长什么样」无关的那一半。成片 1920×1080，左上 1440×810 是直播画面，下面一条放字幕，右边一列（480 宽）放文字和弹幕。
 * 这里是尺寸、标题怎么分行、封面大字里【】的记号怎么拆、ffmpeg 的滤镜。
 * 侧栏、字幕、弹幕、封面具体怎么排、用什么颜色，是可以换的模块（StageStyle，见 ../basic/README.md），从 ./highlightStageAss 调用。
 */
export interface StageInfo {
  team: string;        // X / NII / HII / SII / G / NIII / Z / B / E / C / K
  teamColor: string;   // #a9ca27
  show: string;        // 《Fire X》2.0
  date: string;        // 2026.11.21
}

const W: number = 1_920;
const H: number = 1_080;

export const STAGE_VIDEO: { width: number; height: number } = { width: 1_440, height: 810 };

const BACKGROUND: string = '0x101215';

/* #rrggbb → ASS 的 &HBBGGRR& */
export function assColor(hex: string): string {
  const value: string = hex.replace('#', '').padStart(6, '0');

  return `&H${ value.slice(4, 6) }${ value.slice(2, 4) }${ value.slice(0, 2) }&`.toUpperCase();
}

export function pixelWidth(text: string, size: number, fonts: FontSet): number {
  return (textWidth(text) * size) / fonts.em;
}

export function fitText(text: string, size: number, maxWidth: number, fonts: FontSet): string {
  if (pixelWidth(text, size, fonts) <= maxWidth) return text;

  let out: string = '';
  let width: number = 0;
  const limit: number = ((maxWidth * fonts.em) / size) - 1;

  for (const ch of Array.from(text)) {
    if (width + charWidth(ch) > limit) break;

    out += ch;
    width += charWidth(ch);
  }

  return `${ out }…`;
}

export function stageShowLabel(show: string): string {
  return /公演$/.test(show) ? show : `${ show } 公演`;
}

export function stageTitleRows(title: string): Array<string> {
  const chars: Array<string> = Array.from(title);

  if (textWidth(title) <= 8) return [title];

  const middle: number = Math.ceil(chars.length / 2);
  let at: number = middle;
  let best: number = Infinity;

  chars.forEach((ch: string, index: number): void => {
    if (/[，、！？,!?\s：:]/.test(ch) && Math.abs(index + 1 - middle) < best) {
      best = Math.abs(index + 1 - middle);
      at = index + 1;
    }
  });

  if (best > 3) {
    at = middle;
    best = Infinity;

    for (const boundary of wordBoundaries(title)) {
      if (boundary <= 1 || boundary >= chars.length - 1) continue;

      const cost: number = Math.abs(boundary - middle) + (/[的了地得着过吗呢吧啊]/.test(chars[boundary]) ? 2 : 0);

      if (cost <= 3 && cost <= best) {
        best = cost;
        at = boundary;
      }
    }
  }

  return [chars.slice(0, at).join('').replace(/[，,\s]+$/, ''), chars.slice(at).join('').trim()].filter((row: string): boolean => row !== '');
}

export interface StageVideoAssInput {
  stage: StageInfo;
  title: string;
  lines: Array<CaptionLine>;
  segments: Array<Segment>;
  total: number;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
  backdrop?: boolean; // true：底图已经另外画好了（见 ./highlightGraphicsTypes），这里只画会动的：字幕、弹幕
}

/* 合成公演切片的滤镜：可以传入一张另外画好的底图 */
export function stageRenderFilter(segments: Array<Segment>, fonts: FontSet, assFile: string = 'overlay.ass', backdropInput?: number): string {
  const parts: Array<string> = [
    ...segmentFilters(segments),
    `[vc]fps=30,scale=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:force_original_aspect_ratio=decrease:flags=lanczos,`
      + `pad=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:(ow-iw)/2:(oh-ih)/2:color=${ BACKGROUND },setsar=1[vs]`
  ];

  if (backdropInput !== undefined) {
    parts.push(`[${ backdropInput }:v]scale=out_range=tv,format=yuv420p,setsar=1[bg]`);
  } else {
    parts.push(`color=c=${ BACKGROUND }:s=${ W }x${ H }:r=30[bg]`);
  }

  parts.push('[bg][vs]overlay=0:0:shortest=1[base]');
  parts.push(`[base]${ subtitlesFilter(assFile, fonts) }[vout]`);
  parts.push(LOUDNESS_FILTER);

  return parts.join(';');
}

export function stageFrameFilter(): string {
  return `[0:v]setpts=PTS-STARTPTS,scale=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:force_original_aspect_ratio=decrease:flags=lanczos,format=yuv420p,`
    + `pad=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:(ow-iw)/2:(oh-ih)/2:color=${ BACKGROUND },pad=${ W }:${ H }:0:0:color=${ BACKGROUND },setsar=1[out]`;
}

export function coverSegments(line: string): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  const pattern: RegExp = /【([^】]+)】/g;
  let last: number = 0;

  for (const match of line.matchAll(pattern)) {
    if (match.index > last) out.push({ text: line.slice(last, match.index), mark: false });

    out.push({ text: match[1], mark: true });
    last = match.index + match[0].length;
  }

  if (last < line.length) out.push({ text: line.slice(last), mark: false });

  return out.map((part: { text: string; mark: boolean }): { text: string; mark: boolean } => ({ ...part, text: part.text.trim() }))
    .filter((part: { text: string; mark: boolean }): boolean => part.text !== '');
}

export interface StageCoverInput {
  stage: StageInfo;
  lines: Array<string>;
  fonts: FontSet;
  width: number;
}

/* 公演封面的滤镜：画面放大到整张，压上封面的字幕文件 */
export function stageCoverFilter(fonts: FontSet, assFile: string, width: number): string {
  return [
    `[0:v]crop=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:0:0,scale=${ W }:${ H }:flags=lanczos,crop=${ width }:${ H },eq=contrast=1.04:saturation=1.07[bg]`,
    `[bg]${ subtitlesFilter(assFile, fonts) }[out]`
  ].join(';');
}

export interface StageTitleAssInput {
  stage: StageInfo;
  title: string;
  total: number;
  fonts: FontSet;
}

/* 公演切片的画面长什么样：可以换的模块（程序自带的在 ../basic/highlightStageStyle） */
export interface StageStyle {
  stageTitleStrip(): Strip;                                 // 成片上标题占的那一块：渲染完改标题时只重画这一块
  buildStageTitleAss(input: StageTitleAssInput): string;    // 只有标题的字幕文件（改标题用），位置要和 stageTitleStrip 对上
  buildStageVideoAss(input: StageVideoAssInput): string;    // 成片的字幕文件：侧栏、标题、字幕、弹幕
  buildStageCoverAss(input: StageCoverInput): string;       // 封面的字幕文件（压在放大到整张的画面上）
}
