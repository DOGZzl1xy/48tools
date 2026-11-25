import { createDbOpener, requestResult as result, transactionDone as done } from '../common/idb';

/**
 * 成员上下线记录的本地缓存（IndexedDB，和房间消息缓存分开，清除房间消息缓存时不会清掉）。
 * 只用于聊天记录里的时间线展示，不参与未读数统计或消息提示。
 */
export type PresenceKind = 'online' | 'offline';

export interface PresenceEvent {
  ownerId: number;
  time: number;
  kind: PresenceKind;
}

const DB_NAME: string = 'custom-room-presence';
const DB_VERSION: number = 1;
const STORE_NAME: string = 'events';
const DEFAULT_MAX_EVENTS: number = 2_000;

const openDb: () => Promise<IDBDatabase> = createDbOpener(DB_NAME, DB_VERSION, function(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    const store: IDBObjectStore = db.createObjectStore(STORE_NAME, { keyPath: ['ownerId', 'time'] });

    store.createIndex('ownerId', 'ownerId');
  }
});

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function walk(
  store: IDBObjectStore,
  range: IDBKeyRange,
  direction: IDBCursorDirection,
  limit: number,
  remove: boolean = false
): Promise<Array<PresenceEvent>> {
  return new Promise((resolve: (records: Array<PresenceEvent>) => void, reject: (reason: unknown) => void): void => {
    const records: Array<PresenceEvent> = [];
    const request: IDBRequest<IDBCursorWithValue | null> = store.openCursor(range, direction);

    request.onerror = (): void => reject(request.error);
    request.onsuccess = (): void => {
      const cursor: IDBCursorWithValue | null = request.result;

      if (!cursor || records.length >= limit) return resolve(records);

      records.push(cursor.value as PresenceEvent);
      remove && cursor.delete();
      cursor.continue();
    };
  });
}

/* 读取某个成员缓存的上下线记录（从旧到新）；默认读最新的 1000 条 */
export async function readPresenceCache(
  ownerId: number,
  options: { from?: number; to?: number; limit?: number } = {}
): Promise<Array<PresenceEvent>> {
  if (!hasIndexedDb()) return [];

  try {
    const db: IDBDatabase = await openDb();
    const store: IDBObjectStore = db.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME);
    const range: IDBKeyRange = IDBKeyRange.bound(
      [ownerId, options.from ?? -Infinity],
      [ownerId, options.to ?? Infinity]
    );
    const records: Array<PresenceEvent> = await walk(store, range, 'prev', options.limit ?? 1_000);

    return records.reverse();
  } catch (err) {
    console.error('读取在线记录缓存失败', err);

    return [];
  }
}

/* 批量写入多条上下线记录（单次事务，拉取 /events 补档时用） */
export async function writePresenceEvents(events: Array<PresenceEvent>, maxEvents: number = DEFAULT_MAX_EVENTS): Promise<void> {
  if (!hasIndexedDb() || events.length === 0) return;

  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([STORE_NAME], 'readwrite');
    const store: IDBObjectStore = transaction.objectStore(STORE_NAME);
    const finished: Promise<void> = done(transaction);
    const touchedOwners: Set<number> = new Set();

    for (const event of events) {
      store.put(event);
      touchedOwners.add(event.ownerId);
    }

    for (const ownerId of touchedOwners) {
      const count: number = await result<number>(store.index('ownerId').count(ownerId));
      const extra: number = count - maxEvents;

      if (extra >= 100) {
        await walk(store, IDBKeyRange.bound([ownerId, -Infinity], [ownerId, Infinity]), 'next', extra, true);
      }
    }

    await finished;
  } catch (err) {
    console.error('写入在线记录缓存失败', err);
  }
}

/* 写入一条上下线记录；超过上限时顺便清掉最早的一批 */
export async function writePresenceEvent(event: PresenceEvent, maxEvents: number = DEFAULT_MAX_EVENTS): Promise<void> {
  await writePresenceEvents([event], maxEvents);
}

/* 清除某个成员的上下线记录缓存 */
export async function clearPresenceCache(ownerId: number): Promise<void> {
  if (!hasIndexedDb()) return;

  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([STORE_NAME], 'readwrite');
    const store: IDBObjectStore = transaction.objectStore(STORE_NAME);
    const finished: Promise<void> = done(transaction);

    await walk(store, IDBKeyRange.bound([ownerId, -Infinity], [ownerId, Infinity]), 'next', Infinity, true);
    await finished;
  } catch (err) {
    console.error('清除在线记录缓存失败', err);
  }
}
