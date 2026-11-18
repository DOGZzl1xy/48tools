import { useEffect, useState, type Dispatch as D, type SetStateAction as S } from 'react';
import { checkPocket48Proxy, type ProxyState } from '../pocket48Api/apiErrorText';

/**
 * 口袋48代理的运行状态（每 10 秒检查一次），给首页的代理按钮和侧边栏用。
 */
export const proxyStateText: Record<ProxyState, string> = {
  ok: '代理运行中',
  down: '代理没有在运行（连不上代理端口）',
  direct: '没有配置代理，直连'
};

export const proxyStateBadge: Record<ProxyState, 'success' | 'error' | 'default'> = {
  ok: 'success',
  down: 'error',
  direct: 'default'
};

/**
 * @param { unknown } [refreshKey] - 变化时马上重新检查（例如关闭代理配置弹窗后）
 */
export function useProxyState(refreshKey?: unknown): ProxyState | undefined {
  const [state, setState]: [ProxyState | undefined, D<S<ProxyState | undefined>>] = useState(undefined);

  useEffect(function(): () => void {
    let active: boolean = true;

    function check(): void {
      checkPocket48Proxy().then((value: ProxyState): void => {
        active && setState(value);
      }).catch((): void => undefined);
    }

    check();

    const timer: number = window.setInterval(check, 10_000);

    return (): void => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

  return state;
}
