# 社交自动化（可选，出厂全关）

桥接可以替你做几件「加好友 / 进群」的杂事：同意好友申请、同意入群邀请、进群后把自己加进白名单。
这些动作**不需要模型参与**，是桥接自己判断、自己调 OneBot 接口完成的，所以也**不受人设提示词约束**。

正因为是自动化，出厂状态是**全关**（`socialV2.automation` 五个开关里只有 `notifyOwner` 默认开），
额度也有上限（默认一天 5 / 3 / 5 次）。本文说明每个开关到底做什么、有哪些硬限制、以及为什么
「让机器人自己去加群」这件事做不到。

实现分两层：

- `src/social-auto.js`：**纯逻辑**（配置归一 / 部分更新校验 / 上海自然日 / 额度 / 审计尾部解析 / 文案）。
  零 I/O、零依赖，时钟由调用方传入，所以能被单测逐条钉住（`scripts/test-social-auto.mjs`）。
- `src/bridge.js`：三个事件订阅 + 三个 handler + 白名单串行写入 + `GET/POST /api/socialV2/automation`。

## 能做什么 / 不能做什么

| 能做 | 不能做 |
| --- | --- |
| 好友申请：确认对方**真的在**某个白名单群里，然后同意 | 主动加群 / 搜群 / 发加群申请（上游没有这个接口，见下一节） |
| 入群邀请：同意别人把机器人拉进群 | 处理「别人申请加入机器人管理的群」（那是群管理员的职责，不在本功能范围） |
| 进群后把该群加进 `allow.groups` | 从白名单里**删**人或群（只追加，删请去控制台白名单页） |
| 同意好友后把对方加进 `allow.private` | 改群名片、改备注、发欢迎语 |
| 每个动作私聊通知 `ownerQQ` + 写审计 | 替你判断「这个群该不该进」——开关开着就一律同意 |

## 五个开关

`config.json` → `socialV2.automation`：

```json
"socialV2": {
  "automation": {
    "acceptInvite": false,
    "groupWhitelist": false,
    "friendFromGroup": false,
    "privateWhitelist": false,
    "notifyOwner": true,
    "dailyLimits": { "friendApprove": 5, "inviteApprove": 3, "whitelistWrite": 5 }
  }
}
```

| 键 | 出厂 | 管什么 | 语义 |
| --- | --- | --- | --- |
| `acceptInvite` | `false` | 自动同意**入群邀请** | 只有 `=== true` 才算开；`"true"`、`1` 一律按关处理 |
| `groupWhitelist` | `false` | 机器人**自己被拉进群**后，把该群加进 `allow.groups` | 同上（依赖 `notice/group_increase`，见「未获证」） |
| `friendFromGroup` | `false` | 同意**白名单群成员**的好友申请 | 同上 |
| `privateWhitelist` | `false` | 同意好友后，把对方加进 `allow.private` | 同上。不开也能同意好友，只是对方发消息不会回 |
| `notifyOwner` | `true` | 每个自动动作私聊 `ownerQQ` | 唯一 fail-open 的键（关掉就静默，审计照写） |
| `dailyLimits.friendApprove` | `5` | 一天最多同意几个好友申请 | `0` ~ `50`，`0` = 今天一个都不做 |
| `dailyLimits.inviteApprove` | `3` | 一天最多同意几个入群邀请 | 同上 |
| `dailyLimits.whitelistWrite` | `5` | 一天最多写几次白名单 | 同上 |

**为什么要 fail-closed**：这些动作会改变「谁能和机器人说话」。配置里写错一个 `"false"`（字符串）、
少写一个键、或者从旧版本升上来，都不能变成「开着」。所以判定一律是 `value === true`，
**不复用** `socialV2.tools` 那套 `!== false`（那套的语义是「AI 能不能调某个 MCP 工具」，缺省是开）。

额度是**上海自然日**（`Asia/Shanghai`），跨天自动清零；`0` 是合法值，不是「不限」。
额度用完**不抛错**：记一条 `kind:"quota"` 审计、每天只私聊告警一次，然后把这次请求放过去。

## 为什么「自主加群」做不到

结论：**上游没有这个能力**，不是桥接没做。

查证范围（详见 `work/agent-tasks/T-009/research.md`，带证据行号）：SnowLuma 的 132 个 `defineAction`
动作、190 条 `_snowluma-catalog.json` 条目、104 个协议命名空间、16 个 Api 类里，**没有任何**
「搜索群 / 申请加群 / 加入群」的接口。唯一勉强算逃生口的是底层 `send_packet`——那要求调用方自己
拼 protobuf 原始包，既没有回执也没有错误码，等于盲发，所以明确不做。

因此本功能里所有「进群」都来自**别人邀请**（`request/group`），桥接只负责同意；
要主动进群，只能你在 QQ 客户端里自己申请，再在控制台把群号加进 `allow.groups`。

## 事件与判定顺序

三条订阅（旧版运行时缺方法时桥接照常启动，只打一行「社交自动化订阅不可用」）：

| 事件 | handler | 判定 |
| --- | --- | --- |
| `request/friend` | `handleFriendRequest` | 开关 → `flag`/`user_id` 合法 → 逐个白名单群查成员（最多 20 个群、整体 10 秒超时）→ 额度 → `set_friend_add_request` |
| `request/group` | `handleGroupInvite` | 开关 → `flag`/`group_id` 合法 → 额度 → `set_group_add_request` |
| `notice/group_increase` | `handleSelfJoinedGroup` | 开关 → `user_id === self_id` → 群号合法 → 额度 → 写 `allow.groups` |

几个刻意的选择：

- **好友申请不看留言里写的群号**。留言可以伪造，唯一可信的是「这个 QQ 号是不是白名单群的成员」，
  所以真去 `get_group_member_info` 查。查不到（机器人不在那个群、被风控、超时）就跳过，不猜。
- **入群邀请的 `flag` 原样透传**，不自己拼前缀。SnowLuma 实现层会丢弃 `sub_type`，前缀拼错反而同意不了。
- **不处理「别人申请加入机器人管理的群」**（那种事件的 `sub_type` 也是邀请/申请混在一起，容易误批）。
- 跳过也写审计（`kind:"skip"`），方便你在控制台看到「为什么没同意」。

## 白名单写入

只**追加**：不删除、不覆盖、不去重改写别人的条目。控制台白名单页和自动化会同时「读—改—写」
同一份 `config.json`，所以：

1. 所有写入**串行排队**（一次失败不会卡死队列）；
2. **写前重读** `config.json`，只往数组尾部 push（已存在则跳过）；
3. 原子写（临时文件 + rename），**写成功之后**才更新内存 `cfg.allow`；
4. 立刻调 `reconcileSessionPolicies()`，新群/新好友的会话权限当场生效，不用重启。

写失败不会回滚已经完成的动作（好友已经加上了，撤不回来），只补记一条 `ok:false` 审计。

## 状态与审计

两个文件都在 `state/`（不入库）：

- `state/social-auto.json`：当天额度。
  ```json
  { "day": "2026-10-20", "counts": { "friendApprove": 2, "inviteApprove": 1, "whitelistWrite": 3 },
    "alerted": { "friendApprove": false, "inviteApprove": false, "whitelistWrite": false } }
  ```
- `state/social-auto.jsonl`：审计，一行一条。
  ```json
  {"ts":"2026-10-20T20:31:02.441+08:00","kind":"friendApprove","ok":true,"qq":234567,"groupId":119212385,"groupName":"摸鱼大队","text":"已同意好友申请 234567（来自群「摸鱼大队」119212385）"}
  ```

`kind` 取值：`friendApprove` / `inviteApprove` / `whitelistWrite` / `skip` / `quota` / `notify`。
`text` 是控制台直接显示的那一行人话；`notify` 类的 `text` 就是实际发出去的私聊正文。
**不写 token、不写消息正文。**

控制台「最近自动动作」读的就是这个文件的尾部 10 行（按时间正序）；文件不存在时返回 `[]`，不会 500。
想清空就删掉它（历史留档请先备份）。

## 控制台与接口

「开关」页有「社交自动化」卡片（在「说说」卡下面）：五个开关 + 今日额度 + 最近动作。页面走这两个端点：

- `GET /api/socialV2/automation` → `{ ok, automation, today, limits, recent }`
- `POST /api/socialV2/automation` → 部分更新，体如 `{"acceptInvite": true}`

POST 的三种 400（文案固定）：

| 情况 | 响应 |
| --- | --- |
| 未知键 | `不认识的配置项：<key>` |
| 值不是布尔 | `开关必须是布尔值` |
| 空对象 | `至少要改一项（acceptInvite / groupWhitelist / friendFromGroup / privateWhitelist / notifyOwner）` |

落盘顺序是**先校验、再读文件、再原子写、最后才换内存**：写盘失败回 500 且内存不变，
不存在「界面显示开了、实际没写进去」。`dailyLimits` 不在这个端点的白名单里——
它属于「配置」而不是「开关」，要走 `config.json`（见「每日额度怎么改」）。

两个端点都在 `adminOnlyV2Paths` 里：带 `x-agent-token` 的 AI 通道访问会被 403 拒绝，
所以模型没法自己把开关打开。

## 每日额度怎么改

编辑 `config.json` → `socialV2.automation.dailyLimits`，三个键分别对应三类动作，取值 `0`~`50`
（超界自动夹到边界，非数字回落默认 5 / 3 / 5），改完**重启桥接**生效。

想临时停掉某一类动作但保留另一类，把对应额度设成 `0` 比关开关更省事——开关关掉后连「跳过」
都不记，额度设 `0` 会在审计里留下 `kind:"quota"` 的记录，便于事后核对。

## 手动加白名单

不想开自动化（或者某个群是别人拉的、你事后才知道），直接加白名单就行：

1. **控制台**：「访问与安全」页的白名单编辑器，粘贴群号/QQ 号保存，立即生效；
2. **`config.json`**：`allow.groups` / `allow.private` 是数字数组，改完重启桥接。

```json
"allow": { "private": [123456], "groups": [119212385] }
```

`deny` 优先于 `allow`：同一个群同时出现在两边时按黑名单处理，自动化的好友核验也会跳过黑名单群。

## 已知限制与未获证项

- `notice/group_increase` 是否真能收到、`user_id === self_id` 判定是否成立：**未在真机验证**。
  收不到的话，`groupWhitelist` 实际不触发，退化成「手动加白名单」（功能不受影响，见上一节）。
- 入群邀请 `flag` 的实际形态未验证；桥接原样透传，同意失败会记 `ok:false` 与原始错误。
- `get_group_member_info` 对「机器人不在的群」会抛错（已按群 try/catch），且上游有风控，
  好友申请可能因此变慢；单轮最多查 20 个群、整体 10 秒超时后放弃。
- 同意好友申请后，对方是否立刻出现在好友列表里未验证；`privateWhitelist` 只写白名单，不等好友关系。
- 未配置 `ownerQQ` 时通知发不出去，只写日志「未配置 ownerQQ」；动作本身照做。

## 自测

```bash
node scripts/test-social-auto.mjs
```

纯函数级（不连 QQ、不读写真实 `config.json` 和 `state/`）：归一化 fail-closed、额度 `0` 合法与夹取、
三种 400 文案、上海自然日跨日、额度不修改入参、审计尾部解析的时间正序与坏行跳过、
四类文案逐字比对。

## 相关文件

- `src/social-auto.js`：纯逻辑与文案
- `src/bridge.js`：事件订阅、三个 handler、`appendWhitelist`、额度/审计读写、两个端点
- `scripts/test-social-auto.mjs`：单测
- `work/agent-tasks/T-009/`：需求澄清（`clarify.md`）、上游能力查证（`research.md`）、
  施工图（`dev-doc.md`）
