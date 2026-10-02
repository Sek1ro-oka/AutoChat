# 手动修改配置与管理服务

所有命令先在 PowerShell 切换到项目目录：

```powershell
cd E:\AutoChat
```

## 人设／预设

默认人设在 `src/persona.js`。编辑反引号之间的中文提示词，保留 `export const DEFAULT_PERSONA =` 和末尾的反引号、分号；若文字中包含反引号或 `${`，需要按 JavaScript 语法转义。

另一种方式是编辑 `.env` 的 `SYSTEM_PROMPT`，填写自己完整的人设；它会覆盖默认预设。例如：

```dotenv
SYSTEM_PROMPT="你是一位熟悉网络梗的傲娇女生。说话简短、嘴毒，闲聊时偶尔只回梗和反问；对方要求认真回答时正面作答。"
```

保留 `SYSTEM_PROMPT=` 空值即可继续使用 `src/persona.js` 的默认预设。修改后重启服务；旧聊天上下文仍保留，想完全从新人设开始可以在相应私聊／群 @ 中发送 `/清空`。

## 私聊白名单与群

编辑本机 `.env`，不要改 `.env.example`：

- `PRIVATE_USER_QQS`：多个 QQ 号用英文逗号隔开。添加时在现有列表后追加，删除时移除对应号码。此字段有值时优先于旧 `PRIVATE_USER_QQ`。
- `GROUP_QQS`：多个响应群用英文逗号隔开，有值时优先于兼容字段 `GROUP_QQ`。新增群在现有列表后追加。机器人需要已经在对应群；白名单设置不会自动加好友或加群。不同群、不同成员上下文独立，各群分别每 72 小时清理；所有群和私聊共用每日预算。
- `GROUP_QQ`：兼容单群配置，`GROUP_QQS` 为空时使用。
- `ADMIN_QQ`：管理员 QQ，默认取私聊列表的第一个号码，建议明确填写。普通白名单用户不自动获得管理权限。

添加一人不需要修改旧的单用户字段。修改名单和群号后运行 `npm run bot:restart`。更改响应群只影响机器人回复，不解散 QQ 群，也不自动退群。

管理员 `/群关闭`、`/群开启` 控制全部白名单群；`/状态` 列出各群的下一次清理时间。

## 其他常用配置

### 违禁词与关键词固定回复

编辑 `.env`，用英文逗号分隔多个词。例如（仅为格式示例，请替换为自己的词）：

```dotenv
BLOCK_TERMS=违禁词一,违禁词二
TRIGGER_TERMS=关键词一,关键词二
GROUP_KEYWORD_WITHOUT_AT=false
```

消息包含任意违禁词，就直接回复“我是什么都不会告诉你的”；包含触发关键词，就回复命中的关键词本身，例如配置“你好”后，“你好呀”会回复“你好”。两类输入命中都不调用模型、不花模型额度、不写入对话上下文。违禁词优先；同时命中多个关键词时，回复配置列表中排列最靠前的命中项。采用子串匹配，英文字母忽略大小写，不使用正则表达式。留空表示关闭对应列表。`BLOCK_TERMS` 同时检查模型输出；模型输出被拦截时，已经发生的 API 费用仍会记账。`TRIGGER_TERMS` 只检查用户输入，不检查模型输出。

默认仅处理白名单私聊和目标群的 @ 消息；设置 `GROUP_KEYWORD_WITHOUT_AT=true` 后，目标群未 @ 时也会针对这两类词固定回复，其余普通群消息继续忽略。其他群和未授权私聊不触发。固定回复仍遵守限流、去重、全局停用及群停用；管理和清空、状态命令优先处理。改完双击 `restart.cmd` 生效。

输入命中规则时，整条用户消息和本地固定回复都不会保存到 AI 对话上下文，也不会带入之后的模型请求；已有的正常聊天历史继续保留。这条规则对私聊与白名单群聊都适用。

| 字段 | 用途 |
| --- | --- |
| `MODEL_NAME` | 当前默认 deepseek-flash；切换模型时同时核验并更新价格 |
| `DAILY_BUDGET_CNY` | 全部私聊和群聊合计的每日人民币预算，当前为 1 |
| `MAX_OUTPUT_TOKENS` | 单次回答输出 token 上限，当前为 1024 |
| `CONTEXT_INPUT_TOKENS` | 输入容量上限，当前为 16000，使用保守估算 |
| `GROUP_CLEAR_HOURS` | 群上下文自动清理间隔，当前为 72 |
| `MODEL_TIMEOUT_MS` | 模型请求超时毫秒，当前为 60000 |
| `BLOCK_TERMS` | 输入／输出简单拦截词，英文逗号分隔 |
| `TRIGGER_TERMS` | 输入触发关键词，英文逗号分隔，回复命中的关键词本身 |
| `GROUP_KEYWORD_WITHOUT_AT` | true 允许目标群无需 @ 触发规则，默认 false |

群清理已保存的下一次截止时间不会因修改间隔立即重新计时；下一次到期后按新间隔推进。私聊不参与定时清理。

`DEEPSEEK_API_KEY`、`ONEBOT_ACCESS_TOKEN` 是密钥，不要发给别人或写入可提交的范例。修改 OneBot Token／端口后，还需要运行 `node --env-file=.env scripts/configure-napcat.js` 同步 NapCat 配置并重启 NapCat；单纯更换人设、名单和预算只需重启 AutoChat。

## 启动、停止、重启

```powershell
npm run bot:start
npm run bot:stop
npm run bot:restart
```

这些命令管理当前的后台 AutoChat 服务，不关闭 NapCat，也不关闭其他 QQ／Node 进程。重启会先检查配置，检查失败则保留现有运行服务。后台停止使用进程停止方式，建议等机器人当前回复完成后再执行；在途请求的未知费用预留会保留，不会因重启释放预算。

若要前台看日志，先 `npm run bot:stop`，再 `npm start`；按 Ctrl+C 停止前台服务。前台实例不由后台 PID 文件管理，不要同时启动前后台两个实例。

## 检查与排错

```powershell
npm run check
npm run check:connection
npm run status
```

分别是配置校验、真实 NapCat 连接检查、持久化事件和当日账本统计。`npm run check:model` 会真实调用模型并产生小额费用，其余上述诊断不调用模型。

AutoChat 日志在 `logs/`，启动输出／错误在 `runtime/autochat-output.log` 和 `runtime/autochat-error.log`。如重启后无回复，先检查连接，再检查白名单、群号、是否正确 @，以及管理员是否关闭了回复。

管理员可在 QQ 私聊中发送 `/状态`、`/停止`、`/启动`、`/群关闭`、`/群开启`。QQ 命令 `/停止` 只暂停模型回复，进程继续运行；它与 `npm run bot:stop` 的停止进程不同。
