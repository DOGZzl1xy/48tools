import { ipcRenderer } from 'electron';
import { Fragment, use, type ReactElement, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { Button, Collapse, Image, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import {
  ArrowRightOutlined as IconArrowRightOutlined,
  FileSyncOutlined as IconFileSyncOutlined,
  ToolTwoTone as IconToolTwoTone,
  BugTwoTone as IconBugTwoTone
} from '@ant-design/icons';
import { WinIpcChannel } from '@48tools/main/src/channelEnum';
import './home.global.sass';
import ButtonLink from '../../components/ButtonLink/ButtonLink';
import FFmpegOption from '../../pages/Index/FFmpegOption/FFmpegOption';
import ExecutablePath from '../../pages/Index/ExecutablePath/ExecutablePath';
import Pocket48ProxyOption from '../pocket48Proxy/Pocket48ProxyOption';
import ThemeContext, { type Theme } from '../../components/basic/Theme/ThemeContext';
import { useAppDataDir, type UseAppDataDirReturnType } from '../../functionalComponents/Pocket48Login/useAppDataDir/useAppDataDir';
import imageUrlZfbAvif from '../../pages/Index/images/zfb.avif';
import imageUrlWxAvif from '../../pages/Index/images/wx.avif';
import { shellNavGroups, shellNavItems, type ShellNavGroup, type ShellNavItem } from '../shell/navConfig';
import { setQueueOpen } from '../shell/shellStore';
import { useQueueTasks, type QueueTask } from '../downloadQueue/downloadQueue';
import { safeOpenExternal } from '../security/safeOpenExternal';

/**
 * 新的首页：常用功能的大卡片、当前任务、全部功能、设置、关于。
 * 原版首页（pages/Index/Index.tsx）保留不动，设置按钮和赞助信息都复用原版的组件和图片。
 * 接入点：router/Routers.tsx 的首页路由。
 */
const featuredKeys: Array<string> = ['pocket48-record', 'pocket48-live'];
const featured: Array<ShellNavItem> = shellNavItems.filter((item: ShellNavItem): boolean => featuredKeys.includes(item.key));

function handleOpenDeveloperToolsClick(event: MouseEvent): void {
  ipcRenderer.send(WinIpcChannel.DeveloperTools);
}

function FeaturedCard(props: { item: ShellNavItem }): ReactElement {
  const { item }: { item: ShellNavItem } = props;

  return (
    <Link className="home-card" to={ item.to } draggable={ false }>
      <span className="home-card-icon">{ item.icon }</span>
      <span className="home-card-text">
        <b>{ item.title }</b>
        <small>{ item.description }</small>
      </span>
      <IconArrowRightOutlined className="home-card-arrow" />
    </Link>
  );
}

function RunningTasks(props: {}): ReactElement {
  const tasks: Array<QueueTask> = useQueueTasks();
  const running: Array<QueueTask> = tasks.filter((task: QueueTask): boolean => task.status === 'running');

  if (running.length === 0) {
    return (
      <div className="home-empty">
        现在没有进行中的任务。
        { tasks.length > 0 ? <Button type="link" size="small" onClick={ (): void => setQueueOpen(true) }>查看已结束的任务</Button> : null }
      </div>
    );
  }

  return (
    <Fragment>
      {
        running.slice(0, 3).map((task: QueueTask): ReactElement => (
          <div key={ task.id } className="home-task">
            <Tag className="mr-0 shrink-0">{ task.kind }</Tag>
            <Typography.Text className="grow" ellipsis={ true }>{ task.title }</Typography.Text>
            {
              task.percent !== undefined
                ? <Progress className="home-task-progress" percent={ Number(task.percent.toFixed(1)) } size="small" status="active" />
                : <Typography.Text type="secondary">{ task.detail }</Typography.Text>
            }
          </div>
        ))
      }
      <Button className="mt-[4px] px-0" type="link" size="small" onClick={ (): void => setQueueOpen(true) }>
        { running.length > 3 ? `查看全部 ${ running.length } 个任务` : '打开下载队列' }
      </Button>
    </Fragment>
  );
}

function HomeDashboard(props: {}): ReactElement {
  const { ChangeThemeElement }: Theme = use(ThemeContext);
  const { buttonRender, modalRender }: UseAppDataDirReturnType = useAppDataDir();

  return (
    <div className="home">
      <header className="home-header">
        <h1>48tools</h1>
        <Tag bordered={ false }>{ document.title.replace(/^48tools\s*-\s*/, '') }</Tag>
      </header>

      <section>
        <h2>常用</h2>
        <div className="home-featured">
          { featured.map((item: ShellNavItem): ReactElement => <FeaturedCard key={ item.key } item={ item } />) }
        </div>
      </section>

      <section>
        <h2>当前任务</h2>
        <RunningTasks />
      </section>

      <section>
        <h2>全部功能</h2>
        {
          shellNavGroups.map((group: ShellNavGroup): ReactElement => (
            <div key={ group.key } className="home-group">
              <h3>{ group.title }</h3>
              <div className="home-tiles">
                {
                  group.items.map((item: ShellNavItem): ReactElement => (
                    <Link key={ item.key } className="home-tile" to={ item.to } draggable={ false }>
                      { item.icon }
                      <span>{ item.title }</span>
                    </Link>
                  ))
                }
              </div>
            </div>
          ))
        }
      </section>

      <section>
        <h2>设置</h2>
        <Space wrap={ true }>
          <FFmpegOption />
          { buttonRender() }
          <ExecutablePath />
          <Pocket48ProxyOption />
        </Space>
        <div className="mt-[8px]">
          <Space wrap={ true }>
            <Button id="help-doc"
              icon={ <IconFileSyncOutlined /> }
              onClick={ (): void => safeOpenExternal('https://yzb1g5r02h.feishu.cn/docx/MxfydWlNaovZ5sxsbJ5crnAlnVb') }
            >
              使用手册
            </Button>
            { ChangeThemeElement }
            <Tooltip title="开发者工具">
              <Button type="text" icon={ <IconToolTwoTone /> } onClick={ handleOpenDeveloperToolsClick } />
            </Tooltip>
            <Tooltip title="问题反馈（原版仓库）">
              <Button id="issues"
                type="text"
                icon={ <IconBugTwoTone /> }
                onClick={ (): void => safeOpenExternal('https://github.com/duan602728596/48tools/issues') }
              />
            </Tooltip>
            <ButtonLink linkProps={{ to: '/Agreement/Agreement' }} buttonProps={{ type: 'text' }}>License</ButtonLink>
          </Space>
        </div>
      </section>

      <section>
        <Collapse ghost={ true }
          items={ [{
            key: 'about',
            label: '关于原版 48tools 与赞助作者',
            children: (
              <div className="home-about">
                <p>
                  48tools 是段昊辰开发的免费软件，
                  <b>使用及传播均不收取任何费用</b>
                  。原版的最新版本在
                  <Button type="link"
                    size="small"
                    onClick={ (): void => safeOpenExternal('https://github.com/duan602728596/48tools/releases') }
                  >
                    https://github.com/duan602728596/48tools/releases
                  </Button>
                  下载。这个窗口是在原版基础上修改的自定义版本。如果你想要赞助原作者，请扫码打赏。
                </p>
                <Space size={ 8 }>
                  <Image className="cursor-pointer !w-[160px]" src={ imageUrlZfbAvif } />
                  <Image className="cursor-pointer !w-[160px]" src={ imageUrlWxAvif } />
                </Space>
              </div>
            )
          }] }
        />
      </section>
      { modalRender() }
    </div>
  );
}

export default HomeDashboard;
