/**
 * 到处都用得到的小函数：等一会儿、从 localStorage 读写 JSON（读不到或格式不对时用默认值，写失败不报错）。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): unknown => setTimeout(resolve, ms));
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');

    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    if (value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* 存不进去（比如空间满了）不影响使用 */ }
}
