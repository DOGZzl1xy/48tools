import { ipcRenderer } from 'electron';
import { WinIpcChannel } from '@48tools/main/src/channelEnum';
import { requestLiveRoomInfo, requestDownloadFile, type LiveRoomInfo } from '@48tools-api/48';
import { engineUserAgent } from '../../utils/snh48';
import { getNetMediaServerPort, netMediaServerInit, type NetMediaServerPort } from '../../utils/nodeMediaServer/nodeMediaServer';
import { getProxyServerPort, proxyServerInit } from '../../utils/proxyServer/proxyServer';

/**
 * 房间里的「开始直播」消息：点一下就打开播放窗口。
 *   - 直播还在进行：播放直播
 *   - 直播已经结束：播放回放（录播）
 *   - 查不到回放：提示「直播回放已失效」
 * 做法：消息里带着这场直播的 liveId，用它请求直播详情（/live/api/v1/live/getLiveOne，原版已有）。
 * 返回里 review 为 true（或者播放地址是 m3u8）表示已经结束、播放地址是回放；否则播放地址是直播流。
 * 播放窗口用的是原版的播放器（和「直播抓取」「录播下载」页面里的「播放」一样）。
 */
export interface LivePushInfo {
  liveId: string;
  liveTitle: string;
  liveCover?: string;
}

export type OpenLiveResult = 'live' | 'replay' | 'expired';

type LiveContent = LiveRoomInfo['content'] & { review?: boolean; liveType?: number; liveMode?: number; coverPath?: string };

function isM3u8(url: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/* 根据直播详情判断是直播还是回放（单独拿出来方便测试） */
export function liveKind(content: { review?: boolean; playStreamPath?: string } | null | undefined): OpenLiveResult {
  const url: string = content?.playStreamPath ?? '';

  if (!url) return 'expired';

  return content?.review === true || isM3u8(url) ? 'replay' : 'live';
}

/* 回放的 m3u8 还能不能取到 */
async function replayExists(playStreamPath: string): Promise<boolean> {
  try {
    const url: URL = new URL(playStreamPath);
    const text: string = await requestDownloadFile(playStreamPath, {
      Host: /live\.us\.sinaimg\.cn/.test(url.hostname) ? undefined : url.hostname,
      'User-Agent': engineUserAgent
    });

    return /#EXTINF|#EXT-X-STREAM-INF/.test(text);
  } catch (err) {
    console.error(err);

    return false;
  }
}

/**
 * 打开播放窗口
 * @return 打开的是直播、回放，还是回放已经失效
 */
export async function openLivePush(push: LivePushInfo): Promise<OpenLiveResult> {
  const res: LiveRoomInfo = await requestLiveRoomInfo(push.liveId);
  const content: LiveContent | undefined = res?.content;
  const kind: OpenLiveResult = res?.success === false ? 'expired' : liveKind(content);

  if (kind === 'expired' || !content) return 'expired';

  if (kind === 'replay' && !(await replayExists(content.playStreamPath))) return 'expired';

  const common: Record<string, string> = {
    id: push.liveId,
    coverPath: content.coverPath ?? push.liveCover ?? '',
    title: content.title ?? push.liveTitle,
    liveId: push.liveId,
    liveType: String(content.liveType ?? 1),
    liveMode: String(content.liveMode ?? 0)
  };
  let searchParams: URLSearchParams;

  if (kind === 'replay') {
    await proxyServerInit();
    searchParams = new URLSearchParams({ ...common, playerType: 'record', proxyPort: String(getProxyServerPort().port) });
  } else {
    await netMediaServerInit();

    const port: NetMediaServerPort = getNetMediaServerPort();

    searchParams = new URLSearchParams({ ...common, playerType: 'live', httpPort: String(port.httpPort), rtmpPort: String(port.rtmpPort) });
  }

  ipcRenderer.send(WinIpcChannel.PlayerHtml, common.title, searchParams.toString());

  return kind;
}
