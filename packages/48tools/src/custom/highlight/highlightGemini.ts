import { pack } from '../sync/packRegistry';
import { normalizeBaseUrl, httpErrorText } from '../transcribe/transcribeApi';
import { clock, toSeconds, cleanPeople, danmuHeat, isGiftDanmu } from './highlightTime';
import { agyJson, agyDefaults, AgyStopped, AgyRefused } from './highlightAgy';
import type { AudioWindow, CaptionLine, ClipScript, DanmuLine, Highlight } from './highlightTypes';
import type { StageInfo } from './highlightStageAss';
import type { LiveMeta } from './highlightPromptTypes';

export type { LiveMeta } from './highlightPromptTypes';

/**
 * 录播自动切片里交给 Gemini 做的三件事（都用 generateContent，要求按给定的格式返回 JSON）：
 *   1. findRequest：听半小时的音频，找出可能成为爆点的片段和时间
 *   2. scriptRequest：听一个片段，出逐句字幕（带时间、重点词）、每句留不留、三个标题和片段里其他爆点的短标题、简介、封面上的看点、除了主播还有谁是主角
 *   3. coverRequest：在几张截图里挑一张做封面
 * 这个文件只管「怎么问、怎么读结果」；什么时候问、结果怎么用在 ./highlightPipeline。
 * 提示的文字不在这里：从 ../sync/packRegistry 取（默认的那份在 ../basic/highlightPrompts，接口见 ./highlightPromptTypes）。
 * API key 只放在请求头里，只发给配置的接口地址。弹幕只发时间和内容，不发昵称。
 */
export interface GeminiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  via?: 'api' | 'agy'; // 走按量付费的接口（默认），还是本机的 agy（Antigravity 的订阅额度，见 ./highlightAgy）
  agyModel?: string;
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiAsk {
  parts: Array<GeminiPart>;
  schema: Record<string, unknown>;
}

export const highlightDefaults: { model: string; baseUrl: string } = {
  // 2026-11：Gemini 4 里最便宜的一档，听音频标时间够用
  model: 'gemini-4-hydrogen',
  baseUrl: 'https://generativelanguage.googleapis.com'
};

const REQUEST_TIMEOUT: number = 600_000;
const RETRY_DELAY: number = 6_000;

export const DANMU_TEXT_LENGTH: number = 60;

const MAX_TITLES: number = 3;
const MAX_MORE: number = 2;

export class HighlightStopped extends Error {
  constructor() {
    super('已停止');
    this.name = 'HighlightStopped';
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: Error) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);

    signal?.addEventListener('abort', (): void => {
      clearTimeout(timer);
      reject(new HighlightStopped());
    }, { once: true });
  });
}

/**
 * 模型以内容为由拒绝了这次请求（提示里有敏感词，多半来自弹幕）：重试也一样。
 * 调用的地方可以去掉弹幕再问一次，还不行就跳过这个片段（见 ./highlightPipeline）
 */
export class ContentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRefused';
  }
}

const REFUSED_FINISH: Array<string> = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'];

/* 从返回里取出文字（模型的思考过程不算） */
function responseText(json: any): string {
  const blockReason: string | undefined = json?.promptFeedback?.blockReason;

  if (blockReason) throw new ContentRefused(`接口拒绝处理这段内容（${ blockReason }）`);

  const candidate: any = json?.candidates?.[0];
  const text: string = (candidate?.content?.parts ?? [])
    .filter((part: any): boolean => typeof part?.text === 'string' && !part.thought)
    .map((part: any): string => part.text)
    .join('');

  if (!text && REFUSED_FINISH.includes(candidate?.finishReason)) throw new ContentRefused(`接口拒绝处理这段内容（${ candidate.finishReason }）`);

  if (!text) throw new Error(`接口没有给出内容${ candidate?.finishReason ? `（${ candidate.finishReason }）` : '' }`);

  return text;
}

/**
 * 走本机的 agy：失败了隔一会儿再试，最多四次（它偶尔会返回格式不对的内容；
 * 连续用了二十来分钟以后、或者同时开着别的 agy 对话时，偶尔会报「backend returned an empty conversation id」，
 * 马上重试还是一样，有时一分多钟还不好，过几分钟再试就好了，2026-11-22 实测）
 */
const AGY_RETRY_DELAYS: Array<number> = [20_000, 60_000, 180_000];

async function viaAgy<T>(config: GeminiConfig, ask: GeminiAsk, signal?: AbortSignal): Promise<T> {
  let lastError: Error = new Error('请求失败');

  for (const attempt of [0, 1, 2]) {
    try {
      return await agyJson<T>(ask, { model: config.agyModel || agyDefaults.model, signal });
    } catch (err) {
      if (err instanceof AgyStopped || signal?.aborted) throw new HighlightStopped();

      // 以内容为由拒绝：再试也一样
      if (err instanceof AgyRefused) throw new ContentRefused(err.message);

      lastError = err as Error;

      // 找不到 agy、没登录这类问题再试也没用
      if (attempt === AGY_RETRY_DELAYS.length || /找不到 agy/.test(lastError.message)) break;

      await wait(AGY_RETRY_DELAYS[attempt], signal);
    }
  }

  throw lastError;
}

/**
 * 问一次 Gemini，返回解析好的 JSON。接口暂时出错（429、5xx、连不上）时等几秒再试一次
 * @param { GeminiConfig } config
 * @param { GeminiAsk } ask
 * @param { AbortSignal } [signal] - 用户点了停止
 * @param { typeof fetch } [fetchImpl] - 测试时换成假的
 */
export async function geminiJson<T>(config: GeminiConfig, ask: GeminiAsk, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<T> {
  if (config.via === 'agy') return viaAgy<T>(config, ask, signal);

  if (!config.apiKey.trim()) throw new Error('还没有填写 Gemini 的 API key（设置 → 语音转文字）');

  const model: string = config.model.trim().replace(/^models\//, '');
  const url: string = `${ normalizeBaseUrl(config.baseUrl, '/v1beta') }/v1beta/models/${ encodeURIComponent(model) }:generateContent`;
  const body: string = JSON.stringify({
    contents: [{ role: 'user', parts: ask.parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: ask.schema }
  });
  let lastError: Error = new Error('请求失败');

  for (const attempt of [1, 2]) {
    if (signal?.aborted) throw new HighlightStopped();

    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey.trim() },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) : AbortSignal.timeout(REQUEST_TIMEOUT)
      });
    } catch (err) {
      if (signal?.aborted) throw new HighlightStopped();

      lastError = new Error((err as Error)?.name === 'TimeoutError' ? 'Gemini 太久没有响应' : '连不上 Gemini 的接口，检查一下网络');

      if (attempt === 1) await wait(RETRY_DELAY, signal);

      continue;
    }

    const text: string = await response.text();

    if (!response.ok) {
      lastError = new Error(`Gemini：${ httpErrorText(response.status, text) }`);

      if (attempt === 1 && (response.status === 429 || response.status >= 500)) {
        await wait(RETRY_DELAY, signal);
        continue;
      }

      throw lastError;
    }

    try {
      return JSON.parse(responseText(JSON.parse(text))) as T;
    } catch (err) {
      if (err instanceof ContentRefused) throw err;

      lastError = err instanceof SyntaxError ? new Error('Gemini 返回的内容格式不对') : err as Error;

      if (attempt === 1) continue;
    }
  }

  throw lastError;
}

/* 称呼的规则，附在每个提示后面（没有时是空字符串） */
export function pronoun(): string {
  return pack().prompts.pronoun;
}

/* 没有标题时从原话里截一小段：按标点断开，从头取到放得下为止；一句太长就截前面的字 */
export function quoteTitle(quote: string, max: number = 12): string {
  const clauses: Array<string> = quote.split(/[，。！？、,.!?；;：:“”"「」『』\s…~～]+/).filter((clause: string): boolean => clause !== '');
  let out: string = clauses[0] ?? '';

  for (const clause of clauses.slice(1)) {
    if (Array.from(out + clause).length > max) break;

    out += clause;
  }

  return Array.from(out).slice(0, max + 4).join('');
}

/* 每个提示最后都附上的常识：称呼、专有词汇、成员名单、持续学习总结出来的偏好和背景 */
export function knowledge(meta: LiveMeta): string {
  return [pronoun(), meta.glossary, meta.members, meta.learned]
    .filter((text: string | undefined): text is string => Boolean(text))
    .map((text: string): string => `\n${ text }`)
    .join('');
}

export function audioPart(base64: string): GeminiPart {
  return { inlineData: { mimeType: 'audio/mp3', data: base64 } };
}

/* 这一段里的弹幕，一行一条「MM:SS 内容」：时间从这段音频的开头算，只发内容、不发昵称，礼物消息不要 */
export function danmuLines(danmu: Array<DanmuLine>, window: AudioWindow): string {
  return danmu
    .filter((item: DanmuLine): boolean => item.time >= window.start && item.time < window.start + window.length && !isGiftDanmu(item.message))
    .map((item: DanmuLine): string => `${ clock(item.time - window.start) } ${ item.message.slice(0, DANMU_TEXT_LENGTH) }`)
    .join('\n');
}

/**
 * 第 1 步：找爆点
 * @param { LiveMeta } meta
 * @param { AudioWindow } window - 录播的哪一段
 * @param { string } audioBase64
 * @param { Array<DanmuLine> } danmu - 整场的弹幕（这里只取这一段里的，礼物消息不要）
 * @param { boolean } [quotes] - 要不要每个爆点开头、结尾的原话（走 agy 时要：它说的时间不准，用原话定位）
 */
export function findRequest(
  meta: LiveMeta, window: AudioWindow, audioBase64: string, danmu: Array<DanmuLine>, quotes: boolean = false
): GeminiAsk {
  const prompt: string = pack().prompts.find({
    meta, window, danmuText: danmuLines(danmu, window), heat: danmuHeat(danmu, window), quotes, knowledge: knowledge(meta)
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
              start: { type: 'STRING' },
              end: { type: 'STRING' },
              title: { type: 'STRING' },
              cover: { type: 'STRING' },
              quote: { type: 'STRING' },
              reason: { type: 'STRING' },
              score: { type: 'NUMBER' },
              ...(quotes ? { first: { type: 'STRING' }, last: { type: 'STRING' } } : {})
            },
            required: ['start', 'end', 'title', 'cover', 'quote', 'reason', 'score', ...(quotes ? ['first', 'last'] : [])]
          }
        }
      },
      required: ['summary', 'highlights']
    }
  };
}

/* 第 1 步的结果：时间换成整场录播里的秒数，不合理的去掉 */
export function readFound(data: any, window: AudioWindow): { summary: string; highlights: Array<Highlight> } {
  const list: Array<any> = Array.isArray(data?.highlights) ? data.highlights : [];
  const highlights: Array<Highlight> = list
    .map((item: any): Highlight => ({
      start: toSeconds(item?.start) + window.start,
      end: Math.min(toSeconds(item?.end), window.length) + window.start,
      title: String(item?.title ?? '').trim() || (item?.kind ? '' : quoteTitle(String(item?.quote ?? ''))), // 公演的不截（原话可能是歌词）
      cover: String(item?.cover ?? '').trim(),
      quote: String(item?.quote ?? '').trim(),
      reason: String(item?.reason ?? '').trim(),
      score: Number(item?.score) || 0,
      ...(item?.first ? { first: String(item.first).trim() } : {}),
      ...(item?.last ? { last: String(item.last).trim() } : {}),
      // 公演切片才有（./highlightStage 的 stageFindRequest）
      ...(['mc', 'mistake', 'song'].includes(item?.kind) ? { kind: item.kind } : {}),
      ...(item?.song ? { song: String(item.song).trim() } : {}),
      ...(Array.isArray(item?.singers) ? { singers: item.singers.map((name: unknown): string => String(name).trim()).filter(Boolean) } : {}),
      ...(Number.isFinite(toSeconds(item?.reaction)) && item?.reaction !== '' ? { reaction: toSeconds(item.reaction) + window.start } : {})
    }))
    .filter((item: Highlight): boolean => Number.isFinite(item.start) && Number.isFinite(item.end)
      && item.start >= window.start && item.end - item.start >= 5 && item.title !== '');

  return { summary: String(data?.summary ?? '').trim(), highlights };
}

/**
 * 公演里唱歌、失误的片段不写字幕，标题用找爆点时给的；挑片的人自己取了封面标题时，另外问一次发布用的标题
 * （照改过的说明想，找爆点时的标题可能就是因为写错了才被改掉的）
 */
export function stageTitlesRequest(meta: LiveMeta, highlight: Highlight, stage: StageInfo): GeminiAsk {
  const prompt: string = pack().prompts.stageTitles({ meta, highlight, stage, knowledge: knowledge(meta) });

  return {
    parts: [{ text: prompt }],
    schema: { type: 'OBJECT', properties: { titles: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['titles'] }
  };
}

/**
 * 第 2 步：一个片段的逐句字幕、留不留、标题、简介、看点
 * @param { StageInfo } [stage] - 公演 MC 的切片（提示里说的是公演，不是口袋48的直播）
 */
export function scriptRequest(
  meta: LiveMeta, highlight: Highlight, clipLength: number, audioBase64: string, danmu: Array<DanmuLine>, note?: string, stage?: StageInfo
): GeminiAsk {
  const prompt: string = pack().prompts.script({
    meta,
    highlight,
    clipLength,
    danmu: danmu.map((item: DanmuLine): string => item.message.slice(0, DANMU_TEXT_LENGTH)),
    note,
    stage,
    knowledge: knowledge(meta)
  });

  return {
    parts: [{ text: prompt }, audioPart(audioBase64)],
    schema: {
      type: 'OBJECT',
      properties: {
        lines: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              start: { type: 'NUMBER' },
              end: { type: 'NUMBER' },
              text: { type: 'STRING' },
              keep: { type: 'BOOLEAN' },
              emphasis: { type: 'ARRAY', items: { type: 'STRING' } }
            },
            required: ['start', 'end', 'text', 'keep', 'emphasis']
          }
        },
        titles: { type: 'ARRAY', items: { type: 'STRING' } },
        more: { type: 'ARRAY', items: { type: 'STRING' } },
        description: { type: 'STRING' },
        points: { type: 'ARRAY', items: { type: 'STRING' } },
        people: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['lines', 'titles', 'more', 'description', 'points', 'people']
    }
  };
}

/* 短标题：去掉模型有时还是会加的书名号、结尾的句号感叹号等（发布时前后还要拼上名字和日期）；结尾的问号和括号吐槽是标题的一部分，留着 */
export function cleanTitle(title: string): string {
  const text: string = title.trim()
    .replace(/^【([^【】]*)】$/, '$1') // 整个标题包在【】里：是模型加的包装
    .replace(/^[「『《]+|[」』》]+$/g, '').replace(/[！!。，,、~～…\s]+$/g, '').replace(/[?？][！!?？]*$/, '？').trim();

  // 标题中间的【】是公演封面上刷荧光笔的记号（见 ./highlightStage 的 plainTitle），留着；不成对的没法用，去掉
  return (text.match(/【/g)?.length ?? 0) === (text.match(/】/g)?.length ?? 0) ? text : text.replace(/[【】]/g, '').trim();
}

/* 三个标题：去掉空的和重复的 */
export function readTitles(titles: unknown): Array<string> {
  return Array.from(new Set((Array.isArray(titles) ? titles : [])
    .map((title: unknown): string => cleanTitle(String(title ?? '')))
    .filter((title: string): boolean => title !== ''))).slice(0, MAX_TITLES);
}

/* 标题是不是从原话里截的：标点、空格不算，连着的 6 个字以上都一样；8 个字以上的容许听错、写错一个字。
   太短的不算（「性感皮卡丘」这种词组，她说过，拿来点题也是自己想的） */
export function isQuoteTitle(title: string, spoken: string): boolean {
  const letters: (text: string) => Array<string> = (text: string): Array<string> => Array.from(text.toLowerCase()).filter((ch: string): boolean => /[\p{L}\p{N}]/u.test(ch));
  const want: Array<string> = letters(title);
  const heard: Array<string> = letters(spoken);

  if (want.length < 6) return false;

  for (let from: number = 0; from + want.length <= heard.length; from++) {
    const wrong: number = want.reduce((sum: number, ch: string, at: number): number => sum + (ch === heard[from + at] ? 0 : 1), 0);

    if (wrong <= (want.length >= 8 ? 1 : 0)) return true;
  }

  return false;
}

/* 截原话的标题只当备选（用户 2026-11-24 定的：第一个会写在画面和封面上）：第一个是原话时，把后面第一个自己想的换到前面；全是原话就不动 */
export function ownTitleFirst(titles: Array<string>, spoken: Array<string>): Array<string> {
  const isQuote: (title: string) => boolean = (title: string): boolean => spoken.some((text: string): boolean => isQuoteTitle(title, text));
  const own: string | undefined = titles.find((title: string): boolean => !isQuote(title));

  return own === undefined ? titles : [own, ...titles.filter((title: string): boolean => title !== own)];
}

/* 第 2 步的结果：缺的东西用第 1 步的补上；member 是主播（「其他主角」里不能有她自己） */
export function readScript(data: any, highlight: Highlight, member: string = ''): ClipScript {
  const lines: Array<CaptionLine> = (Array.isArray(data?.lines) ? data.lines : []).map((item: any): CaptionLine => ({
    start: Number(item?.start),
    end: Number(item?.end),
    text: String(item?.text ?? ''),
    keep: item?.keep === true,
    emphasis: Array.isArray(item?.emphasis) ? item.emphasis.map(String) : []
  }));
  const points: Array<string> = (Array.isArray(data?.points) ? data.points : [])
    .map((point: unknown): string => String(point ?? '').trim())
    .filter((point: string): boolean => point !== '');

  // 三个标题：去掉空的和重复的。以前只有一个 title（存下来的旧结果），也认
  const titles: Array<string> = ownTitleFirst(
    readTitles([...(Array.isArray(data?.titles) ? data.titles : []), data?.title]),
    [lines.map((line: CaptionLine): string => line.text).join(''), highlight.quote]);

  if (titles.length === 0) titles.push(cleanTitle(highlight.title));

  // 片段里另外的爆点的短标题：最多两个，不和三个标题重复
  const more: Array<string> = Array.from(new Set<string>((Array.isArray(data?.more) ? data.more as Array<unknown> : [])
    .map((title: unknown): string => cleanTitle(String(title ?? '')))
    .filter((title: string): boolean => title !== '' && !titles.includes(title)))).slice(0, MAX_MORE);

  return {
    lines,
    title: titles[0],
    titles,
    more,
    description: String(data?.description ?? '').trim() || highlight.reason,
    points: points.length > 0 ? points : [highlight.cover].filter((point: string): boolean => point !== ''),
    people: cleanPeople(data?.people, member)
  };
}

/* 电台切片的封面照片：她以前直播、电台的封面和轮播图排个序（见 ./radioPhotos） */
export function photoRankRequest(member: string, imagesBase64: Array<string>): GeminiAsk {
  return {
    parts: [
      { text: pack().prompts.photoRank(member, imagesBase64.length) },
      ...imagesBase64.map((data: string): GeminiPart => ({ inlineData: { mimeType: 'image/jpeg', data } }))
    ],
    schema: {
      type: 'OBJECT',
      properties: { order: { type: 'ARRAY', items: { type: 'INTEGER' } }, reason: { type: 'STRING' } },
      required: ['order', 'reason']
    }
  };
}

/* 第 3 步：挑封面 */
export function coverRequest(imagesBase64: Array<string>): GeminiAsk {
  return {
    parts: [
      { text: pack().prompts.cover(imagesBase64.length) },
      ...imagesBase64.map((data: string): GeminiPart => ({ inlineData: { mimeType: 'image/jpeg', data } }))
    ],
    schema: {
      type: 'OBJECT',
      properties: { best: { type: 'INTEGER' }, reason: { type: 'STRING' } },
      required: ['best', 'reason']
    }
  };
}
