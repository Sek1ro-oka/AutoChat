#!/usr/bin/env node
// 跨会话互通接线（T-016 第二步）：配置归一 / ndjson 缓冲 / 三个端点 / prompt 元数据 /
// 唤醒提示的「别处动静」。
//
// 为什么是「静态」断言：src/bridge.js 在模块顶层就 loadConfig() 并 createServer()，
// import 它会把桥接真的跑起来、把 QQ 会话接上去——测试里绝不该做这件事。
// 所以这里只读源码文本 + 切片，钉死这一层的六件事：
//   ① 18 个 cross-core 导出已导入，CROSS_DIR 指向 state/cross；
//   ② 配置在 loadConfig 里归一，config.example.json 有完整 cross 段；
//   ③ 四个写入钩子都调用 recordCrossMessage（且传的是截断前原文）；
//   ④ 三个端点存在、鉴权分工正确（写端点进 adminOnlyV2Paths，recall 不进）；
//   ⑤ recall 的 gid=0 返回 200 空结果 + 「没有找到」，限流是 5 分钟 3 次 / 429；
//   ⑥ prompt 的 cross 块只有 key/label/count/lastAt，不含正文；唤醒提示阈值 ≥2 / ≥3。
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

// ── 组一：导入与常量 ─────────────────────────────────────────────────────────
console.log('\n── 组一：导入与常量 ─────────────────────────────────────');

const CROSS_IMPORT_NAMES = [
  'CROSS_MAX_LIMIT',
  'CROSS_DEFAULT_SINCE_MS',
  'CROSS_DEFAULTS',
  'CROSS_LIMITS',
  'normalizeCrossConfig',
  'normalizeGid',
  'nextFreeGid',
  'assignGroups',
  'groupOf',
  'membersOf',
  'appendEntry',
  'recallEntries',
  'crossIndex',
  'formatRecallLines',
  'humanKeyLabel',
  'serializeCrossState',
  'emptyCrossState',
  'parseCrossState'
];
const crossImport = sliceBetween(bridge, 'import {\n  CROSS_MAX_LIMIT', "} from './cross-core.js';");
check('从 cross-core.js 导入', crossImport !== '');
check('cross-core 的 18 个导出全部导入', CROSS_IMPORT_NAMES.every((name) => crossImport.includes(name)),
  CROSS_IMPORT_NAMES.filter((name) => !crossImport.includes(name)).join(', '));
check('CROSS_DIR = state/cross', bridge.includes("const CROSS_DIR = path.join(STATE_DIR, 'cross');"));
check('cross 缓冲用 .ndjson', bridge.includes('.ndjson'));

// ── 组二：配置归一与示例配置 ─────────────────────────────────────────────────
console.log('\n── 组二：配置归一与示例配置 ─────────────────────────────');

const profileNorm = bridge.indexOf('cfg.socialV2.profile = normalizeProfileConfig(cfg.socialV2?.profile);');
const crossNorm = bridge.indexOf('cfg.socialV2.cross = normalizeCrossConfig(cfg.socialV2?.cross);');
check('loadConfig 里归一 cross', crossNorm > 0);
check('cross 归一在 profile 归一之后', profileNorm > 0 && crossNorm > profileNorm,
  `profile=${profileNorm}, cross=${crossNorm}`);
check('cross 归一只有一处入口', bridge.split('cfg.socialV2.cross = normalizeCrossConfig(').length === 2);

const example = JSON.parse(read('config.example.json'));
const exampleCross = example.socialV2?.cross;
check('config.example.json 有 socialV2.cross', !!exampleCross);
check('示例 enabled=true', exampleCross?.enabled === true);
check('示例 bufferPerConversation=500', exampleCross?.bufferPerConversation === 500);
check('示例 groups 是空对象', exampleCross?.groups && typeof exampleCross.groups === 'object'
  && !Array.isArray(exampleCross.groups) && Object.keys(exampleCross.groups).length === 0);

// ── 组三：ndjson 缓冲 ────────────────────────────────────────────────────────
console.log('\n── 组三：ndjson 缓冲 ────────────────────────────────────');

const recordFn = extractFunction(bridge, 'function recordCrossMessage(');
const loadFn = extractFunction(bridge, 'function loadCrossChannel(');
const fileFn = extractFunction(bridge, 'function crossChannelFile(');
check('recordCrossMessage 存在', recordFn !== '');
check('loadCrossChannel 存在', loadFn !== '');
check("文件名把 ':' 换成 '_'", fileFn.includes(".replace(/:/g, '_')") && fileFn.includes('CROSS_DIR'));
check('enabled=false 直接 return（不写盘）', recordFn.includes('cfg.socialV2?.cross?.enabled === false')
  && /enabled === false\) return;/.test(recordFn));
check('首次见到会话用 assignGroups 补号', recordFn.includes('assignGroups([key], groups)'));
check('补号后立刻写 config（writeCrossGroups）', recordFn.includes('writeCrossGroups(assigned.map)'));
check('追加前按 groupOf 取 gid', recordFn.includes('groupOf(groups, key)'));
check('用 appendEntry 往 store 追加', recordFn.includes('appendEntry(crossStore, { key, gid, entry, limit })'));
check('写 ndjson 用 appendFileSync + 一行 JSON + 换行',
  recordFn.includes('fs.appendFileSync(crossChannelFile(key)') && recordFn.includes('JSON.stringify(last)'));
check('先 mkdirSync CROSS_DIR', recordFn.includes('fs.mkdirSync(CROSS_DIR, { recursive: true })'));
const rewriteFn = extractFunction(bridge, 'function maybeRewriteCrossFile(');
check('超过 buffer 走整文件重写', recordFn.includes('maybeRewriteCrossFile(key, limit)'));
check('行数每次追加都 +1（不能只在 dropped>0 时数）', rewriteFn.includes('(crossChannelLines.get(key) ?? 0) + 1')
  && !rewriteFn.includes('dropped <= 0'));
check('重写用 atomicWriteText（tmp+rename）', bridge.includes('atomicWriteText(crossChannelFile(key)'));
check('读文件不存在/坏行返回空数组', loadFn.includes('catch') && loadFn.includes('entries = []'));
check('只读最后 bufferPerConversation 条', loadFn.includes('lines.slice(-limit)'));
check('缓存上限 20 个会话', bridge.includes('const CROSS_CACHE_LIMIT = 20;')
  && loadFn.includes('crossChannelCache.size > CROSS_CACHE_LIMIT'));
check('逐行 JSON.parse 并跳过坏行', loadFn.includes('JSON.parse(line)') && loadFn.includes('跳过坏行'));
check('文件行数和缓存同步（重写阈值用）', loadFn.includes('crossChannelLines.set(key, lines.length)'));

// ── 组四：四个写入钩子 ──────────────────────────────────────────────────────
console.log('\n── 组四：四个写入钩子 ──────────────────────────────────');

const appendMsgFn = extractFunction(bridge, 'function appendSocialV2Message(');
const pokeFn = extractFunction(bridge, 'function appendSocialV2Poke(');
const sentFn = extractFunction(bridge, 'function recordSentMessagesV2(');
const voiceFn = extractFunction(bridge, 'function recordVoiceSentV2(');
check('appendSocialV2Message 调用 recordCrossMessage', appendMsgFn.includes('recordCrossMessage('));
check('appendSocialV2Poke 调用 recordCrossMessage', pokeFn.includes('recordCrossMessage('));
check('recordSentMessagesV2 调用 recordCrossMessage', sentFn.includes('recordCrossMessage('));
check('recordVoiceSentV2 调用 recordCrossMessage', voiceFn.includes('recordCrossMessage('));
check('入站消息用的是 plainContent/textContent 原串，不是 msg.text',
  appendMsgFn.includes("String(plainContent ?? '').trim() !== '' ? String(plainContent) : String(textContent ?? '')")
  && !/text:\s*msg\.text/.test(appendMsgFn));
check('拍一拍保存截断前 fullText 并传给 recordCrossMessage',
  pokeFn.includes('const fullText = `[拍一拍]') && pokeFn.includes('text: fullText'));
check('自己发的消息用截断前 fullText',
  sentFn.includes('const fullText = redactKnownTokensOnly(') && sentFn.includes('text: fullText'));
check('语音消息用 [语音 …] 描述', voiceFn.includes('text: display'));
check('isSelf 标记正确（入站 false / 出站 true）',
  appendMsgFn.includes('isSelf: false') && sentFn.includes('isSelf: true') && voiceFn.includes('isSelf: true'));

// ── 组五：三个端点与鉴权分工 ────────────────────────────────────────────────
console.log('\n── 组五：三个端点与鉴权分工 ────────────────────────────');

const GET_MARK = "req.method === 'GET' && url.pathname === '/api/socialV2/cross'";
const POST_MARK = "req.method === 'POST' && url.pathname === '/api/socialV2/cross'";
const RECALL_MARK = "req.method === 'POST' && url.pathname === '/api/socialV2/cross/recall'";
check('GET /api/socialV2/cross 存在', bridge.includes(GET_MARK));
check('POST /api/socialV2/cross 存在', bridge.includes(POST_MARK));
check('POST /api/socialV2/cross/recall 存在', bridge.includes(RECALL_MARK));
check('三个端点都在资料端点之后、qzone 配置之前',
  bridge.indexOf("url.pathname === '/api/socialV2/profile/group-card'") < bridge.indexOf(RECALL_MARK)
  && bridge.indexOf(RECALL_MARK) < bridge.indexOf("url.pathname === '/api/qzone/config'"));

const adminLine = bridge.split('\n').find((line) => line.includes('const adminOnlyV2Paths = [')) ?? '';
check('adminOnlyV2Paths 含 /api/socialV2/cross', adminLine.includes("'/api/socialV2/cross'"));
check('adminOnlyV2Paths 不含 /api/socialV2/cross/recall', !adminLine.includes("'/api/socialV2/cross/recall'"));
const adminComment = sliceBetween(bridge, '//   cross         ——', 'const adminOnlyV2Paths');
check('注释说明写端点=管理语义、recall 不算', adminComment.includes('管理语义')
  && adminComment.includes('cross/recall') && adminComment.includes('不**进'));

const getBlock = sliceBetween(bridge, GET_MARK, POST_MARK);
check('GET 返回 ok/enabled/bufferPerConversation/conversations',
  getBlock.includes('ok: true') && getBlock.includes('enabled: cfg.socialV2?.cross?.enabled !== false')
  && getBlock.includes('bufferPerConversation: crossBufferLimit()') && getBlock.includes('conversations'));
check('GET 会话来源 = groups ∪ 二代会话',
  getBlock.includes('new Set(Object.keys(groups))')
  && getBlock.includes('socialV2.conversations.keys()'));
check('GET 每项含 key/label/owner/gid/count/lastAt',
  ['key,', 'owner: key === ownerKey', 'gid: groupOf(groups, key)', 'count: entries.length', 'lastAt']
    .every((piece) => getBlock.includes(piece)));
// 主人私聊永远在列表里，而且编号可改：它有专门的一行 label，不是靠 humanKeyLabel 兜底。
check('GET 把主人私聊补进 keys，并给主人专用 label',
  getBlock.includes('const ownerKey = cfg.ownerQQ ?') && getBlock.includes('if (ownerKey) keys.add(ownerKey)')
  && getBlock.includes('label: key === ownerKey ? `主人（私聊 ${String(cfg.ownerQQ)}）` : humanKeyLabel(key)'));
check('GET 按 lastAt 降序', getBlock.includes('(b.lastAt - a.lastAt)'));

const postBlock = sliceBetween(bridge, POST_MARK, RECALL_MARK);
check('POST 校验 key 正则', postBlock.includes('/^(group|private):\\d{1,20}$/'));
check('POST 遇到坏 key 返回 bad_key', postBlock.includes("reason: 'bad_key'"));
check('POST 用 normalizeGid 校验 gid', postBlock.includes('normalizeGid(value)'));
check('POST 遇到坏 gid 返回 bad_gid', postBlock.includes("reason: 'bad_gid'"));
check('POST 合并写回 groups', postBlock.includes('writeCrossGroups(merged)'));
check('POST 返回 ok/groups', postBlock.includes('ok: true, groups: cfg.socialV2.cross.groups'));

const recallBlock = sliceBetween(bridge, RECALL_MARK, '// 配置：POST body 支持四键的');
check('recall 用 x-agent-token + agentTokenOk', recallBlock.includes("req.headers['x-agent-token']")
  && recallBlock.includes('agentTokenOk(key, agentToken)'));
check('recall 校验当前模式会话白名单', recallBlock.includes('v2SessionAllowed(key)')
  && recallBlock.includes("reason: 'session_not_allowed'"));
check('recall 令牌错返回 bad_token', recallBlock.includes("reason: 'bad_token'"));
check('cross.enabled=false → 403 disabled', recallBlock.includes("reason: 'disabled'")
  && recallBlock.includes('403'));

const gidZeroBlock = sliceBetween(recallBlock, 'if (gid <= 0) {', 'const now = Date.now();');
check('gid=0 分支存在', gidZeroBlock !== '');
check('gid=0 返回 200 + total:0（不是 403）',
  gidZeroBlock.includes('total: 0') && gidZeroBlock.includes('rows: []') && gidZeroBlock.includes('lines: []')
  && !gidZeroBlock.includes('403'));
check('gid=0 hint 含「没有找到」', gidZeroBlock.includes('没有找到匹配记录，请不要推测。'));

check('recall 有 5 分钟窗口常量', bridge.includes('const CROSS_RECALL_WINDOW_MS = 5 * 60 * 1000;'));
check('recall 有每窗 3 次常量', bridge.includes('const CROSS_RECALL_MAX_PER_WINDOW = 3;'));
check('第 4 次返回 429 rate_limited', recallBlock.includes("reason: 'rate_limited'")
  && recallBlock.includes('429') && recallBlock.includes('retryAfterMs'));
check('recall 返回 gid/total/rows/lines/hint',
  recallBlock.includes('gid,') && recallBlock.includes('total,') && recallBlock.includes('rows,')
  && recallBlock.includes('lines: formatRecallLines(rows)'));
check('recall 固定出处提示', recallBlock.includes('以上内容来自其它会话；引用时请说明出处，不要向当前对话的第三方透露。'));
check('excludeSelf 会过滤自己并重算 total',
  recallBlock.includes('row?.isSelf !== true') && recallBlock.includes('total = filtered.length'));

// ── 组六：prompt 元数据与唤醒提示 ───────────────────────────────────────────
console.log('\n── 组六：prompt 元数据与唤醒提示 ────────────────────────');

const promptBlock = sliceBetween(bridge, 'cross: (() => {', 'replyTiming: replyTimingV2');
check('prompt 有 cross 字段', promptBlock !== '');
check('prompt cross 含 enabled/group/others/hint',
  promptBlock.includes('enabled: true') && promptBlock.includes('group: gid')
  && promptBlock.includes('others,') && promptBlock.includes('hint:'));
check('prompt others 只映射 key/label/count/lastAt',
  promptBlock.includes('key: o.key') && promptBlock.includes('label: humanKeyLabel(o.key)')
  && promptBlock.includes('count: o.count') && promptBlock.includes('lastAt: o.lastAt'));
check('prompt cross 不含消息正文（无 text 字段）',
  !/text\s*:/.test(promptBlock) && !promptBlock.includes('o.text') && !promptBlock.includes('.text'));
check('gid<=0 / disabled 时 enabled:false',
  promptBlock.includes('return { enabled: false }'));
check('prompt hint 指向 qq_recall', promptBlock.includes('要回忆细节用 qq_recall'));

const hintFn = extractFunction(bridge, 'function buildCrossHintLineV2(');
check('buildCrossHintLineV2 存在', hintFn !== '');
check('唤醒提示阈值 ≥2 条且 ≥3 轮',
  hintFn.includes('freshTotal >= 2') && hintFn.includes('wakeSeq - crossHintWake >= 3'));
check('唤醒提示文案是【别处动静】', hintFn.includes('【别处动静】'));
check('唤醒提示带「这只是通知」与 qq_recall', hintFn.includes('这只是通知，不需要现在处理')
  && hintFn.includes('qq_recall'));
check('注入后记账 crossHintTs/crossHintWake 并落盘',
  hintFn.includes('st.crossHintTs = lastAt || Date.now();')
  && hintFn.includes('st.crossHintWake = wakeSeq;')
  && hintFn.includes('saveSocialV2State();'));
check('crossLine 插在 statusLine 与 wakeLine 之间',
  bridge.includes('statusLine + crossLine + wakeLine'));
check('每次真实唤醒 wakeSeq +1',
  bridge.includes('st.wakeSeq = (Number(st.wakeSeq) || 0) + 1;'));

check('状态默认对象含 wakeSeq/crossHintTs/crossHintWake',
  /wakeSeq: 0,\n\s+crossHintTs: 0,\n\s+crossHintWake: 0,/.test(bridge));
check('loadSocialV2State 映射三个新字段',
  bridge.includes('wakeSeq: Number(val.wakeSeq) || 0,')
  && bridge.includes('crossHintTs: Number(val.crossHintTs) || 0,')
  && bridge.includes('crossHintWake: Number(val.crossHintWake) || 0,'));
check('saveSocialV2State 持久化三个新字段',
  bridge.includes('wakeSeq: st.wakeSeq || 0,')
  && bridge.includes('crossHintTs: st.crossHintTs || 0,')
  && bridge.includes('crossHintWake: st.crossHintWake || 0,'));

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
