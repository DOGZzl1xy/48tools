import { findNavItem, shellNavItems } from './navConfig';

describe('shell nav config', function(): void {
  test('finds the feature for a page, including sub pages', function(): void {
    expect(findNavItem('/48/Pocket48Record')?.key).toBe('pocket48-record');
    expect(findNavItem('/48/LiveOptions')?.key).toBe('pocket48-live'); // 自动抓取配置属于直播抓取
    expect(findNavItem('/VideoEdit/VideoCut')?.key).toBe('video-cut');
    expect(findNavItem('/')).toBeUndefined();
    expect(findNavItem('/Agreement/Agreement')).toBeUndefined();
  });

  test('keys and addresses are unique', function(): void {
    expect(new Set(shellNavItems.map((item: { key: string }): string => item.key)).size).toBe(shellNavItems.length);
    expect(new Set(shellNavItems.map((item: { to: string }): string => item.to)).size).toBe(shellNavItems.length);
  });
});
