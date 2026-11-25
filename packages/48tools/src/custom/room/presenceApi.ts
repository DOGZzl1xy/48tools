import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { getLocalConfigRoot, getPocket48LocalConfig, type Pocket48LocalConfig } from '../pocket48Proxy/pocket48Proxy';

/**
 * 远端在线状态服务的 HTTPS 客户端：
 *   - 服务地址、鉴权密钥和自签证书配置全部来自本机 local/pocket48.json，不写进代码库
 *   - 除 /health 外，请求统一带 Authorization: Bearer <key>
 *   - 支持自签证书 pin：在 TLS 握手完成后、发送任何 HTTP 请求头之前校验对端证书的 SHA-256 指纹，
 *     指纹不匹配会立即断开，避免鉴权头泄露给未授权对端
 *   - 直连远端服务，不走口袋48 专用代理
 *   - 服务地址必须是 https（密钥是放在请求头里发出去的，http 等于明文）；只有本机地址（127.0.0.1 / localhost）可以用 http
 */
export interface PresenceClientConfig {
  baseUrl: string;
  apiKey: string;
  certPem?: string;
  certPin?: string;
}

export interface PresenceLinkInfo {
  connected: boolean;
  lastPollAt: number | null;
  node?: string | null;
}

export interface PresenceServerMember {
  accid: string;
  name: string;
  online: boolean;
  since: number | null;
  stale: boolean;
}

export interface PresenceResponse {
  serverTime: number;
  link: PresenceLinkInfo;
  members: Array<PresenceServerMember>;
}

export interface RosterMember {
  accid: string;
  name: string;
  serverId?: number;
}

export interface RosterResponse {
  ok?: boolean;
  members: Array<RosterMember>;
}

export interface PresenceHealthResponse {
  ok: boolean;
  uptime?: number;
  connected?: boolean;
  members?: number;
  lastPollAt?: number | null;
}

export interface PresenceServerEvent {
  t: number;
  accid: string;
  name: string;
  online: boolean;
}

export interface PresenceEventsResponse {
  serverTime: number;
  retentionMs: number;
  events: Array<PresenceServerEvent>;
}

export class PresenceApiError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'PresenceApiError';
    this.statusCode = statusCode;
  }
}

const REQUEST_TIMEOUT_MS: number = 12_000;
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

/* 规范化 SHA-256 指纹：去掉冒号和空白并转大写，方便与 tls peerCertificate.fingerprint256 比对 */
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
  method: 'GET' | 'POST' | 'DELETE',
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

    req.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, (): void => {
      req.destroy(new PresenceApiError('在线状态服务请求超时'));
    });
    req.on('error', (err: Error): void => {
      reject(err instanceof PresenceApiError ? err : new PresenceApiError(err.message));
    });

    if (payload !== undefined) req.write(payload);

    req.end();
  });
}

/* GET /presence —— 获取全部已跟踪成员在线状态 */
export function fetchPresence(config?: PresenceClientConfig): Promise<PresenceResponse> {
  return requestPresenceJson<PresenceResponse>('GET', '/presence', { config, auth: true });
}

/* GET /roster —— 查看服务端当前跟踪名单 */
export function fetchRoster(config?: PresenceClientConfig): Promise<RosterResponse> {
  return requestPresenceJson<RosterResponse>('GET', '/roster', { config, auth: true });
}

/* POST /roster —— 本地新增关注时通知服务端追加名单 */
export function addRosterMember(member: RosterMember, config?: PresenceClientConfig): Promise<RosterResponse> {
  if (!member.accid) return Promise.reject(new PresenceApiError('缺少成员 accid', 400));

  const body: RosterMember = member.serverId === undefined
    ? { accid: member.accid, name: member.name }
    : { accid: member.accid, name: member.name, serverId: member.serverId };

  return requestPresenceJson<RosterResponse>('POST', '/roster', { config, auth: true, body });
}

/* DELETE /roster/{accid} —— 本地取消关注时通知服务端移除 */
export function removeRosterMember(accid: string, config?: PresenceClientConfig): Promise<RosterResponse> {
  return requestPresenceJson<RosterResponse>('DELETE', `/roster/${ encodeURIComponent(accid) }`, { config, auth: true });
}

/* GET /health —— 健康检查（不带鉴权头） */
export function fetchPresenceHealth(config?: PresenceClientConfig): Promise<PresenceHealthResponse> {
  return requestPresenceJson<PresenceHealthResponse>('GET', '/health', { config, auth: false });
}

/* GET /events?since=<ms>&accid=<可选> —— 拉取服务端保留的历史上下线事件（按时间升序，用于补齐关机/断网空档） */
export function fetchPresenceEvents(options: {
  since?: number;
  accid?: string;
  config?: PresenceClientConfig;
} = {}): Promise<PresenceEventsResponse> {
  const params: URLSearchParams = new URLSearchParams();

  if (options.since !== undefined && Number.isFinite(options.since) && options.since >= 0) {
    params.set('since', String(Math.floor(options.since)));
  }

  if (options.accid) params.set('accid', options.accid);

  const query: string = params.toString();
  const endpoint: string = query ? `/events?${ query }` : '/events';

  return requestPresenceJson<PresenceEventsResponse>('GET', endpoint, { config: options.config, auth: true });
}
