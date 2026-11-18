import type { ReactElement } from 'react';
import { useLocation, type Location } from 'react-router';
import { findNavItem, type ShellNavItem } from './navConfig';

/**
 * 页面标题：显示当前功能的名字。有了侧边栏之后，顶层页面不再需要「返回」按钮，原来的位置改成标题。
 * 接入点：components/Header/Header.tsx（返回地址是首页时显示标题，子页面仍然显示返回）。
 */
function PageTitle(props: {}): ReactElement | null {
  const location: Location = useLocation();
  const item: ShellNavItem | undefined = findNavItem(location.pathname);

  if (!item) return null;

  return <h1 className="shell-page-title">{ item.title }</h1>;
}

export default PageTitle;
