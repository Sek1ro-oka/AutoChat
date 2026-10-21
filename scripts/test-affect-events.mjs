#!/usr/bin/env node
// 情绪上报（T-012 第四步）：纯函数单测 + 接线静态契约。
//
// 为什么静态段只能读源码：src/bridge.js 在模块顶层就 loadConfig() 并 createServer()，
// import 它会真的把桥起起来、连上 QQ 会话 —— 测试里绝不能做这件事。
// 所以这里钉死两件事：
//   ① 端点形状与顺序：是 POST、落在 GET /affect 之后、照抄 feedback 的鉴权、
//      三道上限（≤3 条 / 单条 step 上限 / 每次最多 3 条）、只在真记上后落盘；
//   ② 上报的纯函数口径：normalizeEventInput 的正反例、shouldSkipEvent 的
//      duplicate / actor_rate 边界、inQuietHours 的跨午夜与左闭右开。
//
// 时间全部是常量假时钟（T0），不读系统时钟、不碰 state/、不连网络。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AFFECT_DEFAULTS,
  inQuietHours,
  normalizeAffectConfig,
  normalizeEventInput,
  shouldSkipEvent
} from '../src/affect-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 仓库源码在 Windows 下是 CRLF：统一折成 LF，跨行断言才不会被行尾符绊倒。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}`);
    return;
  }
  failures.push(name);
  console.log(`❌ ${name}${extra === undefined ? '' : ` —— ${extra}`}`);
}

const MINUTE = 60 * 1000;
/** 假时钟：北京时间 2026-10-20 10:00（和 test-affect-core.mjs 用同一个起点）。 */
const T0 = Date.parse('2026-10-20T10:00:00+08:00');

// ── 组一：normalizeEventInput 正反例 ───────────────────────────────────────
console.log('── 组一：normalizeEventInput 正反例 ────────────────────────');
const okEvent = normalizeEventInput({ kind: 'joy', step: 0.5 });
check('合法事件通过', okEvent.ok === true);
check('confidence 缺省 0.6', okEvent.ok === true && okEvent.event.confidence === 0.6);
check('source 缺省 llm', okEvent.ok === true && okEvent.event.source === 'llm');
check('没有 actorQQ 时不带该字段', okEvent.ok === true && !Object.hasOwn(okEvent.event, 'actorQQ'));

check('causeSummary 压成单行（空白折叠 + 去首尾）', (() => {
  const r = normalizeEventInput({ kind: 'anger', step: 1, causeSummary: '  被  说\n\n了  ' });
  return r.ok === true && r.event.causeSummary === '被 说 了';
})());
check('causeSummary 超长截到 80 字', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.25, causeSummary: 'x'.repeat(120) });
  return r.ok === true && r.event.causeSummary.length === 80;
})());
check('坏 kind → 拒绝，reason 带 kind', (() => {
  const r = normalizeEventInput({ kind: 'happy', step: 0.5 });
  return r.ok === false && r.reason.includes('kind');
})());
check('kind 缺省 / 非字符串 → 拒绝', normalizeEventInput({ step: 0.5 }).ok === false
  && normalizeEventInput({ kind: 1, step: 0.5 }).ok === false);
check('坏 step（0.3）→ 拒绝', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.3 });
  return r.ok === false && r.reason.includes('step');
})());
check('坏 step（2 / 0 / 缺省）→ 拒绝', normalizeEventInput({ kind: 'joy', step: 2 }).ok === false
  && normalizeEventInput({ kind: 'joy', step: 0 }).ok === false
  && normalizeEventInput({ kind: 'joy' }).ok === false);
check('confidence 低于 0.2 钳到 0.2', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, confidence: 0 });
  return r.ok === true && r.event.confidence === 0.2;
})());
check('confidence 高于 1 钳到 1', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, confidence: 9 });
  return r.ok === true && r.event.confidence === 1;
})());
check('confidence 是坏类型 → 回落 0.6', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, confidence: 'x' });
  return r.ok === true && r.event.confidence === 0.6;
})());
check('非对象（null / 数组 / 字符串）→ 拒绝',
  normalizeEventInput(null).ok === false
  && normalizeEventInput([]).ok === false
  && normalizeEventInput('joy').ok === false);
check('actorQQ 5 位数字保留', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, actorQQ: '12345' });
  return r.ok === true && r.event.actorQQ === 12345;
})());
check('actorQQ 12 位数字保留', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, actorQQ: '123456789012' });
  return r.ok === true && r.event.actorQQ === 123456789012;
})());
check('actorQQ 数字类型也认', (() => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, actorQQ: 123456 });
  return r.ok === true && r.event.actorQQ === 123456;
})());
check('actorQQ 非数字 / 位数不对 → 丢掉', [
  'ab12345', '1234', '1234567890123', '123456]', '', null
].every((actorQQ) => {
  const r = normalizeEventInput({ kind: 'joy', step: 0.5, actorQQ });
  return r.ok === true && !Object.hasOwn(r.event, 'actorQQ');
}));

// ── 组二：shouldSkipEvent 的 duplicate / actor_rate 边界 ───────────────────
console.log('── 组二：shouldSkipEvent 边界 ───────────────────────────────');
const eventAt = (ts, causeSummary, actorQQ) => ({
  ts, kind: 'joy', step: 0.5, causeSummary, ...(actorQQ ? { actorQQ } : {})
});
const stateWith = (events) => ({ events });

check('10 分钟内同一句 → duplicate',
  shouldSkipEvent(stateWith([eventAt(T0, '被夸了')]), { causeSummary: '被夸了' }, T0 + 5 * MINUTE).reason === 'duplicate');
check('正好 10 分钟（窗口含端点）→ duplicate',
  shouldSkipEvent(stateWith([eventAt(T0, '被夸了')]), { causeSummary: '被夸了' }, T0 + 10 * MINUTE).reason === 'duplicate');
check('10 分钟零 1 毫秒 → duplicate 失效',
  shouldSkipEvent(stateWith([eventAt(T0, '被夸了')]), { causeSummary: '被夸了' }, T0 + 10 * MINUTE + 1).skip === false);
check('同一句但发生在未来（时钟回拨）→ 不算重复',
  shouldSkipEvent(stateWith([eventAt(T0 + MINUTE, '被夸了')]), { causeSummary: '被夸了' }, T0).skip === false);
check('不同 causeSummary → 不跳过',
  shouldSkipEvent(stateWith([eventAt(T0, '被夸了')]), { causeSummary: '被骂了' }, T0 + MINUTE).skip === false);
check('空 causeSummary 不判重复（避免空串互相顶掉）',
  shouldSkipEvent(stateWith([eventAt(T0, '')]), { causeSummary: '' }, T0).skip === false);

const actorState3 = stateWith([
  eventAt(T0, 'a', 100001),
  eventAt(T0 + MINUTE, 'b', 100001),
  eventAt(T0 + 2 * MINUTE, 'c', 100001)
]);
const actorState2 = stateWith([
  eventAt(T0, 'a', 100001),
  eventAt(T0 + MINUTE, 'b', 100001)
]);
check('同一 actorQQ 已有 3 条 → 第 4 条 actor_rate',
  shouldSkipEvent(actorState3, { causeSummary: 'd', actorQQ: 100001 }, T0 + 30 * MINUTE).reason === 'actor_rate');
check('同一 actorQQ 只有 2 条 → 第 3 条放行',
  shouldSkipEvent(actorState2, { causeSummary: 'd', actorQQ: 100001 }, T0 + 30 * MINUTE).skip === false);
check('3 条都滑出 1 小时窗口 → 不再限流',
  shouldSkipEvent(actorState3, { causeSummary: 'd', actorQQ: 100001 }, T0 + 61 * MINUTE).skip === false);
check('不同 actorQQ 不算在同一个人头上',
  shouldSkipEvent(actorState3, { causeSummary: 'd', actorQQ: 100002 }, T0 + 30 * MINUTE).skip === false);
check('事件没有 actorQQ → 不判 actor_rate',
  shouldSkipEvent(actorState3, { causeSummary: 'd' }, T0 + 30 * MINUTE).skip === false);
check('actorQQ 是坏值（昵称）→ 不判 actor_rate',
  shouldSkipEvent(actorState3, { causeSummary: 'd', actorQQ: '某个群友' }, T0 + 30 * MINUTE).skip === false);
check('duplicate 优先于 actor_rate（顺序固定）', (() => {
  const dupAndRate = stateWith([
    eventAt(T0, '同一句', 100001),
    eventAt(T0 + MINUTE, 'b', 100001),
    eventAt(T0 + 2 * MINUTE, 'c', 100001)
  ]);
  return shouldSkipEvent(dupAndRate, { causeSummary: '同一句', actorQQ: 100001 }, T0 + 5 * MINUTE).reason === 'duplicate';
})());

// ── 组三：inQuietHours 跨午夜 ──────────────────────────────────────────────
console.log('── 组三：inQuietHours ──────────────────────────────────────');
const quiet = { enabled: true, start: '23:30', end: '07:30' };
check('23:45 在跨午夜窗口内', inQuietHours(quiet, 23, 45) === true);
check('06:59 在跨午夜窗口内', inQuietHours(quiet, 6, 59) === true);
check('07:30 整已出窗（左闭右开）', inQuietHours(quiet, 7, 30) === false);
check('12:00 不在窗口内', inQuietHours(quiet, 12, 0) === false);
check('23:30 整进窗（起点闭）', inQuietHours(quiet, 23, 30) === true);
check('23:29 还没进窗', inQuietHours(quiet, 23, 29) === false);
check('enabled=false 恒 false', inQuietHours({ ...quiet, enabled: false }, 3, 0) === false);
check('enabled 缺省也是 false', inQuietHours({ start: '23:30', end: '07:30' }, 3, 0) === false);
check('enabled 不是布尔 true（字符串）→ false', inQuietHours({ ...quiet, enabled: 'true' }, 3, 0) === false);
check('白天窗口 08:00–23:00：08:00 true / 22:59 true / 23:00 false',
  inQuietHours({ enabled: true, start: '08:00', end: '23:00' }, 8, 0) === true
  && inQuietHours({ enabled: true, start: '08:00', end: '23:00' }, 22, 59) === true
  && inQuietHours({ enabled: true, start: '08:00', end: '23:00' }, 23, 0) === false);
check('起止相同 → 视为没有窗口（不是静默一整天）',
  inQuietHours({ enabled: true, start: '12:00', end: '12:00' }, 12, 30) === false);
check('坏起点 / 坏终点 → false',
  inQuietHours({ enabled: true, start: '25:00', end: '07:30' }, 3, 0) === false
  && inQuietHours({ enabled: true, start: '23:30', end: '7:30' }, 3, 0) === false);
check('坏小时（24）/ 坏配置（null）→ false',
  inQuietHours(quiet, 24, 0) === false && inQuietHours(null, 3, 0) === false);
check('AFFECT_DEFAULTS.quietHours.enabled 出厂为 false', AFFECT_DEFAULTS.quietHours.enabled === false);
check('normalizeAffectConfig 只认显式 true', (() => {
  const on = normalizeAffectConfig({ quietHours: { enabled: true } });
  const off = normalizeAffectConfig({ quietHours: { enabled: 'true' } });
  const dflt = normalizeAffectConfig({});
  return on.quietHours.enabled === true && off.quietHours.enabled === false && dflt.quietHours.enabled === false;
})());

// ── 组四：bridge 的端点形状与鉴权（静态） ─────────────────────────────────
console.log('── 组四：bridge POST /api/socialV2/affect/events ───────────');
const bridge = read('src/bridge.js');
const EVENTS_PATH = '/api/socialV2/affect/events';
const eventsPathLines = bridge.split('\n').filter((line) => line.includes(`'${EVENTS_PATH}'`)).length;
check(`存在端点字面量 '${EVENTS_PATH}'`, eventsPathLines >= 1, `出现 ${eventsPathLines} 次`);
check('端点只在一处出现（分派处）', eventsPathLines === 1, `出现 ${eventsPathLines} 次`);
check('端点是 POST 分支（method 与 pathname 同时判定）',
  bridge.includes(`if (req.method === 'POST' && url.pathname === '${EVENTS_PATH}')`));

const getAffectLine = bridge.indexOf("if (req.method === 'GET' && url.pathname === '/api/socialV2/affect')");
const handlerStart = bridge.indexOf(`if (req.method === 'POST' && url.pathname === '${EVENTS_PATH}')`);
// 切片终点必须是**下一条端点分派**，不是下一条注释：注释边界会把后面的
// POST /api/socialV2/affect/config 一起吞进来，任何在两者之间新加的端点
// （例如 T-014 的自我资料四端点，里面有 oneBotActionNested）都会让「上报链路
// 不发送」这条断言误红。这里只切上报分支本身。
const handlerEnd = bridge.indexOf("if (req.method === 'POST' && url.pathname === '/api/socialV2/affect/config')", handlerStart);
const handler = handlerStart < 0 ? '' : bridge.slice(handlerStart, handlerEnd < 0 ? handlerStart + 4000 : handlerEnd);
check('端点排在 GET /api/socialV2/affect 之后', handlerStart > getAffectLine && getAffectLine > 0);
check('handler 切片取到完整分支', handler.length > 200 && handler.includes('sendJson('), `长度 ${handler.length}`);

// 鉴权：照抄 feedback —— 带 agent token 时令牌得对得上会话，且会话在模式允许范围内。
check('handler 读 x-agent-token', handler.includes("req.headers['x-agent-token']"));
check('handler 调 agentTokenOk(key, agentToken)', handler.includes('agentTokenOk(key, agentToken)'));
check('handler 调 v2SessionAllowed(key)', handler.includes('v2SessionAllowed(key)'));
check('handler 带 token 但没 key 时 400（key 不能为空）', handler.includes("'key 不能为空'"));
check('handler 令牌对不上 → 403 agent token 无效', handler.includes("'agent token 无效'"));

const adminStart = bridge.indexOf('const adminOnlyV2Paths = [');
const adminEnd = bridge.indexOf('];', adminStart);
const adminBlock = adminStart < 0 || adminEnd < 0 ? '' : bridge.slice(adminStart, adminEnd + 2);
check('解析到 adminOnlyV2Paths 数组', adminBlock.includes("'/api/socialV2/config'") && adminBlock.includes("'/api/socialV2/automation'"));
check('新端点**不在** adminOnlyV2Paths 里', adminBlock !== '' && !adminBlock.includes(`'${EVENTS_PATH}'`));

// 入参与上限：一次最多 3 条由 HTTP 层再兜一次（工具 schema 之外的第二道）。
check('非数组 / 空数组 → 400 events 必须是非空数组', handler.includes("Array.isArray(body?.events)") && handler.includes("'events 必须是非空数组'"));
check('超过 3 条 → 400 一次最多上报 3 条', handler.includes('rawEvents.length > 3') && handler.includes("'一次最多上报 3 条'"));
check('逐条走 normalizeEventInput(rawEvents[index])', handler.includes('normalizeEventInput(rawEvents[index])'));
check('归一失败进 rejected[]', handler.includes('rejected.push({ index, reason: normalized.reason })'));
check('归一成功再过 shouldSkipEvent(next, normalized.event, now)', handler.includes('shouldSkipEvent(next, normalized.event, now)'));
check('跳过进 skipped[]（带 reason）', handler.includes('skipped.push({ index, reason: verdict.reason })'));
check('其余进 addEvent(next, normalized.event, affectCfg, now)', handler.includes('addEvent(next, normalized.event, affectCfg, now)'));
check('有改动才落盘（applied.length > 0 才 writeAffectState）',
  handler.includes('if (applied.length > 0) writeAffectState(next);'));
check('writeAffectState 排在 addEvent 之后',
  handler.indexOf('addEvent(next, normalized.event, affectCfg, now)') < handler.indexOf('writeAffectState(next)'));
check('响应含 ok/now/applied/skipped/rejected/emotions/canVent',
  ['ok: true', 'now', 'applied', 'skipped', 'rejected', 'emotions', 'canVent:'].every((key) => handler.includes(key)));
check('emotions 只有 {key,label,intensity,dose} 四个读数',
  handler.includes('key: emotionKey') && handler.includes('label: AFFECT_LABELS[emotionKey]') && handler.includes('intensity: emotion.intensity') && handler.includes('dose: emotion.dose'));
check('上报链路不发送（handler 不调 OneBot / fetch）', !/oneBotAction|fetch\(/.test(handler));
check('上报链路不起定时器（handler 无 setInterval / setTimeout）', !/\bsetInterval\b|\bsetTimeout\b/.test(handler));
check('bridge import 了三个上报纯函数',
  ['inQuietHours,', 'normalizeEventInput,', 'shouldSkipEvent'].every((name) => bridge.slice(0, bridge.indexOf('const __dirname')).includes(name)));

// B2：面板的 quiet 必须是真判定，不再是写死的 false。
const snapshotStart = bridge.indexOf('function affectSnapshot(');
const snapshot = snapshotStart < 0 ? '' : bridge.slice(snapshotStart, bridge.indexOf('\nfunction ', snapshotStart + 1));
check('affectSnapshot 用 inQuietHours 判静默（本地时分由 Date 取）',
  snapshot.includes('inQuietHours(affect.quietHours, localNow.getHours(), localNow.getMinutes())'));
check('affectSnapshot 不再写死 quiet: false', !snapshot.includes('quiet: false'));
check('affectSnapshot 把 quiet 传给 planVent', /quiet,\n/.test(snapshot) || snapshot.includes('quiet,'));
check('affectSnapshot 返回 quiet（面板可见）', snapshot.includes('quiet,'));

// ── 组五：MCP 工具声明（静态） ─────────────────────────────────────────────
console.log('── 组五：mcp-snowluma-safe.js 的 qq_affect_report ──────────');
const mcp = read('src/mcp-snowluma-safe.js');
const mcpDecl = mcp.indexOf("server.tool(\n  'qq_affect_report',");
check("存在 server.tool('qq_affect_report', ...) 声明", mcpDecl >= 0);
check('工具描述含「不要为了触发发说说」', mcp.includes('不要为了触发发说说'));
check('工具描述写明一次 1–3 条', mcp.includes('一次 1–3 条'));
check('排在 qq_report_feedback 之后',
  mcpDecl > mcp.indexOf("server.tool(\n  'qq_report_feedback',") && mcp.indexOf("server.tool(\n  'qq_report_feedback',") > 0);
check('排在 qq_get_my_recent_messages 之前', mcpDecl < mcp.indexOf("server.tool(\n  'qq_get_my_recent_messages',"));
check('schema 限制 1–3 条（.min(1).max(3)）', mcp.includes('.min(1).max(3)'));
check('step 只允许四档（z.literal 0.25/0.5/0.75/1）',
  ['z.literal(0.25)', 'z.literal(0.5)', 'z.literal(0.75)', 'z.literal(1)'].every((lit) => mcp.includes(lit)));

const mcpBlockEnd = mcp.indexOf('\nserver.tool(', mcpDecl);
const mcpBlock = mcpDecl < 0 ? '' : mcp.slice(mcpDecl, mcpBlockEnd < 0 ? mcpDecl + 3000 : mcpBlockEnd);
check('工具 POST /api/socialV2/affect/events', mcpBlock.includes(EVENTS_PATH) && mcpBlock.includes("method: 'POST'"));
check('工具带 x-agent-token 头', mcpBlock.includes("'x-agent-token': token"));
check('工具把 events 原样放进 body', mcpBlock.includes('{ key, events }'));
const asyncBlock = mcpBlock.slice(mcpBlock.indexOf('async ({ key, token, events })'));
check('工具实现段取到', asyncBlock.length > 100);
check('返回值**不提**会不会发说说（实现段不出现「发说说」）', !asyncBlock.includes('发说说'));
check('返回值不出现 qzone / 发送动作', !asyncBlock.includes('qzone') && !asyncBlock.includes('qq_qzone_post'));

// ── 组六：提示词里的一行（静态） ──────────────────────────────────────────
console.log('── 组六：qq_get_prompt 的提示词拼装 ───────────────────────');
check('bridge 含「情绪上报：qq_affect_report」', bridge.includes('情绪上报：qq_affect_report'));
check('提示词带括号说明（不保证会发说说）', bridge.includes("hint: '情绪上报：qq_affect_report（不保证会发说说）'"));
check('提示词用独立 affect 字段（不混进 enabledTools）',
  bridge.includes("reportTool: 'qq_affect_report'") && bridge.includes('enabled: cfg.socialV2?.affect?.enabled !== false'));
const promptStart = bridge.indexOf('const toolMap = {');
const promptEnd = bridge.indexOf("if (req.method === 'GET' && url.pathname === '/api/socialV2/unread')", promptStart);
const promptBlock = promptStart < 0 ? '' : bridge.slice(promptStart, promptEnd < 0 ? promptStart + 6000 : promptEnd);
check('提示词拼装在 /api/socialV2/prompt 的 sendJson 里', promptBlock.includes('enabledTools,') && promptBlock.includes('情绪上报：qq_affect_report'));
check('affect 字段排在 enabledTools 之后（同一份 payload）',
  promptBlock.indexOf('enabledTools,') < promptBlock.indexOf('情绪上报：qq_affect_report'));

// ── 收尾 ───────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log('');
if (failures.length === 0) {
  console.log(`结果：${passed}/${total} passed`);
  process.exit(0);
}
console.log(`结果：${total - failures.length}/${total} passed，${failures.length} 项失败：`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
