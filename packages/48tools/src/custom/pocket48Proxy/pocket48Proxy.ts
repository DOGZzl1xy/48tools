import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import type { Agent as HttpAgent } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { HttpProxyAgent, HttpsProxyAgent, type HttpsProxyAgentOptions } from 'hpagent';

/* 和 got 的 Agents 类型兼容 */
export interface Pocket48Agents {
  http: HttpAgent;
  https: HttpsAgent;
}

/**
 * 口袋48接口（pocketapi.48.cn）专用代理。
 * 海外 IP 访问 pocketapi.48.cn 会被 CDN 拒绝（403），所以只给口袋48接口的请求加代理，其他请求照常直连。
 *
 * 代理地址的优先级：
 *   1. 首页「口袋48代理」里保存的地址（localStorage，保存空值表示直连）
 *   2. 仓库根目录 local/pocket48.json 里的 proxy（local/ 已加入 .gitignore）
 * Worker 里没有 localStorage，由主线程把地址随 start 消息传进来（setPocket48ProxyForWorker）。
 */
export const POCKET48_PROXY_STORAGE_KEY: string = 'POCKET48_PROXY';

export interface Pocket48LocalConfig {
  proxy?: string;
  token?: string;
}

let localConfig: Pocket48LocalConfig | undefined;
let workerProxy: string | undefined | null = null; // null：未设置
const agentCache: Map<string, Pocket48Agents> = new Map();

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || /^\s*$/.test(value);
}

/* 从启动目录往上找 local/pocket48.json */
function findLocalConfigFile(): string | undefined {
  // 开发模式从仓库里启动；打包后的程序从 exe 所在目录往上找。
  // 注意：起点必须先单独算好，不能直接写在 for...of 的头部。生产构建的 babel-plugin-delay-require
  // 会把 node 模块的加载语句插到所在块的开头，写在循环头部时加载语句会落进循环体，晚于头部执行，
  // 结果 process 还没加载就被使用（打包后报错、找不到配置、不走代理）。
  const starts: Array<string> = [process.cwd(), path.dirname(process.execPath)];

  for (const start of starts) {
    let dir: string = start;

    for (let i: number = 0; i < 8; i++) {
      const file: string = path.join(dir, 'local', 'pocket48.json');

      if (fs.existsSync(file)) return file;

      const parent: string = path.dirname(dir);

      if (parent === dir) break;

      dir = parent;
    }
  }

  return undefined;
}

export function getPocket48LocalConfig(): Pocket48LocalConfig {
  if (localConfig) return localConfig;

  let file: string | undefined;

  try {
    file = findLocalConfigFile();
  } catch (err) {
    // 查找出错时不缓存，下次请求再找，避免一次出错就一直不走代理
    console.error('查找 local/pocket48.json 失败', err);

    return {};
  }

  let config: Pocket48LocalConfig = {};

  if (file) {
    try {
      config = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }));
    } catch (err) {
      console.error('local/pocket48.json 解析失败', err);
    }
  }

  localConfig = config;

  return config;
}

/* Worker 内使用：设置主线程传过来的代理地址 */
export function setPocket48ProxyForWorker(proxy: string | undefined): void {
  workerProxy = proxy;
}

/* 获取当前生效的口袋48代理地址，返回 undefined 表示直连 */
export function getPocket48Proxy(): string | undefined {
  if (workerProxy !== null) {
    return isBlank(workerProxy) ? undefined : workerProxy!.trim();
  }

  if (typeof localStorage !== 'undefined') {
    const saved: string | null = localStorage.getItem(POCKET48_PROXY_STORAGE_KEY);

    if (saved !== null) {
      return isBlank(saved) ? undefined : saved.trim();
    }
  }

  const fileProxy: string | undefined = getPocket48LocalConfig().proxy;

  return isBlank(fileProxy) ? undefined : fileProxy!.trim();
}

/* 口袋48接口请求的 got agent，没有配置代理时返回 undefined（直连） */
export function pocket48Agent(): Pocket48Agents | undefined {
  const proxy: string | undefined = getPocket48Proxy();

  if (!proxy) return;

  let agent: Pocket48Agents | undefined = agentCache.get(proxy);

  if (!agent) {
    const options: HttpsProxyAgentOptions = {
      keepAlive: true,
      keepAliveMsecs: 1000,
      timeout: 20_000, // 代理连接（CONNECT）超时，否则代理不响应时请求会一直挂着
      maxSockets: 256,
      maxFreeSockets: 256,
      scheduling: 'lifo',
      proxy
    };

    agent = {
      http: new HttpProxyAgent(options),
      https: new HttpsProxyAgent(options)
    };
    agentCache.set(proxy, agent);
  }

  return agent;
}
