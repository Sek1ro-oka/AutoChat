# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：每个版本一节，
`## [版本] - 日期`，节内按 `新增 / 变更 / 修复 / 迁移` 分组。

## [Unreleased]

### 合入上游 v0.2.0-r4（2026-10-20，合并提交 `008a1c5`）

上游 `a56164e` 与本仓库同基线（`9df6a7e`），本次以 `--no-ff` 合并成 `008a1c5`（32 文件，+3468/−320），
6 处冲突逐个手工解得（`src/bridge.js` 3、`src/mcp-snowluma-safe.js` 1、`scripts/audit-bridge-harness.mjs` 1、`README.md` 1）。
用户可见的变化：

- **联网搜索改用与 DSH 同源的 DeepSeek 搜索**：同一个 Anthropic 兼容端点 + `web_search` 服务端工具，凭据按
  `config.webSearch.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → DSH 的 `.credentials.yaml` 顺序解析；Bing RSS 只在
  DeepSeek 不可用时兜底，不再默认把群聊关键词发给 Bing。`webSearch.provider` 可强制 `auto` / `deepseek` / `bing`。
- **图片/表情（含动图 GIF）链路加固**：表情包优先走 QQ CDN 直链、`get_image` 失败时用 `emoji_id` 推 CDN 兜底；
  下载改为 **IPv4 优先 + 逐地址故障切换**，修掉「DNS 先返回 IPv6、本机没有 IPv6 出口 → 每次白等 20 秒」的根因。
  单条消息上限见 `socialV2.media`（默认 8MB / 64MP / 5 张）。
- **会话初始提示词**（二代仿真）：新增 `GET/POST /api/socialV2/initial-prompt`（已进 `adminOnlyV2Paths`），
  控制台「二代仿真 → 初始提示词」可给某个群/私聊预写环境说明，AI 只在该会话第一次唤醒时收到一次；
  字数上限 `socialV2.initialPromptMaxChars`（默认 2000）。
- **`qq_wait_for_messages` 改 5 分钟长轮询**：新增 `agentApiLongPoll()` 走 `node:http`，绕开 undici 的 300 秒
  `headersTimeout`（上游 issue #24）；本地保留 `body.ok === false` 分支与 `error.body/layer/reason/reasons/retryAfterMs/todayCount` 挂载。
- **上游 issue 修复**：控制台切模式被 5 秒轮询改回去、回合永久「繁忙」、机器人身份未注入等。
- **本地技术债**（`0dbaa79`）：`src/bridge.js` 里为 `scripts/audit-bridge-harness.mjs` 的 VM 兜底的
  `socialAuto` 可用性探测整段删除，harness 补 `import * as socialAuto from '../src/social-auto.js'`。

### 情绪与主动表达（2026-10-21，T-012）

机器人现在有四种情绪（生气 / 难过 / 开心 / 无聊），每条消息、每个事件都会给它加一点强度：
强度按半衰期自然衰减，累积到阈值后它**会自己想说话**，不必等谁点名。

- **情绪上报**：新工具 `qq_affect_report`（模型只能打 0.25 / 0.5 / 0.75 / 1 四档并写一句原因），
  端点 `POST /api/socialV2/affect/events`；同一原因 10 分钟内去重、同一个人每小时最多 3 条。
- **宣泄出口**：说说 → 私聊主人 → 日记，三个出口各有每日额度，前一个发不出去才降级到下一个；
  说说沿用现有的 qzone 配额、审计与冷却，私聊只可能发给 `ownerQQ`，日记写到 `state/diaries/`。
  全都失败时这一轮直接放弃，不记账、不进冷却，10 分钟后再看。
- **动画式判定**：`GET /api/socialV2/affect` 会给出「现在四维多少、为什么还不能发」的逐条中文理由，
  控制台「情绪」页把它画成强度条 + 阈值刻度 + 闸门清单，另有「评估一次（不发）」「真的发一次」
  「手动加一次情绪」「改阈值与限额」四个调试动作。
- **主动发言概率受情绪影响**：原有的主动机会检查（`socialV2.proactive`）概率会乘以
  `1 + 0.6 × 最强情绪强度`，心情越重越可能开口，日志里会写清加成来源。
- 配置在 `config.json` 的 `socialV2.affect`（阈值、半衰期、剂量、出口额度、静默时段）；
  缺省段等于出厂默认，删除该段即可回到「情绪记录照常、不发任何东西」的初始状态。

### 资料自管（2026-10-21，T-014）

机器人现在能看头像、也能改自己的昵称 / 签名 / 群名片，改动有闸门、有额度、改完会读回确认。

- **看头像**：`qq_get_avatar` / `GET /api/avatar?uin=&size=`（640 或 100，默认 640；单张上限 2MB，
  640 拉不到自动回落 100），图片直接进视觉上下文。
- **自查**：`qq_get_profile` / `GET /api/socialV2/profile` 返回自己的 QQ 号、昵称、签名、
  三项改动的当日剩余额度与下次可改时间、最近 10 条改动记录。
- **改资料**：`qq_set_nickname` / `qq_set_signature` / `qq_set_group_card`，
  对应 `POST /api/socialV2/profile/{nickname,signature,group-card}`。闸门在纯函数模块
  `src/profile-core.js`：长度按码点、禁换行、禁纯 emoji / 纯标点，正文复用 qzone 的审计规则
  （链接 / 手机号 / 邮箱 / 身份证 / 拉人话术），昵称额外拒绝数字开头、`@`、5 位以上连续数字。
- **额度按自然日**：昵称 24 小时 1 次、签名 6 小时 3 次、群名片每群 1 小时 6 次；
  拒绝时 `429` 带 `retryAfterMs` 与「约 X 小时 Y 分 后才能再改」。
- **读回校验**：改完立刻读回，不一致时不记账、返回 `ok:false` + `pending:true`（模型会被告知「没回读确认」）。
- **群名片清空是网关限制**：SnowLuma 的编码器在群名片为空串时会省略字段，服务端回 OIDB 1007，
  所以「清除」实际写的是一个半角空格（读回可能显示为空），状态文件与日志仍记空串。
- 配置在 `config.json` 的 `socialV2.profile`（`enabled` 与三种资料各自的 `minIntervalMs` / `dailyCap` /
  `maxChars`）；缺省段等于出厂默认。这四个工具没有登记 `TOOL_CONFIG_FLAGS`，总开关是 `socialV2.profile.enabled`。

### 新增

- **社交自动化（`socialV2.automation`，出厂全关）**：桥接自己处理四类「加好友 / 进群」杂事，不需要模型参与——
  ①`acceptInvite` 同意入群邀请、②`groupWhitelist` 自己被拉进群后把群加进 `allow.groups`、
  ③`friendFromGroup` 同意**白名单群成员**的好友申请（真去 `get_group_member_info` 核验，不信申请留言里的群号）、
  ④`privateWhitelist` 同意好友后把对方加进 `allow.private`。每个动作私聊通知 `ownerQQ`（`notifyOwner`，唯一 fail-open 的键）。
  - 判定一律 **fail-closed**（`value === true` 才算开），不复用 `socialV2.tools` 那套 `!== false`；额度按**上海自然日**
    计（默认 5/3/5，区间 `0`~`50`，`0` 是合法值），跨天清零，用完只告警一次不抛错。
  - 白名单**只追加**、串行排队、写前重读 `config.json`、原子写成功后换内存并 `reconcileSessionPolicies()`。
  - 新模块 `src/social-auto.js`（纯函数：归一 / 部分更新校验 / 自然日 / 额度 / 审计尾部解析 / 文案）。
  - 新端点 `GET/POST /api/socialV2/automation`（GET 返回 `automation` / `today` / `limits` / `recent`；
    POST 部分更新，文案固定三种 400），已加入 `adminOnlyV2Paths`，AI 通道访问被 403。
  - 审计 `state/social-auto.jsonl`（`kind` = `friendApprove`/`inviteApprove`/`whitelistWrite`/`skip`/`quota`/`notify`，
    带 `text` 供控制台直接显示）、额度 `state/social-auto.json`；两者都在 `state/`，不入库。
  - **主动加群做不到**：SnowLuma 的 132 个动作 / 190 条 catalog / 104 个协议命名空间 / 16 个 Api 类里没有
    搜群或申请加群的接口，唯一逃生口 `send_packet` 是盲发 protobuf，明确不做。查证见 `work/agent-tasks/T-009/research.md`。
  - 控制台「开关」页新增「社交自动化」卡片（在「说说」卡下面）：五个开关 + 今日额度 + 最近自动动作（右栏两块面板读审计 `text`）。
  - 自检 `node scripts/test-social-auto.mjs`（98 条断言：fail-closed、额度 `0` 与夹取、三种错误文案、
    上海跨日、审计尾部时间正序与坏行跳过、文案逐字比对）。详见 [docs/guides/SOCIAL-AUTO.md](docs/guides/SOCIAL-AUTO.md)。

- **AI 自己的日记本（`qq_diary_write` / `qq_diary_list` / `qq_diary_read`）**：每个聊天一个文件夹、
  一天一个 `.md`（`state/diaries/<group_群号|private_QQ号>/<YYYY-MM-DD>.md`，`state/` 不进版本库）。
  同一天可以写多则（按 `## HH:MM · 标题` 分节）；`list` 给日期/则数/摘要，`read` 给某天全文（超长截断并标记）。
  - 新模块 `src/diary-store.js`：路径派生与 **resolve 校验**（key 来自模型，按不可信输入处理，防 `../` 穿越）、
    日期校验（只认今天或过去）、正文净化（本机绝对路径与 `token=`/`password:` 形态替换成「已隐去」）、
    长度上限（单则 4000 字/标题 60/心情 20/标签 8 个）、同一天最多 20 则、`.tmp` + `rename` 原子写。
  - 桥接三端点 `POST /api/socialV2/diary-write`、`GET /api/socialV2/diary-list|diary-read`，
    与其它 v2 工具同一套关卡（`agentTokenOk` + `v2SessionAllowed` + `v2ToolEnabled('diary')`）；
    `socialV2.tools.diary` 出厂 `true`，关掉后三个工具**根本不注册**。
  - 二代仿真提示词新增【日记】一节（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`）：什么时候写、
    写多少、写之前先翻目录避免重复、被问到旧事时怎么读、不写群友隐私与本机路径。
  - 控制台「二代仿真 → 工具开关」新增日记一项；`config.example.json` 的 `socialV2.tools` 同步补 `diary`。
  - 自检 `node scripts/test-diary.mjs`（40 条断言：路径穿越/日期/净化/上限/会话隔离/接线）。
  - 详见 [docs/guides/DIARY.md](docs/guides/DIARY.md)。

- **说说限流改成可调参数**：`qzone.windowHours`（窗口长度，0~24 小时，出厂 24）与
  `qzone.windowCap`（窗口内最多几条，0~100，出厂 2）。判定口径是**滑动窗口**——最近
  `windowHours` 小时内最多 `windowCap` 条，不再按自然日归零。
- **控制台可直接改这四个参数**：`POST /api/qzone/config` 支持部分更新
  （`enabled` / `windowHours` / `windowCap` / `ugcRight`），只改传了的键，其余保持当前值；
  校验只有一套（`applyQzoneConfigUpdate` → `normalizeQzoneConfig`），越界值夹回边界并在
  `clamped` 里点名，白名单以外的键直接 400。
- **热更新、不重启**：先原子写盘（读原始 `config.json`、只合并这四个键、临时文件 + rename），
  写盘成功后才换内存 —— 下一个请求就生效，重启后仍是新值；`dailyCap` / `minIntervalMs` 等
  旧键原样留在文件里，回滚旧版本也不会炸。
- `GET /api/qzone/recent` 增加 `windowHours` / `windowCap` / `windowCount` 三个键（原来的
  `enabled` / `posts` / `todayCount` / `dailyCap` / `ugcRight` / `nextAllowedAt` / `ok` 一个都没删）。

### 变更

- **`minIntervalMs` 与 `dailyCap` 降级为 legacy**：仍能被读出（用于迁移与回滚），但**不再参与
  任何限流判定**；判定只看 `windowHours` / `windowCap`。
- **两个 `0` 是显式语义**，不是「不限频」：`windowCap: 0` = 暂停发布（一条都不发，
  `retryAfterMs` 也是 0）；`windowHours: 0` = 退回北京自然日计数（上限仍是 `windowCap`）。
- 被拒时仍返回 `reason: 'daily_cap'`（换值会让 MCP 层、控制台与既有脚本同时失效），
  另加 `windowCount`（窗口内条数）与 `windowCap`（当前上限）便于解释：两者一起就能区分
  「发满了」和「已暂停」，调用方不用去解析 `error` 文案。
- 本机记录保留条数不再写死 50：按 `max(50, windowCap + 20)` 裁剪，`windowCap` 调大之后
  窗口计数不会被裁剪封顶。

### 修复

- **DSH 2.0.18 起 `{{cwd}}` 不再是已注册的提示词变量**：两个 preset 的 `persona.suffix` 原本写
  `Your working directory is {{cwd}}.`，新版本只注册 `{{provider}}` / `{{model}}`，装配时抛
  `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`，机器人每条消息
  只能回一句「agent 处理出错」。现改成 `suffix: ''`（`dsh/agent-presets/*/agent.cordis.yml`），
  bundle patch 重新生成；`test-qq-preset-contract.mjs`、`verify-persona-config.mjs`、
  `verify-dsh-020-adaptation.mjs` 的断言从「必须保留 {{cwd}}」改成「只能出现已注册变量」，
  以后再往 section 里塞未知变量会直接测试失败（不用等到线上每条消息都报错才发现）。

### 迁移

- **老配置自动迁移**：`config.json` 里没有 `windowCap`、但有 `dailyCap` 时，`windowCap ← dailyCap`
  （夹到 0~100）、`windowHours ← 24`，启动日志打一条 `[qzone] 老配置迁移：...`。原来的
  「一天 N 条」等价变成「24 小时内 N 条」，不用手改；迁移只在内存里做，旧键不删。
- 两个键同时存在时以 `windowCap` 为准（不再迁移）。
