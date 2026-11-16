import { shell } from 'electron';

/**
 * 只用系统浏览器打开 http(s) 链接。
 * 消息、附件里的地址来自服务器数据，直接交给 shell.openExternal 可能会启动 file:、ms-xxx: 等协议的本地程序。
 */
export function safeOpenExternal(url: string | null | undefined): void {
  if (!url) return;

  try {
    const { protocol }: URL = new URL(url);

    if (protocol === 'http:' || protocol === 'https:') {
      shell.openExternal(url);
    } else {
      console.warn('已阻止打开非 http(s) 链接：', url);
    }
  } catch {
    console.warn('无效的链接：', url);
  }
}
