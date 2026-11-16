import type { ButtonProps } from 'antd';
import { ArrowLeftOutlined as IconArrowLeftOutlined } from '@ant-design/icons';

/* 统一的「返回」按钮样式（替代原来红色的 primary danger 按钮） */
export const backButtonProps: ButtonProps = {
  color: 'default',
  variant: 'filled',
  icon: <IconArrowLeftOutlined />
};
