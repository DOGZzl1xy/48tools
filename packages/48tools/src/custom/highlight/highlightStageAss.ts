import { toOut } from './highlightCut';
import {
  assTime, assEscape, textWidth, charWidth, captionText, fontSize, rect, roundRect, slantedRect, assDocument, style, subtitlesFilter,
  segmentFilters, wordBoundaries, LOUDNESS_FILTER, type CaptionLayout, type FontSet, type PlacedDanmu, type Strip
} from './highlightAss';
import { deriveTeamTokens, resolveTeam, type ResolvedTeam, type TeamVisualTokens } from './highlightTheme';
import type { CaptionLine, Segment } from './highlightTypes';

/**
 * 公演切片的排版（公演封面 A + 公演正片方案 2）。成片 1920×1080：
 *   左上：直播画面 1440×810（无遮挡）
 *   左下：深邃暗幕团队丝绒字幕区（MC 时她们说的话，重点词带斜切团队色荧光笔；唱歌没有字幕）
 *   右边一列（480 宽）：暗幕电影丝绒侧栏（实心队色徽章、日期、公演名、左对齐竖线标题、通透气泡弹幕，不含 SNH48 与昵称）
 * 封面（方案 A）：原片零模糊、不压暗人脸，右上角实心队色徽章 + 公演名 + 日期（不含 SNH48），左下角粗体大字 + 斜切渐变荧光笔。
 * 16:9 和 4:3 两个比例。Electron 渲染进程下静态底板与封面由 ./highlightGraphics 用 Canvas 2D 高质感出图。
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

const SIDE_X: number = STAGE_VIDEO.width;
const SIDE_PAD: number = 36;
const BACKGROUND: string = '0x101215';
const MUTED: string = '&HA6A09A&';
const BUBBLE: string = '&H0E0806&';
const DANMU_TEXT: string = '&HEDEAE8&';
const DANMU: { size: number; row: number; bottom: number; top: number; maxWidth: number } = {
  size: 27, row: 52, bottom: 1_036, top: 400, maxWidth: 408
};

/* #rrggbb → ASS 的 &HBBGGRR& */
export function assColor(hex: string): string {
  const value: string = hex.replace('#', '').padStart(6, '0');

  return `&H${ value.slice(4, 6) }${ value.slice(2, 4) }${ value.slice(0, 2) }&`.toUpperCase();
}

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

function pixelWidth(text: string, size: number, fonts: FontSet): number {
  return (textWidth(text) * size) / fonts.em;
}

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

const TITLE_TOP: number = 192;

function stageTitleEvents(title: string, accentAss: string, total: number, fonts: FontSet): Array<string> {
  const rows: Array<string> = stageTitleRows(title);
  const size: number = Math.round(Math.min(fontSize(42, fonts), (386 * fonts.em) / Math.max(1, ...rows.map(textWidth))));

  return rows.map((row: string, index: number): string => {
    const color: string = index === rows.length - 1 && rows.length > 1 ? `\\c${ accentAss }` : '';

    return `Dialogue: 3,${ assTime(0) },${ assTime(total) },Side,,0,0,0,,{\\an7\\pos(${ SIDE_X + SIDE_PAD + 20 },${
      TITLE_TOP + (index * Math.round(size * 1.24)) })\\fs${ size }\\b1${ color }}${ assEscape(row) }`;
  });
}

function sideStyle(fonts: FontSet): string {
  return style('Side', fonts.text, fontSize(30, fonts), '&H00FFFFFF', '&H00000000', false, 0, 0, 7);
}

export function stageTitleStrip(): Strip {
  return { x: SIDE_X + 8, y: TITLE_TOP - 16, w: W - SIDE_X - 8, h: 152 };
}

export function buildStageTitleAss(input: { stage: StageInfo; title: string; total: number; fonts: FontSet }): string {
  const tokens: TeamVisualTokens = deriveTeamTokens(resolveTeam(input.stage.team, input.stage.teamColor).color);

  return assDocument([sideStyle(input.fonts)], stageTitleEvents(input.title, assColor(tokens.velvetAccent), input.total, input.fonts));
}

export interface StageVideoAssInput {
  stage: StageInfo;
  title: string;
  lines: Array<CaptionLine>;
  segments: Array<Segment>;
  total: number;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
  backdrop?: boolean; // true：静态丝绒侧栏与标题已由 Canvas PNG 绘制，ASS 只画动态字幕、荧光笔、气泡弹幕
}

export function buildStageVideoAss(input: StageVideoAssInput): string {
  const { stage, title, lines, segments, total, danmu, fonts, backdrop = false }: StageVideoAssInput = input;
  const resolved: ResolvedTeam = resolveTeam(stage.team, stage.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const events: Array<string> = [];
  const teamAss: string = assColor(tokens.hex);
  const onTeamAss: string = assColor(tokens.onTeam);
  const accentAss: string = assColor(tokens.velvetAccent);
  const hlAss: string = assColor(tokens.hlStart);
  const velvetDeepAss: string = assColor(tokens.velvetDeep);
  const x: number = SIDE_X + SIDE_PAD;

  function add(layer: number, start: number, end: number, styleName: string, text: string): void {
    if (end - start < 0.02) return;

    events.push(`Dialogue: ${ layer },${ assTime(start) },${ assTime(end) },${ styleName },,0,0,0,,${ text }`);
  }

  function shape(layer: number, color: string, path: string, start: number = 0, end: number = total, extra: string = ''): void {
    add(layer, start, end, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ color }${ extra }}${ path }{\\p0}`);
  }

  // 无 Canvas 底板时（纯 Node/Jest 回退）用 ASS 画方案 2 暗幕丝绒侧栏
  if (!backdrop) {
    shape(0, velvetDeepAss, rect(0, STAGE_VIDEO.height, SIDE_X, H));
    shape(0, velvetDeepAss, rect(SIDE_X, 0, W, H));
    shape(1, teamAss, rect(SIDE_X, 0, SIDE_X + 3, H));

    const badge: string = resolved.badge || `TEAM ${ stage.team }`;
    const badgeSize: number = fontSize(26, fonts);

    shape(2, teamAss, roundRect(x, 36, Math.round(pixelWidth(badge, badgeSize, fonts) + 28), 38, 6));
    add(3, 0, total, 'Side', `{\\an7\\pos(${ x + 14 },${ 41 })\\fs${ badgeSize }\\b1\\c${ onTeamAss }}${ assEscape(badge) }`);
    add(3, 0, total, 'Side', `{\\an9\\pos(${ W - SIDE_PAD },${ 42 })\\fs${ fontSize(24, fonts) }\\c${ MUTED }}${ assEscape(stage.date) }`);

    const showSize: number = Math.round(Math.min(fontSize(36, fonts), (408 * fonts.em) / Math.max(1, textWidth(stage.show))));

    add(3, 0, total, 'Side', `{\\an7\\pos(${ x },${ 88 })\\fs${ showSize }\\b1}${ assEscape(stage.show) }`);
    shape(2, '&HFFFFFF&', rect(x, 152, W - SIDE_PAD, 153), 0, total, '\\1a&HD6&');
    shape(2, accentAss, roundRect(x, TITLE_TOP + 6, 4, 96, 2));
    events.push(...stageTitleEvents(title, accentAss, total, fonts));
    shape(2, '&HFFFFFF&', rect(x, 342, W - SIDE_PAD, 343), 0, total, '\\1a&HD8&');
  }

  // 左下角居中字幕（重点词带斜切团队色荧光笔）
  const kept: Array<CaptionLine> = lines.filter((line: CaptionLine): boolean => line.keep);

  kept.forEach((line: CaptionLine, index: number): void => {
    const start: number | null = toOut(segments, line.start);
    const segment: Segment | undefined = segments.find((item: Segment): boolean => line.start >= item.start && line.start <= item.end);

    if (start === null || !segment) return;

    const next: CaptionLine | undefined = kept[index + 1];
    const nextStart: number | null = next ? toOut(segments, next.start) : null;
    let end: number = segment.out + (Math.min(line.end, segment.end) - segment.start) + 0.9;

    if (nextStart !== null && nextStart > start) end = Math.min(Math.max(end, Math.min(nextStart, end + 0.8)), nextStart);

    if (line.text.trim() === '') return;

    const endTime: number = Math.min(end, total);
    const caption: CaptionLayout = captionText(line, fonts, '&HFFFFFF&', '&HFFFFFF&', 1_280);
    const capSize: number = Math.min(caption.size, fontSize(88, fonts));
    const glyphPx: number = capSize / fonts.em;
    const lineStep: number = Math.round(capSize * 1.12);
    const blockH: number = caption.rows.length * lineStep;
    const topY: number = Math.round((STAGE_VIDEO.height + 135) - (blockH / 2));

    for (const span of caption.highlights) {
      const rowPx: number = caption.rowWidths[span.row] * glyphPx;
      const rowLeft: number = (SIDE_X / 2) - (rowPx / 2);
      const hx: number = rowLeft + (span.startUnits * glyphPx) - 8;
      const hw: number = (span.widthUnits * glyphPx) + 16;
      const hy: number = topY + (span.row * lineStep) + Math.round(capSize * 0.54);
      const hh: number = Math.round(capSize * 0.36);

      shape(3, hlAss, slantedRect(hx, hy, hw, hh), start, endTime, '\\1a&H14&\\fad(80,0)');
    }

    add(4, start, endTime, 'Caption', `{\\an5\\pos(${ SIDE_X / 2 },${ STAGE_VIDEO.height + 135 })\\fs${ capSize }\\fad(80,0)}${ caption.text }`);
  });

  // 弹幕：通透深丝绒圆角气泡，只显示内容，不显示昵称
  const size: number = fontSize(DANMU.size, fonts);
  const items: Array<PlacedDanmu & { text: string; width: number }> = danmu.map((item: PlacedDanmu): PlacedDanmu & { text: string; width: number } => {
    const text: string = fitText(item.message, size, DANMU.maxWidth - 32, fonts);

    return { ...item, text, width: Math.round(Math.min(DANMU.maxWidth, pixelWidth(text, size, fonts) + 32)) };
  });

  items.forEach((item: PlacedDanmu & { text: string; width: number }, index: number): void => {
    for (let k: number = index; k < items.length; k++) {
      const steps: number = k - index;
      const y: number = DANMU.bottom - ((steps + 1) * DANMU.row);

      if (y < DANMU.top) break;

      const from: number = items[k].at;
      const to: number = k + 1 < items.length ? items[k + 1].at : total;
      const prevY: number = y + DANMU.row;
      const move: (dx: number, dy: number) => string = (dx: number, dy: number): string => (from > 0
        ? `\\move(${ x + dx },${ (steps === 0 ? y + 22 : prevY) + dy },${ x + dx },${ y + dy },0,180)${ steps === 0 ? '\\fad(160,0)' : '' }`
        : `\\pos(${ x + dx },${ y + dy })`);

      add(5, from, to, 'Shape', `{\\an7${ move(0, 0) }\\p1\\c${ BUBBLE }\\1a&HB2&}${ roundRect(0, 0, item.width, 40, 9) }{\\p0}`);
      add(6, from, to, 'Danmu', `{\\an7${ move(16, 4) }\\fs${ size }}${ assEscape(item.text) }`);
    }
  });

  return assDocument([
    style('Caption', fonts.text, fontSize(76, fonts), '&H00FFFFFF', '&H55000000', false, 1, 2, 5),
    sideStyle(fonts),
    style('Danmu', fonts.regular, size, `&H00${ DANMU_TEXT.slice(2, 8) }`, '&H00000000', false, 0, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events);
}

/* 合成公演切片的滤镜：支持传入 Canvas 生成的静态底板 PNG */
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

/* 公演封面回退 ASS（方案 A：无黑底、右上角实心队色标 + 公演名 + 日期不含 SNH48、左下大字 + 斜切荧光笔） */
export function buildStageCoverAss(input: StageCoverInput): string {
  const { stage, fonts, width }: StageCoverInput = input;
  const resolved: ResolvedTeam = resolveTeam(stage.team, stage.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const events: Array<string> = [];
  const padX: number = width >= W ? 92 : 68;
  const teamAss: string = assColor(tokens.hex);
  const onTeamAss: string = assColor(tokens.onTeam);
  const inkAss: string = assColor(tokens.hlStart);
  const tintAss: string = assColor(tokens.stageTint);

  function add(layer: number, styleName: string, text: string): void {
    events.push(`Dialogue: ${ layer },0:00:00.00,0:00:10.00,${ styleName },,0,0,0,,${ text }`);
  }

  // 右上角：实心队伍色徽章 + 公演名 + 日期 + 发光竖条（不含 SNH48）
  const badge: string = resolved.badge || `TEAM ${ stage.team }`;
  const badgeSize: number = fontSize(width >= W ? 32 : 28, fonts);
  const showSize: number = fontSize(width >= W ? 44 : 40, fonts);
  const dateSize: number = fontSize(width >= W ? 28 : 25, fonts);
  const railX: number = width - padX - 7;
  const contentRight: number = railX - 20;
  const showW: number = Math.round(pixelWidth(stage.show, showSize, fonts));
  const badgeW: number = Math.round(pixelWidth(badge, badgeSize, fonts) + 36);
  const badgeX: number = contentRight - showW - 18 - badgeW;

  add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ teamAss }}${ roundRect(railX, 48, 7, 88, 3) }{\\p0}`);
  add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ teamAss }}${ roundRect(badgeX, 50, badgeW, 44, 6) }{\\p0}`);
  add(2, 'Text', `{\\an7\\pos(${ badgeX + 18 },54)\\fs${ badgeSize }\\b1\\c${ onTeamAss }\\shad0}${ assEscape(badge) }`);
  add(2, 'Text', `{\\an9\\pos(${ contentRight },48)\\fs${ showSize }\\b1\\shad3\\4c&H000000&\\4a&H60&}${ assEscape(stage.show) }`);
  add(2, 'Text', `{\\an9\\pos(${ contentRight },104)\\fs${ dateSize }\\shad2\\4c&H000000&\\4a&H60&}${ assEscape(stage.date) }`);

  // 左下大字 + 斜切荧光笔
  const rows: Array<Array<{ text: string; mark: boolean }>> = input.lines.map(coverSegments).filter((row: Array<{ text: string; mark: boolean }>): boolean => row.length > 0).slice(0, 3);
  const units: (row: Array<{ text: string; mark: boolean }>) => number = (row: Array<{ text: string; mark: boolean }>): number =>
    row.reduce((sum: number, part: { text: string; mark: boolean }): number => sum + textWidth(part.text) + 0.25, 0.25);
  const room: number = width - (padX * 2);
  const solo: boolean = rows.length === 1 && rows[0].length === 1 && rows[0][0].mark;
  const largest: number = solo ? (width >= W ? 220 : 190) : (width >= W ? 118 : 104);
  const size: number = Math.round(Math.min(fontSize(largest, fonts), (room * fonts.em) / Math.max(1, ...rows.map(units))));
  const gap: number = Math.round(size * 0.12);
  const totalH: number = (rows.length * size) + (Math.max(0, rows.length - 1) * gap);
  let y: number = H - 68 - totalH;

  rows.forEach((row: Array<{ text: string; mark: boolean }>, index: number): void => {
    const plainColor: string = rows.length >= 2 && index === rows.length - 1 ? `\\c${ tintAss }` : '';
    let x: number = padX;

    for (const part of row) {
      const w: number = pixelWidth(part.text, size, fonts);
      const padH: number = Math.round(size * 0.08);

      if (part.mark) {
        add(3, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ inkAss }}${ slantedRect(x - padH, y + (size * 0.56), w + (2 * padH), size * 0.36) }{\\p0}`);
      }

      add(4, 'Text', `{\\an7\\pos(${ Math.round(x) },${ y })\\fs${ size }\\b1${ part.mark ? '' : plainColor }\\shad4\\4c&H000000&\\4a&H66&}${ assEscape(part.text) }`);
      x += w + Math.round(size * (part.mark ? 0.16 : 0.08));
    }

    y += size + gap;
  });

  return assDocument([
    style('Text', fonts.heavy, size, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 0, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events, width);
}

/* 公演封面滤镜（方案 A）：原图零模糊、不压暗人脸，仅轻微提透 */
export function stageCoverFilter(fonts: FontSet, assFile: string, width: number): string {
  return [
    `[0:v]crop=${ STAGE_VIDEO.width }:${ STAGE_VIDEO.height }:0:0,scale=${ W }:${ H }:flags=lanczos,crop=${ width }:${ H },eq=contrast=1.04:saturation=1.07[bg]`,
    `[bg]${ subtitlesFilter(assFile, fonts) }[out]`
  ].join(';');
}
