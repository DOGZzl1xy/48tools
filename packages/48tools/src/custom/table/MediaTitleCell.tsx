import { useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { Typography } from 'antd';
import { source } from '../../utils/snh48';

/**
 * 表格里的「标题」单元格：封面缩略图 + 标题，方便一眼认出是哪一场。
 * 封面加载失败（或没有封面）时只显示标题。
 * 接入点：Pocket48Record.tsx、Pocket48Live.tsx 的「标题」列。
 */
interface MediaTitleCellProps {
  title: string;
  coverPath?: string;
}

function MediaTitleCell(props: MediaTitleCellProps): ReactElement {
  const { title, coverPath }: MediaTitleCellProps = props;
  const [failed, setFailed]: [boolean, D<S<boolean>>] = useState(false);
  const cover: string = failed ? '' : source(coverPath);

  return (
    <div className="flex items-center gap-[10px] min-w-0">
      {
        cover ? (
          <img className="flex-none w-[40px] h-[40px] rounded-[8px] object-cover bg-[#8881]"
            src={ cover }
            alt=""
            loading="lazy"
            draggable={ false }
            onError={ (): void => setFailed(true) }
          />
        ) : null
      }
      <Typography.Text className="min-w-0" ellipsis={{ tooltip: title }} style={{ maxWidth: 190 }}>{ title }</Typography.Text>
    </div>
  );
}

export default MediaTitleCell;
