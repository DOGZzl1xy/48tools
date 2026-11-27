import type { StageInfo } from './highlightStageAss';

/**
 * 切片的封面和成片底图可以由一套「画面包」直接画出来（在程序窗口里用 Canvas）：这里只规定它要给出什么。
 * 程序自带的在 ../basic/highlightGraphics：什么都不画，全部返回 null，封面和成片就走 ffmpeg + ASS 的画法
 * （./highlightAss、./highlightStageAss）。也可以来自同步下来的内容包（见 ../basic/README.md）。
 */
export interface GraphicsMeta {
  member: string;
  date: string;
  radio?: boolean;
  team?: string;
  teamColor?: string;
  stage?: StageInfo;
}

export interface PatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoverInput {
  frameFile: string;     // 封面用的那一帧（jpg）
  meta: GraphicsMeta;
  title: string;
  points: Array<string>; // 封面上的看点
  width: number;         // 1920（16:9）或 1440（4:3），高都是 1080
}

export interface StageCoverInput {
  frameFile: string;
  stage: StageInfo;
  lines: Array<string>;  // 封面上的大字，一行一个；【】里的词要突出
  width: number;
}

/* 每一个都可以返回 null：这一张不画，调用的地方改用 ffmpeg + ASS */
export interface HighlightGraphics {
  stageCover(input: StageCoverInput): Promise<Buffer | null>; // 公演切片的封面（jpg）
  radioCover(input: CoverInput): Promise<Buffer | null>;      // 电台切片的封面
  liveCover(input: CoverInput): Promise<Buffer | null>;       // 直播切片的封面
  videoBackdrop(meta: GraphicsMeta, title: string): Promise<Buffer | null>; // 成片的底图（1920×1080 的 png，画面、字幕、弹幕叠在上面）
  retitlePatch(meta: GraphicsMeta, title: string): Promise<{ buffer: Buffer; rect: PatchRect } | null>; // 渲染完改标题：只画标题那一块
}
