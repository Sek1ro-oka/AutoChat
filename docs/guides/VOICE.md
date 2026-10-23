# 语音发送全解（VOICE）

> TL;DR：语音是「开口说话」的强表达。**AI 发语音默认是关的**（`socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` 都是 `false`）；你自己发语音不受这个开关限制。先把音频放进语音库 `audio/`，再按需要选一条通道发出去。模型还可以**把一句话直接合成语音条**（`qq_speak`，T-032）：语音总开关打开、`tools.speak` 没关就能用，最长 80 字。

## 一、五条通道

| 通道 | 入口 | 谁用 | 受 AI 开关约束 |
| --- | --- | --- | --- |
| 独立工具 · 图形界面 | 仓库上一级 `../voice-tool/` 的 `voice-gui.mjs`；双击上一级的 `发语音-图形界面.cmd` 直接打开浏览器界面 | 你自己 | 否 |
| 独立工具 · 命令行 | `../voice-tool/voice-cli.mjs`（交互菜单）、上一级的 `发语音.cmd` | 你自己 | 否 |
| 桥接 CLI | `node scripts/send-voice.mjs list / list-voice / send / check / status` | 你自己 | 否 |
| 控制台调试面板 | 「二代仿真 → 语音库与语音发送（调试）」：刷新语音库、目标、只校验不发送、试发选中语音 | 你自己 | 否 |
| AI 工具 | `qq_send_voice` / `qq_list_voices` | 模型 | **是** |
| AI 工具 · 文本合成 | `qq_speak`（把一句话合成语音条，T-032） | 模型 | **是**（同 `socialV2.voice.enabled`，另有 `tools.speak`） |

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
| `socialV2.tools.speak` | `true` | 控制 `qq_speak` 是否注册给模型（关掉只影响「文本合成」，不影响发语音库里的成品） |
| `socialV2.tts.engine` | `auto` | 合成引擎：`auto`（先 edge-tts，失败回落 SAPI）/ `edge` / `sapi` |
| `socialV2.tts.voice` | `zh-CN-XiaoyiNeural` | 默认音色（普通话·晓依），**只能是下面 `voices` 里的三项之一**（也可以写 `mandarin` / `普通话` / `晓依` / `xiaoxiao` / `晓晓` / `cantonese` / `粤语` / `曉曼` 这类别名）；配了别的值会在归一化时回落默认并记一条 warn 日志 |
| `socialV2.tts.voices` | 见下 | 固定三支女声：`{id:'zh-CN-XiaoyiNeural', label:'普通话·晓依'}`、`{id:'zh-CN-XiaoxiaoNeural', label:'普通话·晓晓'}`、`{id:'zh-HK-HiuMaanNeural', label:'粤语·曉曼'}`；这是给人看的镜像，真正的白名单在 `src/tts-core.js` 的 `TTS_VOICES`（**不许加男声**） |
| `socialV2.tts.rate` | `0` | 语速百分比，夹取 -30 ~ +30（0 = 原速） |
| `socialV2.tts.tone` | `neutral` | 默认语气档位；五档见「七、语气档位」。认不出的值回落 `neutral` 并记一条 warn |
| `socialV2.tts.tones` | 见下 | 五档镜像：`平淡 / 高兴 / 温和 / 冷淡 / 认真`；真正的事实表在 `src/tts-core.js` 的 `TTS_TONES` |
| `socialV2.tts.pitch` | `0` | 音高偏移 Hz，夹取 -30 ~ +30；显式 `tone` 会压过这个基础值 |
| `socialV2.tts.volume` | `0` | 音量百分比，夹取 -50 ~ +50；显式 `tone` 会压过这个基础值 |
| `socialV2.tts.maxChars` | `80` | 一次最多合成多少字，夹取 10 ~ 120；超了**直接拒绝**，不悄悄截断 |
| `socialV2.tts.timeoutMs` | `15000` | 单次合成超时，夹取 3000 ~ 30000 |
| `socialV2.tts.pythonPath` | `''` | 装 edge-tts 的 Python；空 = 读环境变量 `EDGE_TTS_PYTHON`，再空 = 本机已知的 venv |
| `socialV2.tts.dir` | `''` | 临时合成目录；空 = `<语音库>/.tts`（点目录，语音库列表里看不到） |

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

## 六、文本合成语音条（T-032，`qq_speak`）

模型想说一句话但不想打字时，可以调 `qq_speak`：桥接把它合成成音频 → 立刻当语音条发出去 → 删掉临时文件。走的是和 `qq_send_voice` **完全同一套**发送链路与闸门。

- **三支女声，别的都不许**：默认 `普通话·晓依`（`zh-CN-XiaoyiNeural`），备用 `普通话·晓晓`（`zh-CN-XiaoxiaoNeural`），粤语 `粤语·曉曼`（`zh-HK-HiuMaanNeural`）。`qq_speak` 的 `voice` 只认三类写法：完整 id、普通话别名（`mandarin` / `普通话` / `中文` / `晓依` / `xiaoxiao` / `晓晓`）、粤语别名（`cantonese` / `粤语` / `广东话` / `曉曼` / `晓曼`）；其它任何值（含所有男声、外语）一律 400 `bad_voice` 并列出允许的三项 —— **绝不静默回落**：把用户要的粤语念成普通话，比报错更难发现。
- **粤语没有离线兜底**：本机 SAPI 只有 `Microsoft Huihui Desktop`（zh-CN 女声），没有粤语音色。所以请求粤语时只走 `edge-tts`，它失败就直接返回 `tts_unavailable`（「粤语只有在线合成，这会儿没合成成，改发文字吧」），**不会**用普通话糊过去；只有普通话请求在 `engine:'auto'` 下才会回落 SAPI。
- **两个引擎**：`edge-tts`（Python 包，音质好、走微软端点，冷启动约 2.8 秒；**只走库 API** —— 参数写进 job JSON，用 `python -c <脚本>` + 环境变量 `TTS_JOB` 调 `edge_tts.Communicate(...).save(...)`，不用它的命令行入口，原因见排障表）与 **SAPI**（Windows 自带 `System.Speech`，离线、音色朴素，约 0.8 秒）。`engine: 'auto'` 时普通话先试 edge-tts，失败自动回落 SAPI；显式配成 `edge` 就不回落（失败就是失败）。
- **隐私**：`edge-tts` 会把要念的**原文发到微软的 TTS 端点**。合成内容里别出现密码、密钥、本机路径、群友隐私。完全不想出网就把 `socialV2.tts.engine` 设成 `sapi`。
- **长度**：`maxChars`（默认 80，夹取 10 ~ 120）。超了返回 400 `too_long`，**不会**悄悄截断（截断会断在半句上，还白耗一次合成）。
- **时长/体积**：合成后仍要过 `maxSeconds` / `maxBytes`。超时长是**硬拒绝**（`too_long`，提示「说短一点或者改发文字」），不会自动裁剪。
- **额度**：先查 `maxPerMinute` / `maxPerHour` **再**合成（`429 budget`），免得白等一次上游调用。
- **临时目录**：默认 `<语音库>/.tts/`，文件名 `tts-<pid>-<时间戳>-<随机>.<mp3|wav>`，发送结束（成功或失败）立即删除。`.tts` 以点开头，`listAudioFiles()` 会跳过，所以 `qq_list_voices` / `send-voice.mjs list-voice` 都看不到它。
- **失败语义**：`tts_unavailable` / `tts_timeout`（503）说明这台机器现在说不了话，**改发文字、不要重试第二次**；`verified=true` 才代表真发出去了。
- **实现细节**：音频以 `audio: null` 交给发送层，即**原样发送、不做音量处理** —— 本机没装 ffmpeg 时这点很关键，否则会在发送前失败。

## 七、语气档位（T-034，`tone`）

免费 edge 接口不处理 `mstts:express-as` 的「风格」，所以「语气」只能落成声学参数：语速 `rate` / 音高 `pitch` / 音量 `volume` 三个偏移量的组合。五档固定，`qq_speak` 的 `tone` 缺省是「平淡」：

| 档位 id | 中文 | `rate` | `pitch` | `volume` | 什么时候用 |
| --- | --- | --- | --- | --- | --- |
| `neutral` | 平淡 | 0 | 0 | 0 | 陈述、念信息，默认 |
| `happy` | 高兴 | +8% | +6Hz | +3% | 开心、好消息、打趣 |
| `gentle` | 温和 | −6% | −2Hz | 0 | 安慰、关心、哄人 |
| `cold` | 冷淡 | +4% | −6Hz | −10% | 敷衍、不耐烦、被惹到 |
| `serious` | 认真 | −10% | 0 | +5% | 郑重、强调、说明白 |

- **别名**：英文 id 与中文都认（`高兴/开心/兴奋/愉快`、`温和/温柔/关心/耐心`、`冷淡/冷漠/敷衍/平静/不耐烦`、`认真/郑重/强调/严肃`）。认不出的语气一律 400 `bad_tone` 并列出五档 —— 与 `bad_voice` 同口径，**绝不静默回落成平淡**（否则你以为它在演冷淡，其实只是没认出来）。
- **优先级**：显式 `rate` / `pitch` / `volume` 参数 > `tone` 给的值 > `socialV2.tts` 里的配置值。所以想微调某一档就只传那一个参数。
- **夹取**：`rate` ±30、`pitch` ±30 Hz、`volume` ±50；档位本身的值都在范围内，超范围的手动值会被夹住而不是报错。
- **兜底时语气会退回平淡**：SAPI 只有语速，没有音高/音量控制。走 SAPI 时 `tone` 只能改语速（+8% ≈ 1 档 = 10%），响应里 `toneApplied: false`、`pitch/volume` 回 0 —— 桥接**不假装**语气生效，文档也不假装。
- **标点比参数重要**：TTS 全靠标点断句和停顿。问句带问号、拖长用省略号、感叹别省，比把 `pitch` 调到 +20 有用得多（免费接口的音高是整体移调，调过头会尖）。

## 八、安全边界：AI 只能取语音库里的文件

- AI 通道只接受**语音库内的相对路径**；给绝对路径直接 400：`语音只能从语音库取文件（语音库目录：audio）；即使是绝对路径也必须位于语音库之内…`。
- 库外的音频（比如临时下载的一段）只能用**操作者通道**发：独立工具、`scripts/send-voice.mjs`、控制台面板。
- 原因：模型上下文里的内容是**不可信输入**，一旦允许任意绝对路径，prompt injection 就能把本机任意文件当语音发出去。
- 顺手一条：语音库为空时的提示按通道区分 —— AI 看到「请让管理员先把音频放进语音库」，操作者看到带目录的完整提示；给 AI 的那份不吐绝对路径。

## 九、排障

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| 401 / 未授权 | 换过 QQ 号，旧 token 失效（token 跟账号绑定） | 用独立工具的 `node voice-cli.mjs status` 重新发现账号与 token，或更新 `config.json` 的 `snowluma.token` |
| `语音功能已关闭（socialV2.voice.enabled=false）` | 走的是 AI 通道 | 这是预期的：控制台打开开关，或先用你自己的通道发 |
| `语音只能从语音库取文件…` | AI 给了库外路径 | 把音频放进 `audio/`，或用操作者通道 |
| 发送超时但对方没收到 | 网关侧 `get_record` 只面向收到的语音缓存 | 用 `node scripts/send-voice.mjs send <音频> <目标> --dry-run` 先验参数，再真发 |
| `send` 说白名单未命中 | 目标不在白名单 | 先在控制台加白名单；`--force` 也不会绕过桥接闸门 |
| `qq_speak` 回 503 `tts_unavailable` | 本机没有可用的 edge-tts Python，SAPI 也起不来 | 配 `socialV2.tts.pythonPath`，或把 `engine` 设成 `sapi` 只用系统语音 |
| `qq_speak` 回 400 `too_long` | 这句话超过 `maxChars`（或合成后超过 `maxSeconds`） | 说短一点，或者改发文字；不是故障，别重试 |
| 手动跑 `python -m edge_tts …` 直接抛 `UnboundLocalError: cannot access local variable 'audio_file'` | 本机 edge-tts 的**命令行入口不可用**（7.3.1 实测），库 API `edge_tts.Communicate(...).save(...)` 却正常 | 别修也别换成 npm 包：`src/tts-core.js` 就是这么绕开的 —— 参数写进 job JSON，用 `python -c <脚本>` + 环境变量 `TTS_JOB` 调库，正文不进命令行 |

| `qq_speak` 回 400 `bad_tone` | 传了不认识的语气名 | 用「平淡 / 高兴 / 温和 / 冷淡 / 认真」或它们的别名；不是故障，别重试同一个值 |
| `qq_speak` 回 200 但 `toneApplied: false` | 这次走的是 SAPI 兜底 | 正常：兜底只有语速，音高/音量不生效；想要真语气得让 edge-tts 能连上 |

## 十、实现落点（改代码时看这里）

| 文件 | 职责 |
| --- | --- |
| `src/voice-core.js` | 内核：格式判断、语音库命名、音量/响度、发送参数、回读探测 |
| `src/tts-core.js` | TTS 内核（T-032/T-034）：文本清洗、切句、配置夹取、语气档位（`TTS_TONES`）、edge-tts（job JSON + `python -c` 调库，`rate`/`pitch`/`volume`）/ SAPI 合成（只有语速，带超时与假 spawn 注入口） |
| `src/send-voice-lib.js` | 纯转发 shim（`export … from './voice-core.js'`），防止出现两份实现 |
| `scripts/send-voice.mjs` | 桥接 CLI：默认走 `/api/send/voice`，`--direct` 才是应急直连 |
| `src/bridge.js` | 路由 `/api/voice/send`、`/api/send/voice`（操作者）、`/api/socialV2/send-voice`、`/api/socialV2/speak`（AI）；额度、审计、回读；`speakV2()` 合成+发送 |
| `src/mcp-snowluma-safe.js` | 注册 `qq_send_voice` / `qq_list_voices`（`sendVoice` 开关）、`qq_speak`（`speak` 开关） |
| `public/console.html` | 「语音库与语音发送（调试）」面板 |
| `scripts/test-voice*.mjs` | 自检：`voice` / `voice-edge` / `voice-gui` / `voice-preview` / `voice-volume` / `voice-system` |
| `scripts/test-tts.mjs` | TTS 自检（T-032/T-034）：清洗/切句/夹取、音色白名单、语气五档与别名、`bad_tone` 闸门、优先级（显式 > tone > 配置）、SAPI 只落语速（`toneApplied:false`）、路由闸门、失败回落、edge 走库 API（argv/env/job JSON 的 pitch/volume）、成功路径、`.tts` 不被列出 |

## 十一、相关文档

- [README.md](../../README.md)「已知限制」：收语音只显示占位文本、AI 发语音默认关闭。
- [SOCIAL-AUTO.md](SOCIAL-AUTO.md)：社交自动化的开关与额度模型。
- [SECURITY_BASELINE.md](SECURITY_BASELINE.md)：为什么模型给的路径一律按不可信处理。
- [PRIVACY.md](PRIVACY.md)：本文件只含占位符，可以随仓库发布。
