// @ts-expect-error
import type { Response as GotResponse } from 'got';
import type { HomeMessageResult } from '@48tools-api/48';
import got from '../pocket48Proxy/pocket48Got';
import { createHeaders, getPocket48Token } from '../../utils/snh48';

/**
 * 取房间里所有人的消息（成员 + 粉丝）：POST /im/api/v1/team/message/list/all。
 * 这个接口是从口袋48 App（iOS 7.1.48）抓包看到的，原版 48tools 没有用到。
 * 参数和返回的格式都和「只取成员消息」的 list/homeowner 一样（原版的 requestHomeownerMessage）：
 *   - nextTime 传 0 是最新的一批；传返回里的 nextTime 就是更早的一批；也可以直接传任意时间，从那个时间往回取
 *   - 每次最多返回 50 条（limit 写得再大也是 50）
 *   - 结果里也包含成员自己的消息。发送人的 roleId：成员是 3，粉丝是 1
 * 实测能取到半年以前的消息。
 * @param { number } channelId
 * @param { number } serverId
 * @param { number } [nextTime = 0] - 查询的位置
 */
export async function requestAllMessage(
  channelId: number,
  serverId: number,
  nextTime: number = 0
): Promise<HomeMessageResult | undefined> {
  const token: string | undefined = getPocket48Token();

  if (!token) return;

  const res: GotResponse<HomeMessageResult> = await got('https://pocketapi.48.cn/im/api/v1/team/message/list/all', {
    method: 'POST',
    headers: await createHeaders(token),
    responseType: 'json',
    json: { channelId, serverId, nextTime, limit: 100 }
  });

  return res.body;
}
