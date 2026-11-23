/**
 * 自动抓取（「直播抓取」页面的「开始自动抓取」）开播以后的流程（不碰界面、网络和文件，方便测试；真正的接线在 ./replayGrab）。
 * 用户 2026-11-23 定的：开播时只记下来，不录直播流（录下来的没有弹幕，画面也不如官方录播完整），直播结束后再下载、切片；
 * 开始自动抓取时勾选要什么：完整直播、切片，或者两个都要。
 *   1. 盯着的成员开播了：记下这场（存在本机），下载队列里挂一项「直播中，结束后…」
 *   2. 每隔几分钟查一次录播出来没有（直播地址变成录播的 m3u8，说明直播结束了）；从开播算起最多等 12 小时
 *   3. 录播出来了：下载完整的录播和弹幕。电台只存录音（.m4a）和电台封面（这场直播的封面图，.jpg），录播的画面只是口袋48的占位图
 *   4. 勾了「切片」：用下好的录播和弹幕做切片（数量「自动」；电台也切，2026-11-23 起）；没勾「完整直播」的，
 *      切完删掉录播、弹幕（和电台的封面），只留切片。切片失败、停止、不能切（没设置好 Gemini）时，录播照样留着
 * 还没做完的存在本机，重启程序后接着等、接着下、接着切（下到一半的分片不用重下）。
 * 旧版「录制并自动切片」留下的待办由 ./replayGrab 转成这里的（只切片，切完连同当时录的录像一起删掉）。
 */
export interface GrabRecord {
  liveId: string;
  title: string;
  ctime: string;
  liveType?: number;   // 1：直播，2：电台
  userInfo: { nickname: string };
}

export interface GrabActions {
  full: boolean;       // 留下完整的录播（和弹幕）
  clip: boolean;       // 做切片
}

export interface GrabEntry {
  record: GrabRecord;
  actions: GrabActions;
  dir?: string;              // 录播下到哪个文件夹（自动抓取设置里的）
  since?: number;            // 开始等录播的时间（开播时记下）
  file?: string;             // 下好的录播
  danmuFile?: string;        // 下好的弹幕（这场没有弹幕时没有）
  coverFile?: string;        // 电台封面
  legacy?: Array<string>;    // 旧版「录制并自动切片」录下来的录像：切完一起删
}

export type GrabOutcome = 'done' | 'stopped' | 'error';

export type GrabFiles = Required<Pick<GrabEntry, 'file'>> & Pick<GrabEntry, 'danmuFile' | 'coverFile'>;

export interface GrabDeps {
  isReplayReady(liveId: string): Promise<boolean>;
  // 下载完整的录播和弹幕（电台还有封面）；percent 是 0 ~ 100
  download(entry: GrabEntry, report: (percent: number, detail: string) => void, signal: AbortSignal): Promise<GrabFiles>;
  canClip(record: GrabRecord): boolean;
  // 用下好的录播做切片；不能开始时返回原因。切完（或停止、失败）后调用 onEnd
  startClip(record: GrabRecord, file: string, danmuFile: string | undefined, onEnd: (outcome: GrabOutcome, text: string) => void): string | undefined;
  remove(file: string): Promise<void>;
  load(): Array<GrabEntry>;
  save(entries: Array<GrabEntry>): void;
  // 下载队列里的一项：直播中、下载录播、切片中、结束
  taskStart(id: string, title: string, detail: string, stop: () => void): void;
  taskProgress(id: string, percent: number | undefined, detail: string): void;
  taskEnd(id: string, status: GrabOutcome, detail: string): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

export const REPLAY_POLL_MS: number = 3 * 60_000;       // 每 3 分钟查一次录播出来没有
export const REPLAY_WAIT_MS: number = 12 * 60 * 60_000; // 从开播算起最多等 12 小时

export function grabTaskId(liveId: string): string {
  return `grab:${ liveId }`;
}

/* 勾了什么，说成一句话 */
export function actionsText(actions: GrabActions): string {
  if (actions.full && actions.clip) return '下载完整录播并切片';

  return actions.clip ? '切片（切完删掉录播）' : '下载完整录播';
}

/* 旧版设置里记住的录制方式换成现在的选择：「录制并自动切片」是只要切片，别的是只要完整直播 */
export function actionsOfLegacyMode(mode: string | undefined): GrabActions {
  return mode === 'clip' ? { full: false, clip: true } : { full: true, clip: false };
}

function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/**
 * 录播下到哪个文件夹：待办里记的；没记（旧版转过来的）就用当时录像所在的文件夹；再没有用自动抓取设置的。
 * 不是绝对路径时返回空字符串（否则会落到程序的启动目录 C:\WINDOWS\system32 去，2026-11-23 实际遇到）
 * @param { GrabEntry } entry
 * @param { string } fallback - 自动抓取设置的文件夹
 */
export function saveDirOf(entry: GrabEntry, fallback: string): string {
  const legacyDir: string = entry.legacy?.[0]?.replace(/[\\/][^\\/]*$/, '') ?? '';
  const dir: string = [entry.dir, legacyDir, fallback].find((item: string | undefined): boolean => Boolean(item && item.trim())) ?? '';

  return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(dir) ? dir : '';
}

/**
 * 自动抓取下好、还留着的整场录播（切片失败或停止时会留着）：文件名是「[口袋48录播]_成员_标题_开播时间_liveId__下载时间.mp4」，
 * 旁边还有「同名.parts」文件夹的是没下完的，不算；同名的 .lrc 是弹幕。有好几个时用下载时间最晚的。
 * 电台找的是录音「[口袋48录播音频]_….m4a」（视频直播不找它：那是手动「下载音频」下的，没有画面）。
 * 在「录播下载」里再点「自动切片」时用它，不用把整场重新下一遍（见 custom/highlight/highlightTask 的 startHighlight）
 * @param { Array<string> } names - 文件夹里的文件名
 * @param { string } liveId
 * @param { boolean } [radio] - 这场是电台
 */
export function keptReplayOf(names: Array<string>, liveId: string, radio: boolean = false): { file: string; danmuFile?: string } | undefined {
  const all: Set<string> = new Set(names);
  const [prefix, ext]: [string, string] = radio ? ['[口袋48录播音频]', '.m4a'] : ['[口袋48录播]', '.mp4'];
  const file: string | undefined = names
    .filter((name: string): boolean => name.startsWith(prefix) && name.includes(`_${ liveId }__`) && name.endsWith(ext) && !all.has(`${ name }.parts`))
    .sort()
    .at(-1);

  if (!file) return undefined;

  const danmuFile: string = `${ file.slice(0, -ext.length) }.lrc`;

  return { file, danmuFile: all.has(danmuFile) ? danmuFile : undefined };
}

export class ReplayGrabber {
  private deps: GrabDeps;
  private entries: Map<string, GrabEntry> = new Map();
  private running: Map<string, AbortController> = new Map();
  private loaded: boolean = false;

  constructor(deps: GrabDeps) {
    this.deps = deps;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;

    this.loaded = true;

    for (const entry of this.deps.load()) {
      if (entry?.record?.liveId && entry.actions) this.entries.set(entry.record.liveId, { ...entry });
    }
  }

  private save(): void {
    this.deps.save(Array.from(this.entries.values()));
  }

  /* 这场直播是不是已经记下了（还没做完） */
  has(liveId: string): boolean {
    this.ensureLoaded();

    return this.entries.has(liveId);
  }

  /* 盯着的成员开播了：记下来，结束后按勾选的下载、切片。已经记过的不重复记 */
  track(record: GrabRecord, actions: GrabActions, dir: string): void {
    this.ensureLoaded();

    if (this.entries.has(record.liveId) || (!actions.full && !actions.clip)) return;

    const entry: GrabEntry = { record, actions, dir, since: this.deps.now() };

    this.entries.set(record.liveId, entry);
    this.save();
    void this.run(entry);
  }

  /* 程序启动时：上次没做完的接着做 */
  resume(): void {
    this.ensureLoaded();

    for (const entry of this.entries.values()) void this.run(entry);
  }

  private finish(entry: GrabEntry, status: GrabOutcome, detail: string): void {
    this.running.delete(entry.record.liveId);
    this.entries.delete(entry.record.liveId);
    this.save();
    this.deps.taskEnd(grabTaskId(entry.record.liveId), status, detail);
  }

  private async run(entry: GrabEntry): Promise<void> {
    const { liveId }: GrabRecord = entry.record;

    if (this.running.has(liveId)) return;

    const controller: AbortController = new AbortController();
    const id: string = grabTaskId(liveId);

    this.running.set(liveId, controller);
    entry.since ??= this.deps.now();
    this.deps.taskStart(id, `${ entry.record.userInfo.nickname } ${ entry.record.title }`,
      entry.file ? `录播已经下好了，接着${ entry.actions.clip ? '切片' : '处理' }…` : `直播中，结束后${ actionsText(entry.actions) }…`,
      (): void => {
        controller.abort();
        this.finish(entry, 'stopped', entry.file ? '已停止，录播保留着' : '已停止');
      });

    if (!entry.file) {
      // 等录播出来（直播结束后）
      for (;;) {
        if (controller.signal.aborted) return;

        let ready: boolean = false;

        try {
          ready = await this.deps.isReplayReady(liveId);
        } catch (err) {
          console.warn('自动抓取：查询录播失败，稍后再试', err);
        }

        if (controller.signal.aborted) return;

        if (ready) break;

        if (this.deps.now() - entry.since >= REPLAY_WAIT_MS) {
          this.finish(entry, 'error', `等了 ${ REPLAY_WAIT_MS / 3_600_000 } 个小时录播还没出来，没有下载`);

          return;
        }

        try {
          await this.deps.wait(REPLAY_POLL_MS, controller.signal);
        } catch {
          return; // 停止了
        }
      }

      // 下载完整的录播和弹幕
      this.deps.taskProgress(id, 0, '直播结束了，正在下载录播…');

      try {
        const got: GrabFiles = await this.deps.download(entry, (percent: number, detail: string): void => {
          this.deps.taskProgress(id, percent, detail);
        }, controller.signal);

        entry.file = got.file;
        entry.danmuFile = got.danmuFile;
        entry.coverFile = got.coverFile;
        this.save();
      } catch (err) {
        if (controller.signal.aborted) return;

        this.finish(entry, 'error', `录播下载失败：${ err instanceof Error ? err.message : String(err) }`);

        return;
      }
    }

    const file: string = entry.file!;

    if (!entry.actions.clip) {
      this.finish(entry, 'done', `录播下好了：${ fileName(file) }${ entry.danmuFile ? '（弹幕在旁边的 .lrc）' : '' }`);

      return;
    }

    if (!this.deps.canClip(entry.record)) {
      this.finish(entry, 'done', `这种直播不能切片；录播下好了，保留着：${ fileName(file) }`);

      return;
    }

    // 切片；只要切片的，切完删掉录播
    this.deps.taskProgress(id, 100, '录播下好了，正在切片（进度看下载队列里「切片」那一项）…');

    const reason: string | undefined = this.deps.startClip(entry.record, file, entry.danmuFile, (outcome: GrabOutcome, text: string): void => {
      void this.afterClip(entry, outcome, text);
    });

    if (reason) this.finish(entry, 'error', `没有切片（${ reason }），录播保留着`);
  }

  private async afterClip(entry: GrabEntry, outcome: GrabOutcome, text: string): Promise<void> {
    const ended: boolean = this.entries.get(entry.record.liveId) === entry; // 在下载队列里重试切片时这一项已经结束了

    if (outcome !== 'done') {
      if (ended) this.finish(entry, outcome, '切片没有做完，录播保留着（可以在下载队列里重试切片，做完后照样按勾选的处理录播）');

      return;
    }

    // 旧版录下来的录像都删；没勾「完整直播」的，下好的录播、弹幕和电台的封面也删
    const files: Array<string> = [
      ...(entry.legacy ?? []),
      ...(entry.actions.full ? [] : [entry.file!, entry.danmuFile, entry.coverFile].filter(Boolean) as Array<string>)
    ];
    const failed: Array<string> = [];

    for (const file of files) {
      try {
        await this.deps.remove(file);
      } catch (err) {
        console.warn('自动抓取：删除录播失败', file, err);
        failed.push(file);
      }
    }

    if (ended) {
      const kept: string = entry.actions.full ? '完整录播也留着' : '录播已删除，只留切片';

      this.finish(entry, 'done', failed.length === 0
        ? `${ text }。${ kept }`
        : `${ text }。有 ${ failed.length } 个文件没删掉（可能正被占用），可以手动删`);
    }
  }
}
