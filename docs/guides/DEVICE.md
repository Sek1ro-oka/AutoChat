# 安卓平板：让 agent 自己看图、自己动手（可选）

QQ 侧的 agent 可以通过 USB 连着的一台安卓平板「玩」——看屏幕、点、滑、打英文、按返回键、开应用。
典型用途是 galgame 推进、刷 B 站这类**纯消费**操作。

这个能力和「发消息」不是一回事：它动的是**另一台设备**，一次误点就可能点掉钱、点掉登录态。
所以它叠了三道硬闸门（**授权** + 预算 + 黑名单），并且**只在本地 adb 上跑**，没有任何联网入口。

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
| `device_status` | 连没连上、型号/序列号、电量、屏幕尺寸（以最近一次截图为准）、今日已用/剩余额度、当前前台、暂停原因、**有没有授权**（`granted` / `canPlay`）；没授权时唯一还能调的工具 | 否 |
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

## 三道闸门

### ① 授权：管理员说了才能玩（T-024）

**没有有效授权时，除 `device_status` 之外的工具一律返回 `not_granted`** —— 不碰 adb、不记步；
prompt 的 `device.tools` 是空数组，`enabledTools` 里也没有 `device_*`。授权与预算是**并列**的两道闸门，
同时生效：有授权但额度用完照样拒，额度够但没授权一样拒。

**谁能授权**：`ownerQQ` ∪ `qzone.adminQQ` ∪ `file.adminQQ`（三份名单并起来、按 QQ 号去重）。
群友、群管理说同样的话什么都不发生。`qzone.adminQQ` / `file.adminQQ` 改完要重启桥接才生效
（`ownerQQ` 在控制台改是热更新的）。

**触发词**（桥接侧整句解析，不依赖模型自觉）：

| 意图 | 说法 | 效果 |
| --- | --- | --- |
| 授权 | 「去玩平板」「玩会儿平板」「去玩会儿平板」「玩平板」，可带「20 分钟」「25 min」（钳到 5–120 分钟） | 写 `state/device-grant.json`，缺省 30 分钟 / 60 步 |
| 撤销 | 「别玩了」「不玩了」「回来」「停下」「先别玩」（同义短句如「别玩平板了」「停一下」也算） | 立刻写 `revokedAt`，之后的调用全被拒（从来没有授权记录时只记日志，不造一份空撤销） |

口令必须是**短句**（授权 ≤32 字、撤销 ≤14 字），一句话里不能掺别的诉求 ——
「我回来啦」「刚刚玩了会儿平板」「别玩了，回来吧」都**不算**。授权那句话本身仍会交给模型
（它得知道自己被允许去玩了）；桥接只负责把「允许」落盘并留痕，不替你回话。
生效时机是**下一条消息**：prompt 是每条消息现拉的，没有定时器、也不会主动叫醒模型。

**时长**：默认 30 分钟 / 60 步；句子里写了分钟数就用它（5–120 分钟）。
到期自动失效（读的时候判 `expiresAt > now`），不依赖定时器。一次授权 = 一轮；
玩完或撤销之后要再玩，得让管理员重新说一句。

**日记落点**：授权期内 prompt 会给 `device.diaryKey`，值是
`diaryKeyFor('private:<授权人 QQ>')` —— 管理员在互通组里就是 `cross:<gid>`
（**同组群友也能看到**，这是用户确认过的口径），没有分组时是 `private:<QQ>`。
模型玩完用 `qq_diary_write` 时把 `key` 填成它即可，不需要新工具。

### ② 预算（`deviceBudget`，按自然日重置）

- 每天 **30 分钟 / 60 步**（`maxMinutesPerDay` / `maxStepsPerDay`），午夜清零。
- 两步之间至少 **1 秒**（`minGapMs`），太快就是在瞎点。
- 一轮玩完由桥接落一次 `pausedUntil = now + 1 小时`（`pauseAfterRunMs`），冷却期内 `device_status`
  会告诉你还要等多久。
- 判定顺序是**固定**的：`disabled` → `paused` → 日额度 → 步数 → 间隔冷却 → `ok`。
  暂停压在日额度**前面**是有意为之：否则用户会以为「明天就能好」，实际还被人按着。
- 工具层的闸门顺序是 `disabled` → **`not_granted`** → 预算：没授权时连额度都不提，
  免得模型以为「等额度回来就能玩」。

### ③ 黑名单 + 前台检测（每次动手前都查）

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
- **授权没有配置项**：它只认管理员的 QQ 消息（见「① 授权」）。`enabled:false` 仍然一票否决：
  功能关着时连授权都不看，直接 `disabled`。
- `apps` 是**白名单**，空数组表示不限制包名；非空时 `device_open_app` 只放行名单里的包。
  黑名单优先——两份名单打架以黑名单为准。
- 改 `blockedApps` 只会**追加**，想删掉内核五项是不可能的（这是设计，不是 bug）。

## 落盘

| 路径 | 内容 |
| --- | --- |
| `state/device-grant.json` | 平板授权：谁授权（`grantedBy`）、在哪个会话（`viaKey`）、起止时间、本轮分钟/步数、撤销时间（`revokedAt`） |
| `state/device-state.json` | 当天已用分钟/步数、上次动作时间、暂停截止时间、手动暂停原因 |
| `state/device-actions.jsonl` | 每步一行：时间、动作、坐标/按键/包名、结果、`foreground` |
| `state/device-window.json` | 前台窗口快照（`package` + 矩形 `left/top/right/bottom/width/height` + `fullscreen`）：工具层每次读 `dumpsys window windows` 时覆盖写，桥接只读着往 prompt 里补「窗口在哪」 |
| `state/device/` | 截图 PNG |

五份都在 `.gitignore` 里，不会进仓库。`device-grant.json` 由桥接写（管理员说「去玩平板」/「别玩了」时），
工具层只读；**手删它 = 立刻失去授权**，这是有意的复位手段。`device-window.json` 反过来：
工具层写、桥接只读，删掉只会让 prompt 少一句「只在窗口里点」，不影响动作。

## 真机冒烟

```powershell
npm run smoke:device
# 或换独立账本，不占正式额度：
node scripts/smoke-device.mjs --state-dir state/device-smoke
# 没有管理员授权时，冒烟会停在第一步（granted:false）。临时放行 10 分钟：
node scripts/smoke-device.mjs --grant
```

顺序是 `status → list_apps → screenshot → tap → swipe → key(back) → open_app`，
**前一步失败就停**（后面都建立在它成立的前提下），失败以非 0 退出并打印中文原因。
`tap` / `swipe` / `key` / `open_app` 会**真的动一下平板**。
`--grant` 会在**当前 state 目录**写一份 10 分钟的 `device-grant.json`（等于管理员说了句
「去玩平板 10 分钟」）；不传 `--state-dir` 时会覆盖正式授权，跑完记得让管理员重新说一句。

## 排障

| 现象 | 原因 / 怎么办 |
| --- | --- |
| 工具返回 `not_granted` | 没有有效授权：让管理员在 QQ 里说「去玩平板」（或「去玩平板 20 分钟」）。它是独立于预算的闸门，额度再多也过不去 |
| 管理员说了「去玩平板」，`device_status` 里 `granted` 还是 false | ① 看 `state/device-grant.json` 有没有写进去（写失败桥接日志里有 `[device] 写授权文件失败`）；② 群聊里这条消息有没有唤醒模型（私聊总唤醒；群聊要 @ / 关键词 / `anyMessage`，没唤醒就不会重拉 prompt）；③ `qzone.adminQQ` / `file.adminQQ` 刚改过要重启桥接 |
| 管理员说「我回来啦」但授权没撤 | 这是**有意**的：「回来」只有单独成句才算撤销口令，陈述句不算 |
| `device_status` 返回 `no_device` | 线 / 口 / 授权三件事。先 `adb devices -l`：空 → 平板侧 USB 调试没生效；`unauthorized` → 平板没点「允许」 |
| `找不到 adb：...` | `device.adbPath` 指错了。默认值是 `%LOCALAPPDATA%\Android\platform-tools\adb.exe` |
| Windows 能看见平板，但 `adb devices` 永远空 | 常见！见下一条 |
| 设备管理器里只有 `WPD / 联想小新Pad Pro 12.7`，驱动 `WUDFWpdMtp` | 平板只以 **MTP（文件传输）** 身份出现，**没有 ADB 接口**。正常的调试状态是复合设备，除了 WPD 还会多出一个 `MI_01`。这不是线/口/驱动的问题，是平板侧开关没生效：关掉再打开「USB 调试」，或改 USB 用途为「文件传输/MIDI」后再试 |
| 动作全被拒、理由是「前台是 xx」 | 说明平板现在停在黑名单应用上。用 `device_key home` 回桌面，或手动退到桌面 |
| 动作返回 `outside_window` | 这个应用是**窗口模式（PC 模式浮窗）**，不是全屏：坐标落在它的窗口矩形外面，点下去会落到桌面层、什么都不会发生。看 `device_status` 的 `foregroundWindow`（`fullscreen:false` 时带 `left/top/right/bottom`），只在这个矩形里给坐标 |
| 动作返回 `gesture_zone` | 坐标落在屏幕最底部的手势导航区（高度 `min(80, 屏幕高×6%)`，2944x1840 上就是最下面 80px）。这一条是系统手势区，点/滑会触发导航、把应用切走；**全屏应用同样会拒**。按文案里给的安全 y 往上挪再点 |
| 日志里出现 `foreground:"unknown"` | 这台 ROM 的 `dumpsys window` 没有 `mCurrentFocus`（可能锁屏或厂商改了字段）。功能放行，但你可以顺手补个解析规则 |
| 有两台设备 | 只认第一台 `device` 状态的；同时连多台请先拔掉多余的 |

## 已知限制

- **坐标以最近一次截图的宽高为准**：`wm size` 报的是物理面板（联想小新 Pad Pro 竖持时
  `1840x2944`），横屏应用的实际显示与输入空间却是旋转后的 `2944x1840`。实现会记住最近一次
  截图的尺寸并用它夹坐标（还没截过图才退回 `wm size`），所以**旋转屏幕后先截一张图再点击/滑动**，
  否则会沿用上一张的坐标系。
- **PC 模式浮窗只在窗口里点**：小黑盒这类应用在 ZUI PC 模式下是**浮窗**（真机 TB375FC 实测
  `frame=[737,0]-[2208,1840]`，1471x1840），而截图是整屏 2944x1840 —— 模型照截图给坐标，
  点在窗口外会落到桌面层（毫无反应），点在底部 1604–1840 会触发手势导航把 App 切走。
  现在 `device_tap` / `device_swipe` 会读前台窗口矩形：**端点落在窗口外 → `outside_window`、
  落在最底部手势区 → `gesture_zone`**，两者都不下发、不记步、只留痕；`device_status` 的
  `foregroundWindow` 给出矩形与 `fullscreen`，prompt 的 `device` 块在窗口模式下也会补一句
  「窗口在 (l,t)-(r,b)，只在窗口里点」。窗口矩形缓存 2 秒（切 App 立刻按新窗口判）。
- **底部手势区对全屏应用也拦**：`outside_window` 只对窗口模式有意义（全屏没有窗口外），
  但屏幕最底下那一条（`min(80, 屏幕高×6%)`）是系统手势导航区，**全屏应用点底边同样会把
  App 切走**（真机验收时就是点在一个应用底边把另一个应用切走的），所以这条对所有应用都判，
  被拒时把 y 往上挪一点即可；代价是全屏应用底部 80px 内的按钮点不到。
  读不到窗口信息 / 屏幕尺寸时一律放行（fail-open）。
- **不支持中文输入**：`adb shell input text` 只吃 ASCII。要输入中文只能改成点击选词。
- **不做定时自动去玩**：没有 boredom / 定时器。什么时候玩由「管理员说一句 + 模型当轮决定」——
  授权口令只会落一份 `state/device-grant.json`，然后那句话照常唤醒模型；**群聊里如果唤醒条件
  不满足（没 @、没关键词、`anyMessage` 关着），模型不会被叫起来**（私聊总是唤醒）。
  玩完写日记也是模型自己调 `qq_diary_write`，桥接只给 key。
- **多设备 / root / iOS / 鸿蒙 NEXT / 联机游戏挂机 / 云手机模拟器**都不在范围内。
- 游戏用 Unity/UE 直渲染时，`screencap` 偶尔抓到黑屏或纯色——这是系统截屏的限制，不是本功能的 bug。
- **Ren'Py 封装的 galgame 对 `input tap` 兼容不好**（真机验收实测《永恒世界》`com.caribdis.eternum`）：
  `am force-stop` 冷启动后的**第一次**点击能生效（标题页 → 18+ 内容提示页，有截图证据），之后
  再点同一位置就只切换按钮悬停高亮、不触发，`input tap` / 长按 / 连点 / `KEYCODE_DPAD_CENTER` 都一样；
  切到别的应用再回来画面还会停在旧帧。这不是本功能的 bug（同一时刻 B 站上的点击/滑动完全正常），
  而是这类 SDL2 + 触摸映射的移植游戏对合成触摸事件的处理问题。要玩这类游戏，建议让人先手动进到
  正文，再由 AI 接手推进；或者单独为它做一套 `sendevent` 级触摸注入（本轮未做）。
