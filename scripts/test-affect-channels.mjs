#!/usr/bin/env node
/**
 * 情绪宣泄的**出口通道契约**（T-012 第七步：私聊 owner / 写日记两个备用出口）。
 *
 * 为什么是静态断言而不是单测：三个出口函数都长在 bridge.js 的 `startConsoleServer()` 闭包
 * 里（依赖 loadConfig / socialV2 状态 / OneBot 连接），import 它等于真的起一个控制台服务；
 * 派发顺序也没有抽成纯函数（抽出去要动结构，而这次改动的重点就是接线本身）。
 * 所以这里钉的是「接线长什么样」：谁调谁、失败怎么降级、哪些字段不许出现。
 *
 * 纯函数部分另有归属：判定阶梯在 test-affect-vent.mjs，状态机在 test-affect-core.mjs，
 * 文案三件套在 test-affect-text.mjs；「真发那条链路」的细节在 test-affect-vent-run.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8').replace(/\r\n/g, '\n');

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

/** 从 startAnchor 切到 endAnchor（不含）。两个锚点都必须找得到，否则返回 '' 让断言直接红。 */
function slice(startAnchor, endAnchor) {
  const start = BRIDGE.indexOf(startAnchor);
  if (start < 0) return '';
  const end = endAnchor ? BRIDGE.indexOf(endAnchor, start + startAnchor.length) : BRIDGE.length;
  if (end < 0) return '';
  return BRIDGE.slice(start, end);
}

// ── 切片 ────────────────────────────────────────────────────────────────────
const qzoneFn = slice('async function publishQzonePost(', 'async function publishVentPrivate(');
const privateFn = slice('async function publishVentPrivate(', '/**\n     * 宣泄出口③');
const diaryFn = slice('async function publishVentDiary(', '    // ── 文案会话：与黑话学习会话同构');
const runFn = slice('async function runAffectVent(', 'const server = http.createServer(');
const dispatch = slice('const vents = affect.vents ?? {};', 'const { channel, published } = delivered;');
const accounting = slice('const { channel, published } = delivered;', 'const server = http.createServer(');
const dayKeyFn = slice('function localDayKey(', 'function ventCountToday(');
const countFn = slice('function ventCountToday(', '/**');
const snapshotFn = slice('function affectSnapshot(', 'function qzoneCall(');
const maxCharsFn = slice('function ventTextMaxChars(', '/**\n     * 生成一条宣泄文案');
const proactiveFn = slice('function scheduleProactiveCheckV2(', 'function clearSocialV2Timers(');

// ── ① 三个出口都在，且各自带得出「哪一层失败了」 ───────────────────────────
console.log('① 三个出口函数与失败分层');

check('切到 publishQzonePost / publishVentPrivate / publishVentDiary', qzoneFn !== '' && privateFn !== '' && diaryFn !== '');
check('说说失败分层：disabled / audit / quota / onebot', ["layer: 'disabled'", "layer: 'audit'", "layer: 'quota'", "layer: 'onebot'"].every((needle) => qzoneFn.includes(needle)));
check('私聊失败分层：disabled / rate / onebot', ["layer: 'disabled'", "layer: 'rate'", "layer: 'onebot'"].every((needle) => privateFn.includes(needle)));
check('日记失败分层：diary', diaryFn.includes("layer: 'diary'"));
// 内容审计只属于公开的说说通道：私聊/日记都不调 auditContent（日记是私有文件，私聊只发 owner）
check('私聊不跑 auditContent', !privateFn.includes('auditContent('));
check('日记不跑 auditContent', !diaryFn.includes('auditContent('));
check('说说仍跑 auditContent', qzoneFn.includes('auditContent('));

// ── ② 私聊目标只能是 owner ──────────────────────────────────────────────────
console.log('② 私聊目标只能是 owner');

check('私聊 owner 只取自 cfg.ownerQQ', privateFn.includes("const owner = String(cfg.ownerQQ ?? '').trim();"));
check('私聊函数没有目标参数（targetId / to）', !privateFn.includes('targetId') && !/async function publishVentPrivate\(\{[^}]*to/.test(privateFn));
check('私聊会话 key 为 private:<owner>', privateFn.includes('const key = `private:${owner}`;'));
check('私聊拒绝无 owner（no_owner）', privateFn.includes("reason: 'no_owner'"));
check('私聊复用 sendMessagesV2（不直连 OneBot）', privateFn.includes('await sendMessagesV2(key, [text], [], null, null)') && !privateFn.includes('oneBotAction'));
check('私聊复用端点限频（sendTimes + 每分钟/每小时）', privateFn.includes('st.sendTimes.push(now)') && privateFn.includes('maxPerMinute > 0') && privateFn.includes('maxPerHour > 0'));
check('私聊失败回滚预占额度', privateFn.includes('filter((t) => t !== now)'));

// 唯一调用点在降级循环里，且只传 content（目标不能从调用方来）
check('publishVentPrivate 只有一个调用点', (BRIDGE.match(/await publishVentPrivate\(\{/g) ?? []).length === 1);
check('调用私聊时只传 content', dispatch.includes('await publishVentPrivate({ content: text })'));

// ── ③ 日记：按互通组归一的 key + ownerQQ 缺失时 no_owner ────────────────────
console.log('③ 日记出口');

check('日记 key 经 diaryKeyFor 归一（T-016 共用本子）', diaryFn.includes('const diaryKey = diaryKeyFor(`private:${owner}`)') && diaryFn.includes('key: diaryKey'));
check('日记走 DIARY_ROOT + append', diaryFn.includes('root: DIARY_ROOT') && diaryFn.includes("mode: 'append'"));
check('日记缺 owner 直接拒（不落 private:undefined）', diaryFn.includes("reason: 'no_owner'") && !diaryFn.includes('private:undefined'));
check('日记成功回 date', diaryFn.includes('return { ok: true, date: data.date };'));
check('publishVentDiary 只有一个调用点', (BRIDGE.match(/await publishVentDiary\(\{/g) ?? []).length === 1);
check('调用日记时带 content + now', dispatch.includes('await publishVentDiary({ content: text, now })'));

// ── ④ 降级阶梯：plan.channel 先试，失败按 qzone→private→diary ──────────────
console.log('④ 降级顺序与记账边界');

check('首选 plan.channel，其余按 VENT_CHANNELS 顺序补齐', dispatch.includes(': [plan.channel, ...VENT_CHANNELS.filter((channel) => channel !== plan.channel)];'));
check('已试过的不重复（filter 掉 plan.channel）', dispatch.includes('channel !== plan.channel'));
check('静默时段只允许日记（failed diary 不降级到私聊）', dispatch.includes("? ['diary']"));
check('caps 不允许 → daily_cap（跳过，不算失败）', dispatch.includes('if (capsForChannel[channel] !== true) {') && dispatch.includes("reason: 'daily_cap'"));
check('vents 关闭 → disabled_channel', dispatch.includes('if (vents[channel] !== true) {') && dispatch.includes("reason: 'disabled_channel'"));
check('文案过不了闸门 → text_rejected（换下一个出口）', dispatch.includes("reason: 'text_rejected'"));
check('发送失败 → 记 attempt 后 continue', dispatch.includes("reason: published.reason ?? 'send_failed'") && dispatch.includes('continue;'));
check('全失败返回 send_failed + attempts', dispatch.includes("if (!delivered) {") && dispatch.includes("reason: 'send_failed'") && dispatch.includes('detail: { attempts, emotion: plan.emotion, text }'));
check('全失败之前没有任何记账（dispatch 切片无 applyVent / writeAffectState）', !dispatch.includes('applyVent(') && !dispatch.includes('writeAffectState'));
check('applyVent 在全失败早退之后', runFn.indexOf('applyVent(') > 0 && runFn.indexOf('applyVent(') > runFn.indexOf('if (!delivered) {'));
check('成功才补 ventLog 的 channel / ok / text', accounting.includes("? { ...vent, channel, ok: true, reason: '', text }"));
check('qzone 成功仍由 publishQzonePost 落盘（这里不重复写）', !accounting.includes('writeQzoneState'));

// ── ⑤ caps 真实化：按本地日、只数 ok === true ─────────────────────────────
console.log('⑤ caps 来自 ventLog 当日成功计数');

check('localDayKey 用本地日期（不是 toISOString）', dayKeyFn.includes('date.getFullYear()') && !dayKeyFn.includes('toISOString'));
check('ventCountToday 只数 ok === true', countFn.includes('vent?.ok === true'));
check('ventCountToday 按 channel 过滤', countFn.includes('vent.channel === channel'));
check('ventCountToday 按本地日过滤', countFn.includes('localDayKey(Number(vent.ts)) === day'));
check('runAffectVent 的 private 额度 = 当日成功数 < dailyCap.private', runFn.includes("private: ventCountToday(state, 'private', now) < Math.max(0, Number(dailyCap.private) || 0)"));
check('runAffectVent 的 diary 额度 = 当日成功数 < dailyCap.diary', runFn.includes("diary: ventCountToday(state, 'diary', now) < Math.max(0, Number(dailyCap.diary) || 0)"));
check('runAffectVent 不再把 private / diary 写死 true', !runFn.includes('private: true') && !runFn.includes('diary: true'));
check('affectSnapshot 的 caps 用同一个 helper', snapshotFn.includes("ventCountToday(state, 'private', ts)") && snapshotFn.includes("ventCountToday(state, 'diary', ts)"));
check('affectSnapshot 不再把 private / diary 写死 true', !snapshotFn.includes('private: true') && !snapshotFn.includes('diary: true'));

// ── ⑥ 文案：按通道取上限，且发送前一律过 checkVentText ────────────────────
console.log('⑥ 文案闸门与通道上限');

check('ventTextMaxChars 分通道取上限', maxCharsFn.includes('AFFECT_TEXT_MAX_CHARS.qzone') && maxCharsFn.includes('AFFECT_TEXT_MAX_CHARS.private') && maxCharsFn.includes('AFFECT_TEXT_MAX_CHARS.diary'));
check('generateVentText 用 ventTextMaxChars(channel, qz)', BRIDGE.includes('maxChars: ventTextMaxChars(channel, qz)'));
check('checkVentText 在发送之前', runFn.indexOf('checkVentText(') > 0 && runFn.indexOf('checkVentText(') < runFn.indexOf('await publishQzonePost('));
check('每个通道都单独过闸门（channel 变量）', runFn.includes('checkVentText(candidate, recentTexts, channel, { maxChars })'));

// ── ⑦ proactive 概率联调 + 定时器作用域 ───────────────────────────────────
console.log('⑦ proactive 情绪加成 / 定时器作用域');

check('概率乘 1 + 0.6 × 最大强度并夹到 1', proactiveFn.includes('prob = Math.min(1, prob * (1 + 0.6 * maxIntensity));'));
check('加成长度在既有乘数之后、空闲门槛之前', proactiveFn.indexOf('0.6 * maxIntensity') > proactiveFn.indexOf('aiCount >= 5') && proactiveFn.indexOf('0.6 * maxIntensity') < proactiveFn.indexOf('if (idle >= idleThreshold'));
check('加成日志带前后概率与主导情绪', proactiveFn.includes('主动检查概率 ${before.toFixed(2)} → ${prob.toFixed(2)}（主导 ${dominant} ${maxIntensity.toFixed(2)}）'));
check('既有短路保持原样（enabled / paused / 模式）', proactiveFn.includes('cfg.socialV2?.proactive?.enabled === false') && proactiveFn.includes('socialV2.paused || currentMode !== \'reserved2\''));
check('情绪模块关掉时不加成', proactiveFn.includes('if (affectCfg?.enabled !== false)'));

const ventDefAt = BRIDGE.indexOf('async function runAffectVent(');
const timerAt = BRIDGE.indexOf('if (cfg.socialV2?.affect?.enabled !== false) {');
const httpServerAt = BRIDGE.indexOf('const server = http.createServer(');
check('宣泄定时器与 runAffectVent 同作用域（否则 ReferenceError）', ventDefAt > 0 && timerAt > ventDefAt && httpServerAt > timerAt);
check('定时器仍每 10 分钟、仍 unref', BRIDGE.slice(timerAt, httpServerAt).includes('10 * 60 * 1000') && BRIDGE.slice(timerAt, httpServerAt).includes('.unref?.()'));

// ── 文案会话容器的作用域（2026-10-21 线上事故的回归） ──────────────────────
// 事故经过：ventSessions 这四行被塞进了 startConsoleServer() 里，而**读方** pumpMux 在 main
// 作用域。于是每来一帧事件走到 `if (ventSessions.has(...))` 就抛
// `ReferenceError: ventSessions is not defined` → 事件流断开重连 → 会话永远「繁忙」→
// 群里的 @ 与拍一拍全部无响应。这里钉住「声明必须在 startConsoleServer 之前」。
const consoleFnAt = BRIDGE.indexOf('function startConsoleServer() {');
const ventDeclAt = BRIDGE.indexOf('const ventSessions = new Set();');
const pumpMuxAt = BRIDGE.indexOf('async function pumpMux() {');
check('ventSessions 声明在 startConsoleServer 之前（main 作用域）',
  ventDeclAt > 0 && consoleFnAt > 0 && ventDeclAt < consoleFnAt,
  `decl=${ventDeclAt} consoleFn=${consoleFnAt}`);
check('ventSessions 只有一处声明（没留下重复 const）',
  BRIDGE.split('const ventSessions = new Set();').length - 1 === 1);
check('pumpMux 与 ventSessions 不同在 startConsoleServer 内（读方在 main）',
  pumpMuxAt > 0 && pumpMuxAt > consoleFnAt && BRIDGE.slice(pumpMuxAt, pumpMuxAt + 60000).includes('ventSessions.has('));

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
process.exit(failed > 0 ? 1 : 0);
