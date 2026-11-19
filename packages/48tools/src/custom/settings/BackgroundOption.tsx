import { ipcRenderer, type IpcRendererEvent } from 'electron';
import { Fragment, useEffect, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { App, Button, Switch } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import { PoweroffOutlined as IconPoweroffOutlined } from '@ant-design/icons';
import { BackgroundChannel } from '@48tools/main/src/custom/backgroundChannel';

/**
 * 设置页面里的「后台运行」：
 *   - 开关：关闭窗口后是留在后台（系统托盘）继续运行，还是直接退出
 *   - 退出程序：留在后台时，点窗口的 × 不会退出，这里提供一个真正退出的按钮（托盘图标的右键菜单里也有）
 * 开关的状态存在主进程那边（main/src/custom/backgroundTray），托盘菜单里改了，这里也会跟着变。
 * 接入点：custom/settings/SettingsPage.tsx。
 */
interface BackgroundState {
  supported: boolean; // 这个系统上有没有这个功能（目前只有 Windows）
  enabled: boolean;
}

function BackgroundOption(props: {}): ReactElement {
  const { modal: modalApi }: useAppProps = App.useApp();
  const [state, setState]: [BackgroundState | null, D<S<BackgroundState | null>>] = useState<BackgroundState | null>(null);

  useEffect(function(): () => void {
    let alive: boolean = true;

    function handleChanged(event: IpcRendererEvent, enabled: boolean): void {
      setState({ supported: true, enabled });
    }

    ipcRenderer.invoke(BackgroundChannel.Get).then((value: BackgroundState): void => {
      alive && setState(value);
    }).catch((): void => {
      alive && setState({ supported: false, enabled: false });
    });
    ipcRenderer.on(BackgroundChannel.Changed, handleChanged);

    return (): void => {
      alive = false;
      ipcRenderer.off(BackgroundChannel.Changed, handleChanged);
    };
  }, []);

  async function handleSwitchChange(checked: boolean): Promise<void> {
    const enabled: boolean = await ipcRenderer.invoke(BackgroundChannel.Set, checked);

    setState({ supported: true, enabled });
  }

  function handleQuitClick(): void {
    modalApi.confirm({
      title: '退出 48tools？',
      content: '正在进行的直播抓取、下载和房间新消息检查都会停止。',
      okText: '退出',
      okButtonProps: { danger: true },
      cancelText: '取消',
      centered: true,
      onOk(): void {
        ipcRenderer.invoke(BackgroundChannel.Quit);
      }
    });
  }

  return (
    <Fragment>
      <div className="settings-row">
        <div className="settings-row-label">
          <b>关闭窗口后留在后台</b>
          <small>
            {
              state?.supported === false
                ? '这个系统上暂时不支持。'
                : '打开后，点窗口右上角的 × 只是把窗口收起来，直播抓取、下载和房间新消息检查会继续。在屏幕右下角的托盘里单击 48tools 图标可以重新打开窗口。'
            }
          </small>
        </div>
        <div className="settings-row-control">
          <Switch checked={ state?.enabled ?? false }
            loading={ state === null }
            disabled={ state?.supported === false }
            onChange={ handleSwitchChange }
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <b>退出程序</b>
          <small>完全退出 48tools。托盘图标的右键菜单里也有「退出 48tools」。</small>
        </div>
        <div className="settings-row-control">
          <Button danger={ true } icon={ <IconPoweroffOutlined /> } onClick={ handleQuitClick }>退出程序</Button>
        </div>
      </div>
    </Fragment>
  );
}

export default BackgroundOption;
