import { toOut } from './highlightCut';
import { deriveTeamTokens, resolveTeam, shortMemberName, type ResolvedTeam, type TeamVisualTokens } from './highlightTheme';
import type { CaptionLine, DanmuLine, Segment } from './highlightTypes';

/**
 * 录播自动切片的画面排版（电台布局 2 / 直播布局 2）。成片是 1920×1080 的横屏：
 *   左边：直播画面 / 电台封面（竖屏，缩到 608×1080）
 *   右边：电台用通透暖白画报、直播用宝石刊头 + 通透团队丝绒（Electron 渲染进程由 ./highlightGraphics 生成底板 PNG，
 *         无 DOM 环境下由本文件生成纯净回退底）；
 *   动态层（ASS）：左对齐主轴大字幕（重点词带斜切团队色荧光笔）、去大框通透圆角气泡弹幕（新的从下面出现，旧的往上挪）。
 * 封面（16:9 和 4:3）：Electron 下由 ./highlightGraphics 生成高质感定稿（电台 B / 直播 C3-A），
 *   这里保留纯 Node 回退版（去掉无意义磨砂玻璃，突出成员名、小号时间、热点下对齐）。
 */
export interface FontSet {
  text: string;        // 普通文字
  heavy: string;       // 标题和重点词
  heavyBold: boolean;  // heavy 是不是靠「加粗」得到的（没有单独的粗体字体文件时）
  regular: string;     // 弹幕、小字
  em: number;          // ASS 的字号是行高，实际字宽 = 字号 / em
  dir?: string;        // 字体文件所在的文件夹（相对成片的工作文件夹）；系统字体不用填
}

export const VIDEO_SIZE: { width: number; height: number } = { width: 1_920, height: 1_080 };
export const LEFT_WIDTH: number = 608;

const W: number = VIDEO_SIZE.width;
const H: number = VIDEO_SIZE.height;
const RIGHT_W: number = W - LEFT_WIDTH;
const BACKGROUND: string = '0x101218';
const WHITE: string = '&HFFFFFF&';
const YELLOW: string = '&H4DE1FF&';    // ASS 的颜色是 BBGGRR
const DARK_INK: string = '&H1D1816&';  // #16181d
const TITLE_Y: number = 66;
const TITLE_SIZE: number = 46;
const TAG_SIZE: number = 28;
const CAPTION_WIDTH: number = 1_110;   // 左对齐一行字幕最宽
const CAPTION_BREAK: number = 13;      // 超过这么多个字就分两行
const BASE_EM: number = 1.448;         // 下面的字号是按思源黑体定的，换字体时按 em 的比例调整

const DANMU: { size: number; lineHeight: number; gap: number; maxUnits: number; x: number; bottom: number; top: number; maxWidth: number } = {
  size: 36,
  lineHeight: 46,
  gap: 14,
  maxUnits: 34,
  x: LEFT_WIDTH + 64,
  bottom: H - 46,
  top: 590,
  maxWidth: RIGHT_W - 128
};

/* #rrggbb → ASS 的 &HBBGGRR& */
export function hexToAss(hex: string): string {
  const value: string = hex.replace('#', '').padStart(6, '0');

  return `&H${ value.slice(4, 6) }${ value.slice(2, 4) }${ value.slice(0, 2) }&`.toUpperCase();
}

export function assTime(seconds: number): string {
  const cs: number = Math.max(0, Math.round(seconds * 100));
  const hour: number = Math.floor(cs / 360_000);
  const minute: string = String(Math.floor((cs % 360_000) / 6_000)).padStart(2, '0');
  const second: string = String(Math.floor((cs % 6_000) / 100)).padStart(2, '0');

  return `${ hour }:${ minute }:${ second }.${ String(cs % 100).padStart(2, '0') }`;
}

/* 文字里的 { } \ 在 ASS 里有特殊含义，换成全角的 */
export function assEscape(text: string): string {
  return text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/[\r\n]+/g, ' ');
}

/* 一个字大概占几个汉字宽（排版时估算用） */
export function charWidth(ch: string): number {
  if (!/[\x20-\x7e]/.test(ch)) return 1;

  if (ch === ' ') return 0.3;

  if (/[MW]/.test(ch)) return 0.9;

  if (/[A-Z]/.test(ch)) return 0.7;

  if (/[0-9]/.test(ch)) return 0.6;

  if (/[il.,:;!|'`]/.test(ch)) return 0.3;

  if (/[mw]/.test(ch)) return 0.82;

  return 0.56;
}

export function textWidth(text: string): number {
  return Array.from(text).reduce((sum: number, ch: string): number => sum + charWidth(ch), 0);
}

export function fontSize(size: number, fonts: FontSet): number {
  return Math.round((size * fonts.em) / BASE_EM);
}

export function rect(x1: number, y1: number, x2: number, y2: number): string {
  return `m ${ x1 } ${ y1 } l ${ x2 } ${ y1 } ${ x2 } ${ y2 } ${ x1 } ${ y2 }`;
}

/* -10° 斜切平行四边形（斜切荧光笔用） */
export function slantedRect(x: number, y: number, w: number, h: number): string {
  const skew: number = Math.round(h * 0.1763);
  const x1: number = Math.round(x);
  const y1: number = Math.round(y);
  const x2: number = Math.round(x + w);
  const y2: number = Math.round(y + h);

  return `m ${ x1 + skew } ${ y1 } l ${ x2 + skew } ${ y1 } ${ x2 - skew } ${ y2 } ${ x1 - skew } ${ y2 }`;
}

/* 圆角矩形的 ASS 路径 */
export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const k: number = Math.round(r * 0.5523);
  const x2: number = x + w;
  const y2: number = y + h;

  return `m ${ x + r } ${ y } l ${ x2 - r } ${ y } b ${ x2 - r + k } ${ y } ${ x2 } ${ y + r - k } ${ x2 } ${ y + r } `
    + `l ${ x2 } ${ y2 - r } b ${ x2 } ${ y2 - r + k } ${ x2 - r + k } ${ y2 } ${ x2 - r } ${ y2 } `
    + `l ${ x + r } ${ y2 } b ${ x + r - k } ${ y2 } ${ x } ${ y2 - r + k } ${ x } ${ y2 - r } `
    + `l ${ x } ${ y + r } b ${ x } ${ y + r - k } ${ x + r - k } ${ y } ${ x + r } ${ y }`;
}

function heavyTag(fonts: FontSet): string {
  return `\\fn${ fonts.heavy }\\b${ fonts.heavyBold ? 1 : 0 }`;
}

/* 哪些字要加粗：emphasis 里的词在这一句里出现的位置 */
function boldFlags(text: string, emphasis: Array<string>): Array<boolean> {
  const flags: Array<boolean> = Array.from(text).map((): boolean => false);

  for (const word of emphasis) {
    const at: number = word ? text.indexOf(word) : -1;

    if (at < 0) continue;

    const from: number = Array.from(text.slice(0, at)).length;
    const to: number = from + Array.from(word).length;

    for (let i: number = from; i < to; i++) flags[i] = true;
  }

  return flags;
}

export interface CaptionSpan {
  row: number;
  startUnits: number;
  widthUnits: number;
}

export interface CaptionLayout {
  text: string;
  size: number;
  rows: Array<string>;
  rowWidths: Array<number>;
  highlights: Array<CaptionSpan>;
}

/**
 * 一句字幕：重点词加粗并算出荧光笔区间；太长就在靠中间的标点处分成两行；字号按最宽的一行定。
 * @param { Pick<CaptionLine, 'text' | 'emphasis'> } line
 * @param { FontSet } fonts
 * @param { string } [emphasisColor] - 重点词文字颜色；不给用黄色（保留兼容）
 * @param { string } [baseColor] - 普通字颜色；默认白色（电台暖白底用深墨黑）
 * @param { number } [maxWidth] - 一行最大像素宽
 */
export function captionText(
  line: Pick<CaptionLine, 'text' | 'emphasis'>,
  fonts: FontSet,
  emphasisColor: string = YELLOW,
  baseColor: string = WHITE,
  maxWidth: number = CAPTION_WIDTH
): CaptionLayout {
  const chars: Array<string> = Array.from(line.text);
  const bold: Array<boolean> = boldFlags(line.text, line.emphasis);
  let breakAt: number = -1;

  if (textWidth(line.text) > CAPTION_BREAK) {
    const middle: number = chars.length / 2;
    let best: number = Infinity;

    chars.forEach((ch: string, index: number): void => {
      if (index < 3 || index > chars.length - 4) return;

      // 一个英文单词、一串数字不能从中间断开（iPad 不能变成 i / Pad）
      if (/[A-Za-z0-9]/.test(ch) && /[A-Za-z0-9]/.test(chars[index + 1] ?? '')) return;

      const score: number = Math.abs(index + 1 - middle)
        - (/[，、！？,!?\s]/.test(ch) ? 4 : 0)
        + (bold[index] && bold[index + 1] ? 3 : 0);

      if (score < best) {
        best = score;
        breakAt = index + 1;
      }
    });
  }

  const rows: Array<string> = breakAt > 0 ? [chars.slice(0, breakAt).join(''), chars.slice(breakAt).join('')] : [line.text];
  const rowWidths: Array<number> = rows.map(textWidth);
  const widest: number = Math.max(1, ...rowWidths);
  const size: number = Math.round(Math.min(fontSize(116, fonts), (maxWidth * fonts.em) / widest));
  const highlights: Array<CaptionSpan> = [];
  let text: string = '';
  let on: boolean = false;
  let rowIndex: number = 0;
  let unitsInRow: number = 0;
  let spanStart: number | null = null;

  const closeSpan: () => void = (): void => {
    if (spanStart !== null && unitsInRow > spanStart) {
      highlights.push({ row: rowIndex, startUnits: spanStart, widthUnits: unitsInRow - spanStart });
    }

    spanStart = null;
  };

  chars.forEach((ch: string, index: number): void => {
    if (index === breakAt) {
      closeSpan();
      text += '\\N';
      rowIndex = 1;
      unitsInRow = 0;

      if (bold[index]) spanStart = 0;
    }

    if (bold[index] !== on) {
      on = bold[index];

      if (on) {
        spanStart = unitsInRow;
        text += `{${ heavyTag(fonts) }\\c${ emphasisColor }}`;
      } else {
        closeSpan();
        text += `{\\fn${ fonts.text }\\b0\\c${ baseColor }}`;
      }
    }

    text += assEscape(ch);
    unitsInRow += charWidth(ch);
  });
  closeSpan();

  return { text, size, rows, rowWidths, highlights };
}

export interface PlacedDanmu extends DanmuLine {
  at: number; // 在成片里出现的时间
}

export function placeDanmu(danmu: Array<DanmuLine>, clipStart: number, segments: Array<Segment>, total: number): Array<PlacedDanmu> {
  if (segments.length === 0) return [];

  const firstAbs: number = clipStart + segments[0].start;
  const items: Array<PlacedDanmu> = danmu
    .filter((item: DanmuLine): boolean => item.time < firstAbs && item.time > firstAbs - 90)
    .slice(-5)
    .map((item: DanmuLine): PlacedDanmu => ({ ...item, at: 0 }));

  for (const item of danmu) {
    const time: number = item.time - clipStart;
    const at: number | null = toOut(segments, time);

    if (at !== null) {
      items.push({ ...item, at });
      continue;
    }

    const prev: Segment | undefined = segments.findLast((segment: Segment): boolean => segment.end < time);
    const next: Segment | undefined = segments.find((segment: Segment): boolean => segment.start > time);

    if (prev && next && time - prev.end < 12) items.push({ ...item, at: next.out + 0.2 });
  }

  items.sort((a: PlacedDanmu, b: PlacedDanmu): number => a.at - b.at);

  for (let i: number = 1; i < items.length; i++) {
    if (items[i].at > 0 && items[i].at - items[i - 1].at < 0.35) items[i].at = items[i - 1].at + 0.35;
  }

  return items.filter((item: PlacedDanmu): boolean => item.at < total);
}

/* 一条气泡弹幕：昵称一种颜色、内容高对比色，最多两行，返回精确气泡宽高 */
function danmuBubble(
  item: DanmuLine, nickColor: string, msgColor: string, fonts: FontSet
): { text: string; width: number; height: number; boxHeight: number } {
  const nickname: string = Array.from(item.nickname).slice(0, 14).join('');
  const nicknameLength: number = Array.from(nickname).length + 1;
  const rows: Array<Array<string>> = [[]];
  const rowUnitWidths: Array<number> = [0];

  for (const ch of Array.from(`${ nickname }：${ item.message }`)) {
    const w: number = charWidth(ch);

    if (rowUnitWidths[rows.length - 1] + w > DANMU.maxUnits) {
      if (rows.length === 2) {
        rows[1].splice(-1, 1, '…');
        break;
      }

      rows.push([]);
      rowUnitWidths.push(0);
    }

    rows[rows.length - 1].push(ch);
    rowUnitWidths[rows.length - 1] += w;
  }

  let count: number = 0;
  const text: string = rows.map((row: Array<string>): string => {
    let part: string = '';

    for (const ch of row) {
      if (count === 0) part += `{\\b1\\c${ nickColor }}`;

      if (count === nicknameLength) part += `{\\b0\\c${ msgColor }}`;

      part += assEscape(ch);
      count++;
    }

    return part;
  }).join('\\N');

  const dmSize: number = fontSize(DANMU.size, fonts);
  const widestUnits: number = Math.max(1, ...rowUnitWidths);
  const textPx: number = Math.round((widestUnits * dmSize) / fonts.em);
  const width: number = Math.min(DANMU.maxWidth, textPx + 44);
  const boxHeight: number = (rows.length * DANMU.lineHeight) + 18;

  return { text, width, height: boxHeight + DANMU.gap, boxHeight };
}

export function assDocument(styles: Array<string>, events: Array<string>, width: number = W): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${ width }
PlayResY: ${ H }
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${ styles.join('\n') }

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ events.join('\n') }
`;
}

export function style(
  name: string, font: string, size: number, color: string, back: string, bold: boolean, spacing: number, shadow: number, align: number
): string {
  return `Style: ${ name },${ font },${ size },${ color },&H00FFFFFF,&H00301A0A,${ back },${ bold ? -1 : 0 },0,0,0,100,100,${
    spacing },0,1,0,${ shadow },${ align },0,0,0,1`;
}

/* 回退模式下（无 Canvas 底板）顶栏里的标题：长了自动缩小不压右侧 */
function titleText(title: string, tag: string, fonts: FontSet, color: string = WHITE): string {
  const left: number = LEFT_WIDTH + 64;
  const room: number = W - 64 - (textWidth(tag) * TAG_SIZE) - 48 - left;
  const size: number = Math.min(TITLE_SIZE, Math.floor(room / Math.max(1, textWidth(title))));

  return `{\\an4\\pos(${ left },${ TITLE_Y })\\fs${ fontSize(size, fonts) }\\c${ color }}${ assEscape(title) }`;
}

function titleStyle(fonts: FontSet): string {
  return style('Title', fonts.heavy, fontSize(TITLE_SIZE, fonts), '&H00FFFFFF', '&H00000000', fonts.heavyBold, 1, 0, 4);
}

/* 成片上的一块地方（像素，都是偶数） */
export interface Strip {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* 纯 Node 回退模式改标题用的条带 */
export function titleStrip(tag: string): Strip {
  const x: number = LEFT_WIDTH + 56;

  return { x, y: TITLE_Y - 40, w: Math.floor((W - 72 - (textWidth(tag) * TAG_SIZE) - x) / 2) * 2, h: 80 };
}

export function buildTitleAss(input: { title: string; tag: string; total: number; fonts: FontSet; radio?: boolean; team?: string; teamColor?: string }): string {
  const tokens: TeamVisualTokens = deriveTeamTokens(resolveTeam(input.team, input.teamColor).color);
  const color: string = input.radio ? DARK_INK : hexToAss(tokens.onTeam);

  return assDocument([titleStyle(input.fonts)], [
    `Dialogue: 1,${ assTime(0) },${ assTime(input.total) },Title,,0,0,0,,${ titleText(input.title, input.tag, input.fonts, color) }`
  ]);
}

export interface VideoAssInput {
  title: string;               // 空的不写（封面候选）
  tag: string;                 // 回退模式右上角的小字
  lines: Array<CaptionLine>;
  segments: Array<Segment>;
  total: number;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
  radio?: boolean;             // true：电台布局 2（暖白）；false：直播布局 2（丝绒）
  team?: string;
  teamColor?: string;
  backdrop?: boolean;          // true：静态底板与顶栏已由 Canvas PNG 绘制，ASS 只画动态字幕、荧光笔、气泡弹幕
}

/* 成片的动态字幕文件（电台布局 2 / 直播布局 2） */
export function buildVideoAss(input: VideoAssInput): string {
  const { title, tag, lines, segments, total, danmu, fonts, radio = false, backdrop = false }: VideoAssInput = input;
  const resolved: ResolvedTeam = resolveTeam(input.team, input.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const events: Array<string> = [];

  function add(layer: number, start: number, end: number, styleName: string, text: string): void {
    if (end - start < 0.02) return;

    events.push(`Dialogue: ${ layer },${ assTime(start) },${ assTime(end) },${ styleName },,0,0,0,,${ text }`);
  }

  const teamAss: string = hexToAss(tokens.hex);
  const hlAss: string = hexToAss(radio ? tokens.hex : tokens.hlStart);
  const hlAlpha: string = radio ? '&H88&' : '&H18&';
  const railAss: string = hexToAss(radio ? tokens.hex : tokens.velvetAccent);
  const baseTextAss: string = radio ? DARK_INK : WHITE;
  const emTextAss: string = radio ? '&H14100E&' : WHITE;
  const nickAss: string = hexToAss(radio ? tokens.radioAccentDark : tokens.velvetAccent);
  const msgAss: string = radio ? '&H302926&' : '&HF0F0F0&';
  const bubbleFillAss: string = radio ? '&HE5ECEF&' : '&H120A08&';
  const bubbleAlpha: string = radio ? '&H00&' : '&HB2&';

  // 没有 Canvas 底板时（Node/Jest 回退）：用 ASS 画干净的静态结构底
  if (!backdrop) {
    const bgAss: string = radio ? '&HF6F9FA&' : hexToAss(tokens.velvetDeep);
    const headAss: string = radio ? '&HF6F9FA&' : hexToAss(tokens.mhStart);
    const headTextAss: string = radio ? DARK_INK : hexToAss(tokens.onTeam);

    add(0, 0, total, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ bgAss }}${ rect(LEFT_WIDTH, 0, W, H) }{\\p0}`);
    add(0, 0, total, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ headAss }}${ rect(LEFT_WIDTH, 0, W, 128) }{\\p0}`);
    radio && add(0, 0, total, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ teamAss }}${ rect(LEFT_WIDTH, 0, W, 10) }{\\p0}`);
    add(0, 0, total, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ radio ? DARK_INK : '&HFFFFFF&' }\\1a${ radio ? '&H00&' : '&HCC&' }}${ rect(LEFT_WIDTH + 64, 128, W - 64, 130) }{\\p0}`);
    add(0, 0, total, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ radio ? DARK_INK : '&HFFFFFF&' }\\1a&HD4&}${ rect(LEFT_WIDTH + 64, 532, W - 64, 533) }{\\p0}`);
    title && add(1, 0, total, 'Title', titleText(title, tag, fonts, headTextAss));
    add(1, 0, total, 'Tag', `{\\an6\\pos(${ W - 64 },${ TITLE_Y })\\c${ headTextAss }}${ assEscape(tag) }`);
    add(1, 0, total, 'Tag', `{\\an7\\pos(${ LEFT_WIDTH + 64 },552)\\c${ radio ? '&H7A706B&' : '&H90FFFFFF' }}弹幕 DANMU`);
  }

  // 她说的话（布局 2：瑞士左对齐主轴 + 左侧团队色竖线 + 重点词斜切荧光笔）
  const kept: Array<CaptionLine> = lines.filter((line: CaptionLine): boolean => line.keep);
  const railX: number = LEFT_WIDTH + 64;
  const textX: number = railX + 30;
  const centerY: number = radio ? 344 : 330;

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
    const caption: CaptionLayout = captionText(line, fonts, emTextAss, baseTextAss, CAPTION_WIDTH);
    const glyphPx: number = caption.size / fonts.em;
    const lineStep: number = Math.round(caption.size * 1.12);
    const blockH: number = caption.rows.length * lineStep;
    const topY: number = Math.round(centerY - (blockH / 2));

    // 左侧引导竖线（有字幕时才出现）
    add(1, start, endTime, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ railAss }\\fad(80,0)}${ roundRect(railX, topY + Math.round(glyphPx * 0.12), 5, Math.max(36, blockH - Math.round(glyphPx * 0.24)), 2) }{\\p0}`);

    // 重点词斜切荧光笔底层
    for (const span of caption.highlights) {
      const hx: number = textX + (span.startUnits * glyphPx) - 6;
      const hw: number = (span.widthUnits * glyphPx) + 12;
      const hy: number = topY + (span.row * lineStep) + Math.round(caption.size * 0.56);
      const hh: number = Math.round(caption.size * 0.34);

      add(1, start, endTime, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ hlAss }\\1a${ hlAlpha }\\fad(80,0)}${ slantedRect(hx, hy, hw, hh) }{\\p0}`);
    }

    add(2, start, endTime, 'Caption', `{\\an7\\pos(${ textX },${ topY })\\fs${ caption.size }\\c${ baseTextAss }\\fad(80,0)}${ caption.text }`);
  });

  // 弹幕（布局 2：去大框通透圆角气泡，新的从下面出现，旧的往上挪）
  const laid: Array<PlacedDanmu & { text: string; width: number; height: number; boxHeight: number }> = danmu.map(
    (item: PlacedDanmu): PlacedDanmu & { text: string; width: number; height: number; boxHeight: number } => ({
      ...item, ...danmuBubble(item, nickAss, msgAss, fonts)
    }));
  const clip: string = `\\clip(${ DANMU.x - 4 },${ DANMU.top },${ W - 44 },${ H - 24 })`;

  laid.forEach((item: PlacedDanmu & { text: string; width: number; height: number; boxHeight: number }, index: number): void => {
    let bottomY: number = DANMU.bottom;

    for (let k: number = index; k < laid.length; k++) {
      const from: number = laid[k].at;
      const to: number = k + 1 < laid.length ? laid[k + 1].at : total;

      if (k > index) bottomY -= laid[k].height;

      const boxTop: number = bottomY - item.boxHeight;

      if (boxTop < DANMU.top - 40) break;

      const prevTop: number = k === index ? boxTop + 22 : boxTop + laid[k].height;
      const moveBox: string = from > 0
        ? `\\move(${ DANMU.x },${ prevTop },${ DANMU.x },${ boxTop },0,180)${ k === index ? '\\fad(160,0)' : '' }`
        : `\\pos(${ DANMU.x },${ boxTop })`;
      const moveText: string = from > 0
        ? `\\move(${ DANMU.x + 20 },${ prevTop + 8 },${ DANMU.x + 20 },${ boxTop + 8 },0,180)${ k === index ? '\\fad(160,0)' : '' }`
        : `\\pos(${ DANMU.x + 20 },${ boxTop + 8 })`;

      add(3, from, to, 'Shape', `{\\an7${ moveBox }${ clip }\\p1\\c${ bubbleFillAss }\\1a${ bubbleAlpha }}${ roundRect(0, 0, item.width, item.boxHeight, 10) }{\\p0}`);
      add(4, from, to, 'Danmu', `{\\an7${ moveText }${ clip }}${ item.text }`);
    }
  });

  return assDocument([
    style('Caption', fonts.text, fontSize(76, fonts), radio ? '&H001D1816' : '&H00FFFFFF', '&H00000000', false, 1, 0, 7),
    titleStyle(fonts),
    style('Tag', fonts.regular, fontSize(TAG_SIZE, fonts), '&H30FFFFFF', '&H00000000', false, 1, 0, 7),
    style('Danmu', fonts.regular, fontSize(DANMU.size, fonts), radio ? '&H00302926' : '&H00FFFFFF', '&H00000000', false, 0, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events);
}

export function subtitlesFilter(file: string, fonts: FontSet): string {
  return `subtitles=${ file }${ fonts.dir ? `:fontsdir=${ fonts.dir }` : '' }`;
}

export function segmentFilters(segments: Array<Segment>, still: boolean = false): Array<string> {
  const parts: Array<string> = [];

  segments.forEach((segment: Segment, index: number): void => {
    const range: string = `start=${ segment.start.toFixed(3) }:end=${ segment.end.toFixed(3) }`;
    const fadeOut: string = Math.max(0, segment.end - segment.start - 0.06).toFixed(3);

    if (!still) parts.push(`[0:v]trim=${ range },setpts=PTS-STARTPTS[v${ index }]`);

    parts.push(`[0:a]atrim=${ range },asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${ fadeOut }:d=0.06[a${ index }]`);
  });

  if (still) {
    const total: number = segments.reduce((sum: number, segment: Segment): number => sum + segment.end - segment.start, 0);

    parts.push(`${ segments.map((segment: Segment, index: number): string => `[a${ index }]`).join('') }concat=n=${ segments.length }:v=0:a=1[ac]`);
    parts.push(`[1:v]trim=duration=${ total.toFixed(3) },setpts=PTS-STARTPTS,scale=out_range=tv,format=yuv420p[vc]`);

    return parts;
  }

  parts.push(`${ segments.map((segment: Segment, index: number): string => `[v${ index }][a${ index }]`).join('')
  }concat=n=${ segments.length }:v=1:a=1[vc][ac]`);

  return parts;
}

export const LOUDNESS_FILTER: string = '[ac]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,asetpts=N/SR/TB[aout]';

/**
 * 合成成片的 ffmpeg 滤镜。提供 backdropInput（静态底板 PNG 的输入编号）时直接叠在底板上，否则用纯色底
 */
export function renderFilter(
  segments: Array<Segment>, fonts: FontSet, assFile: string = 'overlay.ass', still: boolean = false, backdropInput?: number
): string {
  const parts: Array<string> = segmentFilters(segments, still);

  parts.push(`[vc]fps=30,scale=${ LEFT_WIDTH }:${ H }:force_original_aspect_ratio=decrease:flags=lanczos,`
    + `pad=${ LEFT_WIDTH }:${ H }:(ow-iw)/2:(oh-ih)/2:color=0x101218,setsar=1[vs]`);

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

/* 封面候选的一帧：左边放直播画面/电台封面（608×1080），输出 [out] */
export function frameFilter(fonts: FontSet, assFile: string, time: number): string {
  return [
    `[0:v]setpts=PTS-STARTPTS,scale=${ LEFT_WIDTH }:${ H }:force_original_aspect_ratio=decrease:flags=lanczos:out_range=tv,format=yuv420p,`
      + `pad=${ LEFT_WIDTH }:${ H }:(ow-iw)/2:(oh-ih)/2:color=0x101218,setsar=1[vs]`,
    `color=c=${ BACKGROUND }:s=${ W }x${ H }:r=30[bg]`,
    `[bg][vs]overlay=0:0:shortest=1,trim=end_frame=1,setpts=${ time.toFixed(3) }/TB,${ subtitlesFilter(assFile, fonts) }[out]`
  ].join(';');
}

/* 别的封面候选：把左边 608×1080 换成新图 */
export function pictureFrameFilter(): string {
  return [
    '[0:v]scale=out_range=tv,format=yuv420p[base]',
    `[1:v]scale=${ LEFT_WIDTH }:${ H }:force_original_aspect_ratio=decrease:flags=lanczos:out_range=tv,format=yuv420p,`
      + `pad=${ LEFT_WIDTH }:${ H }:(ow-iw)/2:(oh-ih)/2:color=0x101218,setsar=1[vs]`,
    '[base][vs]overlay=0:0[out]'
  ].join(';');
}

/* 纯 Node 回退模式的改标题滤镜 */
export function retitleFilter(strip: Strip, color: { y: number; u: number; v: number }, fonts: FontSet, assFile: string): string {
  return `[0:v]split[a][b];[b]crop=${ strip.w }:${ strip.h }:${ strip.x }:${ strip.y },lutyuv=y=${ color.y }:u=${ color.u }:v=${ color.v }[p];`
    + `[a][p]overlay=${ strip.x }:${ strip.y }[c];[c]${ subtitlesFilter(assFile, fonts) }[vout]`;
}

/* 用 Canvas 局部补丁 PNG 无痕覆盖渐变/丝绒顶栏的改标题滤镜 */
export function retitlePatchFilter(x: number, y: number): string {
  return `[1:v]scale=out_range=tv,format=yuv420p[patch];[0:v][patch]overlay=${ x }:${ y }[vout]`;
}

/* ---------- 封面（纯 Node 回退版；Electron 渲染进程走 ./highlightGraphics 的 Canvas 定稿） ---------- */
export const COVER_WIDTHS: { wide: number; standard: number } = { wide: W, standard: 1_440 };

export function wordBoundaries(text: string): Array<number> {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return [];

  const out: Array<number> = [];
  let count: number = 0;

  for (const part of new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)) {
    count += Array.from(part.segment).length;
    out.push(count);
  }

  return out;
}

function splitAt(title: string, part: number): Array<string> {
  const chars: Array<string> = Array.from(title);
  const middle: number = Math.ceil(chars.length * part);
  const spots: Array<number> = [];

  chars.forEach((ch: string, index: number): void => {
    if (/[，、！？,!?\s：:]/.test(ch)) spots.push(index + 1);

    if (/[（(]/.test(ch)) spots.push(index);
  });

  let at: number | undefined = spots
    .filter((spot: number): boolean => spot > 0 && spot < chars.length && Math.abs(spot - middle) <= 3)
    .sort((a: number, b: number): number => Math.abs(a - middle) - Math.abs(b - middle))[0];

  if (at === undefined) {
    let best: number = Infinity;

    for (const boundary of wordBoundaries(title)) {
      if (boundary <= 1 || boundary >= chars.length - 1) continue;

      const cost: number = Math.abs(boundary - middle) + (/[的了地得着过吗呢吧啊儿后]/.test(chars[boundary]) ? 2 : 0);

      if (cost <= 3 && cost < best) {
        best = cost;
        at = boundary;
      }
    }
  }

  at ??= middle;

  return [chars.slice(0, at).join('').replace(/[，,\s]+$/, ''), chars.slice(at).join('').trim()].filter((row: string): boolean => row !== '');
}

export function splitTitle(title: string): Array<string> {
  if (textWidth(title) <= 7) return [title];

  if (textWidth(title) <= 20) return splitAt(title, 1 / 2);

  const [first, rest]: Array<string> = splitAt(title, 1 / 3);

  return [first, ...(rest ? splitAt(rest, 1 / 2) : [])];
}

export interface CoverInput {
  title: string;
  tag: string;
  member?: string;        // 成员本人名字（不从标题取）
  date?: string;
  radio?: boolean;
  team?: string;
  teamColor?: string;
  points: Array<string>;
  fonts: FontSet;
  width?: number;
}

/* 封面回退 ASS：去掉无意义磨砂玻璃，突出成员名、小号类型与日期、热点下对齐 */
export function buildCoverAss(input: CoverInput): string {
  const { title, tag, fonts, radio = false }: CoverInput = input;
  const width: number = input.width ?? W;
  const is43: boolean = width < W;
  const padX: number = is43 ? 52 : 80;
  const innerX: number = LEFT_WIDTH + padX;
  const innerW: number = width - LEFT_WIDTH - (padX * 2);
  const resolved: ResolvedTeam = resolveTeam(input.team, input.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const member: string = shortMemberName(input.member || tag.split(/\s+/)[0] || '');
  const date: string = input.date ?? (/\d{4}\.\d{2}\.\d{2}/.exec(tag)?.[0] ?? '');
  const points: Array<string> = input.points.filter((point: string): boolean => point.trim() !== '').slice(0, 3);
  const rows: Array<string> = splitTitle(title);
  const titleSize: number = Math.round(Math.min(fontSize(is43 ? 112 : 146, fonts), ((innerW - 36) * fonts.em) / Math.max(1, ...rows.map(textWidth))));
  const pointSize: number = Math.round(Math.min(fontSize(is43 ? 52 : 60, fonts), ((innerW - 96) * fonts.em) / Math.max(1, ...points.map(textWidth))));
  const memberSize: number = Math.round(Math.min(fontSize(is43 ? 98 : 118, fonts), ((innerW - 220) * fonts.em) / Math.max(1, textWidth(member || '成员'))));
  const events: Array<string> = [];

  function add(layer: number, styleName: string, text: string): void {
    events.push(`Dialogue: ${ layer },0:00:00.00,0:00:10.00,${ styleName },,0,0,0,,${ text }`);
  }

  const bgAss: string = radio ? '&HF6F9FA&' : hexToAss(tokens.velvetDeep);
  const headAss: string = radio ? '&HF6F9FA&' : hexToAss(tokens.mhStart);
  const headTextAss: string = radio ? DARK_INK : hexToAss(tokens.onTeam);
  const titleAss: string = radio ? DARK_INK : WHITE;
  const numAss: string = hexToAss(radio ? tokens.radioAccentDark : tokens.velvetAccent);
  const pointAss: string = radio ? '&H2E2724&' : '&HF0F0F0&';
  const kindLabel: string = radio ? 'RADIO / 电台' : 'LIVE / 直播';

  // 右侧整块底板（无磨砂玻璃）
  add(0, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ bgAss }}${ rect(LEFT_WIDTH, 0, width, H) }{\\p0}`);
  add(0, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ headAss }}${ rect(LEFT_WIDTH, 0, width, 224) }{\\p0}`);
  radio && add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ hexToAss(tokens.hex) }}${ rect(LEFT_WIDTH, 0, width, 10) }{\\p0}`);
  add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ radio ? DARK_INK : hexToAss(tokens.velvetAccent) }\\1a${ radio ? '&H00&' : '&H88&' }}${ rect(innerX, 224, width - padX, 226) }{\\p0}`);

  // 顶部：队伍名 + 超大成员名 + 右侧小号类型与日期
  if (resolved.badge) {
    add(2, 'Tag', `{\\an7\\pos(${ innerX },44)\\fs${ fontSize(26, fonts) }\\b1\\c${ headTextAss }}${ assEscape(resolved.badge) }`);
  }

  add(2, 'Member', `{\\an7\\pos(${ innerX },82)\\fs${ memberSize }\\c${ headTextAss }}${ assEscape(member) }`);
  add(2, 'Tag', `{\\an9\\pos(${ width - padX },118)\\fs${ fontSize(24, fonts) }\\b1\\c${ headTextAss }}${ assEscape(kindLabel) }`);
  date && add(2, 'Tag', `{\\an9\\pos(${ width - padX },162)\\fs${ fontSize(26, fonts) }\\c${ headTextAss }}${ assEscape(date) }`);

  // 底部热点：严格下对齐
  const pointStep: number = Math.round((pointSize * 1.18 * BASE_EM) / fonts.em) + 14;
  const pointsTop: number = points.length > 0 ? H - 56 - (points.length * pointStep) : H - 56;

  if (points.length > 0) {
    add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ radio ? DARK_INK : WHITE }\\1a&HD0&}${ rect(innerX, pointsTop - 22, width - padX, pointsTop - 21) }{\\p0}`);
    points.forEach((point: string, index: number): void => {
      const py: number = pointsTop + (index * pointStep);

      add(2, 'Num', `{\\an7\\pos(${ innerX },${ py + 4 })\\fs${ Math.round(pointSize * 0.72) }\\c${ numAss }}${ String(index + 1).padStart(2, '0') }`);
      add(2, 'Point', `{\\an7\\pos(${ innerX + 64 },${ py })\\fs${ pointSize }\\c${ pointAss }}${ assEscape(point) }`);
    });
  }

  // 中部标题（居中排在顶栏与下对齐热点之间）
  const rowStep: number = Math.round((titleSize * 0.96 * BASE_EM) / fonts.em);
  const titleBlockH: number = rows.length * rowStep;
  const titleTop: number = 226 + Math.round(((pointsTop - 248) - titleBlockH) / 2);

  !radio && add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ hexToAss(tokens.velvetAccent) }}${ rect(innerX, titleTop + 8, innerX + 4, titleTop + titleBlockH - 8) }{\\p0}`);
  rows.forEach((row: string, idx: number): void => {
    add(2, 'Title', `{\\an7\\pos(${ innerX + (radio ? 0 : 28) },${ titleTop + (idx * rowStep) })\\fs${ titleSize }\\c${ titleAss }}${ assEscape(row) }`);
  });

  return assDocument([
    style('Title', fonts.heavy, 120, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 1, 0, 7),
    style('Member', fonts.heavy, 100, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 1, 0, 7),
    style('Point', fonts.regular, 60, '&H00FFFFFF', '&H00000000', true, 1, 0, 7),
    style('Num', fonts.heavy, 44, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 0, 0, 7),
    style('Tag', fonts.text, fontSize(30, fonts), '&H00FFFFFF', '&H00000000', false, 1, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events, width);
}

/* 回退版封面滤镜：不再加无意义磨砂玻璃，直接保留左侧画面 + 压上 ASS 排版 */
export function coverFilter(fonts: FontSet, assFile: string = 'cover.ass', width: number = W): string {
  return `[0:v]crop=${ width }:${ H }:0:0,${ subtitlesFilter(assFile, fonts) }[out]`;
}
