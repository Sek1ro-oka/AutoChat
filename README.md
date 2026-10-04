# AutoChat

Windows 本机运行的 QQ 机器人，支持文本对话、图片识别和可选联网搜索。NapCatQQ 负责普通 QQ 号接入，AutoChat 通过 OneBot v11 正向 WebSocket 收取消息并调用 `deepseek-flash`。

## 免责声明

本项目是独立的学习与个人自动化工具，与腾讯 QQ、NapCatQQ、DeepSeek 或其他模型服务商没有隶属、合作或官方认证关系。

普通 QQ 账号通过非官方接入端运行机器人，可能出现账号风控、限制、封禁、兼容性变化及服务中断。项目不保证账号安全，也无法证明封号风险低于 5% 或任何具体比例。请自行评估，并遵守适用法律、QQ 与模型服务商规则；不得用于骚扰、垃圾消息、诈骗或侵犯他人权益。

AI 回复可能不准确或包含不恰当表达；默认角色带调侃和毒舌风格，运营者应依据使用场景调整预设，并对发送内容及使用方式负责。API 调用可能收费，每日预算是本程序的保守账本控制，不是服务商账户的全局扣费上限。

密钥、登录会话与聊天记录应由使用者妥善保管；不要将自己的 `.env`、`data/`、`runtime/` 上传或分享。项目按现状提供，不承诺持续可用或特定用途适用性；相关责任以适用法律为准。第三方组件各自适用其许可证，参见 [第三方说明](THIRD_PARTY_NOTICES.md)。

- 私聊白名单中的用户自动回复；支持多群白名单，默认仅在明确 @ 机器人时回复。
- 多模型配置：`.env` 可填写多个兼容Chat Completions接口的模型、各自API Key和人民币计价。管理员私聊 `/模型列表`、`/切换模型 标识`，全局选择重启后保留，不同配置上下文独立。
- 可选群内防刷屏：默认同一成员10秒内连续5条，核实群管理权限后禁言5分钟；独立开关、阈值可配置，机器人是群主时也可禁言刷屏管理员，机器人是管理员时只处理普通成员；群主与机器人自身豁免，不使用模型额度。
- 可选群管理员命令：`@机器人 禁言 @成员 5`，实时核验发起者和机器人的群权限，机器人是管理员时只操作普通成员，是群主时也可操作管理员，不操作群主，不调用模型。
- 群内解除禁言：`@机器人 解除禁言 @成员`，或 `@机器人 禁言 @成员`（省略分钟数）；沿用禁言的权限、去重与限流检查。
- 支持纯 emoji 和 QQ 原生表情消息：常见 QQ 表情转成名称后交给当前人设模型理解，未知编号如实标记；沿用上下文、白名单、限流和每日预算。
- 可选图片识别：私聊发图或群 @ 附图，可识别内容、截图文字和图表；每条最多3张、每张5MB。原图不进入上下文，识别费用与文本、搜索共用每日预算。详见 [图片识别配置](docs/configuration.md#图片识别)。
- 私聊会话持久化；群成员会话独立，每 72 小时统一清理。
- 每日人民币 1 元预算，预留与用量保守结算，重启不重置。
- 本地管理命令、事件去重、限流、断线重连；模型输出仅作为文本发送。
- 违禁词命中回复“我是什么都不会告诉你的”，不调用模型、不写入 AI 上下文；关键词可像 @ 一样触发正常大模型对话，使用完整消息与上下文并计入预算。配置方法见 [配置与服务管理](docs/configuration.md)。
- 可选私聊群管理：配置的控制者可执行禁言、解除禁言，开关 `GROUP_MANAGEMENT_ENABLED` 默认关闭；执行前检查群白名单和机器人权限。
- 群聊联网搜索：`@机器人 /搜索 完整问题` 或 `@机器人 搜索 完整问题`，私聊也可使用。总开关 `WEB_SEARCH_ENABLED`；自动搜索开关 `WEB_SEARCH_AUTO_ENABLED` 默认关闭，开启后天气、新闻、最新动态等问题可自动联网。只发送当前问题，回答附真实来源，使用现有DeepSeek密钥并计入每日预算。
- 搜索资料交给当前模型，结合人设与上下文生成自然纯文本回答，不直接转发Markdown搜索报告；搜索与最终回答两次调用分别计入共同预算。
- 可选本机控制台：`CONSOLE_ENABLED=true` 后通过启动日志里的地址访问，查看运行状态、会话、花费、日志与生效配置，并在「人格」页管理两层提示词、在「仿真」页调整拟人化参数、在「黑话」页审阅群聊词库；仅绑定 127.0.0.1 并需访问令牌，写操作额外要求请求头令牌，不展示聊天正文。详见 [控制台说明](docs/console.md)。
- 拟人化群友（默认关闭）：`SOCIAL_ENABLED=true` 后机器人会自己判断该不该在群里接话——**规则决定「何时说」（相关度打分＋观望/试探/活跃/退场状态机），模型决定「说什么」**（分句成 1~3 条短消息、带随机停顿、与刚说过的话去重）。判断不花钱，只有真的开口才走一次模型调用，并与问答**共用同一个每日预算**，另有每群每日条数上限。被 @ 时仍由问答路径回复，不会出现两条回复。详见 [拟人化群友](docs/simulation.md)。
- 两层提示词：`personas/behavior.md` 定义群友行为协议（保存后需重启），`personas/characters/*.md` 是人格卡（控制台保存后**下一条消息即生效**）。未启用任何卡时回退到 `src/persona.js` 内置默认；`.env` 的 `SYSTEM_PROMPT` 若填写则独占最高优先级（向后兼容）。详见 [人设与两层提示词](docs/persona.md)。
- 令牌与花费看板：逐次记录每次模型调用的输入（区分缓存命中/未命中）与输出 token，按**峰谷分时**计价（DeepSeek：工作日 9:00–12:00、14:00–18:00 为高峰，其余含周末与法定节假日为空闲，空闲价为高峰价的一半），提供 24h／3d／7d／30d 走势图、按会话汇总与逐轮下钻。**看板只是报表，不改变每日预算的保守预留口径**。详见 [令牌与花费看板](docs/cost.md)。
- 群聊黑话词库（默认关闭）：`SLANG_ENABLED=true` 后可以抽出群里的拼音缩写、网络流行语与群内梗，格式化成 `【群聊黑话表】` 附加到群聊提示词，让机器人逐渐听懂群里的话。三个动作严格分开——**模型只负责找候选，人负责批准，提示词只吃批准过的**：候选必须由你在控制台「黑话」页点「确认」才会生效；删除、重复出现都不会推翻你的判断。抽取与「联网查义」会调用模型并**计入每日预算**（与 `/搜索` 共用搜索次数上限），自动抽取默认关闭。词库上限 2000 条，超限按「已确认 > 出现次数 > 最近更新」裁剪；模型回复里抠 JSON 用括号配平扫描（`根据[1]…` 这类前缀不会被当成"没找到"），恢复备份时损坏文件会另存后报错、绝不覆盖现有词库。详见 [群聊黑话词库](docs/slang.md)。
- 按群特异化：人格、仿真参数、黑话都能**按群**单独配置——同一个机器人在不同群可以是不同人格、不同主动发言节奏、不同黑话开关与词条归属。控制台「群设置」页每个群一张卡；未单独指定的项继承全局，行为与升级前一致。详见 [按群特异化](docs/groups.md)。
- 表情包库（默认关闭）：`STICKER_ENABLED=true` 后机器人会**收藏群里发的图片当表情**，也能在合适的时候**主动发一张**。收集 → 确认 → 注入/发送三段分离：群图片自动下载落盘为「待确认」，只有人点确认、或同一图重复出现达阈值（`STICKER_AUTO_THRESHOLD`）、或模型用 `【偷图:备注】` 标记主动收藏，才进入提示词。发图靠模型在回复里写 `【表情:编号】`，渲染层先剥离标记再发图（每轮最多一张）。单轮 chat completions 没有工具循环，所以「决定收不收/发不发」以标记形式搭在本来就要生成的那次回复里，**不额外花一分钱**。容量上限 2000 张，控制台可确认/拒绝/改备注/上传自己的图。详见 [表情包库](docs/stickers.md)。
- 运行时设置控制台化：预算、价格、白名单、联网搜索／识图／群管理／防刷屏等开关与调参，都能在控制台「设置」页直接改、**立即生效、无需重启**。`.env` 仍是默认值来源，控制台改动写入本机 `settings` 表、留空即恢复默认；密钥（API Key、OneBot Token）与启动期参数（端口、WS 地址、数据库路径）不在字段表里、只能留在 `.env`。字段键名与范围由 `src/runtime-config.js` 统一定义，读取方（运行时代理）与写入方（设置页）共用同一份，不会「存下一个没人读的值」。详见 [控制台说明](docs/console.md)。
- 落盘秘密的权限收紧：`data/`（聊天记录与账本）、`.env`（API Key）、控制台 token、黑话损坏备份会在启动时**显式收紧 ACL**，只留当前账号、SYSTEM 与 Administrators。Windows 会忽略 Node 的 `mode: 0o600`，所以这一步是必需的，不是可选的加固。全程 best-effort，失败只记事件、不阻断启动。详见 [安全与隐私基线](docs/security.md)。

## 一键部署（Windows x64）

下载 [AutoChat v0.1.13 Windows 部署包](downloads/AutoChat-v0.1.13-windows.zip)，完整解压后双击 **deploy.cmd**。联网下载并校验 Node.js／NapCat，首次引导填写账号和密钥，然后后台启动。先安装 [QQ NT](https://im.qq.com/)，首次用机器人账号扫码登录；详细步骤见 [部署手册](docs/local-setup.md)。这是联网部署包，不含个人密钥、账号会话或聊天数据。

修改 `.env` 或人设后双击 **restart.cmd**，停止机器人双击 **stop.cmd**。每天 1 元为所有用户共用预算。压缩包校验值见 [SHA-256](downloads/AutoChat-v0.1.13-windows.zip.sha256)。

电脑重启后双击 **start.cmd**，同时启动NapCat与AutoChat并检查QQ登录；需要扫码时打开二维码，确认后自动重连。已有进程不会重复启动，首次安装仍使用 **deploy.cmd**。

开发者运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1` 可重建压缩包；打包采用文件白名单，附带锁定版本的 `ws` 和许可证。

## 开发与启动

需要 Node.js 24+。项目使用内置 SQLite 和 `ws`。

```powershell
npm ci --ignore-scripts
Copy-Item .env.example .env   # 仅首次配置，已有 .env 不要覆盖
npm run check
npm test
npm start
```

实际密钥只写 `.env`，不要写 `.env.example`。填写机器人 QQ、私聊用户、群号、OneBot Token、DeepSeek API Key 和人民币计价参数。多名私聊用户使用 `PRIVATE_USER_QQS`，以英文逗号分隔；设置后优先于兼容的单用户字段 `PRIVATE_USER_QQ`。管理员由 `ADMIN_QQ` 独立指定，新增白名单用户不自动获得管理权限。`npm run check` 只校验配置，不验证网络；`npm run check:model` 会发送一次很小的真实 API 请求，并计入每日预算。

NapCat 的 WebSocket **服务器**应绑定 `127.0.0.1:3001`，Token 与 `.env` 相同，消息格式选择 **array**。AutoChat 的 `ONEBOT_WS_URL` 对应 `ws://127.0.0.1:3001`。本服务在连接后校验实际登录 QQ 号，账号不匹配会停止连接。完整步骤见 [本机运行手册](docs/local-setup.md)。

## 命令

| 命令 | 可用范围 |
| --- | --- |
| `/帮助` | 授权私聊／群 @ |
| `/清空` | 清空自己当前私聊或当前群会话 |
| `/状态` | 管理员私聊，查看预算与清理时间 |
| `/停止`、`/启动` | 管理员私聊，全局关闭／恢复模型回复 |
| `/群关闭`、`/群开启` | 管理员私聊，关闭／恢复指定群模型回复 |

白名单、模型、预算、价格与各开关都能在控制台「设置」页直接改，**立即生效、无需重启**；`.env` 仍是默认值来源，改动写入本机设置、留空即恢复默认，密钥与启动期参数仍只读于 `.env`（见下）。`BLOCK_TERMS` 是简单本地规则，不是完整内容审核。`data/` 包含当前对话和费用，`logs/` 只存固定事件名称；均被 Git 忽略。备份数据库需妥善保管聊天内容。

## 预算说明

按香港时间每天 00:00 分账。默认按核验的最高时段、缓存未命中价格预留并结算，不利用折扣扩大额度，因此显示的“保守计费”可能高于真实账单。输入 token 按 UTF-8 字节与封装余量估计；模型实际 usage 超过预留会停止当日后续调用。超时或 usage 不完整时保留额度，避免未知扣费导致重复消费。价格必须与实际服务一致；共享密钥在其他程序中的消费不属于 AutoChat 账本。

模型请求不自动重试，QQ 发送结果未知不盲目重发。连续三次发送失败停止模型回复。首次验证先发送本地命令，再进行文本对话。离线／休眠期间无法回复，也不批量补发历史消息。

开发阶段、接口依据和验收计划见 [开发文档](docs/development.md)；产品需求见 [需求文档](docs/requirements.md)；下一步方向见 [V2 开发路线图](docs/roadmap.md)，控制台用法见 [控制台说明](docs/console.md)，计费口径见 [令牌与花费看板](docs/cost.md)，人设分层见 [人设与两层提示词](docs/persona.md)，拟人化群友见 [拟人化群友](docs/simulation.md)，黑话词库见 [群聊黑话词库](docs/slang.md)，按群特异化见 [按群特异化](docs/groups.md)，表情包见 [表情包库](docs/stickers.md)，安全边界见 [安全与隐私基线](docs/security.md)。

默认聊天角色是熟悉网络梗、嘴毒但有分寸的傲娇女生，见 [人设说明](docs/persona.md)。系统提示词维护在 `src/persona.js`，可通过 `.env` 的 `SYSTEM_PROMPT` 覆盖；更常用的做法是在控制台「人格」页维护 `personas/` 下的行为层与人格卡，无需改 `.env`。

修改预设、白名单、预算及启动／停止／重启的方法见 [配置与服务管理](docs/configuration.md)。后台服务命令为 `npm run bot:start`、`npm run bot:stop`、`npm run bot:restart`。

## 参考文献与参考项目

| 来源 | 用途 |
| --- | --- |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) / [接入文档](https://napneko.github.io/use/integration) | 独立 QQ 账号接入端、OneBot 接口配置；本项目不内嵌或修改其源码 |
| [OneBot v11 标准](https://github.com/botuniverse/onebot-11) / [消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md) / [公共 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md) | 消息结构、@ 识别、身份校验与文本发送协议 |
| [DeepSeek API 文档](https://api-docs.deepseek.com/) / [计价文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) | 模型请求、usage 与计价配置依据 |
| [DeepSeek 图像理解文档](https://api-docs.deepseek.com/zh-cn/guides/vision/) | deepseek-flash 图片输入格式、细节级别与图片 token 上限（2026-10-03 核验） |
| [Node.js](https://nodejs.org/) / [ws](https://github.com/websockets/ws) | JavaScript 运行环境、SQLite 与 WebSocket 客户端依赖 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) / [LangBot](https://github.com/langbot-app/LangBot) | QQ 与大模型机器人框架的选型参考 |
| [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) / [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | 普通账号接入路线的比较参考 |
| [腾讯 botpy](https://github.com/tencent-connect/botpy) / [botgo](https://github.com/tencent-connect/botgo) | 官方机器人路线的比较参考 |

框架参考不代表依赖、代码复用或官方背书。完整调研口径、观察时间和风险证据见 [QQ 路线调研](docs/qq-route-research.md)；Stars 不等于实际使用人数。感谢这些项目及文档的维护者。
