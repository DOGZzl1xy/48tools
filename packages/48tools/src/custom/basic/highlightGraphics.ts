import type { HighlightGraphics } from '../highlight/highlightGraphicsTypes';

/**
 * 切片的封面和成片底图：程序自带的默认内容什么都不画（全部返回 null），
 * 封面和成片走 ffmpeg + ASS 的画法（../highlight/highlightAss、../highlight/highlightStageAss、../highlight/highlightCover）。
 * 想用 Canvas 画自己的设计：照 ../highlight/highlightGraphicsTypes 做成内容包里的 graphics 模块，见 ./README.md。
 */
function none(): Promise<null> {
  return Promise.resolve(null);
}

export const graphics: HighlightGraphics = {
  stageCover: none,
  radioCover: none,
  liveCover: none,
  videoBackdrop: none,
  retitlePatch: none
};
