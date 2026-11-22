/* eslint-disable require-await */ // 假的「录播出来没有」要返回 Promise，但里面没有什么可等的
/**
 * 「自动抓取并切片」：录完等录播出来、切片、切完删掉录像；失败、停止、等太久时保留录像；重启后接着做。
 */
import {
  AutoClipper, autoClipTaskId, REPLAY_POLL_MS, REPLAY_WAIT_MS,
  type AutoClipDeps, type AutoClipEntry, type AutoClipOutcome, type AutoClipRecord
} from './autoClipCore';

const record: AutoClipRecord = { liveId: '1', title: '测试直播', ctime: '0', liveType: 1, userInfo: { nickname: 'SNH48-测试成员' } };

interface Fake {
  deps: AutoClipDeps;
  ready: boolean;
  checks: number;
  started: Array<AutoClipRecord>;
  removed: Array<string>;
  tasks: Map<string, { status: string; detail: string; stop?: () => void }>;
  saved: Array<AutoClipEntry>;
  clock: number;
  finishClip?: (outcome: AutoClipOutcome, text: string) => void;
  startReason?: string;
}

function fake(saved: Array<AutoClipEntry> = []): Fake {
  const f: Fake = {
    ready: false, checks: 0, started: [], removed: [], tasks: new Map(), saved, clock: 1_000,
    deps: undefined as unknown as AutoClipDeps
  };

  f.deps = {
    isReplayReady: async (): Promise<boolean> => {
      f.checks += 1;

      return f.ready;
    },
    startClip(clip: AutoClipRecord, onEnd: (outcome: AutoClipOutcome, text: string) => void): string | undefined {
      if (f.startReason) return f.startReason;

      f.started.push(clip);
      f.finishClip = onEnd;

      return undefined;
    },
    removeRecording: async (file: string): Promise<void> => {
      f.removed.push(file);
    },
    load: (): Array<AutoClipEntry> => JSON.parse(JSON.stringify(f.saved)),
    save(entries: Array<AutoClipEntry>): void {
      f.saved = JSON.parse(JSON.stringify(entries));
    },
    taskStart(id: string, title: string, detail: string, stop: () => void): void {
      f.tasks.set(id, { status: 'running', detail, stop });
    },
    taskDetail(id: string, detail: string): void {
      f.tasks.get(id)!.detail = detail;
    },
    taskEnd(id: string, status: string, detail: string): void {
      f.tasks.set(id, { status, detail });
    },
    // 等待：时间往前走，马上返回（停止时报错）
    wait: async (ms: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new Error('已停止');

      f.clock += ms;
    },
    now: (): number => f.clock
  };

  return f;
}

async function settle(): Promise<void> {
  for (let i: number = 0; i < 20; i++) await Promise.resolve();
}

describe('AutoClipper', (): void => {
  test('录播还没出来时隔一会儿查一次，不切片；出来以后开始切片', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    clipper.recordingStart(record, 'a.flv');
    expect(f.checks).toBe(0); // 还在录：不查
    clipper.recordingEnd(record.liveId);
    await settle();

    expect(f.checks).toBeGreaterThan(1);
    expect(f.clock).toBeGreaterThanOrEqual(1_000 + REPLAY_POLL_MS); // 两次查询之间等了一会儿
    expect(f.started).toEqual([]);
    expect(f.tasks.get(autoClipTaskId('1'))?.status).toBe('running');

    f.ready = true;
    await settle();
    expect(f.started).toEqual([record]);
  });

  test('录播出来就切片，切完删录像；任务显示做了什么', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    f.ready = true;
    clipper.recordingStart(record, 'a.flv');
    clipper.recordingEnd(record.liveId);
    await settle();

    expect(f.started).toEqual([record]);
    expect(f.tasks.get('autoclip:1')?.detail).toContain('正在切片');

    f.finishClip!('done', '做了 2 个切片：甲、乙');
    await settle();

    expect(f.removed).toEqual(['a.flv']);
    expect(f.tasks.get('autoclip:1')).toEqual({ status: 'done', detail: '做了 2 个切片：甲、乙。录像已删除，只留切片' });
    expect(f.saved).toEqual([]);
    expect(clipper.has('1')).toBe(false);
  });

  test('同一场断开后又录了一段：都录完才开始，两个录像都删', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    f.ready = true;
    clipper.recordingStart(record, 'a.flv');
    clipper.recordingStart(record, 'b.flv');
    clipper.recordingEnd(record.liveId);
    await settle();
    expect(f.started).toEqual([]);

    clipper.recordingEnd(record.liveId);
    await settle();
    f.finishClip!('done', '做了 1 个切片：甲');
    await settle();

    expect(f.removed).toEqual(['a.flv', 'b.flv']);
  });

  test('切片失败或停止：录像保留着', async (): Promise<void> => {
    for (const outcome of ['error', 'stopped'] as Array<AutoClipOutcome>) {
      const f: Fake = fake();
      const clipper: AutoClipper = new AutoClipper(f.deps);

      f.ready = true;
      clipper.recordingStart(record, 'a.flv');
      clipper.recordingEnd(record.liveId);
      await settle();
      f.finishClip!(outcome, '');
      await settle();

      expect(f.removed).toEqual([]);
      expect(f.tasks.get('autoclip:1')?.status).toBe(outcome);
      expect(f.tasks.get('autoclip:1')?.detail).toContain('录像保留着');
    }
  });

  test('之后在下载队列里重试切片成功了：也删掉录像', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    f.ready = true;
    clipper.recordingStart(record, 'a.flv');
    clipper.recordingEnd(record.liveId);
    await settle();
    f.finishClip!('error', '');
    await settle();
    f.finishClip!('done', '做了 1 个切片：甲'); // 重试时带着同一个回调
    await settle();

    expect(f.removed).toEqual(['a.flv']);
    expect(f.tasks.get('autoclip:1')?.status).toBe('error'); // 这一项之前已经结束，不改
  });

  test('不能切片（没填 key 之类）：录像保留，说明原因', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    f.ready = true;
    f.startReason = '还没有填写 Gemini 的 API key';
    clipper.recordingStart(record, 'a.flv');
    clipper.recordingEnd(record.liveId);
    await settle();

    expect(f.removed).toEqual([]);
    expect(f.tasks.get('autoclip:1')).toEqual({ status: 'error', detail: '没有切片（还没有填写 Gemini 的 API key），录像保留着' });
  });

  test('等太久录播还没出来：放弃，录像保留', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    clipper.recordingStart(record, 'a.flv');
    clipper.recordingEnd(record.liveId);

    for (let i: number = 0; i < (REPLAY_WAIT_MS / REPLAY_POLL_MS) + 5 && f.tasks.get('autoclip:1')?.status === 'running'; i++) await settle();

    expect(f.tasks.get('autoclip:1')?.status).toBe('error');
    expect(f.tasks.get('autoclip:1')?.detail).toContain('录播还没出来');
    expect(f.removed).toEqual([]);
    expect(f.saved).toEqual([]);
  });

  test('等录播时点停止：不再等，录像保留', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);

    f.deps.wait = (): Promise<void> => new Promise((): void => undefined); // 一直等
    clipper.recordingStart(record, 'a.flv');
    clipper.recordingEnd(record.liveId);
    await settle();
    f.tasks.get('autoclip:1')!.stop!();
    await settle();

    expect(f.tasks.get('autoclip:1')).toEqual({ status: 'stopped', detail: '已停止，录像保留着' });
    expect(f.started).toEqual([]);
    expect(clipper.has('1')).toBe(false);
  });

  test('重启程序：上次没做完的接着做（上次正在录的当作录完了）', async (): Promise<void> => {
    const f: Fake = fake([{ record, files: ['a.flv'], recording: 1 }]);
    const clipper: AutoClipper = new AutoClipper(f.deps);

    f.ready = true;
    expect(clipper.has('1')).toBe(true);
    clipper.resume();
    await settle();
    expect(f.started).toEqual([record]);

    f.finishClip!('done', '做了 1 个切片：甲');
    await settle();
    expect(f.removed).toEqual(['a.flv']);
  });

  test('录播出来以后才开始的也能马上切（第二次查询）', async (): Promise<void> => {
    const f: Fake = fake();
    const clipper: AutoClipper = new AutoClipper(f.deps);
    let calls: number = 0;

    f.deps.isReplayReady = async (): Promise<boolean> => (++calls) >= 2;
    clipper.recordingStart(record, 'a.flv');
    clipper.recordingEnd(record.liveId);
    await settle();

    expect(calls).toBe(2);
    expect(f.started).toEqual([record]);
  });
});
