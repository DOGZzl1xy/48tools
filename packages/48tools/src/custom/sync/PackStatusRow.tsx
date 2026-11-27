import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { Button, Space, Typography } from 'antd';
import { showTime } from '../time/appTime';
import { getPackStatus, onPackStatus, packSyncDeps, syncPack, type PackStatus } from './packSync';

/**
 * 设置页里的一行：个性化设置同步到哪一版了、签名对不对、到什么时候（只是文字，没有指示灯）。
 * 「立即同步」马上再问一次服务器。接入点：settings/SettingsPage。
 */
const SOURCE: Record<NonNullable<PackStatus['source']>, string> = { server: '来自同步服务', cache: '用的是上次存在本机的', folder: '来自本机文件夹' };

/* 状态写成一两句话 */
export function packStatusText(status: PackStatus): { main: string; note?: string } {
  if (status.state === 'off') return { main: '未启用：没有配置签名的公钥，用的是程序自带的内容' };

  const checked: string = status.checkedAt ? `上次检查 ${ showTime(status.checkedAt, 'MM-DD HH:mm') }` : '';

  if (status.state === 'verified') {
    const expires: string = status.expiresAt ? `，${ status.expired ? '已于' : '到期' } ${ showTime(Date.parse(status.expiresAt), 'YYYY-MM-DD') }${ status.expired ? ' 过期（还在用，记得重新签名）' : '' }` : '';

    return {
      main: `签名${ status.expired ? '已过期' : '有效' }${ expires }；版本 ${ status.version ? showTime(Date.parse(status.version), 'YYYY-MM-DD HH:mm') : '未知' }，${ SOURCE[status.source ?? 'server'] }`,
      note: [status.message, checked].filter(Boolean).join('；') || undefined
    };
  }

  if (status.state === 'rejected') return { main: `没有可用的内容包，用的是程序自带的内容：${ status.message ?? '' }`, note: checked || undefined };

  return { main: '还没有同步到内容包，用的是程序自带的内容', note: checked || undefined };
}

function PackStatusRow(): ReactElement {
  const status: PackStatus = useSyncExternalStore(onPackStatus, getPackStatus);
  const [busy, setBusy]: [boolean, (value: boolean) => void] = useState(false);
  const text: { main: string; note?: string } = packStatusText(status);

  async function handleSyncClick(): Promise<void> {
    setBusy(true);

    try {
      await syncPack(packSyncDeps);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Space direction="vertical" size={ 4 } align="end">
      <Typography.Text>{ text.main }</Typography.Text>
      { text.note ? <Typography.Text type="secondary">{ text.note }</Typography.Text> : null }
      { status.state === 'off' ? null : <Button size="small" loading={ busy } onClick={ handleSyncClick }>立即同步</Button> }
    </Space>
  );
}

export default PackStatusRow;
