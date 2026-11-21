/**
 * 颜色的统一来源：设置页「外观 → 主题色」里可选的颜色、由主题色算出来的几种用法，以及用来区分类别的团队色。
 *
 * 主题色的三种用法（accentTokens）：
 *   - primary：按钮、开关、进度条、选中的边框和底色，就是选的那个颜色
 *   - text：用主题色写字（链接、选中的文字、「进行中」的标签）。浅的颜色在白底上看不清（例如 SII 蓝），
 *     自动加深到看得清；深色模式下反过来调亮
 *   - onPrimary：主题色底上的文字。颜色太浅、白字看不清时（SII 蓝、X 绿）用深色字
 * 团队色：SII 蓝 #8fc8eb、NII 紫 #af83bb、HII 橙 #f49604、X 绿 #a9ca27，既是可选的主题色（明暗模式下都用原色），
 * 也用来区分类别（直播类型等标签，见 ./TeamTag 和 ./theme.global.sass）。
 * 界面里需要颜色时用这里的值或根元素上的 CSS 变量（--accent、--accent-text、--accent-on、--team-*），不要另外写死颜色；
 * 成功 / 失败 / 警告用 antd 的语义色（colorSuccess、colorError、colorWarning）。
 * 接入点：components/basic/AntdConfig/AntdConfig.tsx（antd 主题和 CSS 变量）、settings/SettingsPage.tsx（色块）。
 */
export interface AccentColor {
  name: string;
  light: string; // 浅色模式
  dark: string;  // 深色模式
}

export interface AccentTokens {
  primary: string;
  text: string;
  onPrimary: string;
}

export type Team = 'sii' | 'nii' | 'hii' | 'x';

export const teamColors: Record<Team, { name: string; color: string }> = {
  sii: { name: 'SII 蓝', color: '#8fc8eb' },
  nii: { name: 'NII 紫', color: '#af83bb' },
  hii: { name: 'HII 橙', color: '#f49604' },
  x: { name: 'X 绿', color: '#a9ca27' }
};

/* 可选的主题色；第一个是默认值。名字存在设置里，改名会让已经选了的人回到默认 */
export const accentColors: Array<AccentColor> = [
  { name: '青色', light: '#08979c', dark: '#13c2c2' },
  ...(Object.values(teamColors).map(({ name, color }: { name: string; color: string }): AccentColor => ({ name, light: color, dark: color }))),
  { name: '蓝色', light: '#2563eb', dark: '#4b8bff' },
  { name: '靛蓝', light: '#4f46e5', dark: '#7c83ff' },
  { name: '紫色', light: '#7c3aed', dark: '#a78bfa' },
  { name: '粉色', light: '#db2777', dark: '#f472b6' },
  { name: '橙色', light: '#ea580c', dark: '#fb923c' },
  { name: '绿色', light: '#16a34a', dark: '#4ade80' }
];

/* 内容面板的底色（和 ./modernTheme 一致），算文字颜色看不看得清时用 */
export const SURFACE_LIGHT: string = '#ffffff';
export const SURFACE_DARK: string = '#15181d';
export const DARK_TEXT: string = '#1f2329';     // 浅色底上的深色字
export const TEXT_CONTRAST: number = 3;         // 彩色的字和底色至少要有这么大的对比度（WCAG 对界面元素的要求；原来的几个主题色都够）
const ON_PRIMARY_CONTRAST: number = 2.2;        // 白字和主题色的对比度低于它时改用深色字

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const value: string = hex.replace('#', '');
  const full: string = value.length === 3 ? value.split('').map((c: string): string => c + c).join('') : value.slice(0, 6);

  return [0, 2, 4].map((i: number): number => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${ rgb.map((n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('') }`;
}

/* 相对亮度（WCAG） */
export function luminance(hex: string): number {
  const [r, g, b]: Array<number> = parseHex(hex).map((n: number): number => {
    const v: number = n / 255;

    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });

  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

/* 两个颜色的对比度（1～21） */
export function contrast(a: string, b: string): number {
  const [high, low]: Array<number> = [luminance(a), luminance(b)].sort((x: number, y: number): number => y - x);

  return (high + 0.05) / (low + 0.05);
}

/* 把 color 往 target 方向混 amount（0～1） */
export function mix(color: string, target: string, amount: number): string {
  const from: Rgb = parseHex(color);
  const to: Rgb = parseHex(target);

  return toHex(from.map((n: number, i: number): number => n + ((to[i] - n) * amount)) as Rgb);
}

/* 在 background 上写字时看得清的 color：不够清楚就往黑（浅色底）或白（深色底）一点点调，颜色倾向不变 */
export function readableOn(color: string, background: string, min: number = TEXT_CONTRAST): string {
  const target: string = luminance(background) > 0.5 ? '#000000' : '#ffffff';

  for (let step: number = 0; step <= 20; step++) {
    const candidate: string = step === 0 ? color.toLowerCase() : mix(color, target, step * 0.05);

    if (contrast(candidate, background) >= min) return candidate;
  }

  return target;
}

/* 主题色底上用白字还是深色字 */
export function textOnColor(color: string): string {
  return contrast('#ffffff', color) >= ON_PRIMARY_CONTRAST ? '#ffffff' : DARK_TEXT;
}

export function findAccent(name: string | undefined): AccentColor {
  return accentColors.find((item: AccentColor): boolean => item.name === name) ?? accentColors[0];
}

/* 当前主题色在明 / 暗模式下的三种用法 */
export function accentTokens(name: string | undefined, isDark: boolean | undefined): AccentTokens {
  const accent: AccentColor = findAccent(name);
  const primary: string = isDark ? accent.dark : accent.light;

  return {
    primary,
    text: readableOn(primary, isDark ? SURFACE_DARK : SURFACE_LIGHT),
    onPrimary: textOnColor(primary)
  };
}

/* 根元素上的 CSS 变量：主题色三种用法，加上每个团队色和它写字用的颜色 */
export function colorVariables(name: string | undefined, isDark: boolean | undefined): Record<string, string> {
  const accent: AccentTokens = accentTokens(name, isDark);
  const variables: Record<string, string> = {
    '--accent': accent.primary,
    '--accent-text': accent.text,
    '--accent-on': accent.onPrimary
  };

  for (const [team, { color }] of Object.entries(teamColors)) {
    variables[`--team-${ team }`] = color;
    variables[`--team-${ team }-text`] = readableOn(color, isDark ? SURFACE_DARK : SURFACE_LIGHT);
  }

  return variables;
}
