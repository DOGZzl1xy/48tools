import type { PackConfig } from '../sync/packTypes';

/* 默认的配置：没有同步到内容包时用这一份（见 ../sync/packTypes） */
export const config: PackConfig = {
  // B 站公演自动录制：SNH48 的四个队；公演一般北京时间 13:30、18:30 或 19:30 开始，只在这前后查
  gongyanTeams: ['SII', 'NII', 'HII', 'X'],
  gongyanWindows: [[(13 * 60), (14 * 60) + 30], [18 * 60, (20 * 60) + 15]],
  // SNH48 / GNZ48 / BEJ48 / CKG48 各队的应援色
  teamColors: {
    SII: '#8fc8eb',
    NII: '#af83bb',
    HII: '#f49604',
    X: '#a9ca27',
    G: '#abc813',
    NIII: '#f6cd22',
    N3: '#f6cd22',
    Z: '#ec607c',
    B: '#e7316c',
    E: '#1bb5b5',
    C: '#ffb715',
    K: '#f25554'
  },
  stageTeamTags: {}
};
