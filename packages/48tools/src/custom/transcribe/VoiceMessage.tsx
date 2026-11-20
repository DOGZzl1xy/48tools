import { useEffect, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Link } from 'react-router';
import { App } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import {
  FileTextOutlined as IconFileTextOutlined,
  LoadingOutlined as IconLoadingOutlined,
  ReloadOutlined as IconReloadOutlined,
  CopyOutlined as IconCopyOutlined
} from '@ant-design/icons';
import { clipboard } from '../compat/clipboard';
import VoicePlayer from './VoicePlayer';
import {
  useTranscript,
  loadCachedTranscript,
  requestTranscript,
  cachedAudioUrl,
  type TranscriptState,
  type VoiceSource
} from './transcribeStore';

/**
 * 一条语音：播放条（./VoicePlayer），后面跟一个「转文字」按钮；转好的文字显示在播放条下面。
 * 转过的语音（本地有缓存）下次出现时直接显示文字。文字后面的小图标：复制、重新转一次。
 * 重新转的时候（以及重新转失败时）原来的文字仍然显示着，不会丢。
 * time（消息的时间）、question（翻牌的提问）、ownerId（哪个房间）用来找参考内容，帮模型把名字写对（见 ./voiceHints）。
 * 原来的语音地址播放不了、而本地存着这段语音时（转写过的会存 6 个月），自动改用本地的。
 * 接入点：custom/room/MessageBubble.tsx（语音消息、翻牌的语音回答）。样式在 custom/room/room.global.sass。
 */
function VoiceMessage(props: VoiceSource): ReactElement {
  const { id, url, ext, time, question, ownerId, duration }: VoiceSource = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const state: TranscriptState | undefined = useTranscript(id);
  const [localSrc, setLocalSrc]: [string | undefined, D<S<string | undefined>>] = useState<string | undefined>(undefined);
  const hasText: boolean = state?.text !== undefined;

  useEffect(function(): void {
    loadCachedTranscript(id);
  }, [id]);

  useEffect(function(): () => void {
    return function(): void {
      localSrc && URL.revokeObjectURL(localSrc);
    };
  }, [localSrc]);

  function handleTranscribeClick(): void {
    requestTranscript({ id, url, ext, time, question, ownerId });
  }

  function handleCopyClick(): void {
    clipboard.writeText(state?.text ?? '');
    messageApi.success('已复制');
  }

  async function handleAudioError(): Promise<void> {
    if (localSrc) return;

    const local: string | undefined = await cachedAudioUrl(id);

    local && setLocalSrc(local);
  }

  function textRender(): ReactElement | null {
    if (!state) return null;

    const loading: boolean = state.status === 'loading';

    return (
      <div className="room-voice-result">
        {
          hasText ? (
            <div className={ `room-voice-text${ loading ? ' is-stale' : '' }` }>
              { state.text ? state.text : <i>（没有听到说话的内容）</i> }
              {
                loading ? null : (
                  <span className="room-voice-tools">
                    { state.text ? <button type="button" title="复制" aria-label="复制" onClick={ handleCopyClick }><IconCopyOutlined /></button> : null }
                    <button type="button" title="重新转一次" aria-label="重新转一次" onClick={ handleTranscribeClick }>
                      <IconReloadOutlined />
                    </button>
                  </span>
                )
              }
            </div>
          ) : null
        }
        {
          loading ? (
            <div className="room-voice-text is-loading">
              <IconLoadingOutlined />
              { hasText ? '正在重新转…' : '正在转文字…' }
            </div>
          ) : null
        }
        {
          state.status === 'error' ? (
            <div className="room-voice-text is-error">
              { hasText ? `重新转失败：${ state.error }` : state.error }
              { state.needConfig ? <Link to="/Settings">去设置</Link> : null }
              <button type="button" onClick={ handleTranscribeClick }>重试</button>
            </div>
          ) : null
        }
      </div>
    );
  }

  return (
    <div className="room-voice">
      <div className="room-voice-row">
        <VoicePlayer src={ localSrc ?? url } duration={ duration } onError={ handleAudioError } />
        {
          state ? null : (
            <button className="room-voice-button" type="button" onClick={ handleTranscribeClick }>
              <IconFileTextOutlined />
              转文字
            </button>
          )
        }
      </div>
      { textRender() }
    </div>
  );
}

export default VoiceMessage;
