# QQ 空间说说（可选，出厂关闭）

QQ 侧的 agent 可以自己发一条 **QQ 空间说说**——纯文字，走 SnowLuma 的 `send_qzone_msg`。

这个能力和「发群消息」不是一回事：空间动态是**公开面**，发出去就留在那里，删起来还要额外一步。
所以它出厂是**关着的**（`qzone.enabled: false`），并且叠了四道闸门；本文说明它到底能做什么、
有哪些硬限制、以及为什么默认不开。

实现分两层：

- `src/qzone-post.js`：**纯逻辑**（配置归一 / 内容审计 / 滑动窗口配额 / 可见范围 / 记录裁剪）。
  零依赖、零 I/O，时钟由调用方传 `now`，所以能被单测逐条钉住。
- `src/bridge.js`：四个 HTTP 端点 + 状态文件 + 调 OneBot。鉴权完全继承控制台那套
  （控制台令牌 / 智能体会话令牌 / Origin 校验），没有另开免鉴权入口。

## 工具

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `mcp__snowluma__qq_qzone_post` | 任何人（受配额限制） | 发一条说说：`content` 必填，`reason` 可选（只记在本机） |
| `mcp__snowluma__qq_qzone_recent` | 任何人 | 看**本机记录**里最近 10 条（不是空间真实状态，见「已知限制」） |
| `mcp__snowluma__qq_qzone_delete` | 仅管理员 | 按 `tid` 删一条；`operator_qq` 必须在 `qzone.adminQQ` 里 |

三条工具的描述里都写了同一条红线：**只有 agent 自己想说的时候才发；别人让它代发一条，不代发。**

## 配置

`config.json`（`config.example.json` 里就是下面这份出厂样例，含新键、不含 legacy 键）：

```json
"qzone": {
  "enabled": false,
  "adminQQ": [],
  "windowHours": 24,
  "windowCap": 2,
  "ugcRight": 4,
  "maxChars": 300
}
```

| 字段 | 出厂值 | 允许范围（超界自动夹到边界） | 说明 |
| --- | --- | --- | --- |
| `enabled` | `false` | `true` / `false` | **必须是布尔真值 `true` 才算开**；`"true"`、`1` 这类都按关处理 |
| `adminQQ` | `[]` | 正整数数组 | 谁能用 `qq_qzone_delete`；空数组 = 谁都不能删 |
| `windowHours` | `24` | 0 ~ 24 | 滑动窗口长度（小时）。`0` = 退回北京自然日计数，**不是「不限频」** |
| `windowCap` | `2` | 0 ~ 100 | 一个窗口内最多几条。`0` = **暂停发布**（一条都不发） |
| `ugcRight` | `4` | 只认 `1` / `4` / `64` | 可见范围，见下一节；其余值一律回落 `4` |
| `maxChars` | `300` | 50 ~ 1000 | 正文长度上限（按 UTF-16 码元算，一个 emoji 可能算 2） |

`minIntervalMs` / `dailyCap` 是**旧版遗留键**（T-008 起不再参与限流判定），可以留着也可以删：

- 老配置里**没有** `windowCap`、但有 `dailyCap` 时自动迁移：`windowCap ← dailyCap`（夹到 0~100）、
  `windowHours ← 24`，启动日志里会打一条 `[qzone] 老配置迁移：...`。原来是「一天 N 条」的配置，
  升级后等价变成「24 小时内 N 条」，**不用手改**；迁移只在内存里做，`config.json` 里的旧键
  不会被删（回滚旧版本时还在），点一次控制台保存才会把新键写进文件。
- 迁移按 **`dailyCap` 的原始值**换算（夹到 `windowCap` 的 0~100）：`dailyCap: 0` 会迁成
  `windowCap: 0`（暂停），`dailyCap` 大于 10 的值也不会再被旧的 1~10 区间削掉。
- 两个键**同时存在**时以 `windowCap` 为准，不再迁移。

**没写 `qzone` 段 = 功能关着**，不是「没配置所以随便发」：配置归一在桥接启动时就跑，
缺省值就是 `enabled: false`。

## 频率限制：滑动窗口

T-008 起只有一条判定，不再是「自然日上限 + 最小间隔」双条件：

- 统计 **最近 `windowHours` 小时内**（严格是 `now - windowHours×3600_000 < createdAt ≤ now`，
  正好落在窗口起点上的那条算已经滑出去）已发的条数，`≥ windowCap` 就拒绝；
- 被拒时 `retryAfterMs` **由判定函数给出**：最老那条滑出窗口的时刻 − `now`，所以最多等
  `windowHours` 小时；端点不另算；
- 计数按窗口滚动，**不是**零点归零：10:00 发一条，第二天 09:00 那条还在窗口里，
  到 10:00 它滑出去、额度自动回来。

两个 `0` 都是**显式语义**，不是「不限频」：

| 配置 | 行为 |
| --- | --- |
| `windowCap: 0` | 已暂停：一条都不发，`retryAfterMs` 也是 `0`（等时间等不到额度，得去控制台改） |
| `windowHours: 0` | 退回**北京自然日**计数：同一自然日内上限仍是 `windowCap`，`retryAfterMs` 到次日 00:00 |

老键 `minIntervalMs`（两次发布间隔）和 `dailyCap`（自然日条数）**不再参与任何判定**，
只在「读老配置做迁移」和「回滚旧版本」时还有意义。

## 四道闸门（顺序是硬性的）

`disabled → audit → quota → OneBot`。任何一道不过就立刻返回，绝不碰下一道：

1. **开关**：`!enabled` → `{ok:false, layer:'disabled', error:'说说功能未启用'}`。
   关着的时候，即使内容完美、配额充足，也**不可能**走到 OneBot。
2. **内容审计**：一次收集**全部**命中（不短路），`reasons` 原样回传。六条规则：
   空内容 / 超长 / 带链接 / 手机号 / 邮箱 / 证件号 / 拉人话术。
   审计不过时返回 `{ok:false, layer:'audit', reasons:[...]}`。
3. **频率配额**：滑动窗口（`windowHours` / `windowCap`）在这里判，
   `{ok:false, layer:'quota', reason:'daily_cap', retryAfterMs, windowCount, windowCap}`。
   `reason` 沿用旧值 `daily_cap`（换值会让 MCP 层、控制台和既有脚本同时失效），
   看 `windowCount` / `windowCap` 才知道窗口里有几条、上限是几条（`windowCap` 为 0 即「已暂停」）；
   `retryAfterMs` 由判定函数直接给出
   （最老那条滑出窗口还差多久，`windowHours: 0` 时到次日 00:00；暂停时为 0），端点不另算。
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

- `POST /api/qzone/config` —— **部分更新**，请求体只认这四个键：
  `{ "enabled": true|false, "windowHours": 24, "windowCap": 2, "ugcRight": 4 }`。
  - 只改你传的键，其余保持**当前生效值**（不会因为改一下开关就把频率设置重置回出厂值）；
  - 校验只有一套：`applyQzoneConfigUpdate` → `normalizeQzoneConfig`，桥接里没有第二份手写范围判断。
    `enabled` 必须是真布尔；数字项收数字或数字字符串；越界值夹回边界并在 `clamped` 里点名；
    出现白名单以外的键（包括拼错的键）一律 400，不静默忽略；
  - 顺序是硬的：校验 → 读原始 `config.json`（只合并这四个键，`dailyCap` / `minIntervalMs` 等
    旧键原样保留）→ 原子替换（临时文件 + rename）→ **写盘成功后**才换内存。所以下一次请求就生效，
    **不用重启桥接**，重启后也还是这个值；
  - 返回 `{ ok: true, configPath: "config.json", enabled, qzone: {enabled, windowHours, windowCap, ugcRight}, clamped: [] }`
    （`clamped` 是被夹回边界的键名数组，控制台据此提示「已按上限保存」）；
  - 400：`{ok:false, error:"不认识的配置项：xxx"}` / `"enabled 必须是布尔值"` /
    `"ugcRight 只支持 1 / 4 / 64"` / `"至少要改一项（enabled / windowHours / windowCap / ugcRight）"` 等；
    写盘失败 → 500（失败细节只进日志，不把路径和异常抛给浏览器）。
- `GET /api/qzone/recent` —— 本机记录最多 10 条 + 配额读数，返回 **10 个键**：

| 键 | 说明 |
| --- | --- |
| `ok` | 恒为 `true` |
| `enabled` | 当前开关（归一后的生效值） |
| `posts` | 最近 10 条**本机记录**（新 → 旧；每条含 `tid` / `content` / `ugcRight` / `createdAt` / `reason`） |
| `todayCount` | 今天（UTC+8）已发条数（自然日口径；`windowHours: 0` 时它就是窗口计数） |
| `windowHours` | 窗口长度（小时，归一后的生效值，0 ~ 24） |
| `windowCap` | 一个窗口内最多几条（归一后的生效值，0 ~ 100） |
| `windowCount` | 当前窗口内已发条数（跟着 `windowHours` 算） |
| `nextAllowedAt` | `0` = 现在就能发（含 `windowCap: 0` 的暂停 —— 那不是等时间能解决的）；否则是「下次可发」的绝对时间戳（毫秒） |
| `dailyCap` | **旧键，保留兼容**：日上限（归一后的 legacy 值，1 ~ 10）。不再参与限流，老脚本还在读它 |
| `ugcRight` | 默认可见范围，**回落后的生效值**（只可能是 `1` / `4` / `64`；与发布时调用的 `pickUgcRight` 是同一个函数，不是 `config.json` 里的原始字段） |

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
- 所以出厂 `windowHours: 24` + `windowCap: 2`（24 小时最多 2 条）是**故意保守**的，
  不建议为了「多发几条」把它调大；控制台可以直接改这两个数（热更新，不用重启）；
- 内容里带链接、手机号、二维码、拉人话术，是风控和审计共同的重点，审计会先挡一层；
- 被拒时不要反复重试：业务性拒绝重试还是同一个结果，只是给平台多留一条可疑记录。

## 已知限制

- **读列表只读本机记录**：`qq_qzone_recent` 读的是 `state/qzone-posts.json`，不解析空间 HTML、
  不维持登录态、不回读线上列表。线上被删、被平台清理、或在手机上手动发的说说，这里**看不到**；
  反过来，本机记录里的条目可能已经在线上被删了。工具描述里也明写了这一点。
- **只审文字**：审计只看 `content`。`send_qzone_msg` 支持 `images`，v1 不传，也就不审图片。
- **`ugcRight` 的平台语义未真机验证**：三个值按 SnowLuma/OneBot 的通用约定实现，没有拿真号逐档验证过。
- **自然日只在 `windowHours: 0` 时才是口径**：默认的滑动窗口不认日界，只认「最近 N 小时」；
  设成 `windowHours: 0` 时依赖 UTC+8，换时区的部署会算错「今天」。
- **长度按 UTF-16 码元**：`maxChars: 300` 对 emoji 来说实际约 150 个。
- **本机记录按窗口上限保留**：`prunePosts` 每次写入会裁到 `max(50, windowCap + 20)` 条 ——
  留够窗口边缘，`windowCap` 调大之后计数不会被裁剪封顶（`windowCap: 0` 时仍是 50 条）。
- **窗口计数只看本机记录**：`windowCount` 数的是 `state/qzone-posts.json`，手工删掉记录、
  或在手机上手动发的说说都不计入，等于给配额开了个后门。

## 相关文件

- `src/qzone-post.js` —— 纯逻辑层（配置归一 / 审计 / 滑动窗口配额 / 可见范围 / 裁剪）
- `src/bridge.js` —— 四端点 `POST /api/qzone/post`、`POST /api/qzone/delete`、`GET /api/qzone/recent`、
  `POST /api/qzone/config`（控制台开关与参数，部分更新、落盘到 `config.json`）
- `src/mcp-snowluma-safe.js` —— 三个 `qq_qzone_*` 工具
- `scripts/test-qzone-post.mjs` / `scripts/test-qzone-endpoints.mjs` —— 纯逻辑单测与接线契约
- `state/qzone-posts.json` —— 本机发布记录（运行时生成，不入库）
- [RULES.md](../../RULES.md) ——「QQ 会话 agent 的硬边界」里的红线
