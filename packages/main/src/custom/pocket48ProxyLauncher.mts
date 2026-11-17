import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as process from 'node:process';

/**
 * 启动应用时自动拉起口袋48代理（local/xray），退出应用时关掉。
 *   - 从程序所在目录、启动目录逐级往上找 local/xray/xray.exe 和 local/xray/config.json，找不到就什么也不做
 *   - 代理端口已经有程序在监听（例如手动双击 start-pocket48-proxy.cmd）时不重复启动，退出时也不去关它
 *   - xray 的输出写到 local/xray/xray.log，方便排查
 * 接入点：main.mts（app ready 时 startPocket48Proxy，will-quit 时 stopPocket48Proxy）。
 */
interface ProxyLocation {
  xrayDir: string;
  xrayExe: string;
  config: string;
}

interface ListenAddress {
  host: string;
  port: number;
}

let proxyProcess: ChildProcess | null = null;

/* 从几个起点逐级往上找 local/xray */
function findProxyLocation(): ProxyLocation | undefined {
  const exeName: string = process.platform === 'win32' ? 'xray.exe' : 'xray';
  const starts: Array<string> = [path.dirname(process.execPath), process.cwd()];

  for (const start of starts) {
    let dir: string = start;

    for (let i: number = 0; i < 8; i++) {
      const xrayDir: string = path.join(dir, 'local', 'xray');
      const location: ProxyLocation = {
        xrayDir,
        xrayExe: path.join(xrayDir, exeName),
        config: path.join(xrayDir, 'config.json')
      };

      if (fs.existsSync(location.xrayExe) && fs.existsSync(location.config)) return location;

      const parent: string = path.dirname(dir);

      if (parent === dir) break;

      dir = parent;
    }
  }

  return undefined;
}

/* 读取 config.json 里第一个 http 入站的监听地址 */
function readListenAddress(config: string): ListenAddress | undefined {
  try {
    const json: { inbounds?: Array<{ listen?: string; port?: number; protocol?: string }> }
      = JSON.parse(fs.readFileSync(config, { encoding: 'utf8' }));
    const inbound: { listen?: string; port?: number } | undefined
      = json.inbounds?.find((item: { protocol?: string }): boolean => item.protocol === 'http') ?? json.inbounds?.[0];

    if (inbound?.port) {
      return {
        host: !inbound.listen || inbound.listen === '0.0.0.0' ? '127.0.0.1' : inbound.listen,
        port: inbound.port
      };
    }
  } catch (err) {
    console.error('[口袋48代理] config.json 读取失败', err);
  }

  return undefined;
}

/* 端口上是否已经有程序在监听 */
function isListening(address: ListenAddress): Promise<boolean> {
  return new Promise((resolve: (value: boolean) => void): void => {
    const socket: net.Socket = net.connect(address.port, address.host);

    function done(value: boolean): void {
      socket.destroy();
      resolve(value);
    }

    socket.setTimeout(800);
    socket.once('connect', (): void => done(true));
    socket.once('timeout', (): void => done(false));
    socket.once('error', (): void => done(false));
  });
}

/* 启动代理 */
export async function startPocket48Proxy(): Promise<void> {
  if (proxyProcess) return;

  const location: ProxyLocation | undefined = findProxyLocation();

  if (!location) return;

  const address: ListenAddress | undefined = readListenAddress(location.config);

  if (address && await isListening(address)) {
    console.log(`[口袋48代理] ${ address.host }:${ address.port } 已在运行，直接使用`);

    return;
  }

  let log: number | 'ignore' = 'ignore';

  try {
    log = fs.openSync(path.join(location.xrayDir, 'xray.log'), 'w');
  } catch { /* 写不了日志也照常启动 */ }

  try {
    const child: ChildProcess = spawn(location.xrayExe, ['run', '-c', location.config], {
      cwd: location.xrayDir,
      stdio: ['ignore', log, log],
      windowsHide: true
    });

    proxyProcess = child;
    child.once('error', (err: Error): void => {
      console.error('[口袋48代理] 启动失败', err);
      if (proxyProcess === child) proxyProcess = null;
    });
    child.once('exit', (code: number | null): void => {
      console.log(`[口袋48代理] 已退出，退出码：${ code ?? 'unknown' }`);
      if (proxyProcess === child) proxyProcess = null;
    });
  } finally {
    if (typeof log === 'number') fs.closeSync(log); // 子进程已经拿到了自己的句柄
  }
}

/* 关闭由本应用启动的代理 */
export function stopPocket48Proxy(): void {
  if (!proxyProcess) return;

  try {
    proxyProcess.kill();
  } catch { /* noop */ }

  proxyProcess = null;
}
