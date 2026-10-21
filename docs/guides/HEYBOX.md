# 小黑盒：看帖、搜索与自主评论（可选）

QQ 侧的 agent 可以刷小黑盒（Heybox）首页、看一篇帖子的正文和评论、搜索帖子，以及**自己发一条评论**。

它和「群聊回复」的区别：评论发出去是**公开的**、在别人地盘上、而且**删不掉**（CLI 没有删除接口）。
所以出厂是关着的（`heybox.allowComment: false`），真发要显式打开配置、并在调用时传 `dryRun=false`。

实现分两层：

- `src/heybox-core.js`：**纯逻辑**（配置归一 / 日额度 / 间隔 / 内容审计 / 近似去重 / 验证码暂停窗口 /
  CLI 错误码翻译 / 评论模式回显）。零 I/O，时钟由调用方传 `now`。
- `src/heybox-tools.js`：五个 MCP 工具 + 调 `xiaoheihe-cli` + 账本落盘，注册进**现有的** `snowluma`
  server（不新开进程，避免新增 MCP server 需要重启 DSH）。

底层依赖社区的 `xiaoheihe-cli`（Python）。登录一次（扫码），Cookie 存在它自己的会话文件里，
本仓库不碰账号密码。

## 工具

| 工具 | 说明 | 备注 |
| --- | --- | --- |
| `heybox_status` | 是否登录、用户 id、今日已评论几条、还剩几条、能不能评论、是否被验证码暂停、当前评论模式 | 只读，不调小黑盒 |
| `heybox_feed` | 首页推荐，返回 linkId + 摘要（最多 10 条） | 只读 |
| `heybox_post` | 一条帖子的正文 + 前几条评论 | 只读 |
| `heybox_search` | 搜帖子：linkId / 标题 / 摘要 / 作者 / 评论数 | 只读，搜太勤会被要验证码 |
| `heybox_comment` | 发一条评论；默认 dry-run | 写操作，四道闸门 |

## 评论闸门（顺序是固定的）

1. **总开关** `enabled`。
2. **评论开关** `allowComment`——出厂 `false`，此时 `heybox_comment` 连 `enabledTools` 都不出现。
3. **参数**：`linkId` 必须是数字（来自 `heybox_feed` / `heybox_search`）。
4. **内容审计**（`auditComment`）：长度、有没有刷屏式重复字符、敏感词、像不像广告/联系方式。
   排在额度**前面**——内容不合格是模型自己能立刻改的，先告诉它「哪里不行」比先告诉它「今天没额度了」有用。
5. **额度与间隔**（`heyboxQuota`，顺序：暂停 > 日上限 > 最小间隔）：
   每天 **10 条**（`dailyComments`）、两条之间 **6–20 分钟**随机（`minGapMs` / `maxGapMs`）。
6. **近似去重**：和**最近 5 条真发成功**的评论比（Jaccard 相似度），太像就换说法。演练记录不算数。
7. **dry-run**：默认真跑 CLI 的 `--dry-run`（校验登录态/帖子/文本），不记账、不消耗额度。
   如果 CLI 明确回了 `dry_run: false`（说明它没按演练执行），直接中止。
8. **真发** → **回读评论区确认** → 记账。

### `messageId` 是怎么拿到的

真发成功不一定能拿到评论 id，所以取值按三级来，**拿到哪级算哪级，拿不到就留 `null`**（不编造）：

1. CLI 返回体里的评论 id（只认 `commentid` / `comment_id` / `commentId` 三种键，以及
   `data.comment.*` / `data.result.*` 下的同名键）；
2. 拿不到就**回读该帖评论区**，按自己刚发的正文匹配（返回里 `readbackSource: "readback"`）；
3. 还拿不到就 `null`，账本里 `readback: false`，让你知道这条只能人工去确认。

> 特意**没有**去猜 `data.id`：那是帖子 id，不是评论 id。猜错的 id 比没有 id 更糟。

## 验证码暂停（自动降速）

小黑盒搜得勤、评得猛会被要验证码。命中验证码时：

- **四个入口（feed / post / search / comment）一起停**，不是只停被撞的那一个。
  共用 `state/heybox-usage.json` 里的 `pausedUntil`。
  只掐写接口是不够的：实测 `post get`（读）同样会被要验证码，各写各的窗口等于各停各的，
  用户看到的「评论不能发但还能看帖」会被当成 bug。
- 默认停 **30 分钟**（`captchaPauseMs`，钳制 5 分钟 – 2 小时），到期自动恢复。
- 暂停期内所有小黑盒请求**直接拒绝**，返回里带「还剩 27 分钟」，不会再去碰小黑盒（再试只会延长风控）。
- 老的实现是「停到当天 24:00」——一条验证码废掉剩下半天，还会和日额度混成一句说不清的理由。

## 配置

```json
"heybox": {
  "enabled": true,
  "allowComment": false,
  "dryRunDefault": true,
  "dailyComments": 10,
  "minGapMs": 360000,
  "maxGapMs": 1200000,
  "captchaPauseMs": 1800000,
  "postMaxChars": 200,
  "cliPath": "xiaoheihe-cli"
}
```

- `allowComment: false` + `dryRunDefault: true` 是**出厂组合**：能看不能发。
- 真想放开：`allowComment: true`，并把 `dryRunDefault` 设成 `false`（或者每次调用显式传 `dryRun=false`）。
- 两种开关的组合会翻成四种模式，`heybox_status` 直接回一段人话（`commentMode` /
  `commentModeText`），不用自己去推：

  | 组合 | `commentMode` | 人话 |
  | --- | --- | --- |
  | `enabled: false` | `disabled` | 功能没启用，看帖/搜索/评论都不能用 |
  | `allowComment: false` | `readonly` | 只能看帖和搜索 |
  | `allowComment: true` + `dryRunDefault: true` | `dry_run` | 只演练不发，要真发得传 `dryRun=false` |
  | `allowComment: true` + `dryRunDefault: false` | `live` | 允许真发评论 |

## 落盘

| 路径 | 内容 |
| --- | --- |
| `state/heybox-usage.json` | 当天已评论条数、上次评论时间、验证码暂停截止时间与原因 |
| `state/heybox-actions.jsonl` | 每次真发一行：时间、linkId、正文、`dryRun`、结果、`messageId`、`readback` |

两个都在 `.gitignore` 里，不会进仓库。演练不写这两个文件。

## 排障

| 现象 | 原因 / 怎么办 |
| --- | --- |
| 所有工具都返回 `disabled` | `heybox.enabled` 为 false |
| `heybox_comment` 回 `comment_disabled` | `allowComment: false`（出厂值）。这是设计，不是故障 |
| 返回 `paused` + 「还剩 xx 分钟」 | 之前撞过验证码。等着，别重试 |
| 返回 `captcha` 且刚被暂停 | 平台在风控。停 30 分钟后再说；这期间连看帖也一起停 |
| 返回 `audit` | 内容没过审计（太长 / 重复字符 / 敏感词 / 像广告） |
| 返回 `duplicate` | 和最近 5 条太像，换个说法 |
| 返回 `not_logged_in` / `auth` | `xiaoheihe-cli` 的登录态掉了，手动跑一次它的登录命令（扫码） |
| CLI 报 `code: "input"`「输入或本地文件无效」 | **先别信这条**。这个 CLI 把 `ValueError/OSError/RuntimeError` 全压成 `input`：真实原因常常是读不到会话文件（权限/沙箱/路径），不是参数写错。本机实测过：沙箱里读 `%LOCALAPPDATA%\xiaoheihe-cli\session.json` 被挡，报的就是这句话 |

## 已知限制

- 评论**发出去就删不掉**：CLI 没有删除接口。所以默认 dry-run，且额度/间隔都比「能发」更保守。
- 回读校验只能确认「评论区里有这句」，无法 100% 证明 id 归属；拿不到 id 就如实留 `null`。
- 搜索第 5 次左右容易触发验证码（本机实测），这是平台风控，不是本功能的 bug。
- 帖子里 @ 某人、发图评论、点赞都不做。
