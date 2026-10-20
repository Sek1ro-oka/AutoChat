#!/usr/bin/env node
// 情绪内核接线（T-012 第三步）：只读端点 + 配置归一 + 状态文件的契约测试。
//
// 为什么又是「静态」：src/bridge.js 在模块顶层就 loadConfig() 并 createServer()，
// import 它会真的把桥接跑起来、把 QQ 会话接上去——测试里绝不该做这件事。
// 所以这里只读源码文本，钉死这一层的四件事：
//   ① 端点在哪（qzone/recent 之后）、是不是 GET、块里有没有写盘/发送/定时器；
//   ② 配置只有一处归一入口（loadConfig），桥接里没有偷偷写死阈值；
//   ③ 状态文件路径与读写函数的口径（读不落盘、写失败不抛）；
//   ④ 出厂样例 config.example.json 与 affect-core 的默认值一致，且审计 harness
//      把两个纯模块展开进了 VM（少一行就是 ReferenceError）。
//
// 最后两条用真模块跑（import 纯函数不连网不发消息），其余全是文本断言。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AFFECT_DEFAULTS,
  AFFECT_EMOTIONS,
  normalizeAffectConfig
} from '../src/affect-core.js';
import * as affectCore from '../src/affect-core.js';
import * as affectVent from '../src/affect-vent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 统一把 CRLF 折成 LF：仓库里的源码在 Windows 下是 CRLF，跨行断言不该被行尾符绊倒。
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
/** 从 start 处截到下一个「顶格 function」，拿到一个顶层函数的完整源码块。 */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = text.indexOf('\nfunction ', start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

const bridge = read('src/bridge.js');
const harness = read('scripts/audit-bridge-harness.mjs');
const example = JSON.parse(read('config.example.json'));

// ── 组一：端点存在、是 GET、且是纯读 ───────────────────────────────────────
console.log('── 组一：只读端点的位置与形状 ──────────────────────────────');
const AFFECT_PATH = '/api/socialV2/affect';
const pathLines = allLinesOf(bridge, `'${AFFECT_PATH}'`);
check(`存在端点字面量 '${AFFECT_PATH}'`, pathLines.length >= 1, `出现 ${pathLines.length} 次`);
check(`端点字面量只出现在一处（GET 分派）`, pathLines.length === 1, `出现行 ${pathLines.join(',')}`);

// 令牌关卡：所有 /api 请求先过它。端点行号在它之后 = 静默继承整套鉴权。
const tokenLine = lineOf(bridge, 'resolveRequestToken({');
check('能定位到令牌关卡 resolveRequestToken({', tokenLine > 0, `行号 ${tokenLine}`);
check('端点位于令牌关卡之后（继承鉴权）', pathLines.length > 0 && pathLines[0] > tokenLine, `端点行 ${pathLines[0]} / 关卡行 ${tokenLine}`);

// GET 分支：必须是 `req.method === 'GET' && url.pathname === '/api/socialV2/affect'`，
// 而不是 POST/method 分支或只按路径匹配（只读端点被写成无方法判定，等于开了写入口）。
const getBranch = new RegExp(`if \\(req\\.method === 'GET' && url\\.pathname === '${AFFECT_PATH.replace(/\//g, '\\/')}'\\)`);
check('端点是 GET 分支（method 与 pathname 同时判定）', getBranch.test(bridge));

// 位置契约：插在 /api/qzone/recent 之后（任务书指定），且在 qzone/config 之前。
const recentLine = lineOf(bridge, "if (req.method === 'GET' && url.pathname === '/api/qzone/recent')");
const qzoneConfigLine = lineOf(bridge, "if (req.method === 'POST' && url.pathname === '/api/qzone/config')");
check('端点排在 /api/qzone/recent 之后', pathLines.length > 0 && pathLines[0] > recentLine);
check('端点排在 /api/qzone/config 之前', pathLines.length > 0 && pathLines[0] < qzoneConfigLine);

// handler 切片：从 if 到下一个端点（qzone/config）。
const handlerStart = bridge.indexOf(`if (req.method === 'GET' && url.pathname === '${AFFECT_PATH}')`);
let handlerEnd = bridge.indexOf("\n        if (req.method === 'POST' && url.pathname === '/api/qzone/config'", handlerStart);
if (handlerEnd < 0) handlerEnd = Math.min(bridge.length, handlerStart + 1200);
const handler = bridge.slice(handlerStart, handlerEnd);
check('handler 内调用 affectSnapshot(', handler.includes('affectSnapshot('));
check('handler 内调用 sendJson(', handler.includes('sendJson('));
check('handler 只读：不调用 atomicWriteJson', !handler.includes('atomicWriteJson'));
check('handler 只读：不调用 writeAffectState', !handler.includes('writeAffectState('));
check('handler 只读：不调用 OneBot（oneBotAction）', !/oneBotAction/.test(handler));
check('handler 只读：不起定时器', !/\bsetInterval\b|\bsetTimeout\b/.test(handler));
// 失败也要给出 JSON，而不是让异常冒到外层变成断开的连接。
check('handler 有 try/catch 兜底（失败回 JSON）', handler.includes('try {') && handler.includes('catch (error)'));

// 只读端点必须可以被 agent token 读：不能进管理端专用名单。
const adminStart = bridge.indexOf('const adminOnlyV2Paths = [');
const adminEnd = bridge.indexOf('];', adminStart);
const adminBlock = adminStart < 0 || adminEnd < 0 ? '' : bridge.slice(adminStart, adminEnd + 2);
check('解析到 adminOnlyV2Paths 数组', adminBlock.includes("'/api/socialV2/config'") && adminBlock.includes("'/api/socialV2/automation'"), adminBlock.slice(0, 120));
check(`只读端点不在 adminOnlyV2Paths 里`, adminBlock !== '' && !adminBlock.includes(`'${AFFECT_PATH}'`));

// ── 组二：配置归一入口与 import ────────────────────────────────────────────
console.log('── 组二：配置归一与模块 import ─────────────────────────────');
const importArea = bridge.slice(0, bridge.indexOf('const __dirname'));
const coreImportLine = lineOf(bridge, "} from './affect-core.js';");
const ventImportLine = lineOf(bridge, "} from './affect-vent.js';");
check('顶部 import 了 ./affect-core.js', coreImportLine > 0, `行号 ${coreImportLine}`);
check('顶部 import 了 ./affect-vent.js', ventImportLine > 0, `行号 ${ventImportLine}`);
check('两个 import 都在模块常量之前（顶部 import 区）', coreImportLine > 0 && ventImportLine > 0 && coreImportLine < lineOf(bridge, 'const __dirname') && ventImportLine < lineOf(bridge, 'const __dirname'));
check('affect-core 引入了归一入口与默认值', ['normalizeAffectConfig', 'AFFECT_DEFAULTS', 'AFFECT_EMOTIONS'].every((name) => importArea.includes(`${name},`)));
check('affect-vent 引入了规划与文案闸门', ['planVent', 'checkVentText'].every((name) => importArea.includes(name)));

const affectAssignLine = lineOf(bridge, 'cfg.socialV2.affect = normalizeAffectConfig(');
check('loadConfig 里归一出厂配置（cfg.socialV2.affect = normalizeAffectConfig(）', affectAssignLine > 0, `行号 ${affectAssignLine}`);
check('归一发生在 loadConfig 内部', affectAssignLine > lineOf(bridge, 'function loadConfig(') && affectAssignLine < lineOf(bridge, 'function loadConfig(') + 400);
check('归一排在 automation 之后（沿用既有段的顺序）', affectAssignLine > lineOf(bridge, 'cfg.socialV2.automation = normalizeAutomation('));

check(
  "AFFECT_STATE_FILE 指向 state/affect.json",
  /const AFFECT_STATE_FILE = path\.join\(STATE_DIR, 'affect\.json'\);/.test(bridge)
);

// ── 组三：状态读写函数的口径 ───────────────────────────────────────────────
console.log('── 组三：状态文件读写 ──────────────────────────────────────');
const readBody = functionBody(bridge, 'readAffectState');
const writeBody = functionBody(bridge, 'writeAffectState');
check('定义了 readAffectState(now = Date.now())', readBody.length > 0);
check('readAffectState 先读文件（readJsonSafe(AFFECT_STATE_FILE）', readBody.includes('readJsonSafe(AFFECT_STATE_FILE'));
check('readAffectState 用 normalizeState 修复', readBody.includes('normalizeState(raw'));
check('readAffectState 坏文件回落 createState(', readBody.includes('createState('));
check('readAffectState 是纯读：块内没有 atomicWriteJson', !readBody.includes('atomicWriteJson'));

check('定义了 writeAffectState(state)', writeBody.length > 0);
check('writeAffectState 走 serializeState 序列化', writeBody.includes('serializeState(state)'));
check('writeAffectState 写入 AFFECT_STATE_FILE', writeBody.includes('atomicWriteJson(AFFECT_STATE_FILE'));
check('writeAffectState 失败只记日志（有 try/catch）', writeBody.includes('try {') && writeBody.includes('catch (error)'));

// ── 组四：面板快照的字段契约 ───────────────────────────────────────────────
console.log('── 组四：affectSnapshot 的数据形状 ─────────────────────────');
const snapshot = functionBody(bridge, 'affectSnapshot');
check('定义了 affectSnapshot(now)', snapshot.length > 0);
check('快照每次现读配置（内部 const cfg = loadConfig()）', snapshot.includes('const cfg = loadConfig();'));
check('快照用 decayTo 把强度折算到 now（必须传第 4 参 key）', snapshot.includes('decayTo(state.emotions[key], ts, affect, key)'));
check('快照用 config 里的阈值（params.threshold，不写死）', snapshot.includes('threshold: params.threshold'));
for (const field of ['ok:', 'enabled:', 'now:', 'emotions,', 'dominant:', 'topIntensity:', 'canVent:', 'plan:', 'events:', 'vents:', 'caps,', 'config: affect']) {
  check(`快照返回 ${field.replace(/[:,]$/, '')}`, snapshot.includes(field));
}
check('canVent 字段含 ok/emotion/reason/retryAfterMs', ['ok:', 'emotion:', 'reason:', 'retryAfterMs:'].every((key) => snapshot.includes(key)));
check('caps 覆盖三出口 + 空间读数', ['qzone:', 'private:', 'diary:', 'qzoneConfigured:', 'qzoneRemaining:', 'qzoneRetryAfterMs:'].every((key) => snapshot.includes(key)));
check('caps.qzone 由 checkQuota 判定', snapshot.includes('checkQuota({ now: ts, posts: qzState.posts, cfg: qz })'));
check('planVent 以 quiet:false 调用（静默时段本步骤恒关）', snapshot.includes('quiet: false'));
check('planVent 带最近 5 条空间文案', snapshot.includes('qzState.posts.slice(0, 5)'));
check('planVent 带 lastVentTs', snapshot.includes('lastVentTs: state.lastVentTs'));
check('快照不落盘（不调用 atomicWriteJson / writeAffectState）', !snapshot.includes('atomicWriteJson') && !snapshot.includes('writeAffectState('));
check('快照不发消息（不调用 oneBotAction）', !/oneBotAction/.test(snapshot));

// 中文标签：面板直接用，键必须覆盖四维。
const labels = { anger: '生气', sadness: '难过', joy: '开心', boredom: '无聊' };
const labelStart = bridge.indexOf('const AFFECT_LABELS = Object.freeze({');
const labelBlock = labelStart < 0 ? '' : bridge.slice(labelStart, bridge.indexOf('});', labelStart));
check('定义了 AFFECT_LABELS 冻结表', labelBlock !== '');
for (const [key, label] of Object.entries(labels)) {
  check(`  标签 ${key} → ${label}`, labelBlock.includes(`${key}: '${label}'`));
}
check('标签表覆盖 AFFECT_EMOTIONS（不多不少）', AFFECT_EMOTIONS.every((key) => Object.hasOwn(labels, key)) && Object.keys(labels).length === AFFECT_EMOTIONS.length);

// ── 组五：桥接里不许写死阈值 ───────────────────────────────────────────────
console.log('── 组五：阈值只有一处来源 ─────────────────────────────────');
check('桥接引用 AFFECT_DEFAULTS（默认值来自模块）', bridge.includes('AFFECT_DEFAULTS.emotions[key]'));
check('桥接没有 threshold: <数字> 的硬编码赋值', !/threshold:\s*-?\d/.test(bridge));
check('桥接没有 0.70 字面量', !bridge.includes('0.70'));
check('桥接没有按情绪名写死阈值块（anger: { … threshold: … }）', !/anger\s*:\s*\{[^}]*threshold/s.test(bridge));

// ── 组六：出厂样例配置 ─────────────────────────────────────────────────────
console.log('── 组六：config.example.json 的 affect 段 ─────────────────');
const exampleAffect = example?.socialV2?.affect;
check('样例含 socialV2.affect', Boolean(exampleAffect) && typeof exampleAffect === 'object');
check('样例开关打开（enabled === true）', exampleAffect?.enabled === true);
check('样例 anger.threshold === 0.70', exampleAffect?.emotions?.anger?.threshold === 0.70, String(exampleAffect?.emotions?.anger?.threshold));
check('样例 quietHours.enabled === false', exampleAffect?.quietHours?.enabled === false);
check('样例三个出口与三条额度齐全', ['qzone', 'private', 'diary'].every((key) => Object.hasOwn(exampleAffect?.vents ?? {}, key) && Object.hasOwn(exampleAffect?.dailyCap ?? {}, key)));
check('样例的 group 出口保持关闭（本版不实现群聊宣泄）', exampleAffect?.vents?.group === false);

// 样例必须与出厂默认逐字段相等：样例是操作者抄的第一份配置，
// 它跟 AFFECT_DEFAULTS 漂移的话，新装机器的行为就和测试里的假设不一致了。
const normalizedExample = normalizeAffectConfig(exampleAffect);
const defaultDiffs = [];
for (const key of AFFECT_EMOTIONS) {
  for (const field of ['halfLifeMin', 'sensitivity', 'threshold', 'doseMin', 'cooldownMin']) {
    if (normalizedExample.emotions[key][field] !== AFFECT_DEFAULTS.emotions[key][field]) {
      defaultDiffs.push(`${key}.${field}=${normalizedExample.emotions[key][field]}≠${AFFECT_DEFAULTS.emotions[key][field]}`);
    }
  }
}
check('样例四维参数与 AFFECT_DEFAULTS 完全一致', defaultDiffs.length === 0, defaultDiffs.join('；'));
check('样例 minIntervalMs 与默认值一致', normalizedExample.minIntervalMs === AFFECT_DEFAULTS.minIntervalMs);
check('样例 jitterRatio 与默认值一致', normalizedExample.jitterRatio === AFFECT_DEFAULTS.jitterRatio);

// ── 组七：审计 harness 的 VM 上下文 ────────────────────────────────────────
console.log('── 组七：audit-bridge-harness 的接线 ─────────────────────');
const coreHarnessLine = lineOf(harness, "import * as affectCore from '../src/affect-core.js';");
const ventHarnessLine = lineOf(harness, "import * as affectVent from '../src/affect-vent.js';");
check("harness import 了 * as affectCore from '../src/affect-core.js'", coreHarnessLine > 0, `行号 ${coreHarnessLine}`);
check("harness import 了 * as affectVent from '../src/affect-vent.js'", ventHarnessLine > 0, `行号 ${ventHarnessLine}`);
check('两个 harness import 都在 qzone 之后（新段顺序）', coreHarnessLine > lineOf(harness, "from '../src/qzone-post.js';") && ventHarnessLine > lineOf(harness, "from '../src/qzone-post.js';"));
check('VM context 展开 ...affectCore, ...affectVent,', harness.includes('...affectCore, ...affectVent,'));
check('展开位置在 ...qzone 之后（不与既有名字抢先）', harness.indexOf('...affectCore, ...affectVent,') > harness.indexOf('...qzone,'));

// 重名会静默覆盖已有绑定：这两个模块必须互不重名，也不能碰已知的 nowIso。
const coreNames = Object.keys(affectCore);
const ventNames = Object.keys(affectVent);
const overlap = coreNames.filter((name) => ventNames.includes(name));
check('affect-core 与 affect-vent 没有重名导出', overlap.length === 0, overlap.join(','));
check('两个模块都不导出 nowIso（harness 里已被 slang/sticker 占用）', ![...coreNames, ...ventNames].includes('nowIso'));

// ── 收尾 ───────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log('');
if (failures.length === 0) {
  console.log(`结果：${passed}/${total} passed`);
  process.exit(0);
}
console.log(`结果：${passed}/${total} passed，${failures.length} 项失败：`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
