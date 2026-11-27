import { contrast } from '../theme/accent';
import { teamLabel } from '../room/memberSearch';

/**
 * 自动切片（公演 / 电台 / 直播）的统一队伍配色与视觉色板计算。
 * 支持 SNH48 / GNZ48 / BEJ48 / CKG48 全部 11 支队伍；预备生及未知队伍统一使用 SII 蓝（#8fc8eb）。
 * 从单一队伍主色 Hex 自动推算：
 *   - 徽章底色与高对比字色（自动切换纯白或深色墨字，避免中暗色配黑字发脏）
 *   - 公演斜切渐变荧光笔（针对明黄/黄绿高明度色自动压深，保证白字清晰）
 *   - 电台暖白画报的淡彩晕染与深色序号墨字
 *   - 直播/公演通透丝绒光瀑（带暗部色相偏移 Hue Shifting，防止橙/黄绿暗部发褐发闷）
 */
export const DEFAULT_TEAM_COLOR: string = '#8fc8eb'; // 预备生与未知队伍统一使用 SII 蓝

export const HIGHLIGHT_TEAM_COLORS: Record<string, string> = {
  SII: '#8fc8eb',
  NII: '#af83bb',
  HII: '#f49604',
  X: '#a9ca27',
  G: '#abc813',
  NIII: '#f6cd22',
  N3: '#f6cd22',
  Z: '#ec607c',
  B: '#e7316c',
  E: '#1bb5b5',
  C: '#ffb715',
  K: '#f25554'
};

export interface ResolvedTeam {
  code: string;      // 规范化队伍代码（SII / NII / NIII / 预备生 …），未知时为空字符串
  badge: string;     // 画面上显示的徽章文案：TEAM SII / TEAM NIII / 预备生（不带 SNH48 等团名前缀）
  color: string;     // 队伍主色 #rrggbb
}

export interface TeamVisualTokens {
  hex: string;
  onTeam: string;
  darkInk: string;
  hlStart: string;
  hlEnd: string;
  stageTint: string;
  radioAccentDark: string;
  radioWash: string;
  velvetBloom: string;
  velvetMid: string;
  velvetDeep: string;
  velvetAccent: string;
  mhStart: string;
  mhEnd: string;
  mhSub: string;
  mhBorder: string;
  mhBoxBorder: string;
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

  if (normalized && normalized in HIGHLIGHT_TEAM_COLORS) {
    return {
      code: normalized,
      badge: `TEAM ${ normalized }`,
      color: explicitColor || HIGHLIGHT_TEAM_COLORS[normalized]
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

type Rgb = [number, number, number];
type Hsl = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const clean: string = hex.replace('#', '').padStart(6, '0');

  return [0, 2, 4].map((offset: number): number => Number.parseInt(clean.slice(offset, offset + 2), 16)) as Rgb;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn: number = r / 255;
  const gn: number = g / 255;
  const bn: number = b / 255;
  const max: number = Math.max(rn, gn, bn);
  const min: number = Math.min(rn, gn, bn);
  const l: number = (max + min) / 2;
  let h: number = 0;
  let s: number = 0;

  if (max !== min) {
    const d: number = max - min;

    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    if (max === rn) h = (((gn - bn) / d) + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = (((bn - rn) / d) + 2) * 60;
    else h = (((rn - gn) / d) + 4) * 60;
  }

  return [h, s, l];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue: number = ((h % 360) + 360) % 360;
  const sat: number = clamp(s, 0, 1);
  const light: number = clamp(l, 0, 1);
  const c: number = (1 - Math.abs((2 * light) - 1)) * sat;
  const x: number = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m: number = light - (c / 2);
  let rgb: Rgb;

  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return `#${ rgb.map((part: number): string => Math.round((part + m) * 255).toString(16).padStart(2, '0')).join('') }`;
}

export function hexWithAlpha(hex: string, alpha: number): string {
  const [r, g, b]: Rgb = hexToRgb(hex);

  return `rgba(${ r }, ${ g }, ${ b }, ${ clamp(alpha, 0, 1).toFixed(3) })`;
}

/**
 * 从单一队伍主色 Hex 自动推算整套视觉色板（公演 / 电台 / 直播通用）
 */
export function deriveTeamTokens(hex: string): TeamVisualTokens {
  const [h, s, l]: Hsl = rgbToHsl(...hexToRgb(hex));

  // 暗部色相微偏（Hue Shifting）：让黄绿偏翠绿、橙黄偏暖琥珀、粉红/红偏酒红莓果，避免暗丝绒发褐发脏
  let shadowShift: number = 0;

  if (h >= 56 && h <= 108) shadowShift = 20;
  else if (h >= 36 && h < 56) shadowShift = -14;
  else if (h >= 15 && h < 36) shadowShift = -12;
  else if (h < 15 || h >= 330) shadowShift = -10;
  else if (h >= 160 && h <= 225) shadowShift = 10;

  const darkInk: string = hslToHex(h + (shadowShift * 0.4), clamp(s * 0.68, 0.35, 0.72), 0.11);
  // 与纯白对比度 >= 2.8（例如 NII 紫、Z 桃粉、B 玫红、K 珊瑚红）一律走纯白字，彻底杜绝发脏
  const onTeam: string = contrast('#ffffff', hex) >= 2.8 ? '#ffffff' : darkInk;
  const isBrightYellowRange: boolean = h >= 38 && h <= 100;
  const hlStartL: number = isBrightYellowRange ? 0.36 : 0.42;
  const hlEndL: number = isBrightYellowRange ? 0.46 : 0.55;
  const bloomL: number = isBrightYellowRange ? 0.37 : 0.43;

  return {
    hex,
    onTeam,
    darkInk,
    hlStart: hslToHex(h + (shadowShift * 0.35), clamp(s * 1.05, 0.58, 0.90), hlStartL),
    hlEnd: hslToHex(h + (shadowShift * 0.12), clamp(s * 1.0, 0.54, 0.86), hlEndL),
    stageTint: hslToHex(h, clamp(s * 0.9, 0.45, 0.85), 0.90),
    radioAccentDark: hslToHex(h + (shadowShift * 0.35), clamp(s * 0.95, 0.48, 0.85), isBrightYellowRange ? 0.27 : 0.31),
    radioWash: hslToHex(h, clamp(s * 0.85, 0.40, 0.78), 0.68),
    velvetBloom: hslToHex(h + (shadowShift * 0.15), clamp(s * 0.92, 0.44, 0.80), bloomL),
    velvetMid: hslToHex(h + (shadowShift * 0.55), clamp(s * 0.76, 0.34, 0.66), 0.21),
    velvetDeep: hslToHex(h + shadowShift, clamp(s * 0.58, 0.26, 0.50), 0.105),
    velvetAccent: hslToHex(h, clamp(s * 0.92, 0.52, 0.88), 0.78),
    mhStart: onTeam === '#ffffff'
      ? hslToHex(h + (shadowShift * 0.2), clamp(s * 1.12, 0.44, 0.82), 0.44)
      : hslToHex(h, clamp(s * 0.96, 0.55, 0.90), clamp(l - 0.05, 0.44, 0.72)),
    mhEnd: onTeam === '#ffffff'
      ? hslToHex(h, clamp(s * 1.0, 0.40, 0.76), 0.60)
      : hslToHex(h, clamp(s * 0.95, 0.55, 0.90), clamp(l + 0.06, 0.52, 0.80)),
    mhSub: onTeam === '#ffffff' ? 'rgba(255, 255, 255, 0.86)' : hexWithAlpha(darkInk, 0.74),
    mhBorder: onTeam === '#ffffff' ? 'rgba(255, 255, 255, 0.48)' : hexWithAlpha(darkInk, 0.34),
    mhBoxBorder: onTeam === '#ffffff' ? 'rgba(255, 255, 255, 0.86)' : darkInk
  };
}
