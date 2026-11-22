import { toOut } from './highlightCut';
import {
  assTime, assEscape, textWidth, charWidth, captionText, fontSize, rect, roundRect, assDocument, style, subtitlesFilter,
  segmentFilters, LOUDNESS_FILTER, type FontSet, type PlacedDanmu
} from './highlightAss';
import type { CaptionLine, Segment } from './highlightTypes';

/**
 * 公演切片的排版（B 站公演直播是横屏的）。成片 1920×1080：
 *   左上：直播画面 1440×810
 *   左下：字幕（MC 时她们说的话，重点词变黄；唱歌的片段没有字幕，舞台上自己有歌词）
 *   右边一列（480 宽）：队伍标签、公演名和日期、标题，下面是当时的弹幕（新的从下面出现，旧的往上挪；只显示内容，不显示昵称）
 * 封面：画面里的一帧铺满、压暗、稍微模糊，左上角是队伍标签，中间两三行大字，【】里的词用色块突出。16:9 和 4:3 两个比例。
 * 颜色用团队色（custom/theme/accent 的 teamColors）。都是纯计算，真正跑 ffmpeg 的在 ./highlightPipeline。
 */
export interface StageInfo {
  team: string;        // X / NII / HII
  teamColor: string;   // #a9ca27
  show: string;        // 《Fire X》2.0
  date: string;        // 2026.11.21
}

const W: number = 1_920;
const H: number = 1_080;

export const STAGE_VIDEO: { width: number; height: number } = { width: 1_440, height: 810 };

const SIDE_X: number = STAGE_VIDEO.width;
const SIDE_PAD: number = 40;
const BACKGROUND: string = '0x101215';
const SIDE_BG: string = '&H1D1815&';     // #15181d（ASS 是 BBGGRR）
const CAPTION_BG: string = '&H151210&';  // #101215
const MUTED: string = '&HA6A09A&';       // #9aa0a6
const BUBBLE: string = '&H332B26&';      // #262b33
const DANMU_TEXT: string = '&HEDEAE8&';
const DARK_TEXT: string = '&H29231F&';   // #1f2329
const HIGHLIGHTS: Array<string> = ['#ffd400', '#ff6fa3'];
const DANMU: { size: number; row: number; bottom: number; top: number; maxWidth: number } = { size: 30, row: 52, bottom: 1_036, top: 410, maxWidth: 400 };

/* #rrggbb → ASS 的 &HBBGGRR& */
export function assColor(hex: string): string {
  const value: string = hex.replace('#', '').padStart(6, '0');

  return `&H${ value.slice(4, 6) }${ value.slice(2, 4) }${ value.slice(0, 2) }&`.toUpperCase();
}

/* 字在画面上有多宽（像素） */
function pixelWidth(text: string, size: number, fonts: FontSet): number {
  return (textWidth(text) * size) / fonts.em;
}

/* 一行放不下就截断加省略号 */
function fitText(text: string, size: number, maxWidth: number, fonts: FontSet): string {
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

/* 标题分两行（第二行用团队色）：超过 8 个字时在靠中间的标点处断 */
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

  if (best > 3) at = middle;

  return [chars.slice(0, at).join('').replace(/[，,\s]+$/, ''), chars.slice(at).join('').trim()].filter((row: string): boolean => row !== '');
}

export interface StageVideoAssInput {
  stage: StageInfo;
  title: string;
  lines: Array<CaptionLine>;   // 没有字幕（唱歌、失误）时是空数组
  segments: Array<Segment>;
  total: number;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
}

export function buildStageVideoAss(input: StageVideoAssInput): string {
  const { stage, title, lines, segments, total, danmu, fonts }: StageVideoAssInput = input;
  const events: Array<string> = [];
  const team: string = assColor(stage.teamColor);
  const x: number = SIDE_X + SIDE_PAD;

  function add(layer: number, start: number, end: number, styleName: string, text: string): void {
    if (end - start < 0.02) return;

    events.push(`Dialogue: ${ layer },${ assTime(start) },${ assTime(end) },${ styleName },,0,0,0,,${ text }`);
  }

  function shape(layer: number, color: string, path: string, start: number = 0, end: number = total, extra: string = ''): void {
    add(layer, start, end, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ color }${ extra }}${ path }{\\p0}`);
  }

  // 底色：字幕区、右边一列、团队色的竖条
  shape(0, CAPTION_BG, rect(0, STAGE_VIDEO.height, SIDE_X, H));
  shape(0, SIDE_BG, rect(SIDE_X, 0, W, H));
  shape(1, team, rect(SIDE_X, 0, SIDE_X + 6, H));

  // 右上：队伍标签、公演名、日期、标题
  const badge: string = `SNH48 TEAM ${ stage.team }`;
  const badgeSize: number = fontSize(30, fonts);

  shape(2, team, roundRect(x, 40, Math.round(pixelWidth(badge, badgeSize, fonts) + 36), 50, 12));
  add(3, 0, total, 'Side', `{\\an7\\pos(${ x + 18 },${ 47 })\\fs${ badgeSize }\\b1\\c${ DARK_TEXT }}${ assEscape(badge) }`);
  add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 108 })\\fs${ fontSize(30, fonts) }\\b1}${ assEscape(fitText(`${ stage.show } 公演`, fontSize(30, fonts), 400, fonts)) }`);
  add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 150 })\\fs${ fontSize(24, fonts) }\\c${ MUTED }}${ assEscape(`${ stage.date }  公演切片`) }`);

  const rows: Array<string> = stageTitleRows(title);
  const titleSize: number = Math.round(Math.min(fontSize(48, fonts), (400 * fonts.em) / Math.max(1, ...rows.map(textWidth))));

  rows.forEach((row: string, index: number): void => {
    // 分两行时第二行用团队色
    const color: string = index === rows.length - 1 && rows.length > 1 ? `\\c${ team }` : '';

    add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 206 + (index * Math.round(titleSize * 1.25)) })\\fs${ titleSize }\\b1${ color }}${ assEscape(row) }`);
  });
  shape(2, '&H372F2A&', rect(x, 352, W - SIDE_PAD, 354));
  add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 368 })\\fs${ fontSize(24, fonts) }\\c${ MUTED }}弹幕`);

  // 字幕：左下居中
  const kept: Array<CaptionLine> = lines.filter((line: CaptionLine): boolean => line.keep);

  kept.forEach((line: CaptionLine, index: number): void => {
    const start: number | null = toOut(segments, line.start);
    const segment: Segment | undefined = segments.find((item: Segment): boolean => line.start >= item.start && line.start <= item.end);

    if (start === null || !segment) return;

    const next: CaptionLine | undefined = kept[index + 1];
    const nextStart: number | null = next ? toOut(segments, next.start) : null;
    let end: number = segment.out + (Math.min(line.end, segment.end) - segment.start) + 0.9;

    if (nextStart !== null && nextStart > start) end = Math.min(Math.max(end, Math.min(nextStart, end + 0.8)), nextStart);

    const caption: { text: string; size: number } = captionText(line, fonts);

    add(4, start, Math.min(end, total), 'Caption', `{\\an5\\pos(${ SIDE_X / 2 },${ STAGE_VIDEO.height + 135 })\\fs${
      Math.min(caption.size, fontSize(92, fonts)) }\\fad(80,0)}${ caption.text }`);
  });

  // 弹幕：一条一个圆角底，新的从下面出现、旧的往上挪，挪出弹幕区就不画；只显示内容
  const size: number = fontSize(DANMU.size, fonts);
  const items: Array<PlacedDanmu & { text: string; width: number }> = danmu.map((item: PlacedDanmu): PlacedDanmu & { text: string; width: number } => {
    const text: string = fitText(item.message, size, DANMU.maxWidth - 32, fonts);

    return { ...item, text, width: Math.round(Math.min(DANMU.maxWidth, pixelWidth(text, size, fonts) + 32)) };
  });

  items.forEach((item: PlacedDanmu & { text: string; width: number }, index: number): void => {
    for (let k: number = index; k < items.length; k++) {
      const steps: number = k - index; // 后面又来了几条：往上挪几行
      const y: number = DANMU.bottom - ((steps + 1) * DANMU.row);

      if (y < DANMU.top) break;

      const from: number = items[k].at;
      const to: number = k + 1 < items.length ? items[k + 1].at : total;
      const prevY: number = y + DANMU.row;
      const move: (dx: number, dy: number) => string = (dx: number, dy: number): string => (from > 0
        ? `\\move(${ x + dx },${ (steps === 0 ? y + 24 : prevY) + dy },${ x + dx },${ y + dy },0,180)${ steps === 0 ? '\\fad(160,0)' : '' }`
        : `\\pos(${ x + dx },${ y + dy })`);

      add(5, from, to, 'Shape', `{\\an7${ move(0, 0) }\\p1\\c${ BUBBLE }}${ roundRect(0, 0, item.width, 42, 10) }{\\p0}`);
      add(6, from, to, 'Danmu', `{\\an7${ move(16, 4) }\\fs${ size }}${ assEscape(item.text) }`);
    }
  });

  return assDocument([
    style('Caption', fonts.text, fontSize(76, fonts), '&H00FFFFFF', '&H66000000', false, 2, 3, 5),
    style('Side', fonts.text, fontSize(30, fonts), '&H00FFFFFF', '&H00000000', false, 0, 0, 7),
    style('Danmu', fonts.regular, size, `&H00${ DANMU_TEXT.slice(2, 8) }`, '&H00000000', false, 0, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events);
}

/* 合成公演切片的滤镜：剪好的画面缩到 1440×810 放在左上，压上字幕；声音统一响度 */
export function stageRenderFilter(segments: Array<Segment>, fonts: FontSet, assFile: string = 'overlay.ass'): string {
  return [
    ...segmentFilters(segments),
    `[vc]fps=30,scale=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:force_original_aspect_ratio=decrease:flags=lanczos,`
      + `pad=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:(ow-iw)/2:(oh-ih)/2:color=${ BACKGROUND },setsar=1[vs]`,
    `color=c=${ BACKGROUND }:s=${ W }x${ H }:r=30[bg]`,
    '[bg][vs]overlay=0:0:shortest=1[base]',
    `[base]${ subtitlesFilter(assFile, fonts) }[vout]`,
    LOUDNESS_FILTER
  ].join(';');
}

/* 封面上的一行：【】里的是要用色块突出的词 */
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
  lines: Array<string>;  // 2 ~ 3 行大字
  fonts: FontSet;
  width: number;         // 1920（16:9）或 1440（4:3）
}

export function buildStageCoverAss(input: StageCoverInput): string {
  const { stage, fonts, width }: StageCoverInput = input;
  const events: Array<string> = [];
  const left: number = width >= W ? 110 : 90;
  const team: string = assColor(stage.teamColor);

  function add(layer: number, styleName: string, text: string): void {
    events.push(`Dialogue: ${ layer },0:00:00.00,0:00:10.00,${ styleName },,0,0,0,,${ text }`);
  }

  // 左上角：队伍标签、日期
  const badge: string = `SNH48 TEAM ${ stage.team } · ${ stage.show }`;
  const badgeSize: number = fontSize(40, fonts);

  add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ team }}${ roundRect(left, 90, Math.round(pixelWidth(badge, badgeSize, fonts) + 48), 66, 14) }{\\p0}`);
  add(2, 'Text', `{\\an7\\pos(${ left + 24 },${ 99 })\\fs${ badgeSize }\\b1\\c${ DARK_TEXT }\\shad0}${ assEscape(badge) }`);
  add(2, 'Text', `{\\an7\\pos(${ left },${ 176 })\\fs${ fontSize(36, fonts) }\\c&HD9D4D0&\\shad0}${ assEscape(`${ stage.date }  公演切片`) }`);

  // 大字：每行按最宽的一行定字号；色块轮流用黄色、粉色
  const rows: Array<Array<{ text: string; mark: boolean }>> = input.lines.map(coverSegments).filter((row: Array<{ text: string; mark: boolean }>): boolean => row.length > 0).slice(0, 3);
  const units: (row: Array<{ text: string; mark: boolean }>) => number = (row: Array<{ text: string; mark: boolean }>): number =>
    row.reduce((sum: number, part: { text: string; mark: boolean }): number => sum + textWidth(part.text) + (part.mark ? 0.8 : 0.3), 0);
  const room: number = width - left - 80;
  const size: number = Math.round(Math.min(fontSize(width >= W ? 118 : 104, fonts), (room * fonts.em) / Math.max(1, ...rows.map(units))));
  const gap: number = Math.round(size * 0.44);
  let y: number = Math.round((H - (rows.length * (size + gap))) / 2) + 60;
  let colorIndex: number = 0;

  for (const row of rows) {
    let x: number = left;

    for (const part of row) {
      const w: number = pixelWidth(part.text, size, fonts);

      if (part.mark) {
        const color: string = assColor(HIGHLIGHTS[colorIndex % HIGHLIGHTS.length]);

        colorIndex += 1;
        add(3, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ color }}${ roundRect(Math.round(x - 14), y + 6, Math.round(w + 28), Math.round(size * 1.14), 16) }{\\p0}`);
        add(4, 'Text', `{\\an7\\pos(${ Math.round(x) },${ y })\\fs${ size }\\b1\\c${ DARK_TEXT }\\shad0}${ assEscape(part.text) }`);
        x += w + Math.round(size * 0.36);
      } else {
        add(4, 'Text', `{\\an7\\pos(${ Math.round(x) },${ y })\\fs${ size }\\b1\\shad4\\4c&H000000&\\4a&H60&}${ assEscape(part.text) }`);
        x += w + Math.round(size * 0.26);
      }
    }

    y += size + gap;
  }

  return assDocument([
    style('Text', fonts.heavy, size, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 0, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events, width);
}

/**
 * 做公演封面的滤镜：输入是成片里的一帧（取左上的直播画面），放大铺满、压暗、稍微模糊，再压上字。输出 [out]
 * @param { number } width - 1920（16:9）或 1440（4:3，取中间）
 */
export function stageCoverFilter(fonts: FontSet, assFile: string, width: number): string {
  return [
    `[0:v]crop=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:0:0,scale=${ W }:${ H }:flags=lanczos,crop=${ width }:${ H },`
      + 'boxblur=6:1,eq=brightness=-0.32:saturation=0.85[bg]',
    `[bg]${ subtitlesFilter(assFile, fonts) }[out]`
  ].join(';');
}
