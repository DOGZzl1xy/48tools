/**
 * 语音转文字的本地缓存（IndexedDB，数据在程序的配置目录里，不会上传）。
 * 单独一个数据库（不和房间消息缓存放一起），这样「清除房间缓存」不会把已经转好的文字删掉。
 *   - transcripts：语音的标识 → 转出来的文字（转过一次就不用再转，不再花钱）
 *   - audio：语音的标识 → 语音文件本身。只存转写过的语音（转写时本来就要下载）。
 *     用处：重新转写时不用再下载；原来的地址失效时还能播放（见 ./VoiceMessage）。
 * 语音的标识：房间语音消息用消息里自带的 md5，没有的（翻牌语音）用地址。
 */
export interface TranscriptRecord {
  id: string;
  text: string;
  model: string;
  createdAt: number;
}

export interface AudioRecord {
  id: string;
  mimeType: string;
  bytes: ArrayBuffer;
  savedAt: number;
}

const DB_NAME: string = 'custom-transcripts';
const TRANSCRIPTS: string = 'transcripts';
const AUDIO: string = 'audio';

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve: (db: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
    const request: IDBOpenDBRequest = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (): void => {
      const db: IDBDatabase = request.result;

      if (!db.objectStoreNames.contains(TRANSCRIPTS)) db.createObjectStore(TRANSCRIPTS, { keyPath: 'id' });

      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'id' });
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => {
      dbPromise = undefined;
      reject(request.error);
    };
  });

  return dbPromise;
}

async function get<T>(store: string, id: string): Promise<T | undefined> {
  try {
    const db: IDBDatabase = await openDb();
    const request: IDBRequest<T | undefined> = db.transaction(store, 'readonly').objectStore(store).get(id);

    return await new Promise((resolve: (value: T | undefined) => void, reject: (reason: unknown) => void): void => {
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error);
    });
  } catch (err) {
    console.error('读取语音转文字缓存失败', err);

    return undefined;
  }
}

async function put(store: string, record: TranscriptRecord | AudioRecord): Promise<void> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction(store, 'readwrite');

    transaction.objectStore(store).put(record);
    await new Promise((resolve: (value: void) => void, reject: (reason: unknown) => void): void => {
      transaction.oncomplete = (): void => resolve();
      transaction.onerror = (): void => reject(transaction.error);
      transaction.onabort = (): void => reject(transaction.error);
    });
  } catch (err) {
    console.error('写入语音转文字缓存失败', err);
  }
}

export function getTranscript(id: string): Promise<TranscriptRecord | undefined> {
  return get<TranscriptRecord>(TRANSCRIPTS, id);
}

export function putTranscript(record: TranscriptRecord): Promise<void> {
  return put(TRANSCRIPTS, record);
}

export function getAudio(id: string): Promise<AudioRecord | undefined> {
  return get<AudioRecord>(AUDIO, id);
}

export function putAudio(record: AudioRecord): Promise<void> {
  return put(AUDIO, record);
}
