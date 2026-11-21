import { use, useLayoutEffect, type ReactElement, type PropsWithChildren } from 'react';
import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import ThemeContext, { type Theme } from '../Theme/ThemeContext';
import { createModernTheme } from '../../../custom/theme/modernTheme';
import { setTwoToneColor } from '@ant-design/icons';
import { accentTokens, colorVariables, type AccentTokens } from '../../../custom/theme/accent';
import { useSettingOverrides } from '../../../custom/settings/settingsStore';
import '../../../custom/theme/theme.global.sass';

/* antd ConfigProvider */
function AntdConfig(props: Required<PropsWithChildren>): ReactElement {
  const { isDark }: Theme = use(ThemeContext);
  const { accentColor }: { accentColor?: string } = useSettingOverrides(); // 设置页里选的主题色
  const accent: AccentTokens = accentTokens(accentColor, isDark);

  // 双色图标（工具、礼物等）也用主题色；要在子组件渲染之前设置，所以放在这里而不是 effect 里（同样的值重复设置没有影响）
  setTwoToneColor(accent.text);

  // 主题色和团队色放到根元素的 CSS 变量里，样式文件里用（custom/theme/accent）
  useLayoutEffect(function(): void {
    for (const [name, value] of Object.entries(colorVariables(accentColor, isDark))) {
      document.documentElement.style.setProperty(name, value);
    }
  }, [accentColor, isDark]);

  return (
    <ConfigProvider locale={ zhCN }
      theme={ createModernTheme(isDark, accent) }
    >
      <App component={ false }>
        { props.children }
      </App>
    </ConfigProvider>
  );
}

export default AntdConfig;
