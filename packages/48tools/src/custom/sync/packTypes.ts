import type { HighlightPrompts } from '../highlight/highlightPromptTypes';
import type { HighlightGraphics } from '../highlight/highlightGraphicsTypes';
import type { TeamVisualTokens } from '../highlight/highlightColor';
import type { LiveStyle } from '../highlight/highlightAssCore';
import type { StageStyle } from '../highlight/highlightStageCore';

/**
 * 个性化设置的「内容包」：切片的提示词、画面排版、配色，加上几项配置，可以放在自己的服务器上，各台设备启动时同步下来（见 ./packSync）。
 * 程序里自带一份默认的（../basic），没有同步到内容包时用它。这里规定内容包要给出什么。
 * 接口有不兼容的改动时把 PACK_API 加一：程序不会装上版本对不上的包。
 */
export const PACK_API: number = 1;

export interface PackConfig {
  glossary?: string;                        // 专有词汇：给了就用它，不读本机的 专有词汇.txt
  gongyanTeams: Array<string>;              // B 站公演自动录制：录哪些队
  gongyanWindows: Array<[number, number]>;  // 北京时间（从 0 点起的分钟）：这些时间段里查有没有开播
  teamColors: Record<string, string>;       // 各队的主色（#rrggbb），队名是 SII、NII 这样的写法
  stageTeamTags: Record<string, string>;    // 公演切片发布用的标题前面，队伍怎么叫；没写的直接用队名
}

export interface PackModules {
  prompts: HighlightPrompts;
  graphics: HighlightGraphics;
  palette: { deriveTeamTokens(hex: string): TeamVisualTokens };
  liveStyle: LiveStyle;
  stageStyle: StageStyle;
  config: PackConfig;
}

/* 内容包可以只给一部分，没给的用默认的；config 也是没给的项用默认的 */
export type PackContent = Partial<Omit<PackModules, 'config'>> & { config?: Partial<PackConfig> };

/* 和包一起发的说明：签名签的就是它（见 ./packVerify） */
export interface PackManifest {
  api: number;          // 对应 PACK_API
  version: string;      // 这一版的名字（打包的时间）
  sha256: string;       // 包文件的 SHA-256（十六进制）
  size: number;         // 包文件的字节数
  createdAt: string;    // 打包时间（ISO）
  expiresAt?: string;   // 签名到什么时候为止（ISO）；过了只提示，不停用
}

export interface SignedManifest {
  manifest: PackManifest;
  signature: string;    // Ed25519 签名（base64），签的是 manifestText(manifest)
}
