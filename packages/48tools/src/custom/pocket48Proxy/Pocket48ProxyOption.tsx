import { Fragment, useState, useEffect, type ReactElement, type Dispatch as D, type SetStateAction as S, type MouseEvent } from 'react';
import { Button, Modal, Form, Alert, Input, Badge, Tooltip, message, type FormInstance } from 'antd';
import type { Store } from 'antd/es/form/interface';
import type { Rule } from 'rc-field-form/es/interface';
import type { UseMessageReturnType } from '@48tools-types/antd';
import { GlobalOutlined as IconGlobalOutlined } from '@ant-design/icons';
import { POCKET48_PROXY_STORAGE_KEY, getPocket48LocalConfig } from './pocket48Proxy';
import { checkPocket48Proxy, type ProxyState } from '../pocket48Api/apiErrorText';

const proxyStateText: Record<ProxyState, string> = {
  ok: '代理运行中',
  down: '代理没有在运行（连不上代理端口）',
  direct: '没有配置代理，直连'
};

const proxyStateBadge: Record<ProxyState, 'success' | 'error' | 'default'> = {
  ok: 'success',
  down: 'error',
  direct: 'default'
};

/* 每 10 秒检查一次代理状态，显示在按钮上 */
function useProxyState(refreshKey: unknown): ProxyState | undefined {
  const [state, setState]: [ProxyState | undefined, D<S<ProxyState | undefined>>] = useState(undefined);

  useEffect(function(): () => void {
    let active: boolean = true;

    function check(): void {
      checkPocket48Proxy().then((value: ProxyState): void => {
        active && setState(value);
      }).catch((): void => undefined);
    }

    check();

    const timer: number = window.setInterval(check, 10_000);

    return (): void => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

  return state;
}

const proxyRules: Array<Rule> = [
  { pattern: /^\s*(https?:\/\/\S+)?\s*$/i, message: '请输入 http:// 或 https:// 开头的代理地址，留空表示直连' }
];

/* 配置口袋48接口（pocketapi.48.cn）的代理 */
function Pocket48ProxyOption(props: {}): ReactElement {
  const [visible, setVisible]: [boolean, D<S<boolean>>] = useState(false); // 弹出层
  const [messageApi, messageContextHolder]: UseMessageReturnType = message.useMessage();
  const [form]: [FormInstance] = Form.useForm();
  const fileProxy: string = getPocket48LocalConfig().proxy?.trim() ?? '';
  const proxyState: ProxyState | undefined = useProxyState(visible); // 关闭配置弹窗后马上重新检查

  // 打开配置弹出层
  function handleOpenPocket48ProxyClick(event: MouseEvent): void {
    const saved: string | null = localStorage.getItem(POCKET48_PROXY_STORAGE_KEY);

    form.setFieldsValue({ proxy: saved ?? fileProxy });
    setVisible(true);
  }

  // 取消
  function handleClosePocket48ProxyModalClick(event: MouseEvent): void {
    setVisible(false);
  }

  // 确认
  async function handleSetPocket48ProxyClick(event: MouseEvent): Promise<void> {
    let formValue: Store;

    try {
      formValue = await form.validateFields();
    } catch (err) {
      return console.error(err);
    }

    const proxy: string = (formValue.proxy ?? '').trim();

    if (proxy === fileProxy) {
      // 和 local/pocket48.json 一致时不单独保存，以后改文件就能生效
      localStorage.removeItem(POCKET48_PROXY_STORAGE_KEY);
    } else {
      // 空字符串表示直连
      localStorage.setItem(POCKET48_PROXY_STORAGE_KEY, proxy);
    }

    messageApi.success(proxy ? '配置成功！口袋48接口将通过代理请求。' : '配置成功！口袋48接口将直连。');
    handleClosePocket48ProxyModalClick(event);
  }

  // 恢复为 local/pocket48.json 的配置
  function handleResetPocket48ProxyClick(): void {
    form.setFieldsValue({ proxy: fileProxy });
  }

  // 直连
  function handleDirectPocket48ProxyClick(): void {
    form.setFieldsValue({ proxy: '' });
  }

  return (
    <Fragment>
      <Tooltip title={ proxyState ? proxyStateText[proxyState] : undefined }>
        <Button id="pocket48-proxy" icon={ <IconGlobalOutlined /> } onClick={ handleOpenPocket48ProxyClick }>
          口袋48代理
          { proxyState ? <Badge className="ml-[2px]" status={ proxyStateBadge[proxyState] } /> : null }
        </Button>
      </Tooltip>
      <Modal title="口袋48代理"
        open={ visible }
        width={ 600 }
        centered={ true }
        maskClosable={ false }
        onOk={ handleSetPocket48ProxyClick }
        onCancel={ handleClosePocket48ProxyModalClick }
      >
        <Form form={ form }>
          <Form.Item name="proxy" label="代理地址" rules={ proxyRules }>
            <Input placeholder="例如：http://127.0.0.1:10819，留空表示直连" />
          </Form.Item>
          <div className="mb-[16px] text-right">
            <Button onClick={ handleDirectPocket48ProxyClick }>直连</Button>
            <Button className="ml-[6px]" onClick={ handleResetPocket48ProxyClick }>恢复默认</Button>
          </div>
          <Alert type="info" message={
            <Fragment>
              <p>只有口袋48接口（pocketapi.48.cn）的请求走这个代理，其他请求照常直连。海外网络访问口袋48接口会被拒绝（403），需要国内代理。</p>
              <p>
                默认值来自
                <i className="mx-[3px]">local/pocket48.json</i>
                ：
                <i className="mx-[3px]">{ fileProxy || '（未找到，默认直连）' }</i>
              </p>
            </Fragment>
          } />
        </Form>
      </Modal>
      { messageContextHolder }
    </Fragment>
  );
}

export default Pocket48ProxyOption;
