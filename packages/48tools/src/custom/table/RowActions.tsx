import type { ReactElement, MouseEvent } from 'react';
import { Button, Dropdown, Popconfirm, Space } from 'antd';
import { MoreOutlined as IconMoreOutlined } from '@ant-design/icons';

/**
 * 表格每一行的操作按钮：最常用的一两个直接显示，其余收进「更多」菜单。
 * 原来每行有六七个按钮排成两排，表格又宽又挤；任务进行中时只显示「停止」。
 * 接入点：Pocket48Record.tsx、Pocket48Live.tsx 的「操作」列。
 */
export interface RowAction {
  key: string;
  label: string;
  onClick: (event: MouseEvent) => unknown;
  icon?: ReactElement;
  primary?: boolean;
}

interface RowActionsProps {
  busy: boolean;                  // 这一行正在下载 / 录制
  stopLabel: string;              // 例如「停止下载」
  stopConfirm: string;            // 确认提示
  onStop: (event?: MouseEvent) => void;
  busyActions?: Array<RowAction>; // 进行中时额外显示的按钮（例如「重试」）
  main: Array<RowAction>;         // 直接显示的按钮
  more: Array<RowAction>;         // 收进「更多」的操作
}

function RowActions(props: RowActionsProps): ReactElement {
  const { busy, stopLabel, stopConfirm, onStop, busyActions = [], main, more }: RowActionsProps = props;
  const moreButton: ReactElement | null = more.length > 0 ? (
    <Dropdown trigger={ ['click'] }
      placement="bottomRight"
      menu={{
        items: more.map((action: RowAction): { key: string; label: string; icon?: ReactElement } => ({
          key: action.key,
          label: action.label,
          icon: action.icon
        })),
        onClick(info: { key: string; domEvent: unknown }): void {
          more.find((action: RowAction): boolean => action.key === info.key)?.onClick(info.domEvent as MouseEvent);
        }
      }}
    >
      <Button icon={ <IconMoreOutlined /> } aria-label="更多操作" />
    </Dropdown>
  ) : null;

  return (
    <Space size={ 6 }>
      {
        busy ? (
          <Popconfirm title={ stopConfirm } onConfirm={ (event?: MouseEvent): void => onStop(event) }>
            <Button type="primary" danger={ true }>{ stopLabel }</Button>
          </Popconfirm>
        ) : main.map((action: RowAction): ReactElement => (
          <Button key={ action.key }
            type={ action.primary ? 'primary' : 'default' }
            icon={ action.icon }
            onClick={ action.onClick }
          >
            { action.label }
          </Button>
        ))
      }
      {
        busy ? busyActions.map((action: RowAction): ReactElement => (
          <Button key={ action.key } icon={ action.icon } onClick={ action.onClick }>{ action.label }</Button>
        )) : null
      }
      { moreButton }
    </Space>
  );
}

export default RowActions;
