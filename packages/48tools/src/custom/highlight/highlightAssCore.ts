import { toOut } from './highlightCut';
import type { CaptionLine, DanmuLine, Segment } from './highlightTypes';

/**
 * 录播自动切片的画面：和「长什么样」无关的那一半。成片是 1920×1080 的横屏，左边 608×1080 放直播画面 / 电台封面，右边放文字。
 * 这里是尺寸、估字宽和分行、字幕和弹幕各在什么时候出现、ASS 文件的骨架、ffmpeg 的滤镜。
 * 标题、字幕、弹幕、封面具体怎么排、用什么颜色，是可以换的模块（LiveStyle，见 ../basic/README.md），从 ./highlightAss 调用。
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
const BACKGROUND: string = '0x101218';
const WHITE: string = '&HFFFFFF&';
const YELLOW: string = '&H4DE1FF&';    // ASS 的颜色是 BBGGRR
const CAPTION_WIDTH: number = 1_110;   // 左对齐一行字幕最宽
const CAPTION_BREAK: number = 13;      // 超过这么多个字就分两行

export const BASE_EM: number = 1.448;         // 下面的字号是按思源黑体定的，换字体时按 em 的比例调整

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

/* 成片上的一块地方（像素，都是偶数） */
export interface Strip {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoAssInput {
  title: string;               // 空的不写（封面候选）
  tag: string;                 // 回退模式右上角的小字
  lines: Array<CaptionLine>;
  segments: Array<Segment>;
  total: number;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
  radio?: boolean;             // 电台
  team?: string;
  teamColor?: string;
  backdrop?: boolean;          // true：底图已经另外画好了（见 ./highlightGraphicsTypes），这里只画会动的：字幕、弹幕
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

/* ---------- 封面 ---------- */
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

/* 封面的滤镜：保留左边的画面，压上封面的字幕文件 */
export function coverFilter(fonts: FontSet, assFile: string = 'cover.ass', width: number = W): string {
  return `[0:v]crop=${ width }:${ H }:0:0,${ subtitlesFilter(assFile, fonts) }[out]`;
}

export interface TitleAssInput {
  title: string;
  tag: string;
  total: number;
  fonts: FontSet;
  radio?: boolean;
  team?: string;
  teamColor?: string;
}

/* 直播、电台切片的画面长什么样：可以换的模块（程序自带的在 ../basic/highlightLiveStyle） */
export interface LiveStyle {
  titleStrip(tag: string): Strip;                 // 成片上标题占的那一条：渲染完改标题时只重画这一条
  buildTitleAss(input: TitleAssInput): string;    // 只有标题的字幕文件（改标题用），位置要和 titleStrip 对上
  buildVideoAss(input: VideoAssInput): string;    // 成片的字幕文件：标题、她说的话、弹幕
  buildCoverAss(input: CoverInput): string;       // 封面的字幕文件（压在封面那一帧上）
}
