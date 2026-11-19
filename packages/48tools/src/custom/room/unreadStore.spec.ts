import {
  noteMessages,
  setViewing,
  settleViewing,
  handleWindowFocus,
  getUnreadState,
  getSeen,
  totalUnread,
  unreadText,
  resetUnreadForTest
} from './unreadStore';

const A: number = 1;
const B: number = 2;

describe('room unread counts', function(): void {
  beforeEach((): void => resetUnreadForTest(true));

  test('history is not unread the first time a member is seen; later messages are', function(): void {
    noteMessages(A, [100, 200, 300]);
    expect(getUnreadState().counts[A] ?? 0).toBe(0);
    expect(getSeen(A)).toBe(300);

    noteMessages(A, [200, 300, 400, 500]);
    expect(getUnreadState().counts[A]).toBe(2);
    expect(totalUnread(getUnreadState().counts, [A, B])).toBe(2);
  });

  test('entering a room clears its count and leaves a divider where reading stopped', function(): void {
    noteMessages(A, [300]);
    noteMessages(A, [300, 400, 500]);
    setViewing(A);

    expect(getUnreadState().counts[A]).toBe(0);
    expect(getUnreadState().dividers[A]).toBe(300);
    expect(getSeen(A)).toBe(500);

    // 看着房间时来的新消息直接算已读，分隔线不动
    settleViewing(A);
    noteMessages(A, [500, 600]);
    expect(getUnreadState().counts[A]).toBe(0);
    expect(getUnreadState().dividers[A]).toBe(300);

    // 换到别的房间：分隔线收起来
    setViewing(B);
    expect(getUnreadState().dividers[A]).toBeUndefined();
  });

  test('new messages found while a room is first loading get a divider', function(): void {
    noteMessages(A, [300]);
    setViewing(A);
    noteMessages(A, [300, 400]);

    expect(getUnreadState().counts[A] ?? 0).toBe(0);
    expect(getUnreadState().dividers[A]).toBe(300);
  });

  test('messages that arrive while the window is in the background wait for focus', function(): void {
    resetUnreadForTest(false);
    noteMessages(A, [300]);
    setViewing(A);
    settleViewing(A);
    noteMessages(A, [300, 400]);
    expect(getUnreadState().counts[A]).toBe(1);

    handleWindowFocus();
    expect(getUnreadState().counts[A]).toBe(0);
    expect(getUnreadState().dividers[A]).toBe(300);
  });

  test('a gap that could not be bridged counts as at least the given number', function(): void {
    noteMessages(A, [300]);
    noteMessages(A, [900, 950], 100);
    expect(getUnreadState().counts[A]).toBe(100);
    expect(unreadText(getUnreadState().counts[A])).toBe('99+');
  });
});
