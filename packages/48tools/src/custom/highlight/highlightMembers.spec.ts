/**
 * 交给 Gemini 的常识：成员名单（五个团的各队和预备生，主播是哪个队的；拿不准时结合弹幕）。
 */
import { membersPrompt } from './highlightMembers';
import { findRequest, scriptRequest } from './highlightGemini';
import type { DirectoryMember } from '../room/memberSearch';
import type { Highlight } from './highlightTypes';

const members: Array<DirectoryMember> = [
  { id: 1, name: '甲一', team: 'TEAM NII', group: 'SNH48' },
  { id: 2, name: '甲二', team: 'TEAM SII', group: 'SNH48' },
  { id: 3, name: '甲三', team: '预备生', group: 'SNH48' },
  { id: 4, name: '乙一', team: 'TEAM G', group: 'GNZ48' },
  { id: 5, name: '甲四', team: 'TEAM NII', group: 'SNH48' },
  { id: 6, name: '男团成员', team: 'IDFT', group: 'IDFT' },       // 不是这五个团的
  { id: 7, name: '甲五', team: '荣誉毕业生', group: 'SNH48' },     // 毕业生不要
  { id: 8, name: '丙一', team: 'BEJ48', group: 'BEJ48' }          // 没有分队的不要
];

describe('highlightMembers', (): void => {
  test('只要五个团的各队和预备生；预备生排在每个团最后', (): void => {
    const prompt: string = membersPrompt(members, 'SNH48-甲一');

    expect(prompt).toContain('<成员名单>');
    expect(prompt).toContain('SNH48 NII：甲一、甲四');
    expect(prompt).toContain('GNZ48 G：乙一');
    expect(prompt).toContain('SNH48 预备生：甲三');
    expect(prompt).not.toContain('男团成员');
    expect(prompt).not.toContain('甲五');
    expect(prompt).not.toContain('丙一');
    expect(prompt.indexOf('SNH48 SII')).toBeLessThan(prompt.indexOf('SNH48 预备生'));
    expect(prompt.indexOf('SNH48 预备生')).toBeLessThan(prompt.indexOf('GNZ48 G'));
  });

  test('说明主播是哪个队的；拿不准是谁时结合弹幕判断', (): void => {
    const prompt: string = membersPrompt(members, 'SNH48-甲一');

    expect(prompt).toContain('主播 甲一 是 SNH48 NII 的成员。');
    expect(prompt).toContain('不要写成名单里没有的名字');
    expect(prompt).toContain('结合弹幕判断');
  });

  test('名单是空的时不加这一段；主播不在名单里时不写她是哪个队的', (): void => {
    expect(membersPrompt([], '甲一')).toBe('');
    expect(membersPrompt(members, '不在名单里的人')).not.toContain('主播');
  });

  test('找爆点和写字幕的提示里都带上成员名单（和专有词汇放在一起）', (): void => {
    const meta: { member: string; title: string; members: string } = { member: '甲一', title: '测试直播', members: membersPrompt(members, '甲一') };
    const highlight: Highlight = { start: 700, end: 800, title: '标题', cover: '封面', quote: '原话', reason: '理由', score: 9 };

    expect(findRequest(meta, { start: 600, length: 1_800 }, 'QUJD', []).parts[0].text).toContain('<成员名单>');
    expect(scriptRequest(meta, highlight, 120, 'QUJD', []).parts[0].text).toContain('<成员名单>');
  });
});
