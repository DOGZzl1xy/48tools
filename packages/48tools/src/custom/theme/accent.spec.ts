/**
 * 主题色：必须有四个团队色；浅的颜色写字时自动加深、底色上的字改成深色；原来的几个颜色效果不变。
 */
import {
  accentColors, accentTokens, colorVariables, contrast, readableOn, textOnColor, teamColors,
  SURFACE_LIGHT, SURFACE_DARK, TEXT_CONTRAST, DARK_TEXT
} from './accent';

describe('accent', (): void => {
  test('主题色里有四个团队色，明暗模式都用原色；默认还是青色', (): void => {
    for (const hex of ['#8fc8eb', '#af83bb', '#f49604', '#a9ca27']) {
      expect(accentColors.some((item: { light: string; dark: string }): boolean => item.light === hex && item.dark === hex)).toBe(true);
    }

    expect(accentColors[0].name).toBe('青色');
    expect(new Set(accentColors.map((item: { name: string }): string => item.name)).size).toBe(accentColors.length);
    expect(Object.keys(teamColors)).toEqual(['sii', 'nii', 'hii', 'x']);
  });

  test('对比度的计算', (): void => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  test('浅的团队色写字时加深到看得清，颜色倾向不变；深色模式下原色就够清楚', (): void => {
    const sii: ReturnType<typeof accentTokens> = accentTokens('SII 蓝', false);

    expect(sii.primary).toBe('#8fc8eb');
    expect(sii.text).not.toBe('#8fc8eb');
    expect(contrast(sii.text, SURFACE_LIGHT)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(parseInt(sii.text.slice(5, 7), 16)).toBeGreaterThan(parseInt(sii.text.slice(1, 3), 16)); // 还是偏蓝

    for (const team of Object.values(teamColors)) {
      expect(contrast(accentTokens(team.name, false).text, SURFACE_LIGHT)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      expect(accentTokens(team.name, true).text).toBe(team.color);
    }
  });

  test('主题色底上的字：太浅的颜色用深色字，其余用白字', (): void => {
    expect(accentTokens('SII 蓝', false).onPrimary).toBe(DARK_TEXT);
    expect(accentTokens('X 绿', false).onPrimary).toBe(DARK_TEXT);
    expect(accentTokens('NII 紫', false).onPrimary).toBe('#ffffff');
    expect(accentTokens('HII 橙', false).onPrimary).toBe('#ffffff');
    expect(textOnColor('#000000')).toBe('#ffffff');
  });

  test('原来的颜色效果不变：写字就用原色，底上用白字', (): void => {
    for (const name of ['青色', '蓝色', '靛蓝', '紫色', '粉色', '橙色', '绿色']) {
      const light: ReturnType<typeof accentTokens> = accentTokens(name, false);

      expect(light.text).toBe(light.primary);
      expect(light.onPrimary).toBe('#ffffff');
      expect(accentTokens(name, true).text).toBe(accentTokens(name, true).primary);
    }

    expect(accentTokens(undefined, false)).toEqual(accentTokens('青色', false));
    expect(accentTokens('没有这个颜色', true)).toEqual(accentTokens('青色', true));
  });

  test('CSS 变量：主题色三种用法，加上每个团队色写字用的颜色', (): void => {
    const variables: Record<string, string> = colorVariables('HII 橙', false);

    expect(variables['--accent']).toBe('#f49604');
    expect(variables['--team-sii']).toBe('#8fc8eb');
    expect(contrast(variables['--team-x-text'], SURFACE_LIGHT)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(colorVariables('HII 橙', true)['--team-x-text']).toBe('#a9ca27');
    expect(readableOn('#a9ca27', SURFACE_DARK)).toBe('#a9ca27');
  });
});
