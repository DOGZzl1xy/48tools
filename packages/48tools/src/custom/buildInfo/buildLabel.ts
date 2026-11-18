/**
 * 在窗口标题后面加上「-custom」，例如「48tools - 4.19.4-custom」，和官方版区分。
 * 前面的版本号是上游仓库（原版 48tools）的版本。
 * 具体是哪次提交打的包，记在程序目录的 resources/app/build-info.json 里（打包脚本 scripts/custom/packWin64.mjs 写入）。
 * 接入点：src/index.tsx 里 import 一次。
 */
export const CUSTOM_SUFFIX: string = '-custom';

export function withCustomSuffix(title: string): string {
  return title.endsWith(CUSTOM_SUFFIX) ? title : `${ title }${ CUSTOM_SUFFIX }`;
}

if (typeof document !== 'undefined') {
  document.title = withCustomSuffix(document.title);
}
