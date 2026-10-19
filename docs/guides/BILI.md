# B站「看视频」（只读）

QQ 侧的 agent 可以真的去看一个 B站视频——不是凭记忆编，而是拿到标题、简介、时长、播放/点赞/收藏数据，
有字幕就把字幕读进来，需要时再看热门评论、相关推荐和 B站自己的 AI 总结。

实现是独立的 MCP server：`src/mcp-bili-safe.js`（命名空间 `mcp__bili-safe__`）。它本身不抓网页，
底层调用的是本机已装好的 `bili-cli`——也就是 agent-reach 的 B站渠道用的那套。

## 为什么不用 agent-reach skill

agent-reach 是一个 **DSH skill**，它的用法是让 agent 通过 shell 调 `opencli` / `yt-dlp` / `bili` 这些命令行。
而 QQ 会话的 preset 刻意**不给 agent 命令执行能力**（见 [RULES.md](../RULES.md) 的「QQ 会话 agent 的硬边界」），
所以把 skill 挂上去也用不了。这里改成把同一个 CLI 包成三个只读 MCP 工具，能力等价、攻击面更小。

## 工具

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `bili_search` | 任何人 | 搜视频：BV 号、标题、UP 主、播放量、时长 |
| `bili_video` | 任何人 | 看一个视频：标题、UP 主、时长、播放/点赞/投币/收藏/分享/弹幕、简介；默认连带字幕正文，可选评论/相关推荐/B站 AI 总结 |
| `bili_hot` | 任何人 | 当前热门视频 |

`bili_video` 的 `target` 只接受 **BV 号**（`BV` + 10 位）或 `bilibili.com` / `b23.tv` 链接，其它一律拒绝。

## 配置

```json
"bili": {
  "enabled": true,
  "bin": "",
  "timeoutMs": 60000,
  "maxSubtitleChars": 6000,
  "maxComments": 10,
  "useOpencli": true,
  "opencliBin": ""
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后三个工具直接报错。**随包发布的 `config.example.json` 里是 `false`**（出厂不启用），要用先改成 `true` |
| `bin` | 空 = 自动找 | `bili` 可执行文件路径；空则找 `%USERPROFILE%\.local\bin\bili.exe` |
| `timeoutMs` | 60000 | 单次调用超时，超时 kill 子进程 |
| `maxSubtitleChars` | 6000 | 字幕正文最多返回多少字，超出截断并标 `truncated` |
| `maxComments` | 10 | 评论最多返回几条 |
| `useOpencli` | `true` | bili-cli 拿不到字幕时，是否退回 opencli 取字幕 |
| `opencliBin` | 空 = 自动找 | `opencli` 路径；空则找 `%APPDATA%\npm\opencli.cmd` |

## 字幕从哪来

字幕是两段式：

1. 先让 `bili video -s` 取——它是**免登录**的，但只对视频本身带 CC 字幕的有效；多数视频会返回 `available=false`。
2. 拿不到时退回 **opencli** 的 `bilibili subtitle <bvid> -f json`——它借用浏览器里**已登录的 B站 会话**，
   能拿到 B站 的 `ai-zh` AI 字幕（画面描述，等于把视频讲了什么讲出来）。

返回值里 `subtitle.source` 会写明来源：`bili`（CC 字幕）或 `opencli:ai-zh`（AI 字幕）。两边都没有时
`available=false`，agent 只能看标题/简介/评论——这时必须如实说「这个视频没有字幕」。

opencli 依赖 Chrome 里的 B站 登录会话，浏览器桥没起来时会静默降级（只是一次空结果，不会报错）。


## 安装 bili-cli

```powershell
uv tool install bilibili-cli   # 得到 bili 命令，默认落在 %USERPROFILE%\.local\bin\
bili status                    # 看登录状态（搜索/视频详情不需要登录）
```

不需要登录也能搜视频、看详情。**字幕**取决于视频本身有没有 CC 字幕：没有就返回 `subtitle.available=false`，
这时 agent 只能看标题和简介——要求它如实说「这个视频没有字幕」，不许编内容。

## 安全边界

- **只读**：代码里只拼接 `search` / `video` / `hot` 三个子命令；`login`、`like`、`coin`、`triple`、`dynamic-post` 等写操作根本没有出口。
- **不走 shell**：`spawn(bin, argv)` 直接传数组，关键词和 BV 号不会被拼进命令行。
- **参数校验**：BV 号正则、URL 域名白名单、关键词 ≤60 字符且不含换行。
- **输出限量**：字幕 6000 字符、评论 10 条、stdout 上限 8MB，超时 60s——防止一个视频把上下文撑爆（文件功能刚因为整本读小说把会话卡死过一次）。
- **Windows 编码**：bili-cli 是 Python 程序，控制台默认 GBK 时打印 emoji 会崩，子进程强制 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`、`PYTHONWARNINGS=ignore`。

## 自检

```powershell
node src/mcp-bili-safe.js --check   # 打印解析到的 bili 路径 + 一次真实搜索
node scripts/test-bili-safe.mjs     # 6 项：工具清单/搜索/详情/非法参数/热门/字幕字段
```
