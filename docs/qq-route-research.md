# QQ 接入路线 GitHub 调研

调研日期：2026-10-02。用于需求选型，未安装或运行这些项目。

## 样本与口径

选择与 QQ 接入、LLM 聊天直接相关的代表项目；这是一组目的性样本，不是 GitHub 全量普查。Stars 表示关注，Forks 表示派生开发，两者都不等于使用人数。数字来自此次访问的仓库页面，为页面显示的约数，可能存在缓存和时间差；GitHub 公开 API 返回限频，因此不提供未经获取的精确实时数值。

| 项目 | 页面 Stars | 路线／用途 | 对本项目的意义 |
| --- | ---: | --- | --- |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 约 10.8k | 基于 NTQQ 的普通账号接入端，OneBot 生态 | 普通账号路线首选候选，README 直接推荐 AstrBot 作为 LLM 框架 |
| [LuckyLilliaBot（原 LLOneBot）](https://github.com/LLOneBot/LuckyLilliaBot) | 约 3.6k | 普通账号接入端，支持 OneBot 11／Satori／Milky | 同路线替代候选 |
| [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | 约 3.0k | C# NTQQ 协议实现 | 说明普通账号协议生态存在多种实现；本次不优先选用，也未确认维护时效 |
| [botpy](https://github.com/tencent-connect/botpy) | 约 919 | 腾讯官方 Python SDK | 官方路线参考，README 提供群和好友消息示例 |
| [botgo](https://github.com/tencent-connect/botgo) | 约 389 | 腾讯官方 Go SDK | 官方路线参考 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | 约 41.3k | 多平台 LLM 框架，可接 OneBot 与 QQ 官方机器人 | 适合参考／复用，但不能把全部关注者归入普通账号路线 |
| [LangBot](https://github.com/langbot-app/LangBot) | 约 18.0k | 多平台 LLM 框架，README 同时列出 QQ Personal 与 Official API | 同样属于混合路线，不用于估计两条路线人数 |

## 选型判断

在上述专门接入端／SDK 样本中，普通账号路线有多个数千 Stars 的项目，关注度明显高于抽样到的官方 SDK。按用户“优先选择采用人数多的路线”的偏好，**以开源关注度为可观察的替代指标，暂选普通 QQ 号＋NapCatQQ＋OneBot v11**。这是有限样本推断，不是实际用户量统计，也不能据此断言全 GitHub 的多数项目都选普通号。

[NapCat 框架接入文档](https://napneko.github.io/use/integration)列出 OneBot v11 与 AstrBot 的接入方式。另一方面，[AstrBot 自身的 OneBot 文档](https://github.com/AstrBotDevs/AstrBot/blob/master/docs/zh/platform/aiocqhttp.md)目前推荐 QQ 官方机器人，理由包括稳定性。因此，“生态关注度较高”与“框架维护者推荐路线”并不完全一致，需保留这个差异。

建议用独立 NapCat 进程提供接口，AutoChat 只处理触发、上下文、模型与预算。是否复用 AstrBot／LangBot 待技术方案比较，重点看严格金额预留、三天清理及本机运维的适配成本，不因为框架 Stars 高就默认安装全部功能。

## 封号概率能否估计

| 路线 | 查到的公开证据 | 可以得出的结论 | 概率 |
| --- | --- | --- | --- |
| 普通账号／NapCat | 项目[安全文档](https://doc.napneko.icu/other/security)讨论账号与社交风控；[Issue #978](https://github.com/NapNeko/NapCatQQ/issues/978)报告多次账号异常提醒；[社区讨论列表](https://github.com/NapNeko/NapCatQQ/discussions/categories/general)出现“更新就封号”等反馈 | 确有账号异常／处置反馈，案例不代表所有用户，也不能直接证明具体原因；异常提醒不等同已封号 | 无可信百分比 |
| 官方机器人 | [官方 SDK](https://github.com/tencent-connect/botpy)及[平台文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/README.md)使用应用授权接入 | 避免非官方普通账号接入这一类风险；仍有内容、权限与应用停用风险，不能承诺零风险 | 无可信百分比 |

未发现可直接用于本场景的“独立用户数／账号数＋明确观察周期＋封禁数＋统一事件定义”统计。Issues 是主动报告，存在选择偏差、重复案例、版本与环境差异；无报告也不代表无事故。不能用问题数除以 Stars，不能虚构 1%、5% 或 10% 等概率。

结合接入机制和 AstrBot 的稳定性推荐，可合理推断官方路线少承担普通账号非官方接入风险；不能据此量化两条路线总体封禁概率。用户已暂停 5% 约束，方案继续推进，但记录实际运行中的异常。

## DeepSeek 与预算核验

[DeepSeek 官方快速开始](https://api-docs.deepseek.com/)当前明确列出 `deepseek-flash`，接口可使用兼容格式。配置保留模型名与地址，实施时进行真实 API 校验。

初次调研未成功获取价格表；开发阶段重新访问带尾部斜杠的[官方中文价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)后已核验：Flash 高峰输入未命中 2 元／百万 token、输出 8 元／百万 token，空闲价格各为一半。本机首版按高峰未命中单价保守预留与结算，不换算固定问答次数；用量以实际 usage 核算，显示金额不等于折扣后账单。核验日期 2026-10-02。
