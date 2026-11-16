import type { ThemeConfig } from 'antd';
import darkDerivative from 'antd/es/theme/themes/dark/index';
import { cyan } from '@ant-design/colors';

/**
 * 现代化的 antd 主题：系统界面字体、更大的圆角、去掉按钮阴影、分层的暗黑背景。
 * 接入点：components/basic/AntdConfig/AntdConfig.tsx 用 createModernTheme(isDark) 生成 theme。
 * 暗黑背景色要和 components/basic/Theme/stylesheet.pug 里 body 的背景色保持一致。
 */

/* 系统界面字体：Windows 优先 Segoe UI Variable / 微软雅黑 UI，macOS 优先苹方 */
const fontFamily: string = [
  "'Segoe UI Variable Text'",
  "'Segoe UI'",
  '-apple-system',
  'BlinkMacSystemFont',
  "'PingFang SC'",
  "'Microsoft YaHei UI'",
  "'Microsoft YaHei'",
  "'Helvetica Neue'",
  'Arial',
  'sans-serif'
].join(', ');

/* 暗黑模式的背景色 */
export const layoutBgDark: string = '#0f1115';

export function createModernTheme(isDark: boolean | undefined): ThemeConfig {
  return {
    algorithm: isDark ? darkDerivative : undefined,
    token: {
      // 浅色下用深一级的青色，白字对比度更好
      colorPrimary: isDark ? cyan.primary : cyan[6],
      fontFamily,
      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusLG: 12,
      // 暗黑模式不用纯黑，组件背景会在此基础上逐层变亮
      ...(isDark ? { colorBgBase: layoutBgDark } : {})
    },
    components: {
      Button: {
        fontWeight: 500,
        defaultShadow: 'none',
        primaryShadow: 'none',
        dangerShadow: 'none'
      },
      Table: {
        headerSplitColor: 'transparent'
      },
      Modal: {
        titleFontSize: 17
      }
    }
  };
}
