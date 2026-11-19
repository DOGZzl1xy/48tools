import { use, type ReactElement, type PropsWithChildren } from 'react';
import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import ThemeContext, { type Theme } from '../Theme/ThemeContext';
import { createModernTheme } from '../../../custom/theme/modernTheme';
import { useSettingOverrides, accentColorOf } from '../../../custom/settings/settingsStore';

/* antd ConfigProvider */
function AntdConfig(props: Required<PropsWithChildren>): ReactElement {
  const { isDark }: Theme = use(ThemeContext);
  const { accentColor }: { accentColor?: string } = useSettingOverrides(); // 设置页里选的主题色

  return (
    <ConfigProvider locale={ zhCN }
      theme={ createModernTheme(isDark, accentColorOf(accentColor, isDark)) }
    >
      <App component={ false }>
        { props.children }
      </App>
    </ConfigProvider>
  );
}

export default AntdConfig;