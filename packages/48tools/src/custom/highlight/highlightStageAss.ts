import { toOut } from './highlightCut';
import {
  assTime, assEscape, textWidth, charWidth, captionText, fontSize, rect, roundRect, assDocument, style, subtitlesFilter,
  segmentFilters, wordBoundaries, LOUDNESS_FILTER, type FontSet, type PlacedDanmu
} from './highlightAss';
import type { CaptionLine, Segment } from './highlightTypes';

/**
 * 公演切片的排版（B 站公演直播是横屏的）。成片 1920×1080：
 *   左上：直播画面 1440×810
 *   左下：字幕（MC 时她们说的话，重点词变黄；唱歌的片段没有字幕，舞台上自己有歌词）
 *   右边一列（480 宽）：队伍标签、公演名、日期、标题，分隔线下面是当时的弹幕（新的从下面出现，旧的往上挪；只显示内容，不显示昵称）
 * 封面：画面里的一帧铺满、压得很暗、稍微模糊，左上角是队伍和公演名、日期，中间两三行大字；【】里的词白字、下面刷一道深团队色的荧光笔
 *   （只盖字的下半截，不是整块矩形垫在后面），别的字白色、最后一行浅团队色（用户 2026-11-23 给的参考图）。16:9 和 4:3 两个比例。
 * 画面和封面上都不写「公演切片」（发布用的标题里有），标签里不用「·」（2026-11 用户定的）。
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
// 封面（用户 2026-11-23 给的参考图）：荧光笔用深一点的团队色，浅色字用浅一点的
const COVER_INK_LIGHTNESS: number = 0.42;
const COVER_TINT_LIGHTNESS: number = 0.87;
const COVER_TINT_SATURATION: number = 0.42;
const DANMU: { size: number; row: number; bottom: number; top: number; maxWidth: number } = { size: 30, row: 52, bottom: 1_036, top: 372, maxWidth: 400 };

/* #rrggbb → ASS 的 &HBBGGRR& */
export function assColor(hex: string): string {
  const value: string = hex.replace('#', '').padStart(6, '0');

  return `&H${ value.slice(4, 6) }${ value.slice(2, 4) }${ value.slice(0, 2) }&`.toUpperCase();
}

/**
 * 团队色换成同一个色相、指定亮度的颜色（#rrggbb）。封面的荧光笔用深一点的（亮度 0.42），浅色字用浅一点的（0.87），
 * 照用户 2026-11-23 给的参考图：NII 的紫 #af83bb → 荧光笔 #7a4a8c 左右、浅紫字 #e6d2ec 左右
 * @param { string } hex - 团队色
 * @param { number } lightness - 0 ~ 1
 * @param { number } [minSaturation] - 饱和度至少多少（浅色太灰时提一点）
 */
export function teamShade(hex: string, lightness: number, minSaturation: number = 0): string {
  const value: string = hex.replace('#', '').padStart(6, '0');
  const [r, g, b]: Array<number> = [0, 2, 4].map((at: number): number => Number.parseInt(value.slice(at, at + 2), 16) / 255);
  const max: number = Math.max(r, g, b);
  const min: number = Math.min(r, g, b);
  const l: number = (max + min) / 2;
  const d: number = max - min;
  let h: number = 0;

  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = ((b - r) / d) + 2;
    else h = ((r - g) / d) + 4;
  }

  const s: number = Math.max(minSaturation, d === 0 ? 0 : d / (1 - Math.abs((2 * l) - 1)));
  const c: number = (1 - Math.abs((2 * lightness) - 1)) * Math.min(1, s);
  const x: number = c * (1 - Math.abs((h % 2) - 1));
  const m: number = lightness - (c / 2);
  const sector: number = Math.floor(((h % 6) + 6) % 6);
  const [r1, g1, b1]: Array<number> = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];

  return `#${ [r1, g1, b1].map((part: number): string => Math.round((part + m) * 255).toString(16).padStart(2, '0')).join('') }`;
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

/* 画面上的公演名：「《Fire X》2.0」→「《Fire X》2.0 公演」；本来就以「公演」结尾的不再加 */
export function stageShowLabel(show: string): string {
  return /公演$/.test(show) ? show : `${ show } 公演`;
}

/**
 * 标题分两行（第二行用团队色）：超过 8 个字时在靠中间的标点处断；
 * 中间附近没有标点时在词和词之间断（「不是那么 / 熟悉的前辈」，不要把「熟悉」拆开），第二行不以「的」「了」这类字开头
 */
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

      // 一样近时取靠后的：第二行（团队色）短一点，更像包袱
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
  // 公演名太长时缩小字号放下（不截断）
  const showText: string = stageShowLabel(stage.show);
  const showSize: number = Math.round(Math.min(fontSize(30, fonts), (400 * fonts.em) / Math.max(1, textWidth(showText))));

  add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 108 })\\fs${ showSize }\\b1}${ assEscape(showText) }`);
  add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 150 })\\fs${ fontSize(24, fonts) }\\c${ MUTED }}${ assEscape(stage.date) }`);

  const rows: Array<string> = stageTitleRows(title);
  const titleSize: number = Math.round(Math.min(fontSize(48, fonts), (400 * fonts.em) / Math.max(1, ...rows.map(textWidth))));

  rows.forEach((row: string, index: number): void => {
    // 分两行时第二行用团队色
    const color: string = index === rows.length - 1 && rows.length > 1 ? `\\c${ team }` : '';

    add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 206 + (index * Math.round(titleSize * 1.25)) })\\fs${ titleSize }\\b1${ color }}${ assEscape(row) }`);
  });
  shape(2, '&H372F2A&', rect(x, 352, W - SIDE_PAD, 354));

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

    const caption: { text: string; size: number } = captionText(line, fonts, team); // 重点词用队伍的颜色

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
  lines: Array<string>;  // 1 ~ 3 行大字（按需要）
  fonts: FontSet;
  width: number;         // 1920（16:9）或 1440（4:3）
}

export function buildStageCoverAss(input: StageCoverInput): string {
  const { stage, fonts, width }: StageCoverInput = input;
  const events: Array<string> = [];
  const left: number = width >= W ? 110 : 90;
  const ink: string = assColor(teamShade(stage.teamColor, COVER_INK_LIGHTNESS));                  // 荧光笔：深一点的团队色
  const tint: string = assColor(teamShade(stage.teamColor, COVER_TINT_LIGHTNESS, COVER_TINT_SATURATION)); // 浅色字

  function add(layer: number, styleName: string, text: string): void {
    events.push(`Dialogue: ${ layer },0:00:00.00,0:00:10.00,${ styleName },,0,0,0,,${ text }`);
  }

  /* 字下面刷一道荧光笔：只盖住字的下半截，左右比字宽一点 */
  function highlighter(layer: number, at: { x: number; y: number }, w: number, fs: number): void {
    const padX: number = Math.round(fs * 0.07);

    add(layer, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ ink }}${
      roundRect(Math.round(at.x - padX), Math.round(at.y + (fs * 0.56)), Math.round(w + (2 * padX)), Math.round(fs * 0.37), Math.max(2, Math.round(fs * 0.03))) }{\\p0}`);
  }

  // 左上角：队伍和公演名（白字、下面刷一道荧光笔）、日期
  const badge: string = `SNH48 TEAM ${ stage.team }  ${ stage.show }`;
  const badgeSize: number = fontSize(40, fonts);

  highlighter(1, { x: left, y: 92 }, pixelWidth(badge, badgeSize, fonts), badgeSize);
  add(2, 'Text', `{\\an7\\pos(${ left },${ 92 })\\fs${ badgeSize }\\b1\\shad2\\4c&H000000&\\4a&H80&}${ assEscape(badge) }`);
  add(2, 'Text', `{\\an7\\pos(${ left },${ 172 })\\fs${ fontSize(34, fonts) }\\c${ tint }\\shad0}${ assEscape(stage.date) }`);

  // 大字：每行按最宽的一行定字号。【】里的词白字、下面刷荧光笔；别的字白色，最后一行（两行以上时）浅色
  const rows: Array<Array<{ text: string; mark: boolean }>> = input.lines.map(coverSegments).filter((row: Array<{ text: string; mark: boolean }>): boolean => row.length > 0).slice(0, 3);
  const units: (row: Array<{ text: string; mark: boolean }>) => number = (row: Array<{ text: string; mark: boolean }>): number =>
    row.reduce((sum: number, part: { text: string; mark: boolean }): number => sum + textWidth(part.text) + 0.2, 0.2);
  const room: number = width - left - 80;
  // 只有一个要突出的词（唱歌的片段只写「《歌名》」）：字更大，照用户定的《轨迹》那张
  const solo: boolean = rows.length === 1 && rows[0].length === 1 && rows[0][0].mark;
  const largest: number = solo ? (width >= W ? 250 : 220) : (width >= W ? 124 : 108);
  const size: number = Math.round(Math.min(fontSize(largest, fonts), (room * fonts.em) / Math.max(1, ...rows.map(units))));
  const gap: number = Math.round(size * 0.14);
  let y: number = Math.round((H - (rows.length * (size + gap))) / 2) + 60;

  rows.forEach((row: Array<{ text: string; mark: boolean }>, index: number): void => {
    const plainColor: string = rows.length >= 2 && index === rows.length - 1 ? `\\c${ tint }` : '';
    let x: number = left + Math.round(size * 0.07);

    for (const part of row) {
      const w: number = pixelWidth(part.text, size, fonts);

      if (part.mark) highlighter(3, { x, y }, w, size);

      add(4, 'Text', `{\\an7\\pos(${ Math.round(x) },${ y })\\fs${ size }\\b1${ part.mark ? '' : plainColor }\\shad4\\4c&H000000&\\4a&H70&}${ assEscape(part.text) }`);
      x += w + Math.round(size * (part.mark ? 0.16 : 0.08));
    }

    y += size + gap;
  });

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
      + 'boxblur=6:1,eq=brightness=-0.42:saturation=0.75[bg]',
    `[bg]${ subtitlesFilter(assFile, fonts) }[out]`
  ].join(';');
}
