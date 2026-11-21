import { useEffect, type ReactElement } from 'react';
import { Button, Popconfirm, Progress, Space, Tag, Typography } from 'antd';
import Row from '../settings/SettingsRow';
import {
  useAlignerState, installAligner, cancelAlignerInstall, uninstallAligner, refreshAlignerInstalled, ALIGNER_DOWNLOAD_MB, type AlignerState
} from './alignerPlugin';

/**
 * 设置页面「录播切片」里的一行：本地打轴模型（可选）的安装 / 卸载。
 * 装的是什么、装在哪见 ./alignerPlugin。接入点：./HighlightOption。
 */
function AlignerOption(props: {}): ReactElement {
  const state: AlignerState = useAlignerState();

  // 每次打开设置页都重新看一眼装没装
  useEffect(function(): void {
    refreshAlignerInstalled();
  }, []);

  return (
    <Row label="本地打轴模型（可选）">
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
