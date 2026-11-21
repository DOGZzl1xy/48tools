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
| 自绘标题栏（Windows）：系统标题栏隐藏，标题由界面显示，右上角仍是系统的最小化 / 最大化 / 关闭按钮。从左右滑出的面板（下载队列等）从标题栏下面开始，否则它的关闭按钮落在拖动窗口的区域里点不动 | `shell/AppShell.tsx`、`packages/main/src/custom/windowTuning.mts` | `packages/main/src/ProcessWindow.mts` |
| 设置页面：账号、保存位置、直播录制格式、代理、明暗主题、主题色、工具路径（界面上的设置 > `local/pocket48.json` > 默认值） | `settings/SettingsPage.tsx`、`settings/settingsStore.ts`、`settings/settings.global.sass` | `router/Routers.tsx`（`Settings` 路由）、`components/basic/AntdConfig/AntdConfig.tsx`（主题色） |
| 口袋房间消息改成聊天界面：搜索成员（带头像）、关注列表、上滑自动加载更早的消息、每分钟自动取最新消息、每条消息带发送者头像（别的成员串门发的消息显示名字）、点「直播」卡片播放直播或回放（查不到时提示已失效）、消息缓存在本机（IndexedDB，下次打开先显示本地的，再补上新发的）、导出（原版页面 `pages/48/RoomMessage` 保留不动） | `room/RoomPage.tsx`、`room/roomStore.ts`、`room/MessageBubble.tsx`、`room/liveCard.ts`、`room/roomCache.ts`、`room/room.global.sass` | `pages/48/Index.tsx` 的 `RoomMessage` 路由 |
| 房间的「全部消息」（成员 + 粉丝）：标题栏可以切换「只看成员 / 全部消息」，默认只看成员。用的是抓包得到的 `list/all` 接口。两种消息各自缓存；每次进入房间两种都会取并存到本机（没在看的那种在后台取）。全部消息每个房间本地最多保留最新 20000 条（`localStorage` 的 `ROOM_ALL_CACHE_MAX` 可以改）。缓存改成分批读取（每次 500 条），数据库升到版本 2。导出的是本地已有的全部内容 | `room/roomApi.ts`、`room/roomCache.ts`、`room/roomStore.ts`（`RoomStream`、`setMode`、`readAllCached`）、`room/MessageBubble.tsx`（粉丝 / 礼物消息的显示） | `room/RoomPage.tsx`；`pages/48/RoomMessage/utils/formatData.ts` 的 `formatSendData` 加了 `keepAll` 参数（导出全部消息时保留粉丝的消息） |
| 语音转文字：房间里的语音（语音消息、翻牌的语音回答）后面有「转文字」按钮，点一下把语音发给配置好的接口识别，文字显示在播放条下面。转好的文字和这段语音都存在本机（IndexedDB 的 `custom-transcripts`，和房间消息缓存分开，清除房间缓存不会删掉），同一条语音只转一次；原来的语音地址失效时改用本机存的那份播放。设置页「语音转文字」里选接口类型：Google Gemini（`generateContent`，默认模型 `gemini-3.5-flash-lite`）或 OpenAI 兼容（`/audio/transcriptions`，给用其他服务商的人），填 API key、模型、接口地址，「测试」按钮用 key 取一次模型列表。「参考聊天内容」开关（默认开）：转写时把语音前后的文字一起发给接口，帮模型把粉丝昵称、礼物名写对——取语音前 10 分钟到后 2 分钟里成员自己发的文字（离语音最近的 12 条）、前 15 分钟里粉丝送的礼物（谁送了什么），翻牌语音还带上提问；消息从房间的本地缓存和已加载的消息里读。Gemini 是把它们作为「参考」写进提示，OpenAI 兼容接口是放进 `prompt` 字段（只取最后 400 字）。关掉就只发语音（`sttHints: false`）。两种接口各存各的 key；key 只在请求头里，只发给填写的接口地址，地址必须是 https。key 也可以写在 `local/pocket48.json`（`sttGeminiKey` / `sttOpenaiKey`） | `transcribe/transcribeApi.ts`、`transcribe/transcribeStore.ts`、`transcribe/voiceHints.ts`、`transcribe/transcriptCache.ts`、`transcribe/VoiceMessage.tsx`、`transcribe/TranscribeOption.tsx` | `room/MessageBubble.tsx`（语音改用 `VoiceMessage`）、`settings/SettingsPage.tsx`、`settings/settingsStore.ts`（`stt*` 设置项）、`room/roomCache.ts`（`readRoomCacheBetween`：按时间段读缓存）、`room/room.global.sass` |
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
| 房间页面拆成几块（原来一个 673 行的文件）：成员栏、聊天区、滚动、导出、查找各管各的 | `room/RoomPage.tsx`（外壳）、`room/MemberPanel.tsx`、`room/ChatView.tsx`、`room/useChatScroll.ts`、`room/roomExport.ts`、`room/RoomSearch.tsx` | 同上（`pages/48/Index.tsx` 的 `RoomMessage` 路由） |
| 房间消息只画一段：已加载的消息再多，页面上最多同时画 600 条（往上翻多画一批、把最下面的收掉，往下同理），翻得再远也不会越来越卡；跳转、加载更早的消息时眼前的内容不动。右下角有「回到底部」，离开底部期间来了新消息会变成「有新消息」 | `room/useChatScroll.ts` | `room/ChatView.tsx` |
| 成员的队伍和拼音：房间的成员栏、标题、别的成员串门发的消息、首页都显示队伍（沈馨 → NII）；搜索成员可以输入名字、拼音（全拼，或姓和名的首字母）、成员 ID、队伍。数据是原版就在用的公开成员名单（`services/48/jsdelivrCDN` 的 `roomId.json`），存在本机，一天更新一次，请求里不带账号信息 | `room/memberDirectory.ts`、`room/memberSearch.ts` | `room/MemberPanel.tsx`、`room/ChatView.tsx`、`home/HomeDashboard.tsx`、`live/AutoGrabOptionsPage.tsx` |
| 在房间里查找：搜索本机存下来的消息（文字、回复、翻牌、发送者名字、语音转好的文字），或者跳到某一天；点结果会把那里到现在的消息读出来并滚过去 | `room/RoomSearch.tsx`、`room/roomSearchText.ts`、`room/roomCache.ts`（`searchRoomCache`、`firstCachedSince`）、`room/roomStore.ts`（`loadBackTo`） | `room/ChatView.tsx`（标题栏的放大镜） |
| 房间消息的时间可以按北京时间显示（「更多」菜单里，设置项 `roomBeijingTime`）；鼠标放到时间上显示完整日期和时间；`[太阳]` 这类文字表情显示成 emoji；清除房间缓存前先确认；成员栏可以收起成一列头像（窗口窄时默认收起） | `room/roomTime.ts`、`room/emojiText.ts`、`room/ChatView.tsx`、`room/MemberPanel.tsx` | `room/MessageBubble.tsx` |
| 语音播放条换成自己画的（跟着主题变色，没播放也显示时长，同一时间只播一条）；转好的文字可以复制；重新转失败时原来的文字不丢；参考内容按语音所在的房间找；导出房间消息时带上转好的文字；转过的语音文件只保留 6 个月（启动后自动清理，文字一直保留，缓存数据库升到版本 2） | `transcribe/VoicePlayer.tsx`、`transcribe/VoiceMessage.tsx`、`transcribe/transcribeStore.ts`、`transcribe/transcriptCache.ts`（`purgeOldAudio`、`getAllTranscripts`）、`room/roomExport.ts` | `room/MessageBubble.tsx`、`shell/AppShell.tsx`（启动后清理）、`pages/48/RoomMessage/utils/HTMLComponents.tsx`（导出的 HTML 里显示 `transcript`） |
| API key 加密保存：存进 localStorage 之前用系统的加密功能（Windows 的 DPAPI，绑定当前 Windows 用户）加密，以前明文保存的会在下次启动时自动换成加密的；换电脑或换用户后解不开，需要重新填 | `settings/secretBox.ts`、`settings/settingsStore.ts`、`packages/main/src/custom/secretStore.mts`、`packages/main/src/custom/secretChannel.ts` | `packages/main/src/main.mts`（`registerSecretStore`） |
| 自动抓取随程序启动：启动几秒后自动开始监听（设置里可以关：`autoGrabAutoStart`），录制方式用上次手动开始时选的（`autoGrabMode`）；运行时侧边栏「直播抓取」上有绿点，首页也显示状态 | `live/autoGrabRunner.ts` | `shell/AppShell.tsx`（启动）、`Pocket48Live.tsx`（手动开始时记住录制方式） |
| 新的自动抓取配置页：成员从名单里选（按名字、拼音、队伍搜，可以一键加入关注的成员），名单里没有的另外输入；设置页指定了录制文件夹时这里不用再填目录。保存的格式和原版一样（原版页面 `pages/48/Pocket48/LiveOptions` 保留不动） | `live/AutoGrabOptionsPage.tsx` | `pages/48/Index.tsx` 的 `LiveOptions` 路由 |
| 下载队列的记录保留到重启后（localStorage 的 `DOWNLOAD_QUEUE_HISTORY`；关闭时没完成的显示成「已停止」），右上角「清除记录」清掉已经结束的记录（不删文件）；录播下载点了停止的显示「已停止」并说明下载到一半的内容留在哪里（视频在保存的文件里，音频在 `.part.aac` 里可以接着下，备用方案在 `.cache` 文件夹里），以前文件已经存在时会误显示成「已完成」；失败或停止的录播下载可以「重试」（这次运行里开始的任务才有） | `downloadQueue/downloadQueue.ts`、`downloadQueue/DownloadQueuePanel.tsx`、`downloadQueue/recordTasks.ts` | `Pocket48Record.tsx`（`recordTaskStart` 传入重试函数；`handleStopClick` 调 `recordTaskStopping`） |
| 首页改成看得到东西的：常用功能、关注的成员（未读数、最新一条消息）、正在直播（和自动抓取的状态）、最近的下载。原来的「全部功能」和侧边栏重复，去掉了 | `home/HomeDashboard.tsx`、`home/home.global.sass` | 无（仍是首页路由） |
| 设置页：顶部有分区导航；明暗主题直接三选一（不用再点开弹窗）；加了「直播抓取」一节；FFmpeg 那一行不再显示原版的红色提示 | `settings/SettingsPage.tsx`、`settings/SettingsRow.tsx`、`settings/settings.global.sass` | `components/basic/Theme/ThemeProvider.tsx`、`ThemeContext.ts`（多给出 `theme`、`changeTheme`） |
| Ctrl+K 还能搜到设置、下载队列、自动抓取配置；方向键选到看不见的项时列表跟着滚。侧边栏：窗口拖窄时自动收起、拖宽时恢复；同一平台的「视频」和「直播」图标用线条 / 实心区分 | `shell/CommandPalette.tsx`、`shell/shellStore.ts`、`shell/navConfig.tsx` | 无 |
| 录播下载页：进入时自动加载列表；选了队伍、选了成员（或清空、输入 ID 后回车）马上只显示对应的录播，不用再点「刷新列表」；去掉「加载列表」按钮，翻到最后一页自动加载下一批，直到取不到为止；没有任务在下载时不显示「下载进度」一列；操作列固定在右边（直播抓取页也是）。公演录播页：进来时下拉框提示「先选择队伍」，选了就自动加载，同样翻到最后一页自动加载 | `table/useAutoLoadMore.ts` | `Pocket48Record.tsx`、`Pocket48Live.tsx`、`Live48/InVideo/InVideo.tsx` |
| 录播自动切片：在「录播下载」里点一场直播（电台没有）的「更多 → 自动切片」，选做几个（或者自动：只做爆点分 8.5 分以上的，门槛在设置页「录播切片」里改；提示里要求模型严格打分）。程序把整场录播下载到工作文件夹（和普通录播下载一样同时下 4 个分片、卡住或失败自动重试，下完在本机合成一个 mp4；停止后再来时下好的分片不用重下），每半小时一段把音频和弹幕（只有时间和内容，不带昵称，礼物消息不发）交给 Gemini 找爆点和时间，提示里解释了粉丝的反应词（爆、典、串、急…），带上专有词汇（存在本机的文本文件里：有 `local/` 时是 `local/专有词汇.txt`，否则在 AppData 的 `48tools-custom` 里；第一次用时写入默认内容，设置页「录播切片 → 专有词汇」的按钮打开它所在的文件夹。「词：说明」告诉 Gemini 怎么写，「错 → 对」在它写完后直接替换），并附上程序数好的「弹幕突然变多、反应扎堆」的时刻；再把每个片段交给 Gemini 出逐句字幕、标出哪些句子留下、重点词、三个写法互不相同的标题（提示里要求像粉丝自己起的、不套公式，最长 16 个字；第一个用在画面和封面上、太长时自动缩小，另外两个写在说明里备选）、片段里另外的爆点的短标题（发布用的标题里接在主标题后面：「主标题 | 第二个爆点 | 日期 直播切片」）、2～3 句简介、封面看点，以及除了主播还有谁是主角（连麦的人、被认真讨论的成员，只是提到名字的不算）；模型标的每句话的时间不稳定（偶尔整段早一两秒，字幕就比声音早一句），所以用这段声音里的停顿和音节位置把每句话对回去；在设置页「录播切片」里装了「本地打轴模型」（可选的插件：sherpa-onnx 的命令行识别程序加 SenseVoice 小模型，从 GitHub 下载约 184MB、核对 SHA-256，装在 `%LOCALAPPDATA%\48tools-plugins\aligner`，可以卸载）时，再用本机识别出来的每个字的时间给字幕定时间（文字还是用 Gemini 的；人名、英文、数字被本地模型听错的句子，按前后对上的句子中间夹着的那串字定时间），更准、每次结果一样；然后用 ffmpeg 剪掉沉默和无关的话，合成 1920×1080 的横屏视频（左边直播画面，右上她说的话、重点词加粗变黄，右下弹幕往上滚），并从成片里让 Gemini 挑一帧做封面（右边盖磨砂玻璃，写标题和看点；16:9 和 4:3 各一张）。每场录播一个文件夹，里面是成片（mp4）、两张封面（jpg）、说明（txt：发布用的标题「【沈馨】短标题 | 20261115 直播切片」，有其他主角时是「【沈馨&徐佳琳】…」、简介、看点、在录播里的位置）和一份汇总；工作文件夹做完自动删除，失败或停止时留着，重试时下载好的录播和问过 Gemini 的结果不用重来。进度在下载队列和录播列表的「下载进度」列里（下载时有速度和剩余时间）。可以连着加几场：同一时间只切一场，前一场开始切的时候后一场就开始下载，最多提前下载好一场；排队中的任务点「停止」立刻取消。Gemini 默认走按量付费的接口（key 和接口地址用「语音转文字」里 Google Gemini 的那一份）；设置页「录播切片 → Gemini 走哪里」可以改成本机的 agy（Antigravity 的命令行，用它登录的订阅额度）：音频写到临时文件夹里让它自己读，它说的时间不准（半小时的音频能差几分钟），所以找爆点时让它给出开头、结尾和关键的原话，再到本地打轴模型的识别结果里按原话定位，必须先装本地打轴模型（这时改成 20 分钟一段、重叠 5 分钟，实测比整段半小时找得多、说的时间也准一些）；模型在设置页「录播切片」里改（默认 `gemini-4-hydrogen`）。字体：电脑上装了思源黑体就用它，否则用微软雅黑。需要带 libx264 和 libass 的 ffmpeg | `highlight/highlightPipeline.ts`（流程）、`highlight/highlightDownload.ts`（下载录播）、`highlight/highlightQueue.ts`（排队）、`highlight/highlightGemini.ts`（怎么问 Gemini）、`highlight/highlightAlign.ts`（字幕对准声音）、`highlight/highlightTokens.ts`（本地打轴）、`highlight/highlightAgy.ts`（走本机的 agy）、`highlight/highlightQuotes.ts`（按原话定位）、`highlight/highlightGlossary.ts`、`highlight/glossaryFile.ts`（专有词汇）、`highlight/alignerRun.ts` 和 `highlight/alignerPlugin.ts`（本地打轴插件的调用、安装卸载）、`highlight/AlignerOption.tsx`、`highlight/highlightCut.ts`（剪辑点）、`highlight/highlightAss.ts`（画面排版）、`highlight/highlightFfmpeg.ts`、`highlight/highlightTime.ts`、`highlight/highlightTask.ts`（设置和下载队列）、`highlight/HighlightDialog.tsx`、`highlight/HighlightOption.tsx`、`highlight/HighlightRowProgress.tsx`（列表里的进度） | `Pocket48Record.tsx`（「更多」菜单里的「自动切片」、「下载进度」列）、`shell/AppShell.tsx`（对话框）、`settings/SettingsPage.tsx`、`settings/settingsStore.ts`（`highlight*` 设置项） |
| 几个模块共用的小工具：IndexedDB 的打开和 Promise 包装、等一会儿、读写 localStorage 里的 JSON | `common/idb.ts`、`common/util.ts` | 无 |

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

- 单元测试：`custom/` 下的 `*.spec.ts`（30 个文件，243 个测试），在 `packages/48tools` 目录运行 `node --run test`。
  其中 `highlight/highlightPipeline.spec.ts` 最后一组测试是真的把录播切片跑一遍（下载、问 Gemini、合成；也可以只下载），平时跳过，
  要跑时按那个文件开头的说明设置环境变量。
  除了纯函数，房间消息的加载和同步（`room/roomStore.spec.ts`）、语音转文字的状态（`transcribe/transcribeStore.spec.ts`）
  也有测试，接口和缓存用假的代替。
- 界面检查：`node scripts/custom/uiCheck.mjs`（仓库根目录）。启动一个测试窗口把自定义的几个页面走一遍，
  确认关键的东西都在、没有报错，并截图。要先构建（脚本开头有说明）。只看不改，不会调用语音转文字接口。
