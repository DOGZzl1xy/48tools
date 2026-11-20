import { queueTaskStart, queueTaskProgress, queueTaskEnd, getQueueTasks, resetQueueForTest, type QueueTask } from './downloadQueue';

describe('download queue', function(): void {
  beforeEach(resetQueueForTest);

  test('updates replace the task object so the UI can tell it changed', function(): void {
    queueTaskStart({ id: 'a', title: 'A', kind: '音频', percent: 0 });

    const before: QueueTask = getQueueTasks()[0];

    queueTaskProgress('a', 40, '1 MB/s');

    const after: QueueTask = getQueueTasks()[0];

    expect(after).not.toBe(before);
    expect(before.percent).toBe(0);
    expect(after.percent).toBe(40);
    expect(after.detail).toBe('1 MB/s');

    queueTaskProgress('a', 10); // 进度不会倒退
    expect(getQueueTasks()[0].percent).toBe(40);
  });

  test('finished tasks keep their result and ignore later progress', function(): void {
    queueTaskStart({ id: 'a', title: 'A', kind: '音频', percent: 0 });
    queueTaskEnd('a', 'done', undefined, '10 MB');
    queueTaskProgress('a', 5);
    expect(getQueueTasks()[0]).toMatchObject({ status: 'done', percent: 100, detail: '10 MB' });
  });

  test('tasks are saved, and unfinished ones come back as stopped after a restart', function(): void {
    const saved: Record<string, string> = {};

    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string): string | null => saved[key] ?? null,
      setItem: (key: string, value: string): void => {
        saved[key] = value;
      },
      removeItem: (key: string): void => {
        delete saved[key];
      }
    };

    try {
      queueTaskStart({ id: 'a', title: 'A', kind: '视频', percent: 0, stop: (): void => undefined, retry: (): void => undefined });
      queueTaskStart({ id: 'b', title: 'B', kind: '音频', percent: 0 });
      queueTaskEnd('b', 'done');

      const history: Array<QueueTask> = JSON.parse(saved.DOWNLOAD_QUEUE_HISTORY);

      expect(history.map((task: QueueTask): string => `${ task.id }:${ task.status }`)).toEqual(['b:done', 'a:running']);
      expect(history[1].stop).toBeUndefined(); // 函数存不下来

      // 「重启」：重新加载这个模块
      jest.isolateModules((): void => {
        const fresh: typeof import('./downloadQueue') = require('./downloadQueue');
        const restored: Array<QueueTask> = fresh.getQueueTasks();

        expect(restored.map((task: QueueTask): string => `${ task.id }:${ task.status }`)).toEqual(['b:done', 'a:stopped']);
        expect(restored[1].detail).toBe('程序关闭时还没完成');
        expect(restored[1].retry).toBeUndefined();
      });
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
