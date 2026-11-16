import type { ReactElement, ReactNode } from 'react';
import { Typography, type ButtonProps } from 'antd';

/**
 * 首页功能按钮分组。
 * 按跳转地址归类，不需要改原来的 navLinkConfig；原作者以后新增的入口会自动归组，匹配不到的放进「其他」。
 * 接入点：pages/Index/Index.tsx 的 nativeRender。
 */
export interface NavGroup<T> {
  title: string;
  items: Array<T>;
}

const navGroupRules: Array<{ title: string; test: RegExp }> = [
  { title: '口袋48', test: /^\/48\//i },
  { title: '视频平台', test: /^\/(Bilibili|AcFun|Toutiao|Kuaishou)\//i },
  { title: '微博 · 小红书 · SHOWROOM', test: /^\/(Weibo|Xiaohongshu|ShowroomLive)\//i },
  { title: '视频工具', test: /^\/VideoEdit\//i }
];

export function groupNavItems<T extends { url: string }>(items: Array<T>): Array<NavGroup<T>> {
  const groups: Array<NavGroup<T>> = navGroupRules.map((rule: { title: string }): NavGroup<T> => ({ title: rule.title, items: [] }));
  const others: Array<T> = [];

  for (const item of items) {
    const index: number = navGroupRules.findIndex((rule: { test: RegExp }): boolean => rule.test.test(item.url));

    (index >= 0 ? groups[index].items : others).push(item);
  }

  if (others.length > 0) groups.push({ title: '其他', items: others });

  return groups.filter((group: NavGroup<T>): boolean => group.items.length > 0);
}

/* 功能按钮的样式：柔和的填充式大按钮 */
export const navTileButtonProps: ButtonProps = {
  size: 'large',
  color: 'default',
  variant: 'filled'
};

/* 一个分组：小标题 + 四列网格 */
export function NavSection(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="mb-[18px]">
      <Typography.Text className="block mb-[8px] text-[12px] tracking-[0.04em]" type="secondary">
        { props.title }
      </Typography.Text>
      <nav className="grid grid-cols-4 gap-[12px] w-[800px]">{ props.children }</nav>
    </section>
  );
}
