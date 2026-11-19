import type { ThemeConfig } from 'antd';
import darkDerivative from 'antd/es/theme/themes/dark/index';

/**
 * 现代化的 antd 主题：系统界面字体、分层的背景（窗口底色 + 内容面板）、更轻的表格和边框、更快的动效。
 * 接入点：components/basic/AntdConfig/AntdConfig.tsx 用 createModernTheme(isDark) 生成 theme。
 * 窗口底色要和 components/basic/Theme/stylesheet.pug 里 body 的背景色保持一致（避免启动时闪一下）。
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

/* 窗口底色（侧边栏所在的那一层）；内容面板比它亮一级 */
export const layoutBgLight: string = '#f3f4f6';
export const layoutBgDark: string = '#0b0d10';
const containerBgDark: string = '#15181d';

/**
 * @param { boolean | undefined } isDark
 * @param { string } [primary] - 主题色（设置页里选的，见 custom/settings/settingsStore）
 */
export function createModernTheme(isDark: boolean | undefined, primary: string = isDark ? '#13c2c2' : '#08979c'): ThemeConfig {
  return {
    algorithm: isDark ? darkDerivative : undefined,
    token: {
      colorPrimary: primary,
      colorLink: primary,
      fontFamily,
      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusLG: 12,
      colorBgLayout: isDark ? layoutBgDark : layoutBgLight,
      // 暗黑模式不用纯黑，组件背景在此基础上逐层变亮
      ...(isDark ? { colorBgBase: layoutBgDark, colorBgContainer: containerBgDark, colorBgElevated: '#1c2026' } : {}),
      // 动效快一点，操作更跟手
      motionDurationFast: '0.08s',
      motionDurationMid: '0.14s',
      motionDurationSlow: '0.22s',
      wireframe: false
    },
    components: {
      Button: {
        fontWeight: 500,
        defaultShadow: 'none',
        primaryShadow: 'none',
        dangerShadow: 'none'
      },
      Table: {
        headerBg: 'transparent',
        headerSplitColor: 'transparent',
        rowHoverBg: isDark ? 'rgba(255, 255, 255, .04)' : 'rgba(0, 0, 0, .025)',
        cellPaddingBlockMD: 10
      },
      Modal: {
        titleFontSize: 17
      },
      Drawer: {
        paddingLG: 20
      },
      Tag: {
        borderRadiusSM: 6
      },
      Tooltip: {
        fontSize: 12.5
      }
    }
  };
}
