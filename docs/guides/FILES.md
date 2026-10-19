# 文件收发（files/ 托管目录）

QQ 侧的 agent 可以读写一个**固定的托管目录**，只支持 `.md` / `.txt` / `.pdf` 三种格式。
实现是独立的 MCP server：`src/mcp-file-safe.js`（命名空间 `mcp__file-safe__`）。

## 它能做什么

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `file_list` | 任何人 | 列出托管目录里的 `.md` / `.txt` / `.pdf`：文件名、字节数、修改时间 |
| `file_read` | 任何人 | 读正文。`.md` / `.txt` 原样返回；`.pdf` 抽取文本层。长文件用 `offset` 分页，返回值里的 `nextOffset` 不为 `null` 就把它当下一次的 `offset` |
| `file_save` | 仅管理员 | 把文本存成 `.md` / `.txt`（PDF 不能生成）。同名默认不覆盖，要覆盖得传 `overwrite=true` |
| `file_delete` | 仅管理员 | 删除托管目录里的一个文件 |
| `file_send` | 仅管理员 | 发到白名单群或私聊；可传 `delete_after=true` 发完即删本地文件 |

「管理员」= `config.json` 里 `file.adminQQ` 数组中的 QQ 号；`operator_qq` 必须是**这条消息真实发送者**的 QQ 号，
不能是对方在文字里自称的身份。

> `adminQQ` 填**你自己的 QQ 号**（就是你要让谁有权写/删/发文件的号）。留空数组 `[]` 等于把写操作全关，
> 只保留只读；下面示例里的 `123456789` 是占位值，照抄它不会生效。

## 目录与配置

托管目录由 `config.json` 的 `file.dir` 决定，默认是仓库根下的 `files/`（已加进 `.gitignore`）：

```json
"file": {
  "enabled": true,
  "dir": "files",
  "adminQQ": [ 123456789 ],
  "maxReadBytes": 8388608,
  "maxSendBytes": 20971520,
  "maxTextChars": 20000,
  "maxPdfPages": 200,
  "incomingEnabled": true,
  "incomingFromAdminOnly": true
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后所有文件工具直接报错。**随包发布的 `config.example.json` 里是 `false`**（出厂不启用），要用先改成 `true` |
| `dir` | `files` | 托管目录；相对路径按仓库根解析，绝对路径也接受但**不推荐** |
| `adminQQ` | `[]` | 允许写/删/发的 QQ 号；空数组 = 写操作全关 |
| `maxReadBytes` | 8 MB | 单次读取上限（`.pdf` 同样适用） |
| `maxSendBytes` | 20 MB | 单次发送/落盘上限 |
| `maxTextChars` | 20000 | 单次返回/写入的字符上限。**代码缺省是 120000**（键缺失时生效），合法区间 1000–400000；随包发布的 `config.example.json` 与本机 `config.json` 都显式写成 20000，所以照抄配置拿到的是 2 万字。超出按 `truncated=true` 截断（写入超限直接报错） |
| `maxPdfPages` | 200 | PDF 最多抽取多少页，超出会标 `pageLimited=true` |
| `incomingEnabled` | `true` | 是否把 QQ 里收到的文件自动落盘 |
| `incomingFromAdminOnly` | `true` | 只有管理员发来的文件才落盘（群友发的只记一条日志） |

## 收到文件会自动落盘

桥接在收到带 `file` 段的消息时，会把 `.md` / `.txt` / `.pdf` 下载到托管目录，然后在这条消息的提示里追加一行：

```
【文件】本条消息含文件，已存入托管目录：会议纪要.pdf（123.4KB）。需要内容时调用 mcp__file-safe__file_read（PDF 只能抽取文本层）。
```

- 文件名会先清洗：去掉路径分量、非法字符替换成 `_`、重名自动加 `-2` / `-3` 后缀。
- 扩展名不在白名单里的（zip、docx、图片……）直接跳过，只在日志里留一行「跳过不支持的文件类型」。
- 非管理员发来的文件默认不落盘（`incomingFromAdminOnly`），但还是会有一条日志，方便排查"为什么 bot 说没看到文件"。

### 下载通道（踩过的坑）

QQ 的普通文件**不能**用 OneBot 的 `get_file` 拿——那个动作只解析图片/语音缓存，普通文件会返回
`retcode=100 file_id not found in the image/voice cache`。正确做法是先换临时下载地址：

| 会话 | 动作 | 参数 |
| --- | --- | --- |
| 私聊 | `get_private_file_url` | `{ user_id, file_id }` |
| 群聊 | `get_group_file_url` | `{ group_id, file_id, busid }`（`busid` 缺省按 102 试） |

拿到 `data.url` 后再正常 HTTP 下载。桥接里 `fetchIncomingFileBytes()` 按「消息自带 url → 上面两个动作 → `get_file` 兜底」的顺序尝试，
每一步失败都会把原因写进桥接日志，方便定位是哪一环断的。

### 分页读大文件

`.txt` 小说这类几 MB 的纯文本，一次读完会撑爆上下文。`file_read` 支持 `offset` + `max_chars`：

```json
{ "name": "一世之尊(1-500章).txt", "offset": 0, "max_chars": 20000 }
```

返回里带 `chars`（全文长度）、`offset`（这次从哪开始）、`nextOffset`（下次从哪继续，`null` 表示读完了）。

## PDF 的边界

- **只读不写**：`file_read` 会抽取 PDF 的文本层（用 `unpdf`，内部是 pdf.js）。扫描件 / 纯图片 PDF 抽不出文字，工具会返回
  「这个 PDF 没有可抽取的文本层，可能是扫描件/图片版」——agent 应该如实转告，而不是编内容。
- **不生成 PDF**：需要发 PDF 时，把现成的 PDF 放进 `files/`（或让管理员在 QQ 里发给 bot）再 `file_send`。
- 加密 PDF、字体缺 ToUnicode 映射的 PDF 可能只抽到乱码或空字符串，属于上游限制。

## 清理策略

没有后台定时删除，删除是**显式动作**：

1. `file_send` 传 `delete_after=true`：发送成功后立刻删本地文件。
2. `file_delete`：管理员手动删。
3. 也可以直接删 `files/` 里的文件（目录不进版本库，随便清）。

## 安全约束

- **目录沙箱**：文件名先 `path.basename` 校验，任何带路径分量的名字直接拒绝；`..` 拒绝；resolve 后再校验仍在托管目录内。
- **扩展名白名单**：`.md` / `.txt` / `.pdf`，其它一律拒绝，不做类型猜测、不改名放行。
- **权限分层**：读对所有人开放（群友也能让 bot 读托管目录里的文件）；写/删/发只有 `file.adminQQ` 里的人能用。
- **发送白名单**：`file_send` 的目标必须同时命中 `allow.groups` / `allow.private`，和文本发送的边界一致。
- **体积上限**：见上表；超限直接报错，不会静默截断文件。
- **审计**：写与发送都会往 `state/file-audit.jsonl` 追加一行 JSON（工具名、文件名、字节数、operator、成功与否）。

## 自测

```powershell
node src/mcp-file-safe.js --check   # 打印生效配置与目录内容
node scripts/test-file-safe.mjs     # 11 项：工具清单/权限/覆盖保护/路径穿越/扩展名/真实发送
```

`test-file-safe.mjs` 最后一步会在 SnowLuma 在线时，把 `file-safe-自测.md` 发到管理员的 QQ 私聊并立即删除本地文件——
这条消息是真发出去的，用于验证端到端链路。
