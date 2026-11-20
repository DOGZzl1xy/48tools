import type { ReactElement, ReactNode } from 'react';

/**
 * 设置页面里的一行：左边是名称和说明，右边是控件。设置页面的各个部分都用它（样式在 ./settings.global.sass）。
 */
function SettingsRow(props: { label: string; hint?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <b>{ props.label }</b>
        { props.hint ? <small>{ props.hint }</small> : null }
      </div>
      <div className="settings-row-control">{ props.children }</div>
    </div>
  );
}

export default SettingsRow;
