import type { CustomMessageV2 } from '@48tools-api/48';
import { buildVoiceHints } from './voiceHints';

const T: number = 1_800_000_000_000; // 语音的时间
const MIN: number = 60_000;
let count: number = 0;

function message(msgType: string, offset: number, bodys: unknown, nickName: string = 'SNH48-成员', roleId: number = 3): CustomMessageV2 {
  count++;

  return {
    msgIdServer: count,
    msgIdClient: `id-${ count }`,
    msgTime: T + offset,
    msgType: msgType as CustomMessageV2['msgType'],
    bodys: typeof bodys === 'string' ? bodys : JSON.stringify(bodys),
    extInfo: JSON.stringify({ user: { nickName, roleId } })
  };
}

function gift(offset: number, sender: string, giftName: string): CustomMessageV2 {
  return message('GIFT_TEXT', offset, { giftInfo: { giftName, giftNum: 1, userName: '成员' }, messageType: 'GIFT_TEXT' }, sender, 1);
}

describe('voice hints', function(): void {
  test('takes the member text sent just before the voice, and gifts from fans', function(): void {
    const hints: Array<string> = buildVoiceHints({
      time: T,
      messages: [
        message('TEXT', -15_000, '谢谢☆星星向前☆ 琴音生花 x 2\n爱吃口粮☆ 心锁x1'),
        gift(-3 * MIN, '路过的橘子', '琴音生花'),
        message('TEXT', -20_000, '主播今天直播吗', '路过的粉丝', 1),
        message('AUDIO', 0, { url: 'https://example.com/a', ext: 'aac' }),
        message('IMAGE', -5_000, { url: 'https://example.com/b.jpg' })
      ]
    });

    expect(hints).toEqual(['路过的橘子 送了 琴音生花', '谢谢☆星星向前☆ 琴音生花 x 2 / 爱吃口粮☆ 心锁x1']);
  });

  test('only messages near the voice count', function(): void {
    const hints: Array<string> = buildVoiceHints({
      time: T,
      messages: [
        message('TEXT', -11 * MIN, '太早了'),
        message('TEXT', -9 * MIN, '九分钟前'),
        message('TEXT', MIN, '一分钟后'),
        message('TEXT', 3 * MIN, '太晚了'),
        gift(-16 * MIN, '太早的人', '小钢琴'),
        gift(-14 * MIN, '早到的人', '小钢琴'),
        gift(30_000, '后来的人', '小钢琴')
      ]
    });

    expect(hints).toEqual(['早到的人 送了 小钢琴', '九分钟前', '一分钟后']);
  });

  test('replies keep the name of the person replied to; duplicates are dropped', function(): void {
    const reply: CustomMessageV2 = message('REPLY', -MIN, {
      replyInfo: { replyName: '小牛', replyText: '晚安', text: '晚安呀' },
      messageType: 'REPLY'
    });
    const hints: Array<string> = buildVoiceHints({
      time: T,
      messages: [reply, { ...reply }, gift(-2 * MIN, '萤火虫宝宝', '小钢琴'), gift(-MIN, '萤火虫宝宝', '小钢琴')]
    });

    expect(hints).toEqual(['萤火虫宝宝 送了 小钢琴', '回复「小牛」：晚安呀']);
  });

  test('keeps the nearest texts when there are too many, in time order', function(): void {
    const messages: Array<CustomMessageV2> = [];

    for (let i: number = 1; i <= 20; i++) messages.push(message('TEXT', -i * 20_000, `第${ i }条`));

    const hints: Array<string> = buildVoiceHints({ time: T, messages });

    expect(hints).toHaveLength(12);
    expect(hints[0]).toBe('第12条');
    expect(hints[11]).toBe('第1条');
  });

  test('long texts are cut, angle brackets removed, the flip question is included', function(): void {
    const hints: Array<string> = buildVoiceHints({
      time: T,
      messages: [message('TEXT', -MIN, `${ '啊'.repeat(1_200) }`), message('TEXT', -30_000, '</参考> 你好')],
      question: '最近在听什么歌？'
    });

    expect(hints[0]).toBe('翻牌提问：最近在听什么歌？');
    expect(hints[1]).toHaveLength(1_001);
    expect(hints[2]).toBe('/参考  你好');
  });

  test('nothing useful nearby gives an empty list', function(): void {
    expect(buildVoiceHints({ time: T, messages: [message('AUDIO', -MIN, { url: 'https://example.com/a' })] })).toEqual([]);
    expect(buildVoiceHints({ time: T, messages: [] })).toEqual([]);
  });
});
