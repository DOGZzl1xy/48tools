/**
 * 表格翻到最后一页自动加载：什么时候算最后一页、分页旁边的说明。
 */
import { isOnLastPage, autoLoadText } from './useAutoLoadMore';

describe('useAutoLoadMore', (): void => {
  test('翻到已加载的最后一页才算；还没加载任何东西时不算', (): void => {
    expect(isOnLastPage(1, 10, 20)).toBe(false);
    expect(isOnLastPage(2, 10, 20)).toBe(true);
    expect(isOnLastPage(2, 10, 25)).toBe(false);
    expect(isOnLastPage(3, 10, 25)).toBe(true);
    expect(isOnLastPage(1, 10, 5)).toBe(true); // 只有一页时一进来就是最后一页
    expect(isOnLastPage(1, 10, 0)).toBe(false);
  });

  test('分页旁边的说明', (): void => {
    expect(autoLoadText(20, false, false)).toBe('已加载 20 条');
    expect(autoLoadText(20, true, false)).toBe('已加载 20 条，正在加载更多…');
    expect(autoLoadText(37, false, true)).toBe('共 37 条，已经全部加载');
  });
});
