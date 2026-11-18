import { LiveReconnect, QUICK_FAIL_MS, MAX_QUICK_FAILS, pushCapped, type LiveInfoLike } from './liveReconnect';

interface Harness {
  reconnect: LiveReconnect;
  restarts: Array<string>;
  closed: () => number;
  advance(ms: number): void;
}

function createHarness(requestInfo: () => Promise<LiveInfoLike>, url: string = 'http://live/a.flv'): Harness {
  const restarts: Array<string> = [];
  let closed: number = 0;
  let time: number = 0;
  const reconnect: LiveReconnect = new LiveReconnect({
    liveId: '1',
    getUrl: (): string => url,
    requestInfo,
    restart: (u: string): unknown => restarts.push(u),
    close(): void {
      closed++;
    },
    isKilled: (): boolean => false,
    wait: (): Promise<void> => Promise.resolve(),
    now: (): number => time
  });

  return {
    reconnect,
    restarts,
    closed: (): number => closed,
    advance(ms: number): void {
      time += ms;
    }
  };
}

describe('LiveReconnect', function(): void {
  test('reconnects with the same url after a long run', async function(): Promise<void> {
    const h: Harness = createHarness((): Promise<LiveInfoLike> => Promise.resolve({
      success: true,
      content: { playStreamPath: 'http://live/a.flv' }
    }));

    h.advance(QUICK_FAIL_MS * 10);
    await h.reconnect.handleClose();
    expect(h.restarts).toEqual(['http://live/a.flv']);
    expect(h.closed()).toBe(0);
  });

  test('still reconnects when the info request keeps failing', async function(): Promise<void> {
    const h: Harness = createHarness((): Promise<LiveInfoLike> => Promise.reject(new Error('proxy down')));

    h.advance(QUICK_FAIL_MS * 10);
    await h.reconnect.handleClose();
    expect(h.restarts).toEqual(['http://live/a.flv']);
  });

  test('gives up after repeated quick failures', async function(): Promise<void> {
    const h: Harness = createHarness((): Promise<LiveInfoLike> => Promise.resolve({
      success: true,
      content: { playStreamPath: 'http://live/a.flv' }
    }));

    for (let i: number = 0; i < MAX_QUICK_FAILS; i++) {
      h.reconnect.markStart();
      h.advance(1000);
      await h.reconnect.handleClose();
    }

    expect(h.restarts.length).toBe(MAX_QUICK_FAILS - 1);
    expect(h.closed()).toBe(1);
  });

  test('closes when the live is gone or turned into a replay', async function(): Promise<void> {
    const gone: Harness = createHarness((): Promise<LiveInfoLike> => Promise.resolve({ success: false }));

    gone.advance(QUICK_FAIL_MS * 10);
    await gone.reconnect.handleClose();
    expect(gone.closed()).toBe(1);

    const replay: Harness = createHarness((): Promise<LiveInfoLike> => Promise.resolve({
      success: true,
      content: { playStreamPath: 'http://vod/a.m3u8?x=1' }
    }));

    replay.advance(QUICK_FAIL_MS * 10);
    await replay.reconnect.handleClose();
    expect(replay.closed()).toBe(1);
    expect(replay.restarts).toEqual([]);
  });
});

test('pushCapped keeps only the latest items', function(): void {
  const list: Array<number> = [];

  for (let i: number = 0; i < 10; i++) pushCapped(list, i, 3);

  expect(list).toEqual([7, 8, 9]);
});
