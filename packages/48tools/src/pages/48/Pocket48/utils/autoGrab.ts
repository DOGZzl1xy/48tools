'use idle';

import * as path from 'node:path';
import { promises as fsP } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Store } from '@reduxjs/toolkit';
import type { MessageInstance } from 'antd/es/message/interface';
import * as dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { requestLiveList, requestLiveRoomInfo, type LiveData, type LiveInfo, type UserInfo, type LiveRoomInfo } from '@48tools-api/48';
import getPocket48LiveDownloadWorker from './Pocket48LiveDownload.worker/getPocket48LiveDownloadWorker';
import getDownloadAndTranscodingWorker from './DownloadAndTranscodingWorker/getDownloadAndTranscodingWorker';
import { store } from '../../../../store/store';
import { setLiveList, setDeleteLiveChildList, setAddLiveChildList, type Pocket48InitialState } from '../../reducers/pocket48';
import { getFFmpeg, fileTimeFormat, getFilePath } from '../../../../utils/utils';
import { getPocket48Proxy } from '../../../../custom/pocket48Proxy/pocket48Proxy';
import { createMemberMatcher, createErrorNotifier } from '../../../../custom/live/autoGrabHelpers';
import { getLiveRecordDir, liveRecordingStart, liveRecordingEnd } from '../../../../custom/live/liveRecording';
import { pocket48ErrorText, pocket48FailText } from '../../../../custom/pocket48Api/apiErrorText';
import Pocket48LiveRender from './Pocket48LiveRender';
import type { MessageEventData, LiveStatusEventData, WebWorkerChildItem } from '../../../../commonTypes';

interface DownloadArgs {
  messageApi: MessageInstance;
  transcoding: boolean | undefined;
  item: LiveInfo;
  resInfo: LiveRoomInfo;
  filePath: string;
}

function downloadBackup(args: Pick<DownloadArgs, 'item' | 'resInfo' | 'filePath'>): void {
  const { dispatch }: Store = store;
  const { item, resInfo, filePath }: Pick<DownloadArgs, 'item' | 'resInfo' | 'filePath'> = args;
  const worker: Pocket48LiveRender = new Pocket48LiveRender({
    id: randomUUID(),
    liveId: item.liveId,
    roomId: resInfo.content.roomId,
    playStreamPath: resInfo.content.playStreamPath,
    filePath,
    ffmpeg: getFFmpeg(),
    onClose(id: string): void {
      dispatch(setDeleteLiveChildList(item));
      liveRecordingEnd({ liveId: item.liveId, filePath }, getFFmpeg());
    }
  });

  dispatch(setAddLiveChildList({
    id: item.liveId,
    worker
  }));
  liveRecordingStart({
    liveId: item.liveId,
    title: `${ item.userInfo.nickname } ${ item.title }`,
    filePath,
    stop: (): void => worker.kill()
  });
}

function download(args: DownloadArgs): void {
  const { dispatch }: Store = store;
  const { messageApi, transcoding, item, resInfo, filePath }: DownloadArgs = args;
  const worker: Worker = transcoding ? getDownloadAndTranscodingWorker() : getPocket48LiveDownloadWorker();

  worker.addEventListener('message', function(event: MessageEvent<MessageEventData | LiveStatusEventData>): void {
    const { type }: MessageEventData | LiveStatusEventData = event.data;

    if (type === 'close' || type === 'error') {
      if (type === 'error') {
        messageApi.error(`视频：${ item.title } 下载失败！`);
      }

      worker.terminate();
      dispatch(setDeleteLiveChildList(item));
      liveRecordingEnd({ liveId: item.liveId, filePath }, getFFmpeg(), type === 'error' ? '录制出错' : undefined);
    }
  }, false);
  liveRecordingStart({
    liveId: item.liveId,
    title: `${ item.userInfo.nickname } ${ item.title }`,
    filePath,
    stop: (): void => worker.postMessage({ type: 'stop' })
  });

  worker.postMessage({
    type: 'start',
    playStreamPath: resInfo.content.playStreamPath,
    filePath,
    ffmpeg: getFFmpeg(),
    liveId: item.liveId,
    roomId: resInfo.content.roomId,
    pocket48Proxy: getPocket48Proxy()
  });

  dispatch(setAddLiveChildList({
    id: item.liveId,
    worker
  }));
}

/**
 * 自动抓取
 * @param { MessageInstance } messageApi
 * @param { string } dir - 保存录像的目录
 * @param { Array<string> } usersArr - 监听的小偶像
 * @param { boolean | undefined } transcoding - 自动转码
 * @param { boolean | undefined } backup - 备用下载
 */
/* 轮询出错时提示（同样的错误 10 分钟内只提示一次） */
let notifyAutoGrabError: ((text: string) => void) | undefined;

async function autoGrab(
  messageApi: MessageInstance,
  configDir: string,
  usersArr: string[],
  transcoding: boolean | undefined,
  backup: boolean | undefined
): Promise<void> {
  const { dispatch, getState }: Store = store;
  const dir: string = getLiveRecordDir(configDir); // local/pocket48.json 里配置的目录优先
  let res: LiveData;

  notifyAutoGrabError ??= createErrorNotifier((text: string): unknown => messageApi.error(text, 8));

  try {
    res = await requestLiveList('0', true);
  } catch (err) {
    console.error(err);
    notifyAutoGrabError(await pocket48ErrorText('自动抓取：获取直播列表失败。', err));

    return;
  }

  if (!res.success || !res.content?.liveList) {
    notifyAutoGrabError(pocket48FailText('自动抓取：获取直播列表失败。', res.message));

    return;
  }

  const liveList: Array<LiveInfo> = res.content.liveList; // 自动刷新获取直播列表

  dispatch(setLiveList(liveList));

  // 过滤，只保留xox信息
  const isTargetMember: (nickname: string, userId: string | number) => boolean = createMemberMatcher(usersArr);
  const { liveChildList }: Pocket48InitialState = getState().pocket48;

  for (const item of liveList) {
    const { userId, nickname }: UserInfo = item.userInfo;
    const index: number = liveChildList.findIndex((o: WebWorkerChildItem): boolean => o.id === item.liveId);

    // 昵称匹配或者id完全匹配
    if (isTargetMember(nickname, userId) && index < 0) {
      const cTimeDay: Dayjs = dayjs(Number(item.ctime)),
        cTime: string = cTimeDay.format(fileTimeFormat), // 直播开始时间
        rTimeDay: Dayjs = dayjs(),
        rTime: string = rTimeDay.format(fileTimeFormat), // 文件创建时间
        filename: string = getFilePath({
          typeTitle: '口袋48直播(自动录制)',
          infoArray: [item.userInfo.nickname, item.title, cTime, item.liveId],
          timeString: rTime,
          ext: transcoding ? 'ts' : 'flv'
        }); // 文件名

      let resInfo: LiveRoomInfo;

      try {
        resInfo = await requestLiveRoomInfo(item.liveId);

        if (!resInfo.success || !resInfo.content?.playStreamPath) throw new Error(resInfo.message || '没有拿到直播地址');
      } catch (err) {
        // 这个成员这一轮录不了，下一轮再试，不影响其他成员
        console.error(err);
        notifyAutoGrabError(await pocket48ErrorText(`自动抓取：获取 ${ nickname } 的直播地址失败。`, err));
        continue;
      }

      try {
        // 追加log
        const log: string = path.join(dir, 'pocket48_live_log.txt');
        const logData: string = `直播标题：${ item.title }
直播ID：${ item.liveId }
直播人：${ item.userInfo.nickname }
直播时间：${ cTimeDay.format('YYYY-MM-DD HH:mm:ss') }
输出文件：${ filename }
创建时间：${ rTimeDay.format('YYYY-MM-DD HH:mm:ss') }\n\n`;

        await fsP.writeFile(log, logData, { encoding: 'utf8', flag: 'a' });
      } catch (err) {
        console.error(err);
      }

      const filePath: string = path.join(dir, filename);

      if (backup) {
        downloadBackup({ item, resInfo, filePath });
      } else {
        download({ messageApi, transcoding, item, resInfo, filePath });
      }
    }
  }
}

export default autoGrab;