import type { CaptionLine, Segment, Silence } from './highlightTypes';

/**
 * 录播自动切片里的「剪」：模型给出逐句字幕和每句留不留，这里算出成片由原片的哪几段拼成。
 *   1. tidyLines：整理模型给的句子（时间不合理的去掉、按时间排好、相邻的不重叠）
 *   2. snapLines：用静音的位置修正每句的开始和结束（模型给的时间有时会早一秒左右）
 *   3. buildSegments：留下来的句子拼成几段，中间的沉默和不要的句子剪掉
 *   4. toOut：片段里的时间 → 成片里的时间
 * 都是纯计算，方便测试。
 */
const MAX_GAP: number = 2;        // 留下的两句之间空得比这久，就把中间剪掉
const PAD_BEFORE: number = 0.3;   // 每一段开头多留一点，免得第一个字被切掉
const PAD_AFTER: number = 0.45;
const TAIL: number = 2.5;         // 最后一句说完多留一会儿（笑声、反应）

export function tidyLines(lines: Array<CaptionLine>, clipLength: number): Array<CaptionLine> {
  const list: Array<CaptionLine> = lines
    .filter((line: CaptionLine): boolean => typeof line?.text === 'string' && line.text.trim() !== ''
      && Number.isFinite(line.start) && Number.isFinite(line.end) && line.start >= 0 && line.start < clipLength)
    .map((line: CaptionLine): CaptionLine => ({
      start: line.start,
      end: Math.min(clipLength, Math.max(line.end, line.start + 0.2)),
      text: line.text.trim(),
      keep: line.keep === true,
      emphasis: Array.isArray(line.emphasis)
        ? line.emphasis.filter((word: string): boolean => typeof word === 'string' && word !== '')
        : []
    }))
    .sort((a: CaptionLine, b: CaptionLine): number => a.start - b.start);

  return list.map((line: CaptionLine, index: number): CaptionLine => {
    const next: CaptionLine | undefined = list[index + 1];

    return next && line.end > next.start ? { ...line, end: Math.max(line.start + 0.1, next.start) } : line;
  });
}

export function snapLines(lines: Array<CaptionLine>, silences: Array<Silence>): Array<CaptionLine> {
  const snapped: Array<CaptionLine> = lines.map((line: CaptionLine): CaptionLine => {
    let { start, end }: CaptionLine = line;

    for (const silence of silences) {
      const length: number = end - start;

      // 这一句的开头落在一段静音里（或紧挨着它）：从静音结束的地方开始
      if (silence.start <= start + 0.4 && silence.end > start + 0.15 && silence.end < start + (length * 0.7)) {
        start = silence.end - 0.1;
      }

      // 结尾落在静音里：到静音开始的地方结束
      if (silence.end >= end - 0.4 && silence.start < end - 0.15 && silence.start > start + (length * 0.3)) {
        end = silence.start + 0.15;
      }
    }

    return { ...line, start, end };
  });

  return snapped.map((line: CaptionLine, index: number): CaptionLine => {
    const next: CaptionLine | undefined = snapped[index + 1];

    return next && line.end > next.start ? { ...line, end: next.start } : line;
  });
}

/**
 * 留下来的句子拼成几段
 * @param { Array<CaptionLine> } lines - 已经按时间排好的句子
 * @param { number } clipLength - 片段的长度（秒）
 */
export function buildSegments(lines: Array<CaptionLine>, clipLength: number): { segments: Array<Segment>; total: number } {
  const groups: Array<{ from: number; to: number }> = [];

  lines.forEach((line: CaptionLine, index: number): void => {
    if (!line.keep) return;

    const last: { from: number; to: number } | undefined = groups[groups.length - 1];
    const prev: CaptionLine | undefined = lines[index - 1];

    if (last && prev?.keep && line.start - prev.end <= MAX_GAP) {
      last.to = index;
    } else {
      groups.push({ from: index, to: index });
    }
  });

  const segments: Array<Segment> = [];
  let out: number = 0;

  groups.forEach((group: { from: number; to: number }, index: number): void => {
    const before: CaptionLine | undefined = lines[group.from - 1];
    const after: CaptionLine | undefined = lines[group.to + 1];
    const first: CaptionLine = lines[group.from];
    const last: CaptionLine = lines[group.to];
    const isLast: boolean = index === groups.length - 1;
    // 不要把前一句、后一句不要的话带进来
    const start: number = Math.max(0, first.start - PAD_BEFORE, before ? Math.min(before.end, first.start) : 0);
    const end: number = Math.min(
      clipLength,
      last.end + (isLast ? TAIL : PAD_AFTER),
      after ? Math.max(after.start, last.end + 0.1) : Infinity);

    if (end - start < 0.2) return;

    segments.push({ from: group.from, to: group.to, start, end, out });
    out += end - start;
  });

  return { segments, total: out };
}

/* 片段里的时间 → 成片里的时间；被剪掉的地方返回 null */
export function toOut(segments: Array<Segment>, time: number): number | null {
  for (const segment of segments) {
    if (time >= segment.start && time <= segment.end) return segment.out + (time - segment.start);
  }

  return null;
}
