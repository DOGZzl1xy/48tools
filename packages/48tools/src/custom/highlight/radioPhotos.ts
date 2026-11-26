import { createHash } from 'node:crypto';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import { formatInZone, BEIJING } from '../time/timeZone';
import { safeFileName } from './highlightTime';
import { runFfmpeg } from './highlightFfmpeg';
import { libraryThumb, makePictureThumb, LIBRARY_FOLDER } from './highlightCover';
import { geminiJson, photoRankRequest, HighlightStopped, type GeminiConfig } from './highlightGemini';

/**
 * 电台切片的封面照片（用户 2026-11-26 定的）。电台没有画面，以前封面左边只有这场电台的封面一张，同一场的每个切片都一样。
 * 现在把她以前直播、电台的封面和电台的轮播图存进封面库（切片保存位置下面的 封面库/成员名/；
 * 每一场电台的封面都留着，人可以从里面挑，也可以自己往里放图），去掉重复的（文件一样的；看起来一样的也算：成员常常好几场用同一张封面，
 * 每次压出来的文件不一样，2026-11-26 曾昕妍的库里同一张照片有 7 份），让 Gemini 按适不适合做封面排个序，
 * 同一场的切片按排好的顺序轮着用（不重复），人可以换。
 * 接入点：./highlightPipeline 的 writeDrafts（电台写标题时）；照片从哪里取见 ./highlightTask 的 memberPhotos。
 */
export interface MemberPhoto {
  url: string;
  time: number;                     // 毫秒
  kind: '电台' | '直播';
  title?: string;
}

interface LibraryIndex {
  urls: Record<string, string>;     // 下载过的地址 → 存成了哪个文件（内容重复的指向已有的那个）
  hashes: Record<string, string>;   // 内容 → 文件
  looks: Record<string, string>;    // 文件 → 长什么样（imageLook）
}

const INDEX_FILE: string = '.index.json';
const IMAGE: RegExp = /\.(jpe?g|png|webp|bmp)$/i;
const RANK_FROM: number = 30;       // 最近的多少张交给 Gemini 排

export const RADIO_PICTURES: number = 12; // 每个切片除了这场电台自己的封面，再给几张候选
const DOWNLOAD_AT_ONCE: number = 4;

/* 一个成员的封面库 */
export function libraryDir(showDir: string, member: string): string {
  return path.join(path.dirname(showDir), LIBRARY_FOLDER, safeFileName(member, 60));
}

/* 存成什么名字：北京时间、哪来的、标题，按名字排就是按时间排 */
export function photoName(when: string, kind: MemberPhoto['kind'], title?: string): string {
  return `${ safeFileName(`${ when } ${ kind }${ title ? ` ${ title }` : '' }`, 80) }.jpg`;
}

async function readIndex(dir: string): Promise<LibraryIndex> {
  try {
    const saved: Partial<LibraryIndex> = JSON.parse(await fsP.readFile(path.join(dir, INDEX_FILE), 'utf8'));

    return { urls: saved.urls ?? {}, hashes: saved.hashes ?? {}, looks: saved.looks ?? {} };
  } catch {
    return { urls: {}, hashes: {}, looks: {} };
  }
}

function exists(file: string): Promise<boolean> {
  return fsP.access(file).then((): boolean => true, (): boolean => false);
}

/* 名字被别的照片占了就加个编号 */
async function freeName(dir: string, name: string): Promise<string> {
  const { name: base, ext }: path.ParsedPath = path.parse(name);

  for (let count: number = 1; ; count++) {
    const next: string = count === 1 ? name : `${ base } ${ count }${ ext }`;

    if (!(await exists(path.join(dir, next)))) return next;
  }
}

export const LOOK_WIDTH: number = 9;
export const LOOK_HEIGHT: number = 8;
const SAME_LOOK: number = 6; // 64 位里差几位以内算同一张（同一张照片压缩、缩放过是 0 ~ 4，别的照片一般差 15 以上）

/* 一张图长什么样（dHash）：缩成 9×8 的灰度图，每一行相邻两个比谁亮，64 位，写成 16 个十六进制字 */
export function imageLook(gray: Uint8Array): string {
  let bits: bigint = 0n;

  for (let y: number = 0; y < LOOK_HEIGHT; y++) {
    for (let x: number = 0; x < LOOK_WIDTH - 1; x++) {
      bits = (bits << 1n) | (gray[(y * LOOK_WIDTH) + x] < gray[(y * LOOK_WIDTH) + x + 1] ? 1n : 0n);
    }
  }

  return bits.toString(16).padStart(16, '0');
}

/* 两张图差几位 */
export function lookDistance(a: string, b: string): number {
  let diff: bigint = BigInt(`0x${ a }`) ^ BigInt(`0x${ b }`);
  let count: number = 0;

  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }

  return count;
}

/* 读一张图长什么样；读不了（不是图片）是 undefined */
async function readLook(ffmpeg: string, dir: string, file: string, signal?: AbortSignal): Promise<string | undefined> {
  const out: string = path.join(dir, '.look.gray');

  try {
    await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vf', `scale=${ LOOK_WIDTH }:${ LOOK_HEIGHT }:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', out], { signal });

    const gray: Buffer = await fsP.readFile(out);

    return gray.length >= LOOK_WIDTH * LOOK_HEIGHT ? imageLook(gray) : undefined;
  } catch (err) {
    if (signal?.aborted) throw new HighlightStopped();

    return undefined;
  } finally {
    await fsP.rm(out, { force: true }).catch((): void => undefined);
  }
}

/* 一个文件放进库里（已经有一样的、看起来一样的就不放；库里删掉的，和它一样的也不再放回来），返回库里的文件名 */
async function keep(dir: string, index: LibraryIndex, temp: string, name: string, move: boolean, ffmpeg?: string, signal?: AbortSignal): Promise<string> {
  const hash: string = createHash('sha1').update(await fsP.readFile(temp)).digest('hex');
  let same: string | undefined = index.hashes[hash];
  const look: string | undefined = !same && ffmpeg ? await readLook(ffmpeg, dir, temp, signal) : undefined;

  if (look) same = Object.keys(index.looks).find((other: string): boolean => lookDistance(index.looks[other], look) <= SAME_LOOK);

  if (same) {
    move && await fsP.rm(temp, { force: true });

    return same;
  }

  const file: string = await freeName(dir, name);

  await (move ? fsP.rename(temp, path.join(dir, file)) : fsP.copyFile(temp, path.join(dir, file)));
  index.hashes[hash] = file;
  look && (index.looks[file] = look);

  return file;
}

/* 库里的照片，新的在前（名字开头是时间的按时间，别的按改动时间） */
export async function libraryFiles(dir: string): Promise<Array<string>> {
  let names: Array<string> = [];

  try {
    names = (await fsP.readdir(dir)).filter((name: string): boolean => IMAGE.test(name) && !name.startsWith('.'));
  } catch {
    return [];
  }

  const dated: Array<{ file: string; when: string }> = await Promise.all(names.map(async (name: string): Promise<{ file: string; when: string }> => {
    const file: string = path.join(dir, name);
    const prefix: RegExpMatchArray | null = name.match(/^\d{4}-\d{2}-\d{2}( \d{2}\.\d{2})?/);
    const when: string = prefix ? prefix[0] : formatInZone((await fsP.stat(file)).mtimeMs, BEIJING, 'YYYY-MM-DD HH.mm');

    return { file, when };
  }));

  return dated.sort((a: { when: string }, b: { when: string }): number => b.when.localeCompare(a.when)).map(({ file }: { file: string }): string => file);
}

interface SaveInput {
  dir: string;
  photos: Array<MemberPhoto>;
  own?: { file: string; when: string; title: string };   // 这场电台自己的封面（本机已经有的）
  fetchImage: (url: string, file: string, signal?: AbortSignal) => Promise<void>;
  ffmpeg?: string;                                        // 有的话看起来一样的也只留一张
  signal?: AbortSignal;
}

/**
 * 照片存进封面库：下载过的地址不再下载，内容一样的、看起来一样的只留一张
 * @return { Promise<string | undefined> } 这场电台自己的封面在库里是哪个文件
 */
export async function saveToLibrary(input: SaveInput): Promise<string | undefined> {
  const { dir, photos, own, fetchImage, ffmpeg, signal }: SaveInput = input;
  const index: LibraryIndex = await readIndex(dir);
  // 下载过的不再下载（库里删掉的也不再下回来）
  const wanted: Array<MemberPhoto> = photos.filter((photo: MemberPhoto, order: number): boolean => (
    photo.url !== '' && photos.findIndex((one: MemberPhoto): boolean => one.url === photo.url) === order && index.urls[photo.url] === undefined));
  const queue: Array<number> = wanted.map((_photo: MemberPhoto, order: number): number => order);
  const downloaded: Array<boolean> = [];
  const temp: (order: number) => string = (order: number): string => path.join(dir, `.download-${ order }.jpg`);

  await fsP.mkdir(dir, { recursive: true });

  // 同时下几张；下好了再按原来的顺序放进库里（内容一样的留哪个名字每次都一样）
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_AT_ONCE, queue.length) }, async (): Promise<void> => {
    while (queue.length > 0) {
      if (signal?.aborted) throw new HighlightStopped();

      const order: number = queue.shift()!;

      try {
        await fetchImage(wanted[order].url, temp(order), signal);
        downloaded[order] = true;
      } catch (err) {
        if (signal?.aborted) throw new HighlightStopped();

        console.warn('封面库：照片没有下载下来', wanted[order].url, err); // 下次再试
      }
    }
  }));

  for (const [order, photo] of wanted.entries()) {
    if (!downloaded[order]) continue;

    const when: string = formatInZone(photo.time, BEIJING, 'YYYY-MM-DD HH.mm') || formatInZone(Date.now(), BEIJING, 'YYYY-MM-DD HH.mm');

    index.urls[photo.url] = await keep(dir, index, temp(order), photoName(when, photo.kind, photo.title), true, ffmpeg, signal);
  }

  let ownFile: string | undefined;

  if (own && await exists(own.file)) ownFile = path.join(dir, await keep(dir, index, own.file, photoName(own.when, '电台', own.title), false, ffmpeg, signal));

  await fsP.writeFile(path.join(dir, INDEX_FILE), JSON.stringify(index, null, 2));

  return ownFile;
}

/* 库里还没有小图的照片做好小图（给人挑、交给 Gemini 看）；做不了的（坏图）不要 */
export async function ensureThumbs(ffmpeg: string, files: Array<string>, signal?: AbortSignal): Promise<Array<string>> {
  const good: Array<string> = [];

  for (const file of files) {
    try {
      (await exists(libraryThumb(file))) || await makePictureThumb(ffmpeg, file, libraryThumb(file), false, signal);
      good.push(file);
    } catch (err) {
      if (signal?.aborted) throw new HighlightStopped();

      console.warn('封面库：这张图读不了', file, err);
    }
  }

  return good;
}

/* Gemini 排好的：第几张（从 1 起）→ 文件；不在范围里、重复的不要 */
export function readRank(order: unknown, files: Array<string>): Array<string> {
  if (!Array.isArray(order)) return [];

  const picked: Array<string> = [];

  for (const value of order) {
    const file: string | undefined = Number.isInteger(value) ? files[(value as number) - 1] : undefined;

    if (file && !picked.includes(file)) picked.push(file);
  }

  return picked.slice(0, RADIO_PICTURES);
}

export interface RadioPhotos {
  files: Array<string>;    // 库里最近的照片（完整路径），新的在前
  ranked: Array<string>;   // Gemini 排好的，好的在前；没排成时是空的
  own?: string;            // 这场电台自己的封面在库里是哪个文件
}

interface CollectInput {
  showDir: string;
  member: string;
  title: string;
  date: string;            // 2026.11.25
  liveId: string;
  picture?: string;        // 这场电台的封面（本机的）
  ffmpeg: string;
  gemini: GeminiConfig;
  memberPhotos?: (liveId: string, signal?: AbortSignal) => Promise<Array<MemberPhoto>>;
  fetchImage?: (url: string, file: string, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * 写电台的标题前：更新封面库，交给 Gemini 排序。取不到照片、Gemini 没回答都不耽误写标题（就只有这场电台自己的封面）
 */
export async function collectRadioPhotos(input: CollectInput): Promise<RadioPhotos> {
  const { showDir, member, title, date, liveId, picture, ffmpeg, gemini, memberPhotos, fetchImage, fetchImpl, signal }: CollectInput = input;
  const dir: string = libraryDir(showDir, member);
  let photos: Array<MemberPhoto> = [];

  if (memberPhotos) {
    try {
      photos = await memberPhotos(liveId, signal);
    } catch (err) {
      if (signal?.aborted) throw new HighlightStopped();

      console.warn('封面库：取不到她以前的封面和照片', err);
    }
  }

  const own: string | undefined = await saveToLibrary({
    dir,
    photos,
    own: picture ? { file: picture, when: date.replace(/\./g, '-'), title } : undefined,
    fetchImage: fetchImage ?? ((): Promise<void> => Promise.reject(new Error('不能下载'))),
    ffmpeg,
    signal
  });
  const files: Array<string> = await ensureThumbs(ffmpeg, (await libraryFiles(dir)).slice(0, RANK_FROM), signal);

  if (files.length < 2) return { files, ranked: [], own };

  try {
    const images: Array<string> = await Promise.all(files.map(async (file: string): Promise<string> => (await fsP.readFile(libraryThumb(file))).toString('base64')));
    const answer: { order?: unknown } = await geminiJson<{ order?: unknown }>(gemini, photoRankRequest(member, images), signal, fetchImpl);

    return { files, ranked: readRank(answer.order, files), own };
  } catch (err) {
    if (err instanceof HighlightStopped) throw err;

    console.warn('封面库：Gemini 没排成，先用这场电台的封面', err);

    return { files, ranked: [], own };
  }
}

/**
 * 一场里第 order 个（从 0 起）切片的封面候选：排好的（没排成就是最近的）几张，默认用排在第 order 个的（轮着用，同一场不重复）。
 * pick 是 undefined 时用这场电台自己的封面
 */
export function radioChoice(photos: RadioPhotos, order: number): { pictures: Array<string>; pick?: string } {
  const pool: Array<string> = (photos.ranked.length > 0 ? photos.ranked : photos.files)
    .filter((file: string): boolean => file !== photos.own).slice(0, RADIO_PICTURES);
  const pick: string | undefined = photos.ranked.length > 0 ? photos.ranked[order % photos.ranked.length] : undefined;

  return { pictures: pool, pick: pick && pool.includes(pick) ? pick : undefined };
}
