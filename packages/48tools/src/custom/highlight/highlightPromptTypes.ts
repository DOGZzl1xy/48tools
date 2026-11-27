import type { AudioWindow, Highlight } from './highlightTypes';
import type { StageInfo } from './highlightStageAss';

/**
 * 录播自动切片里问 Gemini 的提示词是一套可以换的「提示词包」：这里只规定它要给出什么。
 * 程序自带的在 ../basic/highlightPrompts，也可以来自同步下来的内容包（见 ../basic/README.md）。
 * 怎么把提示词和音频、格式拼成请求、怎么读结果，在 ./highlightGemini、./highlightStage。
 */
export interface LiveMeta {
  member: string;
  title: string;
  glossary?: string; // 专有词汇那一段提示（见 ./highlightGlossary 的 glossaryPrompt），没有就不加
  members?: string;  // 成员名单那一段提示（见 ./highlightMembers 的 membersPrompt）
}

/* 第 1 步：找爆点 */
export interface FindPromptInput {
  meta: LiveMeta;
  window: AudioWindow;   // 录播的哪一段
  danmuText: string;     // 这一段里的弹幕，一行一条「MM:SS 内容」（时间从这段音频的开头算）；没有弹幕时是空字符串
  heat: Array<string>;   // 程序数出来的弹幕突然变多的时刻（./highlightTime 的 danmuHeat）
  quotes: boolean;       // 要不要每个爆点开头、结尾的原话（first、last）：走 agy 时要
  knowledge: string;     // 附在最后的常识：称呼、专有词汇、成员名单（./highlightGemini 的 knowledge）
}

/* 第 1 步（公演版）：还要分三类 kind（mc / mistake / song），给 song、singers、reaction */
export interface StageFindPromptInput extends FindPromptInput {
  stage: StageInfo;
}

/* 第 2 步：一个片段的逐句字幕、留不留、标题、简介、看点 */
export interface ScriptPromptInput {
  meta: LiveMeta;
  highlight: Highlight;
  clipLength: number;     // 这段音频有多少秒
  danmu: Array<string>;   // 这段时间里的弹幕（只有内容）
  note?: string;          // 上一次剪出来不合要求时，告诉模型哪里不对
  stage?: StageInfo;      // 公演 MC 的切片
  knowledge: string;
}

/* 公演里唱歌、失误的片段：只问标题 */
export interface StageTitlesPromptInput {
  meta: LiveMeta;
  highlight: Highlight;
  stage: StageInfo;
  knowledge: string;
}

export interface HighlightPrompts {
  pronoun: string;         // 称呼的规则，附在每个提示后面；没有就给空字符串
  defaultGlossary: string; // 专有词汇文件第一次用时写进去的内容（./glossaryFile）
  find(input: FindPromptInput): string;
  stageFind(input: StageFindPromptInput): string;
  script(input: ScriptPromptInput): string;
  stageTitles(input: StageTitlesPromptInput): string;
  photoRank(member: string, count: number): string; // 电台切片的封面照片排序
  cover(count: number): string;                     // 几张截图里挑一张做封面
}
