import { Fragment, type ReactElement } from 'react';
import { theme, type GlobalToken } from 'antd';
import { ProgressNative, type ProgressSet } from '../../components/ProgressNative/index';
import ProgressDetailSet from './ProgressDetailSet';

/**
 * 下载进度：百分比 + 细进度条 + 「3.2 MB/s · 剩余 1分23秒 · 已下载 120 MB」。
 * 不是 ProgressDetailSet 时退回原来的 ProgressNative。
 */
function ProgressDetail(props: { readonly progressSet: ProgressSet }): ReactElement {
  const { progressSet }: { progressSet: ProgressSet } = props;
  const { token }: { token: GlobalToken } = theme.useToken();

  if (!(progressSet instanceof ProgressDetailSet)) {
    return <ProgressNative progressSet={ progressSet } />;
  }

  return (
    <Fragment>
      <span id={ progressSet.progressId }
        style={{ color: token.colorPrimary }}
        aria-label="progress"
        aria-valuemin={ 0 }
        aria-valuemax={ 100 }
        aria-valuenow={ progressSet.value }
        aria-valuetext={ `${ progressSet.value }%` }
      >
        { progressSet.value }%
      </span>
      <div className="mt-[4px] h-[4px] w-[120px] overflow-hidden rounded-full" style={{ background: token.colorFillSecondary }}>
        <div id={ progressSet.barId }
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${ Math.min(100, progressSet.value) }%`, background: token.colorPrimary }}
        />
      </div>
      <div id={ progressSet.detailId } className="mt-[4px] text-[12px] whitespace-nowrap" style={{ color: token.colorTextSecondary }}>
        { progressSet.detail }
      </div>
    </Fragment>
  );
}

export default ProgressDetail;
