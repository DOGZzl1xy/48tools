/**
 * 录播自动切片的专有词汇：读设置里的文字、提示里的那一段、替换错的写法。
 */
import { parseGlossary, glossaryPrompt, applyGlossary, DEFAULT_GLOSSARY, type Glossary } from './highlightGlossary';
import { findRequest, scriptRequest } from './highlightGemini';
import type { Highlight } from './highlightTypes';

describe('parseGlossary', (): void => {
  test('「词：说明」是提示，「错 → 对」是替换；空行和 # 开头的不算', (): void => {
    expect(parseGlossary('# 注释\n\n袋王：口袋48 的运营\n代王 → 袋王\n艺龙->叶总\n  老布衣 => 阿悦  \n只有一个词')).toEqual({
      hints: ['袋王：口袋48 的运营', '只有一个词'],
      replacements: [{ from: '代王', to: '袋王' }, { from: '艺龙', to: '叶总' }, { from: '老布衣', to: '阿悦' }]
    });
  });

  test('箭头一边是空的不算替换；没有设置时是空的', (): void => {
    expect(parseGlossary('代王 →').replacements).toEqual([]);
    expect(parseGlossary(undefined)).toEqual({ hints: [], replacements: [] });
  });

  test('默认的词汇表里有袋王和叶总', (): void => {
    const glossary: Glossary = parseGlossary(DEFAULT_GLOSSARY);

    expect(glossary.hints.some((line: string): boolean => line.startsWith('袋王：'))).toBe(true);
    expect(glossary.hints.some((line: string): boolean => line.startsWith('叶总：'))).toBe(true);
    expect(glossary.replacements).toEqual(expect.arrayContaining([{ from: '代王', to: '袋王' }, { from: '艺龙', to: '叶总' }]));
  });
});

describe('glossaryPrompt / applyGlossary', (): void => {
  const glossary: Glossary = parseGlossary('袋王：口袋48 的运营\n代王 → 袋王\n艺龙 → 叶总');

  test('提示里列出词和替换；没有词汇时什么都不加', (): void => {
    const prompt: string = glossaryPrompt(glossary);

    expect(prompt).toContain('<专有词汇>');
    expect(prompt).toContain('袋王：口袋48 的运营');
    expect(prompt).toContain('听到「代王」时写成「袋王」');
    expect(glossaryPrompt({ hints: [], replacements: [] })).toBe('');
  });

  test('错的写法全部换掉', (): void => {
    expect(applyGlossary('偷偷学手语只为背着代王开骂，代王知道吗', glossary)).toBe('偷偷学手语只为背着袋王开骂，袋王知道吗');
    expect(applyGlossary('然后让艺龙帮我下播', glossary)).toBe('然后让叶总帮我下播');
    expect(applyGlossary('没有要换的', glossary)).toBe('没有要换的');
  });

  test('找爆点、写字幕的提示里都带上', (): void => {
    const meta: { member: string; title: string; glossary: string } = { member: '测试成员', title: '测试直播', glossary: glossaryPrompt(glossary) };
    const highlight: Highlight = { start: 0, end: 60, title: '标题', cover: '', quote: '', reason: '', score: 8 };

    expect(findRequest(meta, { start: 0, length: 1_800 }, 'QUJD', []).parts[0].text).toContain('听到「代王」时写成「袋王」');
    expect(scriptRequest(meta, highlight, 60, 'QUJD', []).parts[0].text).toContain('<专有词汇>');
    expect(scriptRequest({ member: '测试成员', title: '测试直播' }, highlight, 60, 'QUJD', []).parts[0].text).not.toContain('<专有词汇>');
  });
});
