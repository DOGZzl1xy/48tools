import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fsP } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

/**
 * 录播自动切片里问 Gemini 的另一条路：不走按量付费的 API，而是调用本机装的 Antigravity 命令行（agy），用它登录的订阅额度。
 * 设置页「录播切片」里选了「本机的 agy」才会走这里（见 ./highlightGemini 的 geminiJson）。
 *
 * agy 是一个带工具的智能体，不能直接把音频塞进请求里，所以：
 *   1. 把这次要给模型的音频 / 图片写到一个临时文件夹里（只有这几个文件）
 *   2. 在那个文件夹里运行 agy（--sandbox：不让它运行命令），提示里告诉它用读文件的工具直接听 / 看这些文件
 *   3. 把要的格式（JSON Schema）写在提示里，读它回答里的第一个 JSON。
 *      不用 agy 自己的 --json-schema：实测加了以后，它会在模型的回答后面再接一个「对任务的总结」，那个才符合格式，内容却是废话
 * 实测 agy 里的 hydrogen 模型能直接听 mp3。提示从标准输入传进去（太长，放不进命令行参数）。
 * 注意：订阅额度有自己的限流，用完时这里会报错；那时在设置里切回 API 就行。
 */
export interface AgyPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface AgyAsk {
  parts: Array<AgyPart>;
  schema: Record<string, unknown>;
}

export const agyDefaults: { command: string; model: string } = {
  command: 'agy',
  // agy 里的模型名带思考强度；找爆点、写字幕用中档
  model: 'gemini-4-hydrogen-medium'
};

const PRINT_TIMEOUT: string = '900s';
const EXTENSIONS: Record<string, string> = {
  'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac', 'image/jpeg': 'jpg', 'image/png': 'png'
};
let counter: number = 0;

export class AgyStopped extends Error {
  constructor() {
    super('已停止');
  }
}

/* Gemini 接口的格式说明里类型是大写的（OBJECT、STRING…），agy 要标准的 JSON Schema（小写） */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);

  if (schema === null || typeof schema !== 'object') return schema;

  return Object.fromEntries(Object.entries(schema as Record<string, unknown>).map(([key, value]: [string, unknown]): [string, unknown] => [
    key, key === 'type' && typeof value === 'string' ? value.toLowerCase() : toJsonSchema(value)
  ]));
}

/**
 * 把一次提问拆成「文字 + 要写到硬盘上的文件」：音频叫 audio-1.mp3，图片叫 image-1.jpg…，并在文字后面说明怎么用这些文件
 * @param { AgyAsk } ask
 */
export function agyInput(ask: AgyAsk): { prompt: string; files: Array<{ name: string; data: string }> } {
  const files: Array<{ name: string; data: string }> = [];
  const counts: Record<string, number> = {};
  const texts: Array<string> = [];

  for (const part of ask.parts) {
    if (part.text !== undefined) texts.push(part.text);

    if (part.inlineData) {
      const kind: string = part.inlineData.mimeType.startsWith('image/') ? 'image' : 'audio';

      counts[kind] = (counts[kind] ?? 0) + 1;
      files.push({ name: `${ kind }-${ counts[kind] }.${ EXTENSIONS[part.inlineData.mimeType] ?? 'bin' }`, data: part.inlineData.data });
    }
  }

  const audio: Array<string> = files.filter((file: { name: string }): boolean => file.name.startsWith('audio-')).map((file: { name: string }): string => file.name);
  const images: Array<string> = files.filter((file: { name: string }): boolean => file.name.startsWith('image-')).map((file: { name: string }): string => file.name);
  const notes: Array<string> = [];

  if (audio.length > 0) notes.push(`上面说的音频是当前文件夹里的 ${ audio.join('、') }。`);

  if (images.length > 0) notes.push(`上面说的截图是当前文件夹里的 ${ images.join('、') }（按这个顺序是第 1 到第 ${ images.length } 张）。`);

  if (files.length > 0) {
    notes.push('请用读文件的工具直接听 / 看这些文件（完整地听完），不要运行任何命令，不要读别的文件，不要上网，不要问我问题。');
  }

  notes.push('最后只输出一个 JSON，不要写别的话，不要用 Markdown 代码块。它必须符合下面这个 JSON Schema：字段名、类型都要一模一样，不要多加字段，'
    + '数组里该是字符串的就直接放字符串（不要包成对象）。');

  return { prompt: `${ texts.join('\n') }\n\n${ notes.join('\n') }\n${ JSON.stringify(toJsonSchema(ask.schema)) }`, files };
}

/**
 * 一段文字里第一个完整的 JSON（对象或数组）。回答的 JSON 前后有时会多出别的东西（说明、代码块标记、甚至第二个 JSON），所以不能整段解析
 * @param { string } text
 */
export function firstJson(text: string): string | null {
  const start: number = text.search(/[{[]/);

  if (start === -1) return null;

  let depth: number = 0;
  let inString: boolean = false;

  for (let index: number = start; index < text.length; index++) {
    const ch: string = text[index];

    if (inString) {
      if (ch === '\\') index++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;

      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

/* agy 用 stream-json 输出时每行一个事件，最后一个 result 事件里是结果 */
export function readAgyResult(stdout: string): unknown {
  let result: { status?: string; response?: unknown; error?: unknown } | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;

    try {
      const event: { event?: string; result?: { status?: string; response?: unknown; error?: unknown } } = JSON.parse(line);

      if (event.event === 'result' && event.result) result = event.result;
    } catch { /* 不是完整的一行 JSON */ }
  }

  if (!result) throw new Error('agy 没有返回结果');

  if (result.status !== 'SUCCESS') {
    throw new Error(`agy 没有成功（${ result.status ?? '未知状态' }）：${ String(result.error ?? '').slice(0, 300) || '可能是订阅额度用完了，或者没有登录' }`);
  }

  if (typeof result.response !== 'string') return result.response;

  const text: string = result.response.trim();
  const json: string | null = firstJson(text);

  if (json !== null) {
    try {
      return JSON.parse(json);
    } catch { /* 下面统一报错 */ }
  }

  throw new Error(`agy 返回的内容格式不对（${ text.length } 字，开头：${ text.slice(0, 80) }）`);
}

/**
 * 通过本机的 agy 问一次，返回解析好的 JSON
 * @param { AgyAsk } ask
 * @param { object } options
 * @param { string } [options.model]
 * @param { string } [options.command] - agy 的命令或路径
 * @param { AbortSignal } [options.signal]
 */
export async function agyJson<T>(ask: AgyAsk, options: { model?: string; command?: string; signal?: AbortSignal } = {}): Promise<T> {
  const { signal }: { signal?: AbortSignal } = options;

  if (signal?.aborted) throw new AgyStopped();

  const dir: string = path.join(os.tmpdir(), `48tools-agy-${ process.pid }-${ Date.now() }-${ counter++ }`);
  const input: { prompt: string; files: Array<{ name: string; data: string }> } = agyInput(ask);

  await fsP.mkdir(dir, { recursive: true });

  try {
    // 不用 for 循环：这个项目打包后，循环头部紧跟着的 node 模块调用会出错（打包时有检查）
    await Promise.all(input.files.map((file: { name: string; data: string }): Promise<void> => (
      fsP.writeFile(path.join(dir, file.name), Buffer.from(file.data, 'base64')))));

    const stdout: string = await new Promise((resolve: (value: string) => void, reject: (reason: Error) => void): void => {
      const child: ChildProcessWithoutNullStreams = spawn(options.command || agyDefaults.command, [
        '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', options.model || agyDefaults.model,
        '--sandbox', '--print-timeout', PRINT_TIMEOUT, '-p='
      ], { cwd: dir, windowsHide: true });
      const out: Array<Buffer> = [];
      let err: string = '';

      function handleAbort(): void {
        child.kill();
      }

      signal?.addEventListener('abort', handleAbort, { once: true });
      child.stdout.on('data', (data: Buffer): number => out.push(data));
      child.stderr.on('data', (data: Buffer): void => {
        err = (err + data.toString('utf8')).slice(-2_000);
      });
      child.stdin.on('error', (): void => { /* agy 提前退出时写入会报错，结果由 close 处理 */ });
      child.on('error', (error: NodeJS.ErrnoException): void => {
        signal?.removeEventListener('abort', handleAbort);
        reject(error.code === 'ENOENT' ? new Error('找不到 agy（Antigravity 的命令行）。先装好并登录，或者在设置里把「Gemini 走哪里」改回 API') : error);
      });
      child.on('close', (code: number | null): void => {
        signal?.removeEventListener('abort', handleAbort);

        if (signal?.aborted) {
          reject(new AgyStopped());
        } else if (out.length === 0 && code !== 0) {
          reject(new Error(`agy 出错（退出码 ${ code }）：${ err.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? '' }`));
        } else {
          resolve(Buffer.concat(out).toString('utf8'));
        }
      });
      child.stdin.end(`${ JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: input.prompt }] } }) }\n`);
    });

    const answer: unknown = readAgyResult(stdout);
    const required: unknown = ask.schema.required;

    // 最外层该有的字段没有：当成格式不对（调用的地方会再问一次）
    if (Array.isArray(required) && (answer === null || typeof answer !== 'object' || required.some((key: unknown): boolean => !(String(key) in (answer as object))))) {
      throw new Error(`agy 返回的内容缺少字段（要有 ${ required.join('、') }）`);
    }

    return answer as T;
  } finally {
    await fsP.rm(dir, { recursive: true, force: true }).catch((): void => undefined);
  }
}
