'use idle';

import { promises as fsP } from 'node:fs';
import type { SaveDialogReturnValue } from 'electron';
import {
  Fragment, useEffect, useMemo, useState, useTransition,
  type ReactElement, type ReactNode, type MouseEvent, type TransitionStartFunction, type Dispatch as D, type SetStateAction as S
} from 'react';
import { useSelector, useDispatch } from 'react-redux';
import type { Dispatch } from '@reduxjs/toolkit';
import { createStructuredSelector, type Selector } from 'reselect';
import { Select, Button, Table, message, Space, Popconfirm, type TablePaginationConfig } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DefaultOptionType } from 'rc-select/es/Select';
import type { UseMessageReturnType } from '@48tools-types/antd';
import {
  requestDownloadFile,
  requestOpenLiveList,
  requestLiveOne,
  type OpenLiveList,
  type OpenLiveInfo,
  type LiveOne,
  type LiveOnePlayStreams
} from '@48tools-api/48';
import { showSaveDialog } from '../../../../utils/remote/dialog';
import getFFmpegDownloadWorker from '../../../../utils/worker/FFmpegDownload.worker/getFFmpegDownloadWorker';
import Header from '../../../../components/Header/Header';
import {
  setVideoListChildAdd,
  setVideoListChildDelete,
  setDownloadProgress,
  setInVideoQueryLiveType,
  setInVideoGroupList,
  type Live48InitialState
} from '../../reducers/live48';
import { getFFmpeg, getFilePath } from '../../../../utils/utils';
import { proxyServerInit } from '../../../../utils/proxyServer/proxyServer';
import { ProgressNative, type ProgressSet } from '../../../../components/ProgressNative/index';
import { formatTsUrl, getTeamId } from '../utils/utils';
import type { WebWorkerChildItem } from '../../../../commonTypes';
import type { MessageEventData } from '../../../../utils/worker/FFmpegDownload.worker/FFmpegDownload.worker';
import { useAutoLoadMore } from '../../../../custom/table/useAutoLoadMore';
import { queueTaskStart, queueTaskProgress, queueTaskEnd } from '../../../../custom/downloadQueue/downloadQueue';
import { startInSlot, cancelWaitingInSlot } from '../../../../custom/downloadQueue/slotTasks';
import { formatProgressDetail } from '../../../../custom/download/formatProgress';
import { startStageReplayHighlight, stageReplayTeam } from '../../../../custom/bilibili/gongyanReplay';
import { showTime } from '../../../../custom/time/appTime'; // 按设置里的时区

/* 公演录播下载在下载队列里的 id；点了停止的记在 inVideoStopping 里（worker 停止和正常结束发的是同一种消息） */
function inVideoTaskId(liveId: string): string {
  return `invideo:${ liveId }`;
}

const inVideoStopping: Set<string> = new Set();

const liveTypeSelectOptions: Array<DefaultOptionType> = ['SNH48', 'BEJ48', 'GNZ48', 'CKG48', 'CGT48']
  .map((o: string): DefaultOptionType => ({ label: o, value: o.toLowerCase() }));

/* redux selector */
type RSelector = Pick<Live48InitialState,
  'videoListChild' | 'progress' | 'inVideoQueryLiveType'
  | 'snh48NextPage' | 'bej48NextPage' | 'gnz48NextPage' | 'ckg48NextPage' | 'cgt48NextPage'
  | 'snh48InVideoList' | 'bej48InVideoList' | 'gnz48InVideoList' | 'ckg48InVideoList' | 'cgt48InVideoList'
>;
type RState = { live48: Live48InitialState };

const selector: Selector<RState, RSelector> = createStructuredSelector({
  // 正在下载
  videoListChild: ({ live48 }: RState): Array<WebWorkerChildItem> => live48.videoListChild,

  // 进度条列表
  progress: ({ live48 }: RState): Record<string, ProgressSet> => live48.progress,

  // LiveType
  inVideoQueryLiveType: ({ live48 }: RState): string | undefined => live48.inVideoQueryLiveType,

  snh48NextPage: ({ live48 }: RState): number => live48.snh48NextPage,
  bej48NextPage: ({ live48 }: RState): number => live48.bej48NextPage,
  gnz48NextPage: ({ live48 }: RState): number => live48.gnz48NextPage,
  ckg48NextPage: ({ live48 }: RState): number => live48.ckg48NextPage,
  cgt48NextPage: ({ live48 }: RState): number => live48.cgt48NextPage,

  snh48InVideoList: ({ live48 }: RState): Array<OpenLiveInfo> => live48.snh48InVideoList,
  bej48InVideoList: ({ live48 }: RState): Array<OpenLiveInfo> => live48.bej48InVideoList,
  gnz48InVideoList: ({ live48 }: RState): Array<OpenLiveInfo> => live48.gnz48InVideoList,
  ckg48InVideoList: ({ live48 }: RState): Array<OpenLiveInfo> => live48.ckg48InVideoList,
  cgt48InVideoList: ({ live48 }: RState): Array<OpenLiveInfo> => live48.cgt48InVideoList
});

/* 录播下载 */
function InVideo(props: {}): ReactElement {
  const rSelector: RSelector = useSelector(selector);
  const {
    videoListChild, progress, inVideoQueryLiveType,
    snh48InVideoList, bej48InVideoList, gnz48InVideoList, ckg48InVideoList, cgt48InVideoList
  }: RSelector = rSelector;
  const dispatch: Dispatch = useDispatch();
  const [messageApi, messageContextHolder]: UseMessageReturnType = message.useMessage();
  const [getLiveListLoading, startGetLiveListStartTransition]: [boolean, TransitionStartFunction] = useTransition();
  // 翻到最后一页自动加载下一页（custom/table/useAutoLoadMore）：noMore 是接口已经取不到更多了，refreshCount 每刷新一次加一（回到第一页）
  const [noMore, setNoMore]: [boolean, D<S<boolean>>] = useState(false);
  const [refreshCount, setRefreshCount]: [number, D<S<number>>] = useState(0);

  const inVideoList: Array<OpenLiveInfo> = useMemo(function(): Array<OpenLiveInfo> {
    if (inVideoQueryLiveType) return rSelector[`${ inVideoQueryLiveType }InVideoList`];

    return [];
  }, [rSelector, inVideoQueryLiveType,
    snh48InVideoList, bej48InVideoList, gnz48InVideoList, ckg48InVideoList, cgt48InVideoList]);

  // 停止下载
  function handleStopClick(record: OpenLiveInfo, event?: MouseEvent): void {
    const index: number = videoListChild.findIndex(
      (o: WebWorkerChildItem): boolean => o.id === record.liveId);

    if (index >= 0) {
      if (cancelWaitingInSlot(inVideoTaskId(record.liveId))) return; // 还在排队：不排了

      inVideoStopping.add(record.liveId);
      videoListChild[index].worker.postMessage({ type: 'stop' });
    }
  }

  // 公演切片：用口袋48 的公演录播（custom/bilibili/gongyanReplay），先在下载队列里排队下载，再切
  function handleStageHighlightClick(record: OpenLiveInfo, event: MouseEvent): void {
    const reason: string | undefined = startStageReplayHighlight(record);

    if (reason) {
      messageApi.warning(reason);
    } else {
      messageApi.success('加到下载队列了：先下载公演录播，再找爆点，找完在「切片」页面挑（口袋48 的公演录播没有弹幕）');
    }
  }

  // 开始下载
  async function handleDownloadClick(record: OpenLiveInfo, event: MouseEvent): Promise<void> {
    try {
      const resLiveOne: LiveOne = await requestLiveOne(record.liveId);
      const playStream: Array<LiveOnePlayStreams> = resLiveOne?.content?.playStreams ?? [];

      if (!playStream.length) {
        messageApi.warning('视频不存在！');

        return;
      }

      const playStreamItem: LiveOnePlayStreams | undefined = playStream
        .filter((o: LiveOnePlayStreams): boolean => !!o.streamPath)
        .at(-1);

      if (!(playStreamItem?.streamPath)) {
        messageApi.warning('视频不存在！');

        return;
      }

      const result: SaveDialogReturnValue = await showSaveDialog({
        defaultPath: getFilePath({
          typeTitle: '48公演录播',
          infoArray: [record.title, record.liveId],
          ext: 'ts'
        })
      });

      if (result.canceled || !result.filePath) return;

      const m3u8File: string = `${ result.filePath }.m3u8`;
      const m3u8Data: string = await requestDownloadFile(playStreamItem.streamPath);
      const [m3u8UrlF]: [string, Array<string>] = formatTsUrl(m3u8Data, playStreamItem.streamPath);

      await fsP.writeFile(m3u8File, m3u8UrlF);

      const worker: Worker = getFFmpegDownloadWorker();
      const queueId: string = inVideoTaskId(record.liveId);
      let releaseSlot: () => void = (): void => undefined; // 下完让给下一场（custom/downloadQueue/slotTasks）

      worker.addEventListener('message', function(workerEvent: MessageEvent<MessageEventData>) {
        const { type }: MessageEventData = workerEvent.data;

        if (workerEvent.data.type === 'progress') {
          dispatch(setDownloadProgress(workerEvent.data));
          queueTaskProgress(queueId, workerEvent.data.data, formatProgressDetail(workerEvent.data));
        }

        if (type === 'close' || type === 'error') {
          if (type === 'error') {
            messageApi.error(`视频：${ record.title } 下载失败！`);
            queueTaskEnd(queueId, 'error', '下载失败');
          } else {
            queueTaskEnd(queueId, inVideoStopping.has(record.liveId) ? 'stopped' : 'done');
          }

          inVideoStopping.delete(record.liveId);
          releaseSlot();
          worker.terminate();
          dispatch(setVideoListChildDelete(record));
        }
      }, false);

      // 登记到下载队列，和别的录播下载排队，轮到了才开始（同一时间只下一场）
      queueTaskStart({
        id: queueId,
        title: record.title,
        kind: '公演录播',
        filePath: result.filePath,
        percent: 0,
        detail: '准备中…',
        stop: (): void => {
          if (cancelWaitingInSlot(queueId)) return; // 还在排队：不排了

          inVideoStopping.add(record.liveId);
          worker.postMessage({ type: 'stop' });
        }
      });
      releaseSlot = startInSlot(queueId, (): void => {
        worker.postMessage({
          type: 'start',
          playStreamPath: m3u8File,
          filePath: result.filePath,
          ffmpeg: getFFmpeg(),
          protocolWhitelist: true,
          qid: record.liveId
        });
      }, (): void => {
        // 排队时点了停止：还没开始下
        queueTaskEnd(queueId, 'stopped', undefined, '已停止（还没开始下）');
        fsP.rm(m3u8File, { force: true }).catch((): void => undefined);
        worker.terminate();
        dispatch(setVideoListChildDelete(record));
      });

      dispatch(setVideoListChildAdd({
        id: record.liveId,
        worker
      }));
    } catch (err) {
      console.error(err);
      messageApi.error('下载失败！');
    }
  }

  // 刷新录播
  function handleGetVideoListClick(liveType: string | undefined = inVideoQueryLiveType): void {
    if (!liveType) return;

    startGetLiveListStartTransition(async (): Promise<void> => {
      try {
        const res: OpenLiveList = await requestOpenLiveList({
          groupId: getTeamId(liveType),
          record: true
        });

        if (res?.content?.liveList) {
          setNoMore(res.content.liveList.length === 0);
          setRefreshCount((count: number): number => count + 1);
          dispatch(setInVideoGroupList({
            liveType,
            data: res.content.liveList,
            nextPage: Number(res.content.next)
          }));
        } else {
          messageApi.error('录播加载失败！');
        }
      } catch (err) {
        console.error(err);
        messageApi.error('录播加载失败！');
      }
    });
  }

  // 选了队伍：马上加载这个队伍的录播（以前选完还要再点「刷新录播」，进来时页面是空的，不知道要先选队伍）
  function handleLiveTypeSelect(value: string): void {
    dispatch(setInVideoQueryLiveType(value));
    handleGetVideoListClick(value);
  }

  // 加载下一页（翻到最后一页时自动调用，custom/table/useAutoLoadMore）
  function handleGetNextPageVideoListClick(): void {
    if (!inVideoQueryLiveType) return;

    startGetLiveListStartTransition(async (): Promise<void> => {
      try {
        const res: OpenLiveList = await requestOpenLiveList({
          groupId: getTeamId(inVideoQueryLiveType),
          record: true,
          next: rSelector[`${ inVideoQueryLiveType }NextPage`]
        });

        if (res?.content?.liveList) {
          res.content.liveList.length === 0 && setNoMore(true);
          dispatch(setInVideoGroupList({
            liveType: inVideoQueryLiveType,
            data: inVideoList.concat(res.content.liveList),
            nextPage: Number(res.content.next)
          }));
        } else {
          messageApi.error('录播加载失败！需要登录账号！');
        }
      } catch (err) {
        console.error(err);
        messageApi.error('录播加载失败！');
      }
    });
  }

  const pagination: TablePaginationConfig = useAutoLoadMore({
    loaded: inVideoList.length,
    loading: getLiveListLoading,
    noMore,
    onLoadMore: handleGetNextPageVideoListClick,
    resetKey: `${ inVideoQueryLiveType }-${ refreshCount }`
  });

  const columns: ColumnsType<OpenLiveInfo> = [
    { title: '标题', dataIndex: 'title' },
    { title: '副标题', dataIndex: 'subTitle' },
    {
      title: '下载进度',
      dataIndex: 'liveId',
      width: 100,
      render: (value: string, record: OpenLiveInfo, index: number): ReactNode => {
        const inDownload: boolean = Object.hasOwn(progress, value);
        const idx: number = videoListChild.findIndex(
          (o: WebWorkerChildItem): boolean => o.id === record.liveId);

        if (inDownload) {
          return <ProgressNative progressSet={ progress[value] } />;
        } else {
          return idx >= 0 ? '准备中' : '未下载';
        }
      }
    },
    {
      title: '时间',
      dataIndex: 'stime',
      width: 165,
      render: (value: string, record: OpenLiveInfo, index: number): string => {
        return showTime(value);
      }
    },
    {
      title: '操作',
      key: 'handle',
      width: 200,
      render: (value: undefined, record: OpenLiveInfo, index: number): ReactElement => {
        const idx: number = videoListChild.findIndex(
          (o: WebWorkerChildItem): boolean => o.id === record.liveId);

        return (
          <Space size={ 8 }>
            { idx >= 0 ? (
              <Popconfirm title="确定要停止下载吗？"
                onConfirm={ (event?: MouseEvent): void => handleStopClick(record, event) }
              >
                <Button type="primary" danger={ true }>停止下载</Button>
              </Popconfirm>
            ) : (
              <Button onClick={ (event: MouseEvent): Promise<void> => handleDownloadClick(record, event) }>
                下载
              </Button>
            ) }
            { stageReplayTeam(record) ? (
              <Button onClick={ (event: MouseEvent): void => handleStageHighlightClick(record, event) }>公演切片</Button>
            ) : null }
          </Space>
        );
      }
    }
  ];

  useEffect(function(): void {
    proxyServerInit();
  }, []);

  return (
    <Fragment>
      <Header>
        <Space size={ 8 } data-test-id="48-in-video-group-type">
          <Select className="!w-[150px]"
            options={ liveTypeSelectOptions }
            value={ inVideoQueryLiveType }
            placeholder="先选择队伍"
            status={ inVideoQueryLiveType === undefined ? 'warning' : undefined }
            onSelect={ handleLiveTypeSelect }
          />
          <Button disabled={ inVideoQueryLiveType === undefined } onClick={ (): void => handleGetVideoListClick() }>刷新</Button>
        </Space>
      </Header>
      <Table size="middle"
        columns={ columns }
        dataSource={ inVideoList }
        bordered={ true }
        loading={ getLiveListLoading }
        rowKey="liveId"
        locale={ inVideoQueryLiveType === undefined ? { emptyText: '先在右上角选择队伍，选好后会自动加载录播' } : undefined }
        pagination={ pagination }
      />
      { messageContextHolder }
    </Fragment>
  );
}

export default InVideo;