# Windows 本机部署

## 压缩包双击部署

支持 Windows 10/11 x64，需要联网、可用的 QQ NT 客户端、机器人 QQ 账号以及 DeepSeek API 密钥。先从 [QQ 官网](https://im.qq.com/)安装 QQ NT；不要用桌面 QQ 同时登录机器人账号。

1. 下载 README 中的 Windows 部署包，完整解压到自己可写的目录（不要直接在压缩包中运行），双击 `deploy.cmd`。
2. 脚本优先使用已有 Node.js 24+；没有时下载并校验 Node.js 便携环境。随后下载并校验 NapCatQQ v4.18.28 官方包。首次下载可能较慢，失败后重新运行即可。
3. 首次填写机器人 QQ、英文逗号分隔的私聊白名单、群号、管理员 QQ，以及隐藏输入的 API 密钥。核对实际服务的人民币计价后填写输入／输出单价。OneBot Token 自动生成。默认模型 deepseek-flash，所有用户共用每天 1 元预算。
4. 脚本校验配置、同步 NapCat 接口并后台启动。打开 `runtime/napcat/cache/qrcode.png`，用手机 QQ 的机器人账号扫码确认；二维码可能需要数秒才生成。
5. 白名单用户私聊 `/帮助`，目标群 @ 机器人 `/帮助`，再测试普通问题。白名单不会自动加好友或加群，需要先建立相应 QQ 关系。

再次双击 `deploy.cmd` 保留已有 `.env`，已安装组件不会重新下载。修改配置后双击 `restart.cmd`；停止 AutoChat 双击 `stop.cmd`，NapCat 独立运行。便携 Node 不必加入系统 PATH。

自定义 QQ 位置可在 `.env` 设置 `QQ_EXECUTABLE=C:\你的目录\QQ.exe`。自动检测常见 Program Files、Program Files (x86)、LocalAppData 目录。QQ／NapCat 兼容性与设备验证可能需要人工处理；下载及校验失败不会绕过校验启动。

## 配置与诊断

终端命令均在解压后的 AutoChat 目录执行。使用系统 Node 时：

```powershell
npm run check
npm run check:connection
npm run status
```

使用便携 Node 时：

```powershell
.\runtime\node\node.exe --env-file=.env src/main.js --check
.\runtime\node\node.exe --env-file=.env scripts/connection-check.js
.\runtime\node\node.exe --env-file=.env scripts/status.js
```

配置校验不会调用模型；连接检查校验登录 QQ，不发消息。日志位于 `logs/` 和 `runtime/`。模型诊断发送一次小额真实请求，计入预算。

二维码过期时使用选定 Node 执行 `scripts/napcat-login.js --refresh`，重新打开二维码。WebUI 为 http://127.0.0.1:6099/webui/，访问 Token 在 `runtime/napcat/config/webui.json`，不要公开。提示同账号已登录时，退出该账号的其他桌面实例，再刷新二维码。

修改 OneBot Token、端口或机器人账号后，重新运行部署脚本同步接口，并停止本项目对应的 NapCat QQ 实例后重新启动。不要结束所有 QQ 进程。WebSocket 默认 127.0.0.1:3001、array 格式；WebUI 仅绑定回环地址。

## 费用与数据

价格须与实际模型服务一致，并在变价时更新。计费采用保守估算和账本预留，可能高于折扣账单；同一密钥在其他程序产生的费用不在本项目预算范围内。

`.env` 保存本机密钥，`data/` 保存对话和费用，`runtime/` 保存 NapCat 设备会话及组件。部署包不会携带这些内容。清空会话用 `/清空`，不要删除整个数据库，否则当日账本也会丢失。升级时保留自己的 `.env`、`data/`、`runtime/`。

项目已通过自动化测试和真实 QQ 私聊／群 @ 基础联调；尚未完成长期稳定性试运行，不能据此量化封号概率。