import type { ReactElement } from 'react';
import { useRoutes } from 'react-router';
import style from './RoomMessage/roomMessage.sass';
import Content from '../../components/Content/Content';
import Pocket48Live from './Pocket48/Pocket48Live/Pocket48Live';
import AutoGrabOptionsPage from '../../custom/live/AutoGrabOptionsPage'; // 新的自动抓取配置页，原版是 ./Pocket48/LiveOptions/LiveOptions
import Pocket48Record from './Pocket48/Pocket48Record/Pocket48Record';
import InLive from './Live48/InLive/InLive';
import InVideo from './Live48/InVideo/InVideo';
import HighlightsPage from '../../custom/highlight/HighlightsPage'; // 录播切片：挑爆点
import RoomPage from '../../custom/room/RoomPage'; // 聊天风格的新房间页，原版是 ./RoomMessage/loader
import Voice from './Voice/Voice';
import Friends from './Friends/Friends';
import QingchunshikeDynamic from './Qingchunshike/loader';

/* 直播和录播下载 */
function Index(props: {}): ReactElement | null {
  const routes: ReactElement | null = useRoutes([
    { path: 'Pocket48Live', element: <Pocket48Live /> },
    { path: 'LiveOptions', element: <AutoGrabOptionsPage /> },
    { path: 'Pocket48Record', element: <Pocket48Record /> },
    { path: 'InLive', element: <InLive /> },
    { path: 'InVideo', element: <InVideo /> },
    { path: 'RoomMessage', element: <RoomPage /> },
    { path: 'Highlights', element: <HighlightsPage /> },
    { path: 'Voice', element: <Voice /> },
    { path: 'Friends', element: <Friends /> },
    { path: 'Qingchunshike', element: <QingchunshikeDynamic /> }
  ]);

  return <Content className={ style.content }>{ routes }</Content>;
}

export default Index;