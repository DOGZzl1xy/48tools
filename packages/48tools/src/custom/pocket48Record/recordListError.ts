import { pocket48ErrorText, pocket48FailText } from '../pocket48Api/apiErrorText';

/**
 * 录播列表加载失败的提示（具体说明见 custom/pocket48Api/apiErrorText）。
 * 接入点：Pocket48Record.tsx。
 */
const PREFIX: string = '录播列表加载失败！';

export function recordListErrorText(err: unknown): Promise<string> {
  return pocket48ErrorText(PREFIX, err);
}

/* 接口返回 success: false 时的提示 */
export function recordListFailText(message: string | undefined): string {
  return pocket48FailText(PREFIX, message);
}
