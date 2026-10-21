# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：每个版本一节，
`## [版本] - 日期`，节内按 `新增 / 变更 / 修复 / 迁移` 分组。

## [Unreleased]

### 被 @ / 引用时不再等满静默窗口（2026-10-21）

- `qq_wait_for_messages`（`/api/socialV2/wait`）在等待期间若收到**@我或引用我**的消息，静默窗口收紧到
  `socialV2.wait.selfMentionQuietMs`（默认 12000ms，且不低于 `minQuietAfterNewMs`），不再等满调用方传的
  150 秒静默。
- 原因：群里 @ 完要等两分多钟才有回应，体感就是「机器人没反应」（实测 21:35:13 被 @、21:37:28 才发出回复）。
- 消息落库新增 `atSelf` 标记（`appendSocialV2Message` 第 11 个参数），引用我的消息沿用既有的
  `quoteTargetIsSelf`；两者都算「被点名」。
- 回归：`test-audit-regressions.mjs` 新增 R17（把 `selfMentionQuietMs` 设成 300ms，断言被 @ 后 5 秒内返回）。

### 小黑盒：验证码自动暂停与评论 id 回读（2026-10-21，T-022 收尾）

- 验证码风控从「撞到就不重试」升级为**自动暂停**：新配置 `heybox.captchaPauseMs`（默认 30 分钟，钳制 5 分钟–2 小时）——命中验证码时把 `pausedUntil` 写进 `state/heybox-usage.json`，到期自动恢复，返回文案带「还剩 27 分钟」这种具体等待时间。
- 暂停窗口覆盖**所有**小黑盒请求（`heybox_feed` / `heybox_post` / `heybox_search` / `heybox_comment`）：真机实测平台对 `post get` 这种只读请求同样会要验证码，只掐搜索和评论等于形同虚设。四个入口共用 `pauseBlocker` 一个闸门、`captchaBlocked` 一个出口，不会出现「一个入口暂停了、另一个还在打」。
- 真发评论后落 `messageId`：先取 CLI 返回的评论 id（只认 `data.commentid` / `comment_id` / `commentId`、`data.comment.*`、`data.result.*`，**绝不拿 `data.id` 猜**——那是帖子的 id），取不到再回读评论区按自己的正文匹配（只认本机发的那条），两者都拿不到就是 `null`、不编造；`state/heybox-actions.jsonl` 同时记 `messageId` / `readback` / `readbackSource`。
- `heybox_status` 回显 `commentMode` 四态（`disabled` / `readonly` / `dry_run` / `live`）与一句人话（例如「当前允许真发评论（allowComment=true，dryRunDefault=false）」），不用再去猜配置和额度状态；暂停期间额外回「还剩多久」。

### 安卓平板：截图、点击与视觉闭环（2026-10-21，T-023）

- 新增 `src/device-core.js`（配置归一/预算/黑名单/坐标夹取/动作分类/`adb devices` 与 `dumpsys window` 解析，纯函数）与 `src/device-tools.js`（**八个** MCP 工具，注册进现有 snowluma 服务器：58 → 66，`tools/list` 实测 66 = 53 个 `qq_*` + 5 个 `heybox_*` + 8 个 `device_*`；没有单独的 `src/mcp-device-safe.js` 进程）。
- 工具：`device_status`（设备/电池/今日额度/`foreground`）、`device_screenshot`（唯一入口，返回 PNG 给模型看）、`device_list_apps`（第三方应用包名 + 是否在黑名单）、`device_tap`、`device_swipe`、`device_type`、`device_key`（back/home）、`device_open_app`。
- 黑名单硬闸门：`device.blockedApps` 的内核五项（支付宝 / 微信 / QQ / Play 商店 / 系统设置）写死在代码里，配置只能追加、删不掉；五个动手工具**每次执行前**先读 `dumpsys window` 的 `mCurrentFocus`，命中即 `blocked_foreground`、写日志且**不记步**；**唯一例外是 `device_key home`**（逃生口：只回桌面，不碰应用内容；`back` 仍拦，因为它是应用内导航）；`device_open_app` 对黑名单包名一律 `blocked_app`（白名单里写了也一样）；`device_status` 直接返回 `foreground` 供模型确认自己在哪一屏。读不出前台时 fail-open 放行，但动作日志会带 `foreground:"unknown"` / `foregroundKnown:false`，事后能看出哪几步是盲着做的。截图 / 列应用不过这道闸门（被拦时至少还能看见「我在微信」）。
- 预算闸门：每天 30 分钟 / 60 步、两步间隔 ≥1 秒、一轮结束暂停 1 小时、`open_app` 只认白名单、敏感词（密码/支付/转账/验证码/登录/购买/删除/安装…）直接拒且不记账。截图与 `device_list_apps` 不计步（否则「点一下看一次」第一眼就被间隔拦），额度用完后两者仍可用——「看」不拦，「动」才拦。
- `device_type` 只支持 ASCII（adb `input text` 的限制）：中文直接返回 `ascii_only` 并提示改用点击；空格转 `%s`，其它特殊字符编码以避免设备端 shell 解释。
- 桥接：顶层 `device` 配置归一（与 MCP 侧同一个 `normalizeDeviceConfig`）、prompt `device` 块（额度现算 + 八个工具名 + 黑名单），`enabled:false` 时整块短路成 `{enabled:false}`、八个工具从清单消失。
- 新增 `scripts/smoke-device.mjs`（`npm run smoke:device`）：真机顺序跑 `status → list_apps → screenshot → tap → swipe → key(back) → open_app`，前一步失败即停并给中文原因（`adb` 不存在 / 无设备 / 未授权 / 前台是黑名单应用），失败以 1 退出；`--state-dir` 可换独立账本，不占正式额度。
- 文档对齐：`work/agent-tasks/T-023/dev-doc.md` 按**实际实现**重写（旧稿里的 `mcp-device-safe.js`、`device_state`、`scalePoint`、剪贴板 IME、boredom 定时器都是没实现的设想，已逐条标出），`ISSUE.md` 状态改为「已实现，真机待验收」。
- adb 路径默认值不再写死本机绝对路径，改成 `%LOCALAPPDATA%\Android\platform-tools\adb.exe`，执行前由导出的纯函数 `expandEnvPath` 展开（只认 `%NAME%`，取不到值原样留着）：同一台机器展开后行为不变，仓库里不再出现某个人的用户目录绝对路径，换账号 clone 也不用改代码。`config.example.json` 与冒烟脚本同步（脚本先展开再 `existsSync`）。
- 本轮不含自动唤醒：模型会用工具，但「自己跑去玩」的定时器与玩后写日记留到下一步。
- 状态在 `state/device-state.json`，动作日志 `state/device-actions.jsonl`，截图 `state/device/`。
- 修复（真机验收 `TB375FC` / Android 16）：坐标空间改用**最近一次截图的宽高**，不再拿 `wm size` 当唯一依据。竖持时 `wm size` 报物理面板 `1840x2944`，而横屏应用的实际显示与输入空间是旋转后的 `2944x1840`（`dumpsys window displays` 的 `cur=` / `app=` 与 `screencap` 的 PNG 一致），旧实现把 x∈[1840,2944) 的合法坐标夹到 `1840`，点错位置。新增纯函数 `parsePngSize(buffer)`（`src/device-core.js`，读 PNG IHDR 偏移 16/20 的大端宽高，非 PNG/长度不足/尺寸为 0 返回 `null`）；`src/device-tools.js` 在内存里记住最近一次截图（带 serial，换设备自动作废），`device_tap` / `device_swipe` 夹取与 `device_status` 的 `screen` 优先用它，没截过图才回退 `wm size`；回执里的 `screen` 即真实使用的宽高，`clamped` 语义不变（越界夹到边界、不报错）。`docs/guides/DEVICE.md` 的已知限制补了「旋转屏幕后先知截图再点击」。

### 小黑盒：看帖、搜索与自主评论（2026-10-21，T-022）

- 新增五个 MCP 工具（注册进 snowluma 服务器，随 DSH 重拉子进程生效）：`heybox_status`（登录态 + 今日额度）、`heybox_feed`（首页推荐，返回链接 id 与摘要）、`heybox_post`（正文 + 前 20 条评论）、`heybox_search`（搜帖子/游戏/话题/用户）、`heybox_comment`（发评论，默认 dry-run）。
- 底层用 `xiaoheihe-cli`（Python，扫码登录一次，Cookie 只存在它自己的会话文件里）；spawn 前清空所有代理环境变量——本机 `NO_PROXY` 里的 `[::1]` 会让 httpx 0.28 抛 `Invalid port: ':1]'`。
- 评论硬闸门全在 `src/heybox-core.js` 纯函数里：日限 10 条、两条间隔 6–20 分钟、内容审计（长度 / 链接 / 手机号 / 邮箱 / 身份证 / 拉人 / 纯表情 / 连续复读）、与最近 5 条近似去重（3-gram Jaccard ≥ 0.55）、默认 `dry-run`、真发后回读校验（找不到只标 `verified:false`，不改记账）。
- 出厂 `heybox.allowComment=false`（只读能上线，评论要显式打开）；验证码即暂停到当日 24:00 并写明原因；每次真发与失败都写 `state/heybox-actions.jsonl`。
- 配置在 `config.json` **顶层** `heybox` 段（与 `qzone` / `file` / `bili` 同级），缺段即出厂默认；prompt 的 `heybox` 块只给额度与工具名，`allowComment=false` 时不列 `heybox_comment`。
- 已知限制：小黑盒**搜索端点**比其它接口更容易触发验证码（连发几次就会被要），搜太勤时模型会收到 `captcha`，隔一会儿再试即可。

### qq_recall 限流改成控制台可调（2026-10-21，T-021）

- 新增 `socialV2.cross.recallWindowMs`（60 秒–60 分钟，默认 5 分钟）与 `recallMaxPerWindow`（0–100，默认 3，**0 = 不限次数**）。
- 「跨渠道互通」面板新增两个输入框（次数上限 / 窗口分钟），和分组一起「保存分组」提交；桥接即时生效，不用重启。
- `POST /api/socialV2/cross` 现在支持只提交限流旋钮（`groups` 可省略）；越界整数直接 400 `bad_quota`，不再静默夹值。
- `GET /api/socialV2/cross` 返回两个当前值供面板回填；`qq_recall` 的 429 `retryAfterMs` 跟着窗口走。

### 同组消息自动进上下文 + 补齐工具清单（2026-10-21，T-020）

- **修好「私聊读不进群聊消息」**：prompt 的 `enabledTools` 之前漏登记 `qq_recall` / `qq_lookup` / `qq_affect_report`，模型看不到能力清单里的检索工具，只能说「读不到别处的消息」。现在三项按各自总开关（`socialV2.cross` / `socialV2.identity` / `socialV2.affect`）出现在清单里。
- **同组消息自动带上**：`GET /api/socialV2/prompt` 的 `cross` 块新增 `recent`——同一互通编号的其它会话最近消息（每个会话默认 5 条、只取 2 小时内），每条带 `key`/`label`/`ts`/`from`/`text`（正文截 200 字），按时间正序。只列同组，编号 `0` 仍然一个字都不给。
- **出处用名字不用号码**：`others`/`recent` 的 `label` 走名字映射表（`群名（群 123…）` / `昵称（QQ 456…）`），查不到才回退号码。
- **新配置**：`socialV2.cross.recentPerKey`（0–20，默认 5，`0` = 不在 prompt 里带）、`socialV2.cross.recentHours`（0–72，默认 2）。
- 跨会话发送不受影响：同编号互发仍然可用（`agentTokenCoversSend`），不同编号/`0` 仍然 403。

### 暂停生图渠道（2026-10-21）

- 新增细分开关 `socialV2.images.generateEnabled`（缺省 `true`）：设为 `false` 只停 `qq_draw_image`，发图 / 存表情 / 换头像三条腿继续可用（换头像仍可吃收藏表情或图片链接）。
- 停用时的表现：`POST /api/socialV2/images/generate` → 403 `generate_disabled`（文案比总开关更具体）；prompt 的 `images.tools` 自动摘掉 `qq_draw_image`、`generateEnabled:false`、hint 换成「别调、用现成图片」；MCP 侧 `qq_draw_image` 直接回一句「生图渠道暂时停用了，别重试」。
- 本机 `config.json` 已置 `false`：Pollinations 出图质量不达标，暂停使用，代码与其余三项保留。

### 私聊群聊互通与名字映射（2026-10-21，T-016 / T-018）

- **跨渠道互通**：会话按互通编号分组（`socialV2.cross.groups`），同号会话共享记忆池——`qq_recall` 按需检索别处说过的话（只给元数据提示，不自动灌正文，每会话 5 分钟 3 次）、成员印象按 QQ 号合并、日记写进共用本子（`state/diaries/cross_<gid>/`）；编号 `0` = 不共享。控制台新增「跨渠道互通」页。
- **跨会话发言**：发送类端点（`send-message` / `send-burst` / `send-poke` / `send-voice` / `send-sticker` / `/api/send/*` / 发图）改用 `agentTokenCoversSend`——本会话令牌，或同一互通编号的会话令牌；编号 0 与不同编号仍然 403，文案会提示「不在同一互通编号」。
- **名字映射表**：`state/identity-map.json` 记录好友、群与群成员（最多 1000 / 200 / 2000），启动 10 秒后与每 6 小时刷新一次（`socialV2.identity`），收到消息时增量更新。`GET /api/socialV2/identity` 搜索、`POST .../refresh` 立即拉取；AI 侧新增 `qq_lookup` 工具，prompt 里也会带上当前会话相关的人名。
- **控制台**：新增「名字映射」页（搜索 + 统计 + 刷新）；「跨渠道互通」里主人私聊永远显示为「主人（私聊 …）」，编号可改。

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

### 生图与资料（2026-10-21，T-017）

机器人现在能自己画图，画完可以发出去、存进收藏表情，也可以拿它当自己的头像。

- **生图**：新工具 `qq_draw_image`（中文/英文提示词，3–300 字），背后是免登录的
  Pollinations（`image.pollinations.ai`），一次性直连、不需要 key。出图后模型能直接
  「看见」这张图，再决定发不发。
- **发图 / 存表情 / 换头像**：`qq_send_image` 发到当前会话，`qq_save_sticker` 存进 QQ
  收藏表情并写一句备注，`qq_set_avatar` 换自己的头像（也能用本机已有的图或白名单域名）。
- **硬闸门**：提示词先过长度、链接/联系方式审计、黑名单与「真人照片」意图检查；出图
  20 张/24 小时且两次至少隔 45 秒（上游免费额度），收藏表情 5 个/24 小时，换头像
  1 次/24 小时；上游 402 会把它自己给的「还有几秒」原样转成 429。
- **隐私**：只把图片存到本机 `state/images/`，索引最多 200 条；对外只允许
  `image.pollinations.ai` 与 `q1.qlogo.cn` 两个域名，图片 id 是 UUID，取图按索引走、
  不拼路径。
- 配置段 `socialV2.images`（开关、尺寸上限、三类额度），`enabled=false` 时四个工具一起消失。

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
  三项改动在 4 小时窗口里已用几次、还剩几次与下次可改时间、最近 10 条改动记录。
- **改资料**：`qq_set_nickname` / `qq_set_signature` / `qq_set_group_card`，
  对应 `POST /api/socialV2/profile/{nickname,signature,group-card}`。闸门在纯函数模块
  `src/profile-core.js`：长度按码点、禁换行、禁纯 emoji / 纯标点，正文复用 qzone 的审计规则
  （链接 / 手机号 / 邮箱 / 身份证 / 拉人话术），昵称额外拒绝数字开头、`@`、5 位以上连续数字。
- **额度是滑动窗口**（2026-10-21 调整，原为「冷却 + 每日上限」）：昵称、签名各算各的，群名片按群算，
  都是 **4 小时内最多 5 次**、两次之间至少 **60 秒**；拒绝时 `429` 带 `retryAfterMs`，
  `too_frequent` 说「N 秒后」、`window_cap` 说「约 X 后才能再改」（等最早那次滑出窗口）。
- **读回校验**：改完立刻读回，不一致时不记账、返回 `ok:false` + `pending:true`（模型会被告知「没回读确认」）。
- **群名片清空是网关限制**：SnowLuma 的编码器在群名片为空串时会省略字段，服务端回 OIDB 1007，
  所以「清除」实际写的是一个半角空格（读回可能显示为空），状态文件与日志仍记空串。
- 配置在 `config.json` 的 `socialV2.profile`（`enabled` 与三种资料各自的 `windowHours` / `windowCap` /
  `minGapMs` / `maxChars`）；缺省段等于出厂默认。这四个工具没有登记 `TOOL_CONFIG_FLAGS`，总开关是 `socialV2.profile.enabled`。

### 私聊与群聊互通（2026-10-21，T-016）

机器人现在能把「同一个圈子」里的私聊和群聊连起来理解：同一编号的会话可以互相回忆对方说过的话，
记忆按人（QQ 号）合并，日记也写进同一本。

- **编号即圈子**：每个会话一个编号，编号相同就互通，`0` = 不共享。默认每个会话各自一个编号、互不共享；
  控制台「跨渠道互通」页可以直接改编号，保存立刻生效，不用重启桥接。
- **消息缓冲**：桥接按会话把消息落成 `state/cross/<会话>.ndjson`，每会话最多 500 条
  （`socialV2.cross.bufferPerConversation`），存全文而不是提示词里那份 200 字截断版。
- **只给元数据提示**：提示词里只会出现「同组还有几个会话、各有几条新消息」，
  要回忆细节时模型自己调 `qq_recall`（只读、逐条带出处、查不到就明说没找到）；
  同一会话 5 分钟内最多查 3 次。唤醒提示的门槛是同组新消息 ≥2 条且距上次提示 ≥3 轮。
- **共享记忆**：对群友的印象从「按显示名」改成「按 QQ 号」合并（`qq:<数字>` 键，带多个名字与渠道），
  同一个人换群、换私聊还是同一个人；旧的名字键继续可读但不自动迁移。
- **共享日记**：同组会话写进同一本日记（目录 `cross_<编号>`），宣泄日记同样并入。
- 配置在 `config.json` 的 `socialV2.cross`（`enabled`、`bufferPerConversation`、`groups`）；
  分组只影响「能不能互相回忆」，不影响原有白名单。

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
