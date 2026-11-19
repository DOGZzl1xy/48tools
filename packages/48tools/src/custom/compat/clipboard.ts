/**
 * 复制文字到剪贴板。
 * Electron 44 起，界面（渲染进程）里不能再用 electron 的 clipboard 模块（import 出来是 undefined，一调用就报错）。
 * 这里提供同名、同用法的替代：原版文件只需要把 `import { clipboard } from 'electron'` 换成从这里 import。
 * 用的是浏览器自带的剪贴板接口；它失败时（比如窗口当时不在前台）退回到老办法（选中一段隐藏的文字再执行复制）。
 */
function legacyCopy(text: string): void {
  const textarea: HTMLTextAreaElement = document.createElement('textarea');

  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
  } catch (err) {
    console.error(err);
  }

  textarea.remove();
}

export const clipboard: { writeText(text: string): void } = {
  writeText(text: string): void {
    if (!navigator.clipboard?.writeText) {
      legacyCopy(text);

      return;
    }

    navigator.clipboard.writeText(text).catch(function(err: unknown): void {
      console.error(err);
      legacyCopy(text);
    });
  }
};
