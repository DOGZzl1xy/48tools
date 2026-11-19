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
});
