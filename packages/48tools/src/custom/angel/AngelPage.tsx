import { useEffect, type ReactElement } from 'react';
import { ipcRenderer } from 'electron';
import { Button, Result, theme, type GlobalToken } from 'antd';
import { HeartOutlined as IconHeartOutlined } from '@ant-design/icons';
import { AngelChannel } from '@48tools/main/src/custom/angelChannel';

/**
 * 「守护天使」页面：点开就用程序自带的浏览器窗口打开 https://angel.48tools.app（主进程 custom/angelWindow），
 * 程序里不再另画一份。网页由 local/angel/site/publish.mjs 用程序在后台算好的结果（./angelStore 导出的 digest）生成。
 * 窗口已经开着时，点按钮会把它拿到前面并刷新。
 */
function openAngelSite(): void {
  ipcRenderer.send(AngelChannel.Open);
}

function AngelPage(props: {}): ReactElement {
  const { token }: { token: GlobalToken } = theme.useToken();

  useEffect(openAngelSite, []);

  return (
    <Result icon={ <IconHeartOutlined style={{ color: token.colorPrimary }} /> }
      title="NII 守护天使推理"
      subTitle="已在单独的窗口里打开 angel.48tools.app"
      extra={ <Button type="primary" onClick={ (): void => openAngelSite() }>打开窗口</Button> }
    />
  );
}

export default AngelPage;
