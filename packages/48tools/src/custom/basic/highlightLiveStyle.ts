import { toOut } from '../highlight/highlightCut';
import {
  VIDEO_SIZE, LEFT_WIDTH, BASE_EM, assTime, assEscape, charWidth, textWidth, fontSize, rect, captionText, assDocument, style, splitTitle,
  type CaptionLayout, type CoverInput, type FontSet, type LiveStyle, type PlacedDanmu, type Strip, type TitleAssInput, type VideoAssInput
} from '../highlight/highlightAssCore';
import type { CaptionLine, Segment } from '../highlight/highlightTypes';

/**
 * 直播、电台切片的画面：程序自带的默认排版。黑底白字，没有配色和装饰：
 *   成片：右边最上面一行标题，下面一行小字（谁、哪天），中间是她说的话，最下面是几条弹幕（只有内容）
 *   封面：右边一块黑底，上面一行小字，中间是标题，下面是看点
 * 想用自己的排版：照 ../highlight/highlightAssCore 的 LiveStyle 做成内容包里的 liveStyle 模块，见 ./README.md。
 */
const W: number = VIDEO_SIZE.width;
const H: number = VIDEO_SIZE.height;
const X: number = LEFT_WIDTH + 56;      // 右边的字从这里开始
const ROOM: number = W - X - 56;        // 一行最宽
const TITLE_Y: number = 64;
const TITLE_SIZE: number = 44;
const GRAY: string = '&HAAAAAA&';
const DANMU: { size: number; row: number; bottom: number; rows: number; units: number } = { size: 30, row: 46, bottom: H - 40, rows: 7, units: 36 };

function titleText(title: string, fonts: FontSet): string {
  const size: number = Math.min(TITLE_SIZE, Math.floor(ROOM / Math.max(1, textWidth(title))));

  return `{\\an4\\pos(${ X },${ TITLE_Y })\\fs${ fontSize(size, fonts) }}${ assEscape(title) }`;
}

function titleStyle(fonts: FontSet): string {
  return style('Title', fonts.heavy, fontSize(TITLE_SIZE, fonts), '&H00FFFFFF', '&H00000000', fonts.heavyBold, 0, 0, 4);
}

/* 标题占的那一条（都是偶数） */
function titleStrip(): Strip {
  return { x: X - 8, y: TITLE_Y - 36, w: ROOM + 16, h: 72 };
}

function buildTitleAss(input: TitleAssInput): string {
  return assDocument([titleStyle(input.fonts)], [
    `Dialogue: 1,${ assTime(0) },${ assTime(input.total) },Title,,0,0,0,,${ titleText(input.title, input.fonts) }`
  ]);
}

/* 弹幕只留内容，太长的截断 */
function danmuText(message: string): string {
  let out: string = '';
  let units: number = 0;

  for (const ch of Array.from(message)) {
    if (units + charWidth(ch) > DANMU.units) return `${ out }…`;

    out += ch;
    units += charWidth(ch);
  }

  return out;
}

function buildVideoAss(input: VideoAssInput): string {
  const { title, tag, lines, segments, total, danmu, fonts }: VideoAssInput = input;
  const events: Array<string> = [];

  function add(layer: number, start: number, end: number, styleName: string, text: string): void {
    if (end - start < 0.02) return;

    events.push(`Dialogue: ${ layer },${ assTime(start) },${ assTime(end) },${ styleName },,0,0,0,,${ text }`);
  }

  title && add(1, 0, total, 'Title', titleText(title, fonts));
  add(1, 0, total, 'Small', `{\\an7\\pos(${ X },${ TITLE_Y + 40 })}${ assEscape(tag) }`);

  // 她说的话：一句出来，下一句来了就换掉
  const kept: Array<CaptionLine> = lines.filter((line: CaptionLine): boolean => line.keep);

  kept.forEach((line: CaptionLine, index: number): void => {
    const start: number | null = toOut(segments, line.start);
    const segment: Segment | undefined = segments.find((item: Segment): boolean => line.start >= item.start && line.start <= item.end);

    if (start === null || !segment || line.text.trim() === '') return;

    const next: CaptionLine | undefined = kept[index + 1];
    const nextStart: number | null = next ? toOut(segments, next.start) : null;
    let end: number = segment.out + (Math.min(line.end, segment.end) - segment.start) + 0.9;

    if (nextStart !== null && nextStart > start) end = Math.min(Math.max(end, Math.min(nextStart, end + 0.8)), nextStart);

    const caption: CaptionLayout = captionText(line, fonts, '&HFFFFFF&', '&HFFFFFF&', ROOM);

    add(2, start, Math.min(end, total), 'Caption', `{\\an4\\pos(${ X },340)\\fs${ Math.min(caption.size, fontSize(72, fonts)) }}${ caption.text }`);
  });

  // 弹幕：新的在最下面，旧的往上排，最多留几条
  danmu.forEach((item: PlacedDanmu, index: number): void => {
    for (let k: number = index; k < danmu.length && k - index < DANMU.rows; k++) {
      const to: number = k + 1 < danmu.length ? danmu[k + 1].at : total;

      add(3, danmu[k].at, to, 'Danmu', `{\\an1\\pos(${ X },${ DANMU.bottom - ((k - index) * DANMU.row) })}${ assEscape(danmuText(item.message)) }`);
    }
  });

  return assDocument([
    style('Caption', fonts.text, fontSize(72, fonts), '&H00FFFFFF', '&H00000000', false, 0, 0, 4),
    titleStyle(fonts),
    style('Small', fonts.regular, fontSize(26, fonts), `&H00${ GRAY.slice(2, 8) }`, '&H00000000', false, 0, 0, 7),
    style('Danmu', fonts.regular, fontSize(DANMU.size, fonts), '&H00DDDDDD', '&H00000000', false, 0, 0, 1)
  ], events);
}

function buildCoverAss(input: CoverInput): string {
  const { title, tag, fonts }: CoverInput = input;
  const width: number = input.width ?? W;
  const pad: number = 64;
  const x: number = LEFT_WIDTH + pad;
  const room: number = width - x - pad;
  const rows: Array<string> = splitTitle(title);
  const size: number = Math.round(Math.min(fontSize(width < W ? 100 : 120, fonts), (room * fonts.em) / Math.max(1, ...rows.map(textWidth))));
  const step: number = Math.round((size * 0.96 * BASE_EM) / fonts.em);
  const points: Array<string> = input.points.map((point: string): string => point.trim()).filter((point: string): boolean => point !== '').slice(0, 3);
  const pointSize: number = Math.round(Math.min(fontSize(44, fonts), (room * fonts.em) / Math.max(1, ...points.map(textWidth))));
  const pointStep: number = Math.round((pointSize * 1.3 * BASE_EM) / fonts.em);
  const pointsTop: number = H - pad - (points.length * pointStep);
  const top: number = Math.max(pad + 80, Math.round((pointsTop - (rows.length * step)) / 2));
  const events: Array<string> = [
    // 封面那一帧的右边可能有当时的字幕和弹幕：先盖成黑的
    `{\\an7\\pos(0,0)\\p1\\c&H000000&}${ rect(LEFT_WIDTH, 0, width, H) }{\\p0}`,
    `{\\an7\\pos(${ x },${ pad })\\fs${ fontSize(30, fonts) }\\c${ GRAY }}${ assEscape(tag) }`,
    ...rows.map((row: string, index: number): string => `{\\an7\\pos(${ x },${ top + (index * step) })\\fs${ size }}${ assEscape(row) }`),
    // 看点：标题下面几行小一号的字
    ...points.map((point: string, index: number): string => `{\\an7\\pos(${ x },${ pointsTop + (index * pointStep) })\\fs${ pointSize }\\b0\\c${ GRAY }}${ assEscape(point) }`)
  ].map((text: string, index: number): string => `Dialogue: ${ index === 0 ? 0 : 1 },0:00:00.00,0:00:10.00,${ index === 0 ? 'Shape' : 'Title' },,0,0,0,,${ text }`);

  return assDocument([
    style('Title', fonts.heavy, 120, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 0, 0, 7),
    style('Shape', 'Arial', 20, '&H00FFFFFF', '&H00000000', false, 0, 0, 7)
  ], events, width);
}

export const liveStyle: LiveStyle = { titleStrip, buildTitleAss, buildVideoAss, buildCoverAss };
