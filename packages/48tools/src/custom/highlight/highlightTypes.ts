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
  edited?: boolean; // 标题或说明被挑片的人改过（./highlightShow）：写字幕时以改过的为准
  coverTitle?: string; // 挑片的人自己取的标题：画面、封面、文件名照它写，发布用的标题（.txt）还是 Gemini 起（用户 2026-11-24 定的）
  first?: string; // 开头、结尾的原话：只有走 agy 时才要（它说的时间不准，用原话到本地识别的结果里找时间，见 ./highlightQuotes）
  last?: string;
  // 下面这些只有公演切片有（见 ./highlightStage）
  kind?: StageKind;
  song?: string;               // 歌名（kind 是 song 时）
  singers?: Array<string>;     // 演唱的成员
  coverLines?: Array<string>;  // 封面上的 1 ~ 3 行大字（按需要），【】里的词下面刷荧光笔
  reaction?: number;           // 失误：模型从弹幕里抄的代表性反应的时间（在录像里的秒数），按它找弹幕的高峰（见 ./highlightStageTiming）
  timing?: string;             // 失误、唱歌的起止是怎么定的（写进切片说明）
}

/* 公演切片的三类：MC 环节的爆点、表演中的失误、组合有特色的一整首歌 */
export type StageKind = 'mc' | 'mistake' | 'song';

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
  title: string;           // 发布用的标题（titles 的第一个）；画面和封面上也用它，挑片的人自己取了标题（coverTitle）的除外
  titles?: Array<string>;  // 模型给的三个不同风格的标题，让发视频的人挑；以前存下来的结果里没有这一项
  more?: Array<string>;    // 片段里另外的爆点的短标题（最多两个），发布用的标题里接在主标题后面
  description: string;
  points: Array<string>;
  people?: Array<string>; // 除了主播以外的主角（连麦的人、被认真讨论的成员），标题里会带上；以前存下来的结果里没有这一项
}

/**
 * 写好、等人定标题的一个切片（用户 2026-11-24 定的：Gemini 写完字幕、标题、亮点先停下来，人定好了再渲染，不满意不用返工）。
 * 上半是写字幕那一步的结果，下半是人定的；存在爆点清单里（./highlightShow 的 ShowItem），渲染完也留着，改标题时用
 */
export interface ClipDraft {
  key: string;                   // 封面候选的画面存在哪个文件夹里（见 ./highlightCover 的 coverDir）
  basis: string;                 // 照爆点的哪个标题和说明写的（之后又改了说明，要重新写才会用上）
  start: number;                 // 录播里从第几秒开始、多长的一段；lines 的时间从这里算
  length: number;
  whole?: boolean;               // 公演的唱歌、失误：整段保留，没有字幕
  lines: Array<CaptionLine>;     // 这一段里的全部句子，时间对好了；字可以改
  timing: string;                // 字幕的时间是怎么定的（写在说明里）
  titles: Array<string>;         // Gemini 起的，最多三个
  more: Array<string>;
  description: string;
  points: Array<string>;         // Gemini 写的亮点
  people: Array<string>;
  frames: Array<number>;         // 从录播里取的封面候选：在成片里的时间（秒）
  pictures?: Array<string>;      // 别的封面候选，排在 frames 后面：自己上传的、播放时选的一帧（存在 coverDir 里的文件名），电台封面库里的照片（完整路径）
  title: string;                 // 定的标题：画面、封面、文件名用它
  ownTitle?: string;             // 自己写过的标题（选回 Gemini 的也记着，还能再选上）
  frame: number;                 // 封面用第几个候选（从 0 起；frames 的在前，pictures 的接在后面）
  ownPoints?: Array<string>;     // 改过的亮点
  ownCoverLines?: Array<string>; // 公演：改过的封面大字
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
