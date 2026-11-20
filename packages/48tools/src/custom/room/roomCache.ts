import type { CustomMessageV2 } from '@48tools-api/48';
import { createDbOpener, requestResult as result, transactionDone as done } from '../common/idb';

/**
 * 房间消息的本地缓存（浏览器自带的 IndexedDB，数据在程序的配置目录里，不会上传）。
 * 每个房间有两套互相独立的缓存（RoomStream）：
 *   - owner：只有成员发的消息（「只看成员」用）
 *   - all：房间里所有人的消息，包括粉丝（「全部消息」用）。量很大，每个房间最多保留最新的一部分（写入时传 maxMessages）
 * 每套缓存存两样东西：
 *   - messages：已经取到的消息（接口返回的原始内容）
 *   - meta：房间的 serverId / channelId，以及「往更早翻」用的位置（nextTime）和是否已经翻到头
 * 一套缓存里的消息在时间上是连续的（中间没有空档），这样下次打开房间时先显示本地的消息，
 * 再只去取比本地更新的部分（见 ./roomStore）。
 * 读的时候分批读：先读最新的一批，往上滚动时再读更早的，缓存再大打开房间也不会变慢。
 * 图片、语音、视频本身不存，只存它们的地址。
 */
export type RoomStream = 'owner' | 'all';

export interface RoomCacheMeta {
  ownerId: number;
  serverId?: number;
  channelId?: number;
  nextTime: number;
  hasMore: boolean;
  updatedAt: number;
  trimmedAt?: number; // 超过保留上限后删过早的消息：这个时间之前的本地已经没有了
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
  more: boolean;                    // 本地还有比这一批更早的
}

const DB_NAME: string = 'custom-room-cache';
const DB_VERSION: number = 2; // 2：加了「全部消息」的两张表，消息表加了按时间读取用的索引
const TIME_INDEX: string = 'time';
const stores: Record<RoomStream, { meta: string; messages: string }> = {
  owner: { meta: 'meta', messages: 'messages' },
  all: { meta: 'allMeta', messages: 'allMessages' }
};

const openDb: () => Promise<IDBDatabase> = createDbOpener(DB_NAME, DB_VERSION, function(db: IDBDatabase, transaction: IDBTransaction): void {
  for (const names of Object.values(stores)) {
    if (!db.objectStoreNames.contains(names.meta)) db.createObjectStore(names.meta, { keyPath: 'ownerId' });

    // 旧版本建的消息表没有按时间的索引，这里补上（已有的消息会自动进索引）
    const messages: IDBObjectStore = db.objectStoreNames.contains(names.messages)
      ? transaction.objectStore(names.messages)
      : db.createObjectStore(names.messages, { keyPath: ['ownerId', 'key'] });

    if (!messages.indexNames.contains('ownerId')) messages.createIndex('ownerId', 'ownerId');

    if (!messages.indexNames.contains(TIME_INDEX)) messages.createIndex(TIME_INDEX, ['ownerId', 'msgTime']);
  }
});

/* 一个房间的消息在时间索引里的范围：从最早到 before（包含） */
function timeRange(ownerId: number, before: number = Infinity): IDBKeyRange {
  return IDBKeyRange.bound([ownerId, -Infinity], [ownerId, before]);
}

/* 沿着时间索引读（或删）若干条，返回读到的记录 */
function walk(
  source: IDBIndex,
  range: IDBKeyRange,
  direction: IDBCursorDirection,
  limit: number,
  remove: boolean = false
): Promise<Array<MessageRecord>> {
  return new Promise((resolve: (records: Array<MessageRecord>) => void, reject: (reason: unknown) => void): void => {
    const records: Array<MessageRecord> = [];
    const request: IDBRequest<IDBCursorWithValue | null> = source.openCursor(range, direction);

    request.onerror = (): void => reject(request.error);
    request.onsuccess = (): void => {
      const cursor: IDBCursorWithValue | null = request.result;

      if (!cursor || records.length >= limit) return resolve(records);

      records.push(cursor.value);
      remove && cursor.delete();
      cursor.continue();
    };
  });
}

/**
 * 读取一个房间的缓存：房间信息，加上最新的一批消息。读不到（或出错）时返回空
 * @param { RoomStream } stream
 * @param { number } ownerId
 * @param { object } [options]
 * @param { number } [options.before] - 只读这个时间及更早的消息（往上翻时传已有消息里最早的时间）
 * @param { number } [options.limit] - 最多读多少条，不传就全读出来
 */
export async function readRoomCache(
  stream: RoomStream,
  ownerId: number,
  options: { before?: number; limit?: number } = {}
): Promise<RoomCacheData> {
  try {
    const db: IDBDatabase = await openDb();
    const limit: number = options.limit ?? Infinity;
    const transaction: IDBTransaction = db.transaction([stores[stream].meta, stores[stream].messages], 'readonly');
    const [meta, records]: [RoomCacheMeta | undefined, Array<MessageRecord>] = await Promise.all([
      result<RoomCacheMeta | undefined>(transaction.objectStore(stores[stream].meta).get(ownerId)),
      walk(transaction.objectStore(stores[stream].messages).index(TIME_INDEX), timeRange(ownerId, options.before), 'prev', limit)
    ]);

    return {
      meta,
      messages: records.reverse().map((record: MessageRecord): CustomMessageV2 => record.raw),
      more: records.length >= limit
    };
  } catch (err) {
    console.error('读取房间缓存失败', err);

    return { messages: [], more: false };
  }
}

/**
 * 读一个房间某段时间里的消息（从旧到新）。太多时只要离结束时间最近的 limit 条。读不到（或出错）时返回空。
 * 语音转文字找「语音前后的文字」时用（见 ../transcribe/transcribeStore）
 */
export async function readRoomCacheBetween(
  stream: RoomStream,
  ownerId: number,
  from: number,
  to: number,
  limit: number = 1_500
): Promise<Array<CustomMessageV2>> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([stores[stream].messages], 'readonly');
    const records: Array<MessageRecord> = await walk(
      transaction.objectStore(stores[stream].messages).index(TIME_INDEX),
      IDBKeyRange.bound([ownerId, from], [ownerId, to]),
      'prev',
      limit);

    return records.reverse().map((record: MessageRecord): CustomMessageV2 => record.raw);
  } catch (err) {
    console.error('读取房间缓存失败', err);

    return [];
  }
}

/**
 * 在本地缓存里找消息：从新到旧一条条看，match 返回 true 的留下，最多 limit 条（结果从新到旧）。
 * 搜索消息内容时用（见 ./RoomSearch）。出错时返回空
 */
export async function searchRoomCache(
  stream: RoomStream,
  ownerId: number,
  match: (raw: CustomMessageV2) => boolean,
  limit: number = 200
): Promise<Array<CustomMessageV2>> {
  try {
    const db: IDBDatabase = await openDb();
    const source: IDBIndex = db.transaction([stores[stream].messages], 'readonly').objectStore(stores[stream].messages).index(TIME_INDEX);

    return await new Promise((resolve: (found: Array<CustomMessageV2>) => void, reject: (reason: unknown) => void): void => {
      const found: Array<CustomMessageV2> = [];
      const request: IDBRequest<IDBCursorWithValue | null> = source.openCursor(timeRange(ownerId), 'prev');

      request.onerror = (): void => reject(request.error);
      request.onsuccess = (): void => {
        const cursor: IDBCursorWithValue | null = request.result;

        if (!cursor || found.length >= limit) return resolve(found);

        const raw: CustomMessageV2 = (cursor.value as MessageRecord).raw;

        match(raw) && found.push(raw);
        cursor.continue();
      };
    });
  } catch (err) {
    console.error('搜索房间缓存失败', err);

    return [];
  }
}

/* 本地缓存里某个时间（含）之后的第一条消息；没有时返回 undefined。跳到某一天时用 */
export async function firstCachedSince(stream: RoomStream, ownerId: number, time: number): Promise<CustomMessageV2 | undefined> {
  try {
    const db: IDBDatabase = await openDb();
    const [record]: Array<MessageRecord> = await walk(
      db.transaction([stores[stream].messages], 'readonly').objectStore(stores[stream].messages).index(TIME_INDEX),
      IDBKeyRange.bound([ownerId, time], [ownerId, Infinity]),
      'next',
      1);

    return record?.raw;
  } catch (err) {
    console.error('读取房间缓存失败', err);

    return undefined;
  }
}

/**
 * 写入消息和房间信息（已有的消息会被覆盖，不会重复）
 * @param { RoomStream } stream
 * @param { RoomCacheMeta } meta
 * @param { Array } messages
 * @param { number } [maxMessages] - 这个房间最多保留多少条。超过时删掉最早的，并把「往更早翻」的位置挪到保留下来的最早一条。
 *   删过之后，比保留下来的更早的消息不再写进缓存（否则中间会出现空档），往上翻时每次都从网络取
 */
export async function writeRoomCache(
  stream: RoomStream,
  meta: RoomCacheMeta,
  messages: Array<{ key: string; raw: CustomMessageV2 }>,
  maxMessages?: number
): Promise<void> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([stores[stream].meta, stores[stream].messages], 'readwrite');
    const metaStore: IDBObjectStore = transaction.objectStore(stores[stream].meta);
    const store: IDBObjectStore = transaction.objectStore(stores[stream].messages);
    const finished: Promise<void> = done(transaction);

    // 以前删过早的消息：保留下来的最早位置不变，更早的不再写入
    const trimmedAt: number | undefined = maxMessages === undefined
      ? undefined
      : (await result<RoomCacheMeta | undefined>(metaStore.get(meta.ownerId)))?.trimmedAt;

    metaStore.put(trimmedAt === undefined ? meta : { ...meta, nextTime: trimmedAt, hasMore: true, trimmedAt });

    for (const message of messages) {
      if (trimmedAt !== undefined && message.raw.msgTime < trimmedAt) continue;

      store.put({ ownerId: meta.ownerId, key: message.key, msgTime: message.raw.msgTime, raw: message.raw } satisfies MessageRecord);
    }

    if (maxMessages !== undefined) {
      const count: number = await result<number>(store.index('ownerId').count(meta.ownerId));
      const extra: number = count - maxMessages;

      // 多出一批（200 条）再删，不用每次写入都删
      if (extra >= 200) {
        await walk(store.index(TIME_INDEX), timeRange(meta.ownerId), 'next', extra, true);

        const [oldest]: Array<MessageRecord> = await walk(store.index(TIME_INDEX), timeRange(meta.ownerId), 'next', 1);

        if (oldest) metaStore.put({ ...meta, nextTime: oldest.msgTime, hasMore: true, trimmedAt: oldest.msgTime });
      }
    }

    await finished;
  } catch (err) {
    console.error('写入房间缓存失败', err);
  }
}

/* 清除一个房间的缓存 */
export async function clearRoomCache(stream: RoomStream, ownerId: number): Promise<void> {
  try {
    const db: IDBDatabase = await openDb();
    const transaction: IDBTransaction = db.transaction([stores[stream].meta, stores[stream].messages], 'readwrite');
    const finished: Promise<void> = done(transaction);

    transaction.objectStore(stores[stream].meta).delete(ownerId);
    await walk(transaction.objectStore(stores[stream].messages).index(TIME_INDEX), timeRange(ownerId), 'next', Infinity, true);
    await finished;
  } catch (err) {
    console.error('清除房间缓存失败', err);
  }
}
