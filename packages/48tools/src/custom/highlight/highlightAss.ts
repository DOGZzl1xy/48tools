import { pack } from '../sync/packRegistry';
import type { CoverInput, Strip, TitleAssInput, VideoAssInput } from './highlightAssCore';

/**
 * 录播自动切片的画面排版（直播、电台）。尺寸、估字宽、分行、滤镜这些在 ./highlightAssCore（这里原样转出去）；
 * 标题、字幕、弹幕、封面具体长什么样从 ../sync/packRegistry 取（默认的那份在 ../basic/highlightLiveStyle），下面四个函数只是转过去。
 */
export * from './highlightAssCore';

export function titleStrip(tag: string): Strip {
  return pack().liveStyle.titleStrip(tag);
}

export function buildTitleAss(input: TitleAssInput): string {
  return pack().liveStyle.buildTitleAss(input);
}

export function buildVideoAss(input: VideoAssInput): string {
  return pack().liveStyle.buildVideoAss(input);
}

export function buildCoverAss(input: CoverInput): string {
  return pack().liveStyle.buildCoverAss(input);
}
