import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parse, type ParsedPath } from 'node:path';
import * as process from 'node:process';
import { requestLiveRoomInfo } from '@48tools-api/48';
import { setPocket48ProxyForWorker } from '../../../../../custom/pocket48Proxy/pocket48Proxy';
import { LiveReconnect, pushCapped } from '../../../../../custom/live/liveReconnect';
import type { _UtilObject } from '../../../../../../../main/src/logProtocol/logTemplate/ffmpeg.mjs';
import { _ffmpegLogProtocol } from '../../../../../utils/logProtocol/logActions';

const isMacOS: boolean = process.platform === 'darwin';
let _stdout: Array<string> = [];

/**
 * ffmpeg下载线程
 */
export type WorkerEventData = {
  type: 'start' | 'stop'; // 执行的方法
  playStreamPath: string; // 媒体地址
  filePath: string;       // 文件保存地址
  ffmpeg: string;         // ffmpeg地址
  liveId: string;         // 播放ID
  roomId: string;         // 直播房间地址
  pocket48Proxy?: string; // 口袋48接口代理地址（worker 里没有 localStorage，由主线程传入）
};

export interface ErrorMessageEventData {
  type: 'error';
  error: Error;
}

export interface CloseMessageEventData {
  type: 'close';
}

export type MessageEventData = ErrorMessageEventData | CloseMessageEventData;

let child: ChildProcessWithoutNullStreams;
let isKilled: boolean = false; // 手动结束
let retryIndex: number = 0;
let reconnect: LiveReconnect | undefined; // 断线重连（custom/live/liveReconnect）

function formatCommend(t: string): string {
  return isMacOS ? `"${ t }"` : t;
}

/* 下载 */
function download(workerData: WorkerEventData, isRetry?: boolean): void {
  const { ffmpeg, playStreamPath, filePath }: WorkerEventData = workerData;
  let filePath2: string = filePath;

  if (isRetry) {
    const parseResult: ParsedPath = parse(filePath);

    filePath2 = `${ parseResult.dir }/${ parseResult.name }(${ retryIndex })${ parseResult.ext }`;
  }

  const ffmpegArgs: Array<string> = [
    '-rw_timeout',
    `${ (1_000 ** 2) * 60 * 5 }`,
    '-i',
    formatCommend(playStreamPath),
    '-c',
    'copy',
    formatCommend(filePath2)
  ];

  child = spawn(formatCommend(ffmpeg), ffmpegArgs, { shell: isMacOS });
  reconnect ??= new LiveReconnect({
    liveId: workerData.liveId,
    getUrl: (): string => workerData.playStreamPath,
    requestInfo: requestLiveRoomInfo,
    restart(url: string): void {
      download(Object.assign(workerData, { playStreamPath: url }), true);
    },
    close: (): void => postMessage({ type: 'close' }),
    isKilled: (): boolean => isKilled
  });
  reconnect.markStart();

  child.stdout.on('data', function(data: Buffer): void {
    // console.log(data.toString());
    pushCapped(_stdout, data.toString());
  });

  child.stderr.on('data', function(data: Buffer): void {
    // console.log(data.toString());
    pushCapped(_stdout, data.toString());
  });

  child.on('close', function(...args: string[]): void {
    _ffmpegLogProtocol.post<_UtilObject>('util', {
      ffmpeg,
      input: playStreamPath,
      output: filePath,
      cmd: ffmpegArgs,
      stdout: _stdout.join('\n')
    });
    _stdout = [];

    if (isKilled) {
      postMessage({ type: 'close' });
    } else {
      retryIndex++;
      reconnect!.handleClose(); // 断线重连，或者确认直播结束后发 close
    }
  });

  child.on('error', function(err: Error): void {
    postMessage({ type: 'error', error: err });
  });
}

/* 停止下载 */
function stop(): void {
  isKilled = true;
  child?.kill?.('SIGTERM');
}

addEventListener('message', function(event: MessageEvent<WorkerEventData>): void {
  switch (event.data.type) {
    case 'start':
      setPocket48ProxyForWorker(event.data.pocket48Proxy);
      download(event.data);
      break;

    case 'stop':
      stop();
      break;
  }
});