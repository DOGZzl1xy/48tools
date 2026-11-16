// @ts-expect-error
import got, { type Got, type Options } from 'got';
import { pocket48Agent } from './pocket48Proxy';

/**
 * 给口袋48服务用的 got 实例：只对 pocketapi.48.cn 的请求生效，其他请求（视频、弹幕文件等）保持原样。
 *   1. 配置了口袋48代理时，请求走代理（见 ./pocket48Proxy）
 *   2. 没有单独设置超时的接口请求，默认 20 秒超时，避免网络卡住时界面一直转圈
 * 接入点：services/48/index.ts 和 services/48/login/index.ts 把 got 换成这个实例。
 */
const POCKET48_API_HOST: string = 'pocketapi.48.cn';
const API_TIMEOUT: number = 20_000;

function isPocket48Api(url: URL | string | undefined): boolean {
  if (!url) return false;

  try {
    return new URL(String(url)).hostname === POCKET48_API_HOST;
  } catch {
    return false;
  }
}

const pocket48Got: Got = got.extend({
  hooks: {
    beforeRequest: [
      function(options: Options): void {
        if (!isPocket48Api(options.url)) return;

        const agent: ReturnType<typeof pocket48Agent> = pocket48Agent();

        if (agent) options.agent = agent;

        // got 的默认 timeout 对象带有各个键，但值都是 undefined
        if (Object.values(options.timeout ?? {}).every((value: unknown): boolean => value === undefined)) {
          options.timeout = { request: API_TIMEOUT };
        }
      }
    ]
  }
});

export default pocket48Got;
