import { createContext, type Context, type ReactElement } from 'react';

export interface Theme {
  ChangeThemeElement?: ReactElement;
  isDark?: boolean;
  theme?: 'light' | 'dark' | 'system';                        // 现在选的是哪一种（custom/settings/SettingsPage 用）
  changeTheme?: (value: 'light' | 'dark' | 'system') => void; // 直接切换，不用先打开弹窗
}

const ThemeContext: Context<Theme> = createContext({});

export default ThemeContext;