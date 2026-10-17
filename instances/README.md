# 多实例约定

同一台机器上可以同时跑多个 bot。每个 bot 是一个**实例**：一份配置文件、一个数据库
文件、一个控制台端口；人格库只有一份，所有实例共享。

`src/schema.js` 的 13 张表都没有 `bot_id` 列，所以隔离的单位不是"同一数据库里的行"，
而是**整个数据库文件**。这样 `store`、`ledger`、`schema` 都不用改，回滚也只是换一个
`DATABASE_PATH`。

## 命名

```
^[a-z0-9][a-z0-9_-]{0,23}$
```

小写字母、数字、下划线、短横线，以字母或数字开头，最多 24 个字符。名字会变成目录名
和锁文件名，所以不允许大写（Windows 上大小写不敏感，`Alpha` 和 `alpha` 会撞成同一个
文件）和大写路径之外的字符；不允许点号，避免 `alpha.env.bak` 被当成实例。

## 目录

| 路径 | 内容 | 是否提交 |
| --- | --- | --- |
| `instances/<name>.env` | 实例配置，结构与根 `.env` 相同 | 否（`.gitignore` 已忽略） |
| `instances/README.md` | 本文件 | 是 |
| `data/bots/<name>/autochat.sqlite` | 该实例的数据库 | 否（`data/` 已忽略） |
| `data/bots/<name>/autochat.lock` | 该实例的 bot 单实例锁 | 否 |
| `data/autochat-supervisor-<name>.lock` | 该实例的 supervisor 互斥锁 | 否 |
| `personas/` | 共享人格库，实例只引用不复制 | — |

`data/bots/<name>/` 由 `src/store.js` 在首次开库时创建，`add` 不预先建目录。

## 配置项

实例文件由 `.env.example` 复制而来，三个键由脚本改写，其余与单实例完全一样：

- `DATABASE_PATH=data/bots/<name>/autochat.sqlite` —— 每个实例独立的数据库。
- `CONSOLE_PORT=<分配值>` —— `add` 从 3200 起找第一个未被占用的端口，已声明的实例
  端口和根 `.env` 的端口都算被占用。
- `PERSONA_DIR=personas` —— 显式写出，强调人格库是共享的：一张人格卡可以被多个 bot
  选用，改一次对所有实例生效。

`CONSOLE_ENABLED` 在模板里默认是 `false`，即实例默认不开控制台；打开后每个实例需要
自己的 `CONSOLE_TOKEN`（至少 16 位），并访问 `http://127.0.0.1:<CONSOLE_PORT>`。

`BOT_QQ` 必须每个实例不同；`ONEBOT_WS_URL` 也要指向各自的 NapCat（不同端口或不同
`NAPCAT_WORKDIR`），否则两个 bot 会抢同一条 OneBot 连接。

## 命令

```
node scripts/instances.js list
node scripts/instances.js add alpha
node scripts/instances.js check
node scripts/instances.js render alpha
```

- `list`：名称、QQ、控制台端口、运行状态、数据库路径。
- `add <name>`：生成 `instances/<name>.env`，已存在则拒绝覆盖（`INSTANCE_EXISTS`）。
- `check`：实例名合法、端口互不冲突、数据库路径互不重复、`BOT_QQ` 不重复；有问题的
  逐条列出并以非 0 退出。错误码：`INVALID_INSTANCE_NAME`、`PORT_CONFLICT`、
  `PORT_INVALID`、`DATABASE_DUPLICATE`、`BOT_QQ_DUPLICATE`、`INSTANCE_MISSING`、
  `INSTANCE_UNREADABLE`、`INSTANCE_INVALID`、`TEMPLATE_MISSING`、`PORT_UNAVAILABLE`。
- `render <name>`：打印该实例的生效配置；所有名字里含 key/token/secret/password 的
  变量都会打码（只留尾 4 位，短值只显示 `<已设置>`，空值显示 `<未设置>`）。

本批**不加** npm script，直接用 `node` 调用。

## 启动

```
node scripts/supervisor.js --instance alpha
node scripts/supervisor.js --instance alpha --status
```

- 子进程加载 `instances/<name>.env`，并注入 `AUTOCHAT_INSTANCE=<name>`，控制台以后
  可以据此显示"我在管哪个号"。
- supervisor 的互斥锁按实例区分：`data/autochat-supervisor-<name>.lock`；bot 锁仍由
  实例的 `DATABASE_PATH` 推导为 `data/bots/<name>/autochat.lock`。
- 不带 `--instance` 时读根 `.env`、锁仍是 `data/autochat-supervisor.lock`，行为与
  多实例功能加入之前完全一致。

注意：`scripts/start-autochat.ps1` 会先用 `.env` 启动 supervisor 再起 bot，所以
`--instance` 的子进程环境会先删掉实例文件声明过的键，再让 `--env-file` 填入实例值；
否则 Node 的 `--env-file` 不会覆盖已存在的环境变量，第一个实例会读到根 `.env` 的配置。

## 判定"是否在运行"

与单实例同一判据：读该实例的 `data/bots/<name>/autochat.lock`（`src/lifecycle.js`
的 `lockPathFor` 按数据库目录推导），锁里 `pid` 指向的进程还活着即为运行中。没有第二
份真相源，也不看 `runtime/autochat.pid`。

## 已知限制

- `add` 只避开"已声明的端口"和根 `.env` 的端口，**不探测操作系统实际占用的端口**；
  端口被别的程序占用时 `check` 发现不了，要等实例真正启动才会报错。
- 控制台前端还没有实例切换界面：一个实例一个端口、一个面板，登录态不互通。
- 多实例只做了骨架与约定，尚未真起过两个实例做端到端验证。
