// 情绪宣泄「真的发一条说说」这条链路的静态契约测试（T-012 第五步）。
//
// 跑法：`node scripts/test-affect-vent-run.mjs`（全过 exit 0，有失败 exit 1）。
//
// 为什么是静态（读源码切片）而不是跑起来：这条链路的真跑需要 DSH 会话 + OneBot 网关 +
// QQ 空间，任何一条不在就会把「有没有接线」和「环境通不通」混在一起。真正吃逻辑的部分
// 已经在纯模块单测里覆盖了（test-affect-core / test-affect-vent / test-affect-text /
// test-affect-endpoints / test-affect-events），这一层只钉住**接线**：
//   ① publishQzonePost 是唯一发送出口：/api/qzone/post 与 runAffectVent 都调它，
//      端点里不再直接碰 auditContent / send_qzone_msg（否则闸门链迟早分叉）
//   ② 定时器：10 分钟一轮、带 enabled 开关判断、unref、启动日志一行
//   ③ dryRun 默认 true（函数签名与端点各一处）
//   ④ 两个端点都在 adminOnlyV2Paths 里，且排在既有事件端点之后
//   ⑤ applyVent 只出现在「发送成功」之后；失败分支与 dryRun 分支都不写状态
//   ⑥ 文案会话：8 秒兜底 + pickFallbackText，等待者容器与黑话学习互不共用
//
// 时间/环境：只读 src/bridge.js 的文本，不读 state/、不连网络。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const BRIDGE = read('src/bridge.js');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? `  — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

/**
 * 从 startAnchor 切到 endAnchor（不含）。两个锚点都必须找得到：
 * 找不到就返回 ''，让所有依赖它的断言直接红 —— 静默返回空串会让断言「意外通过」。
 */
function slice(startAnchor, endAnchor) {
  const start = BRIDGE.indexOf(startAnchor);
  if (start < 0) return '';
  const end = endAnchor ? BRIDGE.indexOf(endAnchor, start + startAnchor.length) : BRIDGE.length;
  if (end < 0) return '';
  return BRIDGE.slice(start, end);
}

// ── 切片 ────────────────────────────────────────────────────────────────────
const publishFn = slice('async function publishQzonePost(', '// ── 文案会话：与黑话学习会话同构');
const sessionFn = slice('async function ensureAffectVentSession(', '/** 等一个文案 turn 收尾');
const waitFn = slice('function waitVentTurn(', '/**\n     * 生成一条宣泄文案');
const generateFn = slice('async function generateVentText(', '/**\n     * 跑一次宣泄判定');
const runFn = slice('async function runAffectVent(', 'const server = http.createServer(');
const postHandler = slice(
  "if (req.method === 'POST' && url.pathname === '/api/qzone/post')",
  "if (req.method === 'POST' && url.pathname === '/api/qzone/delete')"
);
const ventEndpoint = slice(
  "url.pathname === '/api/socialV2/affect/vent'",
  "url.pathname === '/api/socialV2/affect/config'"
);
const configEndpoint = slice(
  "url.pathname === '/api/socialV2/affect/config'",
  "if (req.method === 'POST' && url.pathname === '/api/qzone/config')"
);
const adminBlock = slice('const adminOnlyV2Paths = [', '];');
const timerBlock = slice('// 情绪宣泄检查：每 10 分钟跑一轮', '情绪宣泄检查已安排');
const eventBranch = slice('// 情绪文案会话：与上面黑话学习**同构但完全独立**', '// 追踪当前 turn 是否成功调用过 MCP 发送类工具');

check('切到 publishQzonePost 函数体', publishFn !== '' && publishFn.includes('async function publishQzonePost('));
check('切到 runAffectVent 函数体', runFn !== '' && runFn.includes('async function runAffectVent('));
check('切到 /api/qzone/post handler', postHandler !== '' && postHandler.includes("'/api/qzone/post'"));
check('切到两个新端点', ventEndpoint !== '' && configEndpoint !== '');
check('切到 adminOnlyV2Paths', adminBlock !== '');
check('切到定时器注册块', timerBlock !== '');
check('切到事件消费分支', eventBranch !== '');

// ── ① 唯一发送出口 ─────────────────────────────────────────────────────────
console.log('① publishQzonePost 是唯一发送出口');

check('/api/qzone/post 调用 publishQzonePost', postHandler.includes('publishQzonePost('));
check('runAffectVent 调用 publishQzonePost', runFn.includes('publishQzonePost('));
check(
  '/api/qzone/post **不再**自己调 OneBot 发送',
  !postHandler.includes("'send_qzone_msg'") && !postHandler.includes('oneBotActionNested(')
);
check(
  '/api/qzone/post **不再**自己跑内容审计',
  !postHandler.includes('auditContent(') && !postHandler.includes('checkQuota(')
);
// 闸门顺序：开关 → 审计 → 配额 → 发送（任何一处提前返回都意味着没发出去）
const orderAudit = publishFn.indexOf('auditContent(');
const orderQuota = publishFn.indexOf('checkQuota(');
const orderSend = publishFn.indexOf("'send_qzone_msg'");
check(
  'helper 内部顺序为 审计 → 配额 → 发送',
  orderAudit > 0 && orderQuota > orderAudit && orderSend > orderQuota,
  `audit=${orderAudit} quota=${orderQuota} send=${orderSend}`
);
check('helper 先判开关 enabled', publishFn.indexOf('if (!qz.enabled)') > 0 && publishFn.indexOf('if (!qz.enabled)') < orderAudit);
check('helper 以拿到 tid 作为成功判据', publishFn.includes('没有 tid') && publishFn.includes('ok: true, tid: record.tid'));
check(
  '四种失败各带自己的 layer',
  ['disabled', 'audit', 'quota', 'onebot'].every((layer) => publishFn.includes(`layer: '${layer}'`))
);
// 响应结构保持不变：四个 layer 分支与原来的 ok:true 三件套都在 handler 里
check(
  '端点响应结构不变（layer + reasons/hits + retryAfterMs + tid/record/todayCount）',
  postHandler.includes("layer: 'audit'")
  && postHandler.includes('reasons: published.reasons')
  && postHandler.includes('retryAfterMs: published.retryAfterMs')
  && postHandler.includes('ok: true, tid: published.tid, record: published.record, todayCount: published.todayCount')
);

// ── ② 定时器 ───────────────────────────────────────────────────────────────
console.log('② 定时器（10 分钟）');

check('定时器周期为 10 分钟', timerBlock.includes('10 * 60 * 1000'));
check('定时器调 runAffectVent({ dryRun: false })', timerBlock.includes('runAffectVent({ dryRun: false })'));
check('定时器吞掉异常并记日志', timerBlock.includes('.catch(') && timerBlock.includes('[affect] 宣泄检查异常'));
check('定时器带 enabled 开关判断', timerBlock.includes('cfg.socialV2?.affect?.enabled !== false') || BRIDGE.includes("if (cfg.socialV2?.affect?.enabled !== false) {\n    const affectVentTimer = setInterval("));
check('定时器 unref（不拖住进程退出）', timerBlock.includes('.unref?.()'));
check('启动日志一行「情绪宣泄检查已安排（每 10 分钟）」', BRIDGE.includes("log('情绪宣泄检查已安排（每 10 分钟）')"));

// ── ③ dryRun 默认 true ─────────────────────────────────────────────────────
console.log('③ dryRun 默认 true');

check('runAffectVent 签名默认 dryRun = true', /async function runAffectVent\(\{ dryRun = true, force = false \} = \{\}\)/.test(runFn));
check('端点默认 dryRun:true（body.dryRun !== false）', ventEndpoint.includes('body?.dryRun !== false'));
check('dryRun 分支存在且只回报不发送', runFn.includes('if (dryRun) {') && runFn.includes('dryRun: true'));

// dryRun 分支切片：从 `if (dryRun)` 到真正发送那一行
const drySlice = (() => {
  const start = runFn.indexOf('if (dryRun) {');
  const end = runFn.indexOf('const published = await publishQzonePost(');
  return start >= 0 && end > start ? runFn.slice(start, end) : '';
})();
check('dryRun 分支不写状态文件', drySlice !== '' && !drySlice.includes('writeAffectState') && !drySlice.includes('applyVent'));
check('dryRun 分支不发送', drySlice !== '' && !drySlice.includes('publishQzonePost('));

// ── ④ 端点权限 ─────────────────────────────────────────────────────────────
console.log('④ 两个端点都在 adminOnlyV2Paths');

check('adminOnlyV2Paths 含 affect/vent', adminBlock.includes("'/api/socialV2/affect/vent'"));
check('adminOnlyV2Paths 含 affect/config', adminBlock.includes("'/api/socialV2/affect/config'"));
// 只读端点不能被顺手关掉（AI 应该能看见「我现在什么心情」）
check(
  '只读 GET /api/socialV2/affect 仍不在 adminOnlyV2Paths',
  !adminBlock.includes("'/api/socialV2/affect'")
);
// 新端点必须排在既有事件端点之后：test-affect-events / test-affect-endpoints 都按
// 「GET 情绪面板之后」这个位置做切片，插到前面会把它们的切片弄脏。
const eventsPos = BRIDGE.indexOf("url.pathname === '/api/socialV2/affect/events'");
const ventPos = BRIDGE.indexOf("url.pathname === '/api/socialV2/affect/vent'");
const configPos = BRIDGE.indexOf("url.pathname === '/api/socialV2/affect/config'");
check('新端点排在 affect/events 之后', ventPos > eventsPos && configPos > eventsPos, `events=${eventsPos} vent=${ventPos} config=${configPos}`);
check(
  'vent 与 config 都是 POST 端点',
  BRIDGE.includes("if (req.method === 'POST' && url.pathname === '/api/socialV2/affect/vent')")
  && BRIDGE.includes("if (req.method === 'POST' && url.pathname === '/api/socialV2/affect/config')")
);
// vent 端点的人为身份校验：ownerQQ 或空间管理员
check(
  'vent 端点校验 operatorQQ（owner 或空间管理员）',
  ventEndpoint.includes('cfg.ownerQQ') && ventEndpoint.includes('adminQQ.includes(operatorQQ)')
);

// ── ⑤ 记账只在成功之后 ─────────────────────────────────────────────────────
console.log('⑤ applyVent 只在成功分支');

const failSlice = (() => {
  const start = runFn.indexOf('if (!published.ok) {');
  const end = runFn.indexOf('const ventId = crypto.randomUUID();');
  return start >= 0 && end > start ? runFn.slice(start, end) : '';
})();
const successSlice = (() => {
  const start = runFn.indexOf('const ventId = crypto.randomUUID();');
  return start >= 0 ? runFn.slice(start) : '';
})();
check('切到失败分支与成功分支', failSlice !== '' && successSlice !== '');
check('applyVent 出现在 send 之后', runFn.indexOf('applyVent(') > runFn.indexOf('const published = await publishQzonePost('));
check('applyVent 不在失败分支里', failSlice !== '' && !failSlice.includes('applyVent('));
check('失败分支返回 reason: send_failed', failSlice.includes("reason: 'send_failed'"));
check('失败分支不写情绪状态', failSlice !== '' && !failSlice.includes('writeAffectState'));
check('成功分支才 writeAffectState', successSlice.includes('writeAffectState(next)'));
check('ventId 用 crypto.randomUUID()', successSlice.includes('crypto.randomUUID()'));
check('ventLog 的 ok 由调用方补成 true', successSlice.includes('ok: true') && successSlice.includes("channel: 'qzone'"));
check(
  '成功日志格式 [affect] 宣泄 channel=qzone emotion=… step=… tid=…',
  successSlice.includes('log(`[affect] 宣泄 channel=qzone emotion=${plan.emotion} step=${plan.step} tid=${published.tid}`)')
);
check('返回 ok:true 且带 tid', successSlice.includes('ok: true') && successSlice.includes('tid: published.tid'));

// 判定链：planVent 失败原样返回；非 qzone 出口明确报 channel_not_ready
check('planVent 失败时原样返回 reason', runFn.includes("if (!plan.ok) return { ok: false, reason: plan.reason"));
check('非 qzone 出口返回 channel_not_ready', runFn.includes("reason: 'channel_not_ready'"));
check("出口判定用 plan.channel !== 'qzone'", runFn.includes("if (plan.channel !== 'qzone')"));
check('disabled 早退', runFn.includes("if (affect.enabled === false) return { ok: false, reason: 'disabled' }"));
// caps：qzone 由 checkQuota 推，private/diary 本步恒 true
check(
  'caps 由 checkQuota 推出（qzone 真实额度）',
  runFn.includes('const quota = checkQuota({ now, posts: qzState.posts, cfg: qz })') && runFn.includes('qzone: quota.ok === true')
);
check('private / diary 本步恒 true', runFn.includes('private: true') && runFn.includes('diary: true'));
check('qzoneConfigured 来自 cfg.qzone.enabled', runFn.includes('qzoneConfigured: qz.enabled === true'));
check('静默时段用 inQuietHours', runFn.includes('inQuietHours(affect.quietHours'));
check('每次现读 config.json', runFn.includes('runtime = loadConfig()'));
// 文案去重取的是 content 字段（qzone-posts.json 里的字段名），不是 text
check('recentTexts 取 post.content', runFn.includes('post?.content'));
// 事件摘要在 affect-core 里的情绪字段叫 kind（normalizeEvent），不是 emotion
check('由头取同情绪事件的 kind 字段', runFn.includes('event?.kind === plan.emotion'));
// 文案质量闸门在发送之前
check(
  'checkVentText 排在 publishQzonePost 之前',
  runFn.indexOf("checkVentText(text, recentTexts, 'qzone'") > 0
  && runFn.indexOf("checkVentText(text, recentTexts, 'qzone'") < runFn.indexOf('const published = await publishQzonePost(')
);

// ── ⑥ 文案会话与 8 秒兜底 ──────────────────────────────────────────────────
console.log('⑥ 文案会话 / 8 秒兜底');

check('会话状态文件为 state/affect-vent-session.json', BRIDGE.includes("const AFFECT_VENT_SESSION_FILE = path.join(STATE_DIR, 'affect-vent-session.json')"));
check('会话工作区为 state/affect-agent', sessionFn.includes("path.join(STATE_DIR, 'affect-agent')"));
check('workspace 标题「情绪文案」', sessionFn.includes("const workspaceTitle = '情绪文案'"));
check(
  'preset 取 cfg.socialV2.agentPreset || cfg.agentPreset（strict）',
  sessionFn.includes('cfg.socialV2?.agentPreset || cfg.agentPreset') && sessionFn.includes('{ strict: true }')
);
check('follow 事件流', sessionFn.includes('api.events.follow('));
check('建/复用会话后 ensureChatModel', sessionFn.includes('ensureChatModel('));
check('会话 id 落盘复用', sessionFn.includes('atomicWriteJson(AFFECT_VENT_SESSION_FILE'));
check('换了 preset 就重建会话', sessionFn.includes('if (saved?.preset !== preset) invalidateAffectVentSession()'));

check('8 秒兜底常量 = 8000', BRIDGE.includes('const AFFECT_VENT_TEXT_TIMEOUT_MS = 8000'));
check('waitVentTurn 默认用 8 秒常量', waitFn !== '' && waitFn.includes('timeoutMs = AFFECT_VENT_TEXT_TIMEOUT_MS'));
check('generateVentText 有超时竞速', generateFn.includes('Promise.race([attempt, timeout])'));
check('generateVentText 失败回落 pickFallbackText', generateFn.includes('pickFallbackText(emotion, channel)'));
check("generateVentText 返回 source: 'template'", generateFn.includes("source: 'template'") && generateFn.includes("source: 'llm'"));
check('generateVentText 清洗模型输出', generateFn.includes('cleanVentText(raw)'));
check('迟到 reject 被吸收（不产生 unhandledRejection）', generateFn.includes('attempt.catch(() => {})'));
check('文案超时定时器 unref', generateFn.includes('timer.unref?.()'));

// 等待者容器必须与黑话学习完全分开（混用会让 8 秒的文案任务吃掉 2 分钟的学习 turn）
check('ventWaiters / ventCollectors / ventSessions 各自独立声明', BRIDGE.includes('const ventWaiters = new Map();') && BRIDGE.includes('const ventCollectors = new Map();') && BRIDGE.includes('const ventSessions = new Set();'));
check('事件消费分支处理 ventSessions', eventBranch.includes('if (ventSessions.has(frame.sessionId))'));
check('事件消费分支用 ventWaiters（不是 learnerWaiters）', eventBranch.includes('ventWaiters.get(') && !eventBranch.includes('learnerWaiters'));
check('事件消费分支用 ventCollectors', eventBranch.includes('ventCollectors.get('));
check('事件消费分支只在 turn/start 建 collector', eventBranch.includes("!ventCollector && frame.event.type === 'turn/start'"));
check('事件消费分支按 turn 结果 resolve/reject', eventBranch.includes("ventEnded.reason.kind === 'completed'"));
check('旧文案会话在 turn 结束后清理', eventBranch.includes('frame.sessionId !== ventSessionId'));

// 纯模块接线：三个文案纯函数必须真的从 affect-text.js 进桥接
check(
  'bridge 从 affect-text.js 引入三个纯函数',
  /import \{ cleanVentText, buildVentPrompt, pickFallbackText \} from '\.\/affect-text\.js';/.test(BRIDGE)
);
check('generateVentText 用 buildVentPrompt 拼提示词', generateFn.includes('buildVentPrompt({'));
check('applyVent 已在 affect-core 的 import 列表里', /^\s+applyVent,$/m.test(BRIDGE));

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
process.exit(failed > 0 ? 1 : 0);
