# 日记本（qq_diary_*）

AI 自己的日记：**每个聊天一个文件夹，一天一个 `.md` 文件**，只写给自己看，不会发到 QQ。
和「轻量记忆」（`qq_memory_*`）分工不同——

| | 轻量记忆 | 日记 |
| --- | --- | --- |
| 存哪 | `state/social-v2.json` | `state/diaries/<会话>/<日期>.md` |
| 长度 | 一两句，有上限 | 100~300 字（最多 4000 字） |
| 生命周期 | 会过期、会被主动删 | 按天归档，永久保留 |
| 什么时候读 | 每次唤醒自动出现在提示里 | 只有 AI 主动 `qq_diary_read` 才读 |

## 目录形状

```
state/diaries/
  group_123456789/
    2026-10-20.md
    2026-10-19.md
  private_987654321/
    2026-10-20.md
```

- 文件夹名由会话 key 派生：`group:123456789` → `group_123456789`，`private:987654321` → `private_987654321`。
- 文件名就是日期（本地时区 `YYYY-MM-DD`）。同一天写多则时，追加到同一个文件里，按时间分节。
- `state/` 已被 `.gitignore` 忽略，日记不会进版本库。

一份文件长这样：

```markdown
# 2026-10-20

## 22:31 · 不服
（心情：有点烦 ｜ 标签：群聊、被说AI味）

今天有人说我像客服，我不服。但她是笑着说的，就算了。

## 23:02 · 第二则
（心情：平静）
……
```

## 三个工具（`mcp__snowluma__`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `qq_diary_write` | 写一则（默认追加；`mode="replace"` 整篇重写当天） | `key` / `token` / `content`；可选 `date`（只能今天或过去）/ `title` / `mood` / `tags` |
| `qq_diary_list` | 翻目录：最近几天、每天几则、摘要、字数 | `key` / `token`；可选 `limit`（默认 7，最大 30） |
| `qq_diary_read` | 读某天全文（默认今天），超长截断并标 `truncated` | `key` / `token`；可选 `date` / `maxChars` |

三者与其它 v2 工具同一套关卡：**会话令牌必须匹配该会话**（`agentTokenOk`）、目标必须在当前模式允许范围内
（`v2SessionAllowed`）、工具开关打开（`socialV2.tools.diary`）。这三个端点也都在「带 agent token 的路径白名单」里，
不会因为新增端点而放宽别的面。

## 写入侧的硬限制

- **key 只接受 `group:<数字>` / `private:<数字>`**，目录名派生后再 resolve 校验必须仍在 `state/diaries/` 内 ——
  模型能左右 key 的值，所以这里按不可信输入处理（防 `../` 穿越）。
- **正文净化**：统一换行、去控制字符、压掉过长空行；本机绝对路径（`C:\…`、`/home/…`）与
  `token=…` / `password: …` 这类凭据形态会被替换成「（已隐去）」。日记也不留这些。
- **长度与频率**：单则 ≤ 4000 字（提示词要求 100~300 字）、标题 ≤ 60、心情 ≤ 20、标签 ≤ 8 个；
  同一天最多 20 则（防刷屏）。
- **不能写未来**：`date` 只能是今天或过去。
- 写入先落 `.tmp` 再 `rename`，并发写不会互相截断。

## 开关

控制台「二代仿真 → 工具开关」里有 **`qq_diary_write / qq_diary_list / qq_diary_read`** 一项
（`socialV2.tools.diary`，出厂 `true`）。关掉后三个工具**根本不注册**（不占上下文、也不会被误调），
重启 DSH 后生效。

## 什么时候写、怎么写

规范写在二代仿真提示词的【日记】一节（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的 `persona.prefix`）：

- 只在这次聊天里**真有事发生、有想记住的感受**时写（被逗笑、被戳到、聊到在意的话题、某个人说的话）；
- 100~300 字，第一人称，写给自己看，**不写群聊总结、不写流水账、不替别人代言**；
- 一天最多三四则，没什么可写就不写；写之前先 `qq_diary_list` 看最近几天，避免重复；
- 遇到「你还记得…」、聊到旧事时用 `qq_diary_read` 翻；
- 不写群友真实隐私（真名/电话/住址/账号）、不写本机路径与密钥；日记不主动提，也不发到 QQ。

## 生效方式

- **桥接**（三个端点）改完需重启桥接：`start.bat` 的守护循环会在进程退出后 5 秒自动拉起，
  也可以在控制台点「重启」，或 `POST /api/restart`。
- **MCP 工具**：`mcp-snowluma-safe.js` 是按会话 spawn 的，**新会话**才会拿到新工具清单；
  已经在跑的 QQ 会话需要重建——控制台里对某个会话执行重置（`POST /api/session/reset`），
  或等它重建。重建只清该会话的上下文，日记与轻量记忆都还在磁盘上。
- **提示词**：改 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 后跑
  `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch；同样对**新会话**生效。

## 自检

```bash
node scripts/test-diary.mjs          # 38~40 条断言：路径穿越/日期/净化/上限/会话隔离/接线
npm run test:audit                   # 既有安全审计（本片不改变它的结论）
```

## 未取得

- 没有给日记做控制台浏览页（现在只能看文件或让 AI 读）；要做得先决定「管理端能否读 AI 的日记」这个隐私口径。
- 没有跨会话的日记总览（每个聊天独立，故意如此）。
- 没有导出/备份入口；`state/` 的备份策略见 [SECURITY_BASELINE.md](SECURITY_BASELINE.md)。
