import { teamLabel } from '../room/memberSearch';
import { pack } from '../sync/packRegistry';
import type { TeamVisualTokens } from './highlightColor';

export { hexWithAlpha, hslToHex, type TeamVisualTokens } from './highlightColor';

/**
 * 自动切片（公演 / 电台 / 直播）的队伍配色：哪个队是什么颜色，队伍名怎么认。
 * 支持 SNH48 / GNZ48 / BEJ48 / CKG48 全部 11 支队伍；预备生及未知队伍统一使用 SII 蓝（#8fc8eb）。
 * 各队的主色在配置里（../sync/packTypes 的 teamColors）；一个主色怎么算出画面上用的整套颜色见下面的 deriveTeamTokens。
 */
export const DEFAULT_TEAM_COLOR: string = '#8fc8eb'; // 预备生与未知队伍统一使用 SII 蓝

export interface ResolvedTeam {
  code: string;      // 规范化队伍代码（SII / NII / NIII / 预备生 …），未知时为空字符串
  badge: string;     // 画面上显示的徽章文案：TEAM SII / TEAM NIII / 预备生（不带 SNH48 等团名前缀）
  color: string;     // 队伍主色 #rrggbb
}

/* 成员名去掉前面的团名：SNH48 刘诗彤 / GNZ48-郑丹妮 → 刘诗彤 / 郑丹妮 */
export function shortMemberName(member: string): string {
  return member.replace(/^(?:SNH|GNZ|BEJ|CKG|CGT|SHY|IDFT)48[-\s]+/i, '').trim() || member.trim();
}

/* 在成员名单里按名字查队伍短名（重名时不猜） */
export function memberTeamOf(members: Array<{ name: string; team?: string }>, member: string): string | undefined {
  const short: string = shortMemberName(member);
  const matched: Array<{ name: string; team?: string }> = members.filter((item: { name: string; team?: string }): boolean => item.name === short);

  return matched.length === 1 ? (teamLabel(matched[0].team) || undefined) : undefined;
}

/* 解析队伍名与对应颜色；N3 自动规范为 NIII，预备生及未识别队伍统一回退到 SII 蓝 */
export function resolveTeam(raw?: string, explicitColor?: string): ResolvedTeam {
  const stripped: string = teamLabel((raw ?? '').replace(/^(?:SNH|GNZ|BEJ|CKG|CGT|SHY)48\s+/i, '').trim());
  const upper: string = stripped.toUpperCase();
  const normalized: string = upper === 'N3' ? 'NIII' : upper;

  const colors: Record<string, string> = pack().config.teamColors;

  if (normalized && normalized in colors) {
    return {
      code: normalized,
      badge: `TEAM ${ normalized }`,
      color: explicitColor || colors[normalized]
    };
  }

  if (stripped.includes('预备生')) {
    return { code: '预备生', badge: '预备生', color: explicitColor || DEFAULT_TEAM_COLOR };
  }

  if (stripped) {
    return { code: stripped, badge: stripped, color: explicitColor || DEFAULT_TEAM_COLOR };
  }

  return { code: '', badge: '', color: explicitColor || DEFAULT_TEAM_COLOR };
}

export function teamColorOf(raw?: string): string {
  return resolveTeam(raw).color;
}

/* 一个队伍主色算出画面上用的整套颜色（怎么算从 ../sync/packRegistry 取，默认的那份在 ../basic/highlightPalette） */
export function deriveTeamTokens(hex: string): TeamVisualTokens {
  return pack().palette.deriveTeamTokens(hex);
}
