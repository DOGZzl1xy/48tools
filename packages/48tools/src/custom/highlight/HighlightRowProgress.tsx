import { Fragment, type ReactElement, type ReactNode } from 'react';
import { theme, type GlobalToken } from 'antd';
import { useQueueTasks, type QueueTask } from '../downloadQueue/downloadQueue';
import { highlightTaskId } from './highlightTask';

/**
 * 录播列表「下载进度」那一列里的切片进度：这一行的录播正在自动切片时，显示做到哪一步了
 * （和下载队列里是同一份数据：总进度的百分比、细进度条、「下载录播 37% · 3.2 MB/s · 剩余 1分23秒」这样的说明）。
 * 没有在切片时原样显示 children（原来的下载进度）；同一行又在下载又在切片时两个都显示。
 * 接入点：Pocket48Record.tsx 的「下载进度」列。
 */
function runningHighlight(tasks: Array<QueueTask>, liveId: string): QueueTask | undefined {
  const id: string = highlightTaskId(liveId);

  return tasks.find((task: QueueTask): boolean => task.id === id && task.status === 'running');
}

/* 有没有正在进行的切片任务（没有任何任务时「下载进度」这一列不显示） */
export function useHighlightRunning(): boolean {
  return useQueueTasks().some((task: QueueTask): boolean => task.kind === '切片' && task.status === 'running');
}

function HighlightRowProgress(props: { readonly liveId: string; readonly downloading: boolean; readonly children: ReactNode }): ReactElement {
  const { liveId, downloading, children }: { liveId: string; downloading: boolean; children: ReactNode } = props;
  const task: QueueTask | undefined = runningHighlight(useQueueTasks(), liveId);
  const { token }: { token: GlobalToken } = theme.useToken();

  if (!task) return <Fragment>{ children }</Fragment>;

  const percent: number = Math.floor(task.percent ?? 0);

  return (
    <Fragment>
      { downloading ? <div className="mb-[6px]">{ children }</div> : null }
      <span style={{ color: token.colorPrimary }} aria-label="切片进度" aria-valuenow={ percent }>自动切片 · 总进度 { percent }%</span>
      <div className="mt-[4px] h-[4px] w-[120px] overflow-hidden rounded-full" style={{ background: token.colorFillSecondary }}>
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${ percent }%`, background: token.colorPrimary }} />
      </div>
      <div className="mt-[4px] min-w-[280px] text-[12px]" style={{ color: token.colorTextSecondary }}>{ task.detail }</div>
    </Fragment>
  );
}

export default HighlightRowProgress;
