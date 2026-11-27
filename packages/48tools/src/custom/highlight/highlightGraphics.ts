import { promises as fsP } from 'node:fs';
import {
  deriveTeamTokens, hexWithAlpha, resolveTeam, shortMemberName, type ResolvedTeam, type TeamVisualTokens
} from './highlightTheme';
import { LEFT_WIDTH, splitTitle, VIDEO_SIZE } from './highlightAss';
import { coverSegments, STAGE_VIDEO, stageTitleRows, type StageInfo } from './highlightStageAss';

/**
 * 基于 Chromium Canvas 2D 的高质感平面图形渲染器（运行在 Electron 渲染进程中，毫秒级出图、零外部进程依赖）。
 * 负责生成定稿设计的：
 *   1. 三类封面（16:9 & 4:3）：公演 A（无黑底斜切荧光笔）、电台 B（通透暖白画报）、直播 C3-A（宝石刊头 + 通透丝绒）
 *   2. 三类正片静态底板（1920×1080 PNG）：电台布局 2、直播布局 2、公演方案 2，交给 FFmpeg 与动态画面/字幕/弹幕合成
 *   3. 改标题局部补丁 PNG：支持在渐变刊头/丝绒底上无痕替换标题
 * 在无 DOM 的纯 Node/Jest 测试环境中自动返回 null，由调用方平滑回退到 FFmpeg+ASS 路径。
 */
const W: number = VIDEO_SIZE.width;
const H: number = VIDEO_SIZE.height;
const RIGHT_W: number = W - LEFT_WIDTH;
const FONT_SANS: string = '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const FONT_HEAVY: string = '"Source Han Sans SC Heavy", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const FONT_LATIN: string = '"Inter", "Inter Variable", "Source Han Sans SC", "Segoe UI", sans-serif';

export interface GraphicsMeta {
  member: string;
  date: string;
  radio?: boolean;
  team?: string;
  teamColor?: string;
  stage?: StageInfo;
}

export interface PatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function canUseCanvas(): boolean {
  return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof createImageBitmap === 'function';
}

let cachedNoise: HTMLCanvasElement | undefined;

/* 可平铺的极细微纸感/丝绒噪点贴图（生成一次复用） */
function noiseTile(): HTMLCanvasElement {
  if (cachedNoise) return cachedNoise;

  const size: number = 256;
  const tile: HTMLCanvasElement = document.createElement('canvas');

  tile.width = size;
  tile.height = size;

  const ctx: CanvasRenderingContext2D = tile.getContext('2d')!;
  const img: ImageData = ctx.createImageData(size, size);
  let seed: number = 1337;

  for (let i: number = 0; i < img.data.length; i += 4) {
    seed = ((seed * 1_664_525) + 1_013_904_223) >>> 0;

    const v: number = (seed >>> 24) & 0xff;

    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  cachedNoise = tile;

  return tile;
}

function drawGrain(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number): void {
  const pattern: CanvasPattern | null = ctx.createPattern(noiseTile(), 'repeat');

  if (!pattern) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius: number = Math.min(r, w / 2, h / 2);

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/* 斜切渐变荧光笔（-10°） */
function drawSlantedHighlighter(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, startColor: string, endColor: string, radius: number = 4
): void {
  ctx.save();
  ctx.translate(x + (w / 2), y + (h / 2));
  ctx.transform(1, 0, -0.1763, 1, 0, 0); // skewX(-10deg)
  ctx.translate(-(w / 2), -(h / 2));

  const grad: CanvasGradient = ctx.createLinearGradient(0, 0, w, 0);

  grad.addColorStop(0, startColor);
  grad.addColorStop(1, endColor);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = grad;
  ctx.fill();

  // 顶部 1px 极细高光折射
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.36)';
  ctx.fillRect(2, 0, Math.max(0, w - 4), 1.5);
  ctx.restore();
}

/* 统一外框标签：[RADIO / 电台] 与 [LIVE / 直播] */
function drawKindBox(
  ctx: CanvasRenderingContext2D, rightX: number, topY: number, label: string, color: string, borderColor: string, fontSize: number = 19, padX: number = 14, padY: number = 6
): { width: number; height: number } {
  ctx.save();
  ctx.font = `700 ${ fontSize }px ${ FONT_LATIN }`;

  const textW: number = ctx.measureText(label).width;
  const w: number = Math.ceil(textW + (padX * 2));
  const h: number = Math.ceil((fontSize * 1.15) + (padY * 2));
  const x: number = rightX - w;

  roundRectPath(ctx, x, topY, w, h, 4);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + (w / 2), topY + (h / 2) + 0.5);
  ctx.restore();

  return { width: w, height: h };
}

/* 按最大宽度自动缩小字号，保证单行不溢出 */
function fitFontSize(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, maxSize: number, minSize: number, maxWidth: number): number {
  let size: number = maxSize;

  while (size > minSize) {
    ctx.font = `${ weight } ${ size }px ${ family }`;

    if (ctx.measureText(text).width <= maxWidth) return size;

    size -= 2;
  }

  return minSize;
}

/* 截断超长单行文案加省略号 */
function ellipsisText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;

  const chars: Array<string> = Array.from(text);

  while (chars.length > 1 && ctx.measureText(`${ chars.join('') }…`).width > maxWidth) chars.pop();

  return `${ chars.join('') }…`;
}

async function loadBitmap(file: string): Promise<ImageBitmap> {
  const bytes: Buffer = await fsP.readFile(file);

  return createImageBitmap(new Blob([new Uint8Array(bytes)]));
}

async function canvasToBuffer(canvas: HTMLCanvasElement, mime: 'image/jpeg' | 'image/png', quality: number = 0.94): Promise<Buffer> {
  const blob: Blob = await new Promise<Blob>((resolve: (b: Blob) => void, reject: (err: Error) => void): void => {
    canvas.toBlob((value: Blob | null): void => (value ? resolve(value) : reject(new Error('Canvas 导出图片失败'))), mime, quality);
  });

  return Buffer.from(await blob.arrayBuffer());
}

/* 绘制通透广域团队丝绒底（直播封面 C3-A / 直播正片 2 / 公演正片 2 共享材质） */
function drawVelvetSurface(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tokens: TeamVisualTokens, bloomXRatio: number = 0.86, bloomYRatio: number = 0.32
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // 基础斜向深丝绒渐变
  const base: CanvasGradient = ctx.createLinearGradient(x, y, x + (w * 0.45), y + h);

  base.addColorStop(0, tokens.velvetMid);
  base.addColorStop(1, tokens.velvetDeep);
  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);

  // 广域主丝绒高光漫射（右上/中右）
  const cx1: number = x + (w * bloomXRatio);
  const cy1: number = y + (h * bloomYRatio);
  const r1: number = Math.max(w, h) * 0.92;
  const g1: CanvasGradient = ctx.createRadialGradient(cx1, cy1, 0, cx1, cy1, r1);

  g1.addColorStop(0, hexWithAlpha(tokens.velvetBloom, 0.88));
  g1.addColorStop(0.46, hexWithAlpha(tokens.velvetMid, 0.55));
  g1.addColorStop(0.82, hexWithAlpha(tokens.velvetMid, 0));
  ctx.fillStyle = g1;
  ctx.fillRect(x, y, w, h);

  // 左下辅深度光影
  const cx2: number = x + (w * 0.12);
  const cy2: number = y + (h * 0.94);
  const r2: number = Math.max(w, h) * 0.72;
  const g2: CanvasGradient = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, r2);

  g2.addColorStop(0, hexWithAlpha(tokens.velvetMid, 0.78));
  g2.addColorStop(0.72, hexWithAlpha(tokens.velvetMid, 0));
  ctx.fillStyle = g2;
  ctx.fillRect(x, y, w, h);

  // 通透斜向丝绸折射光带
  const sheen: CanvasGradient = ctx.createLinearGradient(x, y, x + w, y + (h * 0.75));

  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
  sheen.addColorStop(0.26, 'rgba(255, 255, 255, 0.025)');
  sheen.addColorStop(0.46, 'rgba(255, 255, 255, 0)');
  sheen.addColorStop(0.64, 'rgba(255, 255, 255, 0.045)');
  sheen.addColorStop(0.84, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);

  drawGrain(ctx, x, y, w, h, 0.022);
  ctx.restore();
}

/* 宝石渐变刊头底（带斜向通透高光扫过） */
function drawJewelMastheadBg(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tokens: TeamVisualTokens): void {
  const grad: CanvasGradient = ctx.createLinearGradient(x, y, x + w, y + (h * 0.65));

  grad.addColorStop(0, tokens.mhStart);
  grad.addColorStop(1, tokens.mhEnd);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  const sweep: CanvasGradient = ctx.createLinearGradient(x, y, x + w, y + (h * 0.8));

  sweep.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  sweep.addColorStop(0.44, 'rgba(255, 255, 255, 0)');
  sweep.addColorStop(1, 'rgba(0, 0, 0, 0.06)');
  ctx.fillStyle = sweep;
  ctx.fillRect(x, y, w, h);
}

/* C3-A 标志性双细线接缝 */
function drawDoubleSeam(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tokens: TeamVisualTokens): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.fillRect(x, y, w, 1);
  ctx.fillStyle = hexWithAlpha(tokens.velvetAccent, 0.30);
  ctx.fillRect(x, y + h - 1, w, 1);
}

/* =========================================================================
 * 1. 公演封面 A（无黑底、零模糊、右上角实心队标+公演名+日期、左下斜切渐变荧光笔）
 * ========================================================================= */
export async function renderStageCoverCanvas(input: {
  frameFile: string;
  stage: StageInfo;
  lines: Array<string>;
  width: number;
}): Promise<Buffer | null> {
  if (!canUseCanvas()) return null;

  const { frameFile, stage, width }: typeof input = input;
  const is43: boolean = width < W;
  const padX: number = is43 ? 68 : 92;
  const resolved: ResolvedTeam = resolveTeam(stage.team, stage.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const canvas: HTMLCanvasElement = document.createElement('canvas');

  canvas.width = width;
  canvas.height = H;

  const ctx: CanvasRenderingContext2D = canvas.getContext('2d')!;
  const bmp: ImageBitmap = await loadBitmap(frameFile);

  try {
    // 从 frame 的左上 1440×810 舞台区无模糊放大至 1920×1080（4:3 居中裁切）
    const sx: number = is43 ? Math.round((STAGE_VIDEO.width * (W - width)) / (2 * W)) : 0;
    const sw: number = is43 ? Math.round((STAGE_VIDEO.width * width) / W) : STAGE_VIDEO.width;

    ctx.save();
    ctx.filter = 'contrast(1.04) saturate(1.07)';
    ctx.drawImage(bmp, sx, 0, sw, STAGE_VIDEO.height, 0, 0, width, H);
    ctx.restore();
  } finally {
    bmp.close();
  }

  // 底部极轻定向柔光护字（上半屏及成员面部 100% 原亮度零遮挡）
  const bottomScrim: CanvasGradient = ctx.createLinearGradient(0, H, 0, H * 0.46);

  bottomScrim.addColorStop(0, 'rgba(8, 13, 22, 0.62)');
  bottomScrim.addColorStop(0.42, 'rgba(8, 13, 22, 0.24)');
  bottomScrim.addColorStop(0.76, 'rgba(8, 13, 22, 0.04)');
  bottomScrim.addColorStop(1, 'rgba(8, 13, 22, 0)');
  ctx.fillStyle = bottomScrim;
  ctx.fillRect(0, H * 0.46, width, H * 0.54);

  const blGlow: CanvasGradient = ctx.createRadialGradient(width * 0.24, H * 0.88, 0, width * 0.24, H * 0.88, width * 0.55);

  blGlow.addColorStop(0, 'rgba(10, 18, 30, 0.28)');
  blGlow.addColorStop(1, 'rgba(10, 18, 30, 0)');
  ctx.fillStyle = blGlow;
  ctx.fillRect(0, H * 0.4, width, H * 0.6);

  // 右上角局部轻柔护字（避开左上角 SNH48 官摄水印）
  const trScrim: CanvasGradient = ctx.createRadialGradient(width, 0, 0, width, 0, 760);

  trScrim.addColorStop(0, 'rgba(6, 12, 20, 0.56)');
  trScrim.addColorStop(0.55, 'rgba(6, 12, 20, 0.16)');
  trScrim.addColorStop(1, 'rgba(6, 12, 20, 0)');
  ctx.fillStyle = trScrim;
  ctx.fillRect(width - 800, 0, 800, 320);

  // 右上角杂志眉标：实心队伍色标 + 公演名 + 日期 + 发光团队色竖条（不含 SNH48）
  const headerTop: number = 48;
  const railW: number = 7;
  const railX: number = width - padX - railW;
  const contentRight: number = railX - 20;
  const badgeFS: number = is43 ? 28 : 30;
  const dateFS: number = is43 ? 25 : 27;
  const badgeText: string = resolved.badge || `TEAM ${ stage.team }`;

  ctx.font = `900 ${ badgeFS }px ${ FONT_LATIN }`;

  const badgePadX: number = 20;
  const badgeW: number = Math.ceil(ctx.measureText(badgeText).width + (badgePadX * 2));
  const badgeH: number = badgeFS + 16;
  const maxShowW: number = Math.max(220, (width * 0.58) - badgeW - 36);
  const showFS: number = fitFontSize(ctx, stage.show, '900', FONT_HEAVY, is43 ? 40 : 44, 24, maxShowW);

  ctx.font = `900 ${ showFS }px ${ FONT_HEAVY }`;

  const showW: number = ctx.measureText(stage.show).width;
  const row1H: number = Math.max(badgeH, showFS);
  const headerH: number = row1H + 12 + dateFS;

  // 右侧发光竖条
  ctx.save();

  const railGrad: CanvasGradient = ctx.createLinearGradient(0, headerTop, 0, headerTop + headerH);

  railGrad.addColorStop(0, tokens.hex);
  railGrad.addColorStop(1, tokens.hlStart);
  ctx.shadowColor = hexWithAlpha(tokens.hex, 0.55);
  ctx.shadowBlur = 16;
  roundRectPath(ctx, railX, headerTop, railW, headerH, 3.5);
  ctx.fillStyle = railGrad;
  ctx.fill();
  ctx.restore();

  // 公演名
  ctx.save();
  ctx.font = `900 ${ showFS }px ${ FONT_HEAVY }`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.58)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 3;
  ctx.fillText(stage.show, contentRight, headerTop + (row1H / 2) + 1);
  ctx.restore();

  // 实心队伍色徽章
  const badgeX: number = contentRight - showW - 16 - badgeW;
  const badgeY: number = headerTop + ((row1H - badgeH) / 2);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 5;
  roundRectPath(ctx, badgeX, badgeY, badgeW, badgeH, 6);
  ctx.fillStyle = tokens.hex;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.font = `900 ${ badgeFS }px ${ FONT_LATIN }`;
  ctx.fillStyle = tokens.onTeam;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, badgeX + (badgeW / 2), badgeY + (badgeH / 2) + 1);
  ctx.restore();

  // 日期
  ctx.save();
  ctx.font = `600 ${ dateFS }px ${ FONT_LATIN }`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.62)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fillText(stage.date, contentRight, headerTop + row1H + 12);
  ctx.restore();

  // 左下大字组（1~3 行，支持单行超大歌名模式）
  const rows: Array<Array<{ text: string; mark: boolean }>> = input.lines
    .map(coverSegments)
    .filter((row: Array<{ text: string; mark: boolean }>): boolean => row.length > 0)
    .slice(0, 3);

  if (rows.length > 0) {
    const solo: boolean = rows.length === 1 && rows[0].length === 1 && rows[0][0].mark;
    const maxFS: number = solo ? (is43 ? 176 : 210) : (is43 ? 102 : 116);
    const maxRowW: number = width - (padX * 2) - 16;

    const measureRowWidth: (row: Array<{ text: string; mark: boolean }>, size: number) => number = (
      row: Array<{ text: string; mark: boolean }>,
      size: number
    ): number => {
      ctx.font = `900 ${ size }px ${ FONT_HEAVY }`;

      return row.reduce((sum: number, seg: { text: string; mark: boolean }, i: number): number => {
        const w: number = ctx.measureText(seg.text).width;
        const pad: number = seg.mark ? 24 : 0;
        const gap: number = i > 0 ? (seg.mark || row[i - 1].mark ? 14 : 6) : 0;

        return sum + w + pad + gap;
      }, 0);
    };

    let fs: number = maxFS;

    while (fs > 44 && rows.some((row: Array<{ text: string; mark: boolean }>): boolean => measureRowWidth(row, fs) > maxRowW)) {
      fs -= 2;
    }

    const lineH: number = Math.round(fs * 1.14);
    const gapY: number = Math.round(fs * 0.12);
    const totalH: number = (rows.length * lineH) + ((rows.length - 1) * gapY);
    let y: number = H - 68 - totalH;

    rows.forEach((row: Array<{ text: string; mark: boolean }>, rowIdx: number): void => {
      let x: number = padX;

      ctx.font = `900 ${ fs }px ${ FONT_HEAVY }`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';

      row.forEach((seg: { text: string; mark: boolean }, segIdx: number): void => {
        if (segIdx > 0) x += seg.mark || row[segIdx - 1].mark ? 14 : 6;

        const tw: number = ctx.measureText(seg.text).width;

        if (seg.mark) {
          const pad: number = 12;

          drawSlantedHighlighter(ctx, x - 2, y + (fs * 0.56), tw + (pad * 2) + 4, fs * 0.44, tokens.hlStart, tokens.hlEnd, 4);
          ctx.save();
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.56)';
          ctx.shadowBlur = 14;
          ctx.shadowOffsetY = 3;
          ctx.fillText(seg.text, x + pad, y);
          ctx.restore();
          x += tw + (pad * 2);
        } else {
          ctx.save();
          ctx.fillStyle = rows.length >= 2 && rowIdx === rows.length - 1 ? tokens.stageTint : '#ffffff';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.54)';
          ctx.shadowBlur = 18;
          ctx.shadowOffsetY = 4;
          ctx.fillText(seg.text, x, y);
          ctx.restore();
          x += tw;
        }
      });

      y += lineH + gapY;
    });
  }

  return canvasToBuffer(canvas, 'image/jpeg', 0.94);
}

/* =========================================================================
 * 2. 电台封面 B（通透暖白画报 #FAF9F6 + 实心队标 + 大号成员名 + [RADIO / 电台] + 下对齐热点）
 * ========================================================================= */
export async function renderRadioCoverCanvas(input: {
  frameFile: string;
  meta: GraphicsMeta;
  title: string;
  points: Array<string>;
  width: number;
}): Promise<Buffer | null> {
  if (!canUseCanvas()) return null;

  const { frameFile, meta, title, width }: typeof input = input;
  const is43: boolean = width < W;
  const rightW: number = width - LEFT_WIDTH;
  const padX: number = is43 ? 54 : 84;
  const innerW: number = rightW - (padX * 2);
  const resolved: ResolvedTeam = resolveTeam(meta.team, meta.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const member: string = shortMemberName(meta.member);
  const points: Array<string> = input.points.map((p: string): string => p.trim()).filter(Boolean).slice(0, 3);
  const canvas: HTMLCanvasElement = document.createElement('canvas');

  canvas.width = width;
  canvas.height = H;

  const ctx: CanvasRenderingContext2D = canvas.getContext('2d')!;
  const bmp: ImageBitmap = await loadBitmap(frameFile);

  try {
    // 保留左半边 608×1080 原样不变
    ctx.drawImage(bmp, 0, 0, LEFT_WIDTH, H, 0, 0, LEFT_WIDTH, H);
  } finally {
    bmp.close();
  }

  // 右半边通透画廊暖白纸底
  ctx.fillStyle = '#FAF9F6';
  ctx.fillRect(LEFT_WIDTH, 0, rightW, H);

  // 顶部 10px 团队色丝带
  ctx.fillStyle = tokens.hex;
  ctx.fillRect(LEFT_WIDTH, 0, rightW, 10);

  // 右上角轻盈水彩淡晕
  const wash: CanvasGradient = ctx.createRadialGradient(width - 60, 40, 0, width - 60, 40, 560);

  wash.addColorStop(0, hexWithAlpha(tokens.radioWash, 0.18));
  wash.addColorStop(0.66, hexWithAlpha(tokens.radioWash, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(LEFT_WIDTH, 10, rightW, H - 10);
  drawGrain(ctx, LEFT_WIDTH, 10, rightW, H - 10, 0.018);

  // 顶部刊头（不含 SNH48）
  const rx: number = LEFT_WIDTH + padX;
  const rightEdge: number = width - padX;
  let topY: number = 66;

  // 右侧 [RADIO / 电台] 统一外框 + 日期
  const boxSize: { width: number; height: number } = drawKindBox(ctx, rightEdge, topY + 46, 'RADIO / 电台', '#16181D', '#16181D', 19, 14, 6);

  ctx.save();
  ctx.font = `600 23px ${ FONT_LATIN }`;
  ctx.fillStyle = '#6B707A';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.fillText(meta.date, rightEdge, topY + 46 + boxSize.height + 10);
  ctx.restore();

  // 左侧实心队伍标 + 大号成员名
  if (resolved.badge) {
    ctx.save();
    ctx.font = `800 18px ${ FONT_LATIN }`;

    const tagW: number = Math.ceil(ctx.measureText(resolved.badge).width + 26);
    const tagH: number = 30;

    roundRectPath(ctx, rx, topY, tagW, tagH, 4);
    ctx.fillStyle = tokens.hex;
    ctx.fill();
    ctx.fillStyle = tokens.onTeam;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(resolved.badge, rx + (tagW / 2), topY + (tagH / 2) + 0.5);
    ctx.restore();
    topY += 42;
  } else {
    topY += 20;
  }

  const maxMemberW: number = innerW - Math.max(boxSize.width, 160) - 24;
  const memberFS: number = fitFontSize(ctx, member, '900', FONT_HEAVY, is43 ? 86 : 100, 52, maxMemberW);

  ctx.save();
  ctx.font = `900 ${ memberFS }px ${ FONT_HEAVY }`;
  ctx.fillStyle = '#121418';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(member, rx, topY);
  ctx.restore();

  const headerBottomY: number = topY + memberFS + 28;

  ctx.fillStyle = '#16181D';
  ctx.fillRect(rx, headerBottomY, innerW, 2);

  // 底部热点（严格下对齐）
  const bottomPad: number = 62;
  const pointFSBase: number = is43 ? 43 : 49;
  const numW: number = 74;
  let pointFS: number = pointFSBase;

  for (const pt of points) {
    pointFS = Math.min(pointFS, fitFontSize(ctx, pt, '700', FONT_SANS, pointFS, 28, innerW - numW));
  }

  const pointRowH: number = Math.round(pointFS * 1.32);
  const pointGap: number = 16;
  const pointsBlockH: number = points.length > 0 ? (points.length * pointRowH) + ((points.length - 1) * pointGap) : 0;
  const bottomRuleY: number = points.length > 0 ? H - bottomPad - pointsBlockH - 24 : H - bottomPad;

  if (points.length > 0) {
    ctx.fillStyle = 'rgba(22, 24, 29, 0.16)';
    ctx.fillRect(rx, bottomRuleY, innerW, 1);

    let py: number = bottomRuleY + 24;

    points.forEach((pt: string, index: number): void => {
      const numText: string = String(index + 1).padStart(2, '0');
      const numFS: number = Math.round(pointFS * 0.68);
      const chipH: number = Math.round(numFS + 12);
      const chipW: number = Math.round(numFS * 1.75);
      const chipY: number = py + Math.round((pointRowH - chipH) / 2);

      roundRectPath(ctx, rx, chipY, chipW, chipH, 4);
      ctx.fillStyle = hexWithAlpha(tokens.hex, 0.22);
      ctx.fill();

      ctx.save();
      ctx.font = `800 ${ numFS }px ${ FONT_LATIN }`;
      ctx.fillStyle = tokens.radioAccentDark;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(numText, rx + (chipW / 2), chipY + (chipH / 2) + 0.5);

      ctx.font = `700 ${ pointFS }px ${ FONT_SANS }`;
      ctx.fillStyle = '#24272E';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(pt, rx + chipW + 20, py + (pointRowH / 2));
      ctx.restore();

      py += pointRowH + pointGap;
    });
  }

  // 中部爆点主标题（在顶部底线与底部热点区之间垂直居中，最后一行带团队色浅荧光底线）
  const titleRows: Array<string> = splitTitle(title);
  let titleFS: number = is43 ? (titleRows.length > 1 ? 92 : 104) : (titleRows.length > 1 ? 118 : 130);

  for (const row of titleRows) {
    titleFS = Math.min(titleFS, fitFontSize(ctx, row, '900', FONT_HEAVY, titleFS, 46, innerW));
  }

  const titleLineH: number = Math.round(titleFS * 1.2);
  const titleH: number = titleRows.length * titleLineH;
  const midAvailH: number = Math.max(titleH, bottomRuleY - headerBottomY);
  let ty: number = headerBottomY + Math.round((midAvailH - titleH) / 2);

  titleRows.forEach((row: string, idx: number): void => {
    ctx.save();
    ctx.font = `900 ${ titleFS }px ${ FONT_HEAVY }`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    if (idx === titleRows.length - 1) {
      const tw: number = ctx.measureText(row).width;

      roundRectPath(ctx, rx - 4, ty + (titleFS * 0.72), tw + 8, titleFS * 0.28, 2);
      ctx.fillStyle = hexWithAlpha(tokens.hex, 0.38);
      ctx.fill();
    }

    ctx.fillStyle = '#121418';
    ctx.fillText(row, rx, ty);
    ctx.restore();
    ty += titleLineH;
  });

  return canvasToBuffer(canvas, 'image/jpeg', 0.94);
}

/* =========================================================================
 * 3. 直播封面 C3-A（宝石渐变刊头 + 统一 [LIVE / 直播] 框标 + 建筑细线 + 通透广域丝绒 + 下对齐曲目表）
 * ========================================================================= */
export async function renderLiveCoverCanvas(input: {
  frameFile: string;
  meta: GraphicsMeta;
  title: string;
  points: Array<string>;
  width: number;
}): Promise<Buffer | null> {
  if (!canUseCanvas()) return null;

  const { frameFile, meta, title, width }: typeof input = input;
  const is43: boolean = width < W;
  const rightW: number = width - LEFT_WIDTH;
  const padX: number = is43 ? 52 : 80;
  const innerW: number = rightW - (padX * 2);
  const resolved: ResolvedTeam = resolveTeam(meta.team, meta.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const member: string = shortMemberName(meta.member);
  const points: Array<string> = input.points.map((p: string): string => p.trim()).filter(Boolean).slice(0, 3);
  const canvas: HTMLCanvasElement = document.createElement('canvas');

  canvas.width = width;
  canvas.height = H;

  const ctx: CanvasRenderingContext2D = canvas.getContext('2d')!;
  const bmp: ImageBitmap = await loadBitmap(frameFile);

  try {
    ctx.drawImage(bmp, 0, 0, LEFT_WIDTH, H, 0, 0, LEFT_WIDTH, H);
  } finally {
    bmp.close();
  }

  // 右半边通透广域丝绒底
  drawVelvetSurface(ctx, LEFT_WIDTH, 0, rightW, H, tokens, 0.86, 0.32);

  // 顶部宝石渐变刊头
  const mastheadH: number = is43 ? 210 : 226;

  drawJewelMastheadBg(ctx, LEFT_WIDTH, 0, rightW, mastheadH, tokens);

  const rx: number = LEFT_WIDTH + padX;
  const rightEdge: number = width - padX;

  // 右侧竖向分割线 + 统一 [LIVE / 直播] 外框 + 日期
  const boxSize: { width: number; height: number } = drawKindBox(ctx, rightEdge, mastheadH - 38 - 28 - 44, 'LIVE / 直播', tokens.onTeam, tokens.mhBoxBorder, 19, 14, 6);

  ctx.save();
  ctx.font = `600 23px ${ FONT_LATIN }`;
  ctx.fillStyle = tokens.mhSub;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  ctx.fillText(meta.date, rightEdge, mastheadH - 38);

  const metaColW: number = Math.max(boxSize.width, ctx.measureText(meta.date).width);
  const metaDividerX: number = rightEdge - metaColW - 30;

  ctx.fillStyle = tokens.mhBorder;
  ctx.fillRect(metaDividerX, 42, 1, mastheadH - 80);
  ctx.restore();

  // 左侧 TEAM 细框标 + 短横线 + 超大成员名
  let mhY: number = 42;

  if (resolved.badge) {
    ctx.save();
    ctx.font = `800 17px ${ FONT_LATIN }`;

    const pillW: number = Math.ceil(ctx.measureText(resolved.badge).width + 24);
    const pillH: number = 28;

    roundRectPath(ctx, rx, mhY, pillW, pillH, 3);
    ctx.strokeStyle = tokens.mhBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = tokens.onTeam;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(resolved.badge, rx + (pillW / 2), mhY + (pillH / 2) + 0.5);

    ctx.fillStyle = tokens.mhBorder;
    ctx.fillRect(rx + pillW + 12, mhY + (pillH / 2), 32, 1.5);
    ctx.restore();
    mhY += 40;
  } else {
    mhY += 20;
  }

  const maxMemberW: number = Math.max(200, metaDividerX - rx - 24);
  const memberFS: number = fitFontSize(ctx, member, '900', FONT_HEAVY, is43 ? 88 : 104, 52, maxMemberW);

  ctx.save();
  ctx.font = `900 ${ memberFS }px ${ FONT_HEAVY }`;
  ctx.fillStyle = tokens.onTeam;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(member, rx, mastheadH - 36);
  ctx.restore();

  // 标志性双细线接缝
  const seamH: number = 9;

  drawDoubleSeam(ctx, LEFT_WIDTH, mastheadH, rightW, seamH, tokens);

  // 建筑标尺细线 + ── +
  const guideY: number = mastheadH + seamH + 34;

  ctx.save();
  ctx.font = `500 16px ${ FONT_LATIN }`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.30)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('+', rx, guideY);
  ctx.textAlign = 'right';
  ctx.fillText('+', rightEdge, guideY);

  const guideGrad: CanvasGradient = ctx.createLinearGradient(rx + 26, 0, rightEdge - 26, 0);

  guideGrad.addColorStop(0, hexWithAlpha(tokens.velvetAccent, 0.42));
  guideGrad.addColorStop(1, 'rgba(255, 255, 255, 0.10)');
  ctx.fillStyle = guideGrad;
  ctx.fillRect(rx + 26, guideY, innerW - 52, 1);
  ctx.restore();

  // 底部曲目表热点（严格下对齐）
  const bottomPad: number = 52;
  let pointFS: number = is43 ? 40 : 46;

  for (const pt of points) {
    pointFS = Math.min(pointFS, fitFontSize(ctx, pt, '500', FONT_SANS, pointFS, 26, innerW - 64));
  }

  const rowPadY: number = 17;
  const rowContentH: number = Math.round(pointFS * 1.24);
  const rowH: number = rowContentH + (rowPadY * 2);
  const tableH: number = points.length > 0 ? (points.length * rowH) - rowPadY : 0;
  const tableTopY: number = H - bottomPad - tableH;

  if (points.length > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(rx, tableTopY, innerW, 1);

    let py: number = tableTopY;

    points.forEach((pt: string, index: number): void => {
      const centerY: number = py + rowPadY + (rowContentH / 2);

      ctx.save();
      ctx.font = `700 22px ${ FONT_LATIN }`;
      ctx.fillStyle = tokens.velvetAccent;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(String(index + 1).padStart(2, '0'), rx, centerY + 1);

      ctx.font = `500 ${ pointFS }px ${ FONT_SANS }`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.fillText(pt, rx + 60, centerY);
      ctx.restore();

      if (index < points.length - 1) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
        ctx.fillRect(rx, py + rowH, innerW, 1);
      }

      py += rowH;
    });
  }

  // 中部标题（带左侧渐隐团队色引导竖线）
  const titleRows: Array<string> = splitTitle(title);
  let titleFS: number = is43 ? (titleRows.length > 1 ? 88 : 98) : (titleRows.length > 1 ? 116 : 128);

  for (const row of titleRows) {
    titleFS = Math.min(titleFS, fitFontSize(ctx, row, '900', FONT_HEAVY, titleFS, 46, innerW - 34));
  }

  const titleLineH: number = Math.round(titleFS * 1.16);
  const titleH: number = titleRows.length * titleLineH;
  const midTop: number = guideY + 18;
  const midBottom: number = points.length > 0 ? tableTopY - 18 : H - bottomPad;
  const ty: number = midTop + Math.round(((midBottom - midTop) - titleH) / 2);

  // 左侧渐隐竖线
  const railGrad: CanvasGradient = ctx.createLinearGradient(0, ty + 8, 0, ty + titleH - 8);

  railGrad.addColorStop(0, tokens.velvetAccent);
  railGrad.addColorStop(1, hexWithAlpha(tokens.velvetAccent, 0.14));
  roundRectPath(ctx, rx, ty + 8, 4, Math.max(24, titleH - 16), 2);
  ctx.fillStyle = railGrad;
  ctx.fill();

  ctx.save();
  ctx.font = `900 ${ titleFS }px ${ FONT_HEAVY }`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  titleRows.forEach((row: string, idx: number): void => {
    ctx.fillText(row, rx + 30, ty + (idx * titleLineH));
  });
  ctx.restore();

  return canvasToBuffer(canvas, 'image/jpeg', 0.94);
}

/* =========================================================================
 * 4. 正片静态底板（1920×1080 PNG）：电台布局 2 / 直播布局 2 / 公演方案 2
 * ========================================================================= */
function drawRadioBackdropOn(ctx: CanvasRenderingContext2D, meta: GraphicsMeta, title: string): void {
  const resolved: ResolvedTeam = resolveTeam(meta.team, meta.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const member: string = shortMemberName(meta.member);

  ctx.fillStyle = '#101218';
  ctx.fillRect(0, 0, LEFT_WIDTH, H);

  ctx.fillStyle = '#FAF9F6';
  ctx.fillRect(LEFT_WIDTH, 0, RIGHT_W, H);
  ctx.fillStyle = tokens.hex;
  ctx.fillRect(LEFT_WIDTH, 0, RIGHT_W, 10);

  const wash: CanvasGradient = ctx.createRadialGradient(W - 60, 20, 0, W - 60, 20, 620);

  wash.addColorStop(0, hexWithAlpha(tokens.radioWash, 0.16));
  wash.addColorStop(0.66, hexWithAlpha(tokens.radioWash, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(LEFT_WIDTH, 10, RIGHT_W, H - 10);
  drawGrain(ctx, LEFT_WIDTH, 10, RIGHT_W, H - 10, 0.018);

  // 紧凑画报顶栏（y = 10..146）
  const padX: number = 64;
  const rx: number = LEFT_WIDTH + padX;
  const rightEdge: number = W - padX;
  const headerBottomY: number = 142;

  const boxSize: { width: number; height: number } = drawKindBox(ctx, rightEdge, 44, 'RADIO / 电台', '#16181D', '#16181D', 15, 11, 4);

  ctx.save();
  ctx.font = `600 18px ${ FONT_LATIN }`;
  ctx.fillStyle = '#6B707A';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.fillText(meta.date, rightEdge, 44 + boxSize.height + 8);
  ctx.restore();

  // 左：队标 + 成员名
  let idW: number = 0;

  if (resolved.badge) {
    ctx.save();
    ctx.font = `800 15px ${ FONT_LATIN }`;

    const tagW: number = Math.ceil(ctx.measureText(resolved.badge).width + 22);

    roundRectPath(ctx, rx, 36, tagW, 24, 4);
    ctx.fillStyle = tokens.hex;
    ctx.fill();
    ctx.fillStyle = tokens.onTeam;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(resolved.badge, rx + (tagW / 2), 48.5);
    ctx.restore();
    idW = tagW;
  }

  ctx.save();
  ctx.font = `900 38px ${ FONT_HEAVY }`;
  ctx.fillStyle = '#121418';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(member, rx, 70);
  idW = Math.max(idW, Math.ceil(ctx.measureText(member).width));
  ctx.restore();

  const divX: number = rx + idW + 22;

  ctx.fillStyle = 'rgba(22, 24, 29, 0.20)';
  ctx.fillRect(divX, 46, 1.5, 58);

  // 切片主标题
  if (title) {
    const titleX: number = divX + 22;
    const maxTitleW: number = rightEdge - Math.max(boxSize.width, 130) - 28 - titleX;
    const titleFS: number = fitFontSize(ctx, title, '800', FONT_HEAVY, 40, 24, maxTitleW);

    ctx.save();
    ctx.font = `800 ${ titleFS }px ${ FONT_HEAVY }`;
    ctx.fillStyle = '#16181D';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(ellipsisText(ctx, title, maxTitleW), titleX, 76);
    ctx.restore();
  }

  ctx.fillStyle = '#16181D';
  ctx.fillRect(rx, headerBottomY, rightEdge - rx, 2);

  // 字幕区 ON AIR 极简微声波标（y = 196）
  const bars: Array<number> = [6, 14, 9, 12];

  ctx.save();
  bars.forEach((bh: number, idx: number): void => {
    roundRectPath(ctx, rx + (idx * 6), 210 - bh, 3, bh, 1.5);
    ctx.fillStyle = tokens.hex;
    ctx.fill();
  });
  ctx.font = `700 15px ${ FONT_LATIN }`;
  ctx.fillStyle = tokens.radioAccentDark;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText('ON AIR', rx + 32, 211);
  ctx.restore();

  // 弹幕区顶部分割线 + 弹幕 DANMU 眉标（y = 532）
  ctx.fillStyle = 'rgba(22, 24, 29, 0.16)';
  ctx.fillRect(rx, 532, rightEdge - rx, 1);

  ctx.save();
  ctx.beginPath();
  ctx.arc(rx + 4, 564, 4, 0, Math.PI * 2);
  ctx.fillStyle = tokens.hex;
  ctx.fill();

  ctx.font = `700 16px ${ FONT_LATIN }`;
  ctx.fillStyle = '#6B707A';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('弹幕 DANMU', rx + 17, 564);
  ctx.restore();
}

function drawLiveBackdropOn(ctx: CanvasRenderingContext2D, meta: GraphicsMeta, title: string): void {
  const resolved: ResolvedTeam = resolveTeam(meta.team, meta.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const member: string = shortMemberName(meta.member);

  ctx.fillStyle = '#101218';
  ctx.fillRect(0, 0, LEFT_WIDTH, H);

  drawVelvetSurface(ctx, LEFT_WIDTH, 0, RIGHT_W, H, tokens, 0.86, 0.32);

  // 紧凑宝石渐变顶栏（124px）+ 8px 双细线接缝
  const headerH: number = 124;

  drawJewelMastheadBg(ctx, LEFT_WIDTH, 0, RIGHT_W, headerH, tokens);

  const padX: number = 58;
  const rx: number = LEFT_WIDTH + padX;
  const rightEdge: number = W - padX;

  const boxSize: { width: number; height: number } = drawKindBox(ctx, rightEdge, 32, 'LIVE / 直播', tokens.onTeam, tokens.mhBoxBorder, 15, 11, 4);

  ctx.save();
  ctx.font = `600 18px ${ FONT_LATIN }`;
  ctx.fillStyle = tokens.mhSub;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.fillText(meta.date, rightEdge, 32 + boxSize.height + 8);

  const metaColW: number = Math.max(boxSize.width, ctx.measureText(meta.date).width);
  const metaDivX: number = rightEdge - metaColW - 26;

  ctx.fillStyle = tokens.mhBorder;
  ctx.fillRect(metaDivX, 30, 1, headerH - 60);
  ctx.restore();

  // 左：TEAM 细框标 + 成员名
  let idW: number = 0;

  if (resolved.badge) {
    ctx.save();
    ctx.font = `800 14px ${ FONT_LATIN }`;

    const pillW: number = Math.ceil(ctx.measureText(resolved.badge).width + 20);

    roundRectPath(ctx, rx, 26, pillW, 22, 3);
    ctx.strokeStyle = tokens.mhBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = tokens.onTeam;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(resolved.badge, rx + (pillW / 2), 37.5);
    ctx.restore();
    idW = pillW;
  }

  ctx.save();
  ctx.font = `900 38px ${ FONT_HEAVY }`;
  ctx.fillStyle = tokens.onTeam;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(member, rx, 58);
  idW = Math.max(idW, Math.ceil(ctx.measureText(member).width));
  ctx.restore();

  const divX: number = rx + idW + 20;

  ctx.fillStyle = tokens.mhBorder;
  ctx.fillRect(divX, 36, 1.5, 52);

  if (title) {
    const titleX: number = divX + 20;
    const maxTitleW: number = Math.max(180, metaDivX - titleX - 24);
    const titleFS: number = fitFontSize(ctx, title, '900', FONT_HEAVY, 40, 24, maxTitleW);

    ctx.save();
    ctx.font = `900 ${ titleFS }px ${ FONT_HEAVY }`;
    ctx.fillStyle = tokens.onTeam;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(ellipsisText(ctx, title, maxTitleW), titleX, headerH / 2);
    ctx.restore();
  }

  drawDoubleSeam(ctx, LEFT_WIDTH, headerH, RIGHT_W, 8, tokens);

  // 弹幕区顶部分割线 + 弹幕 DANMU 眉标（y = 532）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.fillRect(rx, 532, rightEdge - rx, 1);

  ctx.save();
  ctx.beginPath();
  ctx.arc(rx + 4, 564, 4, 0, Math.PI * 2);
  ctx.fillStyle = tokens.velvetAccent;
  ctx.fill();

  ctx.font = `700 16px ${ FONT_LATIN }`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.56)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('弹幕 DANMU', rx + 17, 564);
  ctx.restore();
}

function drawStageBackdropOn(ctx: CanvasRenderingContext2D, stage: StageInfo, title: string): void {
  const resolved: ResolvedTeam = resolveTeam(stage.team, stage.teamColor);
  const tokens: TeamVisualTokens = deriveTeamTokens(resolved.color);
  const sideX: number = STAGE_VIDEO.width;
  const sideW: number = W - sideX;

  // 整张贯通的深邃暗幕团队丝绒
  drawVelvetSurface(ctx, 0, 0, W, H, tokens, 0.94, 0.26);

  // 左上视频区黑底占位（会被 1440×810 舞台画面覆盖）
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, sideX, STAGE_VIDEO.height);

  // 左下字幕区极轻暗幕沉稳衬底 + 1px 发光底线
  const capLift: CanvasGradient = ctx.createLinearGradient(0, STAGE_VIDEO.height, 0, H);

  capLift.addColorStop(0, 'rgba(6, 8, 14, 0.34)');
  capLift.addColorStop(1, 'rgba(6, 8, 14, 0.16)');
  ctx.fillStyle = capLift;
  ctx.fillRect(0, STAGE_VIDEO.height, sideX, H - STAGE_VIDEO.height);

  const vLine: CanvasGradient = ctx.createLinearGradient(0, 0, sideX, 0);

  vLine.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
  vLine.addColorStop(0.5, hexWithAlpha(tokens.velvetAccent, 0.36));
  vLine.addColorStop(1, 'rgba(255, 255, 255, 0.14)');
  ctx.fillStyle = vLine;
  ctx.fillRect(0, STAGE_VIDEO.height, sideX, 1);

  // 右侧栏暗幕微沉 + 左侧发光细接缝
  const sideLift: CanvasGradient = ctx.createLinearGradient(0, 0, 0, H);

  sideLift.addColorStop(0, 'rgba(6, 8, 14, 0.12)');
  sideLift.addColorStop(1, 'rgba(6, 8, 14, 0.32)');
  ctx.fillStyle = sideLift;
  ctx.fillRect(sideX, 0, sideW, H);

  const seamGrad: CanvasGradient = ctx.createLinearGradient(0, 0, 0, H);

  seamGrad.addColorStop(0, tokens.hex);
  seamGrad.addColorStop(0.42, hexWithAlpha(tokens.hex, 0.34));
  seamGrad.addColorStop(1, 'rgba(255, 255, 255, 0.06)');
  ctx.fillStyle = seamGrad;
  ctx.fillRect(sideX, 0, 3, H);

  // 右上角（公演正片方案 2）：实心队伍色徽章 + 日期 + 公演名（不含 SNH48）
  const pad: number = 36;
  const rx: number = sideX + pad;
  const rightEdge: number = W - pad;
  const badgeText: string = resolved.badge || `TEAM ${ stage.team }`;

  ctx.save();
  ctx.font = `900 18px ${ FONT_LATIN }`;

  const badgeW: number = Math.ceil(ctx.measureText(badgeText).width + 28);
  const badgeH: number = 32;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.26)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  roundRectPath(ctx, rx, 36, badgeW, badgeH, 5);
  ctx.fillStyle = tokens.hex;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = tokens.onTeam;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, rx + (badgeW / 2), 36 + (badgeH / 2) + 0.5);

  ctx.font = `600 19px ${ FONT_LATIN }`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(stage.date, rightEdge, 36 + (badgeH / 2));
  ctx.restore();

  // 公演名
  const maxShowW: number = sideW - (pad * 2);
  const showFS: number = fitFontSize(ctx, stage.show, '900', FONT_HEAVY, 36, 22, maxShowW);

  ctx.save();
  ctx.font = `900 ${ showFS }px ${ FONT_HEAVY }`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(ellipsisText(ctx, stage.show, maxShowW), rx, 86);
  ctx.restore();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fillRect(rx, 152, sideW - (pad * 2), 1);

  // 切片标题块（y = 180..346，左对齐 + 左侧渐隐团队色引导竖线）
  const rows: Array<string> = stageTitleRows(title);

  if (rows.length > 0) {
    const titleMaxW: number = sideW - (pad * 2) - 22;
    let titleFS: number = 36;

    for (const row of rows) {
      titleFS = Math.min(titleFS, fitFontSize(ctx, row, '900', FONT_HEAVY, titleFS, 24, titleMaxW));
    }

    const lineH: number = Math.round(titleFS * 1.26);
    const blockH: number = rows.length * lineH;
    const ty: number = 180 + Math.max(0, Math.round((130 - blockH) / 2));
    const railGrad: CanvasGradient = ctx.createLinearGradient(0, ty + 4, 0, ty + blockH - 4);

    railGrad.addColorStop(0, tokens.velvetAccent);
    railGrad.addColorStop(1, hexWithAlpha(tokens.velvetAccent, 0.18));
    roundRectPath(ctx, rx, ty + 4, 4, Math.max(24, blockH - 8), 2);
    ctx.fillStyle = railGrad;
    ctx.fill();

    ctx.save();
    ctx.font = `900 ${ titleFS }px ${ FONT_HEAVY }`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    rows.forEach((row: string, idx: number): void => {
      ctx.fillStyle = rows.length > 1 && idx === rows.length - 1 ? tokens.velvetAccent : '#ffffff';
      ctx.fillText(row, rx + 20, ty + (idx * lineH));
    });
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(rx, 338, sideW - (pad * 2), 1);

  // 弹幕 DANMU 眉标
  ctx.save();
  ctx.beginPath();
  ctx.arc(rx + 3.5, 370, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = tokens.velvetAccent;
  ctx.fill();

  ctx.font = `700 15px ${ FONT_LATIN }`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('弹幕 DANMU', rx + 15, 370);
  ctx.restore();
}

export async function renderVideoBackdropCanvas(meta: GraphicsMeta, title: string): Promise<Buffer | null> {
  if (!canUseCanvas()) return null;

  const canvas: HTMLCanvasElement = document.createElement('canvas');

  canvas.width = W;
  canvas.height = H;

  const ctx: CanvasRenderingContext2D = canvas.getContext('2d')!;

  if (meta.stage) drawStageBackdropOn(ctx, meta.stage, title);
  else if (meta.radio) drawRadioBackdropOn(ctx, meta, title);
  else drawLiveBackdropOn(ctx, meta, title);

  return await canvasToBuffer(canvas, 'image/png');
}

/* 改标题时只需要重绘顶部/侧栏标题这一块（偶数坐标，供 ffmpeg overlay 直接无痕覆盖渐变/丝绒底） */
export function retitlePatchRect(meta: Pick<GraphicsMeta, 'stage' | 'radio'>): PatchRect {
  if (meta.stage) return { x: STAGE_VIDEO.width + 4, y: 156, w: W - STAGE_VIDEO.width - 4, h: 180 };

  if (meta.radio) return { x: LEFT_WIDTH, y: 0, w: RIGHT_W, h: 146 };

  return { x: LEFT_WIDTH, y: 0, w: RIGHT_W, h: 132 };
}

export async function renderRetitlePatchCanvas(meta: GraphicsMeta, title: string): Promise<{ buffer: Buffer; rect: PatchRect } | null> {
  if (!canUseCanvas()) return null;

  const full: HTMLCanvasElement = document.createElement('canvas');

  full.width = W;
  full.height = H;

  const fullCtx: CanvasRenderingContext2D = full.getContext('2d')!;

  if (meta.stage) drawStageBackdropOn(fullCtx, meta.stage, title);
  else if (meta.radio) drawRadioBackdropOn(fullCtx, meta, title);
  else drawLiveBackdropOn(fullCtx, meta, title);

  const patchRect: PatchRect = retitlePatchRect(meta);
  const patch: HTMLCanvasElement = document.createElement('canvas');

  patch.width = patchRect.w;
  patch.height = patchRect.h;
  patch.getContext('2d')!.drawImage(full, patchRect.x, patchRect.y, patchRect.w, patchRect.h, 0, 0, patchRect.w, patchRect.h);

  return { buffer: await canvasToBuffer(patch, 'image/png'), rect: patchRect };
}
