/* eslint-disable require-await */ // 假的「录播出来没有」「下载」要返回 Promise，但里面没有什么可等的
/**
 * 自动抓取：开播时记下来，直播结束后等录播出来，下载完整录播和弹幕，按勾选的切片；只要切片的切完删掉录播；
 * 失败、停止、不能切时录播保留；等太久、下载失败时说明原因；重启后接着做。
 */
import {
  ReplayGrabber, grabTaskId, actionsText, actionsOfLegacyMode, saveDirOf, keptReplayOf, REPLAY_POLL_MS, REPLAY_WAIT_MS,
  type GrabDeps, type GrabEntry, type GrabFiles, type GrabOutcome, type GrabRecord, type GrabActions
} from './replayGrabCore';

const record: GrabRecord = { liveId: '1', title: '测试直播', ctime: '0', liveType: 1, userInfo: { nickname: 'SNH48-测试成员' } };
const radio: GrabRecord = { ...record, liveId: '2', liveType: 2 };
const FULL: GrabActions = { full: true, clip: false };
const CLIP: GrabActions = { full: false, clip: true };
const BOTH: GrabActions = { full: true, clip: true };
const TASK: string = grabTaskId('1');

interface Fake {
  deps: GrabDeps;
  ready: boolean;
  checks: number;
  downloads: Array<string>;
  downloadError?: string;
  started: Array<{ liveId: string; file: string; danmuFile?: string }>;
  removed: Array<string>;
  tasks: Map<string, { status: string; detail: string; percent?: number; stop?: () => void }>;
  saved: Array<GrabEntry>;
  clock: number;
  finishClip?: (outcome: GrabOutcome, text: string) => void;
  found?: () => void;
  startReason?: string;
}

function fake(saved: Array<GrabEntry> = []): Fake {
  const f: Fake = {
    ready: false, checks: 0, downloads: [], started: [], removed: [], tasks: new Map(), saved, clock: 1_000,
    deps: undefined as unknown as GrabDeps
  };

  f.deps = {
    isReplayReady: async (): Promise<boolean> => {
      f.checks += 1;

      return f.ready;
    },
    download: async (entry: GrabEntry, report: (percent: number, detail: string) => void): Promise<GrabFiles> => {
      f.downloads.push(entry.record.liveId);
      report(50, '下载录播 50%');

      if (f.downloadError) throw new Error(f.downloadError);

      const base: string = `${ entry.dir }/录播${ entry.record.liveId }`;

      // 电台：录音和封面
      return entry.record.liveType === 2
        ? { file: `${ base }.m4a`, danmuFile: `${ base }.lrc`, coverFile: `${ base }.jpg` }
        : { file: `${ base }.mp4`, danmuFile: `${ base }.lrc` };
    },
    canClip: (item: GrabRecord): boolean => [1, 2].includes(Number(item.liveType)),
    startClip(item: GrabRecord, file: string, danmuFile: string | undefined, onEnd: (outcome: GrabOutcome, text: string) => void, onFound: () => void): string | undefined {
      if (f.startReason) return f.startReason;

      f.started.push({ liveId: item.liveId, file, danmuFile });
      f.finishClip = onEnd;
      f.found = onFound;

      return undefined;
    },
    remove: async (file: string): Promise<void> => {
      f.removed.push(file);
    },
    load: (): Array<GrabEntry> => JSON.parse(JSON.stringify(f.saved)),
    save(entries: Array<GrabEntry>): void {
      f.saved = JSON.parse(JSON.stringify(entries));
    },
    taskStart(id: string, title: string, detail: string, stop: () => void): void {
      f.tasks.set(id, { status: 'running', detail, stop });
    },
    taskProgress(id: string, percent: number | undefined, detail: string): void {
      Object.assign(f.tasks.get(id)!, { percent, detail });
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
  for (let i: number = 0; i < 30; i++) await Promise.resolve();
}

/* 一直等、撤掉才返回的等待（看「还在等」时的样子） */
function hang(_ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((_resolve: () => void, reject: (reason: Error) => void): void => {
    signal.addEventListener('abort', (): void => reject(new Error('已停止')), { once: true });
  });
}

describe('ReplayGrabber', (): void => {
  test('开播时记下来，录播还没出来就隔一会儿查一次；出来以后下载。只要完整直播：下好就结束，不切片、不删', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    grabber.track(record, FULL, 'D:/下载');
    await settle();

    expect(f.tasks.get(TASK)?.detail).toBe('直播中，结束后下载完整录播…'); // 一直没出来：任务停在「直播中」
    expect(f.checks).toBeGreaterThan(1);
    expect(f.clock).toBeGreaterThanOrEqual(1_000 + REPLAY_POLL_MS);
    expect(f.downloads).toEqual([]);
    expect(f.saved).toEqual([{ record, actions: FULL, dir: 'D:/下载', since: 1_000 }]);

    f.ready = true;
    await settle();

    expect(f.downloads).toEqual(['1']);
    expect(f.started).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.tasks.get(TASK)).toEqual({ status: 'done', detail: '录播下好了：录播1.mp4（弹幕在旁边的 .lrc）' });
    expect(f.saved).toEqual([]);
    expect(grabber.has('1')).toBe(false);
  });

  test('只要切片：下好录播后用它切，切完删掉录播和弹幕', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    grabber.track(record, CLIP, 'D:/下载');
    await settle();

    expect(f.started).toEqual([{ liveId: '1', file: 'D:/下载/录播1.mp4', danmuFile: 'D:/下载/录播1.lrc' }]);
    expect(f.tasks.get(TASK)?.detail).toContain('正在找爆点');

    // 找好了等人挑：录播先留着
    f.found!();
    expect(f.tasks.get(TASK)?.detail).toContain('等你在「切片」页面挑好');
    expect(f.removed).toEqual([]);

    f.finishClip!('done', '做了 2 个切片：甲、乙');
    await settle();

    expect(f.removed).toEqual(['D:/下载/录播1.mp4', 'D:/下载/录播1.lrc']);
    expect(f.tasks.get(TASK)).toEqual({ status: 'done', detail: '做了 2 个切片：甲、乙。录播已删除，只留切片' });
    expect(f.saved).toEqual([]);
  });

  test('都要：切完录播留着', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    grabber.track(record, BOTH, 'D:/下载');
    await settle();
    f.finishClip!('done', '做了 1 个切片：甲');
    await settle();

    expect(f.removed).toEqual([]);
    expect(f.tasks.get(TASK)?.detail).toBe('做了 1 个切片：甲。完整录播也留着');
  });

  test('切片失败或停止：只要切片的录播也留着；之后在下载队列里重试成功了再删', async (): Promise<void> => {
    for (const outcome of ['error', 'stopped'] as Array<GrabOutcome>) {
      const f: Fake = fake();
      const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

      f.ready = true;
      grabber.track(record, CLIP, 'D:/下载');
      await settle();
      f.finishClip!(outcome, '');
      await settle();

      expect(f.removed).toEqual([]);
      expect(f.tasks.get(TASK)).toMatchObject({ status: outcome });
      expect(f.tasks.get(TASK)?.detail).toContain('录播保留着');

      f.finishClip!('done', '做了 1 个切片：甲'); // 重试时带着同一个回调
      await settle();
      expect(f.removed).toEqual(['D:/下载/录播1.mp4', 'D:/下载/录播1.lrc']);
      expect(f.tasks.get(TASK)?.status).toBe(outcome); // 这一项之前已经结束，不改
    }
  });

  test('不能切片（没设置好 Gemini 之类）：录播保留，说明原因', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    f.startReason = '还没有填写 Gemini 的 API key';
    grabber.track(record, CLIP, 'D:/下载');
    await settle();

    expect(f.removed).toEqual([]);
    expect(f.tasks.get(TASK)).toEqual({ status: 'error', detail: '没有切片（还没有填写 Gemini 的 API key），录播保留着' });
  });

  test('电台勾了切片：和直播一样切，切完删掉录音、弹幕和封面', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    grabber.track(radio, CLIP, 'D:/下载');
    await settle();

    expect(f.downloads).toEqual(['2']);
    expect(f.started).toEqual([{ liveId: '2', file: 'D:/下载/录播2.m4a', danmuFile: 'D:/下载/录播2.lrc' }]);

    f.finishClip!('done', '做了 2 个切片');
    await settle();

    expect(f.removed).toEqual(['D:/下载/录播2.m4a', 'D:/下载/录播2.lrc', 'D:/下载/录播2.jpg']);
    expect(f.tasks.get(grabTaskId('2'))?.status).toBe('done');
  });

  test('电台勾了完整直播和切片：录音和封面都留着', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    grabber.track(radio, BOTH, 'D:/下载');
    await settle();
    f.finishClip!('done', '做了 2 个切片');
    await settle();

    expect(f.removed).toEqual([]);
    expect(f.tasks.get(grabTaskId('2'))?.detail).toContain('完整录播也留着');
  });

  test('不能切的直播勾了切片：录播下好后保留着', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    grabber.track({ ...record, liveId: '3', liveType: 5 }, CLIP, 'D:/下载');
    await settle();

    expect(f.downloads).toEqual(['3']);
    expect(f.started).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.tasks.get(grabTaskId('3'))?.detail).toContain('不能切片；录播下好了，保留着');
  });

  test('从开播算起等了 12 小时录播还没出来：放弃，没有下载', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    grabber.track(record, BOTH, 'D:/下载');

    for (let i: number = 0; i < (REPLAY_WAIT_MS / REPLAY_POLL_MS) + 5 && f.tasks.get(TASK)?.status === 'running'; i++) await settle();

    expect(f.tasks.get(TASK)).toEqual({ status: 'error', detail: '等了 12 个小时录播还没出来，没有下载' });
    expect(f.downloads).toEqual([]);
    expect(f.saved).toEqual([]);
  });

  test('等录播时点停止：不再等，什么都不下载', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.deps.wait = hang;
    grabber.track(record, BOTH, 'D:/下载');
    await settle();
    f.tasks.get(TASK)!.stop!();
    f.ready = true;
    await settle();

    expect(f.tasks.get(TASK)).toEqual({ status: 'stopped', detail: '已停止' });
    expect(f.downloads).toEqual([]);
    expect(grabber.has('1')).toBe(false);
  });

  test('下载失败：说明原因，不切片', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    f.downloadError = '这场直播没有录播地址';
    grabber.track(record, BOTH, 'D:/下载');
    await settle();

    expect(f.tasks.get(TASK)).toEqual({ status: 'error', detail: '录播下载失败：这场直播没有录播地址' });
    expect(f.started).toEqual([]);
  });

  test('同一场每一轮都看到在播：只记一次；一个都没勾时不记', async (): Promise<void> => {
    const f: Fake = fake();
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.deps.wait = hang;
    grabber.track(record, FULL, 'D:/下载');
    grabber.track(record, BOTH, 'D:/别的');
    grabber.track(radio, { full: false, clip: false }, 'D:/下载');
    await settle();

    expect(f.saved).toEqual([{ record, actions: FULL, dir: 'D:/下载', since: 1_000 }]);
    expect(grabber.has('2')).toBe(false);
  });

  test('重启程序：上次没做完的接着做；已经下好的不再下载，直接切片', async (): Promise<void> => {
    const f: Fake = fake([
      { record, actions: CLIP, dir: 'D:/下载', since: 1_000, file: 'D:/下载/录播1.mp4', danmuFile: 'D:/下载/录播1.lrc' },
      { record: { ...record, liveId: '3' }, actions: FULL, dir: 'D:/下载', since: 1_000 }
    ]);
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    expect(grabber.has('1')).toBe(true);
    grabber.resume();
    await settle();

    expect(f.downloads).toEqual(['3']);
    expect(f.started).toEqual([{ liveId: '1', file: 'D:/下载/录播1.mp4', danmuFile: 'D:/下载/录播1.lrc' }]);
  });

  test('旧版「录制并自动切片」留下的：切完连当时录的录像一起删', async (): Promise<void> => {
    const f: Fake = fake([{ record, actions: CLIP, dir: 'D:/下载', legacy: ['D:/下载/直播录像.flv'] }]);
    const grabber: ReplayGrabber = new ReplayGrabber(f.deps);

    f.ready = true;
    grabber.resume();
    await settle();
    f.finishClip!('done', '做了 1 个切片：甲');
    await settle();

    expect(f.removed).toEqual(['D:/下载/直播录像.flv', 'D:/下载/录播1.mp4', 'D:/下载/录播1.lrc']);
  });
});

describe('录播存到哪里', (): void => {
  test('记了用记的；没记（旧版转过来的）用当时录像的文件夹；再没有用设置的；不是绝对路径时不用（以前落到了 C:\\WINDOWS\\system32）', (): void => {
    expect(saveDirOf({ record, actions: CLIP, dir: 'D:\\下载' }, 'E:\\设置的')).toBe('D:\\下载');
    expect(saveDirOf({ record, actions: CLIP, legacy: ['C:\\Users\\a\\download\\直播录像.flv'] }, 'E:\\设置的')).toBe('C:\\Users\\a\\download');
    expect(saveDirOf({ record, actions: CLIP }, 'E:\\设置的')).toBe('E:\\设置的');
    expect(saveDirOf({ record, actions: CLIP, dir: '' }, '')).toBe('');
    expect(saveDirOf({ record, actions: CLIP, dir: '相对路径' }, '')).toBe('');
  });
});

describe('选择', (): void => {
  test('说成一句话', (): void => {
    expect(actionsText(FULL)).toBe('下载完整录播');
    expect(actionsText(CLIP)).toBe('切片（切完删掉录播）');
    expect(actionsText(BOTH)).toBe('下载完整录播并切片');
  });

  test('旧版记住的录制方式：「录制并切片」换成只切片，别的换成只要完整直播', (): void => {
    expect(actionsOfLegacyMode('clip')).toEqual(CLIP);
    expect(actionsOfLegacyMode('ts')).toEqual(FULL);
    expect(actionsOfLegacyMode(undefined)).toEqual(FULL);
  });
});

describe('自动抓取下好、还留着的录播（再点「自动切片」时直接用）', (): void => {
  const base: string = '[口袋48录播]_SNH48-测试成员_测试直播_2026-11-22~09.50.49_42__2026-11-22~12.34.45';

  test('找这场的 mp4 和同名的弹幕', (): void => {
    expect(keptReplayOf([`${ base }.mp4`, `${ base }.lrc`, '别的文件.mp4'], '42')).toEqual({ file: `${ base }.mp4`, danmuFile: `${ base }.lrc` });
    expect(keptReplayOf([`${ base }.mp4`], '42')).toEqual({ file: `${ base }.mp4`, danmuFile: undefined });
  });

  test('别的场次、没下完的（旁边还有 .parts 文件夹）、录像、音频都不算', (): void => {
    expect(keptReplayOf([`${ base }.mp4`], '4')).toBeUndefined();
    expect(keptReplayOf([`${ base }.mp4`, `${ base }.mp4.parts`], '42')).toBeUndefined();
    expect(keptReplayOf(['[口袋48直播(自动录制)]_SNH48-测试成员_测试直播_2026-11-22~09.50.49_42__2026-11-22~09.51.34.flv'], '42')).toBeUndefined();
    expect(keptReplayOf(['[口袋48录播音频]_SNH48-测试成员_测试直播_2026-11-22~09.50.49_42__2026-11-22~12.34.45.m4a'], '42')).toBeUndefined();
  });

  test('电台找录音（.m4a）和同名的弹幕；视频录播不算，没下完的不算', (): void => {
    const audio: string = '[口袋48录播音频]_SNH48-测试成员_测试电台_2026-11-22~09.50.49_42__2026-11-22~12.34.45';

    expect(keptReplayOf([`${ audio }.m4a`, `${ audio }.lrc`, `${ audio }.jpg`], '42', true)).toEqual({ file: `${ audio }.m4a`, danmuFile: `${ audio }.lrc` });
    expect(keptReplayOf([`${ base }.mp4`], '42', true)).toBeUndefined();
    expect(keptReplayOf([`${ audio }.m4a`, `${ audio }.m4a.parts`], '42', true)).toBeUndefined();
  });

  test('有好几个时用下载时间最晚的', (): void => {
    const older: string = '[口袋48录播]_SNH48-测试成员_测试直播_2026-11-22~09.50.49_42__2026-11-22~11.00.00.mp4';

    expect(keptReplayOf([`${ base }.mp4`, older], '42')?.file).toBe(`${ base }.mp4`);
  });
});
