import type { ReactElement } from 'react';
import { Space } from 'antd';
import ButtonLink from '../../components/ButtonLink/ButtonLink';
import { backButtonProps } from '../../custom/theme/backButton';

function Agreement(props: {}): ReactElement {
  return (
    <div className="py-[32px] text-center">
      <Space>
        <ButtonLink linkProps={{ to: '/' }} buttonProps={ backButtonProps }>返回</ButtonLink>
        <ButtonLink linkProps={{ to: '/Agreement/Power' }}>软件声明</ButtonLink>
        <ButtonLink linkProps={{ to: '/Agreement/Credits' }}>许可证和开源软件</ButtonLink>
      </Space>
    </div>
  );
}

export default Agreement;