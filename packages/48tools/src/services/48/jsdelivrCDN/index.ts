import { setTimeout, clearTimeout } from 'node:timers';
import type { RoomIdObj } from './interface';
import { requestSyncedMembers } from '../../../custom/sync/memberSource';

export type * from './interface';

let cacheRoomIdRes: RoomIdObj | null = null;

/**
 * 通过url查找roomId
 * @param { string } url
 */
async function requestRoomIdCore(url: string): Promise<RoomIdObj | null> {
  try {
    const controller: AbortController = new AbortController();
    const timeoutTimer: NodeJS.Timeout = setTimeout((): void => controller.abort(), 10_000);
    const res: Response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutTimer);

    return res.json();
  } catch {
    return null;
  }
}

/* 查找roomId */
export async function requestRoomId(): Promise<RoomIdObj | null> {
  const url: string = 'https://fastly.jsdelivr.net/gh/duan602728596/qqtools@main/packages/NIMTest/node/roomId.json';
  const mirrorUrl: string = 'https://raw.gitmirror.com/duan602728596/qqtools/main/packages/NIMTest/node/roomId.json';

  // custom/sync：配置了同步服务时，成员名单先从它取（更新得及时，新成员、预备生都有）；没配或者没取到再用下面的公开名单
  const synced: RoomIdObj | null = await requestSyncedMembers();

  if (synced) {
    cacheRoomIdRes = synced;

    return synced;
  }

  // 使用主地址
  const res: RoomIdObj | null = await requestRoomIdCore(`${ url }?t=${ new Date().getTime() }`);

  if (res) {
    cacheRoomIdRes = res;

    return res;
  }

  // 使用备用地址
  const mirrorRes: RoomIdObj | null = await requestRoomIdCore(`${ mirrorUrl }?t=${ new Date().getTime() }`);

  if (mirrorRes) {
    cacheRoomIdRes = mirrorRes;

    return mirrorRes;
  }

  return cacheRoomIdRes;
}