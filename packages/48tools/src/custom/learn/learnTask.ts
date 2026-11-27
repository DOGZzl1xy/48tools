import { geminiJson, type GeminiConfig } from '../highlight/highlightGemini';
import { digestRecords, hasDecisions, type ShowRecord } from './learnRecord';
import { learnRequest, readLearnAnswer, type LearnAnswer } from './learnPrompt';
import {
  appendAdvice, learnDir, readBackground, readRecords, readState, writeBackground, writeState, type LearnState
} from './learnStore';

/**
 * 持续学习：每隔几天（默认 3 天）把这段时间里切片的记录交给 Gemini 一次，让它更新背景文档。
 *   - 记录：每次保存切片清单时存下来（./learnStore 的 saveShowRecord）
 *   - 学习：到时间了、而且上次学习以后有新的记录，才问一次（只有文字，没有音频，很便宜）
 *   - 结果：背景文档（附在以后每次的提示后面，见 ./learnPrompt 的 learnedPrompt）；关于提示词本身的建议只存下来，不自动用
 * 程序开着时每 6 小时看一眼到没到时间；设置页「录播切片 → 持续学习」可以关掉，也可以马上学一次。
 */
export const LEARN_EVERY_DAYS: number = 3;
const CHECK_EVERY: number = 6 * 3_600_000;
const FIRST_CHECK_AFTER: number = 3 * 60_000;

export interface LearnDeps {
  enabled: () => boolean;
  everyDays: () => number;
  gemini: () => GeminiConfig;
  glossary: () => string;
  now: () => number;
  ask: (config: GeminiConfig, input: { background: string; digest: string; glossary: string }) => Promise<LearnAnswer>;
}

export interface LearnStatus {
  running: boolean;
  records: number;     // 存着几场的记录（人做过决定的）
  fresh: number;       // 其中上次学习以后有变化的
  state: LearnState;
}

let status: LearnStatus = { running: false, records: 0, fresh: 0, state: { learnedAt: 0 } };
const listeners: Set<() => void> = new Set();

export function getLearnStatus(): LearnStatus {
  return status;
}

export function onLearnStatus(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => void listeners.delete(listener);
}

function setStatus(next: LearnStatus): void {
  status = next;
  listeners.forEach((listener: () => void): void => listener());
}

/* 上次学习以后有变化的记录 */
export function freshRecords(records: Array<ShowRecord>, state: LearnState): Array<ShowRecord> {
  return records.filter((record: ShowRecord): boolean => hasDecisions(record) && record.savedAt > state.learnedAt);
}

/* 该不该学：隔够了天数，而且有新的记录 */
export function learnDue(records: Array<ShowRecord>, state: LearnState, now: number, everyDays: number): boolean {
  return now - state.learnedAt >= everyDays * 86_400_000 && freshRecords(records, state).length > 0;
}

export async function refreshLearnStatus(): Promise<LearnStatus> {
  const [records, state]: [Array<ShowRecord>, LearnState] = await Promise.all([readRecords(), readState()]);
  const decided: Array<ShowRecord> = records.filter(hasDecisions);

  setStatus({ ...status, records: decided.length, fresh: freshRecords(decided, state).length, state });

  return status;
}

/**
 * 学一次
 * @param { LearnDeps } deps
 * @param { boolean } force - 不管隔了几天（设置页的「现在学一次」）；没有新记录时照样不学
 * @return { Promise<LearnStatus> }
 */
export async function runLearning(deps: LearnDeps, force: boolean = false): Promise<LearnStatus> {
  if (status.running || !learnDir()) return status;

  const [records, state]: [Array<ShowRecord>, LearnState] = await Promise.all([readRecords(), readState()]);
  const fresh: Array<ShowRecord> = freshRecords(records, state);

  if (fresh.length === 0 || (!force && !learnDue(records, state, deps.now(), deps.everyDays()))) return refreshLearnStatus();

  setStatus({ ...status, running: true });

  let next: LearnState;

  try {
    const answer: LearnAnswer = await deps.ask(deps.gemini(), { background: readBackground(), digest: digestRecords(fresh), glossary: deps.glossary() });

    if (answer.background === '') throw new Error('没有给出背景文档');

    await writeBackground(answer.background, deps.now());
    await appendAdvice(answer.promptAdvice, deps.now());
    next = { learnedAt: deps.now(), summary: answer.summary, shows: fresh.length };
  } catch (err) {
    // 没学成：记下原因，时间不动，下次到点再试
    next = { ...state, error: (err as Error)?.message ?? String(err) };
  }

  await writeState(next);
  setStatus({ ...status, running: false });

  return refreshLearnStatus();
}

let timer: ReturnType<typeof setInterval> | undefined;

/* 程序启动后调一次（shell/AppShell）：过几分钟看一眼，以后每 6 小时看一眼到没到时间 */
export function startLearnWatcher(deps: LearnDeps): void {
  if (timer || !learnDir()) return;

  const check: () => void = (): void => {
    if (deps.enabled()) void runLearning(deps).catch((err: unknown): void => console.error('持续学习出错', err));
    else void refreshLearnStatus();
  };

  setTimeout(check, FIRST_CHECK_AFTER);
  timer = setInterval(check, CHECK_EVERY);
}

/* 真的去问 Gemini 的那个 ask */
export async function askGemini(config: GeminiConfig, input: { background: string; digest: string; glossary: string }): Promise<LearnAnswer> {
  return readLearnAnswer(await geminiJson<unknown>(config, learnRequest(input)));
}

/* 测试用 */
export function resetLearnForTest(): void {
  status = { running: false, records: 0, fresh: 0, state: { learnedAt: 0 } };
}
