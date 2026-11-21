import { Fragment, useState, type ReactElement, type ReactNode, type ChangeEvent, type Dispatch as D, type SetStateAction as S } from 'react';
import { Button, Input, Segmented, Switch, Typography } from 'antd';
import { getPocket48LocalConfig } from '../pocket48Proxy/pocket48Proxy';
import { useSettingOverrides, setSetting, resolveSetting, type CustomSettings, type SttProvider } from '../settings/settingsStore';
import Row from '../settings/SettingsRow';
import { resolveSttConfig } from './transcribeStore';
import { testSttConfig, sttDefaults, TranscribeError, type SttConfig } from './transcribeApi';

/**
 * 设置页面里的「语音转文字」：选接口类型，填 API key、模型、接口地址，点「测试」检查能不能用。
 *   - Google Gemini：只需要填 API key（模型和地址有默认值）
 *   - OpenAI 兼容：用别的服务商（比如国内的）时选这个，key、模型、地址都要自己填
 * 「参考聊天内容」开关：把语音前后的文字一起发过去，帮模型把昵称、礼物名写对（默认开，见 ./voiceHints）。
 * 两种接口各存各的 key：切换类型不会把一个服务商的 key 发给另一个。
 * key 只保存在这台电脑上（和其他设置一样在 localStorage；也可以写在 local/pocket48.json 里，键名同设置项），
 * 只会发给这里填的接口地址。
 * 接入点：custom/settings/SettingsPage.tsx。
 */
type SettingKey = 'sttGeminiKey' | 'sttGeminiModel' | 'sttGeminiBaseUrl' | 'sttOpenaiKey' | 'sttOpenaiModel' | 'sttOpenaiBaseUrl';

const providerOptions: Array<{ label: string; value: SttProvider }> = [
  { label: 'Google Gemini', value: 'gemini' },
  { label: 'OpenAI 兼容', value: 'openai' }
];

const keysOf: Record<SttProvider, { key: SettingKey; model: SettingKey; baseUrl: SettingKey }> = {
  gemini: { key: 'sttGeminiKey', model: 'sttGeminiModel', baseUrl: 'sttGeminiBaseUrl' },
  openai: { key: 'sttOpenaiKey', model: 'sttOpenaiModel', baseUrl: 'sttOpenaiBaseUrl' }
};

function TranscribeOption(props: {}): ReactElement {
  const overrides: CustomSettings = useSettingOverrides();
  const config: SttConfig = resolveSttConfig(overrides);
  const names: { key: SettingKey; model: SettingKey; baseUrl: SettingKey } = keysOf[config.provider];
  const fromFile: boolean = !overrides[names.key] && !!(getPocket48LocalConfig() as CustomSettings)[names.key]; // key 来自 local/pocket48.json
  const [testing, setTesting]: [boolean, D<S<boolean>>] = useState(false);
  const [result, setResult]: [{ ok: boolean; text: string } | null, D<S<{ ok: boolean; text: string } | null>>]
    = useState<{ ok: boolean; text: string } | null>(null);

  function handleChange(key: SettingKey): (event: ChangeEvent<HTMLInputElement>) => void {
    return function(event: ChangeEvent<HTMLInputElement>): void {
      setSetting(key, event.target.value.trim());
      setResult(null);
    };
  }

  // 默认开：只有关掉时才保存（保存成 false），打开就是恢复默认
  function handleHintsChange(checked: boolean): void {
    setSetting('sttHints', checked ? undefined : false);
  }

  function handleProviderChange(value: SttProvider): void {
    setSetting('sttProvider', value === 'gemini' ? undefined : value);
    setResult(null);
  }

  async function handleTestClick(): Promise<void> {
    setTesting(true);
    setResult(null);

    try {
      setResult({ ok: true, text: await testSttConfig(config) });
    } catch (err) {
      if (!(err instanceof TranscribeError)) console.error(err);

      setResult({ ok: false, text: err instanceof TranscribeError ? err.message : '测试失败，请稍后再试' });
    }

    setTesting(false);
  }

  return (
    <Fragment>
      <Row label="接口类型" hint="语音会发给这里配置的服务商来识别，转好的文字存在本机，同一条语音只转一次。转过的语音文件也存一份在本机，保留 6 个月。">
        <Segmented options={ providerOptions } value={ config.provider } onChange={ handleProviderChange } />
      </Row>
      <Row label="API key" hint="只保存在这台电脑上（用 Windows 的加密功能加密后保存），只会发给下面的接口地址。">
        <Input.Password value={ overrides[names.key] ?? '' }
          placeholder={ fromFile ? '已从 local/pocket48.json 读取' : '没有填写' }
          autoComplete="off"
          spellCheck={ false }
          onChange={ handleChange(names.key) }
        />
      </Row>
      <Row label="模型"
        hint={ config.provider === 'gemini'
          ? `不填就用 ${ sttDefaults.gemini.model }。`
          : '填服务商提供的语音转写模型的名称。' }
      >
        <Input value={ overrides[names.model] ?? '' }
          placeholder={ sttDefaults[config.provider].model || '没有填写' }
          spellCheck={ false }
          onChange={ handleChange(names.model) }
        />
      </Row>
      <Row label="接口地址"
        hint={ config.provider === 'gemini'
          ? '一般不用填。'
          : '服务商的接口地址，一般以 /v1 结尾；程序会请求它下面的 /audio/transcriptions。' }
      >
        <Input value={ overrides[names.baseUrl] ?? '' }
          placeholder={ sttDefaults[config.provider].baseUrl || 'https://…/v1' }
          spellCheck={ false }
          onChange={ handleChange(names.baseUrl) }
        />
      </Row>
      <Row label="参考聊天内容">
        <Switch checked={ resolveSetting(overrides, 'sttHints') !== false } onChange={ handleHintsChange } />
      </Row>
      <Row label="测试" hint="用上面的 key 取一次模型列表，确认 key 能用、模型名称没写错。不会产生转写费用。">
        <Button loading={ testing } disabled={ !config.apiKey } onClick={ handleTestClick }>测试</Button>
        {
          result ? (
            <Typography.Text className="ml-[12px]" type={ result.ok ? 'success' : 'danger' }>{ result.text }</Typography.Text>
          ) : null
        }
      </Row>
    </Fragment>
  );
}

export default TranscribeOption;
