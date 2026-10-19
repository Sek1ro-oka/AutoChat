#!/usr/bin/env node
// QQ 空间说说：三个桥接端点 + 三个 MCP 工具的契约测试。
//
// 为什么是「静态」而不是真起服务：src/bridge.js 在模块顶层就 loadConfig() 并 createServer()，
// import 它会真的把桥接跑起来、把 QQ 会话接上去——测试里绝不该做这件事。
// 所以这里只做两件事：
//   ① 读源码文本，断言「端点在哪、闸门顺序如何、鉴权关卡是否在前面」（结构契约）；
//   ② import 阶段一的纯逻辑模块，用真函数跑端到端组合（行为契约）。
//
// 覆盖任务书 §五 要求的五组（组六是 T-007b 追加的控制台开关部分）：
//   组一 三个路径字面量存在，且都在令牌关卡之后（继承鉴权，没另写一套）
//   组二 闸门顺序 disabled → audit → quota → OneBot（源码顺序）
//   组三 oneBotActionNested 的调用点带 send_qzone_msg / delete_qzone_msg
//   组四 MCP 三工具都注册了，且每条描述都含「不代发」红线
//   组五 纯函数端到端：审计优先于配额、ugcRight 只可能 1/4/64、缺省配置永远 disabled、
//        滑动窗口（windowHours / windowCap）与两个 0 的语义
//   组六 控制台开关端点：位置/类型闸门/写盘口径、删除的 x-agent-call 分流、recent 的读数，
//        以及出厂样例 config.example.json 的口径（新键齐全、legacy 键不写进样例）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyQzoneConfigUpdate,
  auditContent,
  checkQuota,
  normalizeQzoneConfig,
  pickUgcRight,
  prunePosts,
  QZONE_DEFAULTS
} from '../src/qzone-post.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 统一把 CRLF 折成 LF：仓库里的源码在 Windows 下是 CRLF，跨行断言不该被行尾符绊倒
// （行号计算只按 '\n' 计数，所以折完行号仍然是对的）。
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
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return -1;
  return text.slice(0, index).split('\n').length;
}
function allLinesOf(text, needle) {
  const lines = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    lines.push(text.slice(0, index).split('\n').length);
    from = index + needle.length;
  }
  return lines;
}

const bridge = read('src/bridge.js');
const mcp = read('src/mcp-snowluma-safe.js');
const qzonePure = read('src/qzone-post.js');

console.log('── 组一：路径字面量与鉴权顺序 ──────────────────────────────');
// 令牌关卡：所有 /api 请求都必须先过它。端点行号在它之后 = 静默继承了整套鉴权，
// 而不是在别处另开一个免鉴权入口。
const tokenLine = lineOf(bridge, 'resolveRequestToken({');
check('桥接里能定位到令牌关卡 resolveRequestToken({', tokenLine > 0, `行号 ${tokenLine}`);
const QZONE_PATHS = ['/api/qzone/post', '/api/qzone/delete', '/api/qzone/recent'];
for (const rel of QZONE_PATHS) {
  const lines = allLinesOf(bridge, `'${rel}'`);
  check(`存在端点字面量 ${rel}`, lines.length > 0, `出现 ${lines.length} 次`);
  check(`  ${rel} 位于令牌关卡之后（继承鉴权）`, lines.length > 0 && lines.every((n) => n > tokenLine), `端点行 ${lines.join(',')} / 关卡行 ${tokenLine}`);
}
// 端点必须写在同一个 try 块里：跨 try 的 return 语义不同，也容易被后来的写手挪出鉴权区。
const tryLine = lineOf(bridge, "      try {\n        // 空 agent token 一律拒绝");
check('桥接存在承载 /api 分派的 try 块', tryLine > 0, `行号 ${tryLine}`);
check('三个端点都在该 try 块之后', tryLine > 0 && QZONE_PATHS.every((rel) => lineOf(bridge, `'${rel}'`) > tryLine));
// 三处集中关卡也要认这条路径，否则「暂停 AI / 关闭二代」对说说无效。
check('暂停 AI 时 agent 调用 /api/qzone/ 被拦', /socialV2\.paused[\s\S]{0,400}?startsWith\('\/api\/qzone\/'\)/.test(bridge));
check('二代模式关闭时 agent 调用 /api/qzone/ 被拦', /cfg\.socialV2\?\.enabled === false[\s\S]{0,400}?startsWith\('\/api\/qzone\/'\)/.test(bridge));
check('agent token 白名单放行 /api/qzone/', /const agentAllowed = [\s\S]{0,700}?startsWith\('\/api\/qzone\/'\)/.test(bridge));

console.log('\n── 组二：闸门顺序 disabled → audit → quota → OneBot ─────────');
const disabledLine = lineOf(bridge, "layer: 'disabled'");
const auditLine = lineOf(bridge, "layer: 'audit'");
const quotaLine = lineOf(bridge, "layer: 'quota'");
const sendLine = lineOf(bridge, "oneBotActionNested(cfg, 'send_qzone_msg'");
check('四处都能定位到', [disabledLine, auditLine, quotaLine, sendLine].every((n) => n > 0), `${disabledLine}/${auditLine}/${quotaLine}/${sendLine}`);
check('disabled 在 audit 之前', disabledLine > 0 && disabledLine < auditLine, `${disabledLine} < ${auditLine}`);
check('audit 在 quota 之前', auditLine > 0 && auditLine < quotaLine, `${auditLine} < ${quotaLine}`);
check('quota 在 OneBot 调用之前', quotaLine > 0 && quotaLine < sendLine, `${quotaLine} < ${sendLine}`);
// 空 enabled 时不可能走到审计：disabled 分支必须 return。
check('disabled 分支立即 return（不落到审计）', /layer: 'disabled'[\s\S]{0,200}?return;/.test(bridge));
check('audit 分支立即 return（不落到配额/发送）', /layer: 'audit'[\s\S]{0,200}?return;/.test(bridge));
// T-008 之后这一段多回传了 windowCount / windowCap，窗口从 400 放宽到 700；
// 语义没变：配额分支必须在 OneBot 调用之前 return（下面还有 quotaLine < sendLine 的行号断言兜底）。
check('quota 分支立即 return（不落到发送）', /layer: 'quota'[\s\S]{0,700}?return;/.test(bridge));
// 配额被拒时必须如实回传函数算出来的 retryAfterMs，不能自己编一个数字。
check('quota 拒绝时回传 checkQuota 的 retryAfterMs', /retryAfterMs: quota\.retryAfterMs/.test(bridge));
check('配额拒绝时一并回传 windowCount（窗口内条数）', /windowCount: quota\.windowCount/.test(bridge));
check('配额拒绝时一并回传 windowCap（区分「发满」与「暂停」）', /windowCount: quota\.windowCount[\s\S]{0,120}?windowCap: qz\.windowCap/.test(bridge));
check('暂停时用一句话说明，不套「等一会儿」的口径', /说说已暂停（windowCap 为 0）/.test(bridge));
check('桥接把 now 显式注入 checkQuota（时钟由 I/O 层给）', /const now = Date\.now\(\);\s*[\s\S]{0,220}?checkQuota\(\{ now,/.test(bridge));
check('审计用配置里的 maxChars', /auditContent\(content, \{ maxChars: qz\.maxChars \}\)/.test(bridge));
check('可见范围只来自 pickUgcRight', /ugc_right: ugcRight/.test(bridge) && /const ugcRight = pickUgcRight\(qz\)/.test(bridge));
// 成功以拿到 tid 为准：没有 tid 的 200 响应不算发出去。
check('成功判定读 tid（含 data.data.tid 兜底）', /data\?\.tid \?\? data\?\.data\?\.tid/.test(bridge));
check('拿不到 tid 时记日志并报 onebot 失败', /返回里没有 tid[\s\S]{0,400}?layer: 'onebot'/.test(bridge));

console.log('\n── 组三：OneBot 动作名 ────────────────────────────────────');
check("发布调用点带 'send_qzone_msg'", bridge.includes("oneBotActionNested(cfg, 'send_qzone_msg'"));
check("删除调用点带 'delete_qzone_msg'", bridge.includes("oneBotActionNested(cfg, 'delete_qzone_msg'"));
for (const action of ['send_qzone_msg', 'delete_qzone_msg']) {
  const re = new RegExp(`oneBotActionNested\\(cfg, '${action}',[\\s\\S]{0,160}?30000\\)`);
  check(`  ${action} 传了 30000ms 超时`, re.test(bridge));
}
check('只有网络类错误才重试（qzoneRetryableError 里判 error.code）', /function qzoneRetryableError\(error\)[\s\S]{0,200}?error\?\.code/.test(bridge));
check('状态文件路径是 state/qzone-posts.json', bridge.includes("'qzone-posts.json'"));
check('状态落盘复用 atomicWriteJson（不自己写临时文件）', /function writeQzoneState[\s\S]{0,240}?atomicWriteJson\(QZONE_STATE_FILE/.test(bridge));
check('每次请求现读状态文件（无进程内缓存）', /function readQzoneState\(\)[\s\S]{0,240}?readJsonSafe\(QZONE_STATE_FILE/.test(bridge));
check('删除走 qzone.adminQQ 管理员名单', /adminQQ\.includes\(operatorQQ\)/.test(bridge));
check('非管理员删除返回「需要管理员」', /需要管理员/.test(bridge));
check('删除看 retcode：非 0 也算失败（不能白抹本地记录）', /retcode !== undefined && retcode !== 0/.test(bridge));
check('删除失败的分支在写状态之前（失败不抹本地记录）', (() => {
  const failAt = bridge.indexOf("error: '删除失败，已记日志'");
  const writeAt = bridge.indexOf('writeQzoneState(kept, qz.windowCap)');
  return failAt > 0 && writeAt > failAt;
})());
check('loadConfig 把 qzone 归一进 cfg', /cfg\.qzone = normalizeQzoneConfig\(file\.qzone\)/.test(bridge));
// 状态文件保留条数必须跟着 windowCap 走：写死 50 的话，windowCap > 50 时窗口计数永远到不了上限。
check('保留条数按 windowCap 计算：max(50, windowCap + 20)', /function qzoneKeepPosts\(windowCap\)[\s\S]{0,220}?Math\.max\(50, cap \+ 20\)/.test(bridge));
check('  bridge 里没有 prunePosts(..., 50) 这种写死调用', !/prunePosts\([^()]*,\s*50\)/.test(bridge));
check('  写状态时把 windowCap 一并传进裁剪（两条路径都传）', /writeQzoneState\(\[record, \.\.\.state\.posts\], qz\.windowCap\)/.test(bridge) && /writeQzoneState\(kept, qz\.windowCap\)/.test(bridge));
// 老配置迁移：没有 windowCap 但有 dailyCap 时打一条 [qzone] 日志（迁移本身在纯函数里）。
check('loadConfig 对老配置打一条迁移日志', /usesLegacyDailyCap\(file\.qzone\)[\s\S]{0,400}?log\(`\[qzone\] 老配置迁移/.test(bridge));

console.log('\n── 组四：MCP 三个工具 + 「不代发」红线 ──────────────────────');
function toolBlock(name) {
  const marker = `'${name}'`;
  const start = mcp.indexOf(marker);
  if (start < 0) return '';
  const next = mcp.indexOf('server.tool(', start + marker.length);
  return mcp.slice(start, next < 0 ? mcp.length : next);
}
for (const name of ['qq_qzone_post', 'qq_qzone_recent', 'qq_qzone_delete']) {
  const block = toolBlock(name);
  check(`MCP 注册了工具 ${name}`, block !== '', '未找到工具名');
  check(`  ${name} 的描述含「不代发」红线`, block.includes('不代发'));
  check(`  ${name} 走 agentApi 访问桥接`, block.includes('agentApi('));
  check(`  ${name} 支持传会话令牌 x-agent-token`, block.includes("'x-agent-token'"));
}
const postBlock = toolBlock('qq_qzone_post');
check('qq_qzone_post 打到 /api/qzone/post', postBlock.includes("agentApi('/api/qzone/post'"));
check('qq_qzone_post 把 content 传给桥接', /JSON\.stringify\(\{ content/.test(postBlock));
const recentBlock = toolBlock('qq_qzone_recent');
check('qq_qzone_recent 打到 /api/qzone/recent', recentBlock.includes("agentApi('/api/qzone/recent'"));
check('qq_qzone_recent 说明这是「本机记录」', /本机记录/.test(recentBlock) && /不代表空间里的真实状态/.test(recentBlock));
const deleteBlock = toolBlock('qq_qzone_delete');
check('qq_qzone_delete 打到 /api/qzone/delete', deleteBlock.includes("agentApi('/api/qzone/delete'"));
check('qq_qzone_delete 传 operatorQQ', /operatorQQ: operator_qq/.test(deleteBlock));
check('拒绝原因被翻译成可执行的人话（disabled/audit/quota/onebot 四支）', ['disabled', 'audit', 'quota', 'onebot'].every((layer) => mcp.includes(`layer === '${layer}'`)));
check('agentApi 把结构化拒绝字段挂到 error 上（layer/retryAfterMs/reasons）', /error\.layer = body\.layer/.test(mcp) && /error\.retryAfterMs = body\.retryAfterMs/.test(mcp));
// T-008：窗口时长与条数只有桥接知道，MCP 层不再自己套「一天两条 / 六小时」的旧口径——
// 否则 windowCap: 0（暂停）会被翻译成「等一会儿就有额度」，把模型引向反复重试。
check('MCP 的配额提示直接采用桥接给的原因', mcp.includes("const why = message && message !== '[object Object]' ? message : '发布额度用完了'"));
check('MCP 不再写死旧口径（一天两条 / 六小时间隔）', !mcp.includes('一天最多两条') && !mcp.includes('至少六小时'));
check('qq_qzone_post 的描述改说「24 小时内最多 2 条」', postBlock.includes('最近 24 小时内最多 2 条'));

console.log('\n── 组五：纯函数端到端（闸门顺序与取值边界）─────────────────');
const cfg = normalizeQzoneConfig({ enabled: true, dailyCap: 2, minIntervalMs: 6 * 60 * 60 * 1000, maxChars: 300, ugcRight: 4 });
const at = Date.UTC(2026, 0, 1, 4, 0, 0); // 北京时间 12:00
const hour = 60 * 60 * 1000;
const flooded = [
  { tid: 'b', content: '第二条', ugcRight: 4, createdAt: at - 30 * 60 * 1000 },
  { tid: 'a', content: '第一条', ugcRight: 4, createdAt: at - 60 * 60 * 1000 }
];
const quotaFull = checkQuota({ now: at, posts: flooded, cfg });
check('今天两条之后日限生效', quotaFull.ok === false && quotaFull.reason === 'daily_cap', JSON.stringify(quotaFull));
check('  日限带 retryAfterMs 且来自纯函数', Number.isFinite(quotaFull.retryAfterMs) && quotaFull.retryAfterMs > 0 && quotaFull.retryAfterMs <= 24 * hour);
check('  todayCount 如实计数', quotaFull.todayCount === 2, String(quotaFull.todayCount));

const phone = auditContent('加我 13800138000 一起玩', { maxChars: 300 });
check('含手机号的内容被审计拦下', phone.ok === false && phone.reasons.includes('别把手机号贴出去'), JSON.stringify(phone.reasons));

// 端到端闸门：同一份输入「既超频又含手机号」时，必须先报 audit 而不是 quota。
// 这里用与桥接同序的判定链跑纯函数，钉的是「顺序语义」；
// 桥接源码里的顺序由组二单独钉住——两者一起才能说「顺序真的对了」。
function firstRejection({ content, posts, limit, now }) {
  if (!limit.enabled) return 'disabled';
  if (!auditContent(content, { maxChars: limit.maxChars }).ok) return 'audit';
  if (!checkQuota({ now, posts, cfg: limit }).ok) return 'quota';
  return null;
}
check('超频 + 含手机号 → 报 audit（审计优先于配额）', firstRejection({ content: '加我 13800138000', posts: flooded, limit: cfg, now: at }) === 'audit');
check('内容干净 + 超频 → 报 quota', firstRejection({ content: '今天天气不错，出去走了走', posts: flooded, limit: cfg, now: at }) === 'quota');
check('全部通过 → 放行', firstRejection({ content: '今天天气不错，出去走了走', posts: [], limit: cfg, now: at }) === null);
check('enabled:false 最优先（连审计都不做）', firstRejection({ content: '', posts: flooded, limit: normalizeQzoneConfig({}), now: at }) === 'disabled');

check('缺省配置永远是关的：normalizeQzoneConfig(undefined).enabled === false', normalizeQzoneConfig(undefined).enabled === false);
check('脏 enabled 不算开：{enabled:"yes"} → false', normalizeQzoneConfig({ enabled: 'yes' }).enabled === false);
check('脏值不抛错（adminQQ 给字符串）', (() => {
  try {
    const out = normalizeQzoneConfig({ enabled: true, adminQQ: 'not-a-list', minIntervalMs: 'x', dailyCap: null, maxChars: {}, ugcRight: 'A' });
    return out.enabled === true && Array.isArray(out.adminQQ) && out.ugcRight === 4;
  } catch {
    return false;
  }
})());

for (const value of [0, 1, 4, 16, 64, 128, '4', null, undefined, Number.NaN, 1e9, -4, 4.5]) {
  const picked = pickUgcRight({ ugcRight: value });
  check(`pickUgcRight(${String(value)}) 只可能 1/4/64`, [1, 4, 64].includes(picked), String(picked));
}
check('16（部分好友可见）回落 4', pickUgcRight({ ugcRight: 16 }) === 4);
check('128（部分好友不可见）回落 4', pickUgcRight({ ugcRight: 128 }) === 4);
check('可见范围白名单常量与模块一致', pickUgcRight({ ugcRight: 1 }) === 1 && pickUgcRight({ ugcRight: 64 }) === 64);

check('minIntervalMs 0 → 1 小时（clamp 到下限）', normalizeQzoneConfig({ minIntervalMs: 0 }).minIntervalMs === hour);
check('maxChars 10 → 50（clamp 到下限）', normalizeQzoneConfig({ maxChars: 10 }).maxChars === 50);
check('dailyCap 0 → 1（clamp 到下限）', normalizeQzoneConfig({ dailyCap: 0 }).dailyCap === 1);
check('prunePosts 按时间倒序且默认保留 50 条', (() => {
  const many = Array.from({ length: 60 }, (_, i) => ({ tid: `t${i}`, createdAt: at + i * 1000, content: 'x' }));
  const out = prunePosts(many);
  return out.length === 50 && out[0].tid === 't59';
})());

// 滑动窗口（T-008 起唯一的限流口径）：最近 windowHours 小时内最多 windowCap 条。
const windowCfg = normalizeQzoneConfig({ enabled: true, windowHours: 24, windowCap: 3 });
const fullWindow = checkQuota({
  now: at,
  posts: [
    { tid: 'c', createdAt: at - 1 * hour },
    { tid: 'b', createdAt: at - 5 * hour },
    { tid: 'a', createdAt: at - 20 * hour }
  ],
  cfg: windowCfg
});
check('滑动窗口：24h 内 3 条、cap 3 → 拒绝', fullWindow.ok === false && fullWindow.reason === 'daily_cap' && fullWindow.windowCount === 3, JSON.stringify(fullWindow));
check('  拒绝的 retryAfterMs 是最早一条滑出窗口的时刻（20h 前 → 4h）', fullWindow.retryAfterMs === 4 * hour, String(fullWindow.retryAfterMs));
const oneSlidOut = checkQuota({
  now: at,
  posts: [
    { tid: 'c', createdAt: at - 1 * hour },
    { tid: 'b', createdAt: at - 5 * hour },
    { tid: 'a', createdAt: at - 25 * hour }
  ],
  cfg: windowCfg
});
check('滑动窗口：最早那条滑出 24h 就放行（不是等自然日归零）', oneSlidOut.ok === true && oneSlidOut.windowCount === 2, JSON.stringify(oneSlidOut));

const pausedCfg = normalizeQzoneConfig({ enabled: true, windowCap: 0 });
const pausedQuota = checkQuota({ now: at, posts: [], cfg: pausedCfg });
check('windowCap=0 → 暂停：窗口空着也拒、retryAfterMs=0', pausedQuota.ok === false && pausedQuota.reason === 'daily_cap' && pausedQuota.retryAfterMs === 0, JSON.stringify(pausedQuota));
const dayCfg = normalizeQzoneConfig({ enabled: true, windowHours: 0, windowCap: 2 });
const dayQuota = checkQuota({ now: at, posts: [{ createdAt: at - 40 * 1000 }, { createdAt: at - 3 * hour }], cfg: dayCfg });
check('windowHours=0 → 退回北京自然日计数（上限仍是 windowCap）', dayQuota.ok === false && dayQuota.windowCount === 2 && dayQuota.todayCount === 2, JSON.stringify(dayQuota));
check('两个 0 不会被「Number(v) || 默认值」吞掉', normalizeQzoneConfig({ windowHours: 0, windowCap: 0 }).windowHours === 0 && normalizeQzoneConfig({ windowHours: 0, windowCap: 0 }).windowCap === 0);

const migratedCfg = normalizeQzoneConfig({ enabled: true, dailyCap: 2 });
check('老配置 dailyCap:2 迁移成「24 小时 2 条」并真的参与判定', migratedCfg.windowCap === 2 && migratedCfg.windowHours === 24 && checkQuota({ now: at, posts: flooded, cfg: migratedCfg }).reason === 'daily_cap');
check('控制台部分更新：只改 windowCap 不重置别的键', (() => {
  const base = normalizeQzoneConfig({ enabled: true, windowHours: 6, windowCap: 2, ugcRight: 1 });
  const r = applyQzoneConfigUpdate(base, { windowCap: 9 });
  return r.ok === true && r.qzone.windowCap === 9 && r.qzone.windowHours === 6 && r.qzone.ugcRight === 1;
})());
check('控制台部分更新：未知键 / 越界值都有确定结果', (() => {
  const base = normalizeQzoneConfig({ enabled: true });
  const unknown = applyQzoneConfigUpdate(base, { dailyCap: 5 });
  const clamped = applyQzoneConfigUpdate(base, { windowCap: 999 });
  return unknown.ok === false && clamped.ok === true && clamped.qzone.windowCap === 100 && clamped.clamped.includes('windowCap');
})());

console.log('\n── 组六：控制台开关端点与 recent 读数（T-007b）──────────────');
// ① 开关端点本身：位置在令牌关卡之后、同一个 try 块里 —— 否则就是另开了一个免鉴权入口。
const configLines = allLinesOf(bridge, "'/api/qzone/config'");
check('存在端点字面量 /api/qzone/config', configLines.length > 0, `出现 ${configLines.length} 次`);
check('  /api/qzone/config 位于令牌关卡之后（继承鉴权）', configLines.length > 0 && configLines.every((n) => n > tokenLine), `端点行 ${configLines.join(',')} / 关卡行 ${tokenLine}`);
check('  /api/qzone/config 与另外三个端点在同一个 try 块里', configLines.length > 0 && configLines.every((n) => n > tryLine));
const configBlock = (() => {
  const start = bridge.indexOf("url.pathname === '/api/qzone/config'");
  const end = bridge.indexOf("url.pathname === '/api/presets'", start);
  return start < 0 || end < 0 ? '' : bridge.slice(start, end);
})();
check('能定位到开关端点整块', configBlock.length > 0, `${configBlock.length} 字符`);
// ② 校验口径（T-008 起是部分更新）：桥接不再手写范围/类型判断，全部交给
//    applyQzoneConfigUpdate → normalizeQzoneConfig 这一套；类型闸门本身在纯模块里钉。
check('配置端点走 applyQzoneConfigUpdate（单一校验源）', /const patch = applyQzoneConfigUpdate\(before, body\)/.test(configBlock));
check('  桥接里没有第二份手写范围判断', !/windowCap\s*[<>]=?\s*100/.test(configBlock) && !/windowHours\s*[<>]=?\s*24/.test(configBlock) && !/typeof body\.enabled/.test(configBlock));
check('  enabled 类型闸门只在纯模块里（enabled 必须是布尔值 + 400 语义）', /typeof value !== 'boolean'[\s\S]{0,80}?enabled 必须是布尔值/.test(qzonePure));
check('  校验失败直接 400（不写盘）', /if \(!patch\.ok\) \{[\s\S]{0,100}?sendJson\(\{ ok: false, error: patch\.error \}, 400\)/.test(configBlock));
check('  以内存当前生效值为基线（部分更新不重置其他键）', /const before = normalizeQzoneConfig\(cfg\.qzone\)/.test(configBlock));
// ③ 写盘口径：读原始 config.json、只合并四个白名单键，且走 atomicWriteJson（临时文件 + rename）。
check('读原始 config.json（readConfigObject），不把归一化 cfg 整份写回', /readConfigObject\(configFile\)/.test(configBlock) && !/atomicWriteJson\(configFile, cfg\)/.test(configBlock));
check('  只合并 enabled / windowHours / windowCap / ugcRight 四个键', /enabled: patch\.qzone\.enabled,[\s\S]{0,160}?ugcRight: patch\.qzone\.ugcRight/.test(configBlock) && /file\.qzone = \{ \.\.\.\(file\.qzone \?\? \{\}\), \.\.\.next \}/.test(configBlock));
check('  legacy 键原样留在 config.json（不删 dailyCap / minIntervalMs）', !/delete file\.qzone/.test(configBlock) && !/dailyCap: undefined/.test(configBlock));
check('  写盘走 atomicWriteJson（临时文件 + rename）', /atomicWriteJson\(configFile, file\)/.test(configBlock));
check('  写盘成功之后才同步内存 cfg.qzone（顺序不可反）', (() => {
  const writeAt = configBlock.indexOf('atomicWriteJson(configFile, file)');
  const memAt = configBlock.indexOf('cfg.qzone = { ...(cfg.qzone ?? {}), ...next }');
  return writeAt > 0 && memAt > writeAt;
})());
check('  写盘失败返回 500 而不是谎报成功', /读写 config\.json 失败[\s\S]{0,40}?500\)/.test(configBlock));
check('  成功返回归一化后的值（qzone + clamped + configPath）', /sendJson\(\{ ok: true, configPath: 'config\.json', enabled: next\.enabled, qzone: next, clamped: patch\.clamped \}\)/.test(configBlock));
check('  只有真变化才记日志', configBlock.includes('if (before.enabled !== next.enabled) log(`[qzone] 控制台：说说功能已') && /if \(tuned\.length > 0\) log\(/.test(configBlock));
// ④ 删除的放行口径：带 x-agent-call 的是智能体（严格），不带的是控制台（已过令牌关卡）。
const deleteHandler = (() => {
  const start = bridge.indexOf("url.pathname === '/api/qzone/delete'");
  const end = bridge.indexOf("url.pathname === '/api/qzone/recent'", start);
  return start < 0 || end < 0 ? '' : bridge.slice(start, end);
})();
check('能定位到删除端点整块', deleteHandler.length > 0, `${deleteHandler.length} 字符`);
check('删除按 x-agent-call 分流（智能体调用 vs 管理端）', /req\.headers\['x-agent-call'\] !== undefined/.test(deleteHandler));
check('  智能体分支仍然校验 operatorQQ ∈ adminQQ', /agentCall\s*\?\s*Number\.isSafeInteger\(operatorQQ\)[\s\S]{0,120}?adminQQ\.includes\(operatorQQ\)/.test(deleteHandler));
check('  管理端分支直接放行（三元的 else 是 true）', /: true;/.test(deleteHandler));
check('  拒绝语气没变：需要管理员 + 403', /需要管理员[\s\S]{0,40}?403\)/.test(deleteHandler));
check('  管理端放行不等于不鉴权：删除仍在令牌关卡之后', lineOf(bridge, "url.pathname === '/api/qzone/delete'") > tokenLine);
// ⑤ recent 的两个新读数：只追加、不改名，且 ugcRight 必须是回落后的生效值。
const recentHandler = (() => {
  const start = bridge.indexOf("url.pathname === '/api/qzone/recent'");
  const end = bridge.indexOf("url.pathname === '/api/qzone/config'", start);
  return start < 0 || end < 0 ? '' : bridge.slice(start, end);
})();
check('能定位到 recent 端点整块', recentHandler.length > 0, `${recentHandler.length} 字符`);
check('recent 追加了 dailyCap', /dailyCap: qz\.dailyCap/.test(recentHandler));
check('recent 追加了 windowHours / windowCap / windowCount', /windowHours: qz\.windowHours/.test(recentHandler) && /windowCap: qz\.windowCap/.test(recentHandler) && /windowCount: quota\.windowCount/.test(recentHandler));
check('  windowCount 来自 checkQuota（不是控制台自己数 posts）', /windowCount: quota\.windowCount/.test(recentHandler));
check('  暂停（windowCap=0）时 nextAllowedAt 给 0，不编一个未来时间', /quota\.ok \|\| qz\.windowCap <= 0 \? 0 : now \+ quota\.retryAfterMs/.test(recentHandler));
check('recent 追加的 ugcRight 是 pickUgcRight 的回落值（不是 normalizeQzoneConfig 的原始字段）', /ugcRight: pickUgcRight\(qz\)/.test(recentHandler) && !/ugcRight: qz\.ugcRight/.test(recentHandler));
check('recent 原有五个键一个都没改名或换语义', ['ok: true', 'enabled: qz.enabled', 'posts: prunePosts(state.posts, 10)', 'todayCount: quota.todayCount', 'nextAllowedAt:'].every((key) => recentHandler.includes(key)));
check('recent 的 nextAllowedAt 仍是数字（0 或时间戳），没被改成对象', !/nextAllowedAt: \{/.test(recentHandler));
// ⑥ 出厂样例：新键齐全、legacy 键不写进样例（免得新人照抄旧口径）、取值跟 QZONE_DEFAULTS 一致。
const exampleQzone = JSON.parse(read('config.example.json')).qzone;
check('config.example.json 的 qzone 就是新口径六键', JSON.stringify(Object.keys(exampleQzone)) === '["enabled","adminQQ","windowHours","windowCap","ugcRight","maxChars"]', JSON.stringify(Object.keys(exampleQzone)));
check('  样例的 windowHours / windowCap 与 QZONE_DEFAULTS 一致', exampleQzone.windowHours === QZONE_DEFAULTS.windowHours && exampleQzone.windowCap === QZONE_DEFAULTS.windowCap, JSON.stringify({ windowHours: exampleQzone.windowHours, windowCap: exampleQzone.windowCap }));
check('  样例里不再出现 dailyCap / minIntervalMs', !('dailyCap' in exampleQzone) && !('minIntervalMs' in exampleQzone));

const total = passed + failures.length;
console.log(`\n结果：${passed}/${total} passed`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log('全部通过：端点位置、闸门顺序、OneBot 动作、MCP 工具与纯函数行为一致。');
process.exit(0);
