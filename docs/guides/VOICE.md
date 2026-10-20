# 语音发送全解（VOICE）

> TL;DR：语音是「开口说话」的强表达。**AI 发语音默认是关的**（`socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` 都是 `false`）；你自己发语音不受这个开关限制。先把音频放进语音库 `audio/`，再按需要选一条通道发出去。

## 一、五条通道

| 通道 | 入口 | 谁用 | 受 AI 开关约束 |
| --- | --- | --- | --- |
| 独立工具 · 图形界面 | 仓库上一级 `../voice-tool/` 的 `voice-gui.mjs`；双击上一级的 `发语音-图形界面.cmd` 直接打开浏览器界面 | 你自己 | 否 |
| 独立工具 · 命令行 | `../voice-tool/voice-cli.mjs`（交互菜单）、上一级的 `发语音.cmd` | 你自己 | 否 |
| 桥接 CLI | `node scripts/send-voice.mjs list / list-voice / send / check / status` | 你自己 | 否 |
| 控制台调试面板 | 「二代仿真 → 语音库与语音发送（调试）」：刷新语音库、目标、只校验不发送、试发选中语音 | 你自己 | 否 |
| AI 工具 | `qq_send_voice` / `qq_list_voices` | 模型 | **是** |

独立工具不在本仓库里：它是仓库上一级并排的 `voice-tool/`，只依赖 SnowLuma，共享内核仍由本仓库 `src/voice-core.js` 提供（单一实现，不复制）。没有这个目录时，语音相关的自检会自动 skip（见 `scripts/voice-tool-locator.mjs`）。

## 二、语音库

- 位置：`config.json` 里的 `socialV2.voice.dir`，默认 `audio`（相对仓库根）。控制台面板显示的就是它。
- 支持的扩展名：`.mp3 .wav .ogg .oga .opus .m4a .aac .flac .amr .silk .slk .wma .spx`；引用时省略扩展名会按 `.mp3` 补。
- 同名保存自动去重（`foo.mp3` → `foo-2.mp3`），不会覆盖已有音频。
- `audio/` 在 `.gitignore` 里：音频是你自己的资产，不进仓库、不随发布走。
- AI 通道**只能**从语音库取文件（见 §六）。

## 三、开关与出厂默认

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `socialV2.voice.enabled` | `false` | AI 能不能发语音的总闸；**只关 AI 通道**，不关你的手动试发 |
| `socialV2.tools.sendVoice` | `false` | 控制 `qq_send_voice` / `qq_list_voices` 是否注册给模型（关闭时注册期就过滤，省 token） |
| `socialV2.voice.dir` | `audio` | 语音库目录，相对仓库根 |
| `socialV2.voice.maxSeconds` | `300` | 单条语音时长上限（秒） |
| `socialV2.voice.maxBytes` | `20971520` | 单条语音大小上限（20 MB） |
| `socialV2.voice.maxPerMinute` | `2` | 每分钟最多发几条 |
| `socialV2.voice.maxPerHour` | `10` | 每小时最多发几条 |
| `socialV2.voice.allowAbsolutePath` | `false` | 历史开关；**已不再放宽 AI 通道**，AI 一律只认库内相对路径 |
| `socialV2.voice.defaultVolume` | `1` | 默认音量倍数（1 = 原样） |
| `socialV2.voice.loudness` | `normal` | 响度档位：`quiet` / `normal` / `loud`，或直接给 -40~-5 的 LUFS 数字 |
| `socialV2.voice.ffmpegPath` | `''` | 空 = 走 PATH 找 ffmpeg |
| `socialV2.voice.autoReadback` | `true` | 发送后自动回读一条确认 |

打开方式：控制台「开关」页 → 「二代仿真」里勾上 `qq_send_voice / qq_list_voices`，再把 `socialV2.voice.enabled` 置 `true`（改 `config.json` 或控制台配置面板），桥接重启后生效。

## 四、音量与响度

- 响度档位到目标的映射：`quiet` = -20 LUFS、`normal` = -16 LUFS、`loud` = -13 LUFS。
- `volume` 与 `loudness` **互斥**，同时给时 `loudness` 优先（`resolveAudioProcessing()` 里归一）。
- 必须装 ffmpeg：处理在本地做，因为 SnowLuma 的 `record` 段没有增益字段，音量只能在发之前调好。
- 原扩展名没有可用编码器时（`.amr` / `.silk` 这类通常只读），会退回 wav 再试一次，两条都失败才算发送失败。

## 五、发送前后各校验什么

1. **白名单**：与发文本同一套（群白名单 / 私聊白名单 / 所有者），不在白名单直接拒绝。
2. **规格**：时长 ≤ `maxSeconds`、大小 ≤ `maxBytes`。
3. **额度**：`maxPerMinute` / `maxPerHour`。检查与记账分离（`voiceBudgetCheck` / `voiceBudgetCommit`），发送失败不记账。
4. **文件名审计**：`assertOutboundAuditOk()` —— 语音文件名不能成为夹带敏感串的通道。
5. **回读**：`verifyVoiceMessageSent()` 发送后回读，确认消息真的出去了。
6. **静默模式**：AI 通道尊重 `shouldBlockSilentReply(key)`，静默期间不发。

## 六、安全边界：AI 只能取语音库里的文件

- AI 通道只接受**语音库内的相对路径**；给绝对路径直接 400：`语音只能从语音库取文件（语音库目录：audio）；即使是绝对路径也必须位于语音库之内…`。
- 库外的音频（比如临时下载的一段）只能用**操作者通道**发：独立工具、`scripts/send-voice.mjs`、控制台面板。
- 原因：模型上下文里的内容是**不可信输入**，一旦允许任意绝对路径，prompt injection 就能把本机任意文件当语音发出去。
- 顺手一条：语音库为空时的提示按通道区分 —— AI 看到「请让管理员先把音频放进语音库」，操作者看到带目录的完整提示；给 AI 的那份不吐绝对路径。

## 七、排障

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| 401 / 未授权 | 换过 QQ 号，旧 token 失效（token 跟账号绑定） | 用独立工具的 `node voice-cli.mjs status` 重新发现账号与 token，或更新 `config.json` 的 `snowluma.token` |
| `语音功能已关闭（socialV2.voice.enabled=false）` | 走的是 AI 通道 | 这是预期的：控制台打开开关，或先用你自己的通道发 |
| `语音只能从语音库取文件…` | AI 给了库外路径 | 把音频放进 `audio/`，或用操作者通道 |
| 发送超时但对方没收到 | 网关侧 `get_record` 只面向收到的语音缓存 | 用 `node scripts/send-voice.mjs send <音频> <目标> --dry-run` 先验参数，再真发 |
| `send` 说白名单未命中 | 目标不在白名单 | 先在控制台加白名单；`--force` 也不会绕过桥接闸门 |

## 八、实现落点（改代码时看这里）

| 文件 | 职责 |
| --- | --- |
| `src/voice-core.js` | 内核：格式判断、语音库命名、音量/响度、发送参数、回读探测 |
| `src/send-voice-lib.js` | 纯转发 shim（`export … from './voice-core.js'`），防止出现两份实现 |
| `scripts/send-voice.mjs` | 桥接 CLI：默认走 `/api/send/voice`，`--direct` 才是应急直连 |
| `src/bridge.js` | 路由 `/api/voice/send`、`/api/send/voice`（操作者）、`/api/socialV2/send-voice`（AI）、`/api/voice/list`、`/api/socialV2/voices`；额度、审计、回读 |
| `src/mcp-snowluma-safe.js` | 注册 `qq_send_voice` / `qq_list_voices`，映射到 `sendVoice` 开关 |
| `public/console.html` | 「语音库与语音发送（调试）」面板 |
| `scripts/test-voice*.mjs` | 自检：`voice` / `voice-edge` / `voice-gui` / `voice-preview` / `voice-volume` / `voice-system` |

## 九、相关文档

- [README.md](../../README.md)「已知限制」：收语音只显示占位文本、AI 发语音默认关闭。
- [SOCIAL-AUTO.md](SOCIAL-AUTO.md)：社交自动化的开关与额度模型。
- [SECURITY_BASELINE.md](SECURITY_BASELINE.md)：为什么模型给的路径一律按不可信处理。
- [PRIVACY.md](PRIVACY.md)：本文件只含占位符，可以随仓库发布。
