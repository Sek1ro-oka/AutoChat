# AutoChat

Windows 本机运行的 QQ 文本机器人。NapCatQQ 负责普通 QQ 号接入，AutoChat 通过 OneBot v11 正向 WebSocket 收取消息并调用 `deepseek-flash`。

## 免责声明

本项目是独立的学习与个人自动化工具，与腾讯 QQ、NapCatQQ、DeepSeek 或其他模型服务商没有隶属、合作或官方认证关系。

普通 QQ 账号通过非官方接入端运行机器人，可能出现账号风控、限制、封禁、兼容性变化及服务中断。项目不保证账号安全，也无法证明封号风险低于 5% 或任何具体比例。请自行评估，并遵守适用法律、QQ 与模型服务商规则；不得用于骚扰、垃圾消息、诈骗或侵犯他人权益。

AI 回复可能不准确或包含不恰当表达；默认角色带调侃和毒舌风格，运营者应依据使用场景调整预设，并对发送内容及使用方式负责。API 调用可能收费，每日预算是本程序的保守账本控制，不是服务商账户的全局扣费上限。

密钥、登录会话与聊天记录应由使用者妥善保管；不要将自己的 `.env`、`data/`、`runtime/` 上传或分享。项目按现状提供，不承诺持续可用或特定用途适用性；相关责任以适用法律为准。第三方组件各自适用其许可证，参见 [第三方说明](THIRD_PARTY_NOTICES.md)。

- 私聊白名单中的用户自动回复；指定群仅在明确 @ 机器人时回复。
- 私聊会话持久化；群成员会话独立，每 72 小时统一清理。
- 每日人民币 1 元预算，预留与用量保守结算，重启不重置。
- 本地管理命令、事件去重、限流、断线重连；模型输出仅作为文本发送。

## 一键部署（Windows x64）

下载 [AutoChat v0.1.0 Windows 部署包](downloads/AutoChat-v0.1.0-windows.zip)，完整解压后双击 **deploy.cmd**。联网下载并校验 Node.js／NapCat，首次引导填写账号和密钥，然后后台启动。先安装 [QQ NT](https://im.qq.com/)，首次用机器人账号扫码登录；详细步骤见 [部署手册](docs/local-setup.md)。这是联网部署包，不含个人密钥、账号会话或聊天数据。

修改 `.env` 或人设后双击 **restart.cmd**，停止机器人双击 **stop.cmd**。每天 1 元为所有用户共用预算。压缩包校验值见 [SHA-256](downloads/AutoChat-v0.1.0-windows.zip.sha256)。

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

白名单、模型和拦截词修改 `.env` 后重启。`BLOCK_TERMS` 是简单本地规则，不是完整内容审核。`data/` 包含当前对话和费用，`logs/` 只存固定事件名称；均被 Git 忽略。备份数据库需妥善保管聊天内容。

## 预算说明

按香港时间每天 00:00 分账。默认按核验的最高时段、缓存未命中价格预留并结算，不利用折扣扩大额度，因此显示的“保守计费”可能高于真实账单。输入 token 按 UTF-8 字节与封装余量估计；模型实际 usage 超过预留会停止当日后续调用。超时或 usage 不完整时保留额度，避免未知扣费导致重复消费。价格必须与实际服务一致；共享密钥在其他程序中的消费不属于 AutoChat 账本。

模型请求不自动重试，QQ 发送结果未知不盲目重发。连续三次发送失败停止模型回复。首次验证先发送本地命令，再进行文本对话。离线／休眠期间无法回复，也不批量补发历史消息。

开发阶段、接口依据和验收计划见 [开发文档](docs/development.md)；产品需求见 [需求文档](docs/requirements.md)。

默认聊天角色是熟悉网络梗、嘴毒但有分寸的傲娇女生，见 [人设说明](docs/persona.md)。系统提示词维护在 `src/persona.js`，可通过 `.env` 的 `SYSTEM_PROMPT` 覆盖。

修改预设、白名单、预算及启动／停止／重启的方法见 [配置与服务管理](docs/configuration.md)。后台服务命令为 `npm run bot:start`、`npm run bot:stop`、`npm run bot:restart`。

## 参考文献与参考项目

| 来源 | 用途 |
| --- | --- |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) / [接入文档](https://napneko.github.io/use/integration) | 独立 QQ 账号接入端、OneBot 接口配置；本项目不内嵌或修改其源码 |
| [OneBot v11 标准](https://github.com/botuniverse/onebot-11) / [消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md) / [公共 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md) | 消息结构、@ 识别、身份校验与文本发送协议 |
| [DeepSeek API 文档](https://api-docs.deepseek.com/) / [计价文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) | 模型请求、usage 与计价配置依据 |
| [Node.js](https://nodejs.org/) / [ws](https://github.com/websockets/ws) | JavaScript 运行环境、SQLite 与 WebSocket 客户端依赖 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) / [LangBot](https://github.com/langbot-app/LangBot) | QQ 与大模型机器人框架的选型参考 |
| [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) / [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | 普通账号接入路线的比较参考 |
| [腾讯 botpy](https://github.com/tencent-connect/botpy) / [botgo](https://github.com/tencent-connect/botgo) | 官方机器人路线的比较参考 |

框架参考不代表依赖、代码复用或官方背书。完整调研口径、观察时间和风险证据见 [QQ 路线调研](docs/qq-route-research.md)；Stars 不等于实际使用人数。感谢这些项目及文档的维护者。
