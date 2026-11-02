# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注）

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/VOICE.md](guides/VOICE.md) | 语音发送全解：独立工具（`voice-tool/`，本机未安装）、桥接 CLI、AI 工具、控制台面板，以及工具拆出后的配置解析顺序 | ✅ 2026 整理时已更新 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ 2026 整理时自 `scripts/` 移入 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单 | ✅ **改动安全相关代码前必读** |
| [guides/PRIVACY.md](guides/PRIVACY.md) | **发布前隐私检查**：真实 QQ 号 / 群号 / 本机绝对路径 / 令牌 / 人格卡的扫描与处置 | ✅ **推仓库前必读** |
| [guides/BILI.md](guides/BILI.md) | B 站只读能力：搜索、看视频详情（可连带字幕 / 评论 / 相关推荐 / AI 总结） | ✅ |
| [guides/DIARY.md](guides/DIARY.md) | 日记本（`qq_diary_write` / `_list` / `_read`）：存在哪、按天分文件、什么场合才该写 | ✅ |
| [guides/FILES.md](guides/FILES.md) | 文件收发（`files/` 托管目录）：`adminQQ` 白名单、写/删/发文件的权限口径 | ✅ |
| [guides/QZONE.md](guides/QZONE.md) | QQ 空间说说（出厂关闭）：开关、内容审计、配额、删除需管理员 | ✅ |
| [guides/SOCIAL-AUTO.md](guides/SOCIAL-AUTO.md) | 社交自动化（出厂全关）：自动通过好友 / 入群等 | ✅ |
| [guides/HEYBOX.md](guides/HEYBOX.md) | 小黑盒：看帖 / 搜索 / 自主评论；四道闸门、验证码命中后四入口一起停 30 分钟 | ✅ 2026-10-21 新增（T-022） |
| [guides/DEVICE.md](guides/DEVICE.md) | 安卓平板：截图 / 点击 / 滑动 / 输入 / 按键 / 开应用 / 列应用；预算闸门 + 黑名单前台硬闸门 | ✅ 2026-10-21 新增（T-023） |
| [guides/REACH.md](guides/REACH.md) | 三平台只读检索（`reach_status` / `reach_search` / `reach_read`）：B站 / 小红书 / 小黑盒一个入口 | ✅ 2026-10-23 新增（T-027） |
| [guides/ZHANGXUEFENG.md](guides/ZHANGXUEFENG.md) | `zx_perspective`：把「张雪峰视角」skill 当参考资料取用（咨询模式，不换人格）；只在 `group:1131654608` 可用 | ✅ 2026-10-23 新增（T-030） |
| [guides/ROLE-BINDING.md](guides/ROLE-BINDING.md) | 按互通组配置人格卡：三种选项、作用域 `cross:<gid>` 与 `isolated:<key>`、三个管理端点、生效时机 | ✅ 2026-10-25 新增（T-035） |
| [guides/SOCIAL-CHAINS.md](guides/SOCIAL-CHAINS.md) | 模式与链路边界：四个模式（chat / closed-agent / reserved / reserved2）× 三条链（被动回复 / 主动社交 v1+v2 / 黑话学习），状态存哪、改哪个开关才生效、排障对照表 | ✅ 2026-11-02 新增 |

## guides/ —— DSH 适配与内部主链

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | **DSH 0.2.1 适配改动记录**（0.2.0 → 0.2.1）：两处真实断裂——P0 `{{cwd}}` 提示词变量被删（每回合直接 error、QQ 完全不回）、P1 `working_directory` 进全局层；含协议面零漂移的实测结论 | ✅ **最新**；升级 DSH 前先看 §6 的增量清单 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**（v0.1.7 → v0.2.0）：逐条列出改动（现象/为什么必须改/证据/怎么验证），并单独列出「复核后判定兼容、因此没改」的部分 | ✅ 仍有效（0.2.1 未推翻其中任何结论） |

## 不进公开仓库的几类文档

`docs/design/`、`docs/research/`、`docs/audits/`、`docs/legacy/` 四类（设计规划 / 调研记录 / 审计报告 / 历史归档）
在 `.gitignore` 里（见该文件 L60-L63），**不会进公开仓库**，本机当前也没有这些目录。

2026-11-02 核查：旧索引里指向这四个目录的 18 个链接（`design/GEN2_SIMULATION_PLAN.md`、`design/SOCIAL_MODE_PLAN.md`、
`design/DSH_QQ_TOOLS_PLAN.md`、`design/真人语感策略.md`、`research/SnowLuma功能调研.md`、`research/RESEARCH_QQ_MESSAGE_DND.md`、
`research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md`、`research/LOCAL_MODEL_SIZING.md`、`audits/` 下 6 份、`legacy/` 下 3 份、
`guides/PROJECT_GUIDE.md`）**目标都不存在**，已从索引移除，需要时去本机的开发历史/归档里找，不要指望在仓库里读到。

写新文档时请一律放 `docs/guides/`（唯一会进仓库的文档目录）。

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | [../README.md](../README.md)（能力与配置概览）、[FOLDER_MAP.md](FOLDER_MAP.md)（目录与脚本） |
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md)、[guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) |
| 发语音 / 换 QQ 账号后语音工具 401 | [guides/VOICE.md](guides/VOICE.md) |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 改代码前先知道有哪些坑 | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md)（最新）、[guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) |
| 动了安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)、[guides/PRIVACY.md](guides/PRIVACY.md) |
| 让 agent 自己看平板屏幕、自己点 | [guides/DEVICE.md](guides/DEVICE.md) |
| 让它刷小黑盒 / 自己发评论 | [guides/HEYBOX.md](guides/HEYBOX.md) |
| 让它发文件 / 写日记 / 发说说 / 发 B 站 | [guides/FILES.md](guides/FILES.md)、[guides/DIARY.md](guides/DIARY.md)、[guides/QZONE.md](guides/QZONE.md)、[guides/BILI.md](guides/BILI.md) |
| 给它换一张人格卡 / 按互通组分配 | [guides/ROLE-BINDING.md](guides/ROLE-BINDING.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
