import { prompts } from '../basic/highlightPrompts';
import { graphics } from '../basic/highlightGraphics';
import { deriveTeamTokens } from '../basic/highlightPalette';
import { liveStyle } from '../basic/highlightLiveStyle';
import { stageStyle } from '../basic/highlightStageStyle';
import { config } from '../basic/packConfig';
import type { PackContent, PackModules } from './packTypes';

/**
 * 现在用的是哪一份提示词、排版、配色和配置：默认是程序自带的（../basic），同步到内容包以后换成包里的（./packSync 调 installPack）。
 * 用的地方每次都从 pack() 取，所以换上以后马上生效，不用重启。
 */
const builtin: PackModules = { prompts, graphics, palette: { deriveTeamTokens }, liveStyle, stageStyle, config };
let active: PackModules = builtin;
const listeners: Set<() => void> = new Set();

export function pack(): PackModules {
  return active;
}

/* 换上内容包里的：没给的部分用自带的 */
export function installPack(content: PackContent): void {
  active = { ...builtin, ...content, config: { ...builtin.config, ...content.config } };
  listeners.forEach((listener: () => void): void => listener());
}

/* 换回自带的 */
export function resetPack(): void {
  active = builtin;
  listeners.forEach((listener: () => void): void => listener());
}

export function isBuiltinPack(): boolean {
  return active === builtin;
}

export function onPackChange(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => void listeners.delete(listener);
}
