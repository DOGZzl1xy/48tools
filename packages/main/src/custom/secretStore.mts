import { ipcMain, safeStorage, type IpcMainEvent } from 'electron';
import { SecretChannel } from './secretChannel.js';

/**
 * 用系统的加密功能（Windows 上是 DPAPI，绑定当前登录的 Windows 用户）加密、解密一小段文字。
 * 界面用它保存语音转文字的 API key：存进 localStorage 的是加密后的内容，别的用户、别的电脑拿到文件也解不开。
 * 用同步通道，因为界面的设置是启动时一次读出来的（48tools/src/custom/settings/settingsStore）。
 * 接入点：packages/main/src/main.mts 启动时调用 registerSecretStore。
 */
function encrypt(event: IpcMainEvent, text: unknown): void {
  try {
    event.returnValue = typeof text === 'string' && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(text).toString('base64')
      : null;
  } catch {
    event.returnValue = null;
  }
}

function decrypt(event: IpcMainEvent, data: unknown): void {
  try {
    event.returnValue = typeof data === 'string' && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(data, 'base64'))
      : null;
  } catch {
    event.returnValue = null;
  }
}

export function registerSecretStore(): void {
  ipcMain.removeAllListeners(SecretChannel.Encrypt);
  ipcMain.removeAllListeners(SecretChannel.Decrypt);
  ipcMain.on(SecretChannel.Encrypt, encrypt);
  ipcMain.on(SecretChannel.Decrypt, decrypt);
}
