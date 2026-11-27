import { DEFAULT_TEAM_COLOR, deriveTeamTokens, resolveTeam, shortMemberName, teamColorOf } from './highlightTheme';

describe('highlightTheme', (): void => {
  test('全部 11 支队伍（含 N3 别名）与预备生配色正确', (): void => {
    expect(teamColorOf('SII')).toBe('#8fc8eb');
    expect(teamColorOf('TEAM NII')).toBe('#af83bb');
    expect(teamColorOf('SNH48 TEAM HII')).toBe('#f49604');
    expect(teamColorOf('X')).toBe('#a9ca27');
    expect(teamColorOf('GNZ48 TEAM G')).toBe('#abc813');
    expect(teamColorOf('TEAM NIII')).toBe('#f6cd22');
    expect(teamColorOf('N3')).toBe('#f6cd22');
    expect(resolveTeam('N3')).toEqual({ code: 'NIII', badge: 'TEAM NIII', color: '#f6cd22' });
    expect(teamColorOf('TEAM Z')).toBe('#ec607c');
    expect(teamColorOf('BEJ48 TEAM B')).toBe('#e7316c');
    expect(teamColorOf('E')).toBe('#1bb5b5');
    expect(teamColorOf('CKG48 TEAM C')).toBe('#ffb715');
    expect(teamColorOf('K')).toBe('#f25554');
    expect(resolveTeam('预备生')).toEqual({ code: '预备生', badge: '预备生', color: DEFAULT_TEAM_COLOR });
    expect(resolveTeam(undefined)).toEqual({ code: '', badge: '', color: DEFAULT_TEAM_COLOR });
  });

  test('shortMemberName 去掉团名前缀，只留成员本人名字', (): void => {
    expect(shortMemberName('SNH48 刘诗彤')).toBe('刘诗彤');
    expect(shortMemberName('GNZ48-郑丹妮')).toBe('郑丹妮');
    expect(shortMemberName('BEJ48 黄宣绮')).toBe('黄宣绮');
    expect(shortMemberName('CKG48-胡思颖')).toBe('胡思颖');
    expect(shortMemberName('曾昕妍')).toBe('曾昕妍');
  });

  test('deriveTeamTokens：中暗色（NII 紫、Z 桃粉、B 玫红、K 珊瑚红）自动走纯白字，浅色（SII 蓝、X 绿、NIII 黄）走深墨字', (): void => {
    expect(deriveTeamTokens('#af83bb').onTeam).toBe('#ffffff');
    expect(deriveTeamTokens('#ec607c').onTeam).toBe('#ffffff');
    expect(deriveTeamTokens('#e7316c').onTeam).toBe('#ffffff');
    expect(deriveTeamTokens('#f25554').onTeam).toBe('#ffffff');

    expect(deriveTeamTokens('#8fc8eb').onTeam).not.toBe('#ffffff');
    expect(deriveTeamTokens('#a9ca27').onTeam).not.toBe('#ffffff');
    expect(deriveTeamTokens('#f6cd22').onTeam).not.toBe('#ffffff');
  });
});
