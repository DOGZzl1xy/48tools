import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SaveDialogOptions } from 'electron';
import { getLocalConfigRoot } from '../pocket48Proxy/pocket48Proxy';
import { getSetting } from '../settings/settingsStore';

/**
 * 保存文件时默认打开的文件夹。
 * 原版的保存对话框只传文件名，Windows 会打开这个程序上次保存时用的文件夹（同名的 48tools.exe 共用这个记录），
 * 所以默认位置不固定。在「设置」页面（或 local/pocket48.json 的 downloadDir）指定后，所有保存对话框默认打开这个文件夹；
 * 相对路径以仓库根目录（local/ 所在的目录）为基准。没有设置或文件夹不存在时，保持原来的行为。
 * 接入点：utils/remote/dialog.ts 的 showSaveDialog。
 */
/* 把 local/pocket48.json 里配置的文件夹解析成绝对路径；没配置或文件夹不存在时返回 undefined */
export function resolveLocalDir(dir: string | undefined): string | undefined {
  if (!dir || /^\s*$/.test(dir)) return undefined;

  const root: string | undefined = getLocalConfigRoot();
  const resolved: string | undefined = path.isAbsolute(dir) ? dir : (root ? path.resolve(root, dir) : undefined);

  if (!resolved) return undefined;

  try {
    const isDir: boolean = fs.statSync(resolved).isDirectory();

    return isDir ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function getDefaultSaveDir(): string | undefined {
  return resolveLocalDir(getSetting('downloadDir'));
}

/* 只传了文件名时，在前面加上默认文件夹；已经是完整路径的保持不变 */
export function withDefaultSaveDir(options: SaveDialogOptions): SaveDialogOptions {
  const defaultPath: string | undefined = options.defaultPath;

  if (!defaultPath || path.isAbsolute(defaultPath)) return options;

  const dir: string | undefined = getDefaultSaveDir();

  if (!dir) return options;

  return { ...options, defaultPath: path.join(dir, defaultPath) };
}
