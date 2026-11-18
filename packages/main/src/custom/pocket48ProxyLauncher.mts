import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as process from 'node:process';

/**
 * 启动应用时自动拉起口袋48代理（local/xray），并在应用运行期间守护它，退出应用时关掉。
 *   - 从程序所在目录、启动目录逐级往上找 local/xray/xray.exe 和 local/xray/config.json，找不到就什么也不做
 *   - 代理端口已经有程序在监听（例如手动双击 start-pocket48-proxy.cmd）时不重复启动，退出时也不去关它
 *   - 守护：每 15 秒检查一次，代理没在运行（崩溃了，或者被另一个 48tools 退出时关掉了）就重新启动
 *   - 上次 48tools 被强制结束留下的 xray：local/xray/xray.pid 里记着 xray 和启动它的 48tools 的进程号，
 *     那个 48tools 已经不在而 xray 还在时，认领过来，退出时一起关掉
 *   - xray 的输出写到 local/xray/xray.log，方便排查
 * 接入点：main.mts（app ready 时 startPocket48Proxy，will-quit 时 stopPocket48Proxy）。
 */
interface ProxyLocation {
  xrayDir: string;
  xrayExe: string;
  config: string;
  pidFile: string;
}

interface ListenAddress {
  host: string;
  port: number;
}

const GUARD_INTERVAL: number = 15_000;
const exeName: string = process.platform === 'win32' ? 'xray.exe' : 'xray';

let proxyProcess: ChildProcess | null = null;
let adoptedPid: number | null = null; // 认领的上次遗留的 xray
let guardTimer: NodeJS.Timeout | null = null;
let quitting: boolean = false;
let starting: boolean = false;

/* 从几个起点逐级往上找 local/xray */
function findProxyLocation(): ProxyLocation | undefined {
  const starts: Array<string> = [path.dirname(process.execPath), process.cwd()];

  for (const start of starts) {
    let dir: string = start;

    for (let i: number = 0; i < 8; i++) {
      const xrayDir: string = path.join(dir, 'local', 'xray');
      const location: ProxyLocation = {
        xrayDir,
        xrayExe: path.join(xrayDir, exeName),
        config: path.join(xrayDir, 'config.json'),
        pidFile: path.join(xrayDir, 'xray.pid')
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

/* 这个 PID 是不是一个还在运行的 xray（只在 Windows 上判断，其他系统不认领） */
function isXrayProcess(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);

  return new Promise((resolve: (value: boolean) => void): void => {
    execFile('tasklist', ['/FI', `PID eq ${ pid }`, '/FO', 'CSV', '/NH'], { windowsHide: true },
      (err: Error | null, stdout: string): void => resolve(!err && stdout.toLowerCase().includes(`"${ exeName }"`)));
  });
}

interface PidInfo {
  xray: number;  // xray 的进程号
  owner: number; // 启动它的 48tools 主进程
}

function readPidFile(location: ProxyLocation): PidInfo | undefined {
  try {
    const info: PidInfo = JSON.parse(fs.readFileSync(location.pidFile, { encoding: 'utf8' }));

    return Number.isInteger(info.xray) && info.xray > 0 && Number.isInteger(info.owner) ? info : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function removePidFile(location: ProxyLocation): void {
  try {
    fs.rmSync(location.pidFile, { force: true });
  } catch { /* noop */ }
}

/* 确保代理在运行：已经在运行就不动，否则启动 */
async function ensureProxy(location: ProxyLocation): Promise<void> {
  if (quitting || starting || proxyProcess) return;

  starting = true;

  try {
    const address: ListenAddress | undefined = readListenAddress(location.config);

    if (address && await isListening(address)) {
      // 端口上已经有代理。如果是上次遗留的 xray（pid 文件里记的进程还在），认领它，退出时一起关掉
      if (adoptedPid === null) {
        const info: PidInfo | undefined = readPidFile(location);

        // 启动它的 48tools 还在运行（例如同时开着开发版）时不认领
        if (info && !isProcessAlive(info.owner) && await isXrayProcess(info.xray)) {
          adoptedPid = info.xray;
          console.log(`[口袋48代理] 认领上次遗留的 xray（PID ${ info.xray }）`);
        }
      }

      return;
    }

    if (quitting) return;

    adoptedPid = null;

    let log: number | 'ignore' = 'ignore';

    try {
      log = fs.openSync(path.join(location.xrayDir, 'xray.log'), 'a');
    } catch { /* 写不了日志也照常启动 */ }

    try {
      const child: ChildProcess = spawn(location.xrayExe, ['run', '-c', location.config], {
        cwd: location.xrayDir,
        stdio: ['ignore', log, log],
        windowsHide: true
      });

      proxyProcess = child;

      if (child.pid) {
        try {
          fs.writeFileSync(location.pidFile, JSON.stringify({ xray: child.pid, owner: process.pid } satisfies PidInfo), { encoding: 'utf8' });
        } catch { /* noop */ }
      }

      child.once('error', (err: Error): void => {
        console.error('[口袋48代理] 启动失败', err);
        if (proxyProcess === child) proxyProcess = null;
      });
      child.once('exit', (code: number | null): void => {
        console.log(`[口袋48代理] 已退出，退出码：${ code ?? 'unknown' }`);

        if (proxyProcess === child) {
          proxyProcess = null;
          removePidFile(location);
        }
        // 意外退出时由守护定时器在下一轮重新启动
      });
    } finally {
      if (typeof log === 'number') fs.closeSync(log); // 子进程已经拿到了自己的句柄
    }
  } finally {
    starting = false;
  }
}

/* 启动代理并开始守护 */
export async function startPocket48Proxy(): Promise<void> {
  if (guardTimer) return;

  const location: ProxyLocation | undefined = findProxyLocation();

  if (!location) return;

  // 日志只保留本次运行的：启动时清空，之后追加（守护重启时不会覆盖之前的内容）
  try {
    fs.writeFileSync(path.join(location.xrayDir, 'xray.log'), '');
  } catch { /* noop */ }

  quitting = false;
  guardTimer = setInterval((): void => {
    ensureProxy(location).catch((err: unknown): void => console.error('[口袋48代理] 守护出错', err));
  }, GUARD_INTERVAL);
  await ensureProxy(location);
}

/* 关闭由本应用启动（或认领）的代理 */
export function stopPocket48Proxy(): void {
  const owned: boolean = proxyProcess !== null || adoptedPid !== null;

  quitting = true;

  if (guardTimer) clearInterval(guardTimer);

  guardTimer = null;

  if (proxyProcess) {
    try {
      proxyProcess.kill();
    } catch { /* noop */ }

    proxyProcess = null;
  }

  if (adoptedPid !== null) {
    try {
      process.kill(adoptedPid);
    } catch { /* 已经不在了 */ }

    adoptedPid = null;
  }

  if (owned) {
    const location: ProxyLocation | undefined = findProxyLocation();

    if (location) removePidFile(location);
  }
}
