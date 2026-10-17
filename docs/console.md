# Web 控制台

本机控制台，**可选、默认关闭**——开启步骤见 [Windows 本机部署](local-setup.md)，本文讲的是开启之后怎么用。它把运行状态、会话、花费、日志与生效配置摊在十个页签里，并让人格卡、按群设置、活跃度参数、黑话词库、表情包库、空间说说与运行时设置可以在浏览器里改；概览页还有一张「服务」卡片用来重启／停止机器人，系统设置页有扫码登录。对应 [V2 开发路线图](roadmap.md) 的 Phase 1（控制台）、Phase 5（花费看板）、Phase 2（人格）、Phase 3（仿真）、Phase 4（黑话），以及路线图对照表里「表情/贴纸」那一行（表情包库；Phase 6 的 Agent 模式未做）。计费口径见 [令牌与花费看板](cost.md)，人格分层见 [人设与两层提示词](persona.md)，群友仿真见 [拟人化群友](simulation.md)，黑话词库见 [群聊黑话词库](slang.md)，表情包见 [表情包库](stickers.md)，空间说说见 [空间说说](qzone.md)，完整威胁模型与残余风险见 [安全与隐私基线](security.md)。

本文逐句对过代码的日期：**2026-10-17**（界面重构之后；同一天补了 supervisor 与「服务」卡片、扫码登录、第 10 个页签「空间说说」）。旧版的 11 个页签与 `pages.js` 系列脚本已经不适用。

## 开启与访问

在 `.env` 中设置：

```ini
CONSOLE_ENABLED=true
CONSOLE_PORT=3200
# 可选；留空则首次启动自动生成
CONSOLE_TOKEN=
```

重启后，启动日志会打印一行带令牌的地址，例如：

```
AutoChat 控制台：http://127.0.0.1:3200/?token=xxxxxxxx
```

用浏览器打开该地址即可。页面会把令牌记到浏览器本地存储（键 `autochat.console.token`），并立刻用 `history.replaceState` 把地址栏里的 `?token=` 移除，避免令牌留在历史记录里。换浏览器、换隐私窗口或清了站点数据，就要重新用带令牌的地址进一次；没带令牌时页面只显示「缺少访问令牌」和一句指引。

若未指定 `CONSOLE_TOKEN`，令牌会在首次启动时自动生成并写入 `runtime/console-token.txt`。该文件的访问控制是**每次启动都会执行的显式收紧**（只留当前账号、SYSTEM、Administrators），不只是创建时——Windows 会忽略 Node 的 `mode: 0o600`，所以"看起来设了权限"并不等于设了权限，且升级时要能修好旧文件（`src/console/server.js` 的 `resolveToken()` 调用 `src/permissions.js` 的 `harden()`）。已有文件里读到 ≥16 字符的令牌就沿用；想更换令牌，删掉该文件并重启，或在 `.env` 显式指定。机制与实测细节见 [安全与隐私基线](security.md)。

令牌是 24 字节随机数的 base64url 编码。服务端只绑 `127.0.0.1`（`createConsole()` 的 `host` 默认值），局域网与公网都连不上；要远程看就走 SSH 端口转发之类的隧道，不要把端口暴露出去。

控制台起不来（端口被占用，或前端文件根本读不到）时只打印一行 `控制台启动失败：…`，机器人本体照常运行——`src/main.js` 把失败吞在 `.catch` 里并清空 `consoleServer`。观测面板不该拖垮聊天。

## 进程、重启与「是否在运行」

控制台跑在机器人进程里（它要拿活的 store、transport 与运行状态），所以**它自己不能让机器人「再起来」**：进程一退出，控制台跟着没了。能把机器人拉回来的只有另一个进程——`scripts/supervisor.js`。

- **托管启动**：`start.cmd`（→ `scripts/start-all.ps1` → `scripts/start-autochat.ps1`）先跑 `node scripts/supervisor.js --status` 确认没在跑，再起 supervisor；由 supervisor 拉起 `src/main.js`。子进程环境里被注入 `AUTOCHAT_SUPERVISED=1` 与 `AUTOCHAT_SUPERVISOR_PID`，控制台据此知道自己是不是被托管的。
- **是否在运行，只有一个判据**：`data/autochat.lock`。文件在、能解析出整数 `pid`、**且这个 pid 还活着**，才算在运行；缺文件、内容坏了、pid 已经死了，一律算没在运行。锁的路径跟着 `DATABASE_PATH` 走（同一个目录下的 `autochat.lock`）。`node scripts/supervisor.js --status` 打印**一行 JSON**——`running`、`botPid`、`botStartedAt`、`supervisorPid` 与两个锁的路径——`start.cmd` 与 `stop.cmd` 都只信这一行。
- **`runtime/autochat.pid` 已退役**：现在没有任何东西写它。`stop.cmd` 只在确认那个 pid 已经不在了之后才顺手删掉这个遗留文件，活着就保留并打印 `Keeping runtime\autochat.pid: pid N is still alive.`。看到它还写着某个 pid，不要当成「正在运行」的证据。
- **另一把锁不参与判定**：`data/autochat-supervisor.lock` 是 supervisor 自己的互斥锁，第二个 supervisor 会直接退出（码 `2`），不会出现两个 supervisor 抢着拉机器人。它只作为旁注出现在 `--status` 里。
- **停止的顺序是先 supervisor 后机器人**：留着 supervisor，它会把你刚停掉的机器人再拉回来。`stop.cmd` 还做一件事——**pid 不算身份**：它会核对进程名是 `node.exe` 且命令行里含 `src\main.js`（或 `supervisor.js`），不认识就拒绝停止并报错，所以一个过期的 pid 文件不会误杀别的 `node.exe`。
- **supervisor 是隐藏窗口**：`start.cmd` 用 `-WindowStyle Hidden` 起它，输出重定向到 `runtime/autochat-output.log` 与 `runtime/autochat-error.log`，没有「supervisor 窗口」可看——机器人的应用日志仍在 `logs/`。

退出码就是 supervisor 唯一需要的协议（`scripts/supervisor.js` 的 `nextAction`）：

| 机器人的退出码 | supervisor 的动作 |
| --- | --- |
| `75` | 有人要求重启：立刻重拉，失败计数归零 |
| `0` | 正常停止：supervisor 跟着退出，不再拉起 |
| `2` | 单实例锁被别的进程占着：打印后放弃，不再重试 |
| 其它 | 异常退出：按 1s、2s、4s…（封顶 30s）退避重试，连续 6 次失败后放弃；活过 60 秒就当作没崩，计数归零 |

### 在控制台里重启、停止

概览页的「服务」卡片（`GET /api/service`）显示托管状态、进程号、运行时长与 supervisor pid，下面两个按钮：

- **未托管时两个按钮都是禁用的**，接口也会先拒绝（`409 SERVICE_NOT_MANAGED`，页面文案是「这个进程不是 supervisor 拉起来的：重启会让它直接退出，而且不会自己回来」）。这条拒绝存在的理由正是这句话：一个没有 supervisor 看着的进程，一旦把退出码 `75` 交出去，**就只会退出、不会回来**——比如前台 `npm start` 起的那个实例。要重启请用 `start.cmd`。
- **点一次只是「上膛」**：按钮变成「确认重启？」／「确认停止？」，3 秒内不再点就自动复原。这样做是因为两个动作都会让页面立刻失联，误点的代价很高。
- **重启**：接口先回 `{ok:true}`，约 0.5 秒后才 `exit 75`，页面每 2 秒探一次 `/api/service`。这几秒里页面上别的数字会报错——那是在退出，不是新故障。接口重新应答后显示「已恢复」，并把整页数据重新取一遍；**30 秒还不回来**就提示去看 supervisor（页面文案还叫「检查 supervisor 窗口」，其实没有窗口：`start.cmd` 是隐藏启动的，输出在 `runtime/autochat-output.log` 与 `runtime/autochat-error.log`）。
- **停止**：判据正好相反——接口**不再应答**才算停成。成功后提示「要用时请用 start.cmd 重新启动」，因为停止之后没有任何东西会把它拉回来；30 秒后接口仍在应答则提示「停止没有生效」。
- 两者都只影响机器人，不关 NapCat，也不关别的 QQ／Node 进程。

## 页面

十个页签，侧栏分三组：运营（概览、模型与 API Key、人格、群管理、活跃度与静默、空间说说）、数据（素材库、计费看板、日志与健康）、系统（系统设置）。顶栏右侧是深色／浅色与刷新两个按钮；切页时地址栏的 `#page` 会跟着变，可以直接收藏某一页。

| 页签（`data-page`） | 内容 | 能改的东西 |
| --- | --- | --- |
| 概览（`overview`） | 原「会话」页并入。四个指标（运行时长、当前模型、OneBot 连接、今日花费）、四个总开关、预算与队列（账期、已用／上限、预留中、剩余、待发队列、发送失败）、健康与告警、最近事件、参与者与发送、会话表（最近 20 条）、群与下次清理、「服务」卡片（托管状态、进程号、运行时长、supervisor pid） | 四个总开关：联网搜索、图片识别、防刷屏、群管理命令（`POST /api/settings`）；「服务」卡片的重启与停止（二次确认；未托管时禁用，判据与退出码见上文「进程、重启与…」） |
| 模型与 API Key（`model`） | 原「配置」页并入，只读：模型名、接口地址、API Key、OneBot 令牌、控制台令牌、WebSocket 地址（全部打码）、模型档案表（单价／上下文／能力）、生成限额、每日预算 | 无。启动期配置改 `.env` 后重启 |
| 人格（`personas`） | 人格卡表（名称、大小、最后修改、启用状态）、行为层路径与加载状态、合成后的提示词预览（前 800 字）；`SYSTEM_PROMPT` 存在时顶部横幅提醒人格卡不生效 | 新建／编辑／改名（另存为）／启用／删除人格卡；编辑行为层（保存后**需重启**） |
| 群管理（`groups`） | 每个群一张卡：人格卡选择、仿真开关与相关度／冷却／日上限、黑话开关、哪些项被本群覆盖（显示继承来的全局值） | 上述覆盖项、清除单项覆盖、「恢复该群默认」 |
| 活跃度与静默（`activity`） | 原「仿真」页。每群状态表（状态、能量、今日 / 上限、最近发言、最近判断）、全局参数、来自配置文件（只读）的上下文与延迟参数；页内标题是「动态」 | 全局相关度阈值、冷却秒数、每日上限、插话开关与插话最短空闲分钟。`idleHours` 那一项存不进去，见[已知缺口](#已知缺口界面上没有的东西) |
| 空间说说（`qzone`） | 机器人自己发的 QQ 空间说说：三个指标（今日已发／额度、上次发布、干跑开／关）、三条横幅（未开启／还在干跑／正在真实发布）、说说表（时间、正文、状态、可见范围、操作）。`blocked`／`failed` 的行只显示原因，不显示正文；机制与失败语义见 [空间说说](qzone.md) | 删掉自己发出去的那一条（`POST /api/qzone/delete`，只对 `sent` 且有 `tid` 的行可用）。开关、额度、时段等在系统设置页改 |
| 素材库（`assets`） | 原「黑话」与「表情包」两页合并，页内用子页切换。表情包：开关、自动收藏与阈值、上传、图片列表（含缩略图）、逐张确认／拒绝／编辑／删除、注入预览；黑话：开关、已确认与待确认统计、按群抽取、导出／恢复备份、逐条详情（含记录原句）与生效群、注入预览 | 上述全部：黑话与表情包的开关、审核、文本与生效群、上传 |
| 计费看板（`cost`） | 区间合计、平均每轮、缓存命中、谷时花费四个指标；区间切换（24h／3d／7d／30d）；每日预算占用；按会话表；逐轮下钻；最近的调用（含峰时／谷时标记）；计价规则 | 无（只读账本） |
| 日志与健康（`logs`） | 最近事件（120／300／1000 三档，可按事件名筛选）；每行只有时间与事件名 | 无 |
| 系统设置（`settings`） | 运行时字段按分组排列：布尔开关、枚举、数字／整数，带当前值、`.env` 默认值与「已覆盖」标记；另有「扫码登录」卡片：二维码图片、状态一行、刷新按钮，NapCat 的 WebUI 读不到时只显示原因 | 全部非启动期字段；空值＝恢复 `.env` 默认，改动立即生效；扫码登录的「刷新二维码」（`POST /api/login/qr`）。密钥、令牌、端口、WS 地址等启动期参数不在这里 |

**轮询规则**（`src/console/public/app.js` 的 `POLLED`）：

- **只有四页每 3 秒重绘一次**：概览、模型与 API Key、计费看板、日志与健康。
- **其余六页不轮询**：人格、群管理、活跃度与静默、空间说说、素材库、系统设置。其中大多数带着未提交的输入（人设文本、阈值数字、词条含义、下拉框），定时重绘会把这些内容冲掉；所以只在切页、点刷新或动作完成后重绘。
- **唯一的例外是系统设置页的「扫码登录」卡片**：它自己每 3 秒拉一次 `GET /api/login/status`（`src/console/public/pages-settings.js` 的 `LOGIN_POLL_MS`），只在卡片存在且页面没被隐藏（`document.hidden`）时跑。它刻意不借 `POLLED`——那一页有表单，整体重绘会冲掉输入，卡片只更新自己那一块。二维码 `<img>` 指向同源的 `/api/login/qr.png?token=…`（`<img>` 带不了请求头），同一张码不重复下载。
- 轮询只看当前页；**没有**「切到后台标签页就暂停」的逻辑，后台标签页同样每 3 秒请求一次。
- 主题选择存在 localStorage（键 `autochat.console.theme`），切换的是 `<html data-theme>`，刷新后保持。

## 静态资源

外壳（`src/console/public/index.html`）只有顶栏、侧边导航、`<main>` 与提示条；样式全在 `console.css`；脚本拆成 `core.js`（令牌、请求、格式化、错误码文案、页面注册表、事件派发）+ 每页一个脚本 + 素材库的两个子页脚本 + `app.js`（导航与轮询）。当前共 14 个同源 `<script>` 与 1 个样式表。

- **每个文件都必须在 `src/console/server.js` 的 `ASSETS` 里登记**。`ASSETS` 是 `Map`：按请求路径查表，不拼文件系统路径，所以路径穿越在结构上不可能；代价是**新增或改名页面脚本必须同时改 `ASSETS` 与 `index.html`**——漏登记就是 404，登记了但磁盘上没有就是 500 `console_assets_missing`。
- **旧脚本已经删掉了**：`pages.js`、`pages-extra.js`、`pages-stickers.js` 在 `6860d0e`（chore: drop the retired front-end scripts）里从磁盘删除，也不在 `ASSETS` 里——`GET /pages.js` 返回 `404 {"error":"not_found"}`。按旧的三文件结构改前端不会生效，照着改只会得到 404。
- 页面脚本的约定：往 `pages.<名字>` 挂一个返回 HTML 字符串的 `async` 函数；交互只写 `data-act="…"`（和必要的 `data-*`），由 `core.js` 的 `ACTIONS` 表分发；样式只写 `console.css` 里的类名。DOM 事件只有一个入口：`app.js` 在 `document` 上监听 click 与 change。
- 这些静态文件**不校验令牌**，也不含任何数据——它们是代码，浏览器的 `<script>` 请求也带不了自定义头。

## CSP 与前端硬约束

除两张图片外（见下），每个响应都带这一条策略（实际是一行）：

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

另有 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

两个二进制响应是例外：`/api/stickers/image` 与 `/api/login/qr.png` 只带 `Content-Type`（图片类型或 `image/png`）、`Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`，别的那几个头都没有。这两处仍然要令牌，只是走查询串 `?token=`——`<img>` 带不了自定义请求头。

`default-src 'none'` 的意思不是"随便写、浏览器兜底"，而是**没点名的都是拒绝**。于是前端多了一条硬约束：

- **不得用内联 `onclick`／`onsubmit` 或任何 `on*` 属性**——事件必须走 `data-act` + `ACTIONS`；
- **不得用 `style="…"` 内联样式**，也不得写内联 `<style>` 块——样式只能来自 `console.css`。进度条、热力格这类按数据变宽的元素用 **CSSOM** 赋值（`node.style.width = …`），它不受 `style-src` 限制；
- **不得 `eval`／`new Function`／内联 `<script>`**；
- **不得引外部资源**（CDN、字体、外链图片）。`img-src 'self'` 也意味着 `data:` 图片不能直接当 `<img src>`；表情包缩略图与登录二维码分别走同源的 `/api/stickers/image` 与 `/api/login/qr.png`，`<img>` 带不了请求头，所以这两个地址用 `?token=`。

违反这条不会有服务端报错，只会在浏览器控制台留一条 CSP 拒绝，界面表现是"点了没反应"。改前端前先看 DevTools。`test/console-pages.test.js` 会在渲染结果里断言按钮不带 `onclick`，`test/console.test.js` 断言响应头里的 CSP 含 `script-src 'self'`、`style-src 'self'` 且不含 `unsafe-inline`。

## 已知缺口（界面上没有的东西）

下面三处在设计稿里有、后端还没有对应聚合，**当前未实现**。界面不画空图，也不编数字；没有数据的单元格统一显示破折号 `—`：

1. **计费看板的「星期 × 小时」热力图**：没有实现。`console.css` 里有现成的 `.hm-*` 与 `--heat-0…5` 样式，但没有任何脚本渲染它；`/api/cost` 只按时间分桶（`COST_RANGES` 的 24h／3d／7d／30d），没有按「星期几 × 小时」聚合的接口。
2. **「今日／本周／本月」三张花费卡**：没有实现。现在只有区间可选的四档合计，以及顶栏那个「今日花费」（来自 `/api/summary`）。
3. **概览的结构化事件**：没有实现。`/api/logs` 只给事件名与时间，所以「最近事件」表只有两列；事件的 `detail` 不在控制台展开，排障要直接读 `logs/*.jsonl`。

另外两处是**有接口、没控件**：

- 单群静音：`POST /api/social/config` 接受 `{group, muted}`，但「活跃度与静默」页只把 `muted` 显示成状态，没有开关。
- 联网查义：`POST /api/slang/lookup` 在服务端可用，「素材库」的黑话子页没有这个按钮。
- 说说的手动发布：没有「现在就发一条」的按钮。能不能发由 `QZONE_*` 与攒到的素材量决定，界面上只能看与删——这是刻意的，见 [空间说说](qzone.md)。

还有一个**已知会失败的操作**：活跃度页把 `SOCIAL_IDLE_HOURS` 渲染成数字输入框、标成「插话最长空闲（小时）」，但后端要求的是 `H-H` 时段（如 `9-22`，起点 ≤ 终点、不支持跨零点）。从这一项点保存必定得到 400 `SOCIAL_PARAM_INVALID`；同一页别的数字项不受影响。要在控制台改这个时段，目前没有可用入口——直接改 `.env` 里的 `SOCIAL_IDLE_HOURS`。

## API

所有 `/api/*` 都需要令牌。读接口两种方式皆可：

- 请求头 `x-console-token: <token>`
- 查询参数 `?token=<token>`

**写接口（POST）只接受请求头里的令牌**，且当请求带 `Origin` 时必须是回环 `http` 地址（`null` 放行，沙箱 iframe 与 `file://` 会给 `null`）。这是刻意的：URL 里的令牌可被第三方页面复用，而跨站页面既无法给简单请求加自定义头，也无法通过我们从不回应的 CORS 预检，因此写接口不可被 CSRF 触发。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/summary` | 运行总览数据（连接、开关、预算、队列、参与者、群清理时间；顶栏的模型与今日花费也来自这里） |
| GET | `/api/sessions?limit=200` | 会话列表（不含历史正文） |
| GET | `/api/charges?days=30` | 按账期的花费汇总（预算账本：预留与结算） |
| GET | `/api/cost?range=24h\|3d\|7d\|30d` | 计费看板：区间合计、按会话汇总、最近调用、计价规则 |
| GET | `/api/cost/turns?session=<会话键>&limit=100` | 指定会话的逐轮明细 |
| GET | `/api/logs?limit=120` | 最近事件（固定事件名） |
| GET | `/api/config` | 生效配置（凭据打码） |
| GET | `/api/settings` | 运行时设置：分组、字段（当前值／`.env` 默认值／范围／枚举选项）。字段表由 `src/runtime-config.js` 统一下发 |
| POST | `/api/settings` | `{name,value}` 保存单个运行时设置；`value` 为空串即删除该行、恢复 `.env` 默认；越界或未知字段返回 `400` |
| GET | `/api/personas` | 两层提示词状态：生效来源、行为层、人格卡列表、合成提示词预览 |
| GET | `/api/personas/file?kind=card\|behavior&name=<卡名>` | 读取人格卡或行为层正文（供编辑器） |
| POST | `/api/personas/file` | 保存。`{kind:'behavior',content}` 保存行为层（需重启）；`{kind:'card',name,content}` 保存人格卡（即时生效）；改名即另存为 |
| POST | `/api/personas/delete` | `{name}` 删除人格卡 |
| POST | `/api/personas/active` | `{name}` 切换启用的人格卡；`name` 为空串表示恢复内置默认 |
| GET | `/api/social` | 活跃度状态：开关、阈值/冷却/日上限、每群状态与能量、今日发言计数、最近一次判定原因（**不含消息正文**） |
| POST | `/api/social/config` | 调整参数：`{enabled}`、`{threshold}`、`{cooldownSeconds}`、`{dailyLimit}`、`{idleEnabled}`、`{idleMinutes}`、`{idleHours}`、`{group,muted}`；均为可选补丁，立即生效并写入本机设置（带 `group` 的字段只在按群作用域可写；`idleHours` 只接受单个 `H-H`，起点 ≤ 终点，`22-6` 这类跨零点写法返回 `400`；只含全局字段的补丁带 `group` 会被拒绝，不会谎报成功） |
| GET | `/api/groups` | 按群特异化视图：每群的人格选择、仿真参数与覆盖标记、黑话开关与适用词条数，以及全局参考值 |
| POST | `/api/groups/config` | 按群写入口：`{group,subsystem,...}`，`subsystem` 为 `persona`（`{name}`，`null`=继承、空串=内置默认）、`social`（`{enabled?,threshold?,cooldownSeconds?,dailyLimit?}`，`null`=继承）、`slang`（`{enabled}`）或 `reset`（清空该群全部覆盖）。未知群返回 `404`，其余越界返回 `400` |
| GET | `/api/slang` | 黑话词库：开关、统计、容量、上次抽取、每群可抽取的群列表、**当前注入原文**、词条列表（**不含记录中的原句**） |
| GET | `/api/slang/entry?id=<id>` | 单条词条详情，含记录中的原句（显式点击才取） |
| GET | `/api/slang/export` | 导出整库备份（JSON） |
| POST | `/api/slang/config` | `{enabled}` 打开／关闭黑话功能 |
| POST | `/api/slang/extract` | `{group}` 抽取候选。**会调用一次模型并计入每日预算** |
| POST | `/api/slang/status` | `{id,status}`，`status` 为 `candidate`／`confirmed`／`rejected`；只有 `confirmed` 会进入提示词 |
| POST | `/api/slang/entry` | `{id,meaning?,usage?,example?,risk?}` 修改词条文本，不改变确认状态 |
| POST | `/api/slang/scopes` | `{id,groups}` 设置词条生效群；空数组 = 全局（所有群注入） |
| POST | `/api/slang/delete` | `{id}` 删除词条 |
| POST | `/api/slang/lookup` | `{id}` 联网查义。**会消耗一次搜索额度与模型预算**，结果仍需人工确认。当前界面没有这个按钮 |
| POST | `/api/slang/import` | `{text}` 恢复备份；按词条内容加法合并，保留本地的人工确认状态 |
| GET | `/api/stickers` | 表情包库：开关、自动收藏参数、统计、容量、**当前注入原文**、图片列表（含备注/标签/状态，不含图片字节） |
| GET | `/api/stickers/entry?id=<id>` | 单张详情（显式点击才取） |
| GET | `/api/stickers/image?id=<id>` | 图片缩略图（二进制，走 `?token=` 查询串，`<img>` 带不了请求头） |
| POST | `/api/stickers/config` | `{enabled?,autoCollect?,autoThreshold?}` 打开/关闭或调自动收藏 |
| POST | `/api/stickers/status` | `{id,status}`，`status` 为 `candidate`／`confirmed`／`rejected`；只有 `confirmed` 会进入提示词 |
| POST | `/api/stickers/entry` | `{id,note?,desc?,tags?}` 修改备注/标签，不改变确认状态 |
| POST | `/api/stickers/delete` | `{id}` 删除图片，并删除本地文件 |
| POST | `/api/stickers/upload` | `{dataUrl,note?}` 上传自己的图（PNG/JPG/GIF/WebP，≤5MB），直接确认为可发 |
| GET | `/api/qzone/posts` | 空间说说：今日已发／额度、上次发送时间、干跑与总开关状态、最近 50 条记录（时间、正文、状态、原因、可见范围、能不能删）。`blocked`／`failed` 的行不带正文 |
| POST | `/api/qzone/delete` | `{id}` 收回自己发出去的那一条：先调 OneBot 的 `delete_qzone_msg`，成功了才把本地行改成 `deleted`。只对 `sent` 且有 `tid` 的行可用，失败按 `QZONE_DELETE_*` 分类返回 |
| GET | `/api/service` | 进程托管状态：`managed`、`pid`、`supervisorPid`、`uptimeMs`、`restartable`。`managed` 只看子进程环境里的 `AUTOCHAT_SUPERVISED`，不看命令行也不看锁文件 |
| POST | `/api/service/restart` | 先回 `{ok:true,action:"restart"}`，约 0.5 秒后以退出码 `75` 退出，交给 supervisor 重拉。**未托管时 `409 SERVICE_NOT_MANAGED`**；动作名不认识 `400 SERVICE_ACTION_INVALID` |
| POST | `/api/service/stop` | 同上，但退出码是 `0`：supervisor 跟着退出，不再拉起，要用 `start.cmd` 才回来 |
| GET | `/api/login/status` | NapCat WebUI 的登录状态：`state`（`disabled`／`unreachable`／`error`／`idle`／`waiting`／`scanned`／`online`）、`online`、`qrAt`，在线时附 `uin`。**永不抛错**，坏消息都在 `error` 字段里 |
| POST | `/api/login/qr` | 让 NapCat 换一张二维码。服务端最多等 12 秒（NapCat 自己最多 10 秒）；二维码文本**绝不转发**，只回状态与 `qrAt` |
| GET | `/api/login/qr.png` | 当前这张二维码图片（二进制，走 `?token=` 查询串）。还没有码时 `404 QR_NOT_FOUND` |

写接口返回**完整的新状态**（人格卡列表、黑话列表、表情包列表、群设置视图、说说列表），页面据此一次重绘，不必再 GET 一次；`/api/service/*` 是个例外，它只回 `{ok:true,action}` 然后在半秒后把进程带走，新的状态只能等页面下一次探测。方法不是 GET／POST 时返回 `405 {"error":"method_not_allowed"}`；未知路径返回 `404 {"error":"not_found"}`。

错误码按「操作者能不能自己修」分配：名称非法或内容为空 `400`、内容超限 `413`、卡数达上限 `409`、卡不存在 `404`、子系统没启用 `503`；仿真与按群写为参数非法 `400`、未知群 `404`、`SOCIAL_PARAM_NOT_GROUP_SCOPED` `400`；黑话为参数非法 `400`、词条不存在 `404`、功能未开启／预算不足／搜索未启用 `409`、搜索次数用尽 `429`、模型失败或返回不可解析／查义没验证上 `502`；表情包为参数非法 `400`、图片不存在 `404`、上传格式或大小非法 `400`；运行时设置为参数非法或越界 `400`（`CONFIG_PARAM_INVALID`）。**服务控制**按「会不会回来」分配：没人托管的进程 `409 SERVICE_NOT_MANAGED`（让它退出就再也回不来，所以宁可拒绝），动作名不认识 `400 SERVICE_ACTION_INVALID`。**扫码登录**把 NapCat 的坏消息分三层：WebUI 读不到或连不上是 `503`（`WEBUI_DISABLED`／`WEBUI_UNREACHABLE`），请求失败、令牌被拒是 `502`（`WEBUI_REQUEST_FAILED`／`WEBUI_AUTH_FAILED`），需要二次验证或已经在线是 `409`（`WEBUI_2FA_REQUIRED`／`LOGIN_ALREADY_ONLINE`）；刷新二维码另有 `502 QR_REFRESH_FAILED`、`504 QR_REFRESH_TIMEOUT`、`409 QR_EXPIRED`、`404 QR_NOT_FOUND`。**说说**的删除：记录不存在 `404 QZONE_POST_NOT_FOUND`，已删过或没有 `tid` `409`，传输层不可用 `503 QZONE_DELETE_UNAVAILABLE`、超时 `504 QZONE_DELETE_TIMEOUT`、被服务端拒绝 `502 QZONE_DELETE_REJECTED`、其它 `502 QZONE_DELETE_FAILED`。未分类异常统一 `500 {"error":"internal"}`。

请求体上限默认 128 KiB；`/api/slang/import` 放宽到 2 MB（整库备份可能包含上限 2000 条词条），`/api/stickers/upload` 放宽到 8 MB（一张 ≤5 MB 的图经过 base64 编码后略超 6.7 MB；前端还会先按 5 MB 原图卡一道）。超限返回 `413` 并关闭连接，避免半截 JSON 继续占着内存。

## 安全边界

1. **只绑回环**：服务端绑定 `127.0.0.1`（`createConsole({ host })` 的默认值），不接受外部地址，因此局域网与公网无法访问。这与 OneBot 正向连接的设计一致——不需要暴露端口。
2. **令牌鉴权**：`/api/*` 全部需要令牌；比较使用定长常量时间比较（先比长度再 `timingSafeEqual`），避免时序侧信道。
3. **凭据打码**：任何形如 `key`／`token`／`secret`／`password` 的字段在响应里都会被遮罩，从不返回明文。`api.js` 的 `redact()` 递归处理嵌套对象，深度封顶 6 层。
4. **页面本身不含数据**：`/` 只返回静态外壳，任何真实数据都要过令牌。
5. **写入面极小且受额外约束**：观测页面（模型与 API Key、计费看板、日志与健康）全为只读；写操作只有「概览」页的四个总开关与「服务」卡片（重启／停止）、「人格」页（保存行为层／人格卡、删除、启用）、「群管理」页（按群的人格／仿真／黑话覆盖与恢复默认）、「活跃度与静默」页（开关、阈值、冷却、日上限、冷场开关与时长；时段那一项见[已知缺口](#已知缺口界面上没有的东西)）、「素材库」页（黑话与表情包的开关、抽取、确认／拒绝、改文本、生效群、删除、备份恢复、上传）、「空间说说」页（收回自己发出去的那一条）、「系统设置」页（逐项保存；刷新登录二维码），以及首次生成令牌文件。写接口额外要求**请求头令牌 + 回环 Origin**，不接受查询参数令牌（见上）。「服务」卡片的重启／停止不传任何数据，只是让进程按约定退出码退出——未托管时接口直接拒绝，因为没人会把它拉回来。人格写入只落在 `personas/` 目录内的 `behavior.md` 与 `characters/*.md`——卡名经过字符集白名单与路径包含双重校验，不产生路径穿越；落盘走临时文件原子重命名，崩溃不会留下半截文件。仿真参数是一组**经过范围校验的数值与布尔量**，只写入 `settings` 表的固定键，不能指定任意键名。按群覆盖使用命名空间键（如 `group_persona:<群号>`），由 `src/group-settings.js` 统一定义键名与数值边界，写入口只接受已知群号与已知子系统。运行时设置同样只写 `settings` 表的固定键（`cfg:*`），键名、类型与范围由 `src/runtime-config.js` 的字段表统一定义——写入口只接受已登记字段，不能指定任意键名，密钥与启动期参数根本不在字段表里、无法被写入。黑话只写 `slang` 表的固定列：状态限三个枚举值，文本经 `sanitiseText()` 压平并截断，`id` 必须已存在；生效群写 `slang_groups` 表，群号须在已配置群里；恢复备份解析失败时**不改动词库**，而是把原文另存到数据目录下的 `slang-corrupt/`（`<数据目录>/slang-corrupt/slang-corrupt-<时间戳>.json`，最多保留 20 份）。表情包只写 `stickers` 表的固定列：状态限三个枚举值，备注/标签经 `sanitizeStickerText()` 压平成单行并截断，`id` 必须已存在；删除会连同本地图片文件一起删；上传只接受 base64 图片，先校验格式与大小再落盘。
6. **不打印聊天内容**：控制台只读 `logs/`（事件名与时间，`detail` 不返回）与数据库的**结构信息**（条数、时间、状态），不读会话正文。人格页编辑的是**人设文本**，活跃度页展示的是**判定原因与计数**，都与会话正文无关。黑话页的列表接口同样不返回记录中的原句，只有点开单条详情时才返回该条的依据（见 8）。
7. **花费看板不含正文**：采样只存 token 计数、会话键与时间，不存提问或回答文本。
8. **群消息流水不对外开放**：`messages` 表（群聊正文）没有任何 API 读取入口，控制台也不会展示它。黑话词条里会带一条**记录中的原句**作为判断依据，它是唯一从群消息正文派生出来的字段，因此列表接口不返回它，只在 `GET /api/slang/entry?id=<id>` 这一个人工点击下返回单条。
9. **不可被套壳**：所有响应带 `X-Frame-Options: DENY` 与上一条的完整 CSP（含 `frame-ancestors 'none'`、`base-uri 'none'`、`form-action 'none'`）。写接口本身就接受同源请求，所以一个能把控制台套进不可见 iframe 的第三方页面会是通往人格／黑话编辑器的点击劫持路径。页面**零外部资源**，这条 CSP 不依赖任何 CDN，不会影响渲染。
10. **已知取舍：认证之后的接口没有限流**。控制台对读接口与写接口都不做频率限制——这是**有意留下的取舍，不是待修的缺口**。理由有三条：令牌是 24 字节随机数，逐个试没有现实可能；这台机器是单人自用，限流挡不住自己、只会给自己加摩擦，还会多出一个只能被自己触发的「误伤」状态；真正要防的是浏览器里的第三方页面，而那条路由写接口的请求头令牌、回环 `Origin` 与第 9 条的 `DENY`/CSP 一起挡住。**前提是令牌没有泄漏**：拿到令牌的人不受任何限制，这条已经写进 [安全与隐私基线](security.md) 的威胁模型与残余风险。

> 令牌等同于控制台访问权，请像对待 `.env` 一样保管。`runtime/` 已被 Git 忽略。

## 排查

| 现象 | 处理 |
| --- | --- |
| 页面提示「缺少访问令牌」 | 用启动日志里带 `?token=` 的完整地址打开 |
| `401` | 令牌不匹配。检查 `runtime/console-token.txt`，或清掉浏览器本地存储后重开带令牌的地址 |
| 写请求 `403 header_token_required` | 令牌放在了查询串里。写接口只认请求头 `x-console-token` |
| 写请求 `403 origin_rejected` | `Origin` 不是回环 `http`。用 `http://127.0.0.1:3200/` 或 `localhost` 打开，别用反代域名 |
| 某个页面脚本 `404` | 文件名改了但没在 `src/console/server.js` 的 `ASSETS` 里登记，或 `index.html` 引用了退役脚本 |
| `500 console_assets_missing` | `ASSETS` 登记了但磁盘上没这个文件，部署包不完整 |
| 点重启得到 `409 SERVICE_NOT_MANAGED` | 这个进程不是 supervisor 拉起来的（比如前台 `npm start`）。重启会让它直接退出而且不会回来——用 `start.cmd` 起，再用卡片 |
| 点了重启，30 秒还没回来 | 看 `runtime/autochat-output.log` 与 `autochat-error.log`：退出码 `2` 是锁被别的实例占着，其它码会退避后重试；supervisor 进程本身没了就没人再拉它，重新 `start.cmd` |
| 点了停止，之后要它回来 | 停止是退出码 `0`，没有任何东西会再拉起它——用 `start.cmd` |
| 扫码卡片说读不到 / 连不上 NapCat | `503 WEBUI_DISABLED` 是 `runtime/napcat/config/webui.json` 不存在（NapCat 没在跑或换了 workdir）；`503 WEBUI_UNREACHABLE` 是端口不对、WebUI 没开或刚重启，等几秒再刷新 |
| 刷新二维码得到 `502 WEBUI_AUTH_FAILED` 或 `504 QR_REFRESH_TIMEOUT` | 前者是 WebUI 令牌被拒（NapCat 重启后旧凭证失效、`webui.json` 里的 token 变了）；后者是 NapCat 那边 10 秒内没换出码，再点一次 |
| 说说页空空如也、一行都没有 | 功能默认关闭且默认干跑；`QZONE_ENABLED=false` 时什么都不会发生，攒够素材也不会发 |
| 界面某处只有 `—` | 该数据没有值（当天没有调用），或属于[已知缺口](#已知缺口界面上没有的东西) |
| 端口被占用 | 改 `CONSOLE_PORT` 后重启；启动失败只记录日志，不影响机器人本体 |
| 控制台没起来 | `CONSOLE_ENABLED` 是否为 `true`；看启动日志中是否有「控制台启动失败」 |
