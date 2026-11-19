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
| 应用外壳：常驻侧边栏（功能列表、下载队列、代理状态）、页面切换动效、Ctrl+K 搜索功能、Ctrl+B 收起侧边栏 | `shell/AppShell.tsx`、`shell/navConfig.tsx`、`shell/shellStore.ts`、`shell/CommandPalette.tsx`、`shell/shell.global.sass` | `src/index.tsx`（包住 `<Routers />`） |
| 自绘标题栏（Windows）：系统标题栏隐藏，标题由界面显示，右上角仍是系统的最小化 / 最大化 / 关闭按钮 | `shell/AppShell.tsx`、`packages/main/src/custom/windowTuning.mts` | `packages/main/src/ProcessWindow.mts` |
| 设置页面：账号、保存位置、直播录制格式、代理、明暗主题、主题色、工具路径（界面上的设置 > `local/pocket48.json` > 默认值） | `settings/SettingsPage.tsx`、`settings/settingsStore.ts`、`settings/settings.global.sass` | `router/Routers.tsx`（`Settings` 路由）、`components/basic/AntdConfig/AntdConfig.tsx`（主题色） |
| 口袋房间消息改成聊天界面：搜索成员（带头像）、关注列表、上滑自动加载更早的消息、每分钟自动取最新消息、每条消息带发送者头像（别的成员串门发的消息显示名字）、点「直播」卡片播放直播或回放（查不到时提示已失效）、消息缓存在本机（IndexedDB，下次打开先显示本地的，再补上新发的）、导出（原版页面 `pages/48/RoomMessage` 保留不动） | `room/RoomPage.tsx`、`room/roomStore.ts`、`room/MessageBubble.tsx`、`room/liveCard.ts`、`room/roomCache.ts`、`room/room.global.sass` | `pages/48/Index.tsx` 的 `RoomMessage` 路由 |
| 房间的「全部消息」（成员 + 粉丝）：标题栏可以切换「只看成员 / 全部消息」，默认只看成员。用的是抓包得到的 `list/all` 接口。两种消息各自缓存；每次进入房间两种都会取并存到本机（没在看的那种在后台取）。全部消息每个房间本地最多保留最新 20000 条（`localStorage` 的 `ROOM_ALL_CACHE_MAX` 可以改）。缓存改成分批读取（每次 500 条），数据库升到版本 2。导出的是本地已有的全部内容 | `room/roomApi.ts`、`room/roomCache.ts`、`room/roomStore.ts`（`RoomStream`、`setMode`、`readAllCached`）、`room/MessageBubble.tsx`（粉丝 / 礼物消息的显示） | `room/RoomPage.tsx`；`pages/48/RoomMessage/utils/formatData.ts` 的 `formatSendData` 加了 `keepAll` 参数（导出全部消息时保留粉丝的消息） |
| 关注成员的新消息提示：后台每 2 分钟检查一次关注成员的房间，未读条数显示在关注列表的头像气泡和侧边栏「房间消息」上；进入房间后清零，并用「以下是新消息」标出从哪里开始没看过；这条线在屏幕上方时，右上角有「N 条新消息」按钮，点一下跳到第一条新消息。「看到哪了」存在本机（localStorage 的 `ROOM_UNREAD`） | `room/unreadStore.ts`、`room/unreadWatcher.ts`、`room/RoomUnreadBadge.tsx` | `shell/AppShell.tsx`（启动后台检查、侧边栏数字）、`room/roomStore.ts`（`reportMessages`）、`room/RoomPage.tsx` |
| 关闭窗口后留在后台运行（Windows 系统托盘）：点 × 只是收起窗口，直播抓取、下载、房间新消息检查继续；托盘图标单击打开窗口，右键可以关掉这个功能或退出。设置页面有开关和「退出程序」按钮。`48tools.exe --quit` 可以让正在运行的程序正常退出（打包脚本的启动检查用它） | `main/src/custom/backgroundTray.mts`、`main/src/custom/backgroundChannel.ts`、`settings/BackgroundOption.tsx` | `main/src/ProcessWindow.mts`（`keepInBackground`）、`main/src/custom/singleInstance.mts`（`--quit`）、`main/src/commend.mts`（`partial: true`，否则 `--quit` 会被当成未知参数报错）、`settings/SettingsPage.tsx`、`scripts/custom/packWin64.mjs`（启动检查） |
| 回放窗口的弹幕跟着播放进度出现：右边的弹幕栏默认「跟随播放」，视频播到哪里弹幕出到哪里，新的从下面冒出来并自动滚到最新；往上翻时停止自动滚动，出现「N 条新弹幕」按钮；拖动进度条时弹幕跟着变；点弹幕前面的时间，视频跳到那一刻。「全部」是整份弹幕（原版的看法），标出当前播到的那一条。跟随播放只画最近 200 条（原版 `pages/PlayerWindow/Danmu/RecordDanmu.tsx` 保留不动） | `player/ReplayDanmu.tsx`、`player/danmuTimeline.ts`、`player/replayDanmu.global.sass` | `pages/PlayerWindow/PlayerWindow.tsx` 的 `danmuRender`（回放时用 `ReplayDanmu`） |
| Electron 从 35 升到 45（35 在 2025 年 9 月已停止维护；上游仍停在 35）。界面里不能再用 electron 的 `clipboard`，换成同名的替代（浏览器自带的剪贴板接口）；打包时如果 `node_modules/electron/dist` 不存在会先下载（42 起安装依赖不再自动下载 Electron）；安装后脚本改成可以重复执行（原来每装一次就给 `@reduxjs/toolkit` 的源码多加一行 `@ts-expect-error`，第二次安装后构建会报错）。回退：切回升级前的提交，重新 `yarn install` 再打包 | `compat/clipboard.ts`、`scripts/custom/packWin64.mjs`（`ensureElectronDist`） | 根目录和 `packages/48tools` 的 `package.json`（electron 版本）、`yarn.lock`；`Pocket48Login.tsx`、`GetLiveUrl.tsx`、`Pocket48Live.tsx`、`Pocket48Record.tsx` 的 `clipboard` import；`scripts/postInstall.mts` 的 `fixReduxjsToolkitTypeError` |
| 顶层页面的「返回」换成页面标题（子页面仍然显示返回） | `shell/PageTitle.tsx` | `components/Header/Header.tsx` |
| 新首页：常用功能卡片、当前任务、全部功能、设置、关于（原版首页 `pages/Index/Index.tsx` 保留不动） | `home/HomeDashboard.tsx`、`home/home.global.sass` | `router/Routers.tsx` 的首页路由 |
| 表格「操作」列：常用按钮 + 「更多」菜单；「标题」列带封面；窄窗口时表格横向滚动 | `table/RowActions.tsx`、`table/MediaTitleCell.tsx` | `Pocket48Record.tsx`、`Pocket48Live.tsx` 的列定义和 `<Table>` |
| 主窗口：默认宽 1280、画好再显示（不闪白屏）、最小化时定时器不降频、缓存编译后的脚本 | `packages/main/src/custom/windowTuning.mts` | `packages/main/src/ProcessWindow.mts` |
| 下载队列：侧边栏底部的入口（显示进行中的任务数和总进度），任何页面都能看到录播下载、直播录制、转 mp4 的进度 | `downloadQueue/downloadQueue.ts`、`downloadQueue/DownloadQueuePanel.tsx`、`downloadQueue/recordTasks.ts` | `shell/AppShell.tsx`（面板）、`Pocket48Record.tsx`（开始 / 进度 / 结束） |
| 音频断点续传（每 40 个分片记录一次进度到「文件名.part.json」）、m4a 写入标题 / 成员 / 日期 | `download/audioExtract.ts`、`download/audioResumeState.ts`、`download/audioResume.tsx` | `Pocket48Record.tsx`（下载音频前询问是否接着下）、`Pocket48M3u8Download.worker.ts`（`resume`、`audioMeta`） |
| 窗口标题加「-custom」（`48tools - 上游版本号-custom`）；打包的提交号记在程序目录的 `resources/app/build-info.json` | `buildInfo/buildLabel.ts` | `src/index.tsx` |
| 打包后的程序也能找到 `local/`（从 exe 所在目录往上找） | `pocket48Proxy/pocket48Proxy.ts` | 无 |
| 只打包 Windows 64 位：`node --run pack:win`，输出 `build/48tools-win64/48tools.exe`；最后替换程序目录时如果文件夹暂时被占用（比如杀毒软件在扫描），会自动重试 | `scripts/custom/packWin64.mjs` | 根目录 `package.json` 的 `pack:win` |
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
| 现代化主题（分层背景、更轻的表格、更快的动效） | `theme/modernTheme.ts` | `components/basic/AntdConfig/AntdConfig.tsx`；窗口底色同步改在 `components/basic/Theme/stylesheet.pug` 和 `packages/main/src/custom/windowTuning.mts` |
| 统一的「返回」按钮 | `theme/backButton.tsx` | `components/Header/Header.tsx`、`LiveOptions.tsx`、`Agreement.tsx` |
| 原版首页按平台分组（原版首页现在不再作为首页显示，改动保留） | `home/navGroups.tsx` | `pages/Index/Index.tsx` 的 `nativeRender` |
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
- 界面代码开启了 React Compiler（自动缓存组件的渲染结果）。组件渲染时**不要直接读会变化的外部数据**
  （例如 `localStorage`、模块里的变量、`getSetting()`、`isFollowed()`），也不要原地修改已经交给界面的对象；
  否则数据变了界面不刷新。正确的做法：数据放进 store，用 `useSyncExternalStore` 之类的 hook 取出来，再从它算出要显示的值；
  更新时生成新的对象（参考 `downloadQueue/downloadQueue.ts`、`settings/settingsStore.ts`、`room/roomStore.ts`）。
- 口袋48的接口地址和请求头都是抓包得来的，过期时界面会提示「可能需要重新抓包更新」，到时更新
  `pocket48Headers/pocket48ClientInfo.ts` 和 `services/48/index.ts`。

## 测试

`custom/` 下有少量单元测试（`*.spec.ts`），在 `packages/48tools` 目录运行 `node --run test`。
