import * as fs from 'node:fs';
import { shell } from 'electron';
import type { ReactElement } from 'react';
import { Drawer, Progress, Tag, Button, Empty, Typography, Space } from 'antd';
import { useShellState, setQueueOpen, type ShellState } from '../shell/shellStore';
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
  const isRunning: boolean = task.status === 'running';

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

  return (
    <Drawer title={ `下载队列${ running.length > 0 ? `（进行中 ${ running.length }）` : '' }` }
      open={ queueOpen }
      width={ 440 }
      extra={ hasFinished ? <Button size="small" onClick={ queueClearFinished }>清除已结束</Button> : null }
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
