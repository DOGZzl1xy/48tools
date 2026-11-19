import type { CustomMessageV2 } from '@48tools-api/48';

/**
 * 房间消息的本地缓存（浏览器自带的 IndexedDB，数据在程序的配置目录里，不会上传）。
 * 每个房间存两样东西：
 *   - messages：已经取到的消息（接口返回的原始内容，只存成员发的那些）
 *   - meta：房间的 serverId / channelId，以及「往更早翻」用的位置（nextTime）和是否已经翻到头
 * 这样下次打开房间时先显示本地的消息，再只去取比本地更新的部分（见 ./roomStore）。
 * 图片、语音、视频本身不存，只存它们的地址。
 */
export interface RoomCacheMeta {
  ownerId: number;
  serverId?: number;
  channelId?: number;
  nextTime: number;
  hasMore: boolean;
  updatedAt: number;
}

interface MessageRecord {
  ownerId: number;
  key: string;
  msgTime: number;
  raw: CustomMessageV2;
}

export interface RoomCacheData {
  meta?: RoomCacheMeta;
  messages: Array<CustomMessageV2>; // 从旧到新
}

const DB_NAME: string = 'custom-room-cache';
const DB_VERSION: number = 1;
const META: string = 'meta';
const MESSAGES: string = 'messages';

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve: (db: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
    const request: IDBOpenDBRequest = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (): void => {
      const db: IDBDatabase = request.result;

      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'ownerId' });

      if (!db.objectStoreNames.contains(MESSAGES)) {
        db.createObjectStore(MESSAGES, { keyPath: ['ownerId', 'key'] }).createIndex('ownerId', 'ownerId');
      }
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => {
      dbPromise = undefined;
      reject(request.error);
    };
  });

  return dbPromise;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: unknown) => void): void => {
    transaction.oncomplete = (): void => resolve();
    transaction.onerror = (): void => reject(transaction.error);
    transaction.onabort = (): void => reject(transaction.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

/* 读取一个房间的缓存；读不到（或出错）时返回空 */
export async function readRoomCache(ownerId: number): Promise<RoomCacheData> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([META, MESSAGES], 'readonly');
    const [meta, records]: [RoomCacheMeta | undefined, Array<MessageRecord>] = await Promise.all([
      result<RoomCacheMeta | undefined>(transaction.objectStore(META).get(ownerId)),
      result<Array<MessageRecord>>(transaction.objectStore(MESSAGES).index('ownerId').getAll(ownerId))
    ]);

    return {
      meta,
      messages: records
        .sort((a: MessageRecord, b: MessageRecord): number => a.msgTime - b.msgTime)
        .map((record: MessageRecord): CustomMessageV2 => record.raw)
    };
  } catch (err) {
    console.error('读取房间缓存失败', err);

    return { messages: [] };
  }
}

/* 写入消息和房间信息（已有的消息会被覆盖，不会重复） */
export async function writeRoomCache(
  meta: RoomCacheMeta,
  messages: Array<{ key: string; raw: CustomMessageV2 }>
): Promise<void> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([META, MESSAGES], 'readwrite');
    const store: IDBObjectStore = transaction.objectStore(MESSAGES);

    transaction.objectStore(META).put(meta);

    for (const message of messages) {
      store.put({ ownerId: meta.ownerId, key: message.key, msgTime: message.raw.msgTime, raw: message.raw } satisfies MessageRecord);
    }

    await done(transaction);
  } catch (err) {
    console.error('写入房间缓存失败', err);
  }
}

/* 清除一个房间的缓存 */
export async function clearRoomCache(ownerId: number): Promise<void> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([META, MESSAGES], 'readwrite');
    const index: IDBIndex = transaction.objectStore(MESSAGES).index('ownerId');
    const keys: Array<IDBValidKey> = await result<Array<IDBValidKey>>(index.getAllKeys(ownerId));

    transaction.objectStore(META).delete(ownerId);

    for (const key of keys) transaction.objectStore(MESSAGES).delete(key);

    await done(transaction);
  } catch (err) {
    console.error('清除房间缓存失败', err);
  }
}
