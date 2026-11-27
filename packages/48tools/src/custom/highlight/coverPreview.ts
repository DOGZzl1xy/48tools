import { promises as fsP } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { useEffect, useState, type Dispatch as D, type SetStateAction as S } from 'react';
import { getFFmpeg } from '../../utils/utils';
import { teamOfName, useMemberDirectory } from '../room/memberDirectory';
import { pickFonts } from './highlightFfmpeg';
import { coverDir, makeCovers, type CoverJob } from './highlightCover';
import { shortMemberName, teamColorOf } from './highlightTheme';
import { draftCoverLines, lookOf } from './highlightDraft';
import { highlightOf, type ShowInfo, type ShowItem } from './highlightShow';
import type { FontSet } from './highlightAss';
import type { Highlight } from './highlightTypes';

/**
 * 定标题时看的封面：和最后放进文件夹的是同一张（./highlightCover 的 makeCovers），改一下就重做，一两秒。
 * 同时最多做两个切片的；同一个切片的一个接一个做，排着队又改了的不做。
 */
const WORK_DIR: string = path.join(os.tmpdir(), '48tools-covers'); // 字幕文件、字体放在这里（文件夹名不能有中文和空格，ffmpeg 的滤镜里要写）
const AT_ONCE: number = 2;
const DELAY: number = 250;
let fonts: Promise<FontSet> | undefined;
let running: number = 0;
const waiting: Array<() => void> = [];
const chains: Map<string, Promise<unknown>> = new Map();

async function loadFonts(): Promise<FontSet> {
  await fsP.mkdir(WORK_DIR, { recursive: true });

  return pickFonts(WORK_DIR);
}

function previewFonts(): Promise<FontSet> {
  fonts ??= loadFonts().catch((err: unknown): never => {
    fonts = undefined; // 下次再试

    throw err;
  });

  return fonts;
}

async function takeTurn<T>(run: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((resolve: () => void): number => waiting.push(resolve));

  running++;

  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

type Covers = { wide: string; standard: string };

/* 做一次预览；signal 停了（又改了）就不做 */
function previewCovers(dir: string, job: CoverJob, item: ShowItem, signal: AbortSignal): Promise<Covers | undefined> {
  const covers: string = coverDir(dir, item.draft!.key);

  async function run(): Promise<Covers | undefined> {
    if (signal.aborted) return undefined;

    return makeCovers({
      ffmpeg: getFFmpeg(), cwd: WORK_DIR, dir: covers, job, highlight: highlightOf(item), draft: item.draft!, fonts: await previewFonts(), signal
    });
  }

  const next: Promise<Covers | undefined> = (chains.get(covers) ?? Promise.resolve()).catch((): void => undefined)
    .then((): Promise<Covers | undefined> => takeTurn(run));

  chains.set(covers, next);

  return next;
}

export interface CoverPreview {
  covers?: Covers;  // 图的地址（file://，带版本，改了会重新读）
  loading: boolean;
  error?: string;
}

/* 一个切片的封面预览 */
export function useCoverPreview(dir: string, info: ShowInfo, item: ShowItem): CoverPreview {
  const [preview, setPreview]: [CoverPreview, D<S<CoverPreview>>] = useState<CoverPreview>({ loading: true });
  const directory: ReturnType<typeof useMemberDirectory> = useMemberDirectory();
  const memberTeam: string | undefined = info.stage ? info.stage.team : teamOfName(directory, shortMemberName(info.member))?.label;
  const coverJob: CoverJob = {
    member: info.member,
    date: info.date,
    radio: info.radio,
    team: memberTeam,
    teamColor: info.stage ? info.stage.teamColor : teamColorOf(memberTeam),
    stage: info.stage
  };
  const highlight: Highlight = highlightOf(item);
  const look: string = `${ item.draft!.key } ${ memberTeam ?? '' } ${ Boolean(info.radio) } ${ lookOf(item.draft!) } ${ info.stage ? draftCoverLines(highlight, item.draft!).join('\n') : '' }`;

  useEffect((): (() => void) => {
    const controller: AbortController = new AbortController();

    setPreview((now: CoverPreview): CoverPreview => ({ ...now, loading: true }));

    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      previewCovers(dir, coverJob, item, controller.signal).then((covers: Covers | undefined): void => {
        if (!covers || controller.signal.aborted) return;

        const version: number = Date.now();

        setPreview({
          loading: false,
          covers: { wide: `${ pathToFileURL(covers.wide).href }?v=${ version }`, standard: `${ pathToFileURL(covers.standard).href }?v=${ version }` }
        });
      }, (err: unknown): void => {
        if (controller.signal.aborted) return;

        console.error('封面预览失败', err);
        setPreview({ loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    }, DELAY);

    return (): void => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dir, look]);

  return preview;
}
