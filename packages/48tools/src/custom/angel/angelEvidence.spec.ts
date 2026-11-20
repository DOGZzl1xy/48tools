import { describe, test, expect } from '@jest/globals';
import { buildEvidence, momentKind, type RoomMessages, type Evidence, type VisitStat } from './angelEvidence';
import type { PairClue } from './angelModel';
import { GAME_START } from './angelConfig';
import type { AngelMessage } from './angelText';

/* 名字都是编的 */
const minute: number = 60_000;
let seq: number = 0;

function say(roomId: number, senderId: number, time: number, own: string): AngelMessage {
  seq += 1;

  return { key: `m${ seq }`, roomId, senderId, senderNick: '', time, type: 'TEXT', text: own, own };
}

function room(name: string, ownerId: number, messages: Array<AngelMessage>): RoomMessages {
  return { name, ownerId, messages };
}

describe('守护天使：自动线索', function(): void {
  test('分辨几类发言', function(): void {
    expect(momentKind('谢谢小天使的蛋挞')).toBe('receipt');
    expect(momentKind('我的守护天使呢')).toBe('waiting');
    expect(momentKind('我已经给我守护的人点了好几顿了')).toBe('act');
    expect(momentKind('其实我是自己的守护天使')).toBe('self');
    expect(momentKind('谢谢天使3号')).toBeUndefined(); // 粉丝送的礼物
    expect(momentKind('今天吃了火锅')).toBeUndefined();
  });

  test('不把愿望、粉丝团、抽签当成收到东西', function(): void {
    expect(momentKind('我的守护天使能不能送我一个蛋糕')).toBe('mention');
    expect(momentKind('守护天使看到就给孩子买一辆吧')).toBe('mention');
    expect(momentKind('谢谢守护甜心们奖励我的串串')).toBeUndefined();
    expect(momentKind('刚刚守护天使，我抽到了一个人')).toBe('mention');
    expect(momentKind('如果我的守护天使点进房间')).toBe('mention');
    expect(momentKind('大家猜猜她是不是我的守护天使呢')).toBe('mention');
    expect(momentKind('不对我的天使给我点的酸奶')).toBe('receipt');
    expect(momentKind('又收到小天使的投喂')).toBe('receipt');
    expect(momentKind('守护天使的奶茶也到了')).toBe('receipt');
  });

  test('说的是之前收到的东西，不拿来对时间', function(): void {
    expect(momentKind('忘记说了昨天我的守护天使发力了')).toBe('mention');
    expect(momentKind('前天天使给我点的果切我错过了')).toBe('mention');
    expect(momentKind('收获了小天使的泡芙')).toBe('receipt');
  });

  test('串门变多、时间对得上、自称抽到自己', function(): void {
    const t0: number = GAME_START + (10 * 3_600_000);
    const rooms: Array<RoomMessages> = [
      room('成员甲', 1, [
        say(1, 1, t0, '我守护的人你也准备一下吃饭叭'),
        say(1, 1, t0 + minute, '其实我是自己的守护天使')
      ]),
      room('成员乙', 2, [
        say(2, 1, GAME_START - (2 * 86_400_000), '早'),
        say(2, 1, t0 - (30 * minute), '来看看'),
        say(2, 1, t0 - (20 * minute), '在吗'),
        say(2, 1, t0 - (10 * minute), '哈哈哈'),
        say(2, 2, t0 + (40 * minute), '谢谢小天使点的烤肉')
      ])
    ];
    const evidence: Evidence = buildEvidence(rooms, ['成员甲', '成员乙'], t0 + 3_600_000);
    const ids: Array<string> = evidence.clues.map((clue: PairClue): string => clue.id);

    expect(ids).toContain('visit:成员甲:成员乙');
    expect(ids).toContain('timing:成员甲:成员乙');
    expect(ids).toContain('self:成员甲');
    expect(evidence.visits.find((v: VisitStat): boolean => v.visitor === '成员甲')).toMatchObject({ game: 3, baseline: 1 });
    expect(evidence.activity['成员甲'][0].count).toBe(2);
  });

  test('不参加的人不算', function(): void {
    const t0: number = GAME_START + 3_600_000;
    const rooms: Array<RoomMessages> = [
      room('成员甲', 1, []),
      room('成员乙', 2, [say(2, 1, t0, '在吗'), say(2, 1, t0 + minute, '在吗'), say(2, 1, t0 + (2 * minute), '在吗')])
    ];

    expect(buildEvidence(rooms, ['成员乙'], t0 + 3_600_000).clues).toHaveLength(0);
  });
});
