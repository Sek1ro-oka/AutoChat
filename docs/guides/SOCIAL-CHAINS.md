# 模式与链路边界：谁在哪一档跑、状态存在哪、别把两条链混在一起

这份文档回答三个问题：**同一个群/私聊，当前到底由哪套逻辑在驱动？它的状态存在哪个文件？改配置时哪几条开关在这个模式下根本不生效？**

写它的原因很直接：桥接里同时活着**两代社交引擎**（一代 `social`、二代 `socialV2`）、**两种 agent 预设**（`qq-chat` / `qq-chat-v2`）、**一条独立的学习链**（黑话学习会话）。它们在代码里是并列的、名字只差一个 `V2`，日志里的「主动机会检查」「唤醒」「潜水」字眼又几乎一样。2026-10-22 / 11-02 两次复盘都出现过同一类误判：拿二代的现象去改一代的开关（或反过来），改完看不到任何变化；或者把学习链的用量算进社交成本里。

---

## 一、四个模式

`state/mode.json` 里的 `mode` 决定一切；进程内部用历史拼写比较（`currentMode === 'reserved2'` 这类），控制台显示名也沿用同一套词。

| 模式 | 含义 | 谁在驱动这条会话 |
| --- | --- | --- |
| `chat` | 普通聊天模式 | 收到消息 → 组 prompt 投给 DSH → 回话。**没有**主动社交、**没有**潜水/唤醒定时器 |
| `closed-agent` | 关闭对外应答（只在主人私聊里可用） | 群消息一律不理；主人可以通过私聊操作桥接 |
| `reserved` | 一代仿真（角色扮演式潜水） | 一代社交引擎：`cfg.social` + 内存里的 `social.states`（不落盘） |
| `reserved2` | 二代仿真（一切皆工具） | 二代社交引擎：`cfg.socialV2` + `state/social-v2.json` |

判定入口只有一处：`isSocialEnabled()`（一代）——`currentMode === 'reserved' && cfg.social?.enabled !== false`。二代那边不看它，二代的开关是 `cfg.socialV2.enabled` 加一连串模式判定（`sendWakePromptV2()` 开头 `currentMode !== 'reserved2'` 直接 return）。

**边界规则 1：`cfg.social.*` 只在 `reserved` 下生效；`cfg.socialV2.*` 只在 `reserved2` 下生效。** 在 `chat` 模式下调这两组参数都是白调。

---

## 二、三条链路

### 1）被动回复链（四个模式都有，`closed-agent` 除外）

有人说话 → 读未读 → 投给 DSH 的会话 → agent 调工具发回消息。这条链是 `chat` 模式的全部，也是另外两个仿真模式的**底座**：仿真模式只是在这条链上面加了「什么时候该醒」的调度器。

- 预设：`chat` / `reserved` 用 `qq-chat`（一代，回复正文可以直接写在文本输出里）；`reserved2` 用 `qq-chat-v2`（二代，**文本输出只是思考、不会自动发出**，必须调 `mcp__snowluma__qq_send_message`）。
- 预设名映射在 `src/bridge.js` 的 `PRESET_NAMES`：`{ v1: 'qq-chat', v2: 'qq-chat-v2' }`。
- 一代 / 二代工具集不同：二代的工具白名单由 `v2ToolEnabled()` 管（`cfg.socialV2.tools.*`），一代那套是 `tools.*`（`getPrompt`/`getUnread`/`getRecent`/`socialState`/`sendGroup`/`sendPrivate`/`reply`…，见 `src/bridge.js` 里 `toolFlags` 常量那一处）。

**边界规则 2：改工具开关前先确认模式。** 同一件事在两代里名字都不一样（例：二代发表情是 `qq_send_sticker` 要 `stickerId`，一代是「选分类」）。

### 2）主动社交链（v1 与 v2 是两条独立的调度器）

| | 一代（`reserved`） | 二代（`reserved2`） |
| --- | --- | --- |
| 状态存放 | **只在内存**：`social.states`（`Map`，无落盘文件，重启即清空） | `state/social-v2.json`（`SOCIAL_V2_FILE`，`saveSocialV2State()` 显式字段白名单） |
| 状态入口 | `socialState(key)` | `getSocialV2State(key)` |
| 唤醒投递 | 走被动回复链 | `sendWakePromptV2(key, reason)` |
| 提示词 | — | `buildWakePromptV2(key, reason)` |
| 潜水定时器 | — | `setupSleepTimerV2(key)` |
| 主动机会 | 一代自己的检查器（`social.proactive*` 参数） | `scheduleProactiveCheckV2(key)` |

二代这条链上值得记住的几件事：

- **潜水 = 不调用任何发送工具直接结束**。二代没有「保持沉默」的标记语法，也不需要；醒来读一遍、什么都不发就是一次潜水。
- **排队投递**：会话忙的时候唤醒原因进 `st.pendingWakeReasons`（有界 20 条），不丢弃；限频命中时是**延后重试**而不是丢弃（丢掉的后果见 `sendWakePromptV2` 里的注释：会话会停在「没有定时器」的静默态）。
- **沉默唤醒闸**（2026-11-02 新增）：`st.wakesSinceReply` 记录「连续醒来没发消息」的次数，`scheduleProactiveCheckV2` 里对主动开口概率做衰减（默认 3 次起、每次对半、地板 0.15，可用 `cfg.socialV2.proactive.silenceGate*` 微调）。计数在 `sendWakePromptV2` 里 +1，一旦发现「上次唤醒之后有过发送」就清零。它**只调制主动检查的骰子**，不改任何被叫醒的路径。

### 3）学习链（黑话学习）

- 会话 key 固定为 `internal:黑话学习`，**不属于**上面任何一个模式；它由 `cfg.slang.*` 驱动，预设是 `cfg.slang.learnerPreset`（默认 `qq-chat`，用 `resolvePresetName(..., { strict: true })` 校验，未知名字会报错而不是静默回退）。
- 它自己烧 token（历史累计 470 轮 / 8.34M miss），在用量面板里是一条独立会话。**统计社交成本时要把它单列**，别混进「群聊花了多少钱」。

---

## 三、排障对照表（现象 → 该看哪条链）

| 现象 | 大概率是哪条链 | 先看什么 |
| --- | --- | --- |
| 群里完全没人回话 | 被动回复链 | `/api/status` 的 `dshReady`、`state/bridge.log` 里的「会话繁忙」「唤醒投递失败」 |
| 醒了但一个字都没发 | 二代主动链（潜水） | `state/qq-activity.log*` 里该会话的 `silent` 计数、`st.wakesSinceReply` |
| 改了 `social.probability` 没反应 | 模式不是 `reserved` | `state/mode.json` 的 `mode` |
| 改了 `socialV2.wake.*` 没反应 | 模式不是 `reserved2` | 同上 |
| 表情发不出去 | 工具代际 | 二代要 `qq_send_sticker` + `stickerId`；一代是分类 |
| 用量面板里冒出一个陌生会话 | 学习链 | `internal:黑话学习` |

---

## 四、改这块代码时的硬约定

1. **不要给两代共用同一个状态字段名。** `wakesSinceReply` 只属于二代；一代有自己的一套字段。
2. **`sendWakePromptV2` 里所有「提前 return」的分支都必须留下日志。** 复盘反复踩的坑是「静默 return → 会话停在无定时器状态」，`pendingWakeReasons` 那套排队机制就是为此存在的。
3. **新增二代开关要同时考虑 `state/social-v2.json` 的持久化白名单**（`saveSocialV2State()` 是显式字段清单）。字段不写进去，重启就丢——`wakesSinceReply` 就是照这个规矩加的。
4. **模式切换时清理自己那条链的状态**（`isSocialEnabled()` 与 `sendWakePromptV2()` 一带的模式判定 + `clearSocialV2Timers()`），不要把上一档的定时器带进新档。
