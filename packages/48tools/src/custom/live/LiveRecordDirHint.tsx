import type { ReactElement } from 'react';
import { Typography } from 'antd';
import { getLiveRecordDir, getLiveRecordFormat } from './liveRecording';

/**
 * 「自动抓取配置」页面里的提示：local/pocket48.json 配置了保存目录时，说明实际会保存到哪里、录完会不会转 mp4。
 * 接入点：pages/48/Pocket48/LiveOptions/LiveOptions.tsx（「自动保存的目录」下面）。
 */
function LiveRecordDirHint(props: {}): ReactElement | null {
  const dir: string = getLiveRecordDir('');
  const format: string = getLiveRecordFormat();
  const formatText: string = format === 'mp4' ? '，录完后自动转成 mp4' : (format === 'mp4-compress' ? '，录完后自动压缩成 mp4' : '');

  if (!dir && !formatText) return null;

  return (
    <Typography.Text className="block mt-[6px] text-[12px]" type="secondary">
      { dir ? `本机配置（local/pocket48.json）指定了保存目录，实际保存到：${ dir }` : '保存到上面的目录' }
      { formatText }
    </Typography.Text>
  );
}

export default LiveRecordDirHint;
