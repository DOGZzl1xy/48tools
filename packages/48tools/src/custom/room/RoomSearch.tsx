import { useEffect, useRef, useState, type ReactElement, type RefObject, type ChangeEvent, type Dispatch as D, type SetStateAction as S } from 'react';
import { DatePicker, Drawer, Empty, Input, Spin } from 'antd';
import { SearchOutlined as IconSearchOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import type { CustomMessageV2 } from '@48tools-api/48';
import { mp4Source } from '../../utils/snh48';
import { getAllTranscripts } from '../transcribe/transcriptCache';
import { searchRoomCache, firstCachedSince, type RoomStream } from './roomCache';
import { keyOf, type RoomMember } from './roomStore';
import { matchMessage, messageText, senderName, snippet } from './roomSearchText';
import { roomClock, dayStart, type RoomClock } from './roomTime';

/**
 * 在一个房间的本地消息里搜索，或者跳到某一天（从右边滑出的面板）。
 *   - 搜索：在本机已经存下来的消息里找（看的是「只看成员」就搜成员的消息，「全部消息」就连粉丝的一起搜），
 *     能搜文字、回复、翻牌的提问和回答、发送者的名字，还有语音转好的文字。从新到旧最多列 MAX_RESULTS 条。
 *   - 跳到某一天：跳到那一天的第一条消息；那天没有消息就跳到之后最近的一条。
 * 点一条结果后由 ChatView 把那里的消息读出来并滚过去（onJump）。只搜本机有的：没存下来的更早的消息搜不到。
 */
const MAX_RESULTS: number = 200;

interface RoomSearchProps {
  open: boolean;
  member: RoomMember;
  mode: RoomStream;
  beijing: boolean; // 时间是不是按北京时间显示
  onJump: (raw: CustomMessageV2) => void;
  onClose: () => void;
}

/* 语音消息在转写缓存里的标识（和 MessageBubble 里用的一致）；不是语音返回 undefined */
function voiceIdOf(raw: CustomMessageV2): string | undefined {
  try {
    if (raw.msgType === 'AUDIO') {
      const body: { md5?: string; url?: string } = JSON.parse(raw.bodys);

      return body.md5 || body.url;
    }

    if ((raw.msgType as string) === 'FLIPCARD_AUDIO') {
      const body: any = JSON.parse(raw.bodys);
      const info: any = body.filpCardInfo ?? body.flipCardInfo ?? body.filpCardAudioInfo ?? body.flipCardAudioInfo;

      return mp4Source(JSON.parse(info.answer).url);
    }
  } catch { /* 不是预期的格式：当成没有 */ }

  return undefined;
}

interface ResultRow {
  raw: CustomMessageV2;
  key: string;
  clock: RoomClock;
  name: string;
  text: string;
}

function RoomSearch(props: RoomSearchProps): ReactElement {
  const { open, member, mode, beijing, onJump, onClose }: RoomSearchProps = props;
  const [keyword, setKeyword]: [string, D<S<string>>] = useState('');
  const [rows, setRows]: [Array<ResultRow> | null, D<S<Array<ResultRow> | null>>] = useState<Array<ResultRow> | null>(null);
  const [searching, setSearching]: [boolean, D<S<boolean>>] = useState(false);
  const [dateHint, setDateHint]: [string, D<S<string>>] = useState('');
  const searchId: RefObject<number> = useRef(0);

  // 输入停下 0.4 秒后搜索
  useEffect(function(): (() => void) | void {
    const word: string = keyword.trim();
    const id: number = ++searchId.current;

    if (word === '' || !open) {
      setRows(null);
      setSearching(false);

      return;
    }

    const timer: number = window.setTimeout(async (): Promise<void> => {
      setSearching(true);

      const transcripts: Map<string, string> = await getAllTranscripts();

      function transcriptOf(raw: CustomMessageV2): string | undefined {
        const voiceId: string | undefined = voiceIdOf(raw);

        return voiceId === undefined ? undefined : transcripts.get(voiceId);
      }

      const found: Array<CustomMessageV2> = await searchRoomCache(
        mode, member.ownerId, (raw: CustomMessageV2): boolean => matchMessage(raw, word, transcriptOf(raw)), MAX_RESULTS);

      if (id !== searchId.current) return;

      setRows(found.map((raw: CustomMessageV2): ResultRow => ({
        raw,
        key: keyOf(raw),
        clock: roomClock(raw.msgTime, beijing),
        name: senderName(raw),
        text: snippet(messageText(raw, transcriptOf(raw)) || `[${ raw.msgType }]`, word)
      })));
      setSearching(false);
    }, 400);

    return (): void => window.clearTimeout(timer);
  }, [keyword, open, mode, member.ownerId, beijing]);

  async function handleDateChange(value: Dayjs | null): Promise<void> {
    setDateHint('');

    if (!value) return;

    const dateText: string = value.format('YYYY-MM-DD');
    const raw: CustomMessageV2 | undefined = await firstCachedSince(mode, member.ownerId, dayStart(dateText, beijing));

    if (!raw) {
      setDateHint('这一天和之后，本机都没有存下来的消息。');

      return;
    }

    const found: string = roomClock(raw.msgTime, beijing).date;

    setDateHint(found === dateText ? '' : `${ dateText } 没有消息，已经跳到之后最近的一条（${ found }）。`);
    onJump(raw);
  }

  return (
    <Drawer title={ `在 ${ member.name } 的房间里查找` }
      open={ open }
      width={ 400 }
      mask={ false }
      destroyOnHidden={ true }
      onClose={ onClose }
    >
      <div className="room-find">
        <div className="room-find-label">跳到某一天</div>
        <DatePicker className="w-full" allowClear={ true } placeholder="选择日期" onChange={ handleDateChange } />
        { dateHint ? <p className="room-find-hint">{ dateHint }</p> : null }
        <div className="room-find-label">搜索消息</div>
        <Input allowClear={ true }
          autoFocus={ true }
          placeholder={ mode === 'all' ? '搜索内容或发送者（成员和粉丝的消息）' : '搜索内容（成员的消息、转好的语音）' }
          prefix={ <IconSearchOutlined /> }
          value={ keyword }
          onChange={ (event: ChangeEvent<HTMLInputElement>): void => setKeyword(event.target.value) }
        />
        <p className="room-find-hint">
          只在本机已经存下来的消息里找。
          { rows ? (rows.length >= MAX_RESULTS ? `只列出最新的 ${ MAX_RESULTS } 条。` : `找到 ${ rows.length } 条。`) : '' }
          { searching ? <Spin className="ml-[8px]" size="small" /> : null }
        </p>
        <div className="room-find-list">
          {
            (rows ?? []).map((row: ResultRow): ReactElement => (
              <button key={ row.key } className="room-find-item" type="button" onClick={ (): void => onJump(row.raw) }>
                <small>
                  <b>{ row.name }</b>
                  { row.clock.date } { row.clock.time }
                </small>
                <span>{ row.text }</span>
              </button>
            ))
          }
          { rows && rows.length === 0 && !searching ? <Empty className="pt-[32px]" description="没有找到" /> : null }
        </div>
      </div>
    </Drawer>
  );
}

export default RoomSearch;
