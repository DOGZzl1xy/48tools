import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { getLocalConfigRoot, getPocket48LocalConfig, type Pocket48LocalConfig } from '../pocket48Proxy/pocket48Proxy';

/**
 * 远端在线状态服务的纯 HTTPS 客户端：
 *   - 服务地址、鉴权密钥和自签证书指纹全部来自本机 local/pocket48.json，不写进代码库
 *   - 除 GET /health 外，请求统一带 Authorization: Bearer <key>
 *   - 严格证书 Pin：在 TLS 握手完成后、发送任何 HTTP 请求头之前校验对端证书 SHA-256 指纹，不符立即断开
 *   - 直连远端服务，不走口袋48 专用代理；客户端不碰云信 SDK，不做关注操作，不解析成员 accid
 */
export interface PresenceClientConfig {
  baseUrl: string;
  apiKey: string;
  certPem?: string;
  certPin?: string;
}

export interface ListMemberInput {
  ownerId: number;
  name: string;
  serverId?: number;
}

export interface ListTrackedMember {
  ownerId: number;
  name: string;
  serverId?: number;
  accid: string;
}

export interface ListPendingMember {
  ownerId: number;
  name: string;
  serverId?: number;
  reason?: string;
}

export interface ListSyncResponse {
  ok: boolean;
  userId: string;
  unionSize: number;
  tracked: Array<ListTrackedMember>;
  pending: Array<ListPendingMember>;
}

export interface PresenceLinkInfo {
  connected: boolean;
  lastPollAt: number | null;
  node?: string | null;
}

export interface PresenceServerMember {
  ownerId: number;
  accid: string;
  name: string;
  serverId?: number;
  online: boolean;
  since: number | null;
  stale: boolean;
}

export interface PresenceResponse {
  serverTime: number;
  link: PresenceLinkInfo;
  members: Array<PresenceServerMember>;
}

export interface PresenceServerEvent {
  t: number;
  accid: string;
  ownerId: number;
  name: string;
  online: boolean;
}

export interface PresenceEventsResponse {
  serverTime: number;
  retentionMs: number;
  events: Array<PresenceServerEvent>;
}

export interface PresenceHealthResponse {
  ok: boolean;
  uptime?: number;
  connected?: boolean;
  union?: number;
  users?: number;
  members?: number;
  lastPollAt?: number | null;
}

export class PresenceApiError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'PresenceApiError';
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS: number = 15_000;
const LIST_PUSH_TIMEOUT_MS: number = 75_000; // POST /list 服务端需按 diff 解析新成员，超时给 ≥60s
const DEFAULT_CERT_CANDIDATES: Array<string> = [
  path.join('local', 'presence', 'server.crt'),
  path.join('local', 'presence', 'cert.pem')
];
let warnedInsecure: boolean = false;

/* 服务地址能不能用：https 都可以；http 只允许本机（开发、测试时用） */
export function isAllowedPresenceUrl(baseUrl: string): boolean {
  let url: URL;

  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') return true;

  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/* 规范化 SHA-256 指纹：去掉冒号和空白并转大写 */
export function normalizePin(pin: string | undefined): string {
  return (pin ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/* 从 PEM 公钥证书提取规范化 SHA-256 指纹 */
export function fingerprintFromPem(pem: string): string {
  const cert: crypto.X509Certificate = new crypto.X509Certificate(pem);

  return normalizePin(cert.fingerprint256);
}

function resolveCertPem(configuredPath: string | undefined): string | undefined {
  const root: string | undefined = getLocalConfigRoot();
  const candidates: Array<string> = [];

  if (configuredPath && configuredPath.trim() !== '') {
    candidates.push(path.isAbsolute(configuredPath) || !root ? configuredPath.trim() : path.join(root, configuredPath.trim()));
  } else if (root) {
    for (const rel of DEFAULT_CERT_CANDIDATES) candidates.push(path.join(root, rel));
  }

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch { /* ignore unreadable cert */ }
  }

  return undefined;
}

/* 从本机 local/pocket48.json 读取服务配置；未配置时返回 undefined（功能静默不启用） */
export function getPresenceConfig(): PresenceClientConfig | undefined {
  const local: Pocket48LocalConfig = getPocket48LocalConfig();
  const baseUrl: string = (local.presenceUrl ?? '').trim().replace(/\/+$/, '');
  const apiKey: string = (local.presenceKey ?? '').trim();

  if (!baseUrl || !apiKey) return undefined;

  if (!isAllowedPresenceUrl(baseUrl)) {
    if (!warnedInsecure) {
      warnedInsecure = true;
      console.error('在线状态服务的地址必须以 https:// 开头（http 会把密钥明文发出去），这次不启用在线状态。请改 local/pocket48.json 的 presenceUrl。');
    }

    return undefined;
  }

  const certPem: string | undefined = resolveCertPem(local.presenceCert);
  let certPin: string | undefined = normalizePin(local.presenceCertPin) || undefined;

  if (!certPin && certPem) {
    try {
      certPin = fingerprintFromPem(certPem);
    } catch (err) {
      console.error('解析在线状态服务证书失败', err);
    }
  }

  return { baseUrl, apiKey, certPem, certPin };
}

/* 构造带证书 pin 校验的 https.Agent：握手通过且指纹一致后才把连接交给 http 层发送请求头 */
function createPinnedAgent(certPem: string | undefined, expectedPin: string): https.Agent {
  const agent: https.Agent = new https.Agent({ keepAlive: false });

  agent.createConnection = function(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: tls.TLSSocket) => void
  ): tls.TLSSocket | undefined {
    const host: string = String(options.host ?? options.hostname ?? '127.0.0.1');
    const port: number = Number(options.port ?? 443);
    let settled: boolean = false;

    const finish: (err: Error | null, stream?: tls.TLSSocket) => void = (err: Error | null, stream?: tls.TLSSocket): void => {
      if (settled) return;

      settled = true;
      callback?.(err, stream as tls.TLSSocket);
    };

    const socket: tls.TLSSocket = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      ca: certPem,
      rejectUnauthorized: false // 由下方 secureConnect 在写任何 HTTP 字节前执行严格指纹 pin 校验
    });

    socket.once('error', (err: Error): void => finish(err));
    socket.once('close', (): void => finish(new Error('TLS 连接在校验完成前关闭')));
    socket.once('secureConnect', (): void => {
      const peer: tls.PeerCertificate = socket.getPeerCertificate(false);
      const actualPin: string = normalizePin(peer?.fingerprint256);

      if (!actualPin || actualPin !== expectedPin) {
        const err: Error = new PresenceApiError(`证书指纹不匹配（收到 ${ actualPin || '无' }）`);

        socket.destroy(err);
        finish(err);

        return;
      }

      finish(null, socket);
    });

    return undefined;
  };

  return agent;
}

export async function requestPresenceJson<T>(
  method: 'GET' | 'POST',
  endpoint: string,
  options: {
    config?: PresenceClientConfig;
    body?: unknown;
    auth?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const config: PresenceClientConfig | undefined = options.config ?? getPresenceConfig();

  if (!config) throw new PresenceApiError('未配置在线状态服务');

  const url: URL = new URL(endpoint, `${ config.baseUrl }/`);
  const isHttps: boolean = url.protocol === 'https:';
  const payload: string | undefined = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    Accept: 'application/json'
  };

  if (options.auth !== false) headers.Authorization = `Bearer ${ config.apiKey }`;

  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'));
  }

  const expectedPin: string | undefined = isHttps ? normalizePin(config.certPin) || undefined : undefined;
  const agent: https.Agent | undefined = isHttps && expectedPin ? createPinnedAgent(config.certPem, expectedPin) : undefined;

  return await new Promise<T>((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
    const transport: typeof https | typeof http = isHttps ? https : http;
    const req: http.ClientRequest = transport.request(url, {
      method,
      headers,
      agent,
      ca: !agent && isHttps && config.certPem ? config.certPem : undefined,
      rejectUnauthorized: isHttps ? true : undefined
    }, (res: http.IncomingMessage): void => {
      const chunks: Array<Buffer> = [];

      res.on('data', (chunk: Buffer): void => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', (): void => {
        const status: number = res.statusCode ?? 0;
        const text: string = Buffer.concat(chunks).toString('utf8');

        if (status < 200 || status >= 300) {
          reject(new PresenceApiError(`在线状态服务返回 ${ status }${ text ? `: ${ text.slice(0, 160) }` : '' }`, status));

          return;
        }

        try {
          resolve(JSON.parse(text) as T);
        } catch (err) {
          reject(new PresenceApiError(`在线状态服务响应不是有效的 JSON: ${ err instanceof Error ? err.message : String(err) }`, status));
        }
      });
    });

    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, (): void => {
      req.destroy(new PresenceApiError('在线状态服务请求超时'));
    });
    req.on('error', (err: Error): void => {
      reject(err instanceof PresenceApiError ? err : new PresenceApiError(err.message));
    });

    if (payload !== undefined) req.write(payload);

    req.end();
  });
}

/* POST /list —— 推送某用户的完整关注清单（全量，服务端自行 diff；超时 ≥60s） */
export function pushFollowList(
  userId: string,
  members: Array<ListMemberInput>,
  config?: PresenceClientConfig
): Promise<ListSyncResponse> {
  if (!userId) return Promise.reject(new PresenceApiError('缺少 userId', 400));

  const cleaned: Array<ListMemberInput> = members.map((item: ListMemberInput): ListMemberInput => (
    item.serverId === undefined
      ? { ownerId: item.ownerId, name: item.name }
      : { ownerId: item.ownerId, name: item.name, serverId: item.serverId }
  ));

  return requestPresenceJson<ListSyncResponse>('POST', '/list', {
    config,
    auth: true,
    body: { userId, members: cleaned },
    timeoutMs: LIST_PUSH_TIMEOUT_MS
  });
}

/* GET /presence?userId=<id> —— 拉取该用户追踪成员的在线快照 */
export function fetchPresence(options: {
  userId?: string;
  config?: PresenceClientConfig;
} = {}): Promise<PresenceResponse> {
  const params: URLSearchParams = new URLSearchParams();

  if (options.userId) params.set('userId', options.userId);

  const query: string = params.toString();
  const endpoint: string = query ? `/presence?${ query }` : '/presence';

  return requestPresenceJson<PresenceResponse>('GET', endpoint, { config: options.config, auth: true });
}

/* GET /events?since=<ms>&userId=<id>&accid=<可选> —— 近 7 天上下线事件（升序），用于补齐时间线 */
export function fetchPresenceEvents(options: {
  since?: number;
  userId?: string;
  accid?: string;
  config?: PresenceClientConfig;
} = {}): Promise<PresenceEventsResponse> {
  const params: URLSearchParams = new URLSearchParams();

  if (options.since !== undefined && Number.isFinite(options.since) && options.since >= 0) {
    params.set('since', String(Math.floor(options.since)));
  }

  if (options.userId) params.set('userId', options.userId);

  if (options.accid) params.set('accid', options.accid);

  const query: string = params.toString();
  const endpoint: string = query ? `/events?${ query }` : '/events';

  return requestPresenceJson<PresenceEventsResponse>('GET', endpoint, { config: options.config, auth: true });
}

/* GET /health —— 健康检查（默认不带鉴权头） */
export function fetchPresenceHealth(
  config?: PresenceClientConfig,
  options: { auth?: boolean } = {}
): Promise<PresenceHealthResponse> {
  return requestPresenceJson<PresenceHealthResponse>('GET', '/health', { config, auth: options.auth ?? false });
}
