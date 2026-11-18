import * as fs from 'node:fs';
import { shell } from 'electron';
import { Fragment, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { FloatButton, Drawer, Progress, Tag, Button, Empty, Typography, Space } from 'antd';
import { DownloadOutlined as IconDownloadOutlined } from '@ant-design/icons';
import {
  useQueueTasks,
  queueTaskRemove,
  queueClearFinished,
  type QueueTask,
  type QueueTaskStatus
} from './downloadQueue';

/**
 * 下载队列的界面：右下角的悬浮按钮（显示正在进行的任务数），点开是任务列表。
 * 没有任何任务时不显示。数据来自 ./downloadQueue。
 * 接入点：src/index.tsx（放在路由旁边，所有页面都能看到）。
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
        { isRunning ? null : <Button size="small" type="text" onClick={ (): void => queueTaskRemove(task.id) }>移除</Button> }
      </Space>
    </div>
  );
}

function DownloadQueuePanel(props: {}): ReactElement | null {
  const tasks: Array<QueueTask> = useQueueTasks();
  const [open, setOpen]: [boolean, D<S<boolean>>] = useState(false);
  const running: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status === 'running');
  const hasFinished: boolean = running.length < tasks.length;

  if (tasks.length === 0 && !open) return null;

  return (
    <Fragment>
      <FloatButton icon={ <IconDownloadOutlined /> }
        type={ running.length > 0 ? 'primary' : 'default' }
        tooltip={ running.length > 0 ? `正在进行 ${ running.length } 个任务` : '下载队列' }
        badge={{ count: running.length, color: 'blue' }}
        style={{ insetInlineEnd: 28, insetBlockEnd: 28 }}
        onClick={ (): void => setOpen(true) }
      />
      <Drawer title={ `下载队列${ running.length > 0 ? `（进行中 ${ running.length }）` : '' }` }
        open={ open }
        width={ 440 }
        extra={ hasFinished ? <Button size="small" onClick={ queueClearFinished }>清除已结束</Button> : null }
        onClose={ (): void => setOpen(false) }
      >
        {
          tasks.length === 0
            ? <Empty description="没有任务" />
            : tasks.map((task: QueueTask): ReactElement => <TaskItem key={ task.id } task={ task } />)
        }
      </Drawer>
    </Fragment>
  );
}

export default DownloadQueuePanel;
