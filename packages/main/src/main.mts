import './_sourcemap.mjs';
import { env, platform } from 'node:process';
import { app } from 'electron';
import { nodeNimCleanup } from './ipcHandle/nodeNimHandleLogin.mjs';
import { createWindow, processWindow } from './ProcessWindow.mjs';
import { startPocket48Proxy, stopPocket48Proxy } from './custom/pocket48ProxyLauncher.mjs';

env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'; // 关闭警告

// https://github.com/microsoft/vscode/issues/116715#issuecomment-917783861
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

app.whenReady().then(createWindow);
app.whenReady().then(startPocket48Proxy);
app.on('will-quit', stopPocket48Proxy);

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