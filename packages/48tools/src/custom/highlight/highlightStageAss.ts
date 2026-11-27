import { pack } from '../sync/packRegistry';
import type { Strip } from './highlightAssCore';
import type { StageCoverInput, StageTitleAssInput, StageVideoAssInput } from './highlightStageCore';

/**
 * 公演切片的画面排版。尺寸、分行、滤镜这些在 ./highlightStageCore（这里原样转出去）；
 * 侧栏、字幕、弹幕、封面具体长什么样从 ../sync/packRegistry 取（默认的那份在 ../basic/highlightStageStyle），下面四个函数只是转过去。
 */
export * from './highlightStageCore';

export function stageTitleStrip(): Strip {
  return pack().stageStyle.stageTitleStrip();
}

export function buildStageTitleAss(input: StageTitleAssInput): string {
  return pack().stageStyle.buildStageTitleAss(input);
}

export function buildStageVideoAss(input: StageVideoAssInput): string {
  return pack().stageStyle.buildStageVideoAss(input);
}

export function buildStageCoverAss(input: StageCoverInput): string {
  return pack().stageStyle.buildStageCoverAss(input);
}
