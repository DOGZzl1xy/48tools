import { draftPoints, isOwnTitle } from '../highlight/highlightDraft';
import type { ShowInfo, ShowItem, ShowKind } from '../highlight/highlightShow';

/**
 * 持续学习的「记录」：每一场切片留一份，记下 Gemini 第一轮给了什么、人最后怎么选的（纯计算，读写在 ./learnStore）。
 *   - 第一轮：每个爆点的标题、说明、关键的那句原话、分数、是不是推荐的
 *   - 人的选择：切了哪些；挑的时候改过的标题和说明；Gemini 给的几个标题里定了哪个，还是自己写的；看点留了哪些、改成了什么
 * 攒几天以后交给 Gemini 总结成一份背景文档（./learnTask），以后每次问它都附上。
 */
export interface RecordItem {
  start: number;
  end: number;
  kind?: string;           // 公演：mc / mistake / song
  score: number;
  recommended: boolean;
  picked: boolean;         // 选了切（写过字幕、做成了切片的都算）
  made: boolean;           // 做成了
  gemini: { title: string; reason: string; quote: string };  // 第一轮写的（改过的这里是改之前的）
  mine?: { title?: string; reason?: string };                // 挑的时候改成了什么
  titles?: { offered: Array<string>; chosen: string; own: boolean }; // 写字幕那一步给的几个标题、定的那个、是不是自己写的
  points?: { offered: Array<string>; final: Array<string> };          // 看点：给的和留下的
}

export interface ShowRecord {
  version: 1;
  liveId: string;
  kind: ShowKind;
  member: string;
  title: string;
  date: string;
  team?: string;
  status: ShowInfo['status'];
  savedAt: number;
  items: Array<RecordItem>;
}

function recordItem(item: ShowItem): RecordItem {
  const first: { title: string; reason: string } = item.original ?? { title: item.title, reason: item.reason };
  const mine: { title?: string; reason?: string } = {
    ...(item.title !== first.title ? { title: item.title } : {}),
    ...(item.reason !== first.reason ? { reason: item.reason } : {})
  };

  return {
    start: Math.round(item.start),
    end: Math.round(item.end),
    ...(item.kind ? { kind: item.kind } : {}),
    score: item.score,
    recommended: item.recommended,
    picked: item.cut || item.draft !== undefined || item.clip !== undefined,
    made: item.clip !== undefined,
    gemini: { title: first.title, reason: first.reason, quote: item.quote },
    ...(Object.keys(mine).length > 0 ? { mine } : {}),
    ...(item.draft ? {
      titles: { offered: item.draft.titles, chosen: item.draft.title, own: isOwnTitle(item.draft) },
      points: { offered: item.draft.points, final: draftPoints(item.draft) }
    } : {})
  };
}

export function toRecord(info: ShowInfo, now: number): ShowRecord {
  return {
    version: 1,
    liveId: info.liveId,
    kind: info.stage ? 'stage' : (info.radio ? 'radio' : 'live'),
    member: info.member,
    title: info.title,
    date: info.date,
    ...(info.stage ? { team: info.stage.team } : {}),
    status: info.status,
    savedAt: now,
    items: info.items.map(recordItem)
  };
}

/* 人做过决定没有：写过字幕（定标题那一步）或者做成过切片的才算；只是找完爆点、还没挑的不算 */
export function hasDecisions(record: ShowRecord): boolean {
  return record.items.some((item: RecordItem): boolean => item.titles !== undefined || item.made);
}

/* 存成的文件名：日期在前面，按名字排就是按时间排 */
export function recordFileName(record: Pick<ShowRecord, 'date' | 'kind' | 'liveId'>): string {
  return `${ record.date.replace(/[^\d]/g, '') }_${ record.kind }_${ record.liveId.replace(/[^\w-]/g, '_') }.json`;
}

const KIND_NAME: Record<ShowKind, string> = { live: '直播', radio: '电台', stage: '公演' };

function itemText(item: RecordItem): string {
  const parts: Array<string> = [
    `${ item.picked ? '切了' : '没切' }（${ item.score } 分${ item.recommended ? '，程序推荐' : '' }${ item.kind ? `，${ item.kind }` : '' }）`,
    `第一轮的标题「${ item.gemini.title }」`,
    `说明：${ item.gemini.reason }`
  ];

  if (item.gemini.quote) parts.push(`关键的一句：「${ item.gemini.quote }」`);

  if (item.mine?.title) parts.push(`剪辑者把标题改成了「${ item.mine.title }」`);

  if (item.mine?.reason) parts.push(`剪辑者把说明改成了：${ item.mine.reason }`);

  if (item.titles) {
    const others: Array<string> = item.titles.offered.filter((title: string): boolean => title !== item.titles!.chosen);

    parts.push(item.titles.own
      ? `定的标题是剪辑者自己写的「${ item.titles.chosen }」（没用给的：${ item.titles.offered.map((title: string): string => `「${ title }」`).join('') }）`
      : `定的标题是给的「${ item.titles.chosen }」${ others.length > 0 ? `（没选：${ others.map((title: string): string => `「${ title }」`).join('') }）` : '' }`);
  }

  if (item.points && item.points.final.join('|') !== item.points.offered.join('|')) {
    parts.push(`看点从「${ item.points.offered.join(' / ') }」改成了「${ item.points.final.join(' / ') || '（都删了）' }」`);
  }

  return `- ${ parts.join('；') }`;
}

/**
 * 几场记录写成给 Gemini 看的文字：新的在前，太长就只留前面的
 * @param { Array<ShowRecord> } records
 * @param { number } limit - 最多多少个字
 */
export function digestRecords(records: Array<ShowRecord>, limit: number = 14_000): string {
  const blocks: Array<string> = [];
  let length: number = 0;

  for (const record of [...records].sort((a: ShowRecord, b: ShowRecord): number => b.savedAt - a.savedAt)) {
    const block: string = [
      `【${ KIND_NAME[record.kind] }｜${ record.team ? `TEAM ${ record.team } ` : '' }${ record.member }｜${ record.date }｜${ record.title }】`,
      ...record.items.map(itemText)
    ].join('\n');

    if (blocks.length > 0 && length + block.length > limit) break;

    blocks.push(block);
    length += block.length;
  }

  return blocks.join('\n\n');
}
