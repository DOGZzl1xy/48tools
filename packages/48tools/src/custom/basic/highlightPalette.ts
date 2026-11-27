import { contrast } from '../theme/accent';
import type { TeamVisualTokens } from '../highlight/highlightColor';

/**
 * 一个队伍主色算出切片画面用的整套颜色：程序自带的默认算法。
 * 只分「队伍色」和几档中性的深灰、浅灰，队伍色上的字按对比度选白或深色；没有按色相调过，够用、不讲究。
 * 想用自己的配色：照这个文件做成内容包里的 palette 模块，见 ./README.md。
 */
const INK: string = '#1f1f1f';
const WHITE: string = '#ffffff';

export function deriveTeamTokens(hex: string): TeamVisualTokens {
  const whiteOnTeam: boolean = contrast(WHITE, hex) >= 2.8;

  return {
    hex,
    onTeam: whiteOnTeam ? WHITE : INK,       // 队伍色底上的字
    darkInk: INK,
    hlStart: '#3d3d3d',                      // 白字下面的荧光笔：统一用深灰，什么队伍色都看得清
    hlEnd: '#4a4a4a',
    stageTint: '#f2f2f2',
    radioAccentDark: INK,                    // 浅底上的强调色
    radioWash: hex,
    velvetBloom: '#3a3a3a',                  // 深色底的三档
    velvetMid: '#262626',
    velvetDeep: '#161616',
    velvetAccent: hex,                       // 深色底上的强调色
    mhStart: hex,                            // 标题栏的底
    mhEnd: hex,
    mhSub: whiteOnTeam ? 'rgba(255, 255, 255, 0.86)' : 'rgba(31, 31, 31, 0.74)',
    mhBorder: whiteOnTeam ? 'rgba(255, 255, 255, 0.48)' : 'rgba(31, 31, 31, 0.34)',
    mhBoxBorder: whiteOnTeam ? 'rgba(255, 255, 255, 0.86)' : INK
  };
}
