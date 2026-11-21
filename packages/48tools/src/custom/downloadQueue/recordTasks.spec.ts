/**
 * 录播下载登记到下载队列：点了停止的显示「已停止」（不管文件有没有留下），并说明下载到一半的内容在哪里。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordTaskStart, recordTaskEnd, recordTaskStopping, stoppedDetail } from './recordTasks';
import { getQueueTasks, resetQueueForTest, type QueueTask } from './downloadQueue';

const record: { liveId: string; title: string; ctime: string; userInfo: { nickname: string } } = {
  liveId: '1', title: '测试直播', ctime: '0', userInfo: { nickname: '测试成员' }
};

describe('recordTasks', (): void => {
  let dir: string;

  beforeEach((): void => {
    resetQueueForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-task-'));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function task(): QueueTask {
    return getQueueTasks()[0];
  }

  test('视频下到一半点了停止：文件留着，但显示「已停止」而不是「已完成」', (): void => {
    const file: string = path.join(dir, '录播.ts');

    recordTaskStart(record, file, false, (): void => undefined);
    fs.writeFileSync(file, '下到一半');
    recordTaskStopping(record.liveId);
    recordTaskEnd(record.liveId, file, { type: 'close' });

    expect(task()).toMatchObject({ status: 'stopped', detail: '已停止。已下载的部分留在保存的文件里（不完整）' });
  });

  test('下载队列里点停止也一样', (): void => {
    const file: string = path.join(dir, '录播.ts');
    const stop: jest.Mock = jest.fn();

    recordTaskStart(record, file, false, stop);
    fs.writeFileSync(file, '下到一半');
    task().stop?.();
    recordTaskEnd(record.liveId, file, { type: 'close' });

    expect(stop).toHaveBeenCalled();
    expect(task().status).toBe('stopped');
  });

  test('没点停止、文件生成了：已完成；下次再下同一场不受上次停止的影响', (): void => {
    const file: string = path.join(dir, '录播.ts');

    recordTaskStart(record, file, false, (): void => undefined);
    recordTaskStopping(record.liveId);
    recordTaskStart(record, file, false, (): void => undefined); // 重新开始
    fs.writeFileSync(file, '完整的');
    recordTaskEnd(record.liveId, file, { type: 'close' });

    expect(task().status).toBe('done');
  });

  test('停止后的说明：音频说可以接着下，备用方案说分片在 .cache 里', (): void => {
    const audio: string = path.join(dir, '录播.m4a');
    const video: string = path.join(dir, '录播2.ts');

    fs.writeFileSync(path.join(dir, '录播.part.aac'), '');
    fs.mkdirSync(`${ video }.cache`);

    expect(stoppedDetail(audio)).toBe('已停止。已下载的部分保留着，再下载这场的音频时可以接着下');
    expect(stoppedDetail(video)).toBe('已停止。已下载的分片留在「录播2.ts.cache」文件夹里');
    expect(stoppedDetail(path.join(dir, '什么都没有.ts'))).toBe('已停止');
  });
});
