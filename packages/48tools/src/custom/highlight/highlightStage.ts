import { pack } from '../sync/packRegistry';
import { audioPart, knowledge, danmuLines, type GeminiAsk, type LiveMeta } from './highlightGemini';
import { danmuHeat, CLIP_MIN_SECONDS, CLIP_MAX_SECONDS, type ClipWindow } from './highlightTime';
import type { AudioWindow, ClipScript, DanmuLine, Highlight, StageKind } from './highlightTypes';
import { splitTitle, textWidth } from './highlightAss';
import type { StageInfo } from './highlightStageAss';

/**
 * 公演切片（B 站公演直播录下来的视频和弹幕，见 custom/bilibili）和口袋48直播切片不一样的地方：
 *   - 找三类片段：MC 环节的爆点（mc）、表演中的失误（mistake）、组合有特色的一整首歌（song）
 *   - 提示里讲清楚公演的流程（歌和歌之间的间隔），失误要结合弹幕（粉丝的反应晚 10 秒左右，从反应前 15 秒开切）
 *   - mc 和口袋48直播一样写字幕、剪掉无关的话（45 秒 ~ 5 分钟）；song、mistake 不写字幕（舞台上自己有歌词），整段原样保留
 *   - song、mistake 的起止不按原话定位，按伴奏和弹幕的反应重新定（./highlightStageTiming）
 * 这里是提示和规则（纯计算）；流程在 ./highlightPipeline，排版在 ./highlightStageAss。
 */
export const STAGE_LIMITS: Record<StageKind, { min: number; max: number }> = {
  mc: { min: CLIP_MIN_SECONDS, max: CLIP_MAX_SECONDS },
  mistake: { min: 12, max: 160 }, // 停音乐重来、救场这类，台上要聊一两分钟
  song: { min: 60, max: 480 }
};

export function stageKindOf(highlight: Highlight): StageKind {
  return highlight.kind ?? 'mc';
}

/**
 * 公演自动切片每类做几个（用户 2026-11-22 定的）：MC 的爆点合在一起算；好评的舞台（song）和失误少切一点。
 * MC 原来最多 8 个，2026-11-23 用户看了模型的打分，觉得没做的里面还有很多有意思的（队内的戏剧性），放宽到最多 15 个。
 * 三类各算各的名额，不和 MC 放在一起按分数排（整场一起排的话，一类会把另一类挤掉）。
 * 门槛相对于「自动」的爆点分（设置里的，默认 8.5）：MC 放宽半分；唱歌、失误要够门槛。
 */
export const STAGE_QUOTA: Record<StageKind, { max: number; below: number }> = {
  mc: { max: 15, below: 0.5 },
  song: { max: 2, below: 0 },
  mistake: { max: 2, below: 0 }
};

const COVER_LINE_WIDTH: number = 12; // 封面上的标题，一行最多这么多字

const STAGE_KINDS: Array<StageKind> = ['mc', 'song', 'mistake'];
const STAGE_FALLBACK_SCORE: number = 7; // 一个够分的都没有时，最高的那个不低于它也做一个

export interface StageQuota {
  limit: Record<StageKind, number>;    // 每类最多做几个（够分的候选不够时更少）
  minScore: Record<StageKind, number>; // 每类至少要多少分
  total: number;
}

/**
 * 公演自动切片每类做几个
 * @param { Array<Highlight> } candidates - 合并去重后的候选
 * @param { number } autoScore - 「自动」的爆点分门槛
 */
export function stageQuota(candidates: Array<Highlight>, autoScore: number): StageQuota {
  const minScore: Record<StageKind, number> = {
    mc: autoScore - STAGE_QUOTA.mc.below, song: autoScore - STAGE_QUOTA.song.below, mistake: autoScore - STAGE_QUOTA.mistake.below
  };
  const limit: Record<StageKind, number> = { mc: 0, song: 0, mistake: 0 };

  for (const kind of STAGE_KINDS) {
    const good: number = candidates.filter((item: Highlight): boolean => stageKindOf(item) === kind && item.score >= minScore[kind]).length;

    limit[kind] = Math.min(STAGE_QUOTA[kind].max, good);
  }

  let total: number = limit.mc + limit.song + limit.mistake;
  const best: Highlight | undefined = [...candidates].sort((a: Highlight, b: Highlight): number => b.score - a.score)[0];

  if (total === 0 && best && best.score >= STAGE_FALLBACK_SCORE) {
    limit[stageKindOf(best)] = 1;
    minScore[stageKindOf(best)] = best.score;
    total = 1;
  }

  return { limit, minScore, total };
}

const SONG_PAD: { before: number; after: number } = { before: 2, after: 6 };   // 前奏前、最后的动作和掌声
const MISTAKE_PAD: { before: number; after: number } = { before: 1, after: 2 };

/* 唱歌、失误的片段：直接按模型给的起止时间（前后留一点），不剪 */
export function stageClipWindow(highlight: Highlight, duration: number): ClipWindow {
  const pad: { before: number; after: number } = stageKindOf(highlight) === 'song' ? SONG_PAD : MISTAKE_PAD;
  const start: number = Math.max(0, highlight.start - pad.before);
  const end: number = Math.min(duration, highlight.end + pad.after);

  return { start, length: Math.max(0, end - start) };
}

/* 这个片段的长度合不合适；不合适时返回原因 */
export function stageLengthProblem(kind: StageKind, length: number): string | undefined {
  const { min, max }: { min: number; max: number } = STAGE_LIMITS[kind];

  if (length < min) return `只有 ${ Math.round(length) } 秒（至少 ${ min } 秒）`;

  if (length > max) return `有 ${ Math.round(length) } 秒（最多 ${ max } 秒）`;

  return undefined;
}

/* 唱的是哪首歌（不带书名号）：模型给的 song；没给（或者「未知」）时从标题、选它的理由里找第一个《》；都没有返回 undefined */
export function songNameOf(highlight: Highlight): string | undefined {
  const given: string = (highlight.song ?? '').replace(/^《|》$/g, '').trim();

  if (given && given !== '未知') return given;

  for (const text of [highlight.title, highlight.reason]) {
    const match: RegExpExecArray | null = /《([^《》]{1,24})》/.exec(text ?? '');

    if (match) return match[1].trim();
  }

  return undefined;
}

/* 唱歌的片段，歌名认得出来时的标题：「《歌名》」。排在备选标题的第一个（发布时就叫【队伍】《歌名》 | 公演名 日期） */
export function stageSongTitle(highlight: Highlight): string | undefined {
  const song: string | undefined = stageKindOf(highlight) === 'song' ? songNameOf(highlight) : undefined;

  return song ? `《${ song }》` : undefined;
}

/* 唱歌、失误的片段不问第二次模型：标题、简介、看点用第一步给的 */
export function stageScript(highlight: Highlight): ClipScript {
  const singers: Array<string> = highlight.singers ?? [];
  const points: Array<string> = stageKindOf(highlight) === 'song'
    ? [highlight.song && highlight.song !== '未知' ? `《${ highlight.song.replace(/^《|》$/g, '') }》` : '', singers.join('、')]
    : [highlight.cover];

  // 唱歌的先放「《歌名》」（用户 2026-11-27 给的发布标题的例子就是这样叫的），找爆点时起的那个排在后面
  const songTitle: string | undefined = stageSongTitle(highlight);
  const titles: Array<string> = songTitle && songTitle !== highlight.title ? [songTitle, highlight.title] : [highlight.title];

  return {
    lines: [],
    title: titles[0],
    titles,
    more: [],
    description: highlight.reason,
    points: points.filter(Boolean),
    people: singers
  };
}

/**
 * 标题里的【】只是记号：标出封面上要刷荧光笔的词（用户 2026-11-27 定的）。括号本身哪里都不显示：
 * 封面上换成荧光笔（./highlightStageAss、./highlightGraphics 的 coverSegments），画面上的标题、文件名、发布用的标题用这个去掉
 */
export function plainTitle(title: string): string {
  return title.replace(/[【】]/g, '').trim();
}

/* 带记号的标题拆成一个个字，记下每个字在不在【】里 */
function markedChars(title: string): Array<{ ch: string; mark: boolean }> {
  const out: Array<{ ch: string; mark: boolean }> = [];
  let mark: boolean = false;

  for (const ch of Array.from(title.trim())) {
    if (ch === '【') mark = true;
    else if (ch === '】') mark = false;
    else out.push({ ch, mark });
  }

  return out;
}

/* 一段字写回带【】的样子 */
function withMarks(chars: Array<{ ch: string; mark: boolean }>): string {
  let text: string = '';

  chars.forEach((item: { ch: string; mark: boolean }, index: number): void => {
    if (item.mark && !chars[index - 1]?.mark) text += '【';

    text += item.ch;

    if (item.mark && !chars[index + 1]?.mark) text += '】';
  });

  return text;
}

/**
 * 太长的标题分行：照不带记号的字来分（和画面上的标题一样，在标点、词和词之间断，见 ./highlightAss 的 splitTitle），记号跟着字走。
 * 断的地方正好落在一个【】中间时，挪到这个词的前面或者后面（哪边近挪哪边），不把要突出的词拆成两半
 */
function splitMarked(title: string): Array<string> {
  const chars: Array<{ ch: string; mark: boolean }> = markedChars(title);
  const rows: Array<string> = splitTitle(chars.map((item: { ch: string }): string => item.ch).join(''));

  if (rows.length < 2) return [withMarks(chars)];

  // 每一行是从第几个字到第几个字（分行时行尾的逗号、空格会去掉，所以要一行行对回去）
  const ranges: Array<{ start: number; end: number }> = [];
  let from: number = 0;

  for (const row of rows) {
    const want: Array<string> = Array.from(row);
    let start: number = from;

    while (start + want.length <= chars.length && !want.every((ch: string, index: number): boolean => chars[start + index].ch === ch)) start++;

    if (start + want.length > chars.length) return [withMarks(chars)]; // 对不回去：不分了

    ranges.push({ start, end: start + want.length });
    from = start + want.length;
  }

  for (let i: number = 0; i < ranges.length - 1; i++) {
    const upper: { start: number; end: number } = ranges[i];
    const lower: { start: number; end: number } = ranges[i + 1];
    const joined: boolean = chars.slice(upper.end - 1, lower.start + 1).every((item: { mark: boolean }): boolean => item.mark);

    if (!joined) continue;

    let head: number = upper.end - 1; // 这个词从哪开始
    let tail: number = lower.start;   // 到哪结束（不含）

    while (head > 0 && chars[head - 1].mark) head--;

    while (tail < chars.length && chars[tail].mark) tail++;

    const toLower: boolean = head > upper.start; // 整个词放到下一行：上一行还剩得下字
    const toUpper: boolean = tail < lower.end;   // 整个词放到上一行：下一行还剩得下字

    if (toLower && (!toUpper || upper.end - head <= tail - lower.start)) {
      upper.end = head;
      lower.start = head;
    } else if (toUpper) {
      upper.end = tail;
      lower.start = tail;
    }
  }

  return ranges.map((range: { start: number; end: number }): string => withMarks(chars.slice(range.start, range.end))).filter((row: string): boolean => row !== '');
}

/**
 * 封面上的大字就是定的标题（用户 2026-11-27 定的：不再另外写「封面大字」。以前 Gemini 单独写 1～3 行、定标题时还能一行行改，
 * 标题和封面各说各的；现在标题是什么封面就写什么）。一行放得下就一行，太长分行；【】里的词下面刷荧光笔，括号不显示。
 * 唱歌的片段还是只写歌名（用户 2026-11-23 定的，11-27 又确认过，照《轨迹》那张）：一行「《歌名》」放在团队色的色块里，字比平常大
 * （见 ./highlightStageAss）；认不出歌名，或者标题是自己写的（own，用户 2026-11-24 定的：自己取了标题就写它），就和别的片段一样写标题
 */
export function stageCoverLines(highlight: Highlight, title: string, own: boolean = false): Array<string> {
  const song: string | undefined = !own && stageKindOf(highlight) === 'song' ? songNameOf(highlight) : undefined;

  if (song) return [`【《${ song }》】`];

  const plain: string = plainTitle(title);

  if (plain === '') return [];

  return textWidth(plain) > COVER_LINE_WIDTH ? splitMarked(title) : [withMarks(markedChars(title))];
}

/* 发布用的标题前面的队伍怎么叫：配置（../sync/packTypes 的 stageTeamTags）里写了的照配置，别的直接写队伍名（SII、HII、G……） */
export function stageTeamTag(team: string): string {
  const code: string = team.trim().replace(/^(?:SNH|GNZ|BEJ|CKG|CGT|SHY)48\s*/i, '').replace(/^TEAM\s*/i, '').trim().toUpperCase();

  return pack().config.stageTeamTags[code] || code || team.trim();
}

/**
 * 发布用的标题：【队伍】标题 | 公演名 日期，例如
 *   【NII】《光芒》 | 《新芽之契》十三周年庆特别公演 2026.11.22
 * 以前是「【SNH48 TEAM X｜甲&乙】标题 | 公演名 日期 公演切片」：前面不再带团名和成员名字，后面不再写「公演切片」
 */
export function stagePostTitle(stage: StageInfo, title: string): string {
  return `【${ stageTeamTag(stage.team) }】${ plainTitle(title) } | ${ stage.show } ${ stage.date }`;
}

/**
 * 第 1 步（公演版）：在一段录像里找 MC 爆点、失误、组合有特色的歌
 * @param { LiveMeta } meta - 成员名单、专有词汇
 * @param { AudioWindow } window - 录像的哪一段
 * @param { string } audioBase64
 * @param { Array<DanmuLine> } danmu - 整场的弹幕
 * @param { boolean } quotes - 要不要开头、结尾的原话（走 agy 时要，唱歌的就写第一句和最后一句歌词）
 * @param { StageInfo } stage
 */
export function stageFindRequest(
  meta: LiveMeta, window: AudioWindow, audioBase64: string, danmu: Array<DanmuLine>, quotes: boolean, stage: StageInfo
): GeminiAsk {
  const prompt: string = pack().prompts.stageFind({
    meta, window, danmuText: danmuLines(danmu, window), heat: danmuHeat(danmu, window), quotes, knowledge: knowledge(meta), stage
  });

  return {
    parts: [{ text: prompt }, audioPart(audioBase64)],
    schema: {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING' },
        highlights: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              kind: { type: 'STRING', enum: ['mc', 'mistake', 'song'] },
              start: { type: 'STRING' },
              end: { type: 'STRING' },
              title: { type: 'STRING' },
              cover: { type: 'STRING' },
              quote: { type: 'STRING' },
              reason: { type: 'STRING' },
              score: { type: 'NUMBER' },
              song: { type: 'STRING' },
              singers: { type: 'ARRAY', items: { type: 'STRING' } },
              reaction: { type: 'STRING' },
              ...(quotes ? { first: { type: 'STRING' }, last: { type: 'STRING' } } : {})
            },
            required: ['kind', 'start', 'end', 'title', 'cover', 'quote', 'reason', 'score', 'reaction', ...(quotes ? ['first', 'last'] : [])]
          }
        }
      },
      required: ['summary', 'highlights']
    }
  };
}

export interface RecordedPart {
  start: number;     // 开始录的时间（毫秒）
  duration: number;  // 这一段实际有多长（秒）
}

/**
 * 弹幕的时间对到接起来的录像上：弹幕文件里的时间是从开始录制算的（毫秒级的秒数），录像断过的话中间有空档，
 * 接起来以后后面几段要往前挪；落在空档里的弹幕不要
 * @param { Array<DanmuLine> } danmu - time 是从 startedAt 起的秒数
 * @param { number } startedAt - 开始录制的时间（毫秒）
 * @param { Array<RecordedPart> } parts - 按顺序
 */
export function mapDanmuToParts(danmu: Array<DanmuLine>, startedAt: number, parts: Array<RecordedPart>): Array<DanmuLine> {
  const out: Array<DanmuLine> = [];

  for (const item of danmu) {
    const absolute: number = startedAt + (item.time * 1_000);
    let offset: number = 0;

    for (const part of parts) {
      const into: number = (absolute - part.start) / 1_000;

      if (into >= 0 && into <= part.duration) {
        out.push({ ...item, time: offset + into });
        break;
      }

      offset += part.duration;
    }
  }

  return out;
}
