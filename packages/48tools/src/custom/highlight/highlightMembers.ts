import { teamLabel, type DirectoryMember } from '../room/memberSearch';
import { shortName } from './highlightTime';

/**
 * 交给 Gemini 的常识：成员名单。SNH48、GNZ48、BEJ48、CKG48、CGT48 各队现在的成员和预备生（不要荣誉毕业生、没有分队的人），
 * 转写、标题、people 里的名字以它为准；拿不准是谁时结合弹幕判断。
 * 名单来自 custom/room/memberDirectory（原版就在用的公开名单，本机存一份、一天更新一次）。
 * 接入点：./highlightTask（开始切片时生成）、./highlightGemini（找爆点和写字幕的提示）。
 */
const GROUPS: Array<string> = ['SNH48', 'GNZ48', 'BEJ48', 'CKG48', 'CGT48'];
const TRAINEES: string = '预备生';

/* 要不要这个队伍：正式的队伍（名单里写成「TEAM XX」）和预备生 */
function isWantedTeam(team: string | undefined): boolean {
  const text: string = (team ?? '').trim();

  return /^TEAM\s+\S/i.test(text) || text === TRAINEES;
}

/**
 * 成员名单那一段提示；名单是空的时返回空字符串
 * @param { Array<DirectoryMember> } members - 成员名单
 * @param { string } streamer - 主播（可以带团名：SNH48-沈馨）
 */
export function membersPrompt(members: Array<DirectoryMember>, streamer: string): string {
  const groups: Map<string, Map<string, Array<string>>> = new Map(GROUPS.map((group: string): [string, Map<string, Array<string>>] => [group, new Map()]));

  for (const member of members) {
    const teams: Map<string, Array<string>> | undefined = groups.get(member.group ?? '');
    const memberName: string = member.name?.trim();

    if (!teams || !memberName || !isWantedTeam(member.team)) continue;

    const team: string = teamLabel(member.team);
    const names: Array<string> = teams.get(team) ?? [];

    if (!names.includes(memberName)) names.push(memberName);

    teams.set(team, names);
  }

  const lines: Array<string> = [];

  for (const [group, teams] of groups) {
    const sorted: Array<[string, Array<string>]> = Array.from(teams.entries())
      .sort((a: [string, Array<string>], b: [string, Array<string>]): number =>
        Number(a[0] === TRAINEES) - Number(b[0] === TRAINEES) || a[0].localeCompare(b[0])); // 预备生排在每个团最后

    for (const [team, names] of sorted) lines.push(`${ group } ${ team }：${ names.join('、') }`);
  }

  if (lines.length === 0) return '';

  const name: string = shortName(streamer);
  const self: DirectoryMember | undefined = members.find((member: DirectoryMember): boolean => member.name === name);
  const selfTeam: string = [self?.group, teamLabel(self?.team)].filter(Boolean).join(' ');
  const selfLine: string = self && selfTeam ? `主播 ${ name } 是 ${ selfTeam } 的成员。` : '';

  return `<成员名单>
下面是 SNH48、GNZ48、BEJ48、CKG48、CGT48 各队现在的成员和预备生（团 队伍：名字）。${ selfLine }
转写、写标题和 people 时，成员的名字以这里的写法为准；听到像成员名字的话，先在名单里找是谁，不要写成名单里没有的名字（同音字、错别字都不行）。
不好判断是谁时（只听到昵称、名字听不清、同音的有好几个），结合弹幕判断：粉丝常在弹幕里叫出她的名字或昵称，也会说出在和谁连麦、在聊谁。还是拿不准就不写名字。
${ lines.join('\n') }
</成员名单>`;
}
