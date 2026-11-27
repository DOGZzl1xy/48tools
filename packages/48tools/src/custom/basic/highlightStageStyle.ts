import { toOut } from '../highlight/highlightCut';
import {
  VIDEO_SIZE, assTime, assEscape, textWidth, fontSize, captionText, assDocument, style,
  type CaptionLayout, type FontSet, type PlacedDanmu, type Strip
} from '../highlight/highlightAssCore';
import {
  STAGE_VIDEO, fitText, stageTitleRows, coverSegments,
  type StageCoverInput, type StageStyle, type StageTitleAssInput, type StageVideoAssInput
} from '../highlight/highlightStageCore';
import type { CaptionLine, Segment } from '../highlight/highlightTypes';

/**
 * 公演切片的画面：程序自带的默认排版。黑底白字，没有配色和装饰：
 *   成片：右边一列从上到下是公演名、日期、标题、几条弹幕（只有内容），画面下面是她们说的话
 *   封面：整张画面，右上角公演名和日期，左下角标题
 * 想用自己的排版：照 ../highlight/highlightStageCore 的 StageStyle 做成内容包里的 stageStyle 模块，见 ./README.md。
 */
const W: number = VIDEO_SIZE.width;
const H: number = VIDEO_SIZE.height;
const X: number = STAGE_VIDEO.width + 36;   // 右边一列的字从这里开始
const ROOM: number = W - X - 36;
const TITLE_TOP: number = 150;
const GRAY: string = '&HAAAAAA&';
const SHADOW: string = '\\shad3\\4c&H000000&\\4a&H60&';
const DANMU: { size: number; row: number; bottom: number; top: number } = { size: 27, row: 44, bottom: H - 40, top: 330 };

function fit(text: string, largest: number, room: number, fonts: FontSet): number {
  return Math.round(Math.min(fontSize(largest, fonts), (room * fonts.em) / Math.max(1, textWidth(text))));
}

function sideStyle(fonts: FontSet): string {
  return style('Side', fonts.text, fontSize(30, fonts), '&H00FFFFFF', '&H00000000', false, 0, 0, 7);
}

function titleEvents(title: string, total: number, fonts: FontSet): Array<string> {
  const rows: Array<string> = stageTitleRows(title);
  const size: number = Math.min(...rows.map((row: string): number => fit(row, 40, ROOM, fonts)));

  return rows.map((row: string, index: number): string => `Dialogue: 2,${ assTime(0) },${ assTime(total) },Side,,0,0,0,,{\\an7\\pos(${ X },${
    TITLE_TOP + (index * Math.round(size * 1.24)) })\\fs${ size }\\b1}${ assEscape(row) }`);
}

/* 标题占的那一块（都是偶数） */
function stageTitleStrip(): Strip {
  return { x: STAGE_VIDEO.width + 8, y: TITLE_TOP - 14, w: W - STAGE_VIDEO.width - 8, h: 150 };
}

function buildStageTitleAss(input: StageTitleAssInput): string {
  return assDocument([sideStyle(input.fonts)], titleEvents(input.title, input.total, input.fonts));
}

function buildStageVideoAss(input: StageVideoAssInput): string {
  const { stage, title, lines, segments, total, danmu, fonts }: StageVideoAssInput = input;
  const events: Array<string> = [];

  function add(layer: number, start: number, end: number, styleName: string, text: string): void {
    if (end - start < 0.02) return;

    events.push(`Dialogue: ${ layer },${ assTime(start) },${ assTime(end) },${ styleName },,0,0,0,,${ text }`);
  }

  add(1, 0, total, 'Side', `{\\an7\\pos(${ X },40)\\fs${ fit(stage.show, 30, ROOM, fonts) }}${ assEscape(stage.show) }`);
  add(1, 0, total, 'Side', `{\\an7\\pos(${ X },92)\\fs${ fontSize(24, fonts) }\\c${ GRAY }}${ assEscape(stage.date) }`);
  title && events.push(...titleEvents(title, total, fonts));

  // 她们说的话：画面下面居中
  const kept: Array<CaptionLine> = lines.filter((line: CaptionLine): boolean => line.keep);

  kept.forEach((line: CaptionLine, index: number): void => {
    const start: number | null = toOut(segments, line.start);
    const segment: Segment | undefined = segments.find((item: Segment): boolean => line.start >= item.start && line.start <= item.end);

    if (start === null || !segment || line.text.trim() === '') return;

    const next: CaptionLine | undefined = kept[index + 1];
    const nextStart: number | null = next ? toOut(segments, next.start) : null;
    let end: number = segment.out + (Math.min(line.end, segment.end) - segment.start) + 0.9;

    if (nextStart !== null && nextStart > start) end = Math.min(Math.max(end, Math.min(nextStart, end + 0.8)), nextStart);

    const caption: CaptionLayout = captionText(line, fonts, '&HFFFFFF&', '&HFFFFFF&', 1_280);

    add(2, start, Math.min(end, total), 'Caption',
      `{\\an5\\pos(${ STAGE_VIDEO.width / 2 },${ STAGE_VIDEO.height + 135 })\\fs${ Math.min(caption.size, fontSize(80, fonts)) }}${ caption.text }`);
  });

  // 弹幕：新的在最下面，旧的往上排
  const size: number = fontSize(DANMU.size, fonts);

  danmu.forEach((item: PlacedDanmu, index: number): void => {
    const text: string = assEscape(fitText(item.message, size, ROOM, fonts));

    for (let k: number = index; k < danmu.length; k++) {
      const y: number = DANMU.bottom - ((k - index) * DANMU.row);

      if (y < DANMU.top) break;

      add(3, danmu[k].at, k + 1 < danmu.length ? danmu[k + 1].at : total, 'Danmu', `{\\an1\\pos(${ X },${ y })}${ text }`);
    }
  });

  return assDocument([
    style('Caption', fonts.text, fontSize(76, fonts), '&H00FFFFFF', '&H00000000', false, 0, 0, 5),
    sideStyle(fonts),
    style('Danmu', fonts.regular, size, '&H00DDDDDD', '&H00000000', false, 0, 0, 1)
  ], events);
}

function buildStageCoverAss(input: StageCoverInput): string {
  const { stage, fonts, width }: StageCoverInput = input;
  const pad: number = 64;
  // 【】只是「这个词要突出」的记号：默认的排版不突出，去掉括号照常写
  const rows: Array<string> = input.lines
    .map((line: string): string => coverSegments(line).map((part: { text: string }): string => part.text).join(''))
    .filter((row: string): boolean => row !== '')
    .slice(0, 3);
  const size: number = rows.length > 0 ? Math.min(...rows.map((row: string): number => fit(row, 104, width - (pad * 2), fonts))) : fontSize(104, fonts);
  const step: number = Math.round(size * 1.12);
  const top: number = H - pad - (rows.length * step);
  const showSize: number = fit(stage.show, 36, width * 0.6, fonts);
  const texts: Array<string> = [
    `{\\an9\\pos(${ width - pad },44)\\fs${ showSize }${ SHADOW }}${ assEscape(stage.show) }`,
    `{\\an9\\pos(${ width - pad },${ 44 + showSize + 6 })\\fs${ fontSize(26, fonts) }${ SHADOW }}${ assEscape(stage.date) }`,
    ...rows.map((row: string, index: number): string => `{\\an7\\pos(${ pad },${ top + (index * step) })\\fs${ size }\\b1${ SHADOW }}${ assEscape(row) }`)
  ];

  return assDocument([style('Text', fonts.heavy, size, '&H00FFFFFF', '&H00000000', fonts.heavyBold, 0, 0, 7)],
    texts.map((text: string): string => `Dialogue: 1,0:00:00.00,0:00:10.00,Text,,0,0,0,,${ text }`), width);
}

export const stageStyle: StageStyle = { stageTitleStrip, buildStageTitleAss, buildStageVideoAss, buildStageCoverAss };
