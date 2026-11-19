import { memo, type ReactElement, type ReactNode } from 'react';
import { Avatar, Image, Tooltip } from 'antd';
import { PlayCircleOutlined as IconPlayCircleOutlined } from '@ant-design/icons';
import { source, mp4Source } from '../../utils/snh48';
import type { RoomMessageItem } from './roomStore';

/**
 * 一条房间消息：左边是发消息的人的头像，右边是气泡。按消息类型显示：文字、回复（带被回复的那句话）、图片、语音、视频、
 * 直播通知、翻牌（文字 / 语音 / 视频）、表情图；不认识的类型显示成一行灰色的说明。
 * 房间里偶尔会有别的成员来发消息，所以每条都带头像；不是房主发的还会显示名字。
 * 直播通知卡片可以点击：直播中打开直播播放，已结束打开回放（见 ./openLive）。
 */
export interface LivePushInfo {
  liveId: string;
  liveTitle: string;
  liveCover?: string;
}
const typeNames: Record<string, string> = {
  EXPRESS: '表情',
  DELETE: '删除了一条消息',
  DISABLE_SPEAK: '禁言',
  SESSION_DIANTAI: '房间电台',
  OPEN_LIVE: '开始直播',
  TRIP_INFO: '行程',
  PRESENT_NORMAL: '礼物',
  PRESENT_TEXT: '礼物',
  VOTE: '投票',
  CLOSE_ROOM_CHAT: '房间聊天关闭',
  ZHONGQIU_ACTIVITY_LANTERN_FANS: '活动消息',
  RED_PACKET_2024: '红包',
  AUDIO: '语音',
  VIDEO: '视频'
};

function Quote(props: { name?: string; children: ReactNode }): ReactElement {
  return (
    <blockquote className="room-quote">
      { props.name ? <b>{ props.name }：</b> : null }
      { props.children }
    </blockquote>
  );
}

/* 第一个存在的值（接口里同一个字段有 flip / filp 两种拼写） */
function pick<T>(...values: Array<T | undefined | null>): T | undefined {
  return values.find((value: T | undefined | null): boolean => value !== undefined && value !== null) ?? undefined;
}

function renderBody(item: RoomMessageItem, onOpenLive?: (info: LivePushInfo) => void): { body: ReactNode; plain?: boolean } {
  const message: any = item.message;

  if (message.type === 'text') return { body: <p className="room-text">{ message.body }</p> };

  if (message.type === 'image') {
    return { body: <Image className="room-image" src={ message.attach.url } loading="lazy" />, plain: true };
  }

  if (message.type === 'audio') return { body: <audio className="room-audio" src={ message.attach.url } controls={ true } preload="none" /> };

  if (message.type === 'video') {
    return { body: <video className="room-video" src={ message.attach.url } controls={ true } preload="metadata" />, plain: true };
  }

  if (message.type === 'custom') {
    const attach: any = message.attach;
    const type: string = attach.messageType;

    if (type === 'REPLY' || type === 'GIFTREPLY') {
      const info: { replyName: string; replyText: string; text: string } = attach.replyInfo ?? attach.giftReplyInfo;

      return {
        body: (
          <div>
            <Quote name={ info.replyName }>{ info.replyText }</Quote>
            <p className="room-text">{ info.text }</p>
          </div>
        )
      };
    }

    if (type === 'LIVEPUSH') {
      return {
        body: (
          <button className="room-card"
            type="button"
            title="点击观看：直播中会打开直播，已经结束会打开回放"
            data-live-id={ attach.livePushInfo.liveId }
            onClick={ (): void => onOpenLive?.(attach.livePushInfo) }
          >
            { attach.livePushInfo.liveCover ? <img src={ source(attach.livePushInfo.liveCover) } alt="" loading="lazy" /> : null }
            <div>
              <small><IconPlayCircleOutlined /> 开始直播 · 点击观看</small>
              <b>{ attach.livePushInfo.liveTitle }</b>
            </div>
          </button>
        ),
        plain: true
      };
    }

    if (type === 'FLIPCARD') {
      const info: { question: string; answer: string } = attach.filpCardInfo ?? attach.flipCardInfo;

      return {
        body: (
          <div>
            <Quote name="翻牌提问">{ info.question }</Quote>
            <p className="room-text">{ info.answer }</p>
          </div>
        )
      };
    }

    if (type === 'FLIPCARD_AUDIO' || type === 'FLIPCARD_VIDEO') {
      const info: { question: string; answer: string } | undefined = pick(
        attach.filpCardInfo, attach.flipCardInfo,
        attach.filpCardAudioInfo, attach.flipCardAudioInfo,
        attach.filpCardVideoInfo, attach.flipCardVideoInfo);
      const url: string = mp4Source(JSON.parse(info!.answer).url);

      return {
        body: (
          <div>
            <Quote name="翻牌提问">{ info!.question }</Quote>
            {
              type === 'FLIPCARD_AUDIO'
                ? <audio className="room-audio" src={ url } controls={ true } preload="none" />
                : <video className="room-video" src={ url } controls={ true } preload="metadata" />
            }
          </div>
        )
      };
    }

    if (type === 'EXPRESSIMAGE') {
      const url: string | undefined = attach.expressImgInfo?.emotionRemote ?? attach.emotionRemote;

      if (url) return { body: <img className="room-sticker" src={ url } alt="表情" loading="lazy" />, plain: true };
    }
  }

  // 其他类型：显示一行说明，鼠标放上去能看到原始内容
  const name: string = typeNames[item.raw.msgType] ?? item.raw.msgType;

  return {
    body: (
      <Tooltip title={ <code className="room-raw">{ String(item.raw.bodys).slice(0, 600) }</code> } placement="right">
        <span className="room-note">[{ name }]</span>
      </Tooltip>
    ),
    plain: true
  };
}

interface MessageBubbleProps {
  item: RoomMessageItem;
  time: string;    // HH:mm
  ownerId: number; // 房主（这个房间的成员）的用户 ID
  onOpenLive?: (info: LivePushInfo) => void;
}

function MessageBubble(props: MessageBubbleProps): ReactElement {
  const { item, time, ownerId, onOpenLive }: MessageBubbleProps = props;
  const user: { avatar?: string; nickName?: string; userId?: number } = item.message.user ?? {};
  const isGuest: boolean = Number(user.userId) !== ownerId; // 不是房主发的（别的成员来串门）
  let content: { body: ReactNode; plain?: boolean };

  try {
    content = renderBody(item, onOpenLive);
  } catch (err) {
    console.error(err, item);
    content = { body: <span className="room-note">[无法显示的消息：{ item.raw.msgType }]</span>, plain: true };
  }

  return (
    <div className={ `room-message${ isGuest ? ' is-guest' : '' }` }>
      <Tooltip title={ user.nickName } placement="left" mouseEnterDelay={ 0.4 }>
        <Avatar className="room-avatar" size={ 34 } src={ user.avatar || undefined }>{ (user.nickName ?? '?').slice(-2) }</Avatar>
      </Tooltip>
      <div className="room-message-main">
        { isGuest ? <div className="room-sender">{ user.nickName }</div> : null }
        <div className="room-message-row">
          <div className={ content.plain ? 'room-plain' : 'room-bubble' }>{ content.body }</div>
          <time>{ time }</time>
        </div>
      </div>
    </div>
  );
}

export default memo(MessageBubble);
