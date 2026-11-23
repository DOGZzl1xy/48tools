'use idle';

import * as path from 'node:path';
import { promises as fsP } from 'node:fs';
import type { Store } from '@reduxjs/toolkit';
import type { MessageInstance } from 'antd/es/message/interface';
import * as dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { requestLiveList, type LiveData, type LiveInfo, type UserInfo } from '@48tools-api/48';
import { store } from '../../../../store/store';
import { setLiveList } from '../../reducers/pocket48';
import { createMemberMatcher, createErrorNotifier } from '../../../../custom/live/autoGrabHelpers';
import { getLiveRecordDir } from '../../../../custom/live/liveRecording';
import { trackLive, isTrackedLive } from '../../../../custom/live/replayGrab';
import { actionsText, type GrabActions } from '../../../../custom/live/replayGrabCore';
import { pocket48ErrorText, pocket48FailText } from '../../../../custom/pocket48Api/apiErrorText';

/* 轮询出错时提示（同样的错误 10 分钟内只提示一次） */
let notifyAutoGrabError: ((text: string) => void) | undefined;

/**
 * 自动抓取：每隔几分钟查一次直播列表，盯着的成员开播了就记下来。
 * 不录直播流（录下来的没有弹幕）：直播结束后下载官方录播、做切片，按开始时勾选的来（见 custom/live/replayGrab，用户 2026-11-23 定的）。
 * 原版在这里用 ffmpeg 录直播流；页面上手动点「录制」照常录（Pocket48Live.tsx）。
 * @param { MessageInstance } messageApi
 * @param { string } configDir - 「自动抓取配置」里填的文件夹（local/pocket48.json 里配置的优先，见 getLiveRecordDir）
 * @param { Array<string> } usersArr - 盯着的成员（名字或 ID）
 * @param { GrabActions } actions - 直播结束后要什么：完整录播、切片
 */
async function autoGrab(messageApi: MessageInstance, configDir: string, usersArr: string[], actions: GrabActions): Promise<void> {
  const { dispatch }: Store = store;
  const dir: string = getLiveRecordDir(configDir);
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

  // 昵称匹配或者 ID 完全匹配
  const isTargetMember: (nickname: string, userId: string | number) => boolean = createMemberMatcher(usersArr);

  for (const item of liveList) {
    const { userId, nickname }: UserInfo = item.userInfo;

    if (!isTargetMember(nickname, userId) || isTrackedLive(item.liveId)) continue;

    const cTimeDay: Dayjs = dayjs(Number(item.ctime));

    try {
      // 追加 log
      await fsP.writeFile(path.join(dir, 'pocket48_live_log.txt'), `直播标题：${ item.title }
直播ID：${ item.liveId }
直播人：${ item.userInfo.nickname }
直播时间：${ cTimeDay.format('YYYY-MM-DD HH:mm:ss') }
直播结束后：${ actionsText(actions) }
记下时间：${ dayjs().format('YYYY-MM-DD HH:mm:ss') }\n\n`, { encoding: 'utf8', flag: 'a' });
    } catch (err) {
      console.error(err);
    }

    trackLive(item, actions, dir);
  }
}

export default autoGrab;
