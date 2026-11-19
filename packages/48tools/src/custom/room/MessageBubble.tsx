import { memo, useState, type ReactElement, type ReactNode, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Avatar, Image, Tooltip } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import { PlayCircleOutlined as IconPlayCircleOutlined, LoadingOutlined as IconLoadingOutlined } from '@ant-design/icons';
import { source, mp4Source } from '../../utils/snh48';
import { openLivePush, type OpenLiveResult } from './liveCard';
import VoiceMessage from '../transcribe/VoiceMessage';
import type { RoomMessageItem } from './roomStore';

/**
 * 一条房间消息的气泡。按消息类型显示：文字、回复（带被回复的那句话）、图片、语音、视频、
 * 直播通知、翻牌（文字 / 语音 / 视频）、表情图；不认识的类型显示成一行灰色的说明。
 * 每条消息左边是发送者的头像（同一个人连续发的只在第一条显示）；不是房主发的消息会显示名字，气泡颜色也不同。
 * 发送者分三种：owner（房主本人）、guest（来串门的别的成员）、fan（粉丝，只有看「全部消息」时才有）。
 * 看「全部消息」时成员的消息（highlight）用主题色标出来，免得淹没在粉丝的消息里。
 * 语音（语音消息、翻牌的语音回答）后面有「转文字」，见 ../transcribe/VoiceMessage。
 * 直播通知可以点：直播中打开直播，结束后打开回放，查不到回放时提示已失效（见 ./liveCard）。
 */
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

/* 「开始直播」卡片：点击播放直播或回放 */
function LiveCard(props: { info: { liveId: string; liveTitle: string; liveCover?: string } }): ReactElement {
  const { info }: { info: { liveId: string; liveTitle: string; liveCover?: string } } = props;
  const { message: messageApi }: useAppProps = App.useApp();
  const [loading, setLoading]: [boolean, D<S<boolean>>] = useState(false);

  async function handleClick(): Promise<void> {
    if (loading) return;

    setLoading(true);

    try {
      const result: OpenLiveResult = await openLivePush(info);

      if (result === 'expired') {
        messageApi.warning('直播回放已失效');
      } else {
        messageApi.success(result === 'live' ? '正在直播，已打开直播窗口' : '直播已结束，已打开回放');
      }
    } catch (err) {
      console.error(err);
      messageApi.error('打开失败，请稍后再试');
    }

    setLoading(false);
  }

  return (
    <button className="room-card" type="button" onClick={ handleClick }>
      { info.liveCover ? <img src={ source(info.liveCover) } alt="" loading="lazy" /> : null }
      <span className="room-card-text">
        <small>
          { loading ? <IconLoadingOutlined /> : <IconPlayCircleOutlined /> }
          &nbsp;直播 · 点击观看
        </small>
        <b>{ info.liveTitle }</b>
      </span>
    </button>
  );
}

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

function renderBody(item: RoomMessageItem): { body: ReactNode; plain?: boolean } {
  const message: any = item.message;

  if (message.type === 'text') return { body: <p className="room-text">{ message.body }</p> };

  if (message.type === 'image') {
    return { body: <Image className="room-image" src={ message.attach.url } loading="lazy" />, plain: true };
  }

  if (message.type === 'audio') {
    // 语音消息自带 md5，用它当标识（同一段语音只转一次）；没有就用地址
    return {
      body: (
        <VoiceMessage id={ message.attach.md5 || message.attach.url }
          url={ message.attach.url }
          ext={ message.attach.ext }
          time={ item.raw.msgTime }
        />
      )
    };
  }

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
      return { body: <LiveCard info={ attach.livePushInfo } />, plain: true };
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
                ? <VoiceMessage id={ url } url={ url } time={ item.raw.msgTime } question={ info!.question } />
                : <video className="room-video" src={ url } controls={ true } preload="metadata" />
            }
          </div>
        )
      };
    }

    if (type === 'EXPRESSIMAGE') {
      const url: string | undefined = attach.expressImgInfo?.emotionRemote ?? attach.emotionRemote;

      if (url) return { body: <img className="room-sticker" src={ source(url) } alt="表情" loading="lazy" />, plain: true };
    }
  }

  // 粉丝送礼物
  if ((item.raw.msgType as string) === 'GIFT_TEXT') {
    const gift: { giftName?: string; giftNum?: number; picPath?: string; userName?: string } = JSON.parse(item.raw.bodys).giftInfo ?? {};

    return {
      body: (
        <span className="room-gift">
          { gift.picPath ? <img src={ source(gift.picPath) } alt="" loading="lazy" /> : null }
          送给 { gift.userName } { gift.giftName } × { gift.giftNum ?? 1 }
        </span>
      )
    };
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
  time: string;        // HH:mm
  showAvatar: boolean; // 同一个人连续发的消息，只在第一条显示头像
  sender: 'owner' | 'guest' | 'fan'; // 房主本人 / 来串门的别的成员 / 粉丝
  highlight: boolean;  // 用主题色标出来（看「全部消息」时成员发的）
}

function MessageBubble(props: MessageBubbleProps): ReactElement {
  const { item, time, showAvatar, sender, highlight }: MessageBubbleProps = props;
  const showName: boolean = showAvatar && (sender !== 'owner' || highlight);
  const user: { nickName?: string; avatar?: string } = item.message.user ?? {};
  let content: { body: ReactNode; plain?: boolean };

  try {
    content = renderBody(item);
  } catch (err) {
    console.error(err, item);
    content = { body: <span className="room-note">[无法显示的消息：{ item.raw.msgType }]</span>, plain: true };
  }

  return (
    <div className={ `room-message is-${ sender }${ highlight ? ' is-highlight' : '' }${ showAvatar ? ' is-first' : '' }` }>
      <div className="room-avatar">
        {
          showAvatar ? (
            <Tooltip title={ user.nickName } placement="left" mouseEnterDelay={ 0.3 }>
              <Avatar size={ 32 } src={ user.avatar || undefined }>{ (user.nickName ?? '?').slice(-2) }</Avatar>
            </Tooltip>
          ) : null
        }
      </div>
      <div className="room-message-main">
        { showName ? <div className="room-sender">{ user.nickName }</div> : null }
        <div className="room-message-row">
          <div className={ content.plain ? 'room-plain' : 'room-bubble' }>{ content.body }</div>
          <time>{ time }</time>
        </div>
      </div>
    </div>
  );
}

export default memo(MessageBubble);
