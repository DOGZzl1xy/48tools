import { useEffect, useRef, useState, type ReactElement, type RefObject, type MouseEvent, type KeyboardEvent, type Dispatch as D, type SetStateAction as S } from 'react';
import { CaretRightFilled as IconCaretRightFilled, PauseOutlined as IconPauseOutlined } from '@ant-design/icons';

/**
 * 语音的播放条（自己画的，跟着主题变色）：播放 / 暂停按钮、进度条（可以点、可以拖着方向键调）、已播放 / 总时长。
 * 以前用的是浏览器自带的播放条：深色主题下是一块刺眼的白色，而且没开始播放前显示 0:00 / 0:00，看不出语音多长。
 * 总时长先用消息里带的（duration，毫秒），开始播放后用实际读到的。
 * 同一时间只播放一条语音：开始播放一条时，正在播放的另一条会暂停。
 * 样式在 custom/room/room.global.sass（.room-player）。
 */
interface VoicePlayerProps {
  src: string;
  duration?: number;    // 毫秒
  onError?: () => void; // 这个地址播放不了
}

let playingAudio: HTMLAudioElement | null = null; // 正在播放的那一条

export function clockText(seconds: number): string {
  const total: number = Math.max(0, Math.round(seconds));

  return `${ Math.floor(total / 60) }:${ String(total % 60).padStart(2, '0') }`;
}

function VoicePlayer(props: VoicePlayerProps): ReactElement {
  const { src, duration, onError }: VoicePlayerProps = props;
  const audioRef: RefObject<HTMLAudioElement | null> = useRef(null);
  const [playing, setPlaying]: [boolean, D<S<boolean>>] = useState(false);
  const [current, setCurrent]: [number, D<S<number>>] = useState(0);
  const [loaded, setLoaded]: [number, D<S<number>>] = useState(0); // 实际读到的总时长（秒），还没读到是 0
  const total: number = loaded || (duration ? duration / 1_000 : 0);
  const percent: number = total > 0 ? Math.min(100, (current / total) * 100) : 0;

  // 换了地址（改用本机存的那份）：从头开始
  useEffect(function(): void {
    setPlaying(false);
    setCurrent(0);
  }, [src]);

  useEffect(function(): () => void {
    const audio: HTMLAudioElement | null = audioRef.current;

    return function(): void {
      if (playingAudio === audio) playingAudio = null;
    };
  }, []);

  function handleToggleClick(): void {
    const audio: HTMLAudioElement | null = audioRef.current;

    if (!audio) return;

    if (audio.paused) {
      if (playingAudio && playingAudio !== audio) playingAudio.pause();

      playingAudio = audio;
      audio.play().catch((): void => { /* 播放不了时 audio 的 error 事件会处理 */ });
    } else {
      audio.pause();
    }
  }

  function seek(seconds: number): void {
    const audio: HTMLAudioElement | null = audioRef.current;

    if (!audio || !Number.isFinite(audio.duration)) return;

    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    setCurrent(audio.currentTime);
  }

  function handleBarClick(event: MouseEvent<HTMLDivElement>): void {
    const audio: HTMLAudioElement | null = audioRef.current;

    if (!audio) return;

    // 还没加载：先开始播放（加载之后才能跳）
    if (!Number.isFinite(audio.duration)) {
      audio.paused && handleToggleClick();

      return;
    }

    const rect: DOMRect = event.currentTarget.getBoundingClientRect();

    seek(((event.clientX - rect.left) / rect.width) * audio.duration);
  }

  function handleBarKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    seek((audioRef.current?.currentTime ?? 0) + (event.key === 'ArrowRight' ? 5 : -5));
  }

  function handleTimeUpdate(): void {
    const audio: HTMLAudioElement | null = audioRef.current;

    if (!audio) return;

    setCurrent(audio.currentTime);

    if (Number.isFinite(audio.duration) && audio.duration > 0) setLoaded(audio.duration);
  }

  function handleEnded(): void {
    setPlaying(false);
    setCurrent(0);
  }

  return (
    <div className={ `room-player${ playing ? ' is-playing' : '' }` }>
      <button className="room-player-button" type="button" aria-label={ playing ? '暂停' : '播放' } onClick={ handleToggleClick }>
        { playing ? <IconPauseOutlined /> : <IconCaretRightFilled /> }
      </button>
      <div className="room-player-bar"
        role="slider"
        tabIndex={ 0 }
        aria-label="播放进度"
        aria-valuemin={ 0 }
        aria-valuemax={ Math.round(total) }
        aria-valuenow={ Math.round(current) }
        onClick={ handleBarClick }
        onKeyDown={ handleBarKeyDown }
      >
        <i style={{ width: `${ percent }%` }} />
      </div>
      <span className="room-player-time">
        { playing || current > 0 ? `${ clockText(current) } / ` : '' }
        { total > 0 ? clockText(total) : '--:--' }
      </span>
      <audio ref={ audioRef }
        src={ src }
        preload="none"
        onPlay={ (): void => setPlaying(true) }
        onPause={ (): void => setPlaying(false) }
        onEnded={ handleEnded }
        onTimeUpdate={ handleTimeUpdate }
        onLoadedMetadata={ handleTimeUpdate }
        onError={ (): void => {
          setPlaying(false);
          onError?.();
        } }
      />
    </div>
  );
}

export default VoicePlayer;
