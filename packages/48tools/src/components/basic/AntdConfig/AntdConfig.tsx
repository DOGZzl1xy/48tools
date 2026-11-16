import { use, type ReactElement, type PropsWithChildren } from 'react';
import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import ThemeContext, { type Theme } from '../Theme/ThemeContext';
import { createModernTheme } from '../../../custom/theme/modernTheme';

/* antd ConfigProvider */
function AntdConfig(props: Required<PropsWithChildren>): ReactElement {
  const { isDark }: Theme = use(ThemeContext);

  return (
    <ConfigProvider locale={ zhCN }
      theme={ createModernTheme(isDark) }
    >
      <App component={ false }>
        { props.children }
      </App>
    </ConfigProvider>
  );
}

export default AntdConfig;