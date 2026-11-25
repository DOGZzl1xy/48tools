import { pathToFileURL } from 'node:url';
import { useRef, useState, type ReactElement, type RefObject, type Dispatch as D, type SetStateAction as S } from 'react';
import { Modal } from 'antd';
import { draftSegments, lineAt, playAt } from './highlightDraft';
import type { CaptionLine, ClipDraft, Segment } from './highlightTypes';

/**
 * 定标题时看一眼内容：直接放录播里的这一段，剪掉的地方自动跳过去，下面是当时的字幕，不用渲染。
 * 接入点：./DraftPanel 的「播放这一段」。
 */
interface DraftPlayerProps {
  readonly title: string;
  readonly source: string;                 // 录播文件
  readonly picture: string | undefined;    // 电台封面
  readonly draft: ClipDraft;
  onClose(): void;
}

function DraftPlayer(props: DraftPlayerProps): ReactElement {
  const { title, source, picture, draft, onClose }: DraftPlayerProps = props;
  const [line, setLine]: [CaptionLine | undefined, D<S<CaptionLine | undefined>>] = useState<CaptionLine | undefined>(undefined);
  const [failed, setFailed]: [boolean, D<S<boolean>>] = useState(false);
  const videoRef: RefObject<HTMLVideoElement | null> = useRef(null);
  const { segments }: { segments: Array<Segment> } = draftSegments(draft);

  function handleLoadedMetadata(): void {
    const video: HTMLVideoElement = videoRef.current!;

    video.currentTime = draft.start + segments[0].start;
    video.play().catch((): void => undefined); // 还没加载好就关掉了
  }

  function handleTimeUpdate(): void {
    const video: HTMLVideoElement = videoRef.current!;
    const time: number = video.currentTime - draft.start;
    const next: ReturnType<typeof playAt> = playAt(segments, time);

    setLine(lineAt(draft.lines, time));

    if (video.seeking || video.paused) return;

    if (next.go === 'jump') video.currentTime = draft.start + next.to;

    if (next.go === 'stop') video.pause();
  }

  return (
    <Modal title={ title } open={ true } footer={ null } width={ 720 } centered={ true } destroyOnHidden={ true } onCancel={ onClose }>
      <video ref={ videoRef }
        className="picks-player"
        src={ pathToFileURL(source).href }
        poster={ picture && pathToFileURL(picture).href }
        controls={ true }
        onLoadedMetadata={ handleLoadedMetadata }
        onTimeUpdate={ handleTimeUpdate }
        onError={ (): void => setFailed(true) }
      />
      <div className="picks-player-line">{ failed ? '这个录播放不了' : line?.text }</div>
      <div className="picks-player-hint">放的是录播，剪掉的地方会自动跳过去；成片会加上标题、字幕和弹幕。</div>
    </Modal>
  );
}

export default DraftPlayer;
