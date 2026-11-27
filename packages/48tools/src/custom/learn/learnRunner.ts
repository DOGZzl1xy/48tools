import { getSetting } from '../settings/settingsStore';
import { highlightGeminiConfig } from '../highlight/highlightTask';
import { readGlossaryFile } from '../highlight/glossaryFile';
import { askGemini, runLearning, startLearnWatcher, LEARN_EVERY_DAYS, type LearnDeps, type LearnStatus } from './learnTask';

/**
 * 持续学习在程序里实际用的那一套：开关和间隔读设置，Gemini 用录播切片的那一份配置（key、模型、走接口还是 agy）。
 * 接入点：shell/AppShell（启动）、./LearnOption（设置页）。
 */
export const learnDeps: LearnDeps = {
  enabled: (): boolean => getSetting('learnAuto') !== false,
  everyDays: (): number => Math.max(1, Number(getSetting('learnDays')) || LEARN_EVERY_DAYS),
  gemini: highlightGeminiConfig,
  glossary: readGlossaryFile,
  now: (): number => Date.now(),
  ask: askGemini
};

export function startLearning(): void {
  startLearnWatcher(learnDeps);
}

/* 设置页的「现在学一次」 */
export function learnNow(): Promise<LearnStatus> {
  return runLearning(learnDeps, true);
}
