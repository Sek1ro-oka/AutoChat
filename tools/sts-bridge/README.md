# sts-bridge — 让 AI 通过 JSON 玩《杀戮尖塔》的 sidecar

这个目录解决一件事：**把游戏状态变成 JSON 给 AI 看，把 AI 的决定变成游戏指令**，全程不碰鼠标。

```
MTS.cmd → ModTheSpire 3.31.0 → CommunicationMod 1.2.1
        → 按 config.properties 的 command 拉起 node bridge.mjs
        → 游戏往 sidecar 的 stdin 写 JSON（每次状态变化一行）
        → sidecar 往 stdout 写纯文本命令（PLAY 1 0 / END / CHOOSE 2 …）
        → 同一份状态再经 HTTP 暴露给桥接层/agent
```

为什么要绕这一圈：截图 + 模拟点击每回合要传一张 1920×1080 的图（几十万 token 级），
而且点错位置就是误操作；CommunicationMod 直接把结构化状态交出来，一回合的 token 是几百。

---

## 1. 已经装好的东西

游戏目录（下文用 `<游戏目录>` 指代，例如 `D:\SteamLibrary\steamapps\common\SlayTheSpire`；1 代，构建日期 2022-12-18）：

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `ModTheSpire.jar` | 11,153,867 B | ModTheSpire **3.31.0**（Workshop 版构建产物，见下方说明） |
| `MTS.cmd` | 本目录脚本 | 用它启动游戏（Steam 的「开始游戏」认不出手动安装的 MTS） |
| `MTS_console.cmd` | 本目录脚本 | 同上，但保留控制台窗口，排错时用 |
| `mods\BaseMod.jar` | 7,659,408 B | BaseMod **5.56.0**（CommunicationMod 声明依赖 `basemod`，必需） |
| `mods\CommunicationMod.jar` | 343,522 B | CommunicationMod **1.2.1**（GitHub release 资产） |

配置文件不在 mods 目录里，而在：

```
%LOCALAPPDATA%\ModTheSpire\CommunicationMod\config.properties
```

（ModTheSpire 的 `ConfigUtils.CONFIG_DIR` 在 Windows 上就是 `%LOCALAPPDATA%\ModTheSpire`，
`SpireConfig("CommunicationMod", "config")` 再拼上 `CommunicationMod\config`。）

```properties
# 示例路径只是占位：把 D:\code\qq-bridge 换成你自己 clone 下来的仓库位置，目录名不能有空格
command=C\:\\PROGRA~1\\nodejs\\node.exe D\:\\code\\qq-bridge\\tools\\sts-bridge\\bridge.mjs
runAtGameStart=true
verbose=true
maxInitializationTimeout=10
```

三个容易踩的点，都写进注释里了：

1. `command` 会被 `trim().split("\\s+")` 拆成 argv，**没有 shell**，所以路径不能带空格，
   引号也不管用。`C:\Program Files\nodejs\node.exe` 用 8.3 短名 `PROGRA~1` 绕开
   （`cmd /c for %I in ("C:\Program Files\nodejs\node.exe") do @echo %~sI` 可自行核对）。
2. `.properties` 里反斜杠是转义符，必须写成 `\\`，否则 `\n`、`\S` 会被吃掉。
3. `runAtGameStart=true` 才会在 mod 初始化时就拉起 sidecar；否则要去 ModTheSpire 的
   mod 设置面板手动点「启动通信进程」。

同目录的 `config.properties.example` 就是上面这份内容的模板。

---

## 2. 怎么启动、怎么验证

**推荐路径（一步）**：双击游戏目录里的 `MTS.cmd`。
游戏会自己把 sidecar 拉起来，不需要你另外开一个终端。

然后在**另一个** PowerShell 窗口里：

```powershell
Invoke-RestMethod http://127.0.0.1:47800/health | ConvertTo-Json -Depth 4
```

期望看到：

- 游戏还在主菜单时：`ok: true`（已经收到过状态）、`screenType: "NONE"` 或主菜单的 screen 名、
  `allowed_actions` 是 15 个白名单动作、`lastError: null`。
- 游戏没启动/没连上时：`ok: false`，`stateAgeMs: null`，但 HTTP 依然在跑 —— 这是**故意的**，
  桥接层靠 `ok` 判断"现在有没有真状态"，不会读到假数据。

**只测 sidecar、不启动游戏**（适合先确认 Node 这一侧没问题）：

```powershell
cd <仓库目录>\tools\sts-bridge
node bridge.mjs
```

期望：stdout 第一行立刻打印 `Ready`（这是 CommunicationMod 等的握手行，超时会杀进程），
stderr 打印监听端口；此时 `http://127.0.0.1:47800/state` 返回 `503 {"error":"no_state_yet"}`，
`/health` 返回 `ok:false`。按 Ctrl+C 结束。

> 两者不要同时用：`runAtGameStart=true` 时游戏自己会起一个 sidecar，你再手动起一个就会撞端口
> （bridge 会记一条 EADDRINUSE 日志但继续活着，命令通道仍然只有游戏那一个）。

**跑自测**（离线，自己拉一个子进程 + 假状态，不碰游戏、不占用 47800）：

```powershell
cd <仓库目录>\tools\sts-bridge
node selftest.mjs
```

---

## 3. HTTP 接口

只绑 `127.0.0.1`，端口默认 `47800`，环境变量 `STS_PORT` 可覆盖。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ok, pid, port, handshakeSent, lastStateAtMs, stateAgeMs, stale, screenType, screenName, inGame, readyForCommand, availableCommands, allowed_actions, lastError, lastCommand, counters, stateFile, uptimeMs}` |
| GET | `/state` | 瘦身后、给模型看的最近状态：`{ok, updatedAtMs, available_commands, ready_for_command, state}` |
| GET | `/state?raw=1` | 逃生口：原样的 `game_state`（含 deck/map/screen_state），调试用 |
| POST | `/act` | body `{action, ...}`，转成一行文本命令写进游戏 stdin，回 `{ok, sent:{action,line}}` |
| POST | `/reset` | 清空当前状态（重开游戏时用），回 `{ok:true, cleared:true}` |

`/state` 里保留的字段（其余一律丢掉，省 token）：

```
screen_type screen_name is_screen_up room_type room_phase action_phase
floor act act_boss ascension_level class current_hp max_hp gold
available_commands ready_for_command in_game choices(=choice_list)
relics[{name,counter}] potions[{slot,name,can_use,can_discard,requires_target}]
# 战斗中额外有：
turn player{hp,max_hp,block,energy,powers,orbs}
hand[{name,id,type,cost,can_play,has_target,rarity,upgrades}]
monsters[{name,id,hp,max_hp,block,intent,damage,hits,powers,is_gone,half_dead}]
piles{draw,discard,exhaust}   # 只给张数
```

两个字段命名上的偏差值得记一下：协议里叫 `is_playable`，这里给模型看的是 `can_play`；
协议里怪物伤害是 `move_adjusted_damage`（未计算时为 -1，要回退到 `move_base_damage`），
这里统一算成 `damage`。**协议本身不提供卡牌描述文本**（卡牌只有 name/id/cost/type/rarity/
upgrades 等），所以 `hand` 里没有 `description` —— 想要中文效果说明得自己按 name 查表，
那属于 agent 侧的知识库，不在 sidecar 里。

状态同时落盘到 `state\latest.json`（原子写：先写 `.tmp` 再 rename，避免 agent 读到半个文件）：

```json
{"receivedAtMs": 1700000000000, "receivedAt": "…", "available_commands": [...], "ready_for_command": true, "state": {...}}
```

---

## 4. `/act` 白名单与文本命令映射

白名单就是 CommunicationMod `CommandExecutor` 的真实分支，**大小写不敏感、只有这些**：

`play` `end` `choose` `potion` `proceed` `confirm` `return` `skip` `cancel` `leave`
`start` `key` `click` `wait` `state`

| POST /act body | 实际写到 stdout 的命令 | 备注 |
| --- | --- | --- |
| `{"action":"play","card_index":1,"target_index":0}` | `PLAY 1 0` | **card_index 从 1 开始**（协议如此）；目标下标从 0 开始 |
| `{"action":"play","hand_index":0,"target_index":1}` | `PLAY 1 1` | 方便模型用 0 开始的数组下标，这里替它 +1 |
| `{"action":"end"}` | `END` | |
| `{"action":"choose","choice_index":2}` | `CHOOSE 2` | |
| `{"action":"choose","choice":"Strike"}` | `CHOOSE Strike` | 名称里可以有空格，游戏侧会重新拼起来 |
| `{"action":"potion","mode":"use","slot":0,"target_index":1}` | `POTION Use 0 1` | 槽位从 0 开始 |
| `{"action":"potion","mode":"discard","slot":1}` | `POTION Discard 1` | |
| `{"action":"proceed"}` / `{"action":"confirm"}` | `PROCEED` | 右侧/确认按钮 |
| `{"action":"return"}` / `skip` / `cancel` / `leave` | `RETURN` | 左侧/返回按钮 |
| `{"action":"key","key":"end_turn","timeout":100}` | `KEY end_turn 100` | 键名白名单见下 |
| `{"action":"click","button":"left","x":960,"y":540}` | `CLICK Left 960 540` | 坐标按 1920×1080 归一 |
| `{"action":"wait","timeout":200}` | `WAIT 200` | 毫秒 |
| `{"action":"state"}` | `STATE` | 让游戏立刻回传一份状态 |
| `{"action":"start","class":"watcher","ascension_level":20,"seed":"ABC123"}` | `START watcher 20 ABC123` | 仅主菜单；职业 `ironclad/silent/the_silent/defect/watcher`；进阶 0-20；种子 `^[A-Z0-9]+$` |

`KEY` 键名白名单（23 个，照 `CommandExecutor.Keyword` 抄）：
`confirm cancel map deck draw_pile discard_pile exhaust_pile end_turn up down left right
drop_card card_1 … card_10`

不在白名单里的 action 一律 `400 {"ok":false,"error":"bad_request"}`，参数类型/范围不对也 400
（比如 `card_index: 0` 或 `11`、`target_index: 99`、`action:"rm -rf"`）。这样做是为了让模型
**没有办法发明指令**：错误在 HTTP 层就停住，不会写进游戏 stdin。

---

## 5. 排错

| 现象 | 先看哪里 |
| --- | --- |
| 游戏启动后卡住约 10 秒，然后 ModTheSpire 报「Timed out while waiting for signal」 | 游戏目录下的 `communication_mod_errors.log`（这是 sidecar 的 stderr）；多半是 `command` 路径写错/含空格 |
| `/health` 一直 `ok:false` | 游戏是否用 `MTS.cmd` 起的；ModTheSpire 界面里 CommunicationMod / BaseMod 是否勾选 |
| `EADDRINUSE` | 已经有一个 sidecar 在跑（手动起的，或上一个游戏进程没退干净）；换 `STS_PORT` 或先关掉旧进程 |
| HTTP 通、`/act` 返回 `warnings` | 该动作不在当前 `available_commands` 里，游戏多半会忽略它 —— 先看 `/health.availableCommands` |
| 想看 ModTheSpire 自己的加载日志 | 用 `MTS_console.cmd` 启动，控制台里就是完整堆栈 |

sidecar 的日志全部走 **stderr**（stdout 是命令通道，混一行日志就会让游戏解析失败），
`stdout` 上除握手 `Ready` 外只会有 `/act` 触发的命令行。

---

## 6. 还没做的部分

- **MCP 工具化**：把 `/state`、`/act` 包成 agent 可调用的 MCP 工具（`sts_get_state` / `sts_act`），
  留给主 agent 做；sidecar 这边只保证 HTTP 契约稳定。
- **卡牌知识库**：`hand` 里没有中文描述，若要模型理解卡牌效果，得按 `id` 建表补一层。
- **整局策略/自动打牌循环**：谁来读 `/state`、决定 `play/end`、出错怎么重试，属于 agent 侧。
- **真机全链路**：本机验证只做到「布局 + 配置解析 + Java 侧 spawn 握手 + HTTP 存活」，
  实际进游戏打一回合需要用户自己点一次（见第 2 节）。
