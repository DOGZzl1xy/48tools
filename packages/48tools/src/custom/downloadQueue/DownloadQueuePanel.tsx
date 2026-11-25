import * as fs from 'node:fs';
import { shell } from 'electron';
import type { ReactElement } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router';
import { App, Drawer, Progress, Tag, Button, Empty, Typography, Space, Tooltip } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import { useShellState, setQueueOpen, type ShellState } from '../shell/shellStore';
import { selectShow } from '../highlight/showStore';
import {
  useQueueTasks,
  queueTaskRemove,
  queueClearFinished,
  type QueueTask,
  type QueueTaskStatus
} from './downloadQueue';

/**
 * 下载队列的界面：从右边滑出的任务列表。入口是侧边栏底部的「下载队列」（显示正在进行的任务数和总进度）。
 * 数据来自 ./downloadQueue，开关状态在 shell/shellStore。失败或停止的任务有「重试」（这次运行里开始的任务才有）。
 * 找好爆点、写好标题、切完的任务可以直接去切片页面（custom/highlight/HighlightsPage）看那一场。
 * 右上角「清除记录」把已经结束的任务从列表里拿掉（文件不删），每一条上的「移除」只拿掉那一条。
 * 由 custom/shell/AppShell 渲染，所有页面都能打开。
 */
const statusText: Record<QueueTaskStatus, string> = {
  running: '进行中',
  done: '已完成',
  error: '失败',
  stopped: '已停止'
};

const statusColor: Record<QueueTaskStatus, string> = {
  running: 'processing',
  done: 'success',
  error: 'error',
  stopped: 'default'
};

const pickText: Record<string, string> = { 找爆点: '去挑爆点', 写标题: '去定标题' };

function showInFolder(filePath: string): void {
  // 文件还没生成（例如下载中）时打开所在的文件夹
  if (fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  } else {
    shell.openPath(filePath.replace(/[\\/][^\\/]*$/, ''));
  }
}

function TaskItem(props: { task: QueueTask }): ReactElement {
  const { task }: { task: QueueTask } = props;
  const navigate: NavigateFunction = useNavigate();
  const isRunning: boolean = task.status === 'running';
  const toPick: boolean = task.kind in pickText; // 找好了等着挑，写好了等着定

  function handleShowClick(): void {
    selectShow(task.filePath);
    setQueueOpen(false);
    navigate('/48/Highlights');
  }

  return (
    <div className="py-[12px] border-b border-solid border-x-0 border-t-0 border-[#8882]">
      <div className="flex items-start gap-[8px]">
        <Tag className="shrink-0 mr-0">{ task.kind }</Tag>
        <Typography.Text className="grow" ellipsis={{ tooltip: task.title }}>{ task.title }</Typography.Text>
        <Tag className="shrink-0 mr-0" color={ statusColor[task.status] }>{ statusText[task.status] }</Tag>
      </div>
      {
        task.percent !== undefined && task.status !== 'done' ? (
          <Progress className="mt-[6px] mb-0"
            percent={ Number(task.percent.toFixed(1)) }
            size="small"
            status={ task.status === 'error' ? 'exception' : (isRunning ? 'active' : 'normal') }
          />
        ) : null
      }
      {
        (task.error || task.detail) ? (
          <Typography.Text className="block mt-[4px] text-[12px]" type={ task.error ? 'danger' : 'secondary' }>
            { task.error || task.detail }
          </Typography.Text>
        ) : null
      }
      <Space className="mt-[6px]" size={ 4 }>
        { isRunning && task.stop ? <Button size="small" danger={ true } onClick={ (): void => task.stop?.() }>停止</Button> : null }
        {
          (toPick || task.kind === '切片' || task.kind === '改标题') && task.status === 'done' && task.filePath
            ? <Button size="small" type={ toPick ? 'primary' : 'default' } ghost={ toPick } onClick={ handleShowClick }>{ pickText[task.kind] ?? '看切片' }</Button>
            : null
        }
        {
          task.filePath
            ? <Button size="small" onClick={ (): void => showInFolder(task.filePath!) }>打开所在文件夹</Button>
            : null
        }
        {
          !isRunning && task.status !== 'done' && task.retry
            ? <Button size="small" type="primary" ghost={ true } onClick={ (): void => task.retry?.() }>重试</Button>
            : null
        }
        { isRunning ? null : <Button size="small" type="text" onClick={ (): void => queueTaskRemove(task.id) }>移除</Button> }
      </Space>
    </div>
  );
}

function DownloadQueuePanel(props: {}): ReactElement {
  const tasks: Array<QueueTask> = useQueueTasks();
  const { queueOpen }: ShellState = useShellState();
  const running: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status === 'running');
  const hasFinished: boolean = running.length < tasks.length;
  const { message: messageApi }: useAppProps = App.useApp();

  /* 清除记录：只是把已经结束的从列表里拿掉，文件还在 */
  function handleClearClick(): void {
    const count: number = tasks.length - running.length;

    queueClearFinished();
    messageApi.success(`已清除 ${ count } 条记录，下载好的文件还在`);
  }

  return (
    <Drawer title={ `下载队列${ running.length > 0 ? `（进行中 ${ running.length }）` : '' }` }
      open={ queueOpen }
      width={ 440 }
      extra={ (
        <Tooltip title="只清掉这里已经结束的记录（完成、失败、停止的），下载好的文件不会删除；进行中的任务不受影响" placement="bottomRight">
          <Button size="small" disabled={ !hasFinished } onClick={ handleClearClick }>清除记录</Button>
        </Tooltip>
      ) }
      onClose={ (): void => setQueueOpen(false) }
    >
      {
        tasks.length === 0
          ? <Empty description="还没有任务。开始下载或录制后会显示在这里" />
          : tasks.map((task: QueueTask): ReactElement => <TaskItem key={ task.id } task={ task } />)
      }
    </Drawer>
  );
}

export default DownloadQueuePanel;
