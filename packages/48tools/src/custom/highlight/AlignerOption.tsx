import type { ReactElement } from 'react';
import { Button, Popconfirm, Progress, Space, Tag, Typography } from 'antd';
import Row from '../settings/SettingsRow';
import {
  useAlignerState, installAligner, cancelAlignerInstall, uninstallAligner, ALIGNER_DOWNLOAD_MB, ALIGNER_DISK_MB, type AlignerState
} from './alignerPlugin';

/**
 * 设置页面「录播切片」里的一行：本地打轴模型（可选）的安装 / 卸载。
 * 装的是什么、装在哪见 ./alignerPlugin。接入点：./HighlightOption。
 */
function AlignerOption(props: {}): ReactElement {
  const state: AlignerState = useAlignerState();

  return (
    <Row label="本地打轴模型（可选）"
      hint={ '给字幕定时间用。不装时字幕的时间由 Gemini 给（再用声音里的停顿和音节对一遍），偶尔会有几句对不准；'
        + '装了以后由本机的识别模型给每个字定时间，更准，每次结果都一样，音频也不会多发给任何人。'
        + `从 GitHub（k2-fsa/sherpa-onnx）下载约 ${ ALIGNER_DOWNLOAD_MB }MB，装好后占约 ${ ALIGNER_DISK_MB }MB，装在本机的用户文件夹里，随时可以卸载。` }
    >
      <Space direction="vertical" size={ 6 } className="w-full">
        <Space size={ 8 } wrap={ true }>
          <Tag className="mr-0" color={ state.installed ? 'success' : 'default' }>{ state.installed ? '已安装' : '未安装' }</Tag>
          {
            state.busy ? (
              state.installed ? null : <Button size="small" onClick={ cancelAlignerInstall }>取消</Button>
            ) : (
              state.installed ? (
                <Popconfirm title="卸载本地打轴模型？" description="会删掉下载的模型，之后切片改回由 Gemini 给时间。" onConfirm={ uninstallAligner }>
                  <Button size="small" danger={ true }>卸载</Button>
                </Popconfirm>
              ) : <Button size="small" type="primary" onClick={ installAligner }>安装（约 { ALIGNER_DOWNLOAD_MB }MB）</Button>
            )
          }
        </Space>
        { state.busy ? <Progress className="mb-0" percent={ Number(state.percent.toFixed(0)) } size="small" status="active" /> : null }
        { state.busy && state.detail ? <Typography.Text className="text-[12px]" type="secondary">{ state.detail }</Typography.Text> : null }
        { state.error ? <Typography.Text className="text-[12px]" type="danger">{ state.error }</Typography.Text> : null }
      </Space>
    </Row>
  );
}

export default AlignerOption;
