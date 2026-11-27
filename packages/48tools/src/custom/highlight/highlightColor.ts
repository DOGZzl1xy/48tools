/**
 * 切片画面用的颜色换算（纯计算）和「一个队伍主色算出来的整套色板」长什么样。
 * 色板怎么算是可以换的模块：程序自带的在 ../basic/highlightPalette，也可以来自同步下来的内容包（见 ../basic/README.md）。
 */
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

export type Rgb = [number, number, number];
export type Hsl = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const clean: string = hex.replace('#', '').padStart(6, '0');

  return [0, 2, 4].map((offset: number): number => Number.parseInt(clean.slice(offset, offset + 2), 16)) as Rgb;
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
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

export function clamp(value: number, low: number, high: number): number {
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
