/**
 * 在成员名单里找人（纯函数，名单从哪里来见 ./memberDirectory）。
 * 可以按：中文名字的一部分、拼音（全拼，或者姓和名的首字母——名单里的拼音是「liu shitong」这样姓和名两段，
 * 所以刘诗彤的首字母是 ls；不分大小写，空格可有可无）、成员 ID、队伍（比如 NII、SII）。
 */
export interface DirectoryMember {
  id: number;      // 成员的用户 ID
  name: string;
  team?: string;   // TEAM NII、预备生……（名单里原样的写法）
  group?: string;  // SNH48、GNZ48……
  pinyin?: string; // shen xin
  account?: string;  // 成员的云信账号（部分成员公开名单自带）
  serverId?: number; // 成员的圈组房间 ID
}

/* 队伍的短写法：「TEAM NII」→「NII」，其他（预备生、荣誉毕业生……）原样 */
export function teamLabel(team: string | undefined): string {
  return (team ?? '').replace(/^TEAM\s+/i, '').trim();
}

function initials(pinyin: string): string {
  return pinyin.split(/\s+/).map((part: string): string => part[0] ?? '').join('');
}

/* 匹配得有多好：数字越小越靠前，-1 是不匹配 */
function score(member: DirectoryMember, keyword: string): number {
  const name: string = member.name.toLowerCase();
  const pinyin: string = (member.pinyin ?? '').toLowerCase();
  const joined: string = pinyin.replace(/\s+/g, '');

  if (name === keyword || String(member.id) === keyword || joined === keyword) return 0;

  if (name.startsWith(keyword)) return 1;

  if (name.includes(keyword)) return 2;

  if (joined.startsWith(keyword) || initials(pinyin) === keyword) return 3;

  if (/^[a-z]+$/.test(keyword) && (joined.includes(keyword) || initials(pinyin).startsWith(keyword))) return 4;

  if (teamLabel(member.team).toLowerCase() === keyword) return 5;

  if (/^\d{4,}$/.test(keyword) && String(member.id).startsWith(keyword)) return 6;

  return -1;
}

export function searchDirectory(list: Array<DirectoryMember>, text: string, limit: number = 30): Array<DirectoryMember> {
  const keyword: string = text.trim().toLowerCase().replace(/\s+/g, '');

  if (keyword === '') return [];

  const found: Array<{ member: DirectoryMember; score: number }> = [];

  for (const member of list) {
    const value: number = score(member, keyword);

    value >= 0 && found.push({ member, score: value });
  }

  return found
    .sort((a: { score: number }, b: { score: number }): number => a.score - b.score)
    .slice(0, limit)
    .map((item: { member: DirectoryMember }): DirectoryMember => item.member);
}
