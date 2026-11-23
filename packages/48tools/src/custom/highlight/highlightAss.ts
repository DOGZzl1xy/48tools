import { toOut } from './highlightCut';
import type { CaptionLine, DanmuLine, Segment } from './highlightTypes';

/**
 * 录播自动切片的画面排版。成片是 1920×1080 的横屏：
 *   左边：直播画面（竖屏，缩到 608×1080）
 *   右上：标题，和她正在说的那句话（重点词加粗变黄）
 *   右下：弹幕，新的从下面出现，旧的往上挪
 * 文字都用 ASS 字幕画（ffmpeg 的 subtitles 滤镜），这里生成字幕文件的内容和 ffmpeg 的滤镜参数。
 * 封面：成片里的一帧，右边盖一块磨砂玻璃，写标题和几个看点。出两个比例：16:9（1920×1080）和 4:3（1440×1080，取成片左边的部分）。
 * 都是纯计算，方便测试；真正跑 ffmpeg 的在 ./highlightPipeline。
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
const CENTER_X: number = LEFT_WIDTH + (RIGHT_W / 2);
const BACKGROUND: string = '0x2B4B99';
const WHITE: string = '&HFFFFFF&';
const YELLOW: string = '&H4DE1FF&';    // ASS 的颜色是 BBGGRR
const NICKNAME: string = '&HFFD0A6&';
const TITLE_Y: number = 96;
const TITLE_SIZE: number = 66; // 成片上标题和右上角小字的大小（像素）
const TAG_SIZE: number = 34;
const CAPTION_Y: number = 330;
const PANEL: { x1: number; y1: number; x2: number; y2: number } = { x1: LEFT_WIDTH + 44, y1: 566, x2: W - 44, y2: H - 40 };
const DANMU: { size: number; lineHeight: number; gap: number; maxUnits: number; x: number; bottom: number; top: number } = {
  size: 42,
  lineHeight: 54,
  gap: 16,
  maxUnits: 38,
  x: PANEL.x1 + 24,
  bottom: PANEL.y2 - 18,
  top: PANEL.y1 + 66
};
const CAPTION_WIDTH: number = 1_180;   // 一行字幕最宽
const CAPTION_BREAK: number = 14;      // 超过这么多个字就分两行
const BASE_EM: number = 1.448;         // 下面的字号是按思源黑体定的，换字体时按 em 的比例调整

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

/* 一个字占多宽：英文数字算半个多一点，其余算一个 */
/* 一个字大概占几个汉字宽（排版时估算用）。英文按字母分开估：以前一律 0.56，加粗字体里的大写字母（尤其 M、W）宽得多，
   「听MC正好【暖和睡】」这种封面上后面的字压到了前面的字上（2026-11-23） */
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

/**
 * 一句字幕：重点词加粗变色；太长就在靠中间的标点处分成两行；字号按最宽的一行定
 * @param { string } [emphasisColor] - 重点词的颜色（ASS 的写法）；不给用黄色。公演切片用队伍的颜色
 */
export function captionText(
  line: Pick<CaptionLine, 'text' | 'emphasis'>, fonts: FontSet, emphasisColor: string = YELLOW
): { text: string; size: number } {
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

      // 离中间近的好；标点后面断最好；不要把一个重点词断开
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
  const widest: number = Math.max(1, ...rows.map(textWidth));
  const size: number = Math.round(Math.min(fontSize(120, fonts), (CAPTION_WIDTH * fonts.em) / widest));
  let text: string = '';
  let on: boolean = false;

  chars.forEach((ch: string, index: number): void => {
    if (index === breakAt) text += '\\N';

    if (bold[index] !== on) {
      on = bold[index];
      text += on ? `{${ heavyTag(fonts) }\\c${ emphasisColor }}` : `{\\fn${ fonts.text }\\b0\\c${ WHITE }}`;
    }

    text += assEscape(ch);
  });

  return { text, size };
}

export interface PlacedDanmu extends DanmuLine {
  at: number; // 在成片里出现的时间
}

/**
 * 弹幕放到成片的时间上
 * @param { Array<DanmuLine> } danmu - 整场录播的弹幕
 * @param { number } clipStart - 片段在录播里开始的时间
 * @param { Array<Segment> } segments - 成片由片段里的哪几段拼成
 * @param { number } total - 成片的长度
 */
export function placeDanmu(danmu: Array<DanmuLine>, clipStart: number, segments: Array<Segment>, total: number): Array<PlacedDanmu> {
  if (segments.length === 0) return [];

  const firstAbs: number = clipStart + segments[0].start;
  // 开头先放上片段开始前最近的几条，免得弹幕区是空的
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

    // 落在被剪掉的地方：如果紧跟在留下的一段后面（多半是对那段话的反应），放到接下来那一段的开头
    const prev: Segment | undefined = segments.findLast((segment: Segment): boolean => segment.end < time);
    const next: Segment | undefined = segments.find((segment: Segment): boolean => segment.start > time);

    if (prev && next && time - prev.end < 12) items.push({ ...item, at: next.out + 0.2 });
  }

  items.sort((a: PlacedDanmu, b: PlacedDanmu): number => a.at - b.at);

  // 同一时刻挤在一起的稍微错开
  for (let i: number = 1; i < items.length; i++) {
    if (items[i].at > 0 && items[i].at - items[i - 1].at < 0.35) items[i].at = items[i - 1].at + 0.35;
  }

  return items.filter((item: PlacedDanmu): boolean => item.at < total);
}

/* 一条弹幕：昵称一种颜色、内容白色，最多两行，再长用省略号 */
function danmuRows(item: DanmuLine): { text: string; height: number } {
  const nickname: string = Array.from(item.nickname).slice(0, 14).join('');
  const nicknameLength: number = Array.from(nickname).length + 1;
  const rows: Array<Array<string>> = [[]];
  let width: number = 0;

  for (const ch of Array.from(`${ nickname }：${ item.message }`)) {
    const w: number = charWidth(ch);

    if (width + w > DANMU.maxUnits) {
      if (rows.length === 2) {
        rows[1].splice(-1, 1, '…');
        break;
      }

      rows.push([]);
      width = 0;
    }

    rows[rows.length - 1].push(ch);
    width += w;
  }

  let count: number = 0;
  const text: string = rows.map((row: Array<string>): string => {
    let part: string = '';

    for (const ch of row) {
      if (count === 0) part += `{\\c${ NICKNAME }}`;

      if (count === nicknameLength) part += `{\\c${ WHITE }}`;

      part += assEscape(ch);
      count++;
    }

    return part;
  }).join('\\N');

  return { text, height: (rows.length * DANMU.lineHeight) + DANMU.gap };
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

/* 一个样式：名字、字体、字号、颜色、阴影的颜色、是否加粗、字距、阴影大小、对齐 */
export function style(
  name: string, font: string, size: number, color: string, back: string, bold: boolean, spacing: number, shadow: number, align: number
): string {
  return `Style: ${ name },${ font },${ size },${ color },&H00FFFFFF,&H00301A0A,${ back },${ bold ? -1 : 0 },0,0,0,100,100,${
    spacing },0,1,0,${ shadow },${ align },0,0,0,1`;
}

export interface VideoAssInput {
  title: string;
  tag: string;                 // 右上角的小字：成员和日期
  lines: Array<CaptionLine>;   // 片段里的全部句子（已经修正过时间）
  segments: Array<Segment>;
  total: number;
  danmu: Array<PlacedDanmu>;
  fonts: FontSet;
}

/* 成片的字幕文件：标题、她说的话、弹幕 */
export function buildVideoAss(input: VideoAssInput): string {
  const { title, tag, lines, segments, total, danmu, fonts }: VideoAssInput = input;
  const events: Array<string> = [];

  function add(layer: number, start: number, end: number, styleName: string, text: string): void {
    if (end - start < 0.02) return;

    events.push(`Dialogue: ${ layer },${ assTime(start) },${ assTime(end) },${ styleName },,0,0,0,,${ text }`);
  }

  // 固定的东西：弹幕区的底、标题前的色条、标题、成员和日期
  add(0, 0, total, 'Shape', `{\\an7\\pos(0,0)\\p1\\c&H000000&\\1a&HB8&}${ rect(PANEL.x1, PANEL.y1, PANEL.x2, PANEL.y2) }{\\p0}`);
  add(0, 0, total, 'Shape',
    `{\\an7\\pos(0,0)\\p1\\c${ YELLOW }}${ rect(LEFT_WIDTH + 44, TITLE_Y - 30, LEFT_WIDTH + 54, TITLE_Y + 30) }{\\p0}`);
  // 标题和右边的成员、日期在同一行：标题长了就缩小，不压到右边的字（11 个字以内是原来的大小）
  const titleLeft: number = LEFT_WIDTH + 76;
  const titleRoom: number = W - 48 - (textWidth(tag) * TAG_SIZE) - 48 - titleLeft;
  const titleSize: number = Math.min(TITLE_SIZE, Math.floor(titleRoom / Math.max(1, textWidth(title))));

  add(1, 0, total, 'Title', `{\\an4\\pos(${ titleLeft },${ TITLE_Y })\\fs${ fontSize(titleSize, fonts) }}${ assEscape(title) }`);
  add(1, 0, total, 'Tag', `{\\an6\\pos(${ W - 48 },${ TITLE_Y })}${ assEscape(tag) }`);
  add(1, 0, total, 'Tag', `{\\an7\\pos(${ PANEL.x1 + 24 },${ PANEL.y1 + 14 })}弹幕`);

  // 她说的话：一句显示到下一句开始；后面没有话了就多停一会儿
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

    add(2, start, Math.min(end, total), 'Caption', `{\\an5\\pos(${ CENTER_X },${ CAPTION_Y })\\fs${ caption.size }\\fad(80,0)}${ caption.text }`);
  });

  // 弹幕：新的从下面出现，旧的往上挪，挪出框就不画
  const laid: Array<PlacedDanmu & { text: string; height: number }> = danmu.map(
    (item: PlacedDanmu): PlacedDanmu & { text: string; height: number } => ({ ...item, ...danmuRows(item) }));
  const clip: string = `\\clip(${ PANEL.x1 },${ DANMU.top },${ PANEL.x2 },${ PANEL.y2 })`;

  laid.forEach((item: PlacedDanmu & { text: string; height: number }, index: number): void => {
    let y: number = DANMU.bottom;

    for (let k: number = index; k < laid.length; k++) {
      const from: number = laid[k].at;
      const to: number = k + 1 < laid.length ? laid[k + 1].at : total;

      if (k === index) {
        const appear: string = from > 0
          ? `\\move(${ DANMU.x },${ y + 24 },${ DANMU.x },${ y },0,180)\\fad(160,0)`
          : `\\pos(${ DANMU.x },${ y })`;

        add(3, from, to, 'Danmu', `{\\an1${ appear }${ clip }}${ item.text }`);
        continue;
      }

      const prevY: number = y;

      if (prevY < DANMU.top - 10) break;

      y -= laid[k].height;

      const moving: string = from > 0 ? `\\move(${ DANMU.x },${ prevY },${ DANMU.x },${ y },0,180)` : `\\pos(${ DANMU.x },${ y })`;

      add(3, from, to, 'Danmu', `{\\an1${ moving }${ clip }}${ item.text }`);
    }
  });

  return assDocument([
    style('Caption', fonts.text, fontSize(76, fonts), '&H00FFFFFF', '&H66000000', false, 2, 3, 5),
    style('Title', fonts.heavy, fontSize(TITLE_SIZE, fonts), '&H00FFFFFF', '&H00000000', fonts.heavyBold, 1, 0, 4),
    style('Tag', fonts.regular, fontSize(TAG_SIZE, fonts), '&H30FFFFFF', '&H00000000', false, 1, 0, 7),
    style('Danmu', fonts.regular, fontSize(DANMU.size, fonts), '&H00FFFFFF', '&H00000000', false, 0, 0, 1),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events);
}

export function subtitlesFilter(file: string, fonts: FontSet): string {
  return `subtitles=${ file }${ fonts.dir ? `:fontsdir=${ fonts.dir }` : '' }`;
}

/**
 * 合成成片的 ffmpeg 滤镜：按 segments 剪出几段拼起来，缩放后放到左边，压上字幕；声音统一响度。
 * 输入是已经定位到片段开头的原片，输出是 [vout] 和 [aout]
 */
/**
 * 按 segments 剪出几段拼起来：输出 [vc] 和 [ac]（两种排版共用）。
 * still：电台的录音没有画面，画面是第二个输入（一张图一直循环），只剪声音，画面截成拼完的长度
 */
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
    // jpg 是全范围的颜色（pc），转成和直播画面一样的标准范围（tv），不然成片标成 yuvj420p，有的播放器颜色会偏
    parts.push(`[1:v]trim=duration=${ total.toFixed(3) },setpts=PTS-STARTPTS,scale=out_range=tv,format=yuv420p[vc]`);

    return parts;
  }

  parts.push(`${ segments.map((segment: Segment, index: number): string => `[v${ index }][a${ index }]`).join('')
  }concat=n=${ segments.length }:v=1:a=1[vc][ac]`);

  return parts;
}

/* 响度拉齐（两种排版共用）。loudnorm 开头两三秒输出的时间戳是乱的（ffmpeg 9 实测：前 0.6 秒里挤了 2.4 秒的声音，后面跟着 2.4 秒的空档），
   播放时开头卡顿、之后音画不同步。它输出的采样本身是完整、连续的，所以在后面按采样数重新算一遍时间戳就对了 */
export const LOUDNESS_FILTER: string = '[ac]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,asetpts=N/SR/TB[aout]';

export function renderFilter(segments: Array<Segment>, fonts: FontSet, assFile: string = 'overlay.ass', still: boolean = false): string {
  const parts: Array<string> = segmentFilters(segments, still);

  // 横屏的录屏直播也放得下：按比例缩进 608×1080，空的地方填深色
  parts.push(`[vc]fps=30,scale=${ LEFT_WIDTH }:${ H }:force_original_aspect_ratio=decrease:flags=lanczos,`
    + `pad=${ LEFT_WIDTH }:${ H }:(ow-iw)/2:(oh-ih)/2:color=0x1B2030,setsar=1[vs]`);
  parts.push(`color=c=${ BACKGROUND }:s=${ W }x${ H }:r=30[bg]`);
  parts.push('[bg][vs]overlay=0:0:shortest=1[base]');
  parts.push(`[base]${ subtitlesFilter(assFile, fonts) }[vout]`);
  parts.push(LOUDNESS_FILTER);

  return parts.join(';');
}

/* ---------- 封面 ---------- */
export const COVER_WIDTHS: { wide: number; standard: number } = { wide: W, standard: 1_440 }; // 16:9 和 4:3，高度都是 1080

interface Card {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/* 磨砂玻璃的位置：盖住直播画面右边的整块，四周留一点边 */
function coverCard(width: number): Card {
  return { x: LEFT_WIDTH + 32, y: 40, w: width - LEFT_WIDTH - 64, h: H - 80, r: 48 };
}

/* 词和词之间的位置（第几个字后面），用系统自带的中文分词；没有分词功能时返回空数组 */
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

/**
 * 封面上的标题：超过 7 个字分两行，尽量在标点后面断；中间附近没有标点时在词和词之间断
 * （以前在正中间硬断，出现过「真到自己这 / 儿也没招」把「这儿」拆开，2026-11-23 用户看到的），第二行不以「的」「了」这类字开头
 */
export function splitTitle(title: string): Array<string> {
  const chars: Array<string> = Array.from(title);

  if (textWidth(title) <= 7) return [title];

  const middle: number = Math.ceil(chars.length / 2);
  const spots: Array<number> = []; // 可以断开的位置：标点后面、左括号前面（「北大不比北芭差」/「（bushi）」）

  chars.forEach((ch: string, index: number): void => {
    if (/[，、！？,!?\s：:]/.test(ch)) spots.push(index + 1);

    if (/[（(]/.test(ch)) spots.push(index);
  });

  // 取离正中间最近的那个（差得不超过 3 个字）
  let at: number | undefined = spots
    .filter((spot: number): boolean => spot > 0 && spot < chars.length && Math.abs(spot - middle) <= 3)
    .sort((a: number, b: number): number => Math.abs(a - middle) - Math.abs(b - middle))[0];

  // 没有标点：在离正中间最近的词边界断（一样近时取靠前的，第一行长一点更稳）；分不了词就在正中间断
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

export interface CoverInput {
  title: string;
  tag: string;            // 小字：成员、日期
  points: Array<string>;  // 1 ~ 3 个看点（按需要，2026-11-23 用户定的不用凑满三个）
  fonts: FontSet;
  width?: number;         // 封面的宽度（见 COVER_WIDTHS），默认 16:9
}

/* 封面上的字（磨砂玻璃上的淡白色和亮边也在这里画） */
export function buildCoverAss(input: CoverInput): string {
  const { title, tag, fonts }: CoverInput = input;
  const width: number = input.width ?? W;
  const CARD: Card = coverCard(width);
  const padding: number = width < W ? 52 : 72; // 窄的封面里字要尽量大，两边少留一点
  const points: Array<string> = input.points.filter((point: string): boolean => point.trim() !== '').slice(0, 3);
  const innerX: number = CARD.x + padding;
  const innerW: number = CARD.w - (padding * 2);
  const rows: Array<string> = splitTitle(title);
  const titleSize: number = Math.round(Math.min(fontSize(230, fonts), (innerW * fonts.em) / Math.max(1, ...rows.map(textWidth))));
  const pointSize: number = Math.round(Math.min(fontSize(104, fonts), ((innerW - 120) * fonts.em) / Math.max(1, ...points.map(textWidth))));
  const events: Array<string> = [];
  let y: number = CARD.y + 84;

  function add(layer: number, styleName: string, text: string): void {
    events.push(`Dialogue: ${ layer },0:00:00.00,0:00:10.00,${ styleName },,0,0,0,,${ text }`);
  }

  add(0, 'Shape', `{\\an7\\pos(0,0)\\p1\\c&HFFFFFF&\\1a&HD2&\\bord2\\3c&HFFFFFF&\\3a&H90&}${
    roundRect(CARD.x, CARD.y, CARD.w, CARD.h, CARD.r) }{\\p0}`);
  add(1, 'Tag', `{\\an7\\pos(${ innerX },${ y })}${ assEscape(tag) }`);
  y += 78;

  for (const row of rows) {
    add(2, 'Title', `{\\an7\\pos(${ innerX },${ y })\\fs${ titleSize }}${ assEscape(row) }`);
    y += Math.round((titleSize * 0.86 * BASE_EM) / fonts.em);
  }

  y += 44;
  add(1, 'Shape', `{\\an7\\pos(0,0)\\p1\\c${ YELLOW }}${ rect(innerX, y, innerX + 150, y + 10) }{\\p0}`);
  y += 58;

  const pointGap: number = Math.min(
    Math.round((pointSize * 1.12 * BASE_EM) / fonts.em),
    Math.floor((CARD.y + CARD.h - 60 - y) / Math.max(1, points.length)));

  points.forEach((point: string, index: number): void => {
    add(2, 'Num', `{\\an7\\pos(${ innerX },${ y + Math.round(pointSize * 0.1) })\\fs${ Math.round(pointSize * 0.8) }}${
      String(index + 1).padStart(2, '0') }`);
    add(2, 'Point', `{\\an7\\pos(${ innerX + Math.round((pointSize * 1.05 * BASE_EM) / fonts.em) },${ y })\\fs${ pointSize }}${
      assEscape(point) }`);
    y += pointGap;
  });

  return assDocument([
    style('Title', fonts.heavy, 120, '&H00FFFFFF', '&H70201008', fonts.heavyBold, 2, 5, 7),
    style('Point', fonts.regular, 70, '&H00FFFFFF', '&H80201008', true, 1, 3, 7),
    style('Num', fonts.heavy, 56, '&H004DE1FF', '&H80201008', fonts.heavyBold, 0, 3, 7),
    style('Tag', fonts.text, fontSize(46, fonts), '&H10FFFFFF', '&H80201008', false, 2, 2, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events, width);
}

/**
 * 做封面的 ffmpeg 滤镜：右边整块先轻轻糊一点，再盖一块圆角的磨砂玻璃（糊得更厉害），最后压上字。
 * 输入是成片里的一帧，输出是 [out]。width 比成片窄时（4:3）只取成片左边的部分
 */
export function coverFilter(fonts: FontSet, assFile: string = 'cover.ass', width: number = W): string {
  const { x, y, w, h, r }: Card = coverCard(width);
  const outside: (cx: number, cy: number) => string = (cx: number, cy: number): string => `gt(hypot(X-${ cx },Y-${ cy }),${ r })`;
  // 圆角以外的四个小角透明
  const alpha: string = `255*(1-(lt(X,${ r })*lt(Y,${ r })*${ outside(r, r) }+gt(X,${ w - r })*lt(Y,${ r })*${ outside(w - r, r) }`
    + `+lt(X,${ r })*gt(Y,${ h - r })*${ outside(r, h - r) }+gt(X,${ w - r })*gt(Y,${ h - r })*${ outside(w - r, h - r) }))`;

  return [
    `[0:v]crop=${ width }:${ H }:0:0,split=3[a1][a2][b]`,
    `[a1]crop=${ width - LEFT_WIDTH }:${ H }:${ LEFT_WIDTH }:0,gblur=sigma=5[soft]`,
    `[a2][soft]overlay=${ LEFT_WIDTH }:0[bg]`,
    `[b]crop=${ w }:${ h }:${ x }:${ y },gblur=sigma=34,eq=brightness=0.03:saturation=1.2,format=rgba,`
      + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${ alpha }'[glass]`,
    `[bg][glass]overlay=${ x }:${ y }[v1]`,
    `[v1]${ subtitlesFilter(assFile, fonts) }[out]`
  ].join(';');
}
