import { useSyncExternalStore } from 'react';
import { requestRoomId, type RoomIdObj, type RoomItem } from '@48tools-api/48/jsdelivrCDN';
import { readJson, writeJson } from '../common/util';
import { teamLabel, type DirectoryMember } from './memberSearch';

/**
 * 成员名单：每个成员的队伍、所属团、拼音。用来在房间里显示成员是哪个队的（沈馨 → NII），以及按拼音、ID、队伍搜索成员。
 * 数据是原版就在用的那份公开名单（services/48/jsdelivrCDN 的 roomId.json，录播下载页的搜索也用它），
 * 取到后存在本机（localStorage 的 ROOM_MEMBER_DIRECTORY），一天更新一次；取不到时用本机存的，都没有就不显示队伍。
 * 请求里不带任何账号信息。
 */
interface SavedDirectory {
  fetchedAt: number;
  members: Array<DirectoryMember>;
}

export interface DirectoryState {
  members: Array<DirectoryMember>;
  byId: Record<number, DirectoryMember>;
}

const STORAGE_KEY: string = 'ROOM_MEMBER_DIRECTORY';
const REFRESH_AFTER: number = 24 * 3_600_000;
const listeners: Set<() => void> = new Set();
let fetchedAt: number = 0;
let loading: boolean = false;
let state: DirectoryState = { members: [], byId: {} };

function setMembers(members: Array<DirectoryMember>): void {
  const byId: Record<number, DirectoryMember> = {};

  for (const member of members) byId[member.id] = member;

  state = { members, byId };

  for (const listener of listeners) listener();
}

function fromSaved(): void {
  const saved: SavedDirectory | null = readJson<SavedDirectory | null>(STORAGE_KEY, null);

  if (!saved || !Array.isArray(saved.members)) return;

  fetchedAt = Number(saved.fetchedAt) || 0;
  setMembers(saved.members.filter((item: DirectoryMember): boolean => typeof item?.id === 'number' && typeof item.name === 'string'));
}

if (typeof localStorage !== 'undefined') fromSaved();

/* 需要时更新名单（一天一次）；页面打开时调用，多次调用没关系 */
export async function loadMemberDirectory(): Promise<void> {
  if (loading || (state.members.length > 0 && Date.now() - fetchedAt < REFRESH_AFTER)) return;

  loading = true;

  try {
    const res: RoomIdObj | null = await requestRoomId();
    const members: Array<DirectoryMember> = (res?.roomId ?? [])
      .filter((item: RoomItem): boolean => typeof item.id === 'number' && typeof item.ownerName === 'string')
      .map((item: RoomItem): DirectoryMember => ({
        id: item.id,
        name: item.ownerName,
        team: item.team,
        group: item.groupName,
        pinyin: item.pinyin
      }));

    if (members.length > 0) {
      fetchedAt = Date.now();
      writeJson(STORAGE_KEY, { fetchedAt, members } satisfies SavedDirectory);
      setMembers(members);
    }
  } catch (err) {
    console.error('成员名单更新失败', err);
  }

  loading = false;
}

export function getMemberDirectory(): DirectoryState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

export function useMemberDirectory(): DirectoryState {
  return useSyncExternalStore(subscribe, getMemberDirectory);
}

function teamOfMember(member: DirectoryMember | undefined): { label: string; title: string } | undefined {
  const label: string = teamLabel(member?.team);

  if (!member || !label) return undefined;

  return { label, title: member.group && member.group !== member.team ? `${ member.group } ${ member.team }` : label };
}

/* 界面上显示的队伍：短写法和完整说明（鼠标放上去时显示）；名单里没有这个成员时是 undefined */
export function teamOf(directory: DirectoryState, ownerId: number): { label: string; title: string } | undefined {
  return teamOfMember(directory.byId[ownerId]);
}

/* 只知道名字时（切片的清单里只有名字）；同名的不止一个人时不猜 */
export function teamOfName(directory: DirectoryState, name: string): { label: string; title: string } | undefined {
  const same: Array<DirectoryMember> = directory.members.filter((member: DirectoryMember): boolean => member.name === name);

  return same.length === 1 ? teamOfMember(same[0]) : undefined;
}
