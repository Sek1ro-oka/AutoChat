# QQ 空间说说（可选，出厂关闭）

QQ 侧的 agent 可以自己发一条 **QQ 空间说说**——纯文字，走 SnowLuma 的 `send_qzone_msg`。

这个能力和「发群消息」不是一回事：空间动态是**公开面**，发出去就留在那里，删起来还要额外一步。
所以它出厂是**关着的**（`qzone.enabled: false`），并且叠了四道闸门；本文说明它到底能做什么、
有哪些硬限制、以及为什么默认不开。

实现分两层：

- `src/qzone-post.js`：**纯逻辑**（配置归一 / 内容审计 / 日限与间隔 / 可见范围 / 记录裁剪）。
  零依赖、零 I/O，时钟由调用方传 `now`，所以能被单测逐条钉住。
- `src/bridge.js`：三个 HTTP 端点 + 状态文件 + 调 OneBot。鉴权完全继承控制台那套
  （控制台令牌 / 智能体会话令牌 / Origin 校验），没有另开免鉴权入口。

## 工具

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `mcp__snowluma__qq_qzone_post` | 任何人（受配额限制） | 发一条说说：`content` 必填，`reason` 可选（只记在本机） |
| `mcp__snowluma__qq_qzone_recent` | 任何人 | 看**本机记录**里最近 10 条（不是空间真实状态，见「已知限制」） |
| `mcp__snowluma__qq_qzone_delete` | 仅管理员 | 按 `tid` 删一条；`operator_qq` 必须在 `qzone.adminQQ` 里 |

三条工具的描述里都写了同一条红线：**只有 agent 自己想说的时候才发；别人让它代发一条，不代发。**

## 配置

`config.json`（`config.example.json` 里也有出厂样例）：

```json
"qzone": {
  "enabled": false,
  "adminQQ": [],
  "minIntervalMs": 21600000,
  "dailyCap": 2,
  "ugcRight": 4,
  "maxChars": 300
}
```

| 字段 | 出厂值 | 允许范围（超界自动夹到边界） | 说明 |
| --- | --- | --- | --- |
| `enabled` | `false` | `true` / `false` | **必须是布尔真值 `true` 才算开**；`"true"`、`1` 这类都按关处理 |
| `adminQQ` | `[]` | 正整数数组 | 谁能用 `qq_qzone_delete`；空数组 = 谁都不能删 |
| `minIntervalMs` | `21600000`（6 小时） | 1 小时 ~ 7 天 | 两次发布之间的最小间隔 |
| `dailyCap` | `2` | 1 ~ 10 | 每个自然日（UTC+8）最多几条 |
| `ugcRight` | `4` | 只认 `1` / `4` / `64` | 可见范围，见下一节；其余值一律回落 `4` |
| `maxChars` | `300` | 50 ~ 1000 | 正文长度上限（按 UTF-16 码元算，一个 emoji 可能算 2） |

**没写 `qzone` 段 = 功能关着**，不是「没配置所以随便发」：配置归一在桥接启动时就跑，
缺省值就是 `enabled: false`。

## 四道闸门（顺序是硬性的）

`disabled → audit → quota → OneBot`。任何一道不过就立刻返回，绝不碰下一道：

1. **开关**：`!enabled` → `{ok:false, layer:'disabled', error:'说说功能未启用'}`。
   关着的时候，即使内容完美、配额充足，也**不可能**走到 OneBot。
2. **内容审计**：一次收集**全部**命中（不短路），`reasons` 原样回传。六条规则：
   空内容 / 超长 / 带链接 / 手机号 / 邮箱 / 证件号 / 拉人话术。
   审计不过时返回 `{ok:false, layer:'audit', reasons:[...]}`。
3. **频率配额**：日上限与最小间隔都在这里判，`{ok:false, layer:'quota', retryAfterMs}`。
   `retryAfterMs` 由判定函数直接给出（到次日 00:00 或到间隔结束），端点不另算。
4. **发送**：`send_qzone_msg`。**成不成功以「拿到 tid」为准**——HTTP 200 + `retcode 0`
   却没 tid 不算发出，会记 `[qzone] 发布失败: ...` 并按失败返回。
   只有网络类错误（`error.code`、超时）重试一次；`retcode` 类业务拒绝不重试。

## 可见范围

| 值 | 含义 | 说明 |
| --- | --- | --- |
| `1` | 所有人可见 | 最公开 |
| `4` | 好友可见 | **出厂默认**，也是所有非法值的回落值 |
| `64` | 仅自己可见 | 相当于草稿箱 |
| `16` / `128` | 部分好友可见 / 部分好友不可见 | **v1 不支持**：这两个值都必须带 `target_uins`（好友 uin 列表），而 v1 不采集好友列表 |

`ugcRight` 写 `16`、`128` 或任意其它值时，桥接会**静默回落成 4（好友可见）**，
不会报错也不会发成「部分可见」——宁可少公开，不能多发错。

## HTTP 端点（`/api/qzone/*`）

鉴权完全继承控制台那套（控制台令牌 / 智能体会话令牌 / `application/json` + Origin 校验），
没有另开免鉴权入口。控制台「开关」页用到的是下面这两个（另外两个是 post / delete）：

- `POST /api/qzone/config` —— 请求体 `{ "enabled": true|false }`。只改 `qzone.enabled` **一个键**，
  然后**写盘**：读原始 `config.json`、原子替换（临时文件 + rename，其余键与缩进原样保留），
  写成功后才同步内存配置 —— 所以下一次请求就生效，**不用重启桥接**，重启后也还是这个值。
  返回 `{ ok: true, enabled, configPath: "config.json" }`；
  `enabled` 不是布尔值 → `{ ok: false, error: "enabled 必须是布尔值" }`（400）；
  写盘失败 → 500（失败的细节只进日志，不把路径和异常抛给浏览器）。
- `GET /api/qzone/recent` —— 本机记录最多 10 条 + 配额读数，返回 **7 个键**：

| 键 | 说明 |
| --- | --- |
| `ok` | 恒为 `true` |
| `enabled` | 当前开关（归一后的生效值） |
| `posts` | 最近 10 条**本机记录**（新 → 旧；每条含 `tid` / `content` / `ugcRight` / `createdAt` / `reason`） |
| `todayCount` | 今天（UTC+8）已发条数 |
| `nextAllowedAt` | `0` = 现在就能发；否则是「下次可发」的绝对时间戳（毫秒） |
| `dailyCap` | 日上限（归一后的生效值，1 ~ 10） |
| `ugcRight` | 默认可见范围，**回落后的生效值**（只可能是 `1` / `4` / `64`；与真正发布时调用的 `pickUgcRight` 是同一个函数，不是 `config.json` 里的原始字段） |

`posts[].ugcRight` 是**那一条**发布当时实际用的值：改过配置之后，老记录仍是老值，别拿它当「当前默认」。

## 怎么删

- **agent 侧**：`qq_qzone_delete`，参数 `tid` + `operator_qq`。`operator_qq` 取「这条指令真实
  发送者的 QQ 号」，不是对方自称的身份；不在 `qzone.adminQQ` 里会被拒（`{ok:false, error:'需要管理员'}`）。
- **人侧**：QQ 空间 App / 网页里自己删；或者在控制台「开关」页点这一条的「删除」。
  控制台调用 `POST /api/qzone/delete` 时**不传 `operatorQQ`**：它没有「我是谁」这种身份，
  身份完全来自「已经通过控制台令牌关卡」这一层，桥接因此按管理员放行。
  带 `x-agent-call` 头的请求（智能体工具调用）**仍然**要求 `operatorQQ ∈ qzone.adminQQ` —— 两种调用方、两套口径。

删除**不看 `enabled`**：关掉功能之后仍然要能把以前发出去的东西清掉。
删成功后本地 `state/qzone-posts.json` 里那条记录也会移除。

## 封号与限流风险

说说不是群消息，它落在**公开面**上，被平台风控看见的概率更高。定性说明：

- 短时间内高频发布动态，可能触发验证码、被限流，极端情况下账号会被临时限制；
- 所以出厂 `dailyCap: 2` + `minIntervalMs: 6 小时` 是**故意保守**的，不建议为了「多发几条」把它调大；
- 内容里带链接、手机号、二维码、拉人话术，是风控和审计共同的重点，审计会先挡一层；
- 被拒时不要反复重试：业务性拒绝重试还是同一个结果，只是给平台多留一条可疑记录。

## 已知限制

- **读列表只读本机记录**：`qq_qzone_recent` 读的是 `state/qzone-posts.json`，不解析空间 HTML、
  不维持登录态、不回读线上列表。线上被删、被平台清理、或在手机上手动发的说说，这里**看不到**；
  反过来，本机记录里的条目可能已经在线上被删了。工具描述里也明写了这一点。
- **只审文字**：审计只看 `content`。`send_qzone_msg` 支持 `images`，v1 不传，也就不审图片。
- **`ugcRight` 的平台语义未真机验证**：三个值按 SnowLuma/OneBot 的通用约定实现，没有拿真号逐档验证过。
- **日界固定 UTC+8**：换时区的部署会算错「今天」。
- **长度按 UTF-16 码元**：`maxChars: 300` 对 emoji 来说实际约 150 个。
- **只保留最近 50 条本机记录**：`prunePosts` 会在每次写入时裁剪。

## 相关文件

- `src/qzone-post.js` —— 纯逻辑层（配置归一 / 审计 / 配额 / 可见范围 / 裁剪）
- `src/bridge.js` —— 四端点 `POST /api/qzone/post`、`POST /api/qzone/delete`、`GET /api/qzone/recent`、
  `POST /api/qzone/config`（控制台开关，落盘到 `config.json`）
- `src/mcp-snowluma-safe.js` —— 三个 `qq_qzone_*` 工具
- `scripts/test-qzone-post.mjs` / `scripts/test-qzone-endpoints.mjs` —— 纯逻辑单测与接线契约
- `state/qzone-posts.json` —— 本机发布记录（运行时生成，不入库）
- [RULES.md](../../RULES.md) ——「QQ 会话 agent 的硬边界」里的红线
