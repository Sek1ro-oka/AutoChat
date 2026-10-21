#!/usr/bin/env node
// 跨渠道共享记忆 + 日记共用（T-016 第三步）的自检。
//
// 为什么是「源码切片 + 迷你沙箱」而不是 import src/bridge.js：bridge.js 在模块顶层就
// loadConfig() 并 createServer()，import 它会把桥接真的跑起来、把 QQ 会话接上去。
// 这里只做纯逻辑验证：从源码切出几个函数，在 new Function 里注入最小依赖执行，
// 不碰真实 config.json / state/，也不联网。
//
// 覆盖面：
//   组一 diaryKeyFor / crossGidOf：同组会话 → cross:<gid>，gid=0 原样
//   组二 resolveMemberQq：recentMessages 与 cross 缓冲两处、取最近、跳过自己
//   组三 appendMemoryV2：qq:<id> 落库、同键合并、解析不到退回名字键、50 条上限
//   组四 formatMemoryV2 / formatSharedMemoryV2：合并同组、出处标注、去重、30 行裁剪
//   组五 接线：日记读写端点、memory 四个端点、prompt payload、唤醒提示
//   组六 diary-store 的 cross 支持（可执行）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupOf, membersOf, humanKeyLabel } from '../src/cross-core.js';
import { diaryKeyOk, diaryFolderName, writeDiaryEntry, listDiaryEntries } from '../src/diary-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 统一把 CRLF 折成 LF：仓库源码在 Windows 下是 CRLF，跨行断言不该被行尾符绊倒。
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

// ── 组一：从源码切出被测函数 ────────────────────────────────────────────────
console.log('\n── 组一：源码切片 ───────────────────────────────────────');

const PIECES = {
  crossGidOf: extractFunction(bridge, 'function crossGidOf('),
  diaryKeyFor: extractFunction(bridge, 'function diaryKeyFor('),
  impressionDisplayV2: extractFunction(bridge, 'function impressionDisplayV2('),
  resolveMemberQq: extractFunction(bridge, 'function resolveMemberQq('),
  formatMemoryV2: extractFunction(bridge, 'function formatMemoryV2('),
  appendMemoryV2: extractFunction(bridge, 'function appendMemoryV2('),
  formatSharedMemoryV2: extractFunction(bridge, 'function formatSharedMemoryV2(')
};
for (const [name, source] of Object.entries(PIECES)) {
  check(`${name} 能从 bridge.js 切出`, source.length > 40, `${source.length} 字符`);
}
check('crossGidOf 用 groupOf 查 groups',
  PIECES.crossGidOf.includes('groupOf(cfg.socialV2?.cross?.groups ?? {}')
  && PIECES.crossGidOf.includes('String(key ?? \'\').trim()'));
check('diaryKeyFor 只在 gid>0 时改成 cross:<gid>',
  PIECES.diaryKeyFor.includes('crossGidOf(k) > 0 ? `cross:${crossGidOf(k)}` : k'));
check('appendMemoryV2 有第 5 个参数 ctx = {}',
  /function appendMemoryV2\(st, category, content, extra = \{\}, ctx = \{\}\)/.test(PIECES.appendMemoryV2));
check('印象分支用 extra.qq 或 resolveMemberQq(ctx.key, target)',
  PIECES.appendMemoryV2.includes('String(extra.qq ?? \'\').trim()')
  && PIECES.appendMemoryV2.includes('resolveMemberQq(channelKey, target)'));

// 迷你沙箱：把切出来的函数放进同一作用域，注入它们依赖的少数几个名字。
// 与真实 bridge 的差异只有 IO 桩（不写盘、不读 cross 文件），逻辑是同一份源码。
const buildSandbox = new Function('groupOf', 'membersOf', 'humanKeyLabel', `
  const cfg = { socialV2: { cross: { groups: {} } } };
  const socialV2 = { conversations: new Map() };
  const stub = { saves: 0 };
  const crossBuffers = new Map();
  function canonicalV2Key(key) {
    const m = /^(group|private):(\\d+)$/.exec(String(key ?? '').trim());
    if (!m) return null;
    const id = Number(m[2]);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return m[1] + ':' + id;
  }
  function getSocialV2State(key) {
    const canonical = canonicalV2Key(key);
    if (!canonical) throw new Error('无效的会话 key：' + String(key));
    let st = socialV2.conversations.get(canonical);
    if (!st) {
      st = { recentMessages: [], activeTopics: [], pendingThoughts: [], memberImpressions: {} };
      socialV2.conversations.set(canonical, st);
    }
    return st;
  }
  function saveSocialV2State() { stub.saves += 1; }
  function redactKnownTokensOnly(value) { return String(value ?? ''); }
  function truncateText(value, max) {
    const s = String(value ?? '');
    return s.length > max ? s.slice(0, max) : s;
  }
  function loadCrossChannel(key) { return crossBuffers.get(canonicalV2Key(key) ?? key) ?? []; }
  ${PIECES.crossGidOf}
  ${PIECES.diaryKeyFor}
  ${PIECES.impressionDisplayV2}
  ${PIECES.resolveMemberQq}
  ${PIECES.formatMemoryV2}
  ${PIECES.appendMemoryV2}
  ${PIECES.formatSharedMemoryV2}
  return {
    cfg, socialV2,
    state: getSocialV2State,
    saveCount: () => stub.saves,
    setCross(key, entries) { crossBuffers.set(canonicalV2Key(key) ?? key, entries); },
    crossGidOf, diaryKeyFor, resolveMemberQq, appendMemoryV2, formatMemoryV2, formatSharedMemoryV2
  };
`);

const makeSandbox = () => {
  const sb = buildSandbox(groupOf, membersOf, humanKeyLabel);
  sb.cfg.socialV2.cross.groups = {
    'group:100': 3,
    'private:200': 3,
    'group:300': 4,
    'group:999': 0
  };
  return sb;
};

// ── 组二：diaryKeyFor / crossGidOf ─────────────────────────────────────────
console.log('\n── 组二：日记 key 按互通组归一 ─────────────────────────');

const sb1 = makeSandbox();
check("gid>0 的群聊 → 'cross:3'", sb1.diaryKeyFor('group:100') === 'cross:3');
check("同组的私聊 → 同一个 'cross:3'", sb1.diaryKeyFor('private:200') === 'cross:3');
check('gid=0 原样返回自己的 key', sb1.diaryKeyFor('group:999') === 'group:999');
check('没分组的会话原样返回', sb1.diaryKeyFor('group:888') === 'group:888');
check('带空白的 key 先 trim', sb1.diaryKeyFor('  group:100  ') === 'cross:3');
check('crossGidOf 对 gid=0 返回 0', sb1.crossGidOf('group:999') === 0);
check('crossGidOf 对非法 key 返回 0', sb1.crossGidOf('cross:3') === 0 && sb1.crossGidOf('') === 0);
check('cross:<gid> 本身就是合法日记 key（幂等）', sb1.diaryKeyFor('cross:3') === 'cross:3');

// ── 组三：resolveMemberQq ──────────────────────────────────────────────────
console.log('\n── 组三：显示名 → QQ ───────────────────────────────────');

const sb2 = makeSandbox();
const st100 = sb2.state('group:100');
st100.recentMessages.push(
  { sender: '阿花', userId: '2001', time: 1000 },
  { sender: 'Alice', userId: '3003', time: 1500 },
  { sender: '没有QQ', userId: null, time: 1600 },
  { sender: '我', userId: null, isSelf: true, time: 1700 }
);
check('从 recentMessages 解析出 QQ', sb2.resolveMemberQq('group:100', '阿花') === '2001');
check('名字匹配大小写不敏感', sb2.resolveMemberQq('group:100', 'alice') === '3003');
check('名字两端空白被忽略', sb2.resolveMemberQq('group:100', '  阿花  ') === '2001');
check('没有 QQ 的消息不产生映射', sb2.resolveMemberQq('group:100', '没有QQ') === null);
check('找不到的名字返回 null', sb2.resolveMemberQq('group:100', '陌生人') === null);
check('非法会话 key 返回 null（不抛错）', sb2.resolveMemberQq('bogus:x', '阿花') === null);

sb2.setCross('group:100', [
  { ts: 5000, from: '小明', fromQq: '4004', isSelf: false, text: '在吗' },
  { ts: 9000, from: '阿花', fromQq: '9999', isSelf: false, text: '换号了' },
  { ts: 10000, from: '阿花', fromQq: '7777', isSelf: true, text: '我自己的消息不该参与' }
]);
check('从 cross 缓冲解析出 QQ', sb2.resolveMemberQq('group:100', '小明') === '4004');
check('同名多映射取最近一次（缓冲比 recentMessages 新）', sb2.resolveMemberQq('group:100', '阿花') === '9999');
check('缓冲里自己发的消息不参与映射', sb2.resolveMemberQq('group:100', '阿花') !== '7777');
check('缓冲与最近消息都查不到时仍返回 null', sb2.resolveMemberQq('group:100', '路人') === null);

// ── 组四：appendMemoryV2 以 qq:<id> 落库并合并 ─────────────────────────────
console.log('\n── 组四：印象按 QQ 落库与合并 ──────────────────────────');

const sb3 = makeSandbox();
const g100 = sb3.state('group:100');
g100.recentMessages.push({ sender: '阿花', userId: '2001', time: 1000 });

sb3.appendMemoryV2(g100, 'memberImpression', '话多', { target: '阿花' }, { key: 'group:100' });
const im1 = g100.memberImpressions['qq:2001'];
check('解析到 QQ 时键是 qq:<id>', !!im1 && !('阿花' in g100.memberImpressions));
check('值里带 qq / names / channels',
  im1.qq === '2001' && typeof im1.names['阿花'] === 'number' && im1.channels.includes('group:100'));
check('首次写入 interactionCount=1', im1.interactionCount === 1);
check('traits 记下内容', Array.isArray(im1.traits) && im1.traits[0] === '话多');

sb3.appendMemoryV2(g100, 'memberImpression', '话多', { target: '阿花' }, { key: 'group:100' });
check('同键再写一次：interactionCount 累加', g100.memberImpressions['qq:2001'].interactionCount === 2);
check('同一 trait 不重复', g100.memberImpressions['qq:2001'].traits.length === 1);
sb3.appendMemoryV2(g100, 'memberImpression', '热心', { target: '阿花' }, { key: 'group:100' });
check('新 trait 追加', g100.memberImpressions['qq:2001'].traits.join('、') === '话多、热心');

const p200 = sb3.state('private:200');
p200.recentMessages.push({ sender: '花姐', userId: '2001', time: 2000 });
sb3.appendMemoryV2(p200, 'memberImpression', '好说话', { target: '花姐' }, { key: 'private:200' });
const imP = p200.memberImpressions['qq:2001'];
check('同一个人换群名片仍然是 qq:2001', !!imP);
check('names 记下第二个显示名', !!imP.names['花姐']);
check('channels 记下第二个会话', imP.channels.includes('private:200'));

// 两个会话的状态是分开的，跨会话合并由 formatSharedMemoryV2 负责。
check('跨会话不共享同一个状态对象', g100.memberImpressions !== p200.memberImpressions);

sb3.appendMemoryV2(g100, 'memberImpression', '神秘', { target: '神秘人', qq: '8888' }, { key: 'group:100' });
check('explicit extra.qq 优先于反查', g100.memberImpressions['qq:8888']?.qq === '8888');

sb3.appendMemoryV2(g100, 'memberImpression', '普通', { target: '路人甲' }, { key: 'group:100' });
check('解析不到 QQ 时退回名字键', !!g100.memberImpressions['路人甲']);
check('名字键的值补 name 字段', g100.memberImpressions['路人甲'].name === '路人甲');
check('名字键不带 qq / names', !g100.memberImpressions['路人甲'].qq && !g100.memberImpressions['路人甲'].names);

const beforeSave = sb3.saveCount();
sb3.appendMemoryV2(g100, 'memberImpression', 'x', { target: '__proto__' }, { key: 'group:100' });
check('__proto__ 目标被拒（不写键）', !Object.prototype.hasOwnProperty.call(g100.memberImpressions, '__proto__'));
check('被拒的写入不落盘', sb3.saveCount() === beforeSave);

const cap = sb3.state('group:700');
for (let i = 0; i < 60; i += 1) {
  sb3.appendMemoryV2(cap, 'memberImpression', `t${i}`, { target: `路人${i}`, qq: String(9000 + i) }, { key: 'group:700' });
}
const capKeys = Object.keys(cap.memberImpressions);
check('印象上限 50 条', capKeys.length === 50, `实际 ${capKeys.length}`);
check('按 lastSeenAt 淘汰最旧（最新一条还在）', capKeys.includes('qq:9059'));

// ── 组五：formatMemoryV2 兼容两种键 ────────────────────────────────────────
console.log('\n── 组五：单会话展示兼容旧名字键 ────────────────────────');

const sb4 = makeSandbox();
const show = sb4.state('group:800');
show.memberImpressions = {
  'qq:2001': { qq: '2001', names: { 阿花: 100, 花姐: 200 }, traits: ['话多'], interactionCount: 3, lastSeenAt: 5, channels: ['group:800'] },
  老人: { name: '老人', traits: ['稳'], interactionCount: 1, lastSeenAt: 4 }
};
const single = sb4.formatMemoryV2(show);
check('单会话展示有印象段', single.includes('【对群友的印象】'));
check('qq 键显示最近的名字并带 QQ', single.includes('- 花姐（QQ 2001）：话多（互动 3 次）'));
check('旧名字键照旧显示', single.includes('- 老人：稳（互动 1 次）'));
show.memberImpressions['qq:5555'] = { traits: [], interactionCount: 0 };
check('没有 names 的 qq 键退回键名', sb4.formatMemoryV2(show).includes('- qq:5555（QQ 5555）：暂无记录（互动 0 次）'));

// ── 组六：formatSharedMemoryV2 合并同组 ────────────────────────────────────
console.log('\n── 组六：跨会话共享展示 ────────────────────────────────');

const sb5 = makeSandbox();
const now = Date.now();
const self = sb5.state('group:100');
self.activeTopics = [
  { text: '周末爬山', lastMentionAt: now - 60000, participants: [], pendingQuestion: '' },
  { text: '谁去过西山', lastMentionAt: now - 120000, participants: [], pendingQuestion: '要不要一起？' }
];
self.pendingThoughts = [
  { text: '想问问谁去', createdAt: now - 5000, motivation: 'curiosity' },
  { text: '别太晚', createdAt: now - 90000, motivation: 'worry' }
];
self.memberImpressions = {
  'qq:2001': { qq: '2001', names: { 阿花: now - 90000 }, traits: ['话多'], interactionCount: 2, lastSeenAt: now - 1000, channels: ['group:100'] }
};
const other = sb5.state('private:200');
other.activeTopics = [
  { text: '周末爬山', lastMentionAt: now - 300000, participants: [], pendingQuestion: '' },
  { text: '工作吐槽', lastMentionAt: now - 5000, participants: [], pendingQuestion: '' }
];
other.pendingThoughts = [{ text: '想问问谁去', createdAt: now - 50000, motivation: 'curiosity' }];
other.memberImpressions = {
  'qq:2001': { qq: '2001', names: { 花姐: now - 200 }, traits: ['话多', '热心'], interactionCount: 3, lastSeenAt: now, channels: ['private:200'] }
};
sb5.state('group:999').activeTopics = [{ text: '只有本群知道', lastMentionAt: now - 1000, participants: [], pendingQuestion: '' }];

const shared = sb5.formatSharedMemoryV2('group:100');
check('共享展示有话题段', shared.includes('【进行中的话题】'));
check('自身话题不加出处', shared.includes('- 周末爬山') && !shared.includes('- 周末爬山（来自'));
check('其它会话的话题加出处', shared.includes('（来自 私聊 200）') && shared.includes('工作吐槽'));
check('同一文本只出现一次', (shared.match(/周末爬山/g) || []).length === 1);
check('想法段来自同组', shared.includes('【你想说但还没说的】'));
check('同一想法去重（自身较新，因此无出处）',
  (shared.match(/想问问谁去/g) || []).length === 1 && shared.includes('- 想问问谁去（curiosity）'));
check('印象段合并同一个 QQ', (shared.match(/互动 5 次/g) || []).length === 1);
check('印象 traits 去重', (shared.match(/话多/g) || []).length === 1 && shared.includes('话多、热心'));
check('印象名字取最近的（花姐）', shared.includes('- 花姐（QQ 2001）：'));
check('共享展示只含本组内容', !shared.includes('只有本群知道'));

const savesBefore = sb5.saveCount();
sb5.formatSharedMemoryV2('group:100');
check('formatSharedMemoryV2 不写盘（不 saveSocialV2State）', sb5.saveCount() === savesBefore);

const single999 = sb5.formatMemoryV2(sb5.state('group:999'));
check('gid=0 时等价单会话展示', sb5.formatSharedMemoryV2('group:999') === single999);
check('gid=0 的展示不串组', !single999.includes('周末爬山'));

// 30 行裁剪：话题 20 + 想法 20 + 印象 10，超了先丢话题。
const sb6 = makeSandbox();
const huge = sb6.state('group:100');
huge.activeTopics = Array.from({ length: 20 }, (_, i) => ({ text: `话题${i}`, lastMentionAt: now - (20 - i) * 1000 }));
huge.pendingThoughts = Array.from({ length: 20 }, (_, i) => ({ text: `想法${i}`, createdAt: now - (20 - i) * 1000, motivation: 'curiosity' }));
huge.memberImpressions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
  `qq:${3000 + i}`,
  { qq: String(3000 + i), names: { [`群友${i}`]: now - i }, traits: ['t'], interactionCount: 1, lastSeenAt: now - i, channels: ['group:100'] }
]));
const hugeText = sb6.formatSharedMemoryV2('group:100');
const hugeLines = hugeText.split('\n').filter(Boolean);
check('共享展示总行数 ≤ 30', hugeLines.length <= 30, `实际 ${hugeLines.length}`);
// 每段各自最多 10 行，所以 3 段全满时是 33 行，只需要丢 3 条话题。丢的是最旧的那几条。
check('裁剪从最旧的话题开始丢（最新话题与印象保留）',
  !hugeText.includes('- 话题10（') && hugeText.includes('- 话题19（') && hugeText.includes('【对群友的印象】'));
check('裁剪后想法仍在', hugeText.includes('【你想说但还没说的】'));

// ── 组七：接线（日记读写 / memory 端点 / prompt） ─────────────────────────
console.log('\n── 组七：桥接接线 ─────────────────────────────────────');

const diaryWriteBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/diary-write'", "url.pathname === '/api/socialV2/diary-list'");
check('diary-write 用 diaryKeyFor 归一 key', diaryWriteBlock.includes('const diaryKey = diaryKeyFor(key);'));
check('diary-write 落盘用归一后的 key', diaryWriteBlock.includes('key: diaryKey,'));
check('diary-write 回带 folder 也用归一 key', diaryWriteBlock.includes('folder: diaryFolderName(diaryKey)'));
const diaryListBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/diary-list'", "url.pathname === '/api/socialV2/diary-read'");
check('diary-list 用 diaryKeyFor', diaryListBlock.includes('key: diaryKeyFor(key)'));
const diaryReadBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/diary-read'", "url.pathname === '/api/socialV2/slang/query'");
check('diary-read 用 diaryKeyFor', diaryReadBlock.includes('key: diaryKeyFor(key),'));

const ventBlock = sliceBetween(bridge, 'async function publishVentDiary(', '// ── 文案会话');
check('宣泄日记并入互通组', ventBlock.includes('const diaryKey = diaryKeyFor(`private:${owner}`);'));
check('宣泄日记用归一后的 key 写入', ventBlock.includes('key: diaryKey,'));

const appendBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/memory-append'", "url.pathname === '/api/socialV2/memory-update'");
check('memory-append 把会话 key 传给 appendMemoryV2', appendBlock.includes('appendMemoryV2(st, category, content, extra, { key })'));

const updateBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/memory-update'", "url.pathname === '/api/socialV2/memory'");
check('memory-update 先按原键命中', updateBlock.includes('Object.prototype.hasOwnProperty.call(st.memberImpressions, raw)'));
check('memory-update 不命中时反查 QQ', updateBlock.includes('resolveMemberQq(key, raw)'));
check('memory-update 命中 qq 键时改 names 不改键', updateBlock.includes('const qqKey = /^qq:\\d{1,20}$/.test(hitTarget);')
  && updateBlock.includes('names[newTarget] = Date.now();'));
check('memory-update 名字键仍允许改名（搬键）', updateBlock.includes('delete st.memberImpressions[hitTarget];')
  && updateBlock.includes('im.name = newTarget;'));

const removeBlock = sliceBetween(bridge, "url.pathname === '/api/socialV2/memory-remove'", "url.pathname === '/api/socialV2/memory-clear'");
check('memory-remove 不命中时反查 QQ', removeBlock.includes('const qq = resolveMemberQq(key, target);'));

check('prompt payload 用 formatSharedMemoryV2(key)', bridge.includes('memory: formatSharedMemoryV2(key),'));
check('唤醒提示用 formatSharedMemoryV2(key)', bridge.includes('const memoryText = formatSharedMemoryV2(key);'));
check('formatSharedMemoryV2 不落盘 / 不读盘',
  !PIECES.formatSharedMemoryV2.includes('saveSocialV2State')
  && !PIECES.formatSharedMemoryV2.includes('loadCrossChannel')
  && !PIECES.formatSharedMemoryV2.includes('fs.')
  && !PIECES.formatSharedMemoryV2.includes('writeFile'));

// ── 组八：diary-store 的 cross 支持（可执行） ────────────────────────────────
console.log('\n── 组八：diary-store 支持 cross:<gid> ──────────────────');

check('diaryKeyOk 接受 cross:3', diaryKeyOk('cross:3'));
check('cross 文件夹名是 cross_3', diaryFolderName('cross:3') === 'cross_3');
check('cross 缺编号被拒', !diaryKeyOk('cross:'));
check('cross 非数字被拒', !diaryKeyOk('cross:abc') && !diaryKeyOk('cross:1x'));
let storeErr = '';
try { diaryFolderName('cross:abc'); } catch (error) { storeErr = String(error?.message ?? error); }
check('diary-store 错误文案提到 cross:', storeErr.includes('cross:<互通组编号>'), storeErr);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-memory-diary-'));
try {
  const w = writeDiaryEntry({ root: tmpRoot, key: 'cross:3', content: '共用的一页。', now });
  check('cross:<gid> 能写日记', w.ok === true && w.key === 'cross:3');
  check('文件落在 cross_3/<日期>.md', fs.existsSync(path.join(tmpRoot, 'cross_3', `${w.date}.md`)));
  check('列表回带 cross_3 文件夹名', listDiaryEntries({ root: tmpRoot, key: 'cross:3', now }).folder === 'cross_3');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
