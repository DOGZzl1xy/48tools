import { ipcRenderer } from 'electron';
import { SecretChannel } from '@48tools/main/src/custom/secretChannel';

/**
 * 加密、解密要保存到本机的 API key（主进程用系统的加密功能来做，见 main/src/custom/secretStore）。
 * 加密后的内容前面带 PREFIX；系统不支持加密时原样保存（和以前一样是明文）。
 */
const PREFIX: string = 'enc:v1:';

function call(channel: SecretChannel, value: string): string | null {
  try {
    const result: unknown = ipcRenderer.sendSync(channel, value);

    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

/* 明文 → 要保存的内容 */
export function sealSecret(text: string): string {
  if (text === '' || text.startsWith(PREFIX)) return text;

  const data: string | null = call(SecretChannel.Encrypt, text);

  return data === null ? text : `${ PREFIX }${ data }`;
}

/* 保存的内容 → 明文。sealed：保存的是不是加密过的；解不开时 text 是 undefined */
export function openSecret(saved: string): { text?: string; sealed: boolean } {
  if (!saved.startsWith(PREFIX)) return { text: saved, sealed: false };

  const text: string | null = call(SecretChannel.Decrypt, saved.slice(PREFIX.length));

  return { text: text ?? undefined, sealed: true };
}
