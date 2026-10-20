# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：每个版本一节，
`## [版本] - 日期`，节内按 `新增 / 变更 / 修复 / 迁移` 分组。

## [Unreleased]

### 新增

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

### 迁移

- **老配置自动迁移**：`config.json` 里没有 `windowCap`、但有 `dailyCap` 时，`windowCap ← dailyCap`
  （夹到 0~100）、`windowHours ← 24`，启动日志打一条 `[qzone] 老配置迁移：...`。原来的
  「一天 N 条」等价变成「24 小时内 N 条」，不用手改；迁移只在内存里做，旧键不删。
- 两个键同时存在时以 `windowCap` 为准（不再迁移）。
