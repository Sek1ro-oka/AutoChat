#!/usr/bin/env node
// 名字映射表接线（T-018 第二步）：状态文件 / 配置归一 / 刷新调度 / 消息增量 /
// 两个端点 / prompt 块 / 跨会话发送授权。
//
// 为什么是「静态」断言：src/bridge.js 在模块顶层就 loadConfig() 并 createServer()，
// import 它会把桥接真的跑起来、把 QQ 会话接上去——测试里绝不该做这件事。
// 所以这里只读源码文本 + 切片，钉死这一层的七件事：
//   ① 17 个 identity-core 导出已导入，IDENTITY_FILE 指向 state/identity-map.json；
//   ② 读写走 readJsonSafe / normalizeIdentityState / atomicWriteJson（0600 + tmp/rename）；
//   ③ 配置在 loadConfig 里归一（紧跟 cross），enabled=false 在四处短路；
//   ④ refresh 拉好友/群/白名单群成员，单群失败不中断，之后落盘 + 一行日志；
//   ⑤ 启动 10 秒跑一次 + setInterval(refreshIntervalMs)，两个定时器都 unref；
//   ⑥ 两个端点：GET 读类放宽（isLiveAgentToken，不绑 key）、POST refresh 进 adminOnlyV2Paths；
//   ⑦ 发送类端点换成 agentTokenCoversSend（同互通编号即可发），读端点保持 agentTokenOk。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function sliceBetween(text, a, b) {
  const start = text.indexOf(a);
  if (start < 0) return '';
  const end = text.indexOf(b, start + a.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}
/** 从函数声明处切出整个函数源码（先跳过参数表的括号，再对函数体花括号配平）。 */
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return '';
  // 先跨过参数表：签名里可能有解构 `{ sender, ... }`，不能把它的花括号当成函数体。
  let i = text.indexOf('(', start);
  if (i < 0) return '';
  let paren = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') paren += 1;
    else if (text[i] === ')') {
      paren -= 1;
      if (paren === 0) { i += 1; break; }
    }
  }
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

const bridge = read('src/bridge.js');
const UNIFIED_403 = 'agent token 无效，或目标会话不在同一互通编号（可在控制台「跨渠道互通」里改编号）';

// ── 组一：导入、常量与状态文件读写 ──────────────────────────────────────────
console.log('\n── 组一：导入、常量与状态文件读写 ───────────────────────');

const IDENTITY_IMPORT_NAMES = [
  'IDENTITY_DEFAULTS',
  'IDENTITY_LIMITS',
  'normalizeIdentityConfig',
  'createIdentityState',
  'normalizeIdentityState',
  'parseIdentityState',
  'serializeIdentityState',
  'upsertPrivate',
  'upsertGroup',
  'upsertMember',
  'applyFriendList',
  'applyGroupList',
  'applyMemberList',
  'identityKey',
  'lookupIdentity',
  'identityPromptBlock',
  'formatIdentityRows'
];
const identityImport = sliceBetween(bridge, 'import {\n  IDENTITY_DEFAULTS', "} from './identity-core.js';");
check('从 identity-core.js 导入', identityImport !== '');
check('identity-core 的 17 个导出全部导入',
  IDENTITY_IMPORT_NAMES.every((name) => identityImport.includes(name)),
  IDENTITY_IMPORT_NAMES.filter((name) => !identityImport.includes(name)).join(', '));
check('IDENTITY_FILE = state/identity-map.json',
  bridge.includes("const IDENTITY_FILE = path.join(STATE_DIR, 'identity-map.json');"));
check('IDENTITY_FILE 在 STATE_DIR 之后定义',
  bridge.indexOf('const STATE_DIR = ') < bridge.indexOf('const IDENTITY_FILE = '));

const readIdentityFn = extractFunction(bridge, 'function readIdentityState(');
check('readIdentityState 存在', readIdentityFn !== '');
check('读接口用 readJsonSafe(IDENTITY_FILE)',
  readIdentityFn.includes('readJsonSafe(IDENTITY_FILE, null)'));
check('读到对象后过 normalizeIdentityState',
  readIdentityFn.includes('normalizeIdentityState(raw)'));
check('没有文件/坏 JSON → createIdentityState（读不写盘）',
  readIdentityFn.includes('return createIdentityState();')
  && !readIdentityFn.includes('writeIdentityState'));

const writeIdentityFn = extractFunction(bridge, 'function writeIdentityState(');
check('writeIdentityState 存在', writeIdentityFn !== '');
check('落盘前 serialize → parse 往返校验（写出去的一定是对象）',
  writeIdentityFn.includes('parseIdentityState(serializeIdentityState(state))'));
check('落盘走 atomicWriteJson（自带 0600 + tmp/rename）',
  writeIdentityFn.includes('atomicWriteJson(IDENTITY_FILE, payload)'));
check('atomicWriteJson 仍然是 0600',
  bridge.includes('mode: 0o600') || bridge.includes('0o600'));
check('落盘失败只 log 并返回 false（不影响消息处理）',
  writeIdentityFn.includes('log(') && writeIdentityFn.includes('return false;'));

// ── 组二：配置归一 ──────────────────────────────────────────────────────────
console.log('\n── 组二：配置归一 ───────────────────────────────────────');

const identityNorm = bridge.indexOf('cfg.socialV2.identity = normalizeIdentityConfig(cfg.socialV2?.identity);');
const crossNorm = bridge.indexOf('cfg.socialV2.cross = normalizeCrossConfig(cfg.socialV2?.cross);');
check('loadConfig 里归一 identity', identityNorm > 0);
check('identity 归一在 cross 归一之后', crossNorm > 0 && identityNorm > crossNorm,
  `cross=${crossNorm}, identity=${identityNorm}`);
check('identity 归一只有一处入口',
  bridge.split('cfg.socialV2.identity = normalizeIdentityConfig(').length === 2);

// ── 组三：refreshIdentityMap 与启动调度 ─────────────────────────────────────
console.log('\n── 组三：refreshIdentityMap 与启动调度 ───────────────────');

const refreshFn = extractFunction(bridge, 'async function refreshIdentityMap(');
check('refreshIdentityMap 存在', refreshFn !== '');
check('enabled=false 整体短路（不拉名单、不落盘）',
  refreshFn.includes("cfg.socialV2?.identity?.enabled === false) return { ok: false, reason: 'disabled' };")
  && refreshFn.indexOf("reason: 'disabled'") < refreshFn.indexOf('get_friend_list'));
check('拉好友列表 get_friend_list', refreshFn.includes("fetchIdentityList('get_friend_list', {})"));
check('拉群列表 get_group_list', refreshFn.includes("fetchIdentityList('get_group_list', {})"));
check('只对 cfg.allow.groups 里的群拉成员',
  refreshFn.includes('for (const raw of cfg.allow?.groups ?? [])')
  && refreshFn.includes("fetchIdentityList('get_group_member_list', { group_id: Number(gid) })"));
check('成员合并用 applyMemberList（先群后成员）',
  refreshFn.includes('applyMemberList(state, gid, list, at, config)')
  && refreshFn.indexOf('applyGroupList(') < refreshFn.indexOf('applyMemberList('));
check('单群失败只 log 后继续（每群独立 try）',
  refreshFn.includes('拉取群 ${gid} 成员失败（跳过）') && refreshFn.includes('continue;'));
check('刷完落盘', refreshFn.includes('saveIdentityState();'));
check('日志格式：好友 N / 群 M / 成员 K',
  refreshFn.includes('`[identity] 名字表已刷新：好友 ${friends} / 群 ${groups} / 成员 ${members}`'));
check('返回 { ok:true, counts }（POST 端点直接回它）',
  refreshFn.includes('return { ok: true, counts };'));

const fetchListFn = extractFunction(bridge, 'async function fetchIdentityList(');
check('fetchIdentityList 用 oneBotActionNested + 15 秒超时',
  fetchListFn.includes('oneBotActionNested(cfg, action, params, 15000)'));
check('列表失败判定：!res.ok 与 status failed/error 都要抛',
  fetchListFn.includes('if (!res?.ok) throw') && fetchListFn.includes('body?.status === \'failed\''));

check('启动 10 秒后先跑一次', bridge.includes('}, 10 * 1000);'));
check('之后按 refreshIntervalMs 定时', bridge.includes('}, identityEveryMs);')
  && bridge.includes('Number(cfg.socialV2?.identity?.refreshIntervalMs) || IDENTITY_DEFAULTS.refreshIntervalMs'));
check('两个定时器都 unref（不拖住进程退出）',
  bridge.includes('identityFirstTimer.unref?.();') && bridge.includes('identityRefreshTimer.unref?.();'));
check('调度整体在 enabled=false 时跳过',
  bridge.includes('if (cfg.socialV2?.identity?.enabled !== false) {'));

// ── 组四：消息增量与 10 分钟写盘节流 ────────────────────────────────────────
console.log('\n── 组四：消息增量与 10 分钟写盘节流 ─────────────────────');

const appendMsgFn = extractFunction(bridge, 'function appendSocialV2Message(');
check('appendSocialV2Message 末尾调用 recordIdentityMessage',
  appendMsgFn.includes('recordIdentityMessage(key, sender, userId);'));
check('增量钩子在 recordCrossMessage 之后（顺序无关紧要，但只加一处）',
  appendMsgFn.split('recordIdentityMessage(').length === 2);

const upsertFn = extractFunction(bridge, 'function recordIdentityMessage(');
check('recordIdentityMessage 存在', upsertFn !== '');
check('enabled=false 时不写内存也不写盘',
  upsertFn.includes('cfg.socialV2?.identity?.enabled === false) return;'));
check('先校验 key / qq / 名字，脏数据直接丢',
  upsertFn.includes('/^(group|private):\\d{1,20}$/') && upsertFn.includes('/^[1-9]\\d*$/'));
check('私聊 upsertPrivate 标 source: message',
  upsertFn.includes("upsertPrivate(state, { qq, name, at: now, source: 'message' })"));
check('群消息先 upsertGroup 再 upsertMember',
  upsertFn.includes('upsertGroup(state, { gid, at: now })') && upsertFn.includes('upsertMember(state, gid, { qq, name, at: now })'));
check('非白名单群不凭空建壳（先查 allow.groups）',
  upsertFn.includes('(cfg.allow?.groups ?? []).map((value) => String(value))')
  && upsertFn.includes('if (!allowed.includes(gid)) return;'));
check('10 分钟节流常量', bridge.includes('const IDENTITY_WRITE_THROTTLE_MS = 10 * 60 * 1000;'));
check('节流按会话 key 记时间（identityWriteThrottle）',
  upsertFn.includes('const last = identityWriteThrottle.get(k) ?? 0;')
  && upsertFn.includes('if (now - last < IDENTITY_WRITE_THROTTLE_MS) return;'));
check('只有 upsert 真报告变化才落盘',
  upsertFn.includes('if (!changed) return;') && upsertFn.includes('if (saveIdentityState()) identityWriteThrottle.set(k, now);'));
check('最近活跃行：好友/群各取前 30',
  bridge.includes('const IDENTITY_RECENT_LIMIT = 30;')
  && bridge.includes('function recentIdentityRows(state, limit = IDENTITY_RECENT_LIMIT)'));

// ── 组五：两个端点与鉴权分工 ────────────────────────────────────────────────
console.log('\n── 组五：两个端点与鉴权分工 ─────────────────────────────');

const GET_MARK = "req.method === 'GET' && url.pathname === '/api/socialV2/identity'";
const POST_MARK = "req.method === 'POST' && url.pathname === '/api/socialV2/identity/refresh'";
check('GET /api/socialV2/identity 存在', bridge.includes(GET_MARK));
check('POST /api/socialV2/identity/refresh 存在', bridge.includes(POST_MARK));
check('两个端点在 cross/recall 之后、qzone 配置之前',
  bridge.indexOf("url.pathname === '/api/socialV2/cross/recall'") < bridge.indexOf(GET_MARK)
  && bridge.indexOf(POST_MARK) < bridge.indexOf("url.pathname === '/api/qzone/config'"));

const getBlock = sliceBetween(bridge, GET_MARK, POST_MARK);
check('GET 带 agent token 时只要求 isLiveAgentToken（读类放宽、不绑 key）',
  getBlock.includes("if (agentToken && !isLiveAgentToken(agentToken)) {")
  && !getBlock.includes('agentTokenOk('));
check('GET 令牌错返回 bad_token', getBlock.includes("reason: 'bad_token'"));
check('GET 返回 ok/updatedAt/counts/rows',
  getBlock.includes('ok: true') && getBlock.includes('updatedAt: Number(state?.updatedAt) || 0')
  && getBlock.includes('counts: identityCounts(state),') && getBlock.includes('rows,'));
check('GET 有 q 走 lookupIdentity（行形状与 core 一致）',
  getBlock.includes('lookupIdentity(state, q, { limit }).rows'));
check('GET 空 q 走「最近活跃」（好友 30 + 群 30）',
  getBlock.includes(': recentIdentityRows(state, IDENTITY_RECENT_LIMIT)'));
check('GET limit 默认 identity.queryLimit',
  getBlock.includes('const defaultLimit = Number(cfg.socialV2?.identity?.queryLimit) || 20;'));
check('GET 附 formatIdentityRows 的人话行', getBlock.includes('lines: formatIdentityRows(rows)'));

const adminLine = bridge.split('\n').find((line) => line.includes('const adminOnlyV2Paths = [')) ?? '';
check('adminOnlyV2Paths 含 /api/socialV2/identity/refresh',
  adminLine.includes("'/api/socialV2/identity/refresh'"));
check('adminOnlyV2Paths 不含只读的 /api/socialV2/identity',
  !adminLine.includes("'/api/socialV2/identity'"));

const postBlock = sliceBetween(bridge, POST_MARK, '// 配置：POST body 支持四键的');
check('POST refresh 同步 await refreshIdentityMap()',
  postBlock.includes('const result = await refreshIdentityMap();'));
check('POST refresh 返回 counts', postBlock.includes('counts: result.counts'));
check('disabled 时 403 且说清原因',
  postBlock.includes('if (!result.ok)') && postBlock.includes('socialV2.identity.enabled=false'));

// ── 组六：prompt 里的 identity 块 ───────────────────────────────────────────
console.log('\n── 组六：prompt 里的 identity 块 ────────────────────────');

const promptIdentity = sliceBetween(bridge, 'identity: (() => {', 'cross: (() => {');
check('prompt 有 identity 字段', promptIdentity !== '');
check('identity 块在 cross 块之前', bridge.indexOf('identity: (() => {') < bridge.indexOf('cross: (() => {'));
check('identity 块在 images 之后、cross 之前',
  bridge.indexOf('images: (() => {') < bridge.indexOf('identity: (() => {'));
check('配置关掉时整块 enabled:false',
  promptIdentity.includes('if (cfg.socialV2?.identity?.enabled === false) return { enabled: false };'));
check('speakers 取当前会话 recentMessages 里最近 8 个非 self',
  promptIdentity.includes('Array.isArray(st.recentMessages)')
  && promptIdentity.includes('if (!m || m.isSelf) continue;')
  && promptIdentity.includes('speakers.length < 8'));
check('speaker 用号码 + 显示名（userId / sender）',
  promptIdentity.includes('String(m.userId ?? m.qq ?? \'\')') && promptIdentity.includes('name: String(m.sender ?? \'\')'));
check('同一号码只留一条（按 qq 去重）',
  promptIdentity.includes('seen.has(qq)') && promptIdentity.includes('seen.add(qq)'));
check('调 identityPromptBlock(identityStateNow(), key, { speakers, speakerLimit: 8 })',
  promptIdentity.includes('identityPromptBlock(identityStateNow(), key, { speakers, speakerLimit: 8 })'));

// ── 组七：跨会话发送授权 ────────────────────────────────────────────────────
console.log('\n── 组七：跨会话发送授权 ─────────────────────────────────');

const sessionKeyFn = extractFunction(bridge, 'const agentTokenSessionKey = (token) => {');
check('agentTokenSessionKey 按令牌反查会话', sessionKeyFn !== '');
check('反查遍历 socialV2.conversations + tokenEq（与 isLiveAgentToken 同口径）',
  sessionKeyFn.includes('for (const [k, st] of socialV2.conversations)')
  && sessionKeyFn.includes('tokenEq(token, st.agentToken)'));

const coversSendFn = extractFunction(bridge, 'const agentTokenCoversSend = (key, token) => {');
check('agentTokenCoversSend 存在', coversSendFn !== '');
check('先认原绑定（agentTokenOk）', coversSendFn.includes('if (agentTokenOk(key, token)) return true;'));
check('没有主人的会话直接 false', coversSendFn.includes('if (!ownerKey) return false;'));
check('从 cfg.socialV2.cross.groups 取互通编号',
  coversSendFn.includes('cfg.socialV2?.cross?.groups ?? {}')
  && coversSendFn.includes('const targetGid = groupOf(groups, key);')
  && coversSendFn.includes('const ownerGid = groupOf(groups, ownerKey);'));
check('只有 targetGid > 0 且两边相同才放行',
  coversSendFn.includes('return targetGid > 0 && targetGid === ownerGid;'));
check('授权函数定义在 isLiveAgentToken 之后',
  bridge.indexOf('const isLiveAgentToken = (token) =>') < bridge.indexOf('const agentTokenCoversSend = (key, token) =>'));

// 六个真正发消息的端点（+ imageAuthFailed 的带 key 那一支）必须换成 coversSend。
const sendBlocks = [
  ['send-burst', sliceBetween(bridge, "url.pathname === '/api/socialV2/send-burst'", "url.pathname === '/api/socialV2/send-message'")],
  ['send-message', sliceBetween(bridge, "url.pathname === '/api/socialV2/send-message'", "url.pathname === '/api/socialV2/send-poke'")],
  ['send-poke', sliceBetween(bridge, "url.pathname === '/api/socialV2/send-poke'", "url.pathname === '/api/socialV2/sticker-image'")],
  ['send-voice', sliceBetween(bridge, "url.pathname === '/api/socialV2/send-voice'", "url.pathname === '/api/socialV2/send-sticker'")],
  ['send-sticker', sliceBetween(bridge, "url.pathname === '/api/socialV2/send-sticker'", "url.pathname === '/api/socialV2/collect-sticker'")],
  ['/api/send/group|private|reply', bridge.slice(bridge.indexOf("url.pathname === '/api/send/group'"), bridge.indexOf("url.pathname === '/api/send/group'") + 3000)]
];
for (const [name, block] of sendBlocks) {
  check(`${name} 用 agentTokenCoversSend`, block.includes('agentTokenCoversSend('));
  check(`${name} 不再用 agentTokenOk( 做发送判定`, !block.includes('!agentTokenOk('));
  check(`${name} 403 文案统一`, block.includes(UNIFIED_403));
}

const imageAuthFn = extractFunction(bridge, 'function imageAuthFailed(req, key)');
check('imageAuthFailed 带 key 那一支改用 coversSend',
  imageAuthFn.includes('if (key && !agentTokenCoversSend(key, agentToken)) {'));
check('imageAuthFailed 不带 key 的分支仍是 isLiveAgentToken',
  imageAuthFn.includes('!isLiveAgentToken(agentToken)'));

// 读/状态类端点必须保持原绑定：跨会话能发，但不等于能读别人的状态。
const promptApiBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/prompt'", 'replyTiming: replyTimingV2');
check('prompt 端点仍是 agentTokenOk（读类不放开）',
  promptApiBlock.includes('agentTokenOk(key') && !promptApiBlock.includes('agentTokenCoversSend('));
const recallBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/cross/recall'", '// ── 名字映射表（T-018）');
check('cross/recall 仍是 agentTokenOk', recallBlock.includes('agentTokenOk(key, agentToken)')
  && !recallBlock.includes('agentTokenCoversSend('));
const unreadBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/unread'", "url.pathname === '/api/socialV2/recent'");
check('unread 端点仍是 agentTokenOk', unreadBlock.includes('agentTokenOk(key'));

check('统一 403 文案至少覆盖 7 处（6 个发送端点 + imageAuthFailed）',
  bridge.split(UNIFIED_403).length - 1 >= 7,
  `实际 ${bridge.split(UNIFIED_403).length - 1} 处`);
check('旧的「agent token 无效」短文案仍留给读端点', bridge.includes("error: 'agent token 无效' }"));

// ── 组八：审计 harness 注入 ────────────────────────────────────────────────
console.log('\n── 组八：审计 harness 注入 ──────────────────────────────');

const harness = read('scripts/audit-bridge-harness.mjs');
check('harness 导入 identityCore',
  harness.includes("import * as identityCore from '../src/identity-core.js';"));
check('harness 在 VM context 里展开 identityCore', harness.includes('...identityCore,'));

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
