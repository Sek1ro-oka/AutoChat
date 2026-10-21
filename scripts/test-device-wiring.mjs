#!/usr/bin/env node
/**
 * T-023 第三步：平板工具接进桥接与 MCP 服务器的**接线契约**测试（静态切片）。
 *
 * 为什么是静态断言而不是起服务真打请求：src/bridge.js 顶层就 loadConfig() + 建目录，
 * import 一次等于把整条桥接真跑起来（还会去连 SnowLuma）；src/mcp-snowluma-safe.js 顶层
 * 直接 await server.connect()，import 会把 stdio 抢走。所以和
 * scripts/test-image-endpoints.mjs / test-heybox-tools.mjs 一样：读源码 → 切片 → 断言。
 *
 * 能直接 import 的都直接 import：device-core 是纯函数模块，device-tools 的 DEVICE_TOOL_NAMES
 * 与状态文件名是「两侧必须逐字一致」的事实地来源 —— 断言它们与桥接里的字面量相等，
 * 比断言桥接里「有这八个字符串」更能挡住漂移。
 *
 * 断言分成十一组：
 *   一 bridge 的 device-core import     二 常量 + 配置归一
 *   三 读状态（只读、坏/缺兜底）        四 toolMap 八项
 *   五 enabledTools 过滤               六 prompt 的 device 块
 *   七 MCP 侧 import 与 try/catch       八 config.example.json 的 device 段
 *   九 授权闸门（T-024：谁能授权 / 写盘 / 门控 / 日记 key）
 *   十 测试接线（audit / harness / 夹具 / 冒烟脚本） 十一 node --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEVICE_DEFAULTS, normalizeDeviceConfig } from '../src/device-core.js';
import { DEVICE_GRANT_FILE as DEVICE_GRANT_FILENAME, DEVICE_STATE_FILE as DEVICE_STATE_FILENAME, DEVICE_TOOL_NAMES } from '../src/device-tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`❌ ${name}${extra === undefined ? '' : `\n   ↳ ${extra}`}`);
  }
}

const lineOf = (text, needle) => {
  const at = text.indexOf(needle);
  return at < 0 ? -1 : text.slice(0, at).split('\n').length;
};

/** 从 a 切到 b（含 a 不含 b）；任一端缺失给空串 —— 缺端点本身会由「存在」那组抓出来。 */
function sliceBetween(text, a, b) {
  const start = text.indexOf(a);
  if (start < 0) return '';
  const end = text.indexOf(b, start + a.length);
  if (end < 0) return '';
  return text.slice(start, end);
}

/**
 * 抠出一个函数的完整源码（先配平参数表的圆括号，再配平函数体的花括号）。
 * 与 scripts/test-image-endpoints.mjs 同一份实现：参数表必须单独配平，
 * 否则 `function f(x = {})` 会在默认值的 `{}` 那里提前「闭合」。
 */
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return '';
  let i = text.indexOf('(', start);
  if (i < 0) return '';
  let parens = 0;
  for (; i < text.length; i++) {
    if (text[i] === '(') parens++;
    else if (text[i] === ')') {
      parens--;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

const bridge = read('src/bridge.js');
const mcp = read('src/mcp-snowluma-safe.js');
const testAudit = read('scripts/test-audit.mjs');
const harness = read('scripts/audit-bridge-harness.mjs');
const modelView = read('scripts/test-qq-model-view.mjs');
const example = read('config.example.json');
const exampleJson = JSON.parse(example);

// ── 一 bridge 的 device-core import ─────────────────────────────────────────
console.log('\n一 bridge 的 device-core import');

const DEVICE_IMPORT = "import { normalizeDeviceConfig, createDeviceState, parseDeviceState, devicePromptBlock } from './device-core.js';";
check('bridge 里有单行 device-core import（audit harness 按行剥 import 的前提）', bridge.includes(DEVICE_IMPORT));
check('import 了 normalizeDeviceConfig（loadConfig 归一）', bridge.includes('normalizeDeviceConfig,'));
check('import 了 createDeviceState + parseDeviceState（读状态两种兜底）', bridge.includes('createDeviceState,') && bridge.includes('parseDeviceState,'));
check('import 了 devicePromptBlock（prompt 的 device 块）', bridge.includes('devicePromptBlock }'));
check('没有 import 用不到的 deviceBudget（提示词块内部已经算过预算）', !/import \{[^}]*\bdeviceBudget\b[^}]*\} from '\.\/device-core\.js'/.test(bridge));
check('device-core 的 import 只有一处', (bridge.match(/from '\.\/device-core\.js'/g) ?? []).length === 1);
check('device-core import 在 heybox-core import 之后', lineOf(bridge, "from './device-core.js'") > lineOf(bridge, "from './heybox-core.js'"));
check('bridge 不直接注册 MCP 工具（注册是 mcp-snowluma-safe.js 的事）', !bridge.includes('registerDeviceTools'));

// ── 二 常量 + 配置归一 ──────────────────────────────────────────────────────
console.log('\n二 常量 + 配置归一');

check("常量 DEVICE_STATE_FILE = state/device-state.json", bridge.includes("const DEVICE_STATE_FILE = path.join(STATE_DIR, 'device-state.json');"));
check('常量紧跟 HEYBOX_USAGE_FILE 之后（同一批「MCP 写、桥接只读」的落盘位置）', (() => {
  const at = lineOf(bridge, 'const DEVICE_STATE_FILE');
  const hb = lineOf(bridge, 'const HEYBOX_USAGE_FILE');
  return at > hb && at - hb <= 8; // 中间夹着一段说明注释
})());
check('桥接侧的文件名与 device-tools 的 DEVICE_STATE_FILE 逐字一致', DEVICE_STATE_FILENAME === 'device-state.json');
check('loadConfig 里归一顶层 device 段', bridge.includes('cfg.device = normalizeDeviceConfig(file.device);'));
check('取的是 file.device（cfg 字面量里没有 device 键，写成 cfg.device 会永远 undefined）', bridge.includes('normalizeDeviceConfig(file.device)'));
check('归一只有一处（不重复归一）', (bridge.match(/cfg\.device = /g) ?? []).length === 1
  && (bridge.match(/normalizeDeviceConfig\(/g) ?? []).length === 1);
check('device 归一在 heybox 归一之后（与配置段顺序一致）', lineOf(bridge, 'cfg.device = normalizeDeviceConfig') > lineOf(bridge, 'cfg.heybox = normalizeHeyboxConfig'));

// ── 三 读状态（只读、坏/缺兜底） ────────────────────────────────────────────
console.log('\n三 readDeviceState（只读、坏/缺兜底）');

const readState = extractFunction(bridge, 'function readDeviceState(');
check('有 readDeviceState() 函数', readState.length > 0);
check('读文件走 readJsonSafe(DEVICE_STATE_FILE, null)', readState.includes('const raw = readJsonSafe(DEVICE_STATE_FILE, null);'));
check('文件缺失/坏 JSON → createDeviceState()（今天的计数归零）', readState.includes('if (raw === null) return createDeviceState(Date.now());'));
check('其余情形交给 parseDeviceState 逐字段兜底', readState.includes('return parseDeviceState(raw);'));
check('读状态绝不写盘（不 mkdir / 不 write / 不 atomicWriteJson）', !readState.includes('mkdirSync') && !readState.includes('writeFileSync') && !readState.includes('atomicWriteJson'));
check('readDeviceState 在 readHeyboxUsage 之后（同属「MCP 写、桥接只读」的一段）', lineOf(bridge, 'function readDeviceState(') > lineOf(bridge, 'function readHeyboxUsage('));
check('桥接没有任何地方写 device 状态文件', !bridge.includes('writeFileSync(DEVICE_STATE_FILE') && !bridge.includes('atomicWriteJson(DEVICE_STATE_FILE') && !bridge.includes('serializeDeviceState'));

// ── 四 toolMap 八项 ────────────────────────────────────────────────────────
console.log('\n四 toolMap 八项');

const toolMap = sliceBetween(bridge, 'const toolMap = {', '};');
check('toolMap 切片存在', toolMap.length > 0);
const DEVICE_FLAGS = [
  ['deviceStatus', 'device_status'],
  ['deviceScreenshot', 'device_screenshot'],
  ['deviceTap', 'device_tap'],
  ['deviceSwipe', 'device_swipe'],
  ['deviceType', 'device_type'],
  ['deviceKey', 'device_key'],
  ['deviceOpenApp', 'device_open_app'],
  ['deviceListApps', 'device_list_apps'],
];
for (const [flag, name] of DEVICE_FLAGS) {
  check(`toolMap 登记 ${flag} → ${name}`, toolMap.includes(`${flag}: '${name}'`));
}
const mappedDeviceNames = [...toolMap.matchAll(/device[A-Z]\w*: '(device_\w+)'/g)].map((m) => m[1]);
check('toolMap 里恰好八个 device_* 工具', mappedDeviceNames.length === 8, mappedDeviceNames.join(','));
check('八个值与 device-tools 的 DEVICE_TOOL_NAMES 逐字同序一致', JSON.stringify(mappedDeviceNames) === JSON.stringify([...DEVICE_TOOL_NAMES]), mappedDeviceNames.join(','));
check('device 八项登记在 heyboxComment 之后（追加在工具表末尾，不动老条目）', lineOf(bridge, "deviceStatus: 'device_status'") > lineOf(bridge, "heyboxComment: 'heybox_comment'"));
check('list_apps 追加在 open_app 之后（第八个工具，不改老顺序）', lineOf(bridge, "deviceListApps: 'device_list_apps'") > lineOf(bridge, "deviceOpenApp: 'device_open_app'"));

// ── 五 enabledTools 过滤 ────────────────────────────────────────────────────
console.log('\n五 enabledTools 过滤');

check('有 deviceEnabled 判据', bridge.includes('const deviceEnabled = cfg.device?.enabled !== false;'));
check('判据用 !== false（缺省即开，与 normalizeDeviceConfig 默认一致）', bridge.includes('cfg.device?.enabled !== false'));
check('deviceToolFlags 覆盖八个 flag', bridge.includes("const deviceToolFlags = new Set(['deviceStatus', 'deviceScreenshot', 'deviceTap', 'deviceSwipe', 'deviceType', 'deviceKey', 'deviceOpenApp', 'deviceListApps']);"));
const filterLine = bridge.split('\n').find((line) => line.includes('enabledTools.push(name)')) ?? '';
check('过滤条件串末尾追加 device 判据', filterLine.includes('&& !(deviceToolFlags.has(flag) && !deviceGranted))'));
check('device 判据在 push 之前（同一条 if 的最后一项）', filterLine.includes('&& !(deviceToolFlags.has(flag) && !deviceGranted)) enabledTools.push(name)'));
check('device 判据排在 heyboxComment 判据之后（不动既有顺序）', filterLine.indexOf('heyboxComment') < filterLine.indexOf('deviceToolFlags'));
check('过滤只有一处 push（没有第二套 enabledTools 逻辑）', (bridge.match(/enabledTools\.push\(name\)/g) ?? []).length === 1);
check('deviceGranted 由「功能开着 + 有效授权」共同决定', bridge.includes('const deviceGranted = deviceEnabled && isGrantActive(readDeviceGrant(), Date.now());'));
check('没有有效授权时 device_* 不列进 enabledTools（模型看不到就不会试）', filterLine.includes('!(deviceToolFlags.has(flag) && !deviceGranted)'));

// ── 六 prompt 的 device 块 ─────────────────────────────────────────────────
console.log('\n六 prompt 的 device 块');

check('prompt payload 里有 device 块', bridge.includes('device: (() => {'));
check('device 块在 heybox 块之后', lineOf(bridge, 'device: (() => {') > lineOf(bridge, 'heybox: (() => {'));
check('device 块在 replyTiming 之前（仍在同一个 payload 里）', lineOf(bridge, 'device: (() => {') < lineOf(bridge, 'replyTiming: replyTimingV2(st),'));
const deviceBlock = sliceBetween(bridge, 'device: (() => {', 'replyTiming: replyTimingV2(st),');
check('device 块切片存在', deviceBlock.length > 200, deviceBlock.length);
check('禁用时短路成 { enabled: false }（整段不注入）', deviceBlock.includes('if (!deviceEnabled) return { enabled: false };'));
check('现算额度：devicePromptBlock(cfg.device, readDeviceState(), nowMs)', deviceBlock.includes('const block = devicePromptBlock(cfg.device, readDeviceState(), nowMs);'));
check('用 { ...block, tools } 合并（devicePromptBlock 只给 enabled/apps/budget/hint）', deviceBlock.includes('...block,'));
check('tools 数组是八个工具名', deviceBlock.includes("tools: ['device_status', 'device_screenshot', 'device_tap', 'device_swipe', 'device_type', 'device_key', 'device_open_app', 'device_list_apps']"));
const promptTools = (deviceBlock.match(/'(device_\w+)'/g) ?? []).map((s) => s.slice(1, -1));
check('prompt 的工具清单与 DEVICE_TOOL_NAMES 逐字同序一致', JSON.stringify(promptTools) === JSON.stringify([...DEVICE_TOOL_NAMES]), promptTools.join(','));
check('device 块不写盘（只读快照）', !deviceBlock.includes('writeFileSync') && !deviceBlock.includes('atomicWriteJson') && !deviceBlock.includes('mkdirSync'));
check('device 块不起定时器（本轮不做主动唤醒）', !deviceBlock.includes('setInterval') && !deviceBlock.includes('setTimeout'));
check('桥接不直接调 adb（闸门与执行都在 MCP 侧）', !bridge.includes('runAdb') && !bridge.includes('DEVICE_ACTION_LOG'));
check('桥接没有新增 device 唤醒理由（主动去玩是下一步）', !bridge.includes('devicePlay'));

// 授权分支（T-024）：未授权只给一句话、不给工具名；已授权才给八个 + 剩余分钟 + diaryKey。
check('未授权分支 granted:false', deviceBlock.includes('granted: false'));
check('未授权分支 tools 为空数组（模型看不到 device_*）', deviceBlock.includes('tools: []'));
check('未授权 hint 写明「要先得到管理员许可」', deviceBlock.includes('想玩平板要先得到管理员许可'));
check('未授权分支在 devicePromptBlock 之后（额度仍然照算）', deviceBlock.indexOf('devicePromptBlock(') < deviceBlock.indexOf('granted: false'));
check('授权判据来自 grantSummary(readDeviceGrant(), nowMs)', deviceBlock.includes('grantSummary(readDeviceGrant(), nowMs)'));
check('已授权分支 granted:true', deviceBlock.includes('granted: true'));
check('已授权分支带 grant 详情（授权人 / 时长 / 步数 / 剩余分钟）', deviceBlock.includes('grant: {') && deviceBlock.includes('leftMinutes: summary.leftMinutes') && deviceBlock.includes('steps: summary.steps'));
check('已授权分支带 diaryKey', deviceBlock.includes('diaryKey,'));
check('日记 key = diaryKeyFor(private:授权人)（落到管理员的互通组日记本）', deviceBlock.includes('diaryKeyFor(`private:${grantedBy}`)'));
check('日记 key 认不出授权人时退回空串（不写脏 key）', deviceBlock.includes(": '';") && deviceBlock.includes('const diaryKey = /^\\d{1,15}$/.test(grantedBy)'));
check('已授权 hint 要求把经过写成日记到这个 key', deviceBlock.includes('玩完把这次玩的经过写成日记，写到这个 key'));
check('已授权 hint 带本轮剩余分钟', deviceBlock.includes('本轮还剩 ${summary.leftMinutes} 分钟'));
check('未授权分支排在已授权分支之前（先判授权再谈工具）', deviceBlock.indexOf('granted: false') < deviceBlock.indexOf('granted: true'));

// ── 七 MCP 侧 import 与 try/catch ──────────────────────────────────────────
console.log('\n七 MCP 侧 import 与 try/catch');

check("MCP 顶部 import registerDeviceTools", mcp.includes("import { registerDeviceTools } from './device-tools.js';"));
check('device-tools 的 import 在 heybox-tools 之后', lineOf(mcp, "from './device-tools.js'") > lineOf(mcp, "from './heybox-tools.js'"));
check('import 与调用各一处（不重复注册）', (mcp.match(/registerDeviceTools\(server\)/g) ?? []).length === 1);
check('注册包在 try/catch 里（依赖坏了不能拖死整个 snowluma server）', mcp.includes('try {\n  registerDeviceTools(server);\n} catch (err) {'));
check("失败文案是 [device] 工具注册失败：", mcp.includes("console.error('[device] 工具注册失败：' + (err?.message || err));"));
check('device 的 try/catch 在 heybox 的之后', lineOf(mcp, 'registerDeviceTools(server)') > lineOf(mcp, 'registerHeyboxTools(server)'));
check('device 的 try/catch 在 server.connect 之前（注册完才握手）', lineOf(mcp, 'registerDeviceTools(server)') < lineOf(mcp, 'await server.connect('));
check('server.connect 仍是文件最后一句（没有代码被塞到握手之后）', mcp.trimEnd().endsWith('await server.connect(new StdioServerTransport());'));

// ── 八 config.example.json 的 device 段 ────────────────────────────────────
console.log('\n八 config.example.json 的 device 段');

const exampleKeys = Object.keys(exampleJson);
check('样例配置有顶层 device 段', Object.prototype.hasOwnProperty.call(exampleJson, 'device'));
check('device 段紧跟 heybox 之后', exampleKeys.indexOf('device') === exampleKeys.indexOf('heybox') + 1, exampleKeys.join(','));
const deviceCfg = exampleJson.device ?? {};
check('device.enabled 为 true', deviceCfg.enabled === true);
check('device.adbPath 是占位符（样例不能写死某台机器的路径）', deviceCfg.adbPath === '%LOCALAPPDATA%\\Android\\platform-tools\\adb.exe', deviceCfg.adbPath);
check('device.adbPath 落成注释/文档里能认出来的样子', deviceCfg.adbPath.includes('platform-tools') && deviceCfg.adbPath.endsWith('adb.exe') && !/Users\\/i.test(deviceCfg.adbPath));
check('device.maxMinutesPerDay = 30', deviceCfg.maxMinutesPerDay === 30);
check('device.maxStepsPerDay = 60', deviceCfg.maxStepsPerDay === 60);
check('device.minGapMs = 1000', deviceCfg.minGapMs === 1000);
check('device.pauseAfterRunMs = 3600000（一轮玩完冷却 1 小时）', deviceCfg.pauseAfterRunMs === 3600000);
check('device.apps 为空数组（= 不限制包名）', Array.isArray(deviceCfg.apps) && deviceCfg.apps.length === 0);
check('device.blockedApps 写上内核五项（给用户看的样子）', JSON.stringify(deviceCfg.blockedApps) === JSON.stringify(['com.eg.android.AlipayGphone', 'com.tencent.mm', 'com.tencent.mobileqq', 'com.android.vending', 'com.android.settings']), deviceCfg.blockedApps);
check('device 段恰好八个键（与 normalizeDeviceConfig 的字段一一对应）', JSON.stringify(Object.keys(deviceCfg)) === JSON.stringify(['enabled', 'adbPath', 'maxMinutesPerDay', 'maxStepsPerDay', 'minGapMs', 'pauseAfterRunMs', 'apps', 'blockedApps']), Object.keys(deviceCfg).join(','));
// adbPath 是「每台机器都不同」的那一项，其余值必须归一后等于出厂默认（没有写一个会被 clamp 掉的数）。
const normalizedExample = normalizeDeviceConfig(deviceCfg);
check('样例值归一后等于出厂默认（adbPath 除外）', JSON.stringify({ ...normalizedExample, adbPath: '' }) === JSON.stringify({ ...DEVICE_DEFAULTS, adbPath: '' }), JSON.stringify(normalizedExample));
check('样例里的黑名单归一后仍是内核五项（不多不少）', JSON.stringify(normalizedExample.blockedApps) === JSON.stringify([...DEVICE_DEFAULTS.blockedApps]));

// ── 九 授权闸门（T-024） ──────────────────────────────────────────────────
console.log('\n九 授权闸门（T-024）');

const GRANT_IMPORT = "import { DEVICE_GRANT_FILE, createGrant, grantSummary, isGrantActive, parseGrant, parseGrantIntent, revokeGrant } from './device-grant.js';";
check('bridge 里有单行 device-grant import（harness 按行剥 import 的前提）', bridge.includes(GRANT_IMPORT));
check('device-grant 的 import 只有一处', (bridge.match(/from '\.\/device-grant\.js'/g) ?? []).length === 1);
check('device-grant import 在 device-core import 之后', lineOf(bridge, "from './device-grant.js'") > lineOf(bridge, "from './device-core.js'"));
check('授权文件常量用模块导出的文件名拼路径（两侧不会漂）', bridge.includes('const DEVICE_GRANT_STATE_FILE = path.join(STATE_DIR, DEVICE_GRANT_FILE);'));
check('授权文件名与 device-grant.js / device-tools.js 的导出逐字一致', DEVICE_GRANT_FILENAME === 'device-grant.json');
check('授权常量紧跟 DEVICE_STATE_FILE（同一批「MCP 与桥接共用」的落盘位置）', (() => {
  const at = lineOf(bridge, 'const DEVICE_GRANT_STATE_FILE');
  const prev = lineOf(bridge, 'const DEVICE_STATE_FILE');
  return at > prev && at - prev <= 12;
})());

const readGrantFn = extractFunction(bridge, 'function readDeviceGrant(');
check('有 readDeviceGrant()（只读）', readGrantFn.length > 0);
check('读授权走 parseGrant(readJsonSafe(授权文件, null))（坏/缺都回落空授权）', readGrantFn.includes('parseGrant(readJsonSafe(DEVICE_GRANT_STATE_FILE, null))'));
check('读授权不写盘', !readGrantFn.includes('writeFileSync') && !readGrantFn.includes('atomicWriteJson'));
const writeGrantFn = extractFunction(bridge, 'function writeDeviceGrant(');
check('写授权走 atomicWriteJson（原子写）', writeGrantFn.includes('atomicWriteJson(DEVICE_GRANT_STATE_FILE, grant)'));
check('写授权失败只记日志、不抛（一条消息不该弄崩桥接）', writeGrantFn.includes('log(') && writeGrantFn.includes('return false'));

const adminSetFn = extractFunction(bridge, 'function deviceGrantAdminSet(');
check('授权人集合包含 ownerQQ', adminSetFn.includes('add(cfg.ownerQQ)'));
check('授权人集合包含 qzone.adminQQ', adminSetFn.includes('cfg.qzone?.adminQQ'));
check('授权人集合包含 file.adminQQ', adminSetFn.includes('cfg.file?.adminQQ'));
check('集合按十进制字符串归一（数字/字符串两种写法都认）', adminSetFn.includes('/^\\d{1,15}$/'));
check('loadConfig 里补了 cfg.file.adminQQ（原本没有 file 段）', bridge.includes('cfg.file = { adminQQ: normalizeAdminQqList(file.file?.adminQQ) };'));
check('adminQQ 列表归一接受数字与数字字符串', extractFunction(bridge, 'function normalizeAdminQqList(').includes('Number.isSafeInteger'));

const applyFn = extractFunction(bridge, 'function applyDeviceGrantIntent(');
check('授权用 createGrant（授权人 / 会话 / 分钟数）', applyFn.includes('createGrant(at, { grantedBy: senderQq, viaKey: key, minutes: intent.minutes })'));
check('撤销用 revokeGrant（读旧授权 → 写新对象）', applyFn.includes('writeDeviceGrant(revokeGrant(current, at))'));
check('从来没授权过时不造「空撤销」（否则 status 会说原定 30 分钟）', applyFn.includes('当前没有任何授权记录'));
check('授权与撤销都写盘', (applyFn.match(/writeDeviceGrant\(/g) ?? []).length === 2);
check('授权与撤销都留痕（log + appendActivity）', applyFn.includes('log(`[device]') && applyFn.includes('appendActivity('));

check('入站消息先判「发送者在管理员集合里」', bridge.includes("if (senderQq !== '' && deviceGrantAdminSet().has(senderQq))"));
check('入站口令交给 applyDeviceGrantIntent(key, senderQq, plainContent)', bridge.includes('applyDeviceGrantIntent(key, senderQq, plainContent)'));
check('授权处理排在挂起提问之前（口令不被当成答案吞掉）', lineOf(bridge, 'applyDeviceGrantIntent(key, senderQq, plainContent)') < lineOf(bridge, 'await handlePendingAnswer(p, plainContent, key, isOwner)'));
check('授权处理不吞消息（那段代码里没有 return）', (() => {
  const slice = sliceBetween(bridge, 'const senderQq = String(event.user_id', 'const p = pending.get(key);');
  return slice.length > 0 && !slice.includes('return');
})());
check('群友说的口令不算：权限判断就在调用点（模块本身不管权限）', !read('src/device-grant.js').includes('ownerQQ'));

const grantModule = read('src/device-grant.js');
check('device-grant 零 I/O（不读不写文件）', !grantModule.includes('readFileSync') && !grantModule.includes('writeFileSync') && !grantModule.includes('fs.'));
check('device-grant 零 import（纯函数模块）', [...grantModule.matchAll(/^import .*$/gm)].length === 0);
check('device-grant 不读系统时钟（now 由调用方注入）', !grantModule.includes('Date.now('));

// ── 十 测试接线（audit / harness / 夹具） ──────────────────────────────────
console.log('\n十 测试接线');

check('test-audit 注册 test-device-core.mjs', testAudit.includes("'test-device-core.mjs'"));
check('test-audit 注册 test-device-tools.mjs', testAudit.includes("'test-device-tools.mjs'"));
check('test-audit 注册 test-device-wiring.mjs', testAudit.includes("'test-device-wiring.mjs'"));
check('test-audit 注册 test-device-grant.mjs（T-024）', testAudit.includes("'test-device-grant.mjs'"));
check('audit-bridge-harness import * as deviceCore', harness.includes("import * as deviceCore from '../src/device-core.js';"));
check('audit-bridge-harness 把 deviceCore 展开进 VM context（否则 loadConfig 里 ReferenceError）', /\n\s+\.\.\.deviceCore,/.test(harness));
check('audit-bridge-harness import * as deviceGrant', harness.includes("import * as deviceGrant from '../src/device-grant.js';"));
check('audit-bridge-harness 把 deviceGrant 展开进 VM context（否则授权处 ReferenceError）', /\n\s+\.\.\.deviceGrant,/.test(harness));
check('test-qq-model-view 夹具复制 device-tools.js', modelView.includes("'device-tools.js'"));
check('test-qq-model-view 夹具复制 device-core.js', modelView.includes("'device-core.js'"));
check('test-qq-model-view 夹具复制 device-grant.js', modelView.includes("'device-grant.js'"));
for (const rel of ['src/device-core.js', 'src/device-tools.js', 'src/device-grant.js', 'scripts/test-device-grant.mjs', 'scripts/test-device-wiring.mjs']) {
  check(`${rel} 存在`, fs.existsSync(path.join(ROOT, rel)));
}

// 真机冒烟脚本：顺序、失败退出码、不引依赖。
const pkgJson = JSON.parse(read('package.json'));
check('package.json 注册 smoke:device', String(pkgJson.scripts?.['smoke:device'] ?? '').includes('scripts/smoke-device.mjs'), pkgJson.scripts?.['smoke:device']);
const smokeRel = 'scripts/smoke-device.mjs';
check(`${smokeRel} 存在`, fs.existsSync(path.join(ROOT, smokeRel)));
const smoke = fs.existsSync(path.join(ROOT, smokeRel)) ? read(smokeRel) : '';
check('冒烟脚本 import 真实 device-tools', smoke.includes("from '../src/device-tools.js'") && smoke.includes('createDeviceTools'));
check('冒烟脚本 import normalizeDeviceConfig', smoke.includes('normalizeDeviceConfig'));
check('冒烟脚本先展开 %NAME% 再查 adb 是否存在',
  lineOf(smoke, 'expandEnvPath(cfg.adbPath)') > 0
  && lineOf(smoke, 'fs.existsSync(adbPath)') > lineOf(smoke, 'expandEnvPath(cfg.adbPath)'));
const order = ['deviceStatus', 'deviceListApps', 'deviceScreenshot', 'deviceTap', 'deviceSwipe', 'deviceKey', 'deviceOpenApp'];
const orderLines = order.map((name) => lineOf(smoke, `tools.${name}(`));
check('冒烟顺序 status → list_apps → screenshot → tap → swipe → key → open_app', orderLines.every((line, i) => line > 0 && (i === 0 || line > orderLines[i - 1])), orderLines.join(','));
check('冒烟失败以非 0 退出', smoke.includes('process.exitCode = 1') && smoke.includes('process.exitCode = failures.length === 0 ? 0 : 1'));
check('冒烟脚本只用 node: 内置模块（零新依赖）', [...smoke.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.')).length === 0);
check('冒烟脚本两步之间等 minGapMs', smoke.includes('cfg.minGapMs') && smoke.includes('await sleep(gapMs)'));

// ── 十一 node --check ──────────────────────────────────────────────────────
console.log('\n十一 node --check');

for (const rel of ['src/bridge.js', 'src/mcp-snowluma-safe.js', 'src/device-grant.js', 'scripts/test-device-wiring.mjs']) {
  const checked = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  check(`${rel} 语法检查通过`, checked.status === 0, (checked.stderr ?? '').trim().split('\n')[0]);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log(`\n结果：${passed}/${total} passed`);
if (failures.length > 0) {
  console.log('\n失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
