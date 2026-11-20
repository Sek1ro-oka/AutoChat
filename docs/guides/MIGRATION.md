# 把 bot 搬到另一台电脑（数据迁移）

> 适用：换机器、重装系统、把 bot 从旧笔记本挪到新台式。
> 一句话原则：**代码从 git 来，数据从迁移包来，凭据各自重配。**
> 相关：`scripts/migrate-export.mjs`（打包）、[DSH_SETUP.md](DSH_SETUP.md)（DSH 端挂载）、`README.md`「完整启动流程」。

## 0. 先搞清楚什么算「数据」

这个 bot 的「人格」不只写在 `roles/` 里，更多在你以为不重要的地方。下表左边任何一样丢了，新机器上的它就不再是同一个它：

| 想保留的东西 | 存在哪 | 丢了会怎样 |
| --- | --- | --- |
| **日记**（`qq_diary_write`） | `state/diaries/<group_群号\|private_QQ号\|cross_互通组>/YYYY-MM-DD.md` | 问「你还记得…」它会说没找到；日记读到空 |
| **跨会话回忆**（`qq_recall`） | `state/cross/*.ndjson` | 只记得当前对话，别的会话说过的话全忘 |
| 群聊/私聊状态、唤醒配置、话题、对群友的印象 | `state/social-v2.json` | 潜水/唤醒规则回到出厂，印象清零 |
| 黑话表 / 梗 | `state/slang.json` | 群里的梗它又听不懂了 |
| 收藏表情及其备注 | `state/stickers.json` | 表情库空白（线上收藏本身还在 QQ 账号上，重新同步即可，但「我对这个表情的理解」没了） |
| QQ 会话 ↔ DSH 会话的映射 | `state/sessions.json` | 每个会话重新建一轮上下文（等于忘掉最近几轮） |
| 心情值 / 触动记录 | `state/affect.json` | 情绪状态归零 |
| 名字映射（群名片、昵称） | `state/identity-map.json` | @ 人、认人变笨 |
| 当前人格 / 模式 | `state/current-role.json`、`state/mode.json` | 换回默认人格 |
| 说说记录（本机流水） | `state/qzone-posts.json` | 本机不再知道发过什么 |
| 语音库（`qq_send_voice` 的资源） | `audio/` | 发语音报「语音库为空」 |
| `files/` 托管目录（长文档、导出的日记） | `files/` | `file_list` / `file_send` 空 |
| 控制台令牌 | `state/console-token` | 控制台要重新配令牌（不致命） |
| **QQ 登录态** | SnowLuma 目录的 `data/` | 新机器要重新扫码登录 |
| 机器相关配置 | `config.json` | 起不来，或者连错端口/账号 |

不搬的东西：`node_modules/`（`npm install` 重装，`postinstall` 会修补 `@snowluma/sdk`）、`.git/`（用 `git clone`）、`work/`（开发临时文件）、`logs/`（只有排障才需要）、`*.pid` / `*.lock` / `*.spawn`（进程残留，搬过去会让新机器误判「已在运行」）。

## 1. 打包（旧机器）

打包前**先停服务**，避免复制到写了一半的文件：

```bat
cd /d <仓库目录>
node scripts\stack-control.mjs stop
```

然后导出：

```bat
:: 只导数据（约 15 MB）
node scripts\migrate-export.mjs --zip

:: 连 SnowLuma 一起（约 140 MB，省掉新机器扫码登录）
node scripts\migrate-export.mjs --with-snowluma --zip

:: 连历史日志一起（排错用，通常不用）
node scripts\migrate-export.mjs --with-logs --zip
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--out <目录>` | 输出位置，默认 `work\migrate\migrate-<时间戳>`（在 `.gitignore` 里，不会误提交） |
| `--with-snowluma` | 按 `config.json` 的 `snowluma.homeDir` 整个目录搬成 `snowluma/` |
| `--with-logs` | 带上 `logs/` 与 `state/*.log`、`*.jsonl` |
| `--zip` | 打完用 `Compress-Archive` 压成 `.zip` |
| `--dry-run` | 只打印清单和体积，不复制 |

包里除了数据，还会生成两个文件：

- **`MANIFEST.json`**：每个文件的 sha256、来源机器/用户/node/git 版本、以及 `config.json` 里**所有盘符开头的值**（换机器时必须人工核对的清单）。
- **`RESTORE.md`**：照着做的还原清单（本文件的精简现场版）。

> ⚠️ 迁移包是**私密文件**：`config.json` 里有 OneBot accessToken、控制台令牌、真实 QQ 号与群号；`state/` 里有聊天内容、日记、对群友的印象。别提交进 git、别传群、别放公开网盘。

## 2. 新机器装环境

1. **Node.js ≥ 22.13**（`node -v` 确认；`package.json` 的 engines 卡这个版本）
2. **DeepSeek Harness（DSH）**：装好并能打开 `http://127.0.0.1:3080`。
   DSH 自己的模型服务商凭据**不随这个包迁移**，要在 DSH 设置里重新配（这是另一套凭据）。
3. **SnowLuma**：
   - 包里带了 `snowluma/` → **不要再装一份**，直接解压到任意目录（例如 `D:\SnowLuma`），它自带 node 运行时。
   - 包里没带 → 去 <https://github.com/SnowLuma/SnowLuma/releases/latest> 下 `SnowLuma-v<版本>-win-x64.zip`，启动一次扫码登录 QQ，并在 WebUI 里确认 WebSocket(3001) 与 HTTP(3000) 开着、记下 accessToken。

## 3. 把代码和数据放好

```bat
git clone -b qq-bridge https://github.com/Sek1ro-oka/AutoChat.git
cd AutoChat
npm install
```

然后解开迁移包，把这些**放到仓库根目录**（覆盖同名文件）：

| 包内 | 目标 |
| --- | --- |
| `config.json` | 仓库根目录 |
| `state/`（含 `diaries/`、`cross/`） | 仓库根目录 |
| `audio/`、`files/`、`roles/` | 仓库根目录 |
| `snowluma/`（如果带了） | 仓库外的任意目录 |

### 3.1 逐项核对 `config.json` 里的绝对路径

`MANIFEST.json` 的 `absolutePaths` 已经把要改的列全了。典型五处（旧机器 → 新机器；下面是举例，以你自己 `MANIFEST.json` 里的值为准）：

| 配置项 | 旧机器的值（示例） | 改成 |
| --- | --- | --- |
| `snowluma.homeDir` | `E:\SnowLuma` | 新机器的 SnowLuma 目录，如 `D:\SnowLuma`；**不填则一键启动只起 DSH + 桥接，QQ 不上线** |
| `socialV2.voice.ffmpegPath` | `E:\tools\ffbin\ffmpeg.exe` | 新机器的 ffmpeg；没有就别填（语音/媒体归一化会降级） |
| `socialV2.tts.pythonPath` | `<某个 python 环境>\Scripts\python.exe` | 装了 `edge-tts` 的那个 python；不用唱歌/语音可留空 |
| `socialV2.asr.pythonPath` / `scriptPath` / `modelsDir` | `E:\tools\asr\...` | ASR 那一套（可选能力，没有就留空） |
| `snowluma.accessToken` / `wsUrl` / `httpUrl` | 旧机器的 token、端口 | 换过 SnowLuma 就换成新的；端口跟着 SnowLuma 配置走 |

其余（`dsh.baseUrl`、`consolePort`、`allow.private/groups`、`ownerQQ`、`adminQQ`）一般不用改，但跨机器换了 QQ 号就要动 `ownerQQ`（日记会换目录）。

> 编码坑：`config.json` 必须是 **UTF-8 无 BOM**。用记事本另存会带 BOM，桥接读 JSON 会直接失败。
> 在这台 Windows PowerShell 5.1 上不要用 `Set-Content -Encoding utf8NoBOM`（不支持），要用 `[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))`。

## 4. 安装 DSH 端并重启 DSH

```bat
node scripts\setup-dsh.mjs
```

它会往 DSH 的 profile 里写 `qq-chat` / `qq-chat-v2` preset 与三个 MCP server，**路径来自当前仓库位置**——所以换机器必须重跑，不能直接搬 `~/.dsh` 里的旧配置（除非仓库路径一模一样）。

装完**必须重启 DSH**（preset 与 MCP 只在启动时加载）。

## 5. 起服务并验证

```bat
node scripts\stack-control.mjs status   :: 先看现状（新机器应该三个都 ❌）
启动全部.cmd                             :: 缺什么起什么
node scripts\stack-control.mjs status   :: 再看：三端口 + QQ 账号 + 桥接连线应全绿
```

逐项验证（建议真的做一遍）：

1. `status` 里出现 `QQ 账号 <号>（<昵称>）` → OneBot 通了。
2. QQ 上发一条消息给 bot → `logs\bridge.log` 出现收取与投递；控制台（`http://127.0.0.1:3100`）能看到会话。
3. 群里 `@它 你还记得我们的日记吗` → 能引用出旧日记内容（说明 `state/diaries/` 生效）。
4. 私聊让它「唱一句」或发语音 → `audio/` 生效。
5. 让它 `file_list` → `files/` 生效。
6. 同一条消息里它调用了工具（控制台能看见 `qq_send_message`）→ MCP 挂载正常。

## 6. 开机自启（可选）

不推荐恢复那 5 个计划任务（会用 InteractiveToken 起 node，每次触发弹一个真实终端窗口，2026-11-15 已禁用）。两种无窗口的做法：

- **启动文件夹**：`shell:startup` 里放一个 `.vbs`：
  ```vbs
  CreateObject("WScript.Shell").Run "cmd /c cd /d D:\AutoChat && node scripts\stack-control.mjs start", 0, False
  ```
- **自己写一个 .vbs 调 `scripts\run-hidden.vbs`**（参数里不能带内层引号）。

## 7. 旧机器怎么处理

1. **先确认新机器跑通一轮消息**，再动旧机器 —— 同一个 QQ 号不能两头同时在线，会互相踢。
2. 旧机器上 `node scripts\stack-control.mjs stop`（停桥接与 SnowLuma；DSH 有登录守护任务，可以留着）。
3. 迁移包留着，等你确认新机器一切正常再删。

## 8. 想连「DSH 侧的会话历史」一起搬

桥接只是把 QQ 消息喂给 DSH；真正的对话历史在 DSH 自己的目录（`%USERPROFILE%\.dsh`）。要连它一起搬：

| 目录 | 内容 | 是否必需 |
| --- | --- | --- |
| `~/.dsh/profiles/` | DSH profile、preset、MCP 配置（**含旧仓库绝对路径**） | 不必搬，`setup-dsh.mjs` 会重建 |
| `~/.dsh/sessions/` | 每个会话的消息历史（体积大，以 GB 计） | 想「它记得最近几轮」才搬 |
| `~/.dsh/attachments/`、`storages/` | 附件与本地存储 | 同上 |
| `~/.dsh/.credentials.yaml` | DSH 的模型服务商令牌 | **建议在新机器上重新登录**，别搬 |

只搬 `sessions/` 的话，`state/sessions.json` 里的映射才有意义；否则桥接会为每个会话新建 DSH 会话（上下文从零开始，但功能正常）。嫌旧映射碍事可以删掉 `state\sessions.json` 再启动，让它重建。

## 9. 常见坑

- **`启动全部.cmd` 说起来了但 QQ 离线**：九成是 `snowluma.homeDir` 没填或填错 → `status` 会显示 SnowLuma ❌。
- **新机器上 `npm install` 后桥接报 SDK 相关错误**：`postinstall` 没跑成功，手动 `node scripts\patch-snowluma-sdk.mjs`。
- **控制台 401**：`state/console-token` 没跟着搬，或 `config.json` 里手填了 `consoleToken`。以 `config.json` 为准，其次 `state/console-token`。
- **`state/` 写不进去（EPERM/ACL）**：跑 `npm run harden-acl`；排查用 `npm run diagnose:acl`。
- **它「失忆」了**：先看 `state/diaries/`、`state/cross/`、`state/social-v2.json` 是否真的在；再看 `config.json` 的 `ownerQQ` 有没有变（变了日记目录就变了）。
- **日志中文乱码**：只是控制台代码页问题，文件本身是 UTF-8。用 `Get-Content -Encoding UTF8` 看。

## 10. 回滚

新机器起不来、旧机器还想继续用：旧机器上恢复服务即可（数据没被改过，打包是只读复制）：

```bat
node scripts\stack-control.mjs start
```

迁移包里 `MANIFEST.json` 的 sha256 可用来自查包是否完整（`Get-FileHash -Algorithm SHA256`）。
