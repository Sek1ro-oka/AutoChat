# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：每个版本一节，
`## [版本] - 日期`，节内按 `新增 / 变更 / 修复 / 迁移` 分组。

## [Unreleased]

### 新增

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
