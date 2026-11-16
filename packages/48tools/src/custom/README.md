# custom/ —— 本仓库在原版 48tools 之上的改动

自定义逻辑都放在这里（主进程的在 `packages/main/src/custom/`），原版文件里只留很少的「接入点」，
方便以后合并原作者的更新。合并冲突时，只需要按下表把接入点重新加回去。

本机私有配置（代理节点、登录 token）在仓库根目录的 `local/`，已被 `.gitignore` 忽略。

## 模块与接入点

| 功能 | 模块 | 接入点（原版文件） |
| --- | --- | --- |
| 口袋48接口走代理、接口默认 20 秒超时 | `pocket48Proxy/pocket48Got.ts`、`pocket48Proxy/pocket48Proxy.ts` | `services/48/index.ts`、`services/48/login/index.ts`：`got` 换成 `pocket48Got` |
| 直播录制断线重连也走代理 | `pocket48Proxy/pocket48Proxy.ts` | `Pocket48Live.tsx`、`utils/autoGrab.ts` 传 `pocket48Proxy`；两个直播下载 worker 调 `setPocket48ProxyForWorker` |
| 请求头模拟 iOS 口袋48 7.1.48，设备 ID 本机固定 | `pocket48Headers/pocket48ClientInfo.ts` | `utils/snh48.ts` 的 `createHeaders` |
| 首页「口袋48代理」设置 | `pocket48Proxy/Pocket48ProxyOption.tsx` | `pages/Index/Index.tsx` |
| 登录弹窗自动填入 `local/pocket48.json` 的 token | `pocket48Proxy/pocket48Proxy.ts` | `Pocket48Login.tsx`、`TokenForm.tsx` |
| 录播列表加载失败提示（403 等） | `pocket48Record/recordListError.ts` | `Pocket48Record.tsx` |
| 下载速度、剩余时间、进度条 | `download/downloadMeter.ts`、`download/formatProgress.ts`、`download/ffmpegStats.ts`、`download/ProgressDetailSet.ts`、`download/ProgressDetail.tsx` | `Pocket48M3u8Download.worker.ts`、`FFmpegDownload.worker.ts`、`reducers/pocket48.ts`、`Pocket48Record.tsx` |
| 只下载音频（边下载边提取 AAC，保存为 m4a） | `download/audioExtract.ts` | `Pocket48M3u8Download.worker.ts`（`audioOnly`）、`FFmpegDownload.worker.ts`（`audioOnly`）、`Pocket48Record.tsx`（按钮） |
| 现代化主题 | `theme/modernTheme.ts` | `components/basic/AntdConfig/AntdConfig.tsx`；暗黑背景色同步改在 `components/basic/Theme/stylesheet.pug` |
| 统一的「返回」按钮 | `theme/backButton.tsx` | `components/Header/Header.tsx`、`LiveOptions.tsx`、`Agreement.tsx` |
| 首页按平台分组 | `home/navGroups.tsx` | `pages/Index/Index.tsx` 的 `nativeRender` |
| 只用浏览器打开 http(s) 链接 | `security/safeOpenExternal.ts` | `MessageDisplay.tsx`、`Credits/Software/Software.tsx` |
| 主窗口、播放器窗口禁止跳到外部网页 / 打开新窗口 | `packages/main/src/custom/windowGuards.mts` | `ProcessWindow.mts`、`ipcListener/openPlayerHtml.mts` |
| 开发模式 F5 / Ctrl+R 刷新、F12 开发者工具 | `packages/main/src/custom/devShortcuts.mts` | 同上 |

## 原版文件里的其他小改动

- `services/48/index.ts`：录播列表请求显式传 `record: true`；按成员查询不再先请求一次最新列表。
- `Pocket48Record.tsx`：下载结束后删除中间生成的 `.m3u8` 文件。
- `pages/Index/FFmpegOption/FFmpegOption.tsx`：「FFmpeg配置」按钮不再用红色。
- `sweet.config.ts`：把 DLL 配置里已弃用的 `[hash]` 换成 `[fullhash]`。
- `scripts/utils.mjs`：Windows 下用拼好的命令字符串调用 shell，消除 Node 的 DEP0190 警告。
- 根目录 `tsconfig.json`：`skipLibCheck: true`；`.gitignore`：不再忽略 `yarn.lock`，忽略 `local/`。
