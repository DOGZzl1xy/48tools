# custom/ —— 本仓库在原版 48tools 之上的改动

自定义逻辑都放在这里（主进程的在 `packages/main/src/custom/`），原版文件里只留很少的「接入点」，
方便以后合并原作者的更新。合并冲突时，只需要按下表把接入点重新加回去。

本机私有配置（代理节点、登录 token）在仓库根目录的 `local/`，已被 `.gitignore` 忽略。

## 模块与接入点

| 功能 | 模块 | 接入点（原版文件） |
| --- | --- | --- |
| 口袋48接口走代理、接口默认 20 秒超时 | `pocket48Proxy/pocket48Got.ts`、`pocket48Proxy/pocket48Proxy.ts` | `services/48/index.ts`、`services/48/login/index.ts`：`got` 换成 `pocket48Got` |
| 启动应用时自动拉起 `local/xray` 代理并守护（每 15 秒检查，没在运行就重启），退出时关闭；认领上次强制结束留下的 xray | `packages/main/src/custom/pocket48ProxyLauncher.mts` | `packages/main/src/main.mts` |
| 只允许运行一个 48tools，再次双击会把已有窗口调到前面 | `packages/main/src/custom/singleInstance.mts` | `packages/main/src/main.mts` |
| 首页「口袋48代理」按钮显示代理是否在运行；接口出错时的说明（代理没运行 / IP 被拒 / 接口或版本可能过期，需要重新抓包） | `pocket48Api/apiErrorText.ts`、`pocket48Proxy/Pocket48ProxyOption.tsx`、`pocket48Record/recordListError.ts` | `Pocket48Record.tsx`、`utils/autoGrab.ts` |
| 直播录制断线重连（3 秒后重连，查询失败会重试，连续 3 次秒断才结束）、ffmpeg 日志只留最近 300 条 | `live/liveReconnect.ts` | `Pocket48LiveDownload.worker.ts`、`DownloadAndTranscoding.worker.ts` 的 ffmpeg 结束回调 |
| 自动抓取：按成员 ID 匹配（原版写错不生效）、昵称不再当正则、出错有提示、一个成员出错不影响其他成员 | `live/autoGrabHelpers.ts` | `utils/autoGrab.ts` |
| 自动录制保存到 `local/pocket48.json` 的 `liveRecordDir`（没有就用 `downloadDir`）；录完按 `liveRecordFormat` 转成 mp4（无损封装或压缩） | `live/liveRecording.ts`、`live/convertRecording.ts`、`live/LiveRecordDirHint.tsx` | `utils/autoGrab.ts`、`Pocket48Live.tsx`（录制开始 / 结束）、`LiveOptions.tsx`（提示） |
| 下载队列：右下角悬浮按钮，任何页面都能看到录播下载、直播录制、转 mp4 的进度 | `downloadQueue/downloadQueue.ts`、`downloadQueue/DownloadQueuePanel.tsx`、`downloadQueue/recordTasks.ts` | `src/index.tsx`（面板）、`Pocket48Record.tsx`（开始 / 进度 / 结束） |
| 音频断点续传（每 40 个分片记录一次进度到「文件名.part.json」）、m4a 写入标题 / 成员 / 日期 | `download/audioExtract.ts`、`download/audioResumeState.ts`、`download/audioResume.tsx` | `Pocket48Record.tsx`（下载音频前询问是否接着下）、`Pocket48M3u8Download.worker.ts`（`resume`、`audioMeta`） |
| 窗口标题显示「自定义版 提交号（日期）」 | `buildInfo/buildLabel.ts`（读取打包脚本写的 `build-info.json`） | `src/index.tsx` |
| 打包后的程序也能找到 `local/`（从 exe 所在目录往上找） | `pocket48Proxy/pocket48Proxy.ts` | 无 |
| 只打包 Windows 64 位：`node --run pack:win`，输出 `build/48tools-win64/48tools.exe` | `scripts/custom/packWin64.mjs` | 根目录 `package.json` 的 `pack:win` |
| 直播录制断线重连也走代理 | `pocket48Proxy/pocket48Proxy.ts` | `Pocket48Live.tsx`、`utils/autoGrab.ts` 传 `pocket48Proxy`；两个直播下载 worker 调 `setPocket48ProxyForWorker` |
| 请求头模拟 iOS 口袋48 7.1.48，设备 ID 本机固定 | `pocket48Headers/pocket48ClientInfo.ts` | `utils/snh48.ts` 的 `createHeaders` |
| 首页「口袋48代理」设置 | `pocket48Proxy/Pocket48ProxyOption.tsx` | `pages/Index/Index.tsx` |
| 登录弹窗自动填入 `local/pocket48.json` 的 token | `pocket48Proxy/pocket48Proxy.ts` | `Pocket48Login.tsx`、`TokenForm.tsx` |
| 录播列表加载失败提示（403 等） | `pocket48Record/recordListError.ts` | `Pocket48Record.tsx` |
| 下载速度、剩余时间、进度条 | `download/downloadMeter.ts`、`download/formatProgress.ts`、`download/ffmpegStats.ts`、`download/ProgressDetailSet.ts`、`download/ProgressDetail.tsx` | `Pocket48M3u8Download.worker.ts`、`FFmpegDownload.worker.ts`、`reducers/pocket48.ts`、`Pocket48Record.tsx` |
| 分片下载失败自动重试（最多 5 次）、卡住 30 秒自动断开重试 | `download/segmentRetry.ts` | `Pocket48M3u8Download.worker.ts` 的 `downloadSegment`（超时）和 `downloadSegmentWithRetry` |
| 分片并行下载（同时 4 个，按顺序处理），停止时取消所有请求 | `download/segmentPrefetcher.ts` | `Pocket48M3u8Download.worker.ts` 的 `downloadParts`、`downloadSegment`（登记请求）、`run`、`stop`；`download/audioExtract.ts` |
| 保存对话框默认打开 `local/pocket48.json` 里 `downloadDir` 指定的文件夹 | `download/defaultSaveDir.ts` | `utils/remote/dialog.ts` 的 `showSaveDialog` |
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
- 根目录 `tsconfig.json`：`skipLibCheck: true`；`.gitignore`：不再忽略 `yarn.lock`，忽略 `local/`；`.gitattributes`：文本文件统一用 LF。

## 写新代码时要注意

- 界面代码（`packages/48tools`）的生产构建会用 `babel-plugin-delay-require` 把 node 模块（`fs`、`path`、`process` 等）改成用到时才加载，
  加载语句插在所在代码块的开头。所以**不要在 `for` / `while` 的头部直接调用 node 模块**（例如 `for (const x of [process.cwd()])`），
  先把值存到变量里再循环。开发模式不会出问题，只有打包后才报错；打包脚本会检查这种写法，并在打包后启动一次程序确认没有报错。
- 口袋48的接口地址和请求头都是抓包得来的，过期时界面会提示「可能需要重新抓包更新」，到时更新
  `pocket48Headers/pocket48ClientInfo.ts` 和 `services/48/index.ts`。

## 测试

`custom/` 下有少量单元测试（`*.spec.ts`），在 `packages/48tools` 目录运行 `node --run test`。
