import { useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Checkbox } from 'antd';
import type { GrabActions } from './replayGrabCore';

interface AutoGrabActionsFormProps {
  initial: GrabActions;
  clipUnavailable?: string;                 // 现在做不了切片的原因（没设置好 Gemini 之类）
  onChange(actions: GrabActions): void;
}

type ActionKey = 'full' | 'clip';

/**
 * 开始自动抓取时弹出的选择：直播结束后要完整录播、切片，还是都要（用户 2026-11-23 定的）。
 * 接入点：pages/48/Pocket48/Pocket48Live/Pocket48Live.tsx（「开始自动抓取」）。流程见 ./replayGrabCore。
 */
function AutoGrabActionsForm(props: AutoGrabActionsFormProps): ReactElement {
  const { initial, clipUnavailable, onChange }: AutoGrabActionsFormProps = props;
  const [value, setValue]: [Array<ActionKey>, D<S<Array<ActionKey>>>] = useState<Array<ActionKey>>(
    (['full', 'clip'] as Array<ActionKey>).filter((key: ActionKey): boolean => initial[key]));

  function handleChange(next: Array<ActionKey>): void {
    setValue(next);
    onChange({ full: next.includes('full'), clip: next.includes('clip') });
  }

  return (
    <div>
      <p className="mb-[12px] text-[13px] opacity-80">
        盯着的成员开播时只记下来，不录直播流；直播结束后等官方录播出来再下载（画面完整，带弹幕）。
      </p>
      <Checkbox.Group className="flex flex-col gap-[10px]" value={ value } onChange={ handleChange }>
        <Checkbox value="full">完整直播：下载整场录播和弹幕</Checkbox>
        <Checkbox value="clip">切片：用录播找爆点，等你挑好再切</Checkbox>
      </Checkbox.Group>
      <p className="mt-[12px] mb-0 text-[12px] opacity-70">
        {
          value.length === 0
            ? '至少勾一个。'
            : (value.length === 2 ? '录播和切片都留着。' : (value[0] === 'clip' ? '只勾切片：录播留到你挑好、切完，然后删掉，只留切片（电台也切）。' : '电台下载的是录音和一张封面。'))
        }
      </p>
      {
        clipUnavailable && value.includes('clip')
          ? <p className="mt-[6px] mb-0 text-[12px] text-[#d4380d]">现在还做不了切片：{ clipUnavailable }。到时候录播会照样下载、保留着。</p>
          : null
      }
    </div>
  );
}

export default AutoGrabActionsForm;
