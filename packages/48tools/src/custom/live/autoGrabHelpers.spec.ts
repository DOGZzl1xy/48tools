import { createMemberMatcher, createErrorNotifier } from './autoGrabHelpers';

describe('createMemberMatcher', function(): void {
  test('matches by nickname (case-insensitive) or by exact user id', function(): void {
    const match: (nickname: string, userId: string | number) => boolean = createMemberMatcher(['成员甲', '10001', 'abc']);

    expect(match('SNH48-成员甲', '1')).toBe(true);
    expect(match('SNH48-ABC', '1')).toBe(true);
    expect(match('SNH48-其他人', '10001')).toBe(true); // 原版按 ID 匹配不生效
    expect(match('SNH48-其他人', 10001)).toBe(true);
    expect(match('SNH48-其他人', '2')).toBe(false);
  });

  test('special characters in names are treated literally', function(): void {
    const match: (nickname: string, userId: string | number) => boolean = createMemberMatcher(['a.b(c', '*']);

    expect(match('xx a.b(c xx', '1')).toBe(true);
    expect(match('aXb(c', '1')).toBe(false);
    expect(match('star*', '1')).toBe(true);
  });

  test('empty list matches nothing', function(): void {
    expect(createMemberMatcher([' ', ''])('anyone', '1')).toBe(false);
  });
});

describe('createErrorNotifier', function(): void {
  test('same text is shown once per interval', function(): void {
    const shown: Array<string> = [];
    let time: number = 0;
    const notify: (text: string) => void = createErrorNotifier((text: string): unknown => shown.push(text), 1000, (): number => time);

    notify('a');
    time = 500;
    notify('a');
    notify('b');
    time = 2000;
    notify('b');
    expect(shown).toEqual(['a', 'b', 'b']);
  });
});
