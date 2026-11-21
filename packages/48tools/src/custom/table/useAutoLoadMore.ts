import { useEffect, useRef, useState } from 'react';
import type { TablePaginationConfig } from 'antd';

/**
 * 表格翻到最后一页时自动加载下一批（不用再点「加载列表」「加载下一页」），一直到接口取不到更多为止。
 * 用法：把返回值传给 <Table pagination={ … }>；加载函数在取到空列表时把 noMore 设成 true，刷新列表时设回 false 并换一个 resetKey。
 * 加载失败时同一批不会自己重试（免得一直请求），翻页或者刷新后会再试。
 * 接入点：Pocket48Record.tsx（口袋48录播）、Live48/InVideo/InVideo.tsx（公演录播）。
 */
export interface AutoLoadMoreOptions {
  loaded: number;          // 已经加载了多少条
  loading: boolean;        // 正在加载
  noMore: boolean;         // 接口已经取不到更多了
  onLoadMore: () => void;  // 加载下一批
  resetKey?: string;       // 换了查询条件（队伍、成员）时变一下，回到第一页
}

export const AUTO_LOAD_PAGE_SIZE: number = 10;

/* 现在这一页是不是最后一页（这时该加载下一批了） */
export function isOnLastPage(current: number, pageSize: number, loaded: number): boolean {
  return loaded > 0 && current >= Math.ceil(loaded / pageSize);
}

/* 分页旁边的说明 */
export function autoLoadText(loaded: number, loading: boolean, noMore: boolean): string {
  if (loading) return `已加载 ${ loaded } 条，正在加载更多…`;

  if (noMore) return `共 ${ loaded } 条，已经全部加载`;

  return `已加载 ${ loaded } 条`;
}

export function useAutoLoadMore(options: AutoLoadMoreOptions): TablePaginationConfig {
  const { loaded, loading, noMore, onLoadMore, resetKey }: AutoLoadMoreOptions = options;
  const [current, setCurrent]: [number, (value: number) => void] = useState(1);
  const [pageSize, setPageSize]: [number, (value: number) => void] = useState(AUTO_LOAD_PAGE_SIZE);
  const triggeredAt: { current: number } = useRef(-1); // 上一次是在已加载多少条时触发的（同一批不重复触发）

  // 换了查询条件：回到第一页
  useEffect(function(): void {
    setCurrent(1);
    triggeredAt.current = -1;
  }, [resetKey]);

  useEffect(function(): void {
    if (loading || noMore || !isOnLastPage(current, pageSize, loaded) || triggeredAt.current === loaded) return;

    triggeredAt.current = loaded;
    onLoadMore();
  }, [current, pageSize, loaded, loading, noMore]);

  return {
    current,
    pageSize,
    showQuickJumper: true,
    showSizeChanger: true,
    onChange(page: number, size: number): void {
      // 翻页时允许重试上次失败的那一批
      if (page !== current) triggeredAt.current = -1;

      setCurrent(page);
      setPageSize(size);
    },
    showTotal: (): string => autoLoadText(loaded, loading, noMore)
  };
}
