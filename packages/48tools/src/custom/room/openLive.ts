import { ipcRenderer } from 'electron';
import { WinIpcChannel } from '@48tools/main/src/channelEnum';
import { requestLiveRoomInfo, requestDownloadFile, type LiveRoomInfo } from '@48tools-api/48';
import { engineUserAgent } from '../../utils/snh48';
import { getNetMediaServerPort, netMediaServerInit, type NetMediaServerPort } from '../../utils/nodeMediaServer/nodeMediaServer';
import { getProxyServerPort, proxyServerInit } from '../../utils/proxyServer/proxyServer';

/**
 * 房间消息里的「开始直播」卡片：点击后打开播放窗口。
 *   - 直播还在进行：打开直播播放（和「直播抓取」页面的「播放」一样）
 *   - 直播已经结束：打开录播回放（和「录播下载」页面的「播放」一样）
 *   - 查不到这场直播，或者回放文件已经取不到：返回 gone，由界面提示「直播回放已失效」
 * 判断方法：用直播 ID 查 /live/api/v1/live/getLiveOne，返回的 playStreamPath 是 m3u8 / mp4 就是回放，否则是直播流。
 * 接入点：custom/room/MessageBubble 的直播卡片。
 */
export type LivePushKind = 'live' | 'record' | 'gone';

export interface LivePushResult {
  kind: LivePushKind;
  info?: LiveRoomInfo;
  reason?: string;
}

type LiveContent = LiveRoomInfo['content'] & { liveType?: number; liveMode?: number; coverPath?: string; status?: number };

export function isReplayPath(playStreamPath: string): boolean {
  try {
    return /\.(m3u8|mp4)$/i.test(new URL(playStreamPath).pathname);
  } catch {
    return /\.(m3u8|mp4)(\?|$)/i.test(playStreamPath);
  }
}

/* 查这场直播现在是什么状态 */
export async function resolveLivePush(liveId: string): Promise<LivePushResult> {
  let info: LiveRoomInfo;

  try {
    info = await requestLiveRoomInfo(liveId);
  } catch (err) {
    return { kind: 'gone', reason: err instanceof Error ? err.message : String(err) };
  }

  const playStreamPath: string | undefined = info?.content?.playStreamPath;

  if (!info?.success || !playStreamPath) return { kind: 'gone', info, reason: info?.message || '没有播放地址' };

  if (!isReplayPath(playStreamPath)) return { kind: 'live', info };

  // 回放：确认回放文件还取得到（过期的回放地址还在，但文件已经没有了）
  if (/\.m3u8$/i.test(new URL(playStreamPath).pathname)) {
    try {
      const url: URL = new URL(playStreamPath);
      const m3u8: string = await requestDownloadFile(playStreamPath, {
        Host: /live\.us\.sinaimg\.cn/.test(url.hostname) ? undefined : url.hostname,
        'User-Agent': engineUserAgent
      });

      if (!m3u8.includes('#EXTM3U')) return { kind: 'gone', info, reason: '回放文件内容不对' };
    } catch (err) {
      return { kind: 'gone', info, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  return { kind: 'record', info };
}

/**
 * 打开播放窗口
 * @param { string } liveId
 * @param { { title: string; cover?: string } } fallback - 卡片上的标题和封面（查不到时用）
 */
export async function openLivePush(liveId: string, fallback: { title: string; cover?: string }): Promise<LivePushResult> {
  const result: LivePushResult = await resolveLivePush(liveId);

  if (result.kind === 'gone' || !result.info) return result;

  const content: LiveContent = result.info.content;
  const common: Record<string, string> = {
    id: liveId,
    coverPath: content.coverPath ?? fallback.cover ?? '',
    title: content.title || fallback.title,
    liveId,
    liveType: String(content.liveType ?? 1),
    liveMode: String(content.liveMode ?? 0)
  };
  let searchParams: URLSearchParams;

  if (result.kind === 'live') {
    await netMediaServerInit(); // 直播播放需要本机的流转换服务（「直播抓取」页面也是进页面时启动）

    const port: NetMediaServerPort = getNetMediaServerPort();

    searchParams = new URLSearchParams({
      ...common,
      playerType: 'live',
      httpPort: String(port.httpPort),
      rtmpPort: String(port.rtmpPort)
    });
  } else {
    await proxyServerInit(); // 回放需要本机的分片代理（「录播下载」页面也是进页面时启动）
    searchParams = new URLSearchParams({
      ...common,
      playerType: 'record',
      proxyPort: String(getProxyServerPort().port)
    });
  }

  ipcRenderer.send(WinIpcChannel.PlayerHtml, common.title, searchParams.toString());

  return result;
}

// 自动化测试时暴露出来，方便检查接口返回的内容
if (typeof globalThis !== 'undefined' && (globalThis as { __INITIAL_STATE__?: { isTest?: boolean } }).__INITIAL_STATE__?.isTest) {
  (globalThis as { __resolveLivePush?: typeof resolveLivePush }).__resolveLivePush = resolveLivePush;
}
