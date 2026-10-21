#!/usr/bin/env node
// 自我资料接线（T-014 步骤 2）：五个端点的契约测试。
//
// 为什么是「静态」断言：src/bridge.js 在模块顶层就 loadConfig() 并 createServer()，
// import 它会把桥接真的跑起来、把 QQ 会话接上去——测试里绝不该做这件事。
// 所以这里只读源码文本 + 切片，钉死这一层的五件事：
//   ① 五个端点存在（两个 GET、三个 POST），且都在令牌关卡之后；
//   ② 三个 POST 共用 handleProfileUpdate，闸门顺序是
//      enabled → 内容审计 → 额度 → 读旧值 → OneBot → 读回 → 记账；
//   ③ 读回不一致（not_applied / pending）绝不记账，签名读不到时降级但不失败；
//   ④ 头像端点走 avatarUrl + safeFetchBuffer，640 失败回落 100；
//   ⑤ 状态文件用 atomicWriteJson（tmp+rename），配置只在 loadConfig 里归一，
//      profile 路径**不在** adminOnlyV2Paths 里（模型要能自己改）。
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
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return -1;
  return text.slice(0, index).split('\n').length;
}
/** 从 a 到 b 之间的源码切片；任一端找不到就给空串（断言会红，比抛错好定位）。 */
function sliceBetween(text, a, b) {
  const start = text.indexOf(a);
  if (start < 0) return '';
  const end = text.indexOf(b, start + a.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}
/** `}, 429)` 这类收尾块：从最后一次 sendJson({ 截到状态码。 */
function sendBlockBefore(text, marker) {
  const end = text.indexOf(marker);
  if (end < 0) return '';
  const start = text.lastIndexOf('sendJson({', end);
  return start < 0 ? '' : text.slice(start, end + marker.length);
}
/**
 * 从 `functionName(` 的声明处切出整个函数源码（花括号配平）。
 *
 * 为什么要抠源码：profileWaitText / sameProfileValue 这些 helper 定义在
 * startConsoleServer 的闭包里，模块级没法 import；但它们是纯函数，把源码取出来
 * 用 new Function 跑一遍就能做真断言，而不是只对着字符串猜。模板串里的 `${x}`
 * 花括号成对出现，配平计数不受影响。
 */
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return '';
  let depth = 0;
  for (let i = text.indexOf('{', start); i >= 0 && i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

const bridge = read('src/bridge.js');

const AVATAR_PATH = '/api/avatar';
const PROFILE_PATH = '/api/socialV2/profile';
const NICKNAME_PATH = '/api/socialV2/profile/nickname';
const SIGNATURE_PATH = '/api/socialV2/profile/signature';
const GROUP_CARD_PATH = '/api/socialV2/profile/group-card';
const esc = (p) => p.replace(/\//g, '\\/');

// ── 组一：五个端点的存在与形状 ─────────────────────────────────────────────
console.log('── 组一：五个端点的存在与形状 ──────────────────────────────');
const avatarBranch = new RegExp(`if \\(req\\.method === 'GET' && url\\.pathname === '${esc(AVATAR_PATH)}'\\)`);
const profileBranch = new RegExp(`if \\(req\\.method === 'GET' && url\\.pathname === '${esc(PROFILE_PATH)}'\\)`);
const nicknameBranch = new RegExp(`if \\(req\\.method === 'POST' && url\\.pathname === '${esc(NICKNAME_PATH)}'\\)`);
const signatureBranch = new RegExp(`if \\(req\\.method === 'POST' && url\\.pathname === '${esc(SIGNATURE_PATH)}'\\)`);
const groupCardBranch = new RegExp(`if \\(req\\.method === 'POST' && url\\.pathname === '${esc(GROUP_CARD_PATH)}'\\)`);
check('GET /api/avatar 是 GET 分支（method 与 pathname 同时判定）', avatarBranch.test(bridge));
check('GET /api/socialV2/profile 是 GET 分支', profileBranch.test(bridge));
check('POST /api/socialV2/profile/nickname 是 POST 分支', nicknameBranch.test(bridge));
check('POST /api/socialV2/profile/signature 是 POST 分支', signatureBranch.test(bridge));
check('POST /api/socialV2/profile/group-card 是 POST 分支', groupCardBranch.test(bridge));

// 令牌关卡：所有 /api 请求先过它。端点行号在它之后 = 静默继承整套鉴权。
const tokenLine = lineOf(bridge, 'resolveRequestToken({');
check('能定位到令牌关卡 resolveRequestToken({', tokenLine > 0, `行号 ${tokenLine}`);
for (const [label, needle] of [
  ['/api/avatar', `url.pathname === '${AVATAR_PATH}'`],
  ['/api/socialV2/profile', `url.pathname === '${PROFILE_PATH}'`],
  ['nickname', `url.pathname === '${NICKNAME_PATH}'`],
  ['signature', `url.pathname === '${SIGNATURE_PATH}'`],
  ['group-card', `url.pathname === '${GROUP_CARD_PATH}'`]
]) {
  const line = lineOf(bridge, needle);
  check(`${label} 端点位于令牌关卡之后（继承鉴权）`, line > tokenLine, `端点行 ${line} / 关卡行 ${tokenLine}`);
}

// 三个 POST 共用一套实现：路由块只调 runProfileUpdate，不许各写一份。
const routeBlock = sliceBetween(bridge, `if (req.method === 'POST' && url.pathname === '${NICKNAME_PATH}')`, "// 配置：POST body 支持四键的**部分更新**");
check('三个 POST 路由都只调 runProfileUpdate(', (routeBlock.match(/await runProfileUpdate\(req, res, '/g) ?? []).length === 3, String(routeBlock.length));
check("路由块分别传 'nickname' / 'signature' / 'groupCard'",
  routeBlock.includes("runProfileUpdate(req, res, 'nickname')")
  && routeBlock.includes("runProfileUpdate(req, res, 'signature')")
  && routeBlock.includes("runProfileUpdate(req, res, 'groupCard')"));

// 集中关卡：MCP 的 agentHeaders 恒带 x-agent-call: 1 但不带会话令牌（工具签名里没有
// key/token 参数），所以这四条路径必须在「无令牌智能体调用」白名单里，否则第一次调用就 403。
const tokenlessBlock = sliceBetween(bridge, 'const tokenlessAgentAllowed =', 'if (!tokenlessAgentAllowed)');
for (const p of [AVATAR_PATH, PROFILE_PATH, NICKNAME_PATH, SIGNATURE_PATH, GROUP_CARD_PATH]) {
  check(`无令牌智能体白名单包含 '${p}'`, tokenlessBlock.includes(`'${p}'`), tokenlessBlock.slice(0, 80));
}
check('白名单上方的注释解释了「为什么这四个例外不是管理端」', bridge.includes('自我资料四端点 + 头像'));

// 头像端点同时接受会话令牌：agentAllowed 必须放行 /api/avatar，否则「带令牌反而 403」。
const agentAllowedBlock = sliceBetween(bridge, 'const agentAllowed =', 'if (!agentAllowed)');
check("agentAllowed 放行 '/api/avatar'", agentAllowedBlock.includes(`'${AVATAR_PATH}'`), agentAllowedBlock.slice(0, 120));

// 改资料是 AI 对自己的操作，不是管理端：不得进 adminOnlyV2Paths。
const adminStart = bridge.indexOf('const adminOnlyV2Paths = [');
const adminEnd = bridge.indexOf('];', adminStart);
const adminBlock = adminStart < 0 || adminEnd < 0 ? '' : bridge.slice(adminStart, adminEnd + 2);
check('解析到 adminOnlyV2Paths 数组', adminBlock.includes("'/api/socialV2/config'") && adminBlock.includes("'/api/socialV2/automation'"), adminBlock.slice(0, 120));
for (const p of [AVATAR_PATH, PROFILE_PATH, NICKNAME_PATH, SIGNATURE_PATH, GROUP_CARD_PATH]) {
  check(`'${p}' 不在 adminOnlyV2Paths 里`, adminBlock !== '' && !adminBlock.includes(`'${p}'`));
}

// ── 组二：handleProfileUpdate 的七步顺序 ──────────────────────────────────
console.log('── 组二：改资料闸门的顺序（七步） ──────────────────────────');
const handleBody = sliceBetween(bridge, 'async function handleProfileUpdate(req, res, kind) {', 'async function runProfileUpdate(req, res, kind) {');
check('能切出 handleProfileUpdate 的函数体', handleBody.length > 2000, `长度 ${handleBody.length}`);

const step = {
  enabled: handleBody.indexOf('if (profileCfg.enabled === false)'),
  audit: handleBody.indexOf('verdict = checkNickname('),
  quota: handleBody.indexOf('const quota = quotaFor('),
  oldValue: handleBody.indexOf("let oldValue = ''"),
  setOneBot: handleBody.indexOf("await profileOneBot('set_qq_profile'"),
  readBack: handleBody.indexOf('let verified = true;'),
  notApplied: handleBody.indexOf("reason: 'not_applied'"),
  record: handleBody.indexOf('recordChange(state, {'),
  persist: handleBody.indexOf('writeProfileState(nextState)')
};
const stepOrder = ['enabled', 'audit', 'quota', 'oldValue', 'setOneBot', 'readBack', 'notApplied', 'record', 'persist'];
let orderOk = stepOrder.every((key) => step[key] >= 0);
for (let i = 1; i < stepOrder.length && orderOk; i++) {
  if (!(step[stepOrder[i - 1]] < step[stepOrder[i]])) orderOk = false;
}
check('七步顺序：enabled → 内容 → 额度 → 读旧值 → OneBot → 读回 → not_applied → 记账 → 落盘', orderOk, JSON.stringify(step));
check('记账在读回校验（not_applied 分支）之后', step.record > step.notApplied && step.notApplied > step.setOneBot);
check('落盘只在记账之后', step.persist > step.record);

// ① 鉴权：带会话令牌时必须能对上会话且模式允许；不带令牌的请求已过全局关卡。
check('带 x-agent-token 时要求 key（bad_key）', handleBody.includes("reason: 'bad_key'"));
check('校验 agentTokenOk(key, agentToken)', handleBody.includes('agentTokenOk(key, agentToken)'));
check('校验 v2SessionAllowed(key)', handleBody.includes('v2SessionAllowed(key)'));
check('会话不允许时 403 session_not_allowed', handleBody.includes("reason: 'session_not_allowed'"));

// ② 开关：显式 false 才关（缺省 = 开，与 normalizeProfileConfig 一致）。
check('开关判定用 enabled === false（缺省即启用）', handleBody.includes('profileCfg.enabled === false'));
check('关闭时 403 disabled', handleBody.includes("reason: 'disabled'") && handleBody.includes('}, 403)'));

// ③ 内容：先清洗（按该 kind 的 maxChars）再审计，审计失败回 reasons[0].code。
check('昵称先 cleanProfileText(body?.nickname) 再 checkNickname',
  handleBody.indexOf('cleanProfileText(body?.nickname') >= 0
  && handleBody.indexOf('cleanProfileText(body?.nickname') < step.audit);
check('签名走 checkSignature(', handleBody.includes('verdict = checkSignature(value, profileCfg.signature)'));
check('群名片走 checkGroupCard(', handleBody.includes('verdict = checkGroupCard(value, profileCfg.groupCard)'));
check('内容不合格 400 且 reason 取 reasons[0]?.code', handleBody.includes("reason: reasons[0]?.code ?? 'rejected'"));
check('内容不合格时回 reasons 与 hits', handleBody.includes('reasons,') && handleBody.includes('hits: Array.isArray(verdict.hits)'));
check('内容审计失败按 400 返回', handleBody.includes('}, 400);'));

// 群号：显式 group_id 优先，缺省从 key 解析；解析不出 400 bad_group；
// 不在 allow.groups 白名单 403 group_not_allowed（先白名单后审计，免得对任意群做探测）。
check('群号显式 group_id 优先、缺省 groupIdFromKey(key)',
  handleBody.includes('const explicit = Number(body?.group_id)') && handleBody.includes('groupIdFromKey(key)'));
check('群号解析不出时 400 bad_group', handleBody.includes("reason: 'bad_group'"));
check('群号必须在 cfg.allow?.groups 里', handleBody.includes('cfg.allow?.groups ?? []'));
check('非白名单群 403 group_not_allowed', handleBody.includes("reason: 'group_not_allowed'"));
check('白名单判定在 checkGroupCard 之前',
  handleBody.indexOf('cfg.allow?.groups ?? []') < handleBody.indexOf('checkGroupCard(value, profileCfg.groupCard)'));

// ④ 额度：quotaFor 不过 → 429，字段是 reason/retryAfterMs/todayCount/remaining。
const quotaBlock = sendBlockBefore(handleBody, '}, 429)');
check('额度不过时返回 429', quotaBlock.length > 0);
for (const field of ['reason: quota.reason', 'retryAfterMs: quota.retryAfterMs', 'todayCount: quota.todayCount', 'remaining: quota.remaining']) {
  check(`429 响应含 ${field}`, quotaBlock.includes(field), quotaBlock.slice(0, 160));
}
check('quotaFor 带 groupId（群名片按群记账）', handleBody.includes("kind === 'groupCard' ? groupId : undefined"));

// 429 文案的时长格式化：真机 smoke 抓到过「约 23 小时 60 分」——ceil 只能进到 59 分，
// 满 60 必须再进一位成小时。这里把 profileWaitText 的源码抠出来真跑一遍：
// 它是纯函数（只碰 Math），从 bridge 源码里 eval 出来不影响任何运行态。
const waitText = extractFunction(bridge, 'function profileWaitText(');
let profileWaitText;
try {
  profileWaitText = new Function(`${waitText}\nreturn profileWaitText;`)();
} catch {
  profileWaitText = undefined;
}
check('profileWaitText 满 60 分时进位到小时（不出现「X 小时 60 分」）',
  waitText.includes('if (minutes >= 60) { hours += 1; minutes = 0; }'));
check('profileWaitText 的 hours/minutes 可进位（let 而非 const）',
  /\blet hours = Math\.floor/.test(waitText) && /\blet minutes = Math\.ceil/.test(waitText));
if (typeof profileWaitText === 'function') {
  check('profileWaitText(86399993) → 24 小时', profileWaitText(86399993) === '24 小时', profileWaitText(86399993));
  check('profileWaitText(21599581) → 6 小时', profileWaitText(21599581) === '6 小时', profileWaitText(21599581));
  check('profileWaitText(45000) → 1 分钟', profileWaitText(45000) === '1 分钟', profileWaitText(45000));
  check('profileWaitText(0) → 空串', profileWaitText(0) === '');
  check('任何取值都不含「60 分」', [1, 59999, 3599999, 86399993, 86400000].every((ms) => !profileWaitText(ms).includes('60 分')));
} else {
  check('profileWaitText 能从 bridge 源码里取出并执行', false);
}

// ⑤ 读旧值：失败不阻断（degraded:true，oldValue 记空串）。
check('旧值读不到时 degraded = true 且不阻断', handleBody.includes('degraded = true') && handleBody.includes("oldValue = ''"));
check('昵称/签名旧值走 readProfileInfo（get_stranger_info）',
  handleBody.includes('readProfileInfo(selfId)')
  && bridge.includes("profileOneBot('get_stranger_info', { user_id: selfId, no_cache: true })"));
check('群名片旧值走 get_group_member_info', handleBody.includes("profileOneBot('get_group_member_info'"));
check('成功响应按需带 degraded:true', handleBody.includes('...(degraded ? { degraded: true } : {})'));

// ⑥ OneBot：三个 action 名必须与 research.md 一致。
check("昵称调 set_qq_profile { nickname }", handleBody.includes("profileOneBot('set_qq_profile', { nickname: target })"));
check("签名调 set_self_longnick { longNick }", handleBody.includes("profileOneBot('set_self_longnick', { longNick: target })"));
check("群名片调 set_group_card { group_id, user_id, card: wireCard }",
  handleBody.includes("profileOneBot('set_group_card', { group_id: groupId, user_id: selfId, card: wireCard })"));
// 真机 smoke 结论：SnowLuma 的 protobuf 编码器在 targetName 为空串时省略整个字段，
// 服务端回 OIDB 1007 / retcode=100。清除只能发半角空格，状态与日志仍记空串。
check('清空群名片时线上发半角空格（wireCard 映射）',
  handleBody.includes("const wireCard = target === '' ? ' ' : target;"));
check('群名片旧值读回后归一（纯空白 → 空串，不把空格写进状态）',
  handleBody.includes("oldValue = typeof member?.card === 'string' ? cleanProfileText(member.card) : '';"));
check('OneBot 失败 502 onebot_error（不抛 500）', handleBody.includes("reason: 'onebot_error'") && handleBody.includes('}, 502)'));

// ⑦ 读回：昵称/名片不一致 → not_applied + pending:true 且不记账；签名读不到字段 → 只降级。
check('读回不一致时回 not_applied', handleBody.includes("reason: 'not_applied'"));
check('not_applied 带 pending:true', handleBody.includes('pending: true'));
check('not_applied 的响应里有 oldValue/newValue/verified', handleBody.includes('oldValue,') && handleBody.includes('newValue: target'));
check('昵称读回不一致才 pending（current === null 也算）',
  handleBody.includes('if (current === null || !sameProfileValue(current, target)) { verified = false; pending = true; }'));
// 签名降级（dev-doc §4）：网关不返回签名字段时只是「无法确认」，记 verified:false 但照常记账；
// 只有「读回来了、值不对」才 pending。两条分支在源码里必须长得不一样。
const sigNullIdx = handleBody.indexOf('if (current === null) verified = false;');
const sigMismatchIdx = handleBody.indexOf('else if (!sameProfileValue(current, target)) { verified = false; pending = true; }');
check('签名读回没有签名字段时只 verified:false、不 pending', sigNullIdx >= 0 && sigMismatchIdx > sigNullIdx, `null=${sigNullIdx} mismatch=${sigMismatchIdx}`);
check('签名候选字段含 sign/longNick/signature/long_nick',
  bridge.includes("for (const field of ['sign', 'longNick', 'signature', 'long_nick'])"));
check('比较前两端都过 cleanProfileText（避免空白假阴性）',
  bridge.includes('return cleanProfileText(actual) === cleanProfileText(expected);'));

// ⑧ 成功：记账 + 落盘 + 日志 + nextAllowedAt。
check('成功时调 recordChange 并写 groupId', handleBody.includes('groupId: kind === \'groupCard\' ? groupId : 0,'));
check('成功响应含 kind/oldValue/newValue/verified/nextAllowedAt',
  handleBody.includes('kind,') && handleBody.includes('verified,') && handleBody.includes('nextAllowedAt: intervalMs > 0 ? ts + intervalMs : 0'));
check("日志前缀是 '[profile] '", handleBody.includes("log(`[profile] ${label}"));
check('落盘失败不把成功变成 500（只带 persisted:false）', handleBody.includes('...(persisted ? {} : { persisted: false })'));

// ⑨ 兜底：未预期异常也回 JSON，不抛到控制台。
const runBody = sliceBetween(bridge, 'async function runProfileUpdate(req, res, kind) {', `if (req.method === 'GET' && url.pathname === '${AVATAR_PATH}')`);
check('runProfileUpdate 用 try/catch 兜底', runBody.includes('try {') && runBody.includes('catch (error)'));
check('兜底路径检查 res.headersSent 后回 500 internal', runBody.includes('if (!res.headersSent)') && runBody.includes("reason: 'internal'"));

// ── 组三：头像端点 ────────────────────────────────────────────────────────
console.log('── 组三：头像端点（avatarUrl + safeFetchBuffer + 回落） ─────');
const avatarBody = sliceBetween(bridge, `if (req.method === 'GET' && url.pathname === '${AVATAR_PATH}')`, `if (req.method === 'GET' && url.pathname === '${PROFILE_PATH}')`);
check('能切出头像 handler', avatarBody.length > 500, `长度 ${avatarBody.length}`);
check('uin 先做 5–12 位纯数字校验', avatarBody.includes('/^\\d{5,12}$/.test(uin)'));
check('uin 非法 400 bad_uin', avatarBody.includes("reason: 'bad_uin'"));
check('size 走 AVATAR_SIZES 白名单、非法回落 640', avatarBody.includes('AVATAR_SIZES.includes(sizeRaw) ? sizeRaw : 640'));
check('640 失败时用 100 再试一次', avatarBody.includes('const sizes = wantedSize === 640 ? [640, 100] : [wantedSize];'));
check('抓图走 safeFetchBuffer(avatarUrl(uin, size), PROFILE_AVATAR_MAX_BYTES)',
  avatarBody.includes('await safeFetchBuffer(avatarUrl(uin, size), PROFILE_AVATAR_MAX_BYTES)'));
check('上限常量是 2 MB', bridge.includes('const PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;'));
check('非图片 502 not_image', avatarBody.includes("failReason = 'not_image'"));
check('两次都失败 502 fetch_failed + detail', avatarBody.includes("reason: failReason") && avatarBody.includes('detail, error: `头像抓取失败：${detail}`'));
check('成功响应含 uin/size/mimeType/bytes/data(base64)',
  avatarBody.includes('mimeType: mimeFromBuffer(buffer)')
  && avatarBody.includes('bytes: buffer.length')
  && avatarBody.includes("data: buffer.toString('base64')"));
check('再次用 looksLikeImageBuffer 兜一层（非图片不进模型上下文）', avatarBody.includes('!looksLikeImageBuffer(fetched.buffer)'));
check('头像鉴权：会话令牌带 key 时校验归属性', avatarBody.includes('agentTokenOk(key, agentToken)') && avatarBody.includes('v2SessionAllowed(key)'));
check('头像鉴权：控制台令牌走 tokenMatches', avatarBody.includes('} else if (!tokenMatches) {'));
check('头像鉴权失败 401', avatarBody.includes('}, 401);'));

// ── 组四：资料快照端点 ────────────────────────────────────────────────────
console.log('── 组四：GET /api/socialV2/profile 的字段 ──────────────────');
const snapshotBody = sliceBetween(bridge, `if (req.method === 'GET' && url.pathname === '${PROFILE_PATH}')`, `if (req.method === 'POST' && url.pathname === '${NICKNAME_PATH}')`);
check('能切出资料快照 handler', snapshotBody.length > 500, `长度 ${snapshotBody.length}`);
check('昵称/签名来自 get_stranger_info', snapshotBody.includes('readProfileInfo(selfId)') && bridge.includes("profileOneBot('get_stranger_info', { user_id: selfId, no_cache: true })"));
check('三项额度各自调 quotaFor', ['nickname', 'signature', 'groupCard'].every((kind) => snapshotBody.includes(`quotaFor(state, profileCfg, '${kind}'`)));
check('额度视图含 remaining/retryAfterMs/lastTs', snapshotBody.includes('remaining: quota.remaining') && snapshotBody.includes('retryAfterMs: quota.retryAfterMs') && snapshotBody.includes('lastTs: quota.lastTs'));
check('changes 只给最近 10 条', snapshotBody.includes('changes: state.changes.slice(0, 10)'));
check('读不到资料卡时给 degraded:true（昵称/签名不会伪装成空）', snapshotBody.includes('...(info ? {} : { degraded: true })'));
check('快照带 profile 上限（让模型知道字数上限）', snapshotBody.includes('nicknameMaxChars: profileCfg.nickname.maxChars'));
check('快照失败回 500 internal（不抛栈）', snapshotBody.includes("reason: 'internal'"));

// ── 组五：状态文件与配置归一 ──────────────────────────────────────────────
console.log('── 组五：状态文件口径与配置归一 ────────────────────────────');
check("状态文件是 state/profile-changes.json（桥接里 STATE_DIR，没有 DATA_DIR）",
  bridge.includes("const PROFILE_STATE_FILE = path.join(STATE_DIR, 'profile-changes.json');"));
const readStateBody = sliceBetween(bridge, 'function readProfileState(now = Date.now()) {', '/**\n * 落盘资料改动账本');
check('readProfileState 用 readJsonSafe 读文件', readStateBody.includes('readJsonSafe(PROFILE_STATE_FILE, null)'));
check('读不到 / 坏 JSON 时回 createProfileState()', readStateBody.includes('createProfileState()'));
check('读到的状态必须过 normalizeProfileState(raw, ts)', readStateBody.includes('normalizeProfileState(raw, ts)'));
const writeStateBody = sliceBetween(bridge, 'function writeProfileState(state) {', '/**\n * 本地自然日键');
check('writeProfileState 只经 atomicWriteJson（tmp+rename 由它负责）', writeStateBody.includes('atomicWriteJson(PROFILE_STATE_FILE, payload)'));
check('落盘前先 serialize+parse 走一遍形状校验', writeStateBody.includes('parseProfileState(serializeProfileState(state))'));
check('落盘失败只记日志并返回 false（不让成功变 500）', writeStateBody.includes('return false;') && !writeStateBody.includes('throw '));
check('写 profile 状态不碰 config.json', !writeStateBody.includes('configFile') && !writeStateBody.includes('readConfigObject'));
check('配置归一只有一处：cfg.socialV2.profile = normalizeProfileConfig(...)',
  (bridge.match(/normalizeProfileConfig\(/g) ?? []).length === 1
  && bridge.includes('cfg.socialV2.profile = normalizeProfileConfig(cfg.socialV2?.profile);'));
check("顶部 import 了 ./profile-core.js", bridge.includes("} from './profile-core.js';"));
for (const name of ['avatarUrl', 'AVATAR_SIZES', 'quotaFor', 'recordChange', 'normalizeProfileState', 'cleanProfileText']) {
  const importBlock = sliceBetween(bridge, "import {\n  PROFILE_DEFAULTS,", "} from './profile-core.js';");
  check(`import 块含 ${name}`, importBlock.includes(name), importBlock.slice(0, 80));
}
check('登录账号走 resolveAutomationSelfId(null)（没有全局 selfId）', handleBody.includes('resolveAutomationSelfId(null)'));
check('拿不到登录号时 502 onebot_error 并说明原因', handleBody.includes('拿不到登录账号'));

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
