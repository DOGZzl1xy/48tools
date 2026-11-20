import './_sourcemap.mjs';
import { env, platform } from 'node:process';
import { app } from 'electron';
import { nodeNimCleanup } from './ipcHandle/nodeNimHandleLogin.mjs';
import { createWindow, processWindow } from './ProcessWindow.mjs';
import { startPocket48Proxy, stopPocket48Proxy } from './custom/pocket48ProxyLauncher.mjs';
import { ensureSingleInstance } from './custom/singleInstance.mjs';
import { registerSecretStore } from './custom/secretStore.mjs';
import { registerAngelWindow } from './custom/angelWindow.mjs';

env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'; // 关闭警告

// https://github.com/microsoft/vscode/issues/116715#issuecomment-917783861
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// 只允许运行一个 48tools；已经有一个在运行时，这个进程直接退出
if (ensureSingleInstance((): typeof processWindow => processWindow)) {
  registerSecretStore(); // 界面保存 API key 时用系统加密（custom/secretStore）
  registerAngelWindow(); // 临时功能：守护天使网页用程序自带的浏览器窗口打开（custom/angelWindow）
  app.whenReady().then(createWindow);
  app.whenReady().then(startPocket48Proxy);
  app.on('will-quit', stopPocket48Proxy);
}

app.on('window-all-closed', function(): void {
  nodeNimCleanup();

  if (platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function(): void {
  if (processWindow === null) {
    createWindow();
  }
});