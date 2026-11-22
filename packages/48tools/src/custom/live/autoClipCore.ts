/**
 * 「自动抓取并切片」的流程（不碰界面、网络和文件，方便测试；真正的接线在 ./autoClip）：
 *   1. 自动抓取照常录：录像只是备份，万一录播取不到（被删、一直没出来）还有它
 *   2. 这场直播的录制都结束后，每隔几分钟查一次录播出来没有（直播地址变成录播的 m3u8）
 *   3. 录播出来了就做切片（数量「自动」，和「录播下载 → 自动切片」一样：用官方录播，画面完整、弹幕对得上）
 *   4. 切片做完（成功）删掉这场的录像，只留切片；失败、停止、等太久录播还没出来、不能切片时保留录像
 *   电台没有画面不能切，不走这个流程（照常保留录像）。
 *   还没做完的场次存在本机（重启程序后 resume 接着等、接着切；切到一半的会接着上次的进度）。
 */
export interface AutoClipRecord {
  liveId: string;
  title: string;
  ctime: string;
  liveType?: number;
  userInfo: { nickname: string };
}

export interface AutoClipEntry {
  record: AutoClipRecord;
  files: Array<string>;   // 这场的录像（断开后重新录会有好几个）
  recording: number;      // 还有几个录制没结束（都结束了才开始等录播）
  since?: number;         // 开始等录播的时间
}

export type AutoClipOutcome = 'done' | 'stopped' | 'error';

export interface AutoClipDeps {
  isReplayReady(liveId: string): Promise<boolean>;
  // 开始切片；不能开始时返回原因。切完（或停止、失败）后调用 onEnd
  startClip(record: AutoClipRecord, onEnd: (outcome: AutoClipOutcome, text: string) => void): string | undefined;
  removeRecording(file: string): Promise<void>;   // 删掉一个录像（连同断线重连产生的 xxx(1).flv 等）
  load(): Array<AutoClipEntry>;
  save(entries: Array<AutoClipEntry>): void;
  // 下载队列里的一项：等录播、切片中、结束
  taskStart(id: string, title: string, detail: string, stop: () => void): void;
  taskDetail(id: string, detail: string): void;
  taskEnd(id: string, status: 'done' | 'stopped' | 'error', detail: string): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

export const REPLAY_POLL_MS: number = 3 * 60_000;      // 每 3 分钟查一次录播出来没有
export const REPLAY_WAIT_MS: number = 6 * 60 * 60_000; // 最多等 6 小时

export function autoClipTaskId(liveId: string): string {
  return `autoclip:${ liveId }`;
}

export class AutoClipper {
  private deps: AutoClipDeps;
  private entries: Map<string, AutoClipEntry> = new Map();
  private waiting: Map<string, AbortController> = new Map();
  private loaded: boolean = false;

  constructor(deps: AutoClipDeps) {
    this.deps = deps;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;

    this.loaded = true;

    for (const entry of this.deps.load()) {
      if (entry?.record?.liveId) this.entries.set(entry.record.liveId, { ...entry, files: [...(entry.files ?? [])] });
    }
  }

  private save(): void {
    this.deps.save(Array.from(this.entries.values()));
  }

  /* 这场直播是不是「录完要切片」的 */
  has(liveId: string): boolean {
    this.ensureLoaded();

    return this.entries.has(liveId);
  }

  /* 开始录一场要切片的直播 */
  recordingStart(record: AutoClipRecord, file: string): void {
    this.ensureLoaded();

    const entry: AutoClipEntry = this.entries.get(record.liveId) ?? { record, files: [], recording: 0 };

    if (!entry.files.includes(file)) entry.files.push(file);

    entry.recording += 1;
    this.entries.set(record.liveId, entry);
    this.save();
  }

  /* 一个录制结束了；这场的录制都结束后开始等录播 */
  recordingEnd(liveId: string): void {
    this.ensureLoaded();

    const entry: AutoClipEntry | undefined = this.entries.get(liveId);

    if (!entry) return;

    entry.recording = Math.max(0, entry.recording - 1);
    this.save();

    if (entry.recording === 0) void this.waitAndClip(entry);
  }

  /* 程序启动时：上次没做完的接着做（上次正在录的，录制已经随程序退出断了） */
  resume(): void {
    this.ensureLoaded();

    for (const entry of this.entries.values()) {
      entry.recording = 0;
      void this.waitAndClip(entry);
    }

    this.save();
  }

  private finish(entry: AutoClipEntry, status: 'done' | 'stopped' | 'error', detail: string): void {
    this.waiting.delete(entry.record.liveId);
    this.entries.delete(entry.record.liveId);
    this.save();
    this.deps.taskEnd(autoClipTaskId(entry.record.liveId), status, detail);
  }

  private async waitAndClip(entry: AutoClipEntry): Promise<void> {
    const { liveId }: AutoClipRecord = entry.record;

    if (this.waiting.has(liveId)) return;

    const controller: AbortController = new AbortController();
    const id: string = autoClipTaskId(liveId);

    this.waiting.set(liveId, controller);
    entry.since ??= this.deps.now();
    this.save();
    this.deps.taskStart(id, `${ entry.record.userInfo.nickname } ${ entry.record.title }`, '直播结束了，等录播出来后自动切片…', (): void => {
      controller.abort();
      this.finish(entry, 'stopped', '已停止，录像保留着');
    });

    // 等录播出来
    for (;;) {
      if (controller.signal.aborted) return;

      let ready: boolean = false;

      try {
        ready = await this.deps.isReplayReady(liveId);
      } catch (err) {
        console.warn('自动切片：查询录播失败，稍后再试', err);
      }

      if (controller.signal.aborted) return;

      if (ready) break;

      if (this.deps.now() - entry.since >= REPLAY_WAIT_MS) {
        this.finish(entry, 'error', `等了 ${ REPLAY_WAIT_MS / 3_600_000 } 个小时录播还没出来，没有切片，录像保留着`);

        return;
      }

      try {
        await this.deps.wait(REPLAY_POLL_MS, controller.signal);
      } catch {
        return; // 停止了
      }
    }

    // 切片；做完删掉录像
    this.deps.taskDetail(id, '录播出来了，正在切片（进度看下载队列里「切片」那一项），切完会删掉录像');

    const files: Array<string> = [...entry.files];
    const reason: string | undefined = this.deps.startClip(entry.record, (outcome: AutoClipOutcome, text: string): void => {
      void this.afterClip(entry, files, outcome, text);
    });

    if (reason) this.finish(entry, 'error', `没有切片（${ reason }），录像保留着`);
  }

  private async afterClip(entry: AutoClipEntry, files: Array<string>, outcome: AutoClipOutcome, text: string): Promise<void> {
    const ended: boolean = this.entries.get(entry.record.liveId) === entry; // 在下载队列里重试切片时这一项已经结束了

    if (outcome !== 'done') {
      if (ended) this.finish(entry, outcome, '切片没有做完，录像保留着（可以在下载队列里重试切片，做完后会删掉录像）');

      return;
    }

    const failed: Array<string> = [];

    for (const file of files) {
      try {
        await this.deps.removeRecording(file);
      } catch (err) {
        console.warn('自动切片：删除录像失败', file, err);
        failed.push(file);
      }
    }

    if (ended) {
      this.finish(entry, 'done', failed.length === 0
        ? `${ text }。录像已删除，只留切片`
        : `${ text }。有 ${ failed.length } 个录像没删掉（可能正被占用），可以手动删`);
    }
  }
}
