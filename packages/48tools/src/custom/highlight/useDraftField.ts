import { useEffect, useRef, useState, type RefObject, type ChangeEvent, type Dispatch as D, type SetStateAction as S } from 'react';

/**
 * 切片页面里点进去就能改的文字：一边打字一边存。打字时显示打的字，停一会儿或者离开输入框时存；
 * 清空了就回到原来的（empty 为 true 时清空也算改，字幕用）
 */
const SAVE_DELAY: number = 800;

export interface DraftField {
  value: string;
  onChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void;
  onBlur(): void;
}

export function useDraftField(saved: string, save: (text: string) => Promise<unknown>, empty: boolean = false): DraftField {
  const [draft, setDraft]: [string | undefined, D<S<string | undefined>>] = useState<string | undefined>(undefined);
  const timer: RefObject<ReturnType<typeof setTimeout> | undefined> = useRef(undefined);
  const pending: RefObject<(() => void) | undefined> = useRef(undefined); // 还没存的；切到别的场次时也要存上

  async function commit(text: string, done: boolean): Promise<void> {
    clearTimeout(timer.current);
    pending.current = undefined;

    if ((empty || text.trim() !== '') && text.trim() !== saved) await save(text);

    // 存好了才换回去，不会闪一下旧的字；还在打字的不动
    done && setDraft((now: string | undefined): string | undefined => (now === text ? undefined : now));
  }

  useEffect((): (() => void) => (): void => {
    clearTimeout(timer.current);
    pending.current?.();
  }, []);

  return {
    value: draft ?? saved,
    onChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void {
      const text: string = event.target.value;

      setDraft(text);
      clearTimeout(timer.current);
      pending.current = (): void => void commit(text, false);
      timer.current = setTimeout((): void => void commit(text, false), SAVE_DELAY);
    },
    onBlur(): void {
      draft !== undefined && void commit(draft, true);
    }
  };
}
