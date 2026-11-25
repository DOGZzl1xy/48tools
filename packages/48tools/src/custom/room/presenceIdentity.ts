import { requestServerJump, type ServerJumpResult } from '@48tools-api/48';
import { getPocket48Token } from '../../utils/snh48';
import { readJson, writeJson } from '../common/util';
import { getMemberDirectory, type DirectoryState } from './memberDirectory';
import type { DirectoryMember } from './memberSearch';
import { getChannel, setChannel } from './unreadStore';
import type { RoomMember } from './roomStore';
import type { RosterMember } from './presenceApi';

/**
 * 成员 ownerId ↔ 云信 accid 的本地映射与解析（保持客户端轻量，不启动任何云信 SDK）：
 *   1. 本地持久化缓存（localStorage 的 ROOM_PRESENCE_IDENTITIES）
 *   2. 服务端 /roster 已有记录（按 serverId 或唯一名字反查本地 ownerId）
 *   3. 公开成员名单（memberDirectory / roomId.json 自带的 account & serverId）
 * 三处都没有的（名单还没收录的新成员），客户端查不到她的账号：服务端跟踪不了，界面上一直是「状态未知」。
 */
export interface MemberIdentity {
  accid: string;
  serverId?: number;
  name?: string;
}

const IDENTITIES_KEY: string = 'ROOM_PRESENCE_IDENTITIES';

function loadIdentities(): Record<number, MemberIdentity> {
  if (typeof localStorage === 'undefined') return {};

  const saved: unknown = readJson<unknown>(IDENTITIES_KEY, null);

  if (!saved || typeof saved !== 'object') return {};

  const result: Record<number, MemberIdentity> = {};

  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const ownerId: number = Number(key);

    if (!Number.isFinite(ownerId) || !value || typeof value !== 'object') continue;

    const item: Partial<MemberIdentity> = value as Partial<MemberIdentity>;

    if (typeof item.accid === 'string' && item.accid.trim() !== '') {
      result[ownerId] = {
        accid: item.accid.trim(),
        serverId: typeof item.serverId === 'number' ? item.serverId : undefined,
        name: typeof item.name === 'string' ? item.name : undefined
      };
    }
  }

  return result;
}

let identities: Record<number, MemberIdentity> = loadIdentities();

function persistIdentities(): void {
  if (typeof localStorage === 'undefined') return;

  writeJson(IDENTITIES_KEY, identities);
}

export function getSavedIdentity(ownerId: number): MemberIdentity | undefined {
  return identities[ownerId];
}

export function saveIdentity(ownerId: number, info: MemberIdentity): void {
  const prev: MemberIdentity | undefined = identities[ownerId];

  if (prev?.accid === info.accid && prev?.serverId === info.serverId && prev?.name === info.name) return;

  identities = {
    ...identities,
    [ownerId]: {
      accid: info.accid,
      serverId: info.serverId ?? prev?.serverId,
      name: info.name ?? prev?.name
    }
  };
  persistIdentities();
}

/* 构造 accid → ownerId 的快速索引（用于把服务端 /presence、/events 响应映射到本地成员） */
export function buildAccidToOwnerMap(
  directory: DirectoryState,
  follows: Array<RoomMember>
): Map<string, number> {
  const map: Map<string, number> = new Map();

  for (const member of directory.members) {
    if (member.account) map.set(member.account, member.id);
  }

  for (const [ownerId, info] of Object.entries(identities)) {
    map.set(info.accid, Number(ownerId));
  }

  // 公开名单里有账号的已关注成员：顺便记进本地缓存
  for (const member of follows) {
    if (identities[member.ownerId]?.accid) continue;

    const dir: DirectoryMember | undefined = directory.byId[member.ownerId];

    if (dir?.account) {
      map.set(dir.account, member.ownerId);
      saveIdentity(member.ownerId, { accid: dir.account, serverId: dir.serverId ?? getChannel(member.ownerId)?.serverId, name: member.name });
    }
  }

  return map;
}

/* 把服务端 /roster 返回的名单与本地 ownerId 关联起来并记入缓存 */
export function linkServerRoster(
  roster: Array<RosterMember>,
  directory: DirectoryState,
  follows: Array<RoomMember>
): Map<string, number> {
  const byServerId: Map<number, number> = new Map();
  const byAccount: Map<string, number> = new Map();

  for (const item of directory.members) {
    if (typeof item.serverId === 'number') byServerId.set(item.serverId, item.id);

    if (item.account) byAccount.set(item.account, item.id);
  }

  for (const member of follows) {
    const ch: { serverId: number; channelId: number } | undefined = getChannel(member.ownerId);

    if (ch?.serverId) byServerId.set(ch.serverId, member.ownerId);
  }

  for (const item of roster) {
    if (!item.accid) continue;

    let ownerId: number | undefined = byAccount.get(item.accid)
      ?? (typeof item.serverId === 'number' ? byServerId.get(item.serverId) : undefined);

    if (ownerId === undefined && item.name) {
      const followMatches: Array<RoomMember> = follows.filter((member: RoomMember): boolean => member.name === item.name);

      if (followMatches.length === 1) {
        ownerId = followMatches[0].ownerId;
      } else {
        const dirMatches: Array<DirectoryMember> = directory.members.filter((member: DirectoryMember): boolean => member.name === item.name);

        if (dirMatches.length === 1) ownerId = dirMatches[0].id;
      }
    }

    if (ownerId !== undefined) {
      saveIdentity(ownerId, { accid: item.accid, serverId: item.serverId, name: item.name });
    }
  }

  return buildAccidToOwnerMap(directory, follows);
}

/* 获取某个成员的 serverId（纯 HTTP / 缓存，不启动云信 SDK） */
async function resolveServerId(member: RoomMember): Promise<number | undefined> {
  const fromSaved: number | undefined = identities[member.ownerId]?.serverId;

  if (fromSaved !== undefined) return fromSaved;

  const fromDir: number | undefined = getMemberDirectory().byId[member.ownerId]?.serverId;

  if (fromDir !== undefined) return fromDir;

  const fromChannel: number | undefined = getChannel(member.ownerId)?.serverId;

  if (fromChannel !== undefined) return fromChannel;

  if (!getPocket48Token()) return undefined;

  const res: ServerJumpResult | undefined = await requestServerJump(member.ownerId);

  if (res?.content?.serverId && res.content.channelId) {
    setChannel(member.ownerId, res.content.serverId, res.content.channelId);

    return res.content.serverId;
  }

  return undefined;
}

/**
 * 本地解析某个成员的 accid 与 serverId（用于新增关注时 POST /roster）。
 * 仅使用缓存 / 公开名单，不在客户端启动云信 SDK；若名单暂未收录该新成员则返回 undefined。
 */
export async function resolveMemberIdentity(member: RoomMember): Promise<MemberIdentity | undefined> {
  const saved: MemberIdentity | undefined = identities[member.ownerId];

  if (saved?.accid) {
    if (saved.serverId === undefined) {
      const resolvedServerId: number | undefined = await resolveServerId(member).catch((): undefined => undefined);

      if (resolvedServerId !== undefined) saveIdentity(member.ownerId, { ...saved, serverId: resolvedServerId, name: member.name });
    }

    return identities[member.ownerId];
  }

  const directory: DirectoryState = getMemberDirectory();
  const dirItem: DirectoryMember | undefined = directory.byId[member.ownerId];

  if (dirItem?.account) {
    const info: MemberIdentity = { accid: dirItem.account, serverId: dirItem.serverId, name: member.name };

    saveIdentity(member.ownerId, info);

    return info;
  }

  return undefined;
}

/* 测试用 */
export function resetPresenceIdentityForTest(): void {
  identities = {};
}
