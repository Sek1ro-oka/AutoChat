// 跨渠道互通纯函数（src/cross-core.js）的单测。
//
// 跑法：`node scripts/test-cross-core.mjs`（全过 exit 0，有失败 exit 1）。
//
// 零依赖：不碰 state/、不连网络、不读系统时钟 —— 时间全是常量假时钟（T0 注入）。
//
// 覆盖（对应 dev-doc §七 的断言重点）：
//   组1  normalizeGid：非负整数 / 数字字符串 / 各种脏输入
//   组2  normalizeCrossConfig：enabled 缺省与显式 false、buffer 49/50/2000/2001、groups 键过滤
//   组3  分组：nextFreeGid 取最小空号、assignGroups 不动 0、groupOf、membersOf 插入顺序
//   组4  appendEntry：正常追加 / 超限丢弃并累计 evicted / 超长截断 / 非法 entry 不抛 / limit 钳制
//   组5  recallEntries 过滤：gid=0、排除当前会话、时间窗、person（QQ / 名字）、query 原串与 bigram
//   组6  recallEntries 打分与排序：三项权重、同分按 ts 降序、未来时间钳制、limit 钳制
//   组7  crossIndex：others 排序 / lastAt / count / gid=0
//   组8  序列化往返：serialize→parse 等价、稳定排序、脏文本容错、entries 过滤
//   组9  humanKeyLabel / formatRecallLines 形状
//   组10 纯函数性（只读入参）+ 常量冻结
import {
  CROSS_DEFAULTS,
  CROSS_LIMITS,
  CROSS_MAX_LIMIT,
  CROSS_DEFAULT_SINCE_MS,
  normalizeGid,
  normalizeCrossConfig,
  nextFreeGid,
  assignGroups,
  groupOf,
  membersOf,
  appendEntry,
  recallEntries,
  crossIndex,
  formatRecallLines,
  humanKeyLabel,
  serializeCrossState,
  parseCrossState,
  emptyCrossState
} from '../src/cross-core.js';

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

/** 浮点近似（默认容差 1e-12，打分公式只有四则运算，不需要更松）。 */
function near(actual, expected, tolerance = 1e-12) {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

/** 递归按键名排序后再 JSON 化：用来做「结构等价」比较（不受对象字段顺序影响）。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 假时钟：北京时间 2026-10-20 10:00（注入给纯函数，不依赖本机时区）。 */
const NOW = Date.parse('2026-10-20T10:00:00+08:00');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ── 组1：normalizeGid ──────────────────────────────────────────────────────
console.log('\n── 组1：normalizeGid 只认非负整数 ──');

check('非负整数原样：0 → 0、3 → 3', normalizeGid(0) === 0 && normalizeGid(3) === 3);
check("数字字符串：'3' → 3、'0' → 0", normalizeGid('3') === 3 && normalizeGid('0') === 0);
check('0 是合法值而不是 null（必须能区分「不共享」与「没设置」）',
  normalizeGid(0) === 0 && normalizeGid(0) !== null);
check('负数 / 小数 / 科学计数法 / 带空格 → null',
  normalizeGid(-1) === null && normalizeGid(3.7) === null && normalizeGid('3.0') === null
  && normalizeGid('1e3') === null && normalizeGid(' 3 ') === null);
check('NaN / Infinity / 空串 → null',
  normalizeGid(Number.NaN) === null && normalizeGid(Number.POSITIVE_INFINITY) === null
  && normalizeGid('') === null && normalizeGid('   ') === null);
check('null / undefined / 对象 / 数组 / 布尔 → null（不抛）',
  normalizeGid(null) === null && normalizeGid(undefined) === null
  && normalizeGid({}) === null && normalizeGid([]) === null
  && normalizeGid(true) === null && normalizeGid(false) === null && normalizeGid('x') === null);
check('超出安全整数范围 → null（不返回一个已经失真的数）',
  normalizeGid(2 ** 53) === null && normalizeGid('99999999999999999999') === null
  && normalizeGid(Number.MAX_SAFE_INTEGER) === Number.MAX_SAFE_INTEGER);

// ── 组2：normalizeCrossConfig ──────────────────────────────────────────────
console.log('\n── 组2：normalizeCrossConfig 默认值与钳制 ──');

const cfgDefault = normalizeCrossConfig({});
check('空对象 → enabled true / buffer 500 / groups {}',
  cfgDefault.enabled === true && cfgDefault.bufferPerConversation === CROSS_DEFAULTS.bufferPerConversation
  && stable(cfgDefault.groups) === '{}');
check('undefined / null / 字符串 / 数组 / 数字都回落默认（不抛）',
  normalizeCrossConfig().bufferPerConversation === 500
  && normalizeCrossConfig(null).enabled === true
  && normalizeCrossConfig('x').bufferPerConversation === 500
  && normalizeCrossConfig([]).enabled === true
  && normalizeCrossConfig(42).bufferPerConversation === 500);

check('enabled 只有显式 false 才关：false / 缺省 / \'false\' / 0 / null',
  normalizeCrossConfig({ enabled: false }).enabled === false
  && normalizeCrossConfig({}).enabled === true
  && normalizeCrossConfig({ enabled: 'false' }).enabled === true
  && normalizeCrossConfig({ enabled: 0 }).enabled === true
  && normalizeCrossConfig({ enabled: null }).enabled === true);

check('buffer 边界：49→50、50→50、2000→2000、2001→2000',
  normalizeCrossConfig({ bufferPerConversation: 49 }).bufferPerConversation === 50
  && normalizeCrossConfig({ bufferPerConversation: 50 }).bufferPerConversation === 50
  && normalizeCrossConfig({ bufferPerConversation: 2000 }).bufferPerConversation === 2000
  && normalizeCrossConfig({ bufferPerConversation: 2001 }).bufferPerConversation === 2000);
check('buffer 小数向下取整、数字字符串被接受、坏值回落 500',
  normalizeCrossConfig({ bufferPerConversation: 500.9 }).bufferPerConversation === 500
  && normalizeCrossConfig({ bufferPerConversation: '600' }).bufferPerConversation === 600
  && normalizeCrossConfig({ bufferPerConversation: 'x' }).bufferPerConversation === 500
  && normalizeCrossConfig({ bufferPerConversation: Number.POSITIVE_INFINITY }).bufferPerConversation === 500);

// T-020：prompt 自动带同组最近消息的两个旋钮（默认 5 条 / 2 小时，0 表示关掉）。
check('recentPerKey 默认 5、边界 0/20、坏值回落',
  normalizeCrossConfig({}).recentPerKey === 5
  && normalizeCrossConfig({ recentPerKey: 0 }).recentPerKey === 0
  && normalizeCrossConfig({ recentPerKey: 21 }).recentPerKey === 20
  && normalizeCrossConfig({ recentPerKey: -3 }).recentPerKey === 0
  && normalizeCrossConfig({ recentPerKey: 'x' }).recentPerKey === 5);
check('recentHours 默认 2、边界 0/72、坏值回落',
  normalizeCrossConfig({}).recentHours === 2
  && normalizeCrossConfig({ recentHours: 0 }).recentHours === 0
  && normalizeCrossConfig({ recentHours: 100 }).recentHours === 72
  && normalizeCrossConfig({ recentHours: -1 }).recentHours === 0
  && normalizeCrossConfig({ recentHours: null }).recentHours === 2);

const cfgGroups = normalizeCrossConfig({
  groups: {
    'group:119212385': 2,
    'private:1691642607': 0, // 0 必须留住：用户显式选的「不共享」
    'group:5': '3', // 字符串号归一
    'private:3': -1, // 非法 value → 丢
    'group:abc': 1, // 非法 key → 丢
    'cross:4': 1, // cross: 不属于分组 key → 丢
    nope: 1 // 完全没有前缀 → 丢
  }
});
check('groups 只保留 key 合法且 value 归一成功的项（含 0）',
  stable(cfgGroups.groups) === stable({ 'group:119212385': 2, 'private:1691642607': 0, 'group:5': 3 }));
check('groups 不是对象 → 空对象（不抛）',
  stable(normalizeCrossConfig({ groups: [] }).groups) === '{}'
  && stable(normalizeCrossConfig({ groups: 'x' }).groups) === '{}'
  && stable(normalizeCrossConfig({ groups: null }).groups) === '{}');
check('不改入参、groups 是新的对象（改结果不会污染 raw）', (() => {
  const raw = { enabled: false, bufferPerConversation: 49, groups: { 'group:1': 2, 'bad': 1 } };
  const snapshot = JSON.stringify(raw);
  const out = normalizeCrossConfig(raw);
  out.groups['group:1'] = 99;
  return JSON.stringify(raw) === snapshot && raw.groups['group:1'] === 2;
})());
check('归一化幂等：二次归一结果一致',
  stable(normalizeCrossConfig(cfgGroups)) === stable(cfgGroups));

// ── 组3：分组（找号 / 补号 / 查号 / 成员） ─────────────────────────────────
console.log('\n── 组3：nextFreeGid / assignGroups / groupOf / membersOf ──');

check('nextFreeGid：空 → 1、脏输入 → 1',
  nextFreeGid({}) === 1 && nextFreeGid() === 1 && nextFreeGid(null) === 1 && nextFreeGid('x') === 1);
check('nextFreeGid 有空洞时取最小空号：{1,3} → 2',
  nextFreeGid({ 'group:1': 1, 'group:3': 3 }) === 2);
check('nextFreeGid 跳过 0（0 不占号）与字符串号',
  nextFreeGid({ 'private:1': 0 }) === 1
  && nextFreeGid({ 'group:1': '1', 'group:2': 2 }) === 3);
check('nextFreeGid 连号到底：1..3 占满 → 4',
  nextFreeGid({ a: 1, b: 2, c: 3 }) === 4);

const assignSeed = { 'private:1001': 0, 'group:2002': 5 };
const assignOut = assignGroups(['private:1001', 'group:2002', 'group:3003', 'private:4004'], assignSeed);
check('assignGroups：已存在的 0 原样保留（绝不被覆盖成新号）', assignOut.map['private:1001'] === 0);
check('assignGroups：已存在的 5 保留，新键按最小空号补：1 / 2',
  assignOut.map['group:2002'] === 5
  && assignOut.map['group:3003'] === 1 && assignOut.map['private:4004'] === 2);
check('assignGroups：assigned 只含这次新增的键',
  stable(assignOut.assigned) === stable({ 'group:3003': 1, 'private:4004': 2 }));
check('assignGroups：不改入参（map 是浅拷贝）',
  JSON.stringify(assignSeed) === JSON.stringify({ 'private:1001': 0, 'group:2002': 5 })
  && !('group:3003' in assignSeed));
check('assignGroups：非法 key 跳过、非法 value 修号、字符串号仍占号', (() => {
  const skip = assignGroups(['cross:1', 'nope', 42], {});
  const fix = assignGroups(['group:1'], { 'group:1': 'x' });
  // '4' 是字符串也算占着 4 号，新键只能拿 1（不能把 4 又分出去）
  const str = assignGroups(['group:2'], { 'group:1': '4' });
  return stable(skip.map) === '{}' && stable(skip.assigned) === '{}'
    && fix.map['group:1'] === 1 && stable(fix.assigned) === stable({ 'group:1': 1 })
    && str.map['group:2'] === 1;
})());
check('assignGroups：keys 不是数组 → 原样浅拷贝',
  stable(assignGroups(null, { 'group:1': 2 }).map) === stable({ 'group:1': 2 })
  && stable(assignGroups(undefined, {}).assigned) === '{}');

const groupMap = { 'group:119212385': 2, 'private:1691642607': 0, 'private:1001': 2 };
check('groupOf：合法 gid / 0 / 缺失 / 非法 key',
  groupOf(groupMap, 'group:119212385') === 2
  && groupOf(groupMap, 'private:1691642607') === 0
  && groupOf(groupMap, 'group:999') === 0
  && groupOf(groupMap, 'cross:2') === 0);
check('groupOf：字符串号归一、脏入参不抛',
  groupOf({ 'group:1': '3' }, 'group:1') === 3
  && groupOf(null, 'group:1') === 0 && groupOf({}, null) === 0);

check('membersOf：同组 keys 保持插入顺序',
  JSON.stringify(membersOf(groupMap, 2)) === JSON.stringify(['group:119212385', 'private:1001']));
check('membersOf：gid 0 / 负数 / 非法 → []，字符串 gid 归一',
  membersOf(groupMap, 0).length === 0 && membersOf(groupMap, -1).length === 0
  && membersOf(groupMap, 'x').length === 0 && membersOf(null, 2).length === 0
  && membersOf(groupMap, '2').length === 2);
check('membersOf：0 号会话不会被算进任何组（0 不是「0 号组」）',
  !membersOf(groupMap, 2).includes('private:1691642607'));

// ── 组4：appendEntry 滚动缓冲 ──────────────────────────────────────────────
console.log('\n── 组4：appendEntry 追加 / 丢弃 / 截断 / 容错 ──');

const store4 = emptyCrossState();
const firstAdd = appendEntry(store4, {
  key: 'group:2002',
  gid: 3,
  entry: { ts: NOW, from: '小明', fromQq: 10001, text: '在吗', isSelf: true }
});
const conv4 = store4.conversations['group:2002'];
const entry4 = conv4.entries[0];
check('正常追加：added true / dropped 0 / 会话被创建 / gid 写入 evicted 0',
  firstAdd.added === true && firstAdd.dropped === 0 && conv4.gid === 3
  && conv4.evicted === 0 && conv4.entries.length === 1);
check('entry 形状：ts / from / fromQq(数字转字符串) / isSelf / text / importance 默认 3',
  entry4.ts === NOW && entry4.from === '小明' && entry4.fromQq === '10001'
  && entry4.isSelf === true && entry4.text === '在吗' && entry4.importance === 3
  && entry4.truncated === undefined);
check('store.version 被补成 1',
  store4.version === 1 && appendEntry({}, { key: 'group:1', entry: { ts: NOW } }).added === true);

check('非法 entry 一律 { added:false, dropped:0 } 且不抛',
  appendEntry(emptyCrossState(), { key: 'group:1', entry: { ts: 0 } }).added === false
  && appendEntry(emptyCrossState(), { key: 'group:1', entry: {} }).added === false
  && appendEntry(emptyCrossState(), { key: 'group:1', entry: null }).added === false
  && appendEntry(emptyCrossState(), { key: 'group:1', entry: 'x' }).added === false
  && appendEntry(emptyCrossState(), { key: 'group:1', entry: { ts: -5 } }).added === false
  && appendEntry(emptyCrossState(), { key: 'group:1', entry: { ts: 'oops' } }).added === false);
check('非法 key / 坏 store 不抛（store 缺失时只 repair 不崩）',
  appendEntry(emptyCrossState(), { key: 'cross:1', entry: { ts: NOW } }).added === false
  && appendEntry(emptyCrossState(), { key: null, entry: { ts: NOW } }).added === false
  && appendEntry(null, { key: 'group:1', entry: { ts: NOW } }).added === false
  && appendEntry('x', { key: 'group:1', entry: { ts: NOW } }).added === false);

check('超长 text 截到 2000 并标 truncated',
  (() => {
    const store = emptyCrossState();
    appendEntry(store, { key: 'group:1', entry: { ts: NOW, text: 'x'.repeat(2500) } });
    const entry = store.conversations['group:1'].entries[0];
    return entry.text.length === 2000 && entry.truncated === true;
  })());
check('上游已打的 truncated 标记不会丢（短文本也保留）',
  (() => {
    const store = emptyCrossState();
    appendEntry(store, { key: 'group:1', entry: { ts: NOW, text: '短', truncated: true } });
    return store.conversations['group:1'].entries[0].truncated === true;
  })());
check('importance 钳到 0–10、坏值回落 3',
  (() => {
    const store = emptyCrossState();
    const push = (importance) => {
      appendEntry(store, { key: 'group:1', entry: { ts: NOW, text: 't', importance } });
      return store.conversations['group:1'].entries.at(-1).importance;
    };
    return push(99) === 10 && push(-1) === 0 && push('5') === 5 && push('x') === 3 && push(null) === 3;
  })());
check('from 去控制字符（换行压空格）且裁到 40 字；非字符串给空串',
  (() => {
    const store = emptyCrossState();
    appendEntry(store, { key: 'group:1', entry: { ts: NOW, from: `a\nb${'x'.repeat(60)}` } });
    appendEntry(store, { key: 'group:1', entry: { ts: NOW + 1, from: 42 } });
    const list = store.conversations['group:1'].entries;
    return list[0].from.length === 40 && !list[0].from.includes('\n') && list[0].from.startsWith('a b')
      && list[1].from === '';
  })());
check('fromQq 非法值 → null；isSelf 只有字面 true 才算',
  (() => {
    const store = emptyCrossState();
    appendEntry(store, { key: 'group:1', entry: { ts: NOW, fromQq: {}, isSelf: 1 } });
    appendEntry(store, { key: 'group:1', entry: { ts: NOW + 1, fromQq: '' } });
    const list = store.conversations['group:1'].entries;
    return list[0].fromQq === null && list[0].isSelf === false && list[1].fromQq === null;
  })());

// 滚动：limit 10 被钳到 50
const rollStore = emptyCrossState();
for (let i = 0; i < 50; i += 1) {
  appendEntry(rollStore, { key: 'group:5005', gid: 8, entry: { ts: NOW + i * 1000, text: `第${i}条` }, limit: 10 });
}
const rollConv = rollStore.conversations['group:5005'];
check('limit 10 钳到 50：前 50 条一条不丢',
  rollConv.entries.length === 50 && rollConv.evicted === 0);
let lastDrop = null;
for (let i = 50; i < 60; i += 1) {
  lastDrop = appendEntry(rollStore, { key: 'group:5005', gid: 8, entry: { ts: NOW + i * 1000, text: `第${i}条` }, limit: 10 });
}
check('超限从头部丢弃：60 条留 50、evicted 累计 10、首条变第 11 条',
  rollConv.entries.length === 50 && rollConv.evicted === 10
  && rollConv.entries[0].text === '第10条' && rollConv.entries.at(-1).text === '第59条');
check('每次 dropped 是本次挤掉的条数（第 60 条时是 1）', lastDrop.dropped === 1 && lastDrop.added === true);
check('limit 缺省 500：60 条全留、不丢', (() => {
  const store = emptyCrossState();
  for (let i = 0; i < 60; i += 1) appendEntry(store, { key: 'group:1', entry: { ts: NOW + i, text: 't' } });
  return store.conversations['group:1'].entries.length === 60
    && store.conversations['group:1'].evicted === 0;
})());
check('gid 同步：4 → 0（显式退出共享）→ 缺省时保持 0', (() => {
  const store = emptyCrossState();
  appendEntry(store, { key: 'group:1', gid: 4, entry: { ts: NOW, text: 'a' } });
  const after4 = store.conversations['group:1'].gid;
  appendEntry(store, { key: 'group:1', gid: 0, entry: { ts: NOW + 1, text: 'b' } });
  const after0 = store.conversations['group:1'].gid;
  appendEntry(store, { key: 'group:1', entry: { ts: NOW + 2, text: 'c' } });
  return after4 === 4 && after0 === 0 && store.conversations['group:1'].gid === 0;
})());
check('坏的已有会话记录被修补（entries 不是数组 / evicted 乱写）', (() => {
  const store = { version: 1, conversations: { 'group:1': { gid: 'x', entries: 'nope', evicted: -9 } } };
  appendEntry(store, { key: 'group:1', gid: 2, entry: { ts: NOW, text: 't' } });
  const conv = store.conversations['group:1'];
  return conv.gid === 2 && Array.isArray(conv.entries) && conv.entries.length === 1 && conv.evicted === 0;
})());

// ── 组5：recallEntries 过滤 ────────────────────────────────────────────────
console.log('\n── 组5：recallEntries 可见范围与过滤 ──');

const groups5 = {
  'private:1001': 1,
  'group:2002': 1,
  'group:3003': 2,
  'private:4004': 0
};

/** 造一份固定缓冲：gid 1 有 3 条、gid 2 有 1 条、gid 0 有 1 条。 */
function fixture() {
  const store = emptyCrossState();
  const push = (key, gid, entry) => appendEntry(store, { key, gid, entry, limit: 500 });
  push('private:1001', 1, {
    ts: NOW - 60 * MINUTE, from: '阿芙乐尔', fromQq: '2432829808',
    text: '明天上午开会讨论方案', importance: 6
  });
  push('group:2002', 1, {
    ts: NOW - 120 * MINUTE, from: '小明', fromQq: '10001',
    text: '我昨天买了显卡，真香', importance: 3
  });
  push('group:2002', 1, {
    ts: NOW - 30 * MINUTE, from: 'Alice', fromQq: '10002',
    text: 'hello world 大家好', importance: 3
  });
  push('group:3003', 2, {
    ts: NOW - 180 * MINUTE, from: '小红', fromQq: '10003',
    text: '明天开会', importance: 3
  });
  push('private:4004', 0, {
    ts: NOW - 180 * MINUTE, from: '路人', fromQq: '10004',
    text: '不共享的私聊', importance: 3
  });
  return store;
}

const store5 = fixture();

check('gid=1 只看同组：3 条（不含 gid 2 与 gid 0 的会话）',
  recallEntries({ store: store5, groups: groups5, gid: 1, now: NOW }).total === 3);
check('gid=0 → 空结果（不共享就是查不到）',
  recallEntries({ store: store5, groups: groups5, gid: 0, now: NOW }).total === 0
  && recallEntries({ store: store5, groups: groups5, gid: 0, now: NOW }).rows.length === 0);
check('gid 缺失 / 非法 / 负数 → 空结果，不抛',
  recallEntries({ store: store5, groups: groups5, now: NOW }).total === 0
  && recallEntries({ store: store5, groups: groups5, gid: 'x', now: NOW }).total === 0
  && recallEntries({ store: store5, groups: groups5, gid: -3, now: NOW }).total === 0
  && recallEntries().total === 0 && recallEntries(null).total === 0);
check('gid 字符串归一：gid=\'2\' 等价于 2',
  recallEntries({ store: store5, groups: groups5, gid: '2', now: NOW }).total === 1);

check('excludeKey 排除当前会话：gid 1 去掉 private:1001 后只剩 group:2002 的 2 条',
  (() => {
    const out = recallEntries({ store: store5, groups: groups5, gid: 1, excludeKey: 'private:1001', now: NOW });
    return out.total === 2 && out.rows.every((row) => row.key === 'group:2002');
  })());
check('可见性只看 groups（缓冲里的 gid 只是记录，groups 改了立刻生效）',
  recallEntries({
    store: store5,
    groups: { 'group:2002': 9 },
    gid: 9,
    now: NOW
  }).total === 2);

check('时间窗：sinceMs 90 分钟 → 只剩 -60m 与 -30m 两条',
  recallEntries({ store: store5, groups: groups5, gid: 1, sinceMs: 90 * MINUTE, now: NOW }).total === 2);
check('时间窗边界包含（ts === now - sinceMs 仍在）：sinceMs 60 分钟 → 2 条',
  recallEntries({ store: store5, groups: groups5, gid: 1, sinceMs: 60 * MINUTE, now: NOW }).total === 2);
check('sinceMs 非法/负数回落 24 小时默认值，sinceMs 0 只留此刻之后的',
  recallEntries({ store: store5, groups: groups5, gid: 1, sinceMs: -1, now: NOW }).total === 3
  && recallEntries({ store: store5, groups: groups5, gid: 1, sinceMs: 'x', now: NOW }).total === 3
  && recallEntries({ store: store5, groups: groups5, gid: 1, sinceMs: 0, now: NOW }).total === 0);
check('回溯超出 24h 的旧消息默认查不到',
  recallEntries({ store: store5, groups: groups5, gid: 1, now: NOW + 48 * HOUR }).total === 0);

check('person 按 QQ 精确匹配：10001 → 只有小明那条',
  (() => {
    const out = recallEntries({ store: store5, groups: groups5, gid: 1, person: '10001', now: NOW });
    return out.total === 1 && out.rows[0].from === '小明' && out.rows[0].fromQq === '10001';
  })());
check('person 按名字包含且大小写不敏感：\'alice\' → Alice',
  (() => {
    const out = recallEntries({ store: store5, groups: groups5, gid: 1, person: 'alice', now: NOW });
    return out.total === 1 && out.rows[0].from === 'Alice';
  })());
check('person 中文名字：\'小明\' → 1 条；查无此人 → 0 条',
  recallEntries({ store: store5, groups: groups5, gid: 1, person: '小明', now: NOW }).total === 1
  && recallEntries({ store: store5, groups: groups5, gid: 1, person: '查无此人', now: NOW }).total === 0);
check('person 空串等于不按人过滤',
  recallEntries({ store: store5, groups: groups5, gid: 1, person: '   ', now: NOW }).total === 3);

check('query 原串命中（大小写不敏感）给满分 kw=1：\'显卡\' → 1 条',
  (() => {
    const out = recallEntries({ store: store5, groups: groups5, gid: 1, query: '显卡', now: NOW });
    // 0.5 + 0.3*0.995^2 + 0.2*(3/10)
    return out.total === 1 && near(out.rows[0].score, 0.5 + 0.3 * 0.995 ** 2 + 0.06);
  })());
check('query ASCII 大小写不敏感：\'HELLO\' 命中 \'hello world\'',
  recallEntries({ store: store5, groups: groups5, gid: 1, query: 'HELLO', now: NOW }).total === 1);
check('中文 bigram 宽松命中：\'明天讨论方案\' vs \'明天上午开会讨论方案\'（覆盖率 0.8，kw=0.6）',
  (() => {
    const out = recallEntries({ store: store5, groups: groups5, gid: 1, query: '明天讨论方案', now: NOW });
    // 原串并不连续，命中分必须是 0.6：0.3 + 0.3*0.995 + 0.2*(6/10)
    return out.total === 1 && near(out.rows[0].score, 0.3 + 0.3 * 0.995 + 0.12);
  })());
check('bigram 覆盖率不足 0.6 就不算命中：\'明天量子\'（1/3）→ 0 条',
  recallEntries({ store: store5, groups: groups5, gid: 1, query: '明天量子', now: NOW }).total === 0);
check('query 完全不命中 → 0 条（不把无关条目混进结果）',
  recallEntries({ store: store5, groups: groups5, gid: 1, query: '量子计算', now: NOW }).total === 0);
check('单字中文 query 只走原串匹配：\'鲲\' → 0 条',
  recallEntries({ store: store5, groups: groups5, gid: 1, query: '鲲', now: NOW }).total === 0);
check('query 空串 / 非字符串等于不过滤',
  recallEntries({ store: store5, groups: groups5, gid: 1, query: '', now: NOW }).total === 3
  && recallEntries({ store: store5, groups: groups5, gid: 1, query: 42, now: NOW }).total === 3);
check('person 与 query 叠加：阿芙乐尔 + 开会 → 1 条',
  recallEntries({ store: store5, groups: groups5, gid: 1, person: '阿芙乐尔', query: '开会', now: NOW }).total === 1);
check('行的字段齐全（key/ts/from/fromQq/isSelf/text/score/importance）',
  stable(Object.keys(recallEntries({ store: store5, groups: groups5, gid: 1, now: NOW }).rows[0]))
  === stable(['key', 'ts', 'from', 'fromQq', 'isSelf', 'text', 'score', 'importance']));

check('limit 截断：8 条命中、limit 3 → rows 3 但 total 仍是 8', (() => {
  const store = emptyCrossState();
  for (let i = 0; i < 8; i += 1) {
    appendEntry(store, { key: 'group:8008', gid: 6, entry: { ts: NOW - i * MINUTE, text: `关键 ${i}` } });
  }
  const out = recallEntries({ store, groups: { 'group:8008': 6 }, gid: 6, query: '关键', limit: 3, now: NOW });
  return out.rows.length === 3 && out.total === 8;
})());
check('limit 钳制：0→1、\'5\'→5、999→最多 200', (() => {
  const store = emptyCrossState();
  for (let i = 0; i < 210; i += 1) {
    appendEntry(store, { key: 'group:8009', gid: 6, entry: { ts: NOW - i * MINUTE, text: `批量 ${i}` }, limit: 2000 });
  }
  const base = { store, groups: { 'group:8009': 6 }, gid: 6, query: '批量', now: NOW };
  return recallEntries({ ...base, limit: 0 }).rows.length === 1
    && recallEntries({ ...base, limit: '5' }).rows.length === 5
    && recallEntries({ ...base, limit: 999 }).rows.length === CROSS_MAX_LIMIT
    && recallEntries({ ...base, limit: 999 }).total === 210
    && recallEntries(base).rows.length === 50;
})());

// ── 组6：打分与排序 ────────────────────────────────────────────────────────
console.log('\n── 组6：recallEntries 打分与排序 ──');

const scoreGroups = { 'group:7007': 5 };
function scoreStore() {
  const store = emptyCrossState();
  const push = (entry) => appendEntry(store, { key: 'group:7007', gid: 5, entry, limit: 2000 });
  // 三条同文本、同发送者，只有 importance 不同（同 ts → 排掉时间因素）
  push({ ts: NOW - HOUR, from: '甲', fromQq: '20001', text: '关键信息', importance: 10 });
  push({ ts: NOW - HOUR, from: '乙', fromQq: '20002', text: '关键信息', importance: 0 });
  push({ ts: NOW - HOUR, from: '丙', fromQq: '20003', text: '关键信息', importance: 3 });
  return store;
}
const scoreOut = recallEntries({ store: scoreStore(), groups: scoreGroups, gid: 5, query: '关键', now: NOW });
check('打分公式：0.5*kw + 0.3*0.995^小时差 + 0.2*(importance/10)',
  near(scoreOut.rows[0].score, 0.5 + 0.3 * 0.995 + 0.2)
  && near(scoreOut.rows[1].score, 0.5 + 0.3 * 0.995 + 0.2 * 0.3)
  && near(scoreOut.rows[2].score, 0.5 + 0.3 * 0.995 + 0));
check('按 score 降序：importance 10 > 3 > 0',
  scoreOut.rows[0].from === '甲' && scoreOut.rows[1].from === '丙' && scoreOut.rows[2].from === '乙');
check('同分按 ts 降序（未来时间被钳到「刚刚」，不放大分数）', (() => {
  const store = emptyCrossState();
  appendEntry(store, { key: 'group:1', gid: 1, entry: { ts: NOW + HOUR, from: '早', text: '关键', importance: 10 } });
  appendEntry(store, { key: 'group:1', gid: 1, entry: { ts: NOW + 2 * HOUR, from: '晚', text: '关键', importance: 10 } });
  const out = recallEntries({ store, groups: { 'group:1': 1 }, gid: 1, query: '关键', now: NOW });
  return out.rows.length === 2 && out.rows[0].from === '晚' && out.rows[1].from === '早'
    && near(out.rows[0].score, 1) && near(out.rows[1].score, 1)
    && out.rows[0].score <= 1;
})());
check('importance 越界在打分时也被钳制（15 → 10、-5 → 0）', (() => {
  const store = emptyCrossState();
  appendEntry(store, { key: 'group:1', gid: 1, entry: { ts: NOW, text: '关键', importance: 15 } });
  appendEntry(store, { key: 'group:1', gid: 1, entry: { ts: NOW + 1, text: '关键', importance: -5 } });
  const out = recallEntries({ store, groups: { 'group:1': 1 }, gid: 1, query: '关键', now: NOW });
  return near(out.rows[0].score, 1) && near(out.rows[1].score, 0.8)
    && out.rows[0].importance === 10 && out.rows[1].importance === 0;
})());
check('越久越旧分数越低（同一 importance）', (() => {
  const store = emptyCrossState();
  appendEntry(store, { key: 'group:1', gid: 1, entry: { ts: NOW - 10 * HOUR, from: '旧', text: '关键', importance: 3 } });
  appendEntry(store, { key: 'group:1', gid: 1, entry: { ts: NOW - HOUR, from: '新', text: '关键', importance: 3 } });
  const out = recallEntries({ store, groups: { 'group:1': 1 }, gid: 1, query: '关键', now: NOW });
  return out.rows[0].from === '新' && out.rows[0].score > out.rows[1].score;
})());
check('无 query 时 kw=0（只有时间与重要度两项）',
  (() => {
    const out = recallEntries({ store: scoreStore(), groups: scoreGroups, gid: 5, now: NOW });
    return out.total === 3 && near(out.rows[0].score, 0.3 * 0.995 + 0.2);
  })());

// ── 组7：crossIndex ────────────────────────────────────────────────────────
console.log('\n── 组7：crossIndex 同组概览 ──');

check('gid=1、key=private:1001 → others 只有 group:2002（count 2 / lastAt 最后一条）',
  (() => {
    const out = crossIndex(store5, { key: 'private:1001', groups: groups5, gid: 1, now: NOW });
    return out.gid === 1 && out.others.length === 1
      && out.others[0].key === 'group:2002' && out.others[0].count === 2
      && out.others[0].lastAt === NOW - 30 * MINUTE;
  })());
check('gid=0 / 非法 → { gid:0, others:[] }',
  (() => {
    const zero = crossIndex(store5, { key: 'private:4004', groups: groups5, gid: 0, now: NOW });
    const bad = crossIndex(store5, { key: 'x', groups: groups5, gid: 'x', now: NOW });
    return zero.gid === 0 && zero.others.length === 0 && bad.gid === 0 && bad.others.length === 0;
  })());
check('没有分组的 gid → 空 others（不抛）',
  crossIndex(store5, { key: 'group:1', groups: groups5, gid: 99, now: NOW }).others.length === 0
  && crossIndex(null, { groups: groups5, gid: 1 }).others.length === 2);
check('others 按 lastAt 降序，没有缓冲的会话 count 0 / lastAt 0 沉底', (() => {
  const orderGroups = { 'private:11': 4, 'group:12': 4, 'group:13': 4, 'group:14': 4 };
  const store = emptyCrossState();
  appendEntry(store, { key: 'private:11', gid: 4, entry: { ts: NOW - 3 * HOUR, text: 'a' } });
  appendEntry(store, { key: 'private:11', gid: 4, entry: { ts: NOW - HOUR, text: 'b' } });
  appendEntry(store, { key: 'group:12', gid: 4, entry: { ts: NOW - 2 * HOUR, text: 'c' } });
  appendEntry(store, { key: 'group:14', gid: 4, entry: { ts: NOW - 10 * MINUTE, text: 'd' } });
  const out = crossIndex(store, { key: 'private:11', groups: orderGroups, gid: 4, now: NOW });
  return JSON.stringify(out.others.map((item) => item.key))
    === JSON.stringify(['group:14', 'group:12', 'group:13'])
    && out.others[2].count === 0 && out.others[2].lastAt === 0;
})());
check('key 不在组里时 others 含全部组员（不排除任何人）', (() => {
  const out = crossIndex(store5, { key: 'group:999', groups: groups5, gid: 1, now: NOW });
  return out.others.length === 2;
})());

// ── 组8：序列化 ────────────────────────────────────────────────────────────
console.log('\n── 组8：serializeCrossState / parseCrossState ──');

check('emptyCrossState 形状：version 1 + 空 conversations',
  emptyCrossState().version === 1 && stable(emptyCrossState().conversations) === '{}'
  && !Object.isFrozen(emptyCrossState()));
check('serializeCrossState 按 key 排序（写盘 diff 才稳定）',
  JSON.stringify(Object.keys(JSON.parse(serializeCrossState({
    version: 1,
    conversations: {
      'group:9': { gid: 1, entries: [], evicted: 0 },
      'private:3': { gid: 0, entries: [], evicted: 1 },
      'group:1': { gid: 2, entries: [], evicted: 0 }
    }
  })).conversations)) === JSON.stringify(['group:1', 'group:9', 'private:3']));
check('serialize → parse 往返结构等价（fixture 全量）',
  stable(parseCrossState(serializeCrossState(store5))) === stable(store5));
check('serialize 幂等：parse 后再 serialize 得到同一字符串',
  (() => {
    const text = serializeCrossState(store5);
    return serializeCrossState(parseCrossState(text)) === text;
  })());
check('脏文本容错：坏 JSON / 空串 / null / 非对象 JSON → 空 store',
  (() => {
    const empty = (text) => {
      const store = parseCrossState(text);
      return store.version === 1 && stable(store.conversations) === '{}';
    };
    return empty('{not json') && empty('') && empty('   ') && empty(null) && empty(undefined)
      && empty('null') && empty('[]') && empty('42') && empty('"x"');
  })());
check('conversations 不是对象 → 空 store',
  stable(parseCrossState('{"conversations":[]}').conversations) === '{}'
  && stable(parseCrossState('{"conversations":"x"}').conversations) === '{}');
check('丢弃非法 entries（无 ts / ts≤0 / 非对象），保留合法的', (() => {
  const store = parseCrossState(JSON.stringify({
    version: 1,
    conversations: {
      'group:1': {
        gid: 7,
        entries: [
          { ts: 5, text: 'ok' },
          { ts: 0, text: 'no' },
          { text: 'no ts' },
          'oops',
          null,
          { ts: 9, text: 'two', importance: 99 }
        ],
        evicted: '7'
      }
    }
  }));
  const conv = store.conversations['group:1'];
  return conv.gid === 7 && conv.entries.length === 2 && conv.evicted === 7
    && conv.entries[0].text === 'ok' && conv.entries[1].importance === 10;
})());
check('gid 非法（\'x\' / -3 / 缺省）→ 0，绝不变成一号组',
  (() => {
    const read = (gid) => parseCrossState(JSON.stringify({
      conversations: { 'group:1': { gid, entries: [] } }
    })).conversations['group:1'].gid;
    return read('x') === 0 && read(-3) === 0 && read(undefined) === 0
      && read('7') === 7 && read(0) === 0;
  })());
check('丢弃非法会话 key（cross: / 无前缀），保留 group:/private:',
  (() => {
    const store = parseCrossState(JSON.stringify({
      conversations: { 'cross:1': { gid: 1 }, 'nope': { gid: 1 }, 'group:1': { gid: 1 } }
    }));
    return JSON.stringify(Object.keys(store.conversations)) === JSON.stringify(['group:1']);
  })());
check('会话值不是对象 → 跳过；evicted 负数 → 0',
  (() => {
    const store = parseCrossState(JSON.stringify({
      conversations: { 'group:1': 'x', 'group:2': { gid: 1, entries: [], evicted: -2 } }
    }));
    return !('group:1' in store.conversations) && store.conversations['group:2'].evicted === 0;
  })());
check('解析时保留 truncated 标记、text 超长再截一次', (() => {
  const store = parseCrossState(JSON.stringify({
    conversations: {
      'group:1': { gid: 1, entries: [{ ts: 1, text: 'x'.repeat(2500), truncated: true }] }
    }
  }));
  const entry = store.conversations['group:1'].entries[0];
  return entry.text.length === 2000 && entry.truncated === true;
})());
check('parse && serialize 都不改入参', (() => {
  const snapshot = JSON.stringify(store5);
  parseCrossState(serializeCrossState(store5));
  serializeCrossState(store5);
  return JSON.stringify(store5) === snapshot;
})());

// ── 组9：humanKeyLabel / formatRecallLines ─────────────────────────────────
console.log('\n── 组9：humanKeyLabel / formatRecallLines ──');

check('humanKeyLabel：group → 群、private → 私聊',
  humanKeyLabel('group:119212385') === '群 119212385'
  && humanKeyLabel('private:1691642607') === '私聊 1691642607');
check('humanKeyLabel：非法 key 原样 String()',
  humanKeyLabel('cross:1') === 'cross:1' && humanKeyLabel('group:abc') === 'group:abc'
  && humanKeyLabel(null) === 'null' && humanKeyLabel(undefined) === 'undefined'
  && humanKeyLabel(42) === '42' && humanKeyLabel('') === '');

const recallRows = recallEntries({ store: store5, groups: groups5, gid: 1, now: NOW }).rows;
const lines9 = formatRecallLines(recallRows);
check('formatRecallLines：一 row 一行，形状 \'HH:mm 渠道 人：文本\'',
  lines9.length === 3
  && lines9.every((line) => /^\d{2}:\d{2} (群|私聊) \S+：/.test(line)));
check('渠道由 key 前缀决定：group → 群、private → 私聊', (() => {
  const groupLines = lines9.filter((line) => line.includes(' 群 '));
  const privateLines = lines9.filter((line) => line.includes(' 私聊 '));
  const single = formatRecallLines([{ key: 'private:1', ts: NOW, from: '甲', text: 't' }]);
  return groupLines.length === 2 && privateLines.length === 1
    && single.length === 1 && single[0].includes(' 私聊 ');
})());
check('未知渠道 / 空发送者 / 坏 ts 都有兜底，不产生 NaN:NaN 或 undefined',
  (() => {
    const lines = formatRecallLines([
      { key: 'cross:1', ts: 0, from: '', isSelf: false, text: 't' },
      { key: 'group:1', ts: NOW, from: '', isSelf: true, text: '我发的' }
    ]);
    return lines[0].startsWith('--:-- 未知 未知：') && lines[1].includes(' 我：我发的');
  })());
check('多行正文压成单行（否则「一行一条」会被拆坏）',
  (() => {
    const line = formatRecallLines([{ key: 'group:1', ts: NOW, from: '甲', text: '第一行\n第二行' }])[0];
    return !line.includes('\n') && line.endsWith('：第一行 第二行');
  })());
check('不同时间的行时分不同（相邻 90 分钟）',
  (() => {
    const lines = formatRecallLines([
      { key: 'group:1', ts: NOW, from: '甲', text: 'a' },
      { key: 'group:1', ts: NOW - 90 * MINUTE, from: '甲', text: 'b' }
    ]);
    return lines[0].slice(0, 5) !== lines[1].slice(0, 5);
  })());
check('formatRecallLines：非数组 → []、数组里的非对象被跳过',
  formatRecallLines(null).length === 0 && formatRecallLines('x').length === 0
  && formatRecallLines([null, 'x', { key: 'group:1', ts: NOW, from: '甲', text: 't' }]).length === 1);

// ── 组10：纯函数性 + 常量 ─────────────────────────────────────────────────
console.log('\n── 组10：纯函数性（只读入参）与常量 ──');

check('常量冻结：CROSS_DEFAULTS / CROSS_LIMITS 及区间',
  Object.isFrozen(CROSS_DEFAULTS) && Object.isFrozen(CROSS_LIMITS)
  && Object.isFrozen(CROSS_LIMITS.bufferPerConversation) && Object.isFrozen(CROSS_LIMITS.limit)
  && CROSS_DEFAULTS.enabled === true && CROSS_DEFAULTS.bufferPerConversation === 500
  && CROSS_LIMITS.bufferPerConversation[0] === 50 && CROSS_LIMITS.bufferPerConversation[1] === 2000
  && CROSS_LIMITS.limit[0] === 1 && CROSS_LIMITS.limit[1] === 200
  && CROSS_MAX_LIMIT === 200 && CROSS_DEFAULT_SINCE_MS === 24 * 60 * 60 * 1000);
check('冻结后写入无效（防止运行期被改坏）', (() => {
  try {
    CROSS_DEFAULTS.bufferPerConversation = 1;
  } catch {
    // 严格模式下抛 TypeError 也算「写不进去」
  }
  return CROSS_DEFAULTS.bufferPerConversation === 500;
})());
check('只读函数不改入参：normalizeGid / config / nextFreeGid / assignGroups / groupOf / membersOf',
  (() => {
    const raw = { enabled: true, groups: { 'group:1': 1, 'group:2': 2 } };
    const snapshot = JSON.stringify(raw);
    normalizeGid(3);
    normalizeCrossConfig(raw);
    nextFreeGid(raw.groups);
    assignGroups(['group:3'], raw.groups);
    groupOf(raw.groups, 'group:1');
    membersOf(raw.groups, 1);
    return JSON.stringify(raw) === snapshot;
  })());
check('检索 / 概览 / 序列化 / 展示都不改 store 与 groups', (() => {
  const storeSnapshot = JSON.stringify(store5);
  const groupsSnapshot = JSON.stringify(groups5);
  recallEntries({ store: store5, groups: groups5, gid: 1, query: '开会', now: NOW });
  crossIndex(store5, { key: 'private:1001', groups: groups5, gid: 1, now: NOW });
  serializeCrossState(store5);
  formatRecallLines(recallRows);
  humanKeyLabel('group:1');
  return JSON.stringify(store5) === storeSnapshot && JSON.stringify(groups5) === groupsSnapshot;
})());
check('appendEntry 只动自己那个会话（别的会话一条不少）', (() => {
  const store = fixture();
  const before = store.conversations['group:2002'].entries.length;
  const evictedBefore = store.conversations['group:2002'].evicted;
  appendEntry(store, { key: 'private:1001', gid: 1, entry: { ts: NOW, text: '新' } });
  return store.conversations['group:2002'].entries.length === before
    && store.conversations['group:2002'].evicted === evictedBefore
    && store.conversations['private:1001'].entries.length === 2;
})());
check('同一份输入重复调用结果一致（无隐藏状态）',
  stable(recallEntries({ store: store5, groups: groups5, gid: 1, query: '开会', now: NOW }))
  === stable(recallEntries({ store: store5, groups: groups5, gid: 1, query: '开会', now: NOW })));

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n结果：${passed}/${passed + failed} passed`);
if (failed > 0) console.error(`失败 ${failed} 条`);
process.exitCode = failed > 0 ? 1 : 0;
