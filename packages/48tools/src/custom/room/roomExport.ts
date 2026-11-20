import * as fs from 'node:fs';
import { promises as fsP } from 'node:fs';
import * as path from 'node:path';
import type { SaveDialogReturnValue } from 'electron';
import * as dayjs from 'dayjs';
import type { MessageInstance } from 'antd/es/message/interface';
import { requestRoomInfo, requestDownloadFileByStream, type RoomInfo, type CustomMessageV2 } from '@48tools-api/48';
import { formatSendData } from '../../pages/48/RoomMessage/utils/formatData';
import createHtml from '../../pages/48/RoomMessage/utils/createHtml';
import { showSaveDialog } from '../../utils/remote/dialog';
import { getFilePath } from '../../utils/utils';
import { source } from '../../utils/snh48';
import type { SendDataItem } from '../../pages/48/types';
import { getAllTranscripts } from '../transcribe/transcriptCache';
import { readAllCached, type RoomMember, type RoomStream } from './roomStore';

/**
 * 房间消息的导出和房间背景图下载（从 RoomPage 里拆出来的）。
 * 导出沿用原版的格式和生成代码（pages/48/RoomMessage/utils）；导出的是本地已有的全部消息（本地缓存 + 这次加载的）。
 * 转过文字的语音，会把文字一起写进导出的文件：JSON 里是语音那一条 bodys 的 transcript，HTML 里显示在播放条下面
 * （接入点：pages/48/RoomMessage/utils/HTMLComponents.tsx 里加了两处显示 transcript）。
 */
const HTML_PAGE_SIZE: number = 1_000; // 导出 html 时每个文件多少条
const JSON_PAGE_SIZE: number = 3_000;

/* 导出的一条消息如果是语音：它在转写缓存里的标识（和 MessageBubble 里用的一致） */
function voiceIdOf(item: SendDataItem): string | undefined {
  const bodys: any = item.bodys;

  if (!bodys || typeof bodys !== 'object') return undefined;

  if (item.msgType === 'AUDIO') return bodys.md5 || bodys.url;

  if ((item.msgType as string) === 'FLIPCARD_AUDIO') {
    const info: any = bodys.filpCardInfo ?? bodys.flipCardInfo ?? bodys.filpCardAudioInfo ?? bodys.flipCardAudioInfo;

    try {
      return JSON.parse(info.answer).url; // formatSendData 已经把地址补全了
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/* 给语音消息带上转好的文字，返回带上了多少条 */
export function attachTranscripts(data: Array<SendDataItem>, transcripts: Map<string, string>): number {
  let count: number = 0;

  for (const item of data) {
    const id: string | undefined = voiceIdOf(item);
    const text: string | undefined = id === undefined ? undefined : transcripts.get(id);

    if (text) {
      (item.bodys as unknown as { transcript: string }).transcript = text;
      count++;
    }
  }

  return count;
}

export async function exportRoom(member: RoomMember, mode: RoomStream, type: 'html' | 'json', messageApi: MessageInstance): Promise<void> {
  try {
    const raw: Array<CustomMessageV2> = await readAllCached(member, mode); // 从新到旧
    const result: SaveDialogReturnValue = await showSaveDialog({
      defaultPath: getFilePath({
        typeTitle: `口袋48房间消息(${ type })`,
        infoArray: [type, member.name, member.ownerId, ...(mode === 'all' ? ['全部消息'] : [])]
      })
    });

    if (result.canceled || !result.filePath) return;

    messageApi.info('正在保存…');

    if (!fs.existsSync(result.filePath)) await fsP.mkdir(result.filePath);

    const transcripts: Map<string, string> = await getAllTranscripts();
    const time: string = dayjs().format('YYYY-MM-DD HH:mm:ss');
    const pageSize: number = type === 'html' ? HTML_PAGE_SIZE : JSON_PAGE_SIZE;
    let page: number = 1;
    let transcribed: number = 0;

    for (let i: number = 0; i < raw.length; i += pageSize) {
      const data: Array<SendDataItem> = formatSendData(raw.slice(i, i + pageSize), mode === 'all');

      transcribed += attachTranscripts(data, transcripts);

      if (type === 'html') {
        await createHtml({ data, filePath: result.filePath, page, length: raw.length, time });
      } else {
        await fsP.writeFile(path.join(result.filePath, `${ page }.json`), JSON.stringify({ message: data }, null, 2), { encoding: 'utf8' });
      }

      page++;
    }

    messageApi.success(`已导出 ${ raw.length } 条消息${ transcribed > 0 ? `（其中 ${ transcribed } 条语音带转好的文字）` : '' }`);
  } catch (err) {
    console.error(err);
    messageApi.error('导出失败');
  }
}

export async function downloadRoomBackground(channelId: number | undefined, messageApi: MessageInstance): Promise<void> {
  try {
    const res: RoomInfo | undefined = channelId ? await requestRoomInfo(channelId) : undefined;
    const bgUrl: string | undefined = res?.content?.userChatConfig?.bgImg;

    if (!bgUrl) {
      messageApi.warning('没有获取到房间背景图');

      return;
    }

    const parsed: path.ParsedPath = path.parse(bgUrl);
    const result: SaveDialogReturnValue = await showSaveDialog({
      defaultPath: getFilePath({ typeTitle: '口袋48房间背景图片下载', infoArray: [parsed.name], ext: parsed.ext })
    });

    if (result.canceled || !result.filePath) return;

    await requestDownloadFileByStream(source(bgUrl), result.filePath);
    messageApi.success('背景图片下载完成');
  } catch (err) {
    console.error(err);
    messageApi.error('背景图片下载失败');
  }
}
