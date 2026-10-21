# 安卓平板：让 agent 自己看图、自己动手（可选）

QQ 侧的 agent 可以通过 USB 连着的一台安卓平板「玩」——看屏幕、点、滑、打英文、按返回键、开应用。
典型用途是 galgame 推进、刷 B 站这类**纯消费**操作。

这个能力和「发消息」不是一回事：它动的是**另一台设备**，一次误点就可能点掉钱、点掉登录态。
所以它叠了两道硬闸门（预算 + 黑名单），并且**只在本地 adb 上跑**，没有任何联网入口。

实现分两层：

- `src/device-core.js`：**纯逻辑**（配置归一 / 预算 / 黑名单判定 / 坐标夹取 / 动作分类 /
  `adb devices`、`dumpsys window`、`pm list packages` 的输出解析 / `%NAME%` 路径展开）。
  零 I/O，时钟由调用方传入，所以每条规则都能被单测钉住。
- `src/device-tools.js`：八个 MCP 工具 + adb 调用 + 账本落盘，注册进**现有的** `snowluma`
  server（不新开进程，避免新增 MCP server 需要重启 DSH）。

## 前置条件

1. 装 platform-tools，拿到 `adb.exe`。默认按 `%LOCALAPPDATA%\Android\platform-tools\adb.exe`
   找（Android Studio 的默认安装位置），装在别处就在 `device.adbPath` 里写绝对路径。
   路径支持 `%NAME%` 占位，执行前展开。
2. 平板开「开发者选项 → USB 调试」（有「USB 调试（安全设置）」一起开）。
3. 插线，平板弹「允许 USB 调试吗」→ 勾「一律允许」→ 允许。
4. 验证：

   ```powershell
   adb devices -l
   # 期望：HA2BETT7  device product:... model:... device:...
   ```

   **只有一台「device」才算通**。出现 `unauthorized` 是没点授权弹窗；什么都不出现见「排障」。

## 工具

| 工具 | 说明 | 计步 |
| --- | --- | --- |
| `device_status` | 连没连上、型号/序列号、电量、屏幕尺寸（以最近一次截图为准）、今日已用/剩余额度、当前前台、暂停原因 | 否 |
| `device_screenshot` | 截一张图并**直接把 PNG 返回给模型**（看屏幕的唯一入口） | 否 |
| `device_list_apps` | 列第三方应用包名 + 是否在黑名单（`filter` 子串过滤，最多 80 条） | 否 |
| `device_tap` | 点一下（坐标是截图里的像素，越界自动夹回屏幕内） | 是 |
| `device_swipe` | 滑一下（`durationMs` 100–2000，默认 300） | 是 |
| `device_type` | 往焦点输入框打 **ASCII** 文本（≤200 字，空格转 `%s`） | 是 |
| `device_key` | `back` / `home` | 是 |
| `device_open_app` | 按包名启动应用（过白名单与黑名单） | 是 |

推荐的节奏：`status` → `screenshot` → 动一下 → 再 `screenshot`。截图不计步，所以「看」永远不心疼；
额度只花在「动」上。坐标一律按**最近一次截图**的宽高来给（截图宽高就是当前输入坐标空间，
见「已知限制」里的横屏说明）。

## 两道闸门

### ① 预算（`deviceBudget`，按自然日重置）

- 每天 **30 分钟 / 60 步**（`maxMinutesPerDay` / `maxStepsPerDay`），午夜清零。
- 两步之间至少 **1 秒**（`minGapMs`），太快就是在瞎点。
- 一轮玩完由桥接落一次 `pausedUntil = now + 1 小时`（`pauseAfterRunMs`），冷却期内 `device_status`
  会告诉你还要等多久。
- 判定顺序是**固定**的：`disabled` → `paused` → 日额度 → 步数 → 间隔冷却 → `ok`。
  暂停压在日额度**前面**是有意为之：否则用户会以为「明天就能好」，实际还被人按着。

### ② 黑名单 + 前台检测（每次动手前都查）

- 内核五项写死在代码里：支付宝 / 微信 / QQ / Play 商店 / 系统设置。
  `device.blockedApps` 只能**追加**，删不掉内核项。
- 五个动手工具（tap / swipe / type / key / open_app）**执行前**先跑
  `dumpsys window | grep mCurrentFocus`，解析出前台包名：

  | 情况 | 结果 |
  | --- | --- |
  | 前台是黑名单应用 | 拒绝（`blocked_foreground`），写日志，**不记步** |
  | 前台读不出来 | **放行**，但动作日志记 `foreground:"unknown"` / `foregroundKnown:false` |
  | 前台是别的应用 | 正常执行 |

- **唯一例外：`device_key home`**。前台停在微信/支付宝时，`home` 仍然放行——只回桌面，
  不碰那个应用里的任何内容。这是给「有人找 bot、得赶紧让位」留的逃生口。
  `back` **不放行**：它是应用内导航，可能真的点掉东西。
- `device_open_app` 另有一道：包名在黑名单里一律拒（`blocked_app`），即使被写进白名单也一样。
- 内容侧：`device_type` 碰到敏感词（密码 / 支付 / 转账 / 验证码 / 登录 / 购买 / 删除 / 安装 …）
  直接拒（`risky`），不记账。

## 配置

```json
"device": {
  "enabled": true,
  "adbPath": "%LOCALAPPDATA%\\Android\\platform-tools\\adb.exe",
  "maxMinutesPerDay": 30,
  "maxStepsPerDay": 60,
  "minGapMs": 1000,
  "pauseAfterRunMs": 3600000,
  "apps": [],
  "blockedApps": ["com.eg.android.AlipayGphone", "com.tencent.mm", "com.tencent.mobileqq", "com.android.vending", "com.android.settings"]
}
```

- `enabled: false` 时整个 prompt 的 `device` 块短路成 `{enabled:false}`，八个工具一起从
  「可用工具」里消失（模型不会去调它看不见的工具）。
- `apps` 是**白名单**，空数组表示不限制包名；非空时 `device_open_app` 只放行名单里的包。
  黑名单优先——两份名单打架以黑名单为准。
- 改 `blockedApps` 只会**追加**，想删掉内核五项是不可能的（这是设计，不是 bug）。

## 落盘

| 路径 | 内容 |
| --- | --- |
| `state/device-state.json` | 当天已用分钟/步数、上次动作时间、暂停截止时间、手动暂停原因 |
| `state/device-actions.jsonl` | 每步一行：时间、动作、坐标/按键/包名、结果、`foreground` |
| `state/device/` | 截图 PNG |

三个都在 `.gitignore` 里，不会进仓库。

## 真机冒烟

```powershell
npm run smoke:device
# 或换独立账本，不占正式额度：
node scripts/smoke-device.mjs --state-dir state/device-smoke
```

顺序是 `status → list_apps → screenshot → tap → swipe → key(back) → open_app`，
**前一步失败就停**（后面都建立在它成立的前提下），失败以非 0 退出并打印中文原因。
`tap` / `swipe` / `key` / `open_app` 会**真的动一下平板**。

## 排障

| 现象 | 原因 / 怎么办 |
| --- | --- |
| `device_status` 返回 `no_device` | 线 / 口 / 授权三件事。先 `adb devices -l`：空 → 平板侧 USB 调试没生效；`unauthorized` → 平板没点「允许」 |
| `找不到 adb：...` | `device.adbPath` 指错了。默认值是 `%LOCALAPPDATA%\Android\platform-tools\adb.exe` |
| Windows 能看见平板，但 `adb devices` 永远空 | 常见！见下一条 |
| 设备管理器里只有 `WPD / 联想小新Pad Pro 12.7`，驱动 `WUDFWpdMtp` | 平板只以 **MTP（文件传输）** 身份出现，**没有 ADB 接口**。正常的调试状态是复合设备，除了 WPD 还会多出一个 `MI_01`。这不是线/口/驱动的问题，是平板侧开关没生效：关掉再打开「USB 调试」，或改 USB 用途为「文件传输/MIDI」后再试 |
| 动作全被拒、理由是「前台是 xx」 | 说明平板现在停在黑名单应用上。用 `device_key home` 回桌面，或手动退到桌面 |
| 日志里出现 `foreground:"unknown"` | 这台 ROM 的 `dumpsys window` 没有 `mCurrentFocus`（可能锁屏或厂商改了字段）。功能放行，但你可以顺手补个解析规则 |
| 有两台设备 | 只认第一台 `device` 状态的；同时连多台请先拔掉多余的 |

## 已知限制

- **坐标以最近一次截图的宽高为准**：`wm size` 报的是物理面板（联想小新 Pad Pro 竖持时
  `1840x2944`），横屏应用的实际显示与输入空间却是旋转后的 `2944x1840`。实现会记住最近一次
  截图的尺寸并用它夹坐标（还没截过图才退回 `wm size`），所以**旋转屏幕后先截一张图再点击/滑动**，
  否则会沿用上一张的坐标系。
- **不支持中文输入**：`adb shell input text` 只吃 ASCII。要输入中文只能改成点击选词。
- **不做定时自动去玩**：这一版只提供「工具」，什么时候玩由模型当轮决定；定时器与玩后写日记留到下一步。
- **多设备 / root / iOS / 鸿蒙 NEXT / 联机游戏挂机 / 云手机模拟器**都不在范围内。
- 游戏用 Unity/UE 直渲染时，`screencap` 偶尔抓到黑屏或纯色——这是系统截屏的限制，不是本功能的 bug。
- **从后台返回的 Ren'Py 类 galgame 会「假死」**：真机验收时遇到，切到别的应用再回来，画面停在旧帧、
  点击只让按钮变高亮却不触发，`input tap` / 长按 / 连点 / `KEYCODE_DPAD_CENTER` 全部无效。
  用 `am force-stop <包名>` 冷启动后点击立刻恢复正常。这不是本功能的 bug（`device_open_app` 只做
  `am start`，会把已有实例拉到前台）；遇到点不动就先回桌面重开应用。
