/**
 * 录播自动切片用到的数据类型（见 ./highlightPipeline 开头的说明）。
 */
/* 一条弹幕：time 是它在录播里出现的时间（秒） */
export interface DanmuLine {
  time: number;
  nickname: string;
  message: string;
}

/* 模型找到的一个爆点：start、end 是在整场录播里的时间（秒） */
export interface Highlight {
  start: number;
  end: number;
  title: string;
  cover: string;
  quote: string;
  reason: string;
  score: number; // 1 ~ 10
}

/* 片段里的一句话：start、end 是在这个片段的音频里的时间（秒） */
export interface CaptionLine {
  start: number;
  end: number;
  text: string;
  keep: boolean;            // 留在成片里
  emphasis: Array<string>;  // 这一句里要加粗的词
}

/* 模型给一个片段写的东西：逐句字幕、标题、简介、封面上的看点 */
export interface ClipScript {
  lines: Array<CaptionLine>;
  title: string;
  description: string;
  points: Array<string>;
  people?: Array<string>; // 除了主播以外的主角（连麦的人、被认真讨论的成员），标题里会带上；以前存下来的结果里没有这一项
}

/* 成片里连续的一段：from、to 是句子的下标，start、end 是片段里的时间，out 是它在成片里开始的时间 */
export interface Segment {
  from: number;
  to: number;
  start: number;
  end: number;
  out: number;
}

export interface Silence {
  start: number;
  end: number;
}

/* 分析时一次交给模型的一段录播 */
export interface AudioWindow {
  start: number;
  length: number;
}

/* 做几个切片：数字，或者让程序按爆点分数决定 */
export type HighlightCount = number | 'auto';
