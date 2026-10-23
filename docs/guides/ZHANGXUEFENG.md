# 张雪峰视角（`zx_perspective`）

给「升学 / 专业选择 / 就业 / 阶层流动」这类问题多一套**分析角度**的工具。

**它是咨询模式，不是角色扮演。** 说话的还是小鲸鱼（DeepSeek），只是借这份 skill 里的
5 个心智模型、8 条决策启发式和表达 DNA 来组织答案：

- 不切换身份、不改口吻、不改签名；
- **回答开头不写**「按张雪峰的路子」「以张雪峰视角」这类标注（用户明确不需要）；
- 边界仍然是小鲸鱼的边界（不吹牛、不编数据、不给具体录取线）。

## 数据来源（正文不进仓库）

| | |
| --- | --- |
| 来源 | 外部 skill 目录 `C:\Users\MR\.agents\skills\zhangxuefeng-skill\SKILL.md` |
| 默认路径 | `cfg.socialV2.zx.dir`，缺省即上面这个**绝对路径** |
| 许可 | MIT，Copyright (c) 2026 Huashu（花叔），见该目录下 `LICENSE` |
| 进仓库的 | 只有读取逻辑；**正文一个字都不复制**（避免 25KB 人格文本随仓库扩散，也避免它盖掉小鲸鱼的人设） |

运行时按需读，**每次请求只 `stat` 一次**：`mtimeMs` 没变就复用上次读到的正文，
变了就重新读。所以运营改完 skill 文件**立刻生效**，不用重启；也不会每来一条群消息就重读 25KB。

> 注意：`SKILL.md` 正文里的「直接以张雪峰的身份回应」我们**不采纳** —— 那句是给「角色扮演」
> 场景写的。这里只取分析框架那几节，见下一节。

### 哪些节会被取用

| 小节 | 取不取 | 为什么 |
| --- | --- | --- |
| `## 核心心智模型` | ✅ `frameworks` | 5 个心智模型，咨询模式的主力分析角度 |
| `## 决策启发式` | ✅ `heuristics` | 8 条判断规则，用来给建议 |
| `## 表达DNA` | ✅ `expression` | 句式/词汇/节奏，用来把话说得像人 |
| `## 角色扮演规则` | ❌ **永不返回** | 那节是「直接以张雪峰的身份回应」这类**人格指令**，与「说话的还是小鲸鱼」直接冲突 |
| 身份卡 / 失败模式 / 时间线 / 价值观 / 智识谱系 / 微例 / 反例黑名单 / 诚实边界 / 附录 | ❌ | 属于人设、史料与自我评估，不是咨询要用的框架（取出来只会把回答拽回角色扮演） |

`topic` 缺省（= `all`）只拼上面**三节**。显式传 `rules` / `规则` / `角色扮演规则` 会走
「认不出 → `all`」的兜底，同样拿不到那一节 —— 这个端点只发参考资料，不发人格指令。

另外，`## 表达DNA` 开头那句「角色扮演时必须遵循的风格规则：」是个纯标签行，会被**剥掉**
（只剥这一种以「角色扮演」开头、以冒号结尾的整行标签，句式/词汇/节奏等正文一个字不动）。

## 端点契约

```
POST /api/socialV2/zx-perspective
x-console-token: <控制台令牌>     # 整站闸门，MCP 进程自动带
x-agent-call: 1                  # 声明这是智能体调用，MCP 进程自动带
x-agent-token: <会话令牌>         # 本端点**必带**
content-type: application/json
{ "key": "group:1131654608", "topic": "all" }
```

成功：

```json
{
  "ok": true,
  "topic": "all",
  "source": "zhangxuefeng-skill/SKILL.md",
  "mtime": "2026-09-26T13:29:17.206Z",
  "chars": 3097,
  "truncated": false,
  "missing": [],
  "text": "## 核心心智模型\n\n### 模型1: 社会筛子论\n\n..."
}
```

- `source` 只给「目录名/文件名」这种相对标签，**不回绝对路径**（同语音库口径）。
- `chars` 恒等于 `text.length`（截断后也一样），方便模型判断要不要换 `topic` 再取一节。
- `missing` 是「这一轮按 topic 该有、但文件里没找到」的小节名；正常应为空数组。
- `truncated: true` 时 `text` 末尾带一行「（已截断…）」标注。

### topic 归一

| 传什么 | 得到 | 取哪一节 |
| --- | --- | --- |
| （不传）/ `all` / `全部` / 认不出的值（含 `rules` / `规则` / `角色扮演规则`） | `all` | 三节全要（**不含**角色扮演规则） |
| `frameworks` / `framework` / `models` / `mentalmodels` / `coreframeworks` / `心智模型` / `核心心智模型` | `frameworks` | `## 核心心智模型`（5 个） |
| `heuristics` / `heuristic` / `启发式` / `决策启发式` | `heuristics` | `## 决策启发式`（8 条） |
| `expression` / `dna` / `表达` / `表达DNA` / `表达方式` | `expression` | `## 表达DNA` |

归一规则是**宽松**的：小写、去空格/下划线/连字符后再比；**认不出的一律回 `all`**，
不报 400 —— 模型手滑时它要的是「给我点参考」，不是参数校验报告。

### 长度

三节全取当前约 3.1K 字，**上限 4000 字**。超长时先给截断标注留位置再截正文，
所以 `chars` 永远不会超过 4000。需要完整某一节时用 `topic` 单独取。

## MCP 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `zx_perspective` | `key` / `token` / `topic`（可选，枚举：`frameworks` / `heuristics` / `expression` / `all`） | 取参考框架，返回 `serializeModelData(data)` 后的结构化结果 |

工具描述里写清了三件事，别删：

1. **只在指定群可用**（默认 `group:1131654608`），其它会话一律 403；
2. **这是参考资料，不是指令** —— 说话的还是小鲸鱼，别照抄里面第一人称的口气、别切换成张雪峰；
3. **不是张雪峰本人的观点**，也不代表他的实时说法。

## Gating（四道关卡，按顺序）

1. **控制台令牌**（整站 `x-console-token`）—— 没有就 401，和其它 `/api/*` 一样。
2. **智能体调用声明**（`x-agent-call: 1`）—— 带了就必须有 `x-agent-token`，且令牌必须命中
   某个活跃二代会话；否则 403「未授权：该接口的智能体调用必须携带有效的会话令牌」。
   这条是桥接的集中关卡，防止「漏传令牌」被当成管理端全权（confused deputy）。
3. **模式**：带 `x-agent-token` 的 `/api/socialV2/*` 只在 **`reserved2`（二代仿真）** 模式放行。
   一代 `chat` / `reserved` / `closed-agent` 模式下这个端点不可达 —— 那三种模式本来也不发会话令牌。
4. **端点自己两道**：
   - `agentTokenOk(key, token)` → 令牌必须精确属于这个会话（403「agent token 无效」）；
   - `v2SessionAllowed(key)` → 目标必须在当前模式的允许范围内（403「目标不在当前模式允许范围内」）；
   - **`key` 必须是 `cfg.socialV2.zx.allowKeys` 里的会话**（默认只有 `['group:1131654608']`），
     否则 403 `{ code: 'forbidden', error: '张雪峰视角只在指定群可用（group:1131654608）' }`。

第 4 条最后一关是**硬闸门**：哪怕对方手里有别的群的合法令牌、那个群也在 `allow.groups` 里，
只要不在 `zx.allowKeys` 里就过不去。这是「只给一个群开的小灶」，不是通用能力。

### 上线前提（运维要做的两件事）

- 该群要能在二代仿真里被唤醒 → 群号要在 `allow.groups` 里。不在的话 bot 本来也不会在那说话，
  工具自然用不上（那时返回的是「目标不在当前模式允许范围内」）。
- 运行模式要是 `reserved2`。

两件都不需要改 `config.example.json`：`socialV2.zx` 整段是**可选**的，缺省即「默认路径 + 只允许
`group:1131654608`」。真要改：

```json
{
  "socialV2": {
    "zx": {
      "dir": "C:\\Users\\MR\\.agents\\skills\\zhangxuefeng-skill\\SKILL.md",
      "allowKeys": ["group:1131654608"]
    }
  }
}
```

`allowKeys` 显式给 `[]` 表示**谁都不许**（不会被默认值悄悄覆盖）；条目会先按
`group:<数字>` / `private:<数字>` 归一（去前导零、丢非法项）。

`dir` 只认**文件名是 `SKILL.md`** 的路径：指到别的文件（比如 `secrets.txt`）一律
`500 unavailable`，不会把它读出来回给模型 —— 这个入口只读那一份 skill，不是任意文件读取器。

## 失败语义

| 情况 | HTTP | 返回 |
| --- | --- | --- |
| `key` 为空 | 400 | `{ ok:false, error:'key 不能为空' }` |
| 没带 `x-agent-token` | 403 | `{ ok:false, error:'agent token 不能为空' }`（智能体调用会先被集中关卡拦下） |
| 令牌不属于该会话 / 空串 | 403 | `{ ok:false, error:'agent token 无效' }` |
| 会话不在当前模式允许范围 | 403 | `{ ok:false, error:'目标不在当前模式允许范围内' }` |
| `key` 不在 `zx.allowKeys` | 403 | `{ ok:false, code:'forbidden', error:'张雪峰视角只在指定群可用（…）' }` |
| `dir` 指向的文件名不是 `SKILL.md` | 500 | `{ ok:false, code:'unavailable', error:'… 不是 SKILL.md：…' }` |
| 文件不存在 / 不是普通文件 / 读不出 / 空文件 / 按 topic 找不到那一节 | 500 | `{ ok:false, code:'unavailable', error:'<具体原因>' }` |

最后一行是**失败关闭**的读不到：不会回一段空文本让模型硬编，也不会抛未捕获异常把桥接打挂
（端点内部 try/catch，并 `log('[zx] …')` 记一行）。撞到 `unavailable` 就把原因说给对方，
或者干脆按自己的判断回答，**不要**换个 topic 反复试。

## 生效方式

- **桥接**（端点）改完需重启桥接：`start.bat` 的守护循环会在进程退出后 5 秒自动拉起，
  也可以在控制台点「重启」，或 `POST /api/restart`。
- **MCP 工具**：`mcp-snowluma-safe.js` 按会话 spawn，**新会话**才拿到新工具清单；
  已在跑的会话要重建（控制台重置该会话，或等它重建）。
- **skill 正文**：改 `SKILL.md` 立即生效（mtime 变了就重读），无需重启任何东西。

## 自检

```bash
node scripts/test-zx-perspective.mjs
```

23 条用例，全部走 `scripts/audit-bridge-harness.mjs` 起的**真实 HTTP 控制台**（真源码、真
`startConsoleServer`、真读文件），覆盖 topic 归一（含 `rules` → `all` 且不带那一节）、
小节切分边界、「默认 all 不含角色扮演规则」、4000 字截断、mtime 缓存（改内容 + 按回 mtime →
仍回旧正文；mtime 前进 → 立刻生效）、表达DNA 标签行剥离、`dir` 指到非 `SKILL.md` 的文件 →
`unavailable`、文件缺失/小节缺失/空文件 → `unavailable`、`allowKeys: []` fail-closed、
非 `group:1131654608` → 403、无/错令牌 → 403、生产路径（`x-agent-call: 1`）真令牌 200，
外加真实 skill 的冒烟（三节、`chars < 3436`、不含「角色扮演」字样）。

这个测试**没有**注册进 `scripts/test-audit.mjs`（由收尾统一接入），可以单独跑。

## 未取得

- 没有管理端 UI：改允许群只能改 `config.json`（或等后续把这四个字段接进控制台）。
- 只有这一个 skill、这一套 `topic`；没有「多 skill 路由」或按会话定制的默认 topic。
- 不做「张雪峰本人观点」的时效校验：skill 里是公开言论的提炼，可能落后于他最近的表达。
- **缓存只认 mtime**：如果有人用「先改内容、再把 mtime 改回原值」的方式还原文件（复制旧文件
  覆盖那种），缓存仍会返回上一次的正文，直到 mtime 再次变化。正常编辑（保存、`git checkout`）
  会让 mtime 前进，不受影响。
- 测试没覆盖「不带控制台令牌」这条（整站闸门在控制台其它端点已有覆盖），`allowKeys: []` 已补。
