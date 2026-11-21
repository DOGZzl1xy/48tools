import { Fragment, type ReactElement } from 'react';
import { Tag } from 'antd';
import { Pocket48LiveType, Pocket48LiveMode } from '@48tools-api/48/enum';
import type { LiveInfo } from '@48tools-api/48';
import TeamTag from '../../../../custom/theme/TeamTag'; // 类型用团队色区分（custom/theme/accent）

export function liveTypeRender(liveType: Pocket48LiveType): ReactElement {
  switch (liveType) {
    case Pocket48LiveType.Game:
      return <Tag color="magenta">游戏</Tag>;

    case Pocket48LiveType.AI:
      return <Tag color="magenta">AI</Tag>;

    case Pocket48LiveType.Radio:
      return <TeamTag team="hii">电台</TeamTag>;

    default:
      return <TeamTag team="nii">视频</TeamTag>;
  }
}

interface LiveTypeProps {
  liveInfo: LiveInfo;
}

/* 直播类型 */
function LiveType(props: LiveTypeProps): ReactElement {
  const { liveInfo }: LiveTypeProps = props;
  const { liveType, liveMode, inMicrophoneConnection }: LiveInfo = liveInfo;

  if (liveMode === Pocket48LiveMode.Record) {
    return <TeamTag team="sii">录屏</TeamTag>;
  }

  return (
    <Fragment>
      { liveTypeRender(liveType) }
      { inMicrophoneConnection ? <TeamTag className="m-0" team="x">连麦</TeamTag> : null }
    </Fragment>
  );
}

export default LiveType;