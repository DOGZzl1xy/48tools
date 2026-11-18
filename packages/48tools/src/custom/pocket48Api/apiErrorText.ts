import * as net from 'node:net';
import { getPocket48Proxy } from '../pocket48Proxy/pocket48Proxy';
import { POCKET48_CLIENT_VERSION } from '../pocket48Headers/pocket48ClientInfo';

/**
 * 口袋48接口出错时给用户看的说明。
 *   - 403：海外 IP 被拒绝。先看代理有没有在运行，给出对应的处理办法
 *   - 其他错误：接口地址和模拟的客户端版本都是抓包得来的，随时可能过期，所以提示用户「可能需要重新抓包更新」
 * 接入点：custom/pocket48Record/recordListError（录播列表）、pages/48/Pocket48/utils/autoGrab.ts（自动抓取）。
 */
export type ProxyState = 'direct' | 'ok' | 'down';

export const OUTDATED_HINT: string = `如果一直失败，可能是口袋48更换了接口地址或提高了客户端版本要求（现在模拟的是 iOS ${
  POCKET48_CLIENT_VERSION }），需要重新抓包更新。`;

/* 代理地址的端口是否连得上 */
export function isProxyReachable(proxy: string, timeout: number = 1_500): Promise<boolean> {
  return new Promise((resolve: (value: boolean) => void): void => {
    let url: URL;

    try {
      url = new URL(proxy);
    } catch {
      return resolve(false);
    }

    const socket: net.Socket = net.connect(Number(url.port) || (url.protocol === 'https:' ? 443 : 80), url.hostname);

    function done(value: boolean): void {
      socket.destroy();
      resolve(value);
    }

    socket.setTimeout(timeout);
    socket.once('connect', (): void => done(true));
    socket.once('timeout', (): void => done(false));
    socket.once('error', (): void => done(false));
  });
}

/* 当前口袋48代理的状态：direct 没有配置代理，ok 代理在运行，down 配置了但连不上 */
export async function checkPocket48Proxy(): Promise<ProxyState> {
  const proxy: string | undefined = getPocket48Proxy();

  if (!proxy) return 'direct';

  return (await isProxyReachable(proxy)) ? 'ok' : 'down';
}

type RequestErrorLike = { response?: { statusCode?: number }; code?: string; message?: string } | null | undefined;

/* 根据错误和代理状态生成说明（不含前缀） */
export function describePocket48Error(err: unknown, proxyState: ProxyState): string {
  const error: RequestErrorLike = err as RequestErrorLike;
  const statusCode: number | undefined = error?.response?.statusCode;

  if (proxyState === 'down') {
    return '口袋48代理没有在运行（连不上代理端口）。请重启 48tools；如果还不行，看一下 local/xray/xray.log。';
  }

  if (statusCode === 403) {
    return proxyState === 'direct'
      ? '接口返回 403，当前网络 IP 被口袋48拒绝访问。请在首页「口袋48代理」里配置国内代理。'
      : '接口返回 403。代理在运行，但出口 IP 仍然被口袋48拒绝，请检查代理节点。';
  }

  if (statusCode) return `接口返回 ${ statusCode }。${ OUTDATED_HINT }`;

  const reason: string = error?.code || error?.message || '';

  return `网络请求失败${ reason ? `（${ reason }）` : '' }。${ proxyState === 'ok' ? '代理在运行，可能是代理节点或网络不稳定。' : '' }`;
}

/* 请求抛出错误时的完整提示 */
export async function pocket48ErrorText(prefix: string, err: unknown): Promise<string> {
  let proxyState: ProxyState = 'ok';

  try {
    proxyState = await checkPocket48Proxy();
  } catch { /* noop */ }

  return `${ prefix }${ describePocket48Error(err, proxyState) }`;
}

/* 接口正常返回但 success 为 false 时的完整提示 */
export function pocket48FailText(prefix: string, message: string | undefined): string {
  return `${ prefix }${ message ? `接口提示：${ message }。` : '' }${ OUTDATED_HINT }`;
}
