/**
 * 请求口袋48接口时模拟的客户端信息，和抓包的 iOS 口袋48 7.1.48 保持一致（原版是 7.0.4，User-Agent 还是 6.0.16）。
 * 设备 ID 在本机固定保存（localStorage），不再每次请求随机生成；worker 里没有 localStorage，每个 worker 固定一个。
 * 接入点：utils/snh48.ts 的 createHeaders。
 *
 * 注意：下面这些值和 services/48 里的接口地址都是抓包得来的，随时可能过期（口袋48升级后可能要求更高的客户端版本，
 * 也可能更换接口地址）。接口开始报错时，界面会提示「可能需要重新抓包更新」（见 custom/pocket48Api/apiErrorText），
 * 那时重新抓一次手机端的请求，更新这里的版本号 / 请求头，以及 services/48/index.ts 里的地址。
 */
const APP_VERSION: string = '7.1.48';
const APP_BUILD: string = '26102601';
const OS_VERSION: string = '26.5.2';
const DEVICE_NAME: string = 'iPhone17,1';
const DEVICE_ID_STORAGE_KEY: string = 'POCKET48_DEVICE_ID';

export const POCKET48_CLIENT_VERSION: string = APP_VERSION;

export const pocket48UserAgent: string = `PocketFans201807/${ APP_VERSION } (iPhone; iOS ${ OS_VERSION }; Scale/3.00)`;

/* 抓包里客户端额外带的请求头 */
export const pocket48ExtraHeaders: Record<string, string> = {
  'P-Sign-Type': 'V0'
};

let workerDeviceId: string | undefined;

/* 生成 iOS 风格的设备 ID：8-4-4-4-12 位大写十六进制 */
function randomDeviceId(): string {
  const hex: (n: number) => string = (n: number): string => Array.from(
    { length: n }, (): string => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();

  return `${ hex(8) }-${ hex(4) }-${ hex(4) }-${ hex(4) }-${ hex(12) }`;
}

export function pocket48DeviceId(): string {
  if (typeof localStorage !== 'undefined') {
    let deviceId: string | null = localStorage.getItem(DEVICE_ID_STORAGE_KEY);

    if (!deviceId) {
      deviceId = randomDeviceId();
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
    }

    return deviceId;
  }

  workerDeviceId ??= randomDeviceId();

  return workerDeviceId;
}

/* appInfo 请求头 */
export function pocket48AppInfo(): string {
  return JSON.stringify({
    vendor: 'apple',
    deviceId: pocket48DeviceId(),
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,
    osVersion: OS_VERSION,
    osType: 'ios',
    deviceName: DEVICE_NAME,
    os: 'ios'
  });
}
