/**
 * 语音转文字的本地缓存（IndexedDB，数据在程序的配置目录里，不会上传）。
 * 单独一个数据库（不和房间消息缓存放一起），这样「清除房间缓存」不会把已经转好的文字删掉。
 *   - transcripts：语音的标识 → 转出来的文字（转过一次就不用再转，不再花钱）
 *   - audio：语音的标识 → 语音文件本身。只存转写过的语音（转写时本来就要下载）。
 *     用处：重新转写时不用再下载；原来的地址失效时还能播放（见 ./VoiceMessage）。
 *     语音文件只保留 AUDIO_KEEP_DAYS 天（约 6 个月），更早的在程序启动后自动删掉（purgeOldAudio）；转好的文字一直保留。
 * 语音的标识：房间语音消息用消息里自带的 md5，没有的（翻牌语音）用地址。
 */
import { createDbOpener, requestResult, transactionDone } from '../common/idb';

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

const SAVED_INDEX: string = 'savedAt';
const AUDIO_KEEP_DAYS: number = 183;

// 版本 2：语音表加了按保存时间的索引（删旧语音时用）
const openDb: () => Promise<IDBDatabase> = createDbOpener(DB_NAME, 2, function(db: IDBDatabase, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(TRANSCRIPTS)) db.createObjectStore(TRANSCRIPTS, { keyPath: 'id' });


  const audio: IDBObjectStore = db.objectStoreNames.contains(AUDIO)
    ? transaction.objectStore(AUDIO)
    : db.createObjectStore(AUDIO, { keyPath: 'id' });

  if (!audio.indexNames.contains(SAVED_INDEX)) audio.createIndex(SAVED_INDEX, 'savedAt');
});

async function get<T>(store: string, id: string): Promise<T | undefined> {
  try {
    const db: IDBDatabase = await openDb();

    return await requestResult<T | undefined>(db.transaction(store, 'readonly').objectStore(store).get(id));
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
    await transactionDone(transaction);
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

/* 所有转好的文字（导出房间消息时用）：语音的标识 → 文字 */
export async function getAllTranscripts(): Promise<Map<string, string>> {
  const texts: Map<string, string> = new Map();

  try {
    const db: IDBDatabase = await openDb();
    const records: Array<TranscriptRecord> = await requestResult<Array<TranscriptRecord>>(
      db.transaction(TRANSCRIPTS, 'readonly').objectStore(TRANSCRIPTS).getAll());

    for (const record of records) texts.set(record.id, record.text);
  } catch (err) {
    console.error('读取语音转文字缓存失败', err);
  }

  return texts;
}

/**
 * 删掉保存时间早于 keepDays 天之前的语音文件（文字不删），返回删了多少条
 * @param { number } [keepDays]
 * @param { number } [now] - 测试用
 */
export async function purgeOldAudio(keepDays: number = AUDIO_KEEP_DAYS, now: number = Date.now()): Promise<number> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction(AUDIO, 'readwrite');
    const store: IDBObjectStore = transaction.objectStore(AUDIO);
    const finished: Promise<void> = transactionDone(transaction);
    const keys: Array<IDBValidKey> = await requestResult<Array<IDBValidKey>>(
      store.index(SAVED_INDEX).getAllKeys(IDBKeyRange.upperBound(now - (keepDays * 86_400_000), true)));

    for (const key of keys) store.delete(key);

    await finished;

    return keys.length;
  } catch (err) {
    console.error('清理旧语音失败', err);

    return 0;
  }
}
