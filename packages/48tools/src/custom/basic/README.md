# custom/basic —— 程序自带的默认内容

录播切片里有几块东西是可以换的：问 Gemini 的提示词、成片和封面的排版、配色，还有几项配置。
程序自带一份默认的，就在这个文件夹里；另外可以把自己的一份做成「内容包」放在自己的服务器上，
各台设备启动时同步下来（之后每 10 分钟看一眼有没有新的），换一台电脑不用重新配（见 `custom/sync/`）。

用的地方都从 `sync/packRegistry.ts` 的 `pack()` 取：没同步到内容包时拿到的是这里的默认内容，同步到以后拿到的是包里的。

## 有哪些模块

| 模块 | 要给出什么（接口） | 自带的默认内容 |
| --- | --- | --- |
| `prompts` | `highlight/highlightPromptTypes.ts` 的 `HighlightPrompts`：找爆点、写字幕和标题、公演找片段、挑封面这几步的提示文字，称呼的规则，专有词汇文件的初始内容 | 只说清楚程序要什么字段、时间怎么写、长度的限制 |
| `liveStyle` | `highlight/highlightAssCore.ts` 的 `LiveStyle`：直播、电台切片的成片和封面怎么排 | 黑底白字 |
| `stageStyle` | `highlight/highlightStageCore.ts` 的 `StageStyle`：公演切片的成片和封面怎么排 | 黑底白字 |
| `graphics` | `highlight/highlightGraphicsTypes.ts` 的 `HighlightGraphics`：用 Canvas 直接画封面和成片的底图，都可以返回 `null` | 全部返回 `null`，封面和成片照上面两个模块排 |
| `palette` | `deriveTeamTokens(hex)`：一个队伍主色算出整套颜色（`highlight/highlightColor.ts` 的 `TeamVisualTokens`） | 队伍色加几档中性灰 |
| `config` | `sync/packTypes.ts` 的 `PackConfig`：专有词汇、B 站公演录哪些队和在什么时间段查、各队的主色、发布标题里队伍怎么叫 | `packConfig.ts` |

## 做自己的内容包

1. 在 `packages/48tools/src/custom/private/` 里写自己的模块（这个文件夹不提交），入口是 `pack.ts`：
   默认导出一个 `PackContent`（`sync/packTypes.ts`），只给想换的那几个模块就行，没给的用默认的。
   模块里可以引用本仓库的文件和 `node:` 开头的自带模块，不能用 npm 包。
2. `node scripts/custom/buildPack.mjs`：打成一个文件并签名（签名默认管 10 年，`--days` 可以改；过期以后程序照常用，只在设置页提示），输出在 `local/pack/out/`（`pack.cjs` 和 `manifest.json`）。
   第一次运行会生成签名用的密钥：私钥 `local/pack/signing-key.pem` 只留在打包的电脑上，自己备份；
   公钥在 `local/pack/signing-key.pub.txt`。`local/专有词汇.txt` 会作为配置里的专有词汇一起打进去。
3. 每台设备的 `local/pocket48.json` 里写上 `packPublicKey`（公钥那一行）。然后二选一：
   - 把输出的两个文件放到同步服务器上（和在线状态是同一个服务，接口 `GET /pack/manifest`、`GET /pack/file`）。
     服务端不在这个仓库里，要自己搭：HTTPS、`Authorization: Bearer <密钥>`，`/pack/manifest` 原样返回 `manifest.json`，
     `/pack/file` 返回 `{ "code": "<pack.cjs 的内容>" }`；地址、密钥、证书指纹写在 `local/pocket48.json` 的 `presenceUrl`、`presenceKey`、`presenceCertPin`；
   - 或者写上 `packDir`（比如 `local/pack/out`），程序直接读这个文件夹，不经过服务器。

内容包是会被程序直接运行的代码，所以装上之前要过两关（`sync/packVerify.ts`）：说明上的签名是自己的私钥签的，
包文件的 SHA-256 和说明里写的一样。没通过的不装，接着用现在的；连不上服务器时用上次存在本机的那一版。
设置页「网络 → 个性化设置同步」写着现在用的是哪一版、签名的状态和到期时间。

同一个服务还可以提供成员名单（`GET /members`，格式和公开的 `roomId.json` 一样）：配置了同步服务时，程序各处用的成员名单先从它取，
取不到再用公开名单（`sync/memberSource.ts`）。

## 测试

- `CUSTOM_BASIC=true node --run test`（在 `packages/48tools` 目录）：只测程序自带的默认内容。
- 不带这个环境变量时，本机有 `custom/private/` 就先装上它再跑（`sync/jestSetup.ts`），连它自己的测试一起跑。
- 和提示词、排版的具体写法有关的检查跟着那一份内容走，放在它旁边；`custom/` 别处的测试只检查换哪一份都成立的事。
  流程测试里假的 Gemini 接口用 `highlight/specAsk.ts` 的 `askKind` 判断问的是哪一步：看要求返回的格式，不看提示的文字。
