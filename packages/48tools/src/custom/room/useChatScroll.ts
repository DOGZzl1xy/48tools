import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type Dispatch as D, type SetStateAction as S } from 'react';
import type { RoomMessageItem } from './roomStore';

/**
 * 聊天列表的滚动：画哪一段消息、怎么保持阅读位置、跳到某一条、回到底部。从 RoomPage 里拆出来的。
 *
 * 只画一段（窗口）：房间里已经加载的消息可能有几千上万条，全画出来会越来越卡，所以只画其中连续的一段，
 * 最多 MAX_RENDER 条。往上滚到接近顶部时在上面多画一批（超过上限就把最下面的收掉）；窗口不在最新位置时，
 * 往下滚到接近底部就在下面多画一批（超过上限把最上面的收掉）。窗口到了已加载消息的最上面，再往上就去取更早的（onLoadOlder）。
 *
 * 保持阅读位置：上面多画、上面收掉、更早的消息加载进来，都会让内容上下挪动。每次画完后记下窗口里第一条和最后一条的位置，
 * 下次画完时看它们挪了多少，滚动位置跟着挪同样多，这样眼前的内容不动。
 * 在底部（而且窗口包含最新的消息）时，来了新消息、图片加载把内容撑高，都继续贴着底部。
 */
const RENDER_FIRST: number = 150; // 打开房间时先画最近的多少条
const RENDER_STEP: number = 150;  // 每次多画多少条
const MAX_RENDER: number = 600;   // 最多同时画多少条
const EDGE: number = 400;         // 离顶部 / 底部这么近时多画一批
const BOTTOM_GAP: number = 60;    // 离底部这么近就算「在底部」
const AWAY_GAP: number = 320;     // 离底部超过这么远就显示「回到底部」

interface View {
  bottomKey: string | null; // 窗口里最新的一条；null 表示一直跟着最新的消息
  count: number;            // 窗口里有多少条
}

interface Position {
  firstKey?: string;
  lastKey?: string;
  firstTop: number;
  lastTop: number;
  top: number;
  atBottom: boolean;
  newestKey?: string;
}

type Pending = 'bottom' | { key: string; align: 'start' | 'center' } | null;

export interface ChatScrollOptions<T extends { key: string } = RoomMessageItem> {
  allItems: Array<T>;               // 已经加载的全部条目（消息 + 可选状态记录），从旧到新
  newestMessageKey?: string;        // 最新一条真实消息的 key（用于判断是否提示「有新消息」，避免状态记录触发提示）
  ready: boolean;                   // 第一批已经加载完
  canLoadOlder: boolean;            // 还可以去取更早的（本地缓存或网络）
  onLoadOlder: () => void;
}

export interface ChatScroll<T extends { key: string } = RoomMessageItem> {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  items: Array<T>;                // 要画的这一段
  start: number;                  // 这一段在 allItems 里从第几条开始
  end: number;
  away: boolean;                  // 离开了底部（显示「回到底部」）
  newBelow: boolean;              // 离开底部期间来了新消息
  flashKey: string | undefined;   // 刚跳到的那一条（闪一下）
  onScroll: () => 'up' | 'other'; // 滚动时调用；返回这次是不是用户往上滚
  jumpTo: (key: string, align: 'start' | 'center') => boolean; // 跳到某一条（要已经加载）；找不到返回 false
  toBottom: () => void;
  reset: () => void;              // 回到刚打开房间时的状态
}

function offsetOf(content: HTMLElement | null, key: string | undefined): number | undefined {
  if (!content || key === undefined) return undefined;

  return content.querySelector<HTMLElement>(`[data-key="${ CSS.escape(key) }"]`)?.offsetTop;
}

export function useChatScroll<T extends { key: string } = RoomMessageItem>(options: ChatScrollOptions<T>): ChatScroll<T> {
  const { allItems, newestMessageKey, ready, canLoadOlder, onLoadOlder }: ChatScrollOptions<T> = options;
  const scrollRef: RefObject<HTMLDivElement | null> = useRef(null);
  const contentRef: RefObject<HTMLDivElement | null> = useRef(null);
  const position: RefObject<Position> = useRef({ firstTop: 0, lastTop: 0, top: 0, atBottom: true });
  const pending: RefObject<Pending> = useRef(null);
  const flashTimer: RefObject<number | undefined> = useRef(undefined);
  const [view, setView]: [View, D<S<View>>] = useState<View>({ bottomKey: null, count: RENDER_FIRST });
  const [away, setAway]: [boolean, D<S<boolean>>] = useState(false);
  const [newBelow, setNewBelow]: [boolean, D<S<boolean>>] = useState(false);
  const [flashKey, setFlashKey]: [string | undefined, D<S<string | undefined>>] = useState<string | undefined>(undefined);

  const bottomIndex: number = view.bottomKey === null
    ? -1
    : allItems.findIndex((item: T): boolean => item.key === view.bottomKey);
  const end: number = bottomIndex < 0 ? allItems.length : bottomIndex + 1;
  const start: number = Math.max(0, end - view.count);
  const items: Array<T> = start === 0 && end === allItems.length ? allItems : allItems.slice(start, end);
  const following: boolean = end === allItems.length; // 窗口包含最新的消息
  const trackedNewestKey: string | undefined = newestMessageKey ?? allItems[allItems.length - 1]?.key;

  function setWindow(newStart: number, newEnd: number): void {
    const bottomKey: string | null = newEnd >= allItems.length ? null : allItems[newEnd - 1].key;
    const count: number = newEnd - newStart;

    setView((prev: View): View => (prev.bottomKey === bottomKey && prev.count === count ? prev : { bottomKey, count }));
  }

  function nearBottom(el: HTMLDivElement, gap: number): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < gap;
  }

  /* 记下现在的位置，下次内容变化时用来算挪了多少 */
  function record(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el) return;

    const firstKey: string | undefined = items[0]?.key;
    const lastKey: string | undefined = items[items.length - 1]?.key;

    position.current = {
      firstKey,
      lastKey,
      firstTop: offsetOf(contentRef.current, firstKey) ?? 0,
      lastTop: offsetOf(contentRef.current, lastKey) ?? 0,
      top: el.scrollTop,
      atBottom: following && (position.current.atBottom || nearBottom(el, BOTTOM_GAP)),
      newestKey: trackedNewestKey
    };
  }

  function flash(key: string): void {
    setFlashKey(key);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout((): void => setFlashKey(undefined), 1_800);
  }

  function scrollToKey(key: string, align: 'start' | 'center', smooth: boolean): boolean {
    const el: HTMLDivElement | null = scrollRef.current;
    const top: number | undefined = offsetOf(contentRef.current, key);

    if (!el || top === undefined) return false;

    el.scrollTo({ top: Math.max(0, align === 'start' ? top - 44 : top - (el.clientHeight / 3)), behavior: smooth ? 'smooth' : 'auto' });

    return true;
  }

  /* 接近顶部 / 底部时多画一批，或者去取更早的 */
  function extendIfNeeded(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el || !ready || pending.current) return;

    if (el.scrollTop < EDGE) {
      if (start > 0) {
        const newStart: number = Math.max(0, start - RENDER_STEP);

        setWindow(newStart, Math.min(end, newStart + MAX_RENDER));
      } else if (canLoadOlder) {
        onLoadOlder();
      }
    } else if (!following && nearBottom(el, EDGE)) {
      const newEnd: number = Math.min(allItems.length, end + RENDER_STEP);

      setWindow(Math.max(start, newEnd - MAX_RENDER), newEnd);
    }
  }

  function onScroll(): 'up' | 'other' {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el) return 'other';

    // 只有用户自己往上滚，才算离开了底部。图片加载把内容撑高时也会触发滚动事件，这时位置没有往上走，
    // 不能当成离开底部，否则就不会再自动贴到底部了
    const up: boolean = el.scrollTop < position.current.top - 4;

    if (up) {
      position.current.atBottom = false;
    } else if (following && nearBottom(el, BOTTOM_GAP)) {
      position.current.atBottom = true;
    }

    position.current.top = el.scrollTop;

    const isAway: boolean = !following || !nearBottom(el, AWAY_GAP);

    setAway((prev: boolean): boolean => (prev === isAway ? prev : isAway));
    isAway || setNewBelow((prev: boolean): boolean => (prev ? false : prev));
    extendIfNeeded();

    return up ? 'up' : 'other';
  }

  function jumpTo(key: string, align: 'start' | 'center'): boolean {
    const index: number = allItems.findIndex((item: T): boolean => item.key === key);

    if (index < 0) return false;

    position.current.atBottom = false;

    // 已经画出来了：直接滚过去
    if (index >= start && index < end && scrollToKey(key, align, true)) {
      flash(key);

      return true;
    }

    // 还没画出来：把窗口挪到它周围，画好后再跳（见下面的 useLayoutEffect）
    pending.current = { key, align };
    setWindow(Math.max(0, index - 120), Math.min(allItems.length, index + 80));

    return true;
  }

  function toBottom(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    position.current.atBottom = true;
    pending.current = 'bottom';
    setView({ bottomKey: null, count: RENDER_FIRST }); // 每次都是新对象，下面的 useLayoutEffect 一定会跑
    setAway(false);
    setNewBelow(false);

    if (el && following) el.scrollTop = el.scrollHeight;
  }

  function reset(): void {
    pending.current = null;
    position.current = { firstTop: 0, lastTop: 0, top: 0, atBottom: true };
    setView({ bottomKey: null, count: RENDER_FIRST });
    setAway(false);
    setNewBelow(false);
  }

  // 画完之后：处理跳转，或者保持阅读位置
  useLayoutEffect(function(): void {
    const el: HTMLDivElement | null = scrollRef.current;

    if (!el) return;

    const prev: Position = position.current;
    const job: Pending = pending.current;
    const newestKey: string | undefined = trackedNewestKey;

    if (job === 'bottom') {
      el.scrollTop = el.scrollHeight;
      pending.current = null;
    } else if (job) {
      if (scrollToKey(job.key, job.align, false)) {
        pending.current = null;
        prev.atBottom = false;
        flash(job.key);
      }
    } else if (prev.firstKey === undefined) {
      // 第一次画出消息：到最下面
      el.scrollTop = el.scrollHeight;
      prev.atBottom = true;
    } else if (prev.atBottom && following) {
      el.scrollTop = el.scrollHeight;
    } else {
      const first: number | undefined = offsetOf(contentRef.current, prev.firstKey);
      const last: number | undefined = first === undefined ? offsetOf(contentRef.current, prev.lastKey) : undefined;
      const shift: number = first !== undefined ? first - prev.firstTop : (last !== undefined ? last - prev.lastTop : 0);

      if (shift !== 0) el.scrollTop = prev.top + shift;
    }

    // 不在底部时来了新消息：「回到底部」上提示一下
    if (prev.newestKey !== undefined && newestKey !== prev.newestKey && !(prev.atBottom && following)) setNewBelow(true);

    record();
  }, [allItems, view]);

  // 内容不满一屏，或者刚好停在顶部时，继续多画 / 取更早的消息
  useEffect(extendIfNeeded, [items.length, allItems.length, canLoadOlder, ready]);

  // 图片加载完会把内容撑高：在底部时保持在底部
  useEffect(function(): () => void {
    const observer: ResizeObserver = new ResizeObserver((): void => {
      const el: HTMLDivElement | null = scrollRef.current;

      if (!el) return;

      if (position.current.atBottom && position.current.lastKey !== undefined) el.scrollTop = el.scrollHeight;

      position.current.firstTop = offsetOf(contentRef.current, position.current.firstKey) ?? 0;
      position.current.lastTop = offsetOf(contentRef.current, position.current.lastKey) ?? 0;
      position.current.top = el.scrollTop;
    });

    contentRef.current && observer.observe(contentRef.current);

    return (): void => {
      observer.disconnect();
      window.clearTimeout(flashTimer.current);
    };
  }, []);

  return { scrollRef, contentRef, items, start, end, away, newBelow, flashKey, onScroll, jumpTo, toBottom, reset };
}
