/**
 * 测试用：假的 Gemini 接口收到一次请求时，判断问的是哪一步。
 * 看的是要求返回的格式，不看提示的文字：提示词是可以换的（程序自带的和内容包里的写法不一样，见 ./highlightPromptTypes），
 * 格式是程序定的，换哪一份都一样。
 */
export type AskKind = 'find' | 'script' | 'titles' | 'cover' | 'photos' | 'other';

export function askKind(init: { body?: unknown }): AskKind {
  const properties: Record<string, unknown> = JSON.parse(String(init.body ?? '{}'))?.generationConfig?.responseSchema?.properties ?? {};

  if ('highlights' in properties) return 'find';   // findRequest、stageFindRequest

  if ('lines' in properties) return 'script';      // scriptRequest

  if ('titles' in properties) return 'titles';     // stageTitlesRequest

  if ('best' in properties) return 'cover';        // coverRequest

  if ('order' in properties) return 'photos';      // photoRankRequest

  return 'other';
}
