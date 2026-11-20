import type { CustomMessageV2 } from '@48tools-api/48';
import { emojiText } from './emojiText';
import { roomClock, dayStart } from './roomTime';
import { searchDirectory, teamLabel, type DirectoryMember } from './memberSearch';
import { messageText, matchMessage, senderName, snippet } from './roomSearchText';

function raw(msgType: string, bodys: unknown, nickName: string = '成员'): CustomMessageV2 {
  return {
    msgIdServer: 1,
    msgIdClient: 'id-1',
    msgTime: 0,
    msgType: msgType as CustomMessageV2['msgType'],
    bodys: typeof bodys === 'string' ? bodys : JSON.stringify(bodys),
    extInfo: JSON.stringify({ user: { nickName, roleId: 3 } })
  };
}

describe('emojiText', function(): void {
  test('known codes become emoji, unknown ones stay', function(): void {
    expect(emojiText('早呀[太阳]')).toBe('早呀☀️');
    expect(emojiText('[亲亲][亲亲]晚安[月亮]')).toBe('😘😘晚安🌙');
    expect(emojiText('看这张[图片]')).toBe('看这张[图片]');
    expect(emojiText('没有表情')).toBe('没有表情');
    expect(emojiText('[OK]')).toBe('👌');
  });
});

describe('roomTime', function(): void {
  const noonUtc: number = Date.UTC(2026, 10, 19, 12, 30, 5); // 2026-11-19 12:30:05 UTC = 北京时间 20:30:05

  test('beijing time does not depend on the computer time zone', function(): void {
    expect(roomClock(noonUtc, true)).toEqual({
      day: '2026年11月19日 星期四',
      date: '2026-11-19',
      time: '20:30',
      full: '2026-11-19 20:30:05（北京时间）'
    });
    // 北京时间过了零点：日期也跟着变
    expect(roomClock(Date.UTC(2026, 10, 19, 17, 0, 0), true).date).toBe('2026-11-20');
    expect(roomClock(Date.UTC(2026, 10, 19, 17, 0, 0), true).day).toBe('2026年11月20日 星期五');
  });

  test('local time uses the computer time zone', function(): void {
    const local: Date = new Date(noonUtc);

    expect(roomClock(noonUtc, false).time).toBe(`${ String(local.getHours()).padStart(2, '0') }:${ String(local.getMinutes()).padStart(2, '0') }`);
    expect(roomClock(noonUtc, false).full).not.toContain('北京时间');
  });

  test('dayStart is the first moment of that day', function(): void {
    expect(dayStart('2026-11-20', true)).toBe(Date.UTC(2026, 10, 19, 16, 0, 0));
    expect(roomClock(dayStart('2026-11-20', true), true).full).toBe('2026-11-20 00:00:00（北京时间）');
    expect(roomClock(dayStart('2026-11-20', true) - 1, true).date).toBe('2026-11-19');
    expect(roomClock(dayStart('2026-03-08', false), false).full).toBe('2026-03-08 00:00:00');
  });
});

describe('memberSearch', function(): void {
  const list: Array<DirectoryMember> = [
    { id: 1001, name: '林小雨', team: 'TEAM NII', group: 'SNH48', pinyin: 'lin xiaoyu' },
    { id: 1002, name: '林雨', team: 'TEAM SII', group: 'SNH48', pinyin: 'lin yu' },
    { id: 20031, name: '陈朵朵', team: 'TEAM G', group: 'GNZ48', pinyin: 'chen duoduo' },
    { id: 20032, name: '周小北', team: '预备生', group: 'SNH48', pinyin: 'zhou xiaobei' },
    { id: 30001, name: '没有拼音的人' }
  ];

  function names(text: string): Array<string> {
    return searchDirectory(list, text).map((member: DirectoryMember): string => member.name);
  }

  test('teamLabel drops the TEAM prefix', function(): void {
    expect(teamLabel('TEAM NII')).toBe('NII');
    expect(teamLabel('预备生')).toBe('预备生');
    expect(teamLabel(undefined)).toBe('');
  });

  test('by chinese name, exact match first', function(): void {
    expect(names('林雨')).toEqual(['林雨']);
    expect(names('林')).toEqual(['林小雨', '林雨']);
    expect(names('小')).toEqual(['林小雨', '周小北']);
  });

  test('by pinyin: full, with spaces, initials of family and given name', function(): void {
    expect(names('linxiaoyu')).toEqual(['林小雨']);
    expect(names('Lin Yu')).toEqual(['林雨']);
    expect(names('lin')).toEqual(['林小雨', '林雨']);
    expect(names('cd')).toEqual(['陈朵朵']);
    expect(names('xiao')).toEqual(['林小雨', '周小北']);
  });

  test('by id and by team', function(): void {
    expect(names('20031')).toEqual(['陈朵朵']);
    expect(names('2003')).toEqual(['陈朵朵', '周小北']);
    expect(names('nii')).toEqual(['林小雨']);
    expect(names('预备生')).toEqual(['周小北']);
  });

  test('nothing typed or nothing found gives an empty list; limit is respected', function(): void {
    expect(names('  ')).toEqual([]);
    expect(names('zzz')).toEqual([]);
    expect(searchDirectory(list, '小', 1)).toHaveLength(1);
  });
});

describe('roomSearchText', function(): void {
  test('messageText picks the readable text of each kind of message', function(): void {
    expect(messageText(raw('TEXT', '今天不直播'))).toBe('今天不直播');
    expect(messageText(raw('REPLY', { replyInfo: { replyName: '小牛', replyText: '晚安', text: '晚安呀' } }))).toBe('晚安呀 小牛 晚安');
    expect(messageText(raw('FLIPCARD', { filpCardInfo: { question: '在听什么歌', answer: '老歌' } }))).toBe('在听什么歌 老歌');
    expect(messageText(raw('FLIPCARD_AUDIO', { filpCardInfo: { question: '在听什么歌', answer: '{"url":"/a.mp4"}' } }), '转出来的字'))
      .toBe('在听什么歌 转出来的字');
    expect(messageText(raw('AUDIO', { url: 'https://example.com/a' }))).toBe('');
    expect(messageText(raw('AUDIO', { url: 'https://example.com/a' }), '谢谢小牛')).toBe('谢谢小牛');
    expect(messageText(raw('LIVEPUSH', { livePushInfo: { liveTitle: '进来聊天' } }))).toBe('直播 进来聊天');
    expect(messageText(raw('IMAGE', { url: 'https://example.com/a.jpg' }))).toBe('');
    expect(messageText(raw('REPLY', 'not json'))).toBe('');
  });

  test('matchMessage looks in the text, the transcript and the sender name', function(): void {
    expect(matchMessage(raw('TEXT', 'Hello 大家'), 'hello')).toBe(true);
    expect(matchMessage(raw('TEXT', '今天不直播'), '明天')).toBe(false);
    expect(matchMessage(raw('AUDIO', { url: 'x' }), '小牛', '谢谢小牛')).toBe(true);
    expect(matchMessage(raw('TEXT', '早', '路过的橘子'), '橘子')).toBe(true);
    expect(matchMessage(raw('TEXT', '早'), '  ')).toBe(false);
    expect(senderName(raw('TEXT', '早', '路过的橘子'))).toBe('路过的橘子');
  });

  test('snippet keeps the words around the keyword', function(): void {
    const long: string = `${ '前'.repeat(60) }关键词${ '后'.repeat(60) }`;

    expect(snippet('很短的一句话', '一句')).toBe('很短的一句话');
    expect(snippet(long, '关键词')).toBe(`…${ '前'.repeat(28) }关键词${ '后'.repeat(28) }…`);
    expect(snippet('第一行\n第二行', '二')).toBe('第一行 第二行');
  });
});
