import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type CSSProperties,
  type Dispatch as D,
  type SetStateAction as S,
  type RefObject,
  type Ref,
  type UIEvent
} from 'react';
import { Segmented, Spin, Empty, theme, type GlobalToken } from 'antd';
import { ArrowDownOutlined as IconArrowDownOutlined, AimOutlined as IconAimOutlined } from '@ant-design/icons';
import VirtualList, { type ListRef } from 'rc-virtual-list';
import { requestDanmuFile } from '@48tools-api/48/danmu';
import type { LiveRoomInfo } from '@48tools-api/48';
import formatDanmu from '../../pages/PlayerWindow/utils/formatDanmu';
import { danmuStore } from '../../pages/PlayerWindow/utils/DanmuStore';
import { VIDEO_ID } from '../../pages/PlayerWindow/Video/RecordVideo';
import type { DanmuItem } from '../../pages/PlayerWindow/types';
import { sortDanmu, countUpTo, shortTime } from './danmuTimeline';
import './replayDanmu.global.sass';

/**
 * 回放窗口右边的弹幕栏。
 * 原版（pages/PlayerWindow/Danmu/RecordDanmu.tsx）是把整份弹幕文件一次全部列出来；这里改成两种看法：
 *   - 跟随播放（默认）：像直播时的聊天栏，视频播到哪里弹幕就出到哪里，新的从下面冒出来，自动滚到最新。
 *     往上翻看旧的时不再自动滚动，下面出现「N 条新弹幕」，点一下回到最新。拖动进度条时弹幕跟着变。
 *     只画最近 MAX_SHOWN 条，想看更早的用「全部」。
 *   - 全部：整份弹幕，标出当前播到的那一条，可以定位到它。
 * 两种看法里点时间都会把视频跳到那一刻。弹幕文件只加载一次，放进原版的 danmuStore（原版的字幕轨道也用它）。
 */
type Mode = 'follow' | 'all';
type Status = 'loading' | 'ready' | 'error';

/* 往上翻的时候记下：当时画的第一条是哪一条、当时出到第几条 */
interface Unpinned {
  start: number;
  count: number;
}

const MAX_SHOWN: number = 200; // 跟随播放时最多画最近多少条
const BOTTOM_GAP: number = 24; // 离底部这么近就算「在最新」

const modeOptions: Array<{ label: string; value: Mode }> = [
  { label: '跟随播放', value: 'follow' },
  { label: '全部', value: 'all' }
];

function getVideo(): HTMLVideoElement | null {
  return document.getElementById(VIDEO_ID) as HTMLVideoElement | null;
}

function seekTo(time: number): void {
  const video: HTMLVideoElement | null = getVideo();

  if (video) video.currentTime = time;
}

/* 把 antd 主题里的颜色变成 CSS 变量，样式表里统一使用 */
function danmuVars(token: GlobalToken): CSSProperties {
  return {
    '--rd-surface': token.colorFillQuaternary,
    '--rd-text': token.colorText,
    '--rd-secondary': token.colorTextSecondary,
    '--rd-tertiary': token.colorTextTertiary,
    '--rd-hover': token.colorFillTertiary,
    '--rd-active': token.colorPrimaryBg,
    '--rd-primary': token.colorPrimary,
    '--rd-scrollbar': token.colorFill
  } as CSSProperties;
}

/* 一条弹幕 */
interface RowProps {
  ref?: Ref<HTMLDivElement>;
  item: DanmuItem;
  current?: boolean; // 「全部」里：当前播到的那一条
}

function Row(props: RowProps): ReactElement {
  const { ref, item, current }: RowProps = props;

  return (
    <div ref={ ref } className={ `replay-danmu-row${ current ? ' is-current' : '' }` }>
      <button className="replay-danmu-time"
        type="button"
        title="跳到这里"
        onClick={ (): void => seekTo(item.currentTime) }
      >
        { shortTime(item.currentTime) }
      </button>
      <span className="replay-danmu-text">
        <b>{ item.nickname }</b>
        { item.message }
      </span>
    </div>
  );
}

function ReplayDanmu(props: { info: LiveRoomInfo | undefined }): ReactElement {
  const { info }: { info: LiveRoomInfo | undefined } = props;
  const { token }: { token: GlobalToken } = theme.useToken();
  const list: Array<DanmuItem> = useSyncExternalStore(danmuStore.subscribe, danmuStore.getDanmuList);
  const [status, setStatus]: [Status, D<S<Status>>] = useState<Status>('loading');
  const [mode, setMode]: [Mode, D<S<Mode>>] = useState<Mode>('follow');
  const [count, setCount]: [number, D<S<number>>] = useState(0); // 播放到现在已经出现了多少条
  const [unpinned, setUnpinned]: [Unpinned | null, D<S<Unpinned | null>>] = useState<Unpinned | null>(null);
  const [height, setHeight]: [number, D<S<number>>] = useState(0);
  const bodyRef: RefObject<HTMLDivElement | null> = useRef(null);
  const scrollRef: RefObject<HTMLDivElement | null> = useRef(null);
  const virtualRef: RefObject<ListRef | null> = useRef(null);
  const pinnedRef: RefObject<boolean> = useRef(true);
  const start: number = unpinned ? Math.min(unpinned.start, count) : Math.max(0, count - MAX_SHOWN);
  const fresh: number = unpinned ? Math.max(0, count - unpinned.count) : 0;

  function scrollToNewest(): void {
    const element: HTMLDivElement | null = scrollRef.current;

    if (element) element.scrollTop = element.scrollHeight;
  }

  function locateCurrent(): void {
    virtualRef.current?.scrollTo({ index: Math.max(0, count - 4), align: 'top' }); // 上面留几条，当前这条不贴着顶
  }

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const element: HTMLDivElement = event.currentTarget;
    const atBottom: boolean = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_GAP;

    if (atBottom) {
      unpinned && setUnpinned(null);
    } else if (!unpinned) {
      setUnpinned({ start, count });
    }
  }

  // 加载弹幕文件
  useEffect(function(): (() => void) | void {
    if (!info) return;

    let cancelled: boolean = false;

    async function load(filePath: string | undefined): Promise<void> {
      try {
        const text: string = filePath ? await requestDanmuFile(filePath) : '';

        if (cancelled) return;

        danmuStore.setDanmuList(sortDanmu(formatDanmu(text)));
        setStatus('ready');
      } catch (err) {
        console.error(err);
        cancelled || setStatus('error');
      }
    }

    load(info.content.msgFilePath);

    return function(): void {
      cancelled = true;
    };
  }, [info]);

  // 跟着视频的播放进度走
  useEffect(function(): (() => void) | void {
    const video: HTMLVideoElement | null = getVideo();

    if (!video || !list.length) return;

    const target: HTMLVideoElement = video;

    function sync(): void {
      setCount(countUpTo(list, target.currentTime));
    }

    // 拖动进度条：回到「跟着最新」的状态
    function handleSeeking(): void {
      setUnpinned(null);
      sync();
    }

    sync();
    target.addEventListener('timeupdate', sync);
    target.addEventListener('seeking', handleSeeking);
    target.addEventListener('seeked', sync);

    return function(): void {
      target.removeEventListener('timeupdate', sync);
      target.removeEventListener('seeking', handleSeeking);
      target.removeEventListener('seeked', sync);
    };
  }, [list]);

  // 有新弹幕时滚到最新（往上翻的时候不动）
  useLayoutEffect(function(): void {
    pinnedRef.current = !unpinned;

    if (mode === 'follow' && !unpinned) scrollToNewest();
  }, [mode, count, unpinned, status]);

  // 切到「全部」时定位到当前播到的那一条
  useEffect(function(): void {
    if (mode === 'all') locateCurrent();
  }, [mode]);

  // 弹幕栏的高度（「全部」的列表需要；窗口大小变了以后跟随播放也要保持在最新）
  useEffect(function(): () => void {
    const observer: ResizeObserver = new ResizeObserver(function(entries: Array<ResizeObserverEntry>): void {
      setHeight(entries[0].contentRect.height);
      pinnedRef.current && scrollToNewest();
    });

    bodyRef.current && observer.observe(bodyRef.current);

    return function(): void {
      observer.disconnect();
    };
  }, []);

  function bodyRender(): ReactElement {
    if (status === 'loading') {
      return (
        <div className="replay-danmu-hint">
          <Spin />
          <p>正在加载弹幕</p>
        </div>
      );
    }

    if (status === 'error') return <div className="replay-danmu-hint"><p>弹幕加载失败</p></div>;

    if (!list.length) return <div className="replay-danmu-hint"><Empty description="这场直播没有弹幕" /></div>;

    if (mode === 'all') {
      return (
        <VirtualList ref={ virtualRef } className="replay-danmu-all" data={ list } height={ height } itemHeight={ 26 } itemKey="vid">
          {
            (item: DanmuItem, index: number): ReactElement => (
              <Row key={ item.vid } item={ item } current={ index === count - 1 } />
            )
          }
        </VirtualList>
      );
    }

    return (
      <div ref={ scrollRef } className="replay-danmu-scroll" onScroll={ handleScroll }>
        <div className="replay-danmu-list">
          {
            count === 0
              ? <p className="replay-danmu-wait">弹幕会跟着播放进度出现</p>
              : list.slice(start, count).map((item: DanmuItem): ReactElement => (
                <Row key={ item.vid } item={ item } />
              ))
          }
        </div>
      </div>
    );
  }

  function jumpRender(): ReactElement | null {
    if (status !== 'ready' || !list.length) return null;

    if (mode === 'all') {
      return count > 0 ? (
        <button className="replay-danmu-jump" type="button" onClick={ locateCurrent }>
          <IconAimOutlined />
          定位到当前进度
        </button>
      ) : null;
    }

    return unpinned ? (
      <button className="replay-danmu-jump" type="button" onClick={ (): void => setUnpinned(null) }>
        <IconArrowDownOutlined />
        { fresh > 0 ? `${ fresh > 99 ? '99+' : fresh } 条新弹幕` : '回到最新' }
      </button>
    ) : null;
  }

  return (
    <div className="replay-danmu" style={ danmuVars(token) }>
      <div className="replay-danmu-head">
        <Segmented size="small" options={ modeOptions } value={ mode } onChange={ setMode } />
        { list.length ? <small>{ count } / { list.length }</small> : null }
      </div>
      <div ref={ bodyRef } className="replay-danmu-body">
        { bodyRender() }
        { jumpRender() }
      </div>
    </div>
  );
}

export default ReplayDanmu;
