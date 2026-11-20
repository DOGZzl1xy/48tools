import type { ReactElement } from 'react';
import {
  PlaySquareOutlined as IconPlaySquareOutlined,
  VideoCameraOutlined as IconVideoCameraOutlined,
  DesktopOutlined as IconDesktopOutlined,
  PlayCircleOutlined as IconPlayCircleOutlined,
  CustomerServiceOutlined as IconCustomerServiceOutlined,
  MessageOutlined as IconMessageOutlined,
  BilibiliOutlined as IconBilibiliOutlined,
  BilibiliFilled as IconBilibiliFilled,
  YoutubeOutlined as IconYoutubeOutlined,
  YoutubeFilled as IconYoutubeFilled,
  TikTokOutlined as IconTikTokOutlined,
  TikTokFilled as IconTikTokFilled,
  ThunderboltOutlined as IconThunderboltOutlined,
  ThunderboltFilled as IconThunderboltFilled,
  FireOutlined as IconFireOutlined,
  WeiboOutlined as IconWeiboOutlined,
  CheckSquareOutlined as IconCheckSquareOutlined,
  PictureOutlined as IconPictureOutlined,
  StarOutlined as IconStarOutlined,
  ScissorOutlined as IconScissorOutlined,
  MergeCellsOutlined as IconMergeCellsOutlined,
  CodeOutlined as IconCodeOutlined,
  HeartOutlined as IconHeartOutlined
} from '@ant-design/icons';

/**
 * 侧边栏和首页用的导航配置（功能列表）。
 * 地址和原版首页（pages/Index/Index.tsx 的 navLinkConfig）一致；原版新增功能时在这里补一项。
 * 图标用线条图标；同一个平台的「视频」和「直播」用线条 / 实心两种，侧边栏收起后只剩图标时也分得出来。
 */
export interface ShellNavItem {
  key: string;
  label: string;        // 侧边栏里的短名字
  title: string;        // 页面标题、搜索用的完整名字
  description?: string; // 首页卡片上的说明
  to: string;
  icon: ReactElement;
  match?: RegExp;       // 除了 to 以外，还有哪些地址算在这个功能下面（子页面）
}

export interface ShellNavGroup {
  key: string;
  title: string;
  items: Array<ShellNavItem>;
}

export const shellNavGroups: Array<ShellNavGroup> = [
  {
    key: 'pocket48',
    title: '口袋48',
    items: [
      {
        key: 'pocket48-record',
        label: '录播下载',
        title: '口袋48录播下载',
        description: '搜索成员，下载录播的视频或音频',
        to: '/48/Pocket48Record',
        icon: <IconPlaySquareOutlined />
      },
      {
        key: 'pocket48-live',
        label: '直播抓取',
        title: '口袋48直播抓取',
        description: '录制正在进行的直播，或者自动抓取指定成员',
        to: '/48/Pocket48Live',
        icon: <IconVideoCameraOutlined />,
        match: /^\/48\/LiveOptions/
      },
      { key: '48-inlive', label: '公演直播', title: '官方公演直播抓取', to: '/48/InLive', icon: <IconDesktopOutlined /> },
      { key: '48-invideo', label: '公演录播', title: '官方公演录播下载', to: '/48/InVideo', icon: <IconPlayCircleOutlined /> },
      { key: '48-voice', label: '房间电台', title: '口袋房间电台', to: '/48/Voice', icon: <IconCustomerServiceOutlined /> },
      {
        key: '48-room-message',
        label: '房间消息',
        title: '口袋房间消息',
        to: '/48/RoomMessage',
        icon: <IconMessageOutlined />,
        match: /^\/48\/(Friends|Qingchunshike)/
      },
      // 临时功能：守护天使推理（游戏结束后删掉，见 custom/angel/angelConfig.ts）
      { key: '48-angel', label: '守护天使', title: 'Team NII 守护天使推理', to: '/48/Angel', icon: <IconHeartOutlined /> }
    ]
  },
  {
    key: 'video',
    title: '视频平台',
    items: [
      { key: 'bilibili-download', label: 'B站视频', title: 'B站视频下载', to: '/Bilibili/Download', icon: <IconBilibiliOutlined /> },
      { key: 'bilibili-live', label: 'B站直播', title: 'B站直播抓取', to: '/Bilibili/Live', icon: <IconBilibiliFilled /> },
      { key: 'acfun-download', label: 'A站视频', title: 'A站视频下载', to: '/AcFun/Download', icon: <IconYoutubeOutlined /> },
      { key: 'acfun-live', label: 'A站直播', title: 'A站直播抓取', to: '/AcFun/Live', icon: <IconYoutubeFilled /> },
      { key: 'douyin-download', label: '抖音视频', title: '抖音视频下载', to: '/Toutiao/Douyin', icon: <IconTikTokOutlined /> },
      { key: 'douyin-live', label: '抖音直播', title: '抖音直播抓取', to: '/Toutiao/DouyinLive', icon: <IconTikTokFilled /> },
      { key: 'kuaishou-download', label: '快手视频', title: '快手视频下载', to: '/Kuaishou/VideoDownload', icon: <IconThunderboltOutlined /> },
      { key: 'kuaishou-live', label: '快手直播', title: '快手直播抓取', to: '/Kuaishou/Live', icon: <IconThunderboltFilled /> }
    ]
  },
  {
    key: 'social',
    title: '社交平台',
    items: [
      { key: 'xiaohongshu-live', label: '小红书直播', title: '小红书直播抓取', to: '/Xiaohongshu/Live', icon: <IconFireOutlined /> },
      { key: 'weibo-live', label: '微博直播', title: '微博直播录制', to: '/Weibo/Live', icon: <IconWeiboOutlined /> },
      { key: 'weibo-super', label: '超话签到', title: '微博超话签到', to: '/Weibo/Super', icon: <IconCheckSquareOutlined /> },
      { key: 'weibo-images', label: '微博图片', title: '微博图片批量下载', to: '/Weibo/ImagesDownload', icon: <IconPictureOutlined /> },
      { key: 'showroom-live', label: 'SHOWROOM', title: 'SHOWROOM 直播录制', to: '/ShowroomLive/Live', icon: <IconStarOutlined /> }
    ]
  },
  {
    key: 'tools',
    title: '视频工具',
    items: [
      { key: 'video-cut', label: '视频裁剪', title: '视频裁剪', to: '/VideoEdit/VideoCut', icon: <IconScissorOutlined /> },
      { key: 'video-concat', label: '视频合并', title: '视频合并', to: '/VideoEdit/Concat', icon: <IconMergeCellsOutlined /> },
      { key: 'ffmpeg-process', label: 'FFmpeg 命令', title: '执行 FFmpeg 命令', to: '/VideoEdit/FFmpegProcess', icon: <IconCodeOutlined /> }
    ]
  }
];

export const shellNavItems: Array<ShellNavItem> = shellNavGroups.flatMap((group: ShellNavGroup): Array<ShellNavItem> => group.items);

/* 根据当前地址找到对应的功能（用来高亮侧边栏、显示页面标题） */
export function findNavItem(pathname: string): ShellNavItem | undefined {
  const lower: string = pathname.toLowerCase();

  return shellNavItems.find((item: ShellNavItem): boolean => lower === item.to.toLowerCase()
    || lower.startsWith(`${ item.to.toLowerCase() }/`)
    || Boolean(item.match?.test(pathname)));
}
