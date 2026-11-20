/**
 * IndexedDB 的几个小工具（房间消息缓存、语音转文字缓存、下载队列记录都用）：
 *   - createDbOpener：只打开一次数据库，以后都用同一个连接；打开失败时下次调用会重试
 *   - requestResult / transactionDone：把 IndexedDB 的回调变成 Promise
 */
export type DbUpgrade = (db: IDBDatabase, transaction: IDBTransaction) => void;

export function createDbOpener(name: string, version: number, upgrade: DbUpgrade): () => Promise<IDBDatabase> {
  let dbPromise: Promise<IDBDatabase> | undefined;

  return function openDb(): Promise<IDBDatabase> {
    dbPromise ??= new Promise((resolve: (db: IDBDatabase) => void, reject: (reason: unknown) => void): void => {
      const request: IDBOpenDBRequest = indexedDB.open(name, version);

      request.onupgradeneeded = (): void => upgrade(request.result, request.transaction!);
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => {
        dbPromise = undefined;
        reject(request.error);
      };
    });

    return dbPromise;
  };
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: unknown) => void): void => {
    transaction.oncomplete = (): void => resolve();
    transaction.onerror = (): void => reject(transaction.error);
    transaction.onabort = (): void => reject(transaction.error);
  });
}
