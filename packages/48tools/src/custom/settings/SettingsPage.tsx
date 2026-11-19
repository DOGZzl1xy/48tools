import { ipcRenderer } from 'electron';
import { use, type ReactElement, type ReactNode, type MouseEvent } from 'react';
import { Button, Input, Segmented, Space, Tooltip, Typography } from 'antd';
import {
  FolderOpenOutlined as IconFolderOpenOutlined,
  FileSyncOutlined as IconFileSyncOutlined,
  ToolTwoTone as IconToolTwoTone,
  BugTwoTone as IconBugTwoTone,
  CheckOutlined as IconCheckOutlined
} from '@ant-design/icons';
import { WinIpcChannel } from '@48tools/main/src/channelEnum';
import './settings.global.sass';
import ButtonLink from '../../components/ButtonLink/ButtonLink';
import FFmpegOption from '../../pages/Index/FFmpegOption/FFmpegOption';
import ExecutablePath from '../../pages/Index/ExecutablePath/ExecutablePath';
import Pocket48Login from '../../functionalComponents/Pocket48Login/Pocket48Login';
import ThemeContext, { type Theme } from '../../components/basic/Theme/ThemeContext';
import { useAppDataDir, type UseAppDataDirReturnType } from '../../functionalComponents/Pocket48Login/useAppDataDir/useAppDataDir';
import { showOpenDialog } from '../../utils/remote/dialog';
import Pocket48ProxyOption from '../pocket48Proxy/Pocket48ProxyOption';
import { safeOpenExternal } from '../security/safeOpenExternal';
import { resolveLocalDir } from '../download/defaultSaveDir';
import {
  useSettingOverrides,
  resolveSetting,
  setSetting,
  accentColors,
  type CustomSettings,
  type LiveRecordFormat
} from './settingsStore';

/**
 * 设置页面：账号、保存位置、直播录制格式、代理、外观、工具路径、关于。
 * 入口在侧边栏底部的「设置」。账号、FFmpeg、代理等沿用原来的组件（只是集中放到这里）。
 * 接入点：router/Routers.tsx 的 Settings 路由。
 */
function Row(props: { label: string; hint?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <b>{ props.label }</b>
        { props.hint ? <small>{ props.hint }</small> : null }
      </div>
      <div className="settings-row-control">{ props.children }</div>
    </div>
  );
}

/* 选择文件夹的输入框 */
function DirField(props: { settingKey: 'downloadDir' | 'liveRecordDir'; placeholder: string }): ReactElement {
  const { settingKey, placeholder }: { settingKey: 'downloadDir' | 'liveRecordDir'; placeholder: string } = props;
  const overrides: CustomSettings = useSettingOverrides();
  const value: string = resolveSetting(overrides, settingKey) ?? '';
  const invalid: boolean = value !== '' && resolveLocalDir(value) === undefined;

  async function handleChooseClick(): Promise<void> {
    const result: { canceled: boolean; filePaths?: Array<string> } = await showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveLocalDir(value)
    });

    if (result.canceled || !result.filePaths?.length) return;

    setSetting(settingKey, result.filePaths[0]);
  }

  return (
    <div>
      <Space.Compact className="w-full">
        <Input readOnly={ true } value={ value } placeholder={ placeholder } status={ invalid ? 'error' : undefined } />
        <Button icon={ <IconFolderOpenOutlined /> } onClick={ handleChooseClick }>选择</Button>
        { overrides[settingKey] ? <Button onClick={ (): void => setSetting(settingKey, undefined) }>恢复默认</Button> : null }
      </Space.Compact>
      { invalid ? <Typography.Text className="text-[12px]" type="danger">这个文件夹不存在，保存时会按系统默认位置处理</Typography.Text> : null }
    </div>
  );
}

const formatOptions: Array<{ label: string; value: LiveRecordFormat }> = [
  { label: '保持 flv', value: 'flv' },
  { label: '转成 mp4（无损）', value: 'mp4' },
  { label: '压缩成 mp4', value: 'mp4-compress' }
];

const formatHints: Record<LiveRecordFormat, string> = {
  flv: '不转换。',
  mp4: '录完后重新封装成 mp4，不重新编码，很快，大小基本不变。',
  'mp4-compress': '录完后重新编码压缩，一般能小一半以上，画质略有损失；核对时长一致后才删除原来的 flv。'
};

function SettingsPage(props: {}): ReactElement {
  const { ChangeThemeElement }: Theme = use(ThemeContext);
  const { buttonRender, modalRender }: UseAppDataDirReturnType = useAppDataDir();
  const overrides: CustomSettings = useSettingOverrides();
  const format: LiveRecordFormat = resolveSetting(overrides, 'liveRecordFormat') ?? 'flv';
  const accentName: string = overrides.accentColor ?? accentColors[0].name;

  return (
    <div className="settings">
      <h1>设置</h1>

      <section>
        <h2>账号</h2>
        <Row label="口袋48账号" hint="登录后才能用房间消息、房间电台等功能。点开可以切换账号、复制 Token、退出登录。">
          <Pocket48Login />
        </Row>
      </section>

      <section>
        <h2>保存位置</h2>
        <Row label="默认保存文件夹" hint="下载视频、音频时，保存对话框默认打开这里。">
          <DirField settingKey="downloadDir" placeholder="没有设置（由 Windows 决定）" />
        </Row>
        <Row label="直播自动录制文件夹" hint="自动抓取的录像保存在这里，优先于「自动抓取配置」里填的目录。不设置时用上面的默认保存文件夹。">
          <DirField settingKey="liveRecordDir" placeholder="没有设置（用默认保存文件夹）" />
        </Row>
        <Row label="直播录完后的格式" hint={ formatHints[format] }>
          <Segmented options={ formatOptions }
            value={ format }
            onChange={ (value: LiveRecordFormat): void => setSetting('liveRecordFormat', value) }
          />
        </Row>
      </section>

      <section>
        <h2>网络</h2>
        <Row label="口袋48代理" hint="只有口袋48接口走这个代理，其他请求直连。圆点表示代理是否在运行。">
          <Pocket48ProxyOption />
        </Row>
      </section>

      <section>
        <h2>外观</h2>
        <Row label="明暗主题" hint="浅色、深色，或者跟随系统。">
          { ChangeThemeElement }
        </Row>
        <Row label="主题色" hint="按钮、选中状态、链接的颜色。">
          <div className="settings-colors">
            {
              accentColors.map((accent: { name: string; light: string }): ReactElement => (
                <Tooltip key={ accent.name } title={ accent.name }>
                  <button className={ `settings-color${ accent.name === accentName ? ' is-active' : '' }` }
                    type="button"
                    aria-label={ `主题色：${ accent.name }` }
                    aria-pressed={ accent.name === accentName }
                    style={{ background: accent.light }}
                    onClick={ (): void => setSetting('accentColor', accent.name === accentColors[0].name ? undefined : accent.name) }
                  >
                    { accent.name === accentName ? <IconCheckOutlined /> : null }
                  </button>
                </Tooltip>
              ))
            }
          </div>
        </Row>
      </section>

      <section>
        <h2>工具路径</h2>
        <Row label="FFmpeg" hint="下载、录制、转码都要用到。">
          <FFmpegOption />
        </Row>
        <Row label="口袋48 App Data 目录" hint="房间消息等功能使用的数据目录。">
          { buttonRender() }
        </Row>
        <Row label="无头浏览器" hint="部分平台的功能需要用浏览器取数据。">
          <ExecutablePath />
        </Row>
      </section>

      <section>
        <h2>关于</h2>
        <Row label={ document.title } hint="在原版 48tools（段昊辰开发的免费软件）基础上修改的自定义版本。">
          <Space wrap={ true }>
            <Button icon={ <IconFileSyncOutlined /> }
              onClick={ (): void => safeOpenExternal('https://yzb1g5r02h.feishu.cn/docx/MxfydWlNaovZ5sxsbJ5crnAlnVb') }
            >
              使用手册
            </Button>
            <ButtonLink linkProps={{ to: '/Agreement/Agreement' }} buttonProps={{}}>License</ButtonLink>
            <Tooltip title="开发者工具">
              <Button icon={ <IconToolTwoTone /> }
                onClick={ (event: MouseEvent): void => ipcRenderer.send(WinIpcChannel.DeveloperTools) }
              />
            </Tooltip>
            <Tooltip title="问题反馈（原版仓库）">
              <Button icon={ <IconBugTwoTone /> }
                onClick={ (): void => safeOpenExternal('https://github.com/duan602728596/48tools/issues') }
              />
            </Tooltip>
          </Space>
        </Row>
      </section>
      { modalRender() }
    </div>
  );
}

export default SettingsPage;
