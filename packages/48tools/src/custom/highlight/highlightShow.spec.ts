/**
 * 一场的爆点清单：推荐的默认切、改标题和说明、编号、做完以后怎么记、切片说明怎么写。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  editItem, highlightOf, isRestyled, newShowInfo, nextStatus, planCuts, readShowInfo, readShowInfoSync, readyToRender, showText, stillWaiting, withDraft, withResult,
  writeShowInfo, type ShowClip, type ShowInfo, type ShowItem
} from './highlightShow';
import { recommend } from './highlightPipeline';
import type { ClipDraft, Highlight } from './highlightTypes';

const job: { liveId: string; member: string; title: string; date: string } = { liveId: '123', member: 'SNH48 成员甲', title: '测试', date: '2026.11.23' };

function found(title: string, start: number, score: number = 8, patch: Partial<Highlight> = {}): Highlight {
  return { start, end: start + 80, title, cover: `${ title }的封面`, quote: '', reason: `${ title }的说明`, score, ...patch };
}

function infoOf(items: Array<Highlight>, recommended: Array<number>, old?: ShowInfo): ShowInfo {
  return newShowInfo(job, { model: 'test-model', duration: 1_000, summaries: ['聊天'], notes: [], items, recommended: new Set(recommended) }, old);
}

function clip(index: number, start: number): ShowClip {
  return { index, title: `第${ index }个`, postTitle: `【成员甲】第${ index }个 | 20261123 直播切片`, otherTitles: ['【成员甲】备选'], description: '简介。', start, end: start + 70, duration: 66, score: 8 };
}

const draft: ClipDraft = {
  key: '100', basis: '', start: 85, length: 120, lines: [], timing: '', titles: ['Gemini 的'], more: [], description: '', points: ['亮点'], people: [], frames: [1], title: 'Gemini 的', frame: 0
};

describe('找完爆点的清单', (): void => {
  test('推荐的默认切，别的默认不切，等人挑；一个都没找到就不用等', (): void => {
    const info: ShowInfo = infoOf([found('一', 100), found('二', 300), found('三', 500)], [0, 2]);

    expect(info.status).toBe('waiting');
    expect(info.items.map((item: ShowItem): string => `${ item.title } ${ item.recommended } ${ item.cut }`)).toEqual(['一 true true', '二 false false', '三 true true']);
    expect(infoOf([], []).status).toBe('done');
  });

  test('重新找一遍：以前做好的切片接过来，不再默认切', (): void => {
    const old: ShowInfo = withResult(infoOf([found('一', 100)], [0]), found('一', 100), clip(1, 105));
    const again: ShowInfo = infoOf([found('换了个说法', 95), found('新的', 400)], [0, 1], old);

    expect(again.items.map((item: ShowItem): string => `${ item.title } ${ item.cut } ${ item.clip?.index ?? '-' }`)).toEqual(['换了个说法 false 1', '新的 true -']);
  });

  test('推荐哪几个：按分数；公演 MC、唱歌、失误各算各的名额', (): void => {
    const list: Array<Highlight> = [found('甲', 0, 9), found('乙', 200, 8.5), found('丙', 400, 8)];

    expect(Array.from(recommend({ count: 'auto' }, list, 3_600))).toEqual([0, 1]);
    expect(Array.from(recommend({ count: 1 }, list, 3_600))).toEqual([0]);
    expect(Array.from(recommend({ count: 'auto', autoScore: 8 }, list, 3_600))).toEqual([0, 1, 2]);

    const stage: Array<Highlight> = [
      found('歌一', 0, 9.5, { kind: 'song' }), found('歌二', 300, 9, { kind: 'song' }), found('歌三', 600, 9, { kind: 'song' }), found('话题', 900, 8, { kind: 'mc' })
    ];

    expect(Array.from(recommend({ count: 'auto', stage: { team: 'NII', teamColor: '#af83bb', show: '测试', date: '' } }, stage, 3_600))).toEqual([0, 1, 3]);
  });
});

describe('改标题和说明', (): void => {
  const item: ShowItem = infoOf([found('原来的', 100, 8)], [0]).items[0];

  test('改了记着原来的；改回去就不算改过；清空、只差空格不改', (): void => {
    const edited: ShowItem = editItem(item, { title: ' 新标题 ' });

    expect(edited).toMatchObject({ title: '新标题', reason: '原来的的说明', edited: true, original: { title: '原来的', reason: '原来的的说明' } });

    const twice: ShowItem = editItem(edited, { reason: '新说明' });

    expect(twice).toMatchObject({ title: '新标题', reason: '新说明', original: { title: '原来的', reason: '原来的的说明' } });
    expect(editItem(twice, twice.original!)).toEqual(item);
    expect(editItem(item, { title: '  ', reason: '原来的的说明 ' })).toBe(item);
  });

  test('交给切片流程时：带上改过的标记；改了标题就照改过的写；清单自己的字段不带', (): void => {
    expect(highlightOf(item)).toEqual(found('原来的', 100, 8));

    const reasonOnly: Highlight = highlightOf(editItem(item, { reason: '新说明' }));
    const titled: Highlight = highlightOf(editItem(item, { title: '新标题' }));

    expect(reasonOnly).toMatchObject({ reason: '新说明', edited: true });
    expect(titled).toMatchObject({ title: '新标题', edited: true, cover: '', coverTitle: '新标题' }); // 封面用改过的标题
    expect(reasonOnly.coverTitle).toBeUndefined(); // 只改说明：封面还是 Gemini 的
    expect(Object.keys(titled)).not.toEqual(expect.arrayContaining(['cut', 'recommended', 'original']));
  });
});

describe('切', (): void => {
  test('新切的接着编号（看清单，也看文件夹里的）；重切的用原来的编号', (): void => {
    let info: ShowInfo = withResult(infoOf([found('一', 100), found('二', 300), found('三', 500)], [0, 1]), found('一', 100), clip(2, 105));

    info = { ...info, items: info.items.map((item: ShowItem): ShowItem => ({ ...item, cut: true })) };

    expect(planCuts(info, []).map(({ item, index }: { item: ShowItem; index: number }): string => `${ item.title }${ index }`)).toEqual(['一2', '二3', '三4']);
    expect(planCuts(info, ['05-别的.mp4', '09-封面.jpg']).map(({ index }: { index: number }): number => index)).toEqual([2, 6, 7]);
  });

  test('做完记上切片（不记文件路径），没做成记上原因；都不再是要切的', (): void => {
    const info: ShowInfo = infoOf([found('一', 100), found('二', 300)], [0, 1]);
    const failed: ShowInfo = withResult(info, found('二', 300), '剪完太短');
    const made: ShowInfo = withResult(failed, found('一', 100), { ...clip(1, 105), video: 'C:/不要记.mp4' } as ShowClip);

    expect(made.items.map((item: ShowItem): string => `${ item.cut } ${ item.clip?.index ?? '-' } ${ item.problem ?? '-' }`)).toEqual(['false 1 -', 'false - 剪完太短']);
    expect(made.items[0].clip).toEqual(clip(1, 105));
    expect(withResult(made, found('二', 300), clip(2, 300)).items[1].problem).toBeUndefined();
  });
});

describe('写好了等人定标题', (): void => {
  test('写好的记上草稿、还是要切的；没写成的不切了，记上原因', (): void => {
    const info: ShowInfo = withDraft(withDraft(infoOf([found('一', 100), found('二', 300)], [0, 1]), found('一', 100), draft), found('二', 300), '剪完太短');

    expect(info.items.map((item: ShowItem): string => `${ item.cut } ${ item.draft?.title ?? '-' } ${ item.problem ?? '-' }`)).toEqual(['true Gemini 的 -', 'false - 剪完太短']);
    expect(Object.keys(highlightOf(info.items[0]))).not.toContain('draft');
  });

  test('这一场的状态：有等着定的、还有没写的、都好了', (): void => {
    const info: ShowInfo = infoOf([found('一', 100), found('二', 300)], [0, 1]);
    const written: ShowInfo = withDraft(info, found('一', 100), draft);
    const made: ShowInfo = withResult(written, found('一', 100), clip(1, 105));

    expect(nextStatus(info)).toBe('waiting');
    expect(nextStatus(written)).toBe('naming');
    expect(nextStatus({ ...made, status: 'naming' })).toBe('waiting');                // 第二个还没写
    expect(nextStatus(withResult(made, found('二', 300), '剪完太短'))).toBe('done');
    expect(nextStatus({ ...made, status: 'done' })).toBe('done');                     // 切完以后又选了一个，还没点写标题：不算在等
  });

  test('改了选哪些：写好的都不选了就退回等着挑，选回来又是等着定；已经好了的不变', (): void => {
    const info: ShowInfo = { ...withDraft(infoOf([found('一', 100), found('二', 300)], [0]), found('一', 100), draft), status: 'naming' };
    const off: ShowInfo = stillWaiting({ ...info, items: info.items.map((item: ShowItem): ShowItem => ({ ...item, cut: false })) });

    expect(off.status).toBe('waiting');
    expect(stillWaiting({ ...off, items: info.items }).status).toBe('naming');
    expect(stillWaiting({ ...info, status: 'done' }).status).toBe('done');
  });

  test('编号：只渲染一部分时，没写好的不占号', (): void => {
    const info: ShowInfo = withDraft(infoOf([found('一', 100), found('二', 300)], [0, 1]), found('二', 300), draft);

    expect(planCuts(info, [], readyToRender).map(({ item, index }: { item: ShowItem; index: number }): string => `${ item.title }${ index }`)).toEqual(['二1']);
    expect(planCuts(info, []).map(({ index }: { index: number }): number => index)).toEqual([1, 2]);
  });

  test('渲染完草稿留着，改了标题就是「还没重做」；重新找一遍时草稿跟着做好的切片走', (): void => {
    const made: ShowInfo = withResult(withDraft(infoOf([found('一', 100)], [0]), found('一', 100), draft), found('一', 100), clip(1, 105));

    expect(isRestyled(made.items[0])).toBe(false);
    expect(isRestyled({ ...made.items[0], draft: { ...draft, title: '换了' } })).toBe(true);
    expect(isRestyled(infoOf([found('一', 100)], [0]).items[0])).toBe(false);

    const again: ShowInfo = infoOf([found('换了个说法', 95), found('新的', 400)], [0, 1], made);

    expect(again.items.map((item: ShowItem): string => item.draft?.key ?? '-')).toEqual(['100', '-']);
  });
});

describe('存到文件夹里', (): void => {
  test('存清单时一起写切片说明；没有、以前的格式、写坏了时读出来是 undefined', async (): Promise<void> => {
    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'show-'));

    try {
      expect(await readShowInfo(dir)).toBeUndefined();

      const info: ShowInfo = withResult(infoOf([found('一', 100), found('二', 300)], [0]), found('一', 100), clip(1, 105));

      await writeShowInfo(dir, info);
      expect(await readShowInfo(dir)).toEqual(info);
      expect(readShowInfoSync(dir)).toEqual(info);
      expect(fs.readFileSync(path.join(dir, '切片说明.txt'), 'utf8')).toBe(showText(info));

      for (const bad of ['{"version":1,"items":[]}', '{坏了']) {
        fs.writeFileSync(path.join(dir, '爆点.json'), bad);
        expect(await readShowInfo(dir)).toBeUndefined();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('切片说明：做好的按编号排，没切的列在后面，没做成的写原因', (): void => {
    let info: ShowInfo = infoOf([found('一', 100), found('二', 300), found('三', 500), found('四', 700)], []);

    info = withResult(withResult(withResult(info, found('三', 500), clip(2, 505)), found('一', 100), clip(1, 105)), found('四', 700), '剪完太短');

    const text: string = showText(info);

    expect(text).toContain('找到 4 个爆点，做了 2 个切片');
    expect(text.indexOf('01. 【成员甲】第1个')).toBeLessThan(text.indexOf('02. 【成员甲】第2个'));
    expect(text).toContain('    备选：【成员甲】备选');
    expect(text).toContain('没切的爆点：\r\n    05:00 ~ 06:20 二（8 分）二的说明\r\n    11:40 ~ 13:00 四（8 分）四的说明（没做成：剪完太短）');
  });
});
