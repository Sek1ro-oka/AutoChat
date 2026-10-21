// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 控制台「情绪」面板（T-012 第七步）：视图/导航一一对应、四个端点、真发按钮的二次确认边界
  'test-console-affect.mjs',
  // 控制台令牌来源判定与 cookie 边界（纯函数）：以 `/api/` 开头的路径与一切非 GET 永不读 cookie，
  // cookie 只在 `GET /`、`GET /demo` 上参与，且只在"人是拿 url/header 令牌进来的"时才下发。
  'test-console-auth.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // 会话永久繁忙看门狗（ISS-001）：事件流半开挂住时 turn 永远不结束，
  // isConversationBusyV2() 就会永久为真、该会话永远拒收投递。这里用假时钟钉住三件事：
  //   · 计龄按「最近活动」的四个锚点取 max（合法的 10 分钟长轮询不得被判僵尸）；
  //   · 软 15 分钟只告警，硬 30 分钟要连续 2 轮确认才动手（QQ_BRIDGE_WATCHDOG=off 只软不硬）；
  //   · 清理顺序：先打僵尸标记 → 再 session.cancel → 最后清本地账本（队列条目必须整条删）。
  'test-stall-watchdog.mjs',
  // QQ 空间说说（T-006）的纯逻辑模块：配置归一 / 内容审计 / 日限与间隔 / 可见范围 / 记录裁剪。
  // 模块零依赖零 I/O、时钟由 now 注入，所以这里能钉死六条审计规则的正反例与 clamp 边界。
  'test-qzone-post.mjs',
  // 同一条链路的接线契约（纯静态读源码，不 import bridge.js —— import 会真起服务）：
  // 三端点是否落在令牌关卡之后、闸门顺序是否 disabled → audit → quota → OneBot、
  // MCP 三工具是否都注册且描述里带「不代发」红线。
  'test-qzone-endpoints.mjs',
  // 情绪状态机（T-012 第一步）：四维强度的软饱和累积 / 半衰期衰减 / 剂量积分 /
  // canVent 五道闸门的 reason 与 retryAfterMs 都是纯函数，时钟由 now 注入，
  // 所以这里能钉死「第 3 次才触发」「冷却 45 分钟」「30 分钟后约剩一半」这类时序断言。
  'test-affect-core.mjs',
  // 宣泄决策器（T-012 第二步）：闸门顺序、出口降级链、文案质量闸门（URL/@/手机号/
  // 3-gram 去重）。同样是纯函数，不连网不发消息。
  'test-affect-vent.mjs',
  // 情绪接线的只读契约（T-012 第三步）：端点是否存在且只读、配置归一入口、
  // 状态文件路径、样例配置与出厂默认是否对齐、桥接里有没有偷偷写死阈值。
  'test-affect-endpoints.mjs',
  // 情绪上报（T-012 第四步）：POST /api/socialV2/affect/events 的接线契约 +
  // normalizeEventInput / shouldSkipEvent / inQuietHours 的纯函数边界。
  // 同样只读源码（import bridge 会真起服务）+ 直接 import 纯模块跑。
  'test-affect-events.mjs',
  // 文案三件纯函数的单测（T-012 第五步）：清洗模型输出、拼提示词、
  // 兜底模板逐条过 checkVentText。零 IO，纯字符串断言。
  'test-affect-text.mjs',
  // 宣泄真发这条链路的静态契约（T-012 第五步）：publishQzonePost 是唯一发送出口、
  // 十分钟定时器、dryRun 默认 true、两个端点在 adminOnlyV2Paths、applyVent 只在成功分支、
  // 文案会话 8 秒兜底且等待者与黑话学习互不共用。
  'test-affect-vent-run.mjs',
  // 三个宣泄出口的通道契约（T-012 第七步）：私聊只发 owner、日记 key 带 private: 前缀、
  // 失败按 qzone→private→diary 降级、全失败不记账、caps 来自 ventLog 当日成功计数、
  // proactive 概率乘 1 + 0.6×情绪强度。出口函数在 startConsoleServer 闭包里，
  // import 会真起服务，所以这里只做静态切片断言。
  'test-affect-channels.mjs',
  // 自我资料（T-014 第一步 / T-015）：profile-core 的纯函数边界——清洗/长度按码点、
  // 昵称与签名的形状审计、4 小时 5 次滑动窗口额度与 60 秒最小间隔、状态读写归一。纯函数，零 IO。
  'test-profile-core.mjs',
  // 自我资料的桥接接线（T-014 第二步）：五个端点（头像 GET + 快照 GET + 三个改资料
  // POST）的形状与闸门顺序（enabled→内容→额度→读旧值→OneBot→读回→记账）、
  // not_applied 不记账、头像 640→100 回落、状态用 atomicWriteJson、profile 不进
  // adminOnlyV2Paths。import bridge 会真起服务，所以只读源码。
  'test-profile-endpoints.mjs',
  // 自我资料的 MCP 工具（T-014 第三步 / T-015）：五个工具名与描述红线（拒绝别人的改名要求、
  // 额度是 4 小时 5 次的滑动窗口硬约束）、qq_get_avatar 的 image content 形状、
  // agentApi 把 400/403/429 的 reason/retryAfterMs 透传给模型。含 node --check。
  'test-profile-tools.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
