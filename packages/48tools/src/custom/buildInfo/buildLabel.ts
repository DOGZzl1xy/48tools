import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

/**
 * 在窗口标题后面加上自定义版本的标识，例如「48tools - 4.19.4 · 自定义版 63cb864（11-18）」，
 * 方便和官方版区分、确认运行的是哪次提交打的包。
 * 标识来自打包脚本（scripts/custom/packWin64.mjs）写进程序目录的 resources/app/build-info.json；
 * 开发模式没有这个文件，标题不变。
 * 接入点：src/index.tsx 里 import 一次。
 */
interface BuildInfo {
  commit?: string;
  date?: string;   // YYYY-MM-DD
  dirty?: boolean; // 打包时有没有未提交的改动
}

export function formatBuildLabel(info: BuildInfo): string {
  if (!info.commit) return '';

  const day: string = info.date ? `（${ info.date.slice(5) }）` : '';

  return ` · 自定义版 ${ info.commit }${ info.dirty ? '+' : '' }${ day }`;
}

function readBuildInfo(): BuildInfo {
  try {
    const file: string = path.join(process.resourcesPath, 'app', 'build-info.json');

    return JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }));
  } catch {
    return {};
  }
}

if (typeof document !== 'undefined') {
  const label: string = formatBuildLabel(readBuildInfo());

  if (label && !document.title.includes(label)) document.title += label;
}
