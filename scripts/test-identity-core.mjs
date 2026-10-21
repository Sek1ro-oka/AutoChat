// 名字映射表纯函数（src/identity-core.js）的单测。
//
// 跑法：`node scripts/test-identity-core.mjs`（全过 exit 0，有失败 exit 1）。
//
// 零依赖：不碰 state/、不连网络、不读系统时钟 —— 时间全是常量假时钟（at 注入）。
//
// 覆盖（对应 dev-doc §八 的断言重点）：
//   组1  常量：出厂值、区间、冻结
//   组2  normalizeIdentityConfig：默认值、enabled 的严格口径、五组钳制、幂等
//   组3  createIdentityState / normalizeIdentityState：丢非法号码、名字单行化 40 字、
//        members 补对象、键才是号码、幂等
//   组4  parseIdentityState / serializeIdentityState：坏 JSON → null、往返、排序、幂等
//   组5  upsertPrivate：新建 / 改名 / message 不覆盖 friend / friend 覆盖 message /
//        无名不建条目 / lastSeenAt 只增不减 / 纯推进不算变化
//   组6  upsertGroup / upsertMember：建群、改名、memberCount 不被清零、群不存在不建群
//   组7  applyFriendList / applyGroupList / applyMemberList：整表合并、非法项跳过、
//        超上限按 lastSeenAt 淘汰最旧
//   组8  identityKey：两种 kind 的 label、备注优先、非法 key → null
//   组9  lookupIdentity：号码 / 名字 / 备注 / 群名片 / 群名五种命中、前缀、包含、
//        成员 +5、多群去重、排序、limit 钳制、空 query
//   组10 identityPromptBlock：群块（groupName + speakers）、私聊块（peer）、非法 key
//   组11 formatIdentityRows：两种样板逐字一致、成员行、空数组
//   组12 纯函数性（只读入参）与写路径边界
import {
  IDENTITY_DEFAULTS,
  IDENTITY_LIMITS,
  normalizeIdentityConfig,
  createIdentityState,
  normalizeIdentityState,
  parseIdentityState,
  serializeIdentityState,
  upsertPrivate,
  upsertGroup,
  upsertMember,
  applyFriendList,
  applyGroupList,
  applyMemberList,
  identityKey,
  lookupIdentity,
  identityPromptBlock,
  formatIdentityRows
} from '../src/identity-core.js';

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
const DAY = 24 * HOUR;

// ── 组1：常量 ──────────────────────────────────────────────────────────────
console.log('\n── 组1：IDENTITY_DEFAULTS / IDENTITY_LIMITS ──');

check('出厂值：开启 / 6 小时 / 1000 好友 / 200 群 / 2000 成员 / 20 条',
  IDENTITY_DEFAULTS.enabled === true
  && IDENTITY_DEFAULTS.refreshIntervalMs === 6 * HOUR
  && IDENTITY_DEFAULTS.maxFriends === 1000
  && IDENTITY_DEFAULTS.maxGroups === 200
  && IDENTITY_DEFAULTS.maxGroupMembers === 2000
  && IDENTITY_DEFAULTS.queryLimit === 20);
check('常量（含每个区间数组）全部冻结',
  Object.isFrozen(IDENTITY_DEFAULTS) && Object.isFrozen(IDENTITY_LIMITS)
  && Object.isFrozen(IDENTITY_LIMITS.refreshIntervalMs)
  && Object.isFrozen(IDENTITY_LIMITS.maxFriends)
  && Object.isFrozen(IDENTITY_LIMITS.maxGroups)
  && Object.isFrozen(IDENTITY_LIMITS.maxGroupMembers)
  && Object.isFrozen(IDENTITY_LIMITS.queryLimit));
check('区间：30 分钟–7 天 / 10–10000 / 1–500 / 0–20000 / 1–50',
  IDENTITY_LIMITS.refreshIntervalMs[0] === 30 * MINUTE
  && IDENTITY_LIMITS.refreshIntervalMs[1] === 7 * DAY
  && IDENTITY_LIMITS.maxFriends[0] === 10 && IDENTITY_LIMITS.maxFriends[1] === 10000
  && IDENTITY_LIMITS.maxGroups[0] === 1 && IDENTITY_LIMITS.maxGroups[1] === 500
  && IDENTITY_LIMITS.maxGroupMembers[0] === 0 && IDENTITY_LIMITS.maxGroupMembers[1] === 20000
  && IDENTITY_LIMITS.queryLimit[0] === 1 && IDENTITY_LIMITS.queryLimit[1] === 50);
check('冻结后写入无效（防止运行期被改坏）', (() => {
  const before = IDENTITY_DEFAULTS.maxFriends;
  try {
    IDENTITY_DEFAULTS.maxFriends = 1;
  } catch {
    // 严格模式下抛 TypeError 也算「写不进去」
  }
  return IDENTITY_DEFAULTS.maxFriends === before;
})());

// ── 组2：normalizeIdentityConfig ───────────────────────────────────────────
console.log('\n── 组2：normalizeIdentityConfig 默认值与钳制 ──');

const cfgDefault = normalizeIdentityConfig({});
check('空对象 → 全套出厂值',
  stable(cfgDefault) === stable(IDENTITY_DEFAULTS));
check('非对象回落默认（undefined / null / 字符串 / 数组 / 数字）',
  stable(normalizeIdentityConfig()) === stable(IDENTITY_DEFAULTS)
  && stable(normalizeIdentityConfig(null)) === stable(IDENTITY_DEFAULTS)
  && stable(normalizeIdentityConfig('x')) === stable(IDENTITY_DEFAULTS)
  && stable(normalizeIdentityConfig([])) === stable(IDENTITY_DEFAULTS)
  && stable(normalizeIdentityConfig(42)) === stable(IDENTITY_DEFAULTS));

check('enabled：缺省 → 出厂 true、true → true、false → false',
  normalizeIdentityConfig({}).enabled === true
  && normalizeIdentityConfig({ enabled: true }).enabled === true
  && normalizeIdentityConfig({ enabled: false }).enabled === false);
check('enabled 只认显式 true：\'true\' / 1 / \'yes\' / null 一律当关',
  normalizeIdentityConfig({ enabled: 'true' }).enabled === false
  && normalizeIdentityConfig({ enabled: 1 }).enabled === false
  && normalizeIdentityConfig({ enabled: 'yes' }).enabled === false
  && normalizeIdentityConfig({ enabled: null }).enabled === false);

check('refreshIntervalMs：29 分钟→30 分钟、30 分钟原样、7 天原样、8 天→7 天',
  normalizeIdentityConfig({ refreshIntervalMs: 30 * MINUTE - 1 }).refreshIntervalMs === 30 * MINUTE
  && normalizeIdentityConfig({ refreshIntervalMs: 30 * MINUTE }).refreshIntervalMs === 30 * MINUTE
  && normalizeIdentityConfig({ refreshIntervalMs: 7 * DAY }).refreshIntervalMs === 7 * DAY
  && normalizeIdentityConfig({ refreshIntervalMs: 8 * DAY }).refreshIntervalMs === 7 * DAY);
check('refreshIntervalMs 收数字字符串 / 小数取整 / 坏值回落 6 小时',
  normalizeIdentityConfig({ refreshIntervalMs: '7200000' }).refreshIntervalMs === 7200000
  && normalizeIdentityConfig({ refreshIntervalMs: 5400000.9 }).refreshIntervalMs === 5400000
  && normalizeIdentityConfig({ refreshIntervalMs: 'x' }).refreshIntervalMs === 6 * HOUR
  && normalizeIdentityConfig({ refreshIntervalMs: Number.POSITIVE_INFINITY }).refreshIntervalMs === 6 * HOUR);

check('maxFriends：9→10、10 原样、10000 原样、20000→10000',
  normalizeIdentityConfig({ maxFriends: 9 }).maxFriends === 10
  && normalizeIdentityConfig({ maxFriends: 10 }).maxFriends === 10
  && normalizeIdentityConfig({ maxFriends: 10000 }).maxFriends === 10000
  && normalizeIdentityConfig({ maxFriends: 20000 }).maxFriends === 10000);
check('maxGroups：0→1、1 原样、500 原样、999→500',
  normalizeIdentityConfig({ maxGroups: 0 }).maxGroups === 1
  && normalizeIdentityConfig({ maxGroups: 1 }).maxGroups === 1
  && normalizeIdentityConfig({ maxGroups: 500 }).maxGroups === 500
  && normalizeIdentityConfig({ maxGroups: 999 }).maxGroups === 500);
check('maxGroupMembers：-5→0、0 原样、20000 原样、30000→20000',
  normalizeIdentityConfig({ maxGroupMembers: -5 }).maxGroupMembers === 0
  && normalizeIdentityConfig({ maxGroupMembers: 0 }).maxGroupMembers === 0
  && normalizeIdentityConfig({ maxGroupMembers: 20000 }).maxGroupMembers === 20000
  && normalizeIdentityConfig({ maxGroupMembers: 30000 }).maxGroupMembers === 20000);
check('queryLimit：0→1、1 原样、50 原样、99→50、\'5\'→5',
  normalizeIdentityConfig({ queryLimit: 0 }).queryLimit === 1
  && normalizeIdentityConfig({ queryLimit: 1 }).queryLimit === 1
  && normalizeIdentityConfig({ queryLimit: 50 }).queryLimit === 50
  && normalizeIdentityConfig({ queryLimit: 99 }).queryLimit === 50
  && normalizeIdentityConfig({ queryLimit: '5' }).queryLimit === 5);
check('归一化幂等 + 不改入参', (() => {
  const raw = { enabled: false, maxFriends: 9, queryLimit: 99 };
  const snapshot = JSON.stringify(raw);
  const once = normalizeIdentityConfig(raw);
  const twice = normalizeIdentityConfig(once);
  return stable(once) === stable(twice) && JSON.stringify(raw) === snapshot;
})());

// ── 组3：状态建 / 归一 ─────────────────────────────────────────────────────
console.log('\n── 组3：createIdentityState / normalizeIdentityState ──');

check('createIdentityState 形状：version 1 + updatedAt 0 + 两张空表',
  (() => {
    const state = createIdentityState();
    return state.version === 1 && state.updatedAt === 0
      && stable(state.privates) === '{}' && stable(state.groups) === '{}'
      && !Object.isFrozen(state);
  })());
check('createIdentityState 每次返回新对象（两份互不污染）',
  (() => {
    const left = createIdentityState();
    const right = createIdentityState();
    left.privates.x = 1;
    return stable(right.privates) === '{}';
  })());

const rawState = {
  version: 99,
  updatedAt: '1729',
  privates: {
    '1691642607': { qq: '999', name: '  Derp\n', remark: '主人', source: 'friend', lastSeenAt: NOW },
    abc: { name: '字母号码' },
    '123456789012345678901': { name: '21 位号码' },
    '42': '不是对象',
    '7': { name: 'x'.repeat(50) }
  },
  groups: {
    '119212385': {
      gid: 'x',
      name: '联调群',
      memberCount: '42',
      lastSeenAt: NOW - HOUR,
      members: {
        '2432829808': { qq: '999', card: ' 阿芙乐尔 ', name: 'Aurora', lastSeenAt: NOW },
        bad: { card: '非法成员键' },
        '9': '不是对象'
      }
    },
    nope: { name: '非法群号' },
    '555': { members: '不是对象' }
  }
};
const normState = normalizeIdentityState(rawState);

check('version 固定 1、updatedAt 收数字字符串',
  normState.version === 1 && normState.updatedAt === 1729);
check('丢弃非法号码键（字母 / 21 位 / 值不是对象）',
  !('abc' in normState.privates) && !('123456789012345678901' in normState.privates)
  && !('42' in normState.privates));
check('键才是号码：privates[\'1691642607\'].qq 被纠正成 1691642607',
  normState.privates['1691642607'].qq === '1691642607');
check('名字单行化（换行压空格、去首尾空白）且最多 40 字',
  normState.privates['1691642607'].name === 'Derp'
  && normState.privates['1691642607'].remark === '主人'
  && normState.privates['7'].name.length === 40);
check('群归一：gid 用键、memberCount 收 \'42\'、members 是对象',
  normState.groups['119212385'].gid === '119212385'
  && normState.groups['119212385'].name === '联调群'
  && normState.groups['119212385'].memberCount === 42
  && normState.groups['119212385'].lastSeenAt === NOW - HOUR);
check('群成员：名片/昵称归一、qq 用键、非法成员键丢弃',
  normState.groups['119212385'].members['2432829808'].qq === '2432829808'
  && normState.groups['119212385'].members['2432829808'].card === '阿芙乐尔'
  && Object.keys(normState.groups['119212385'].members).length === 1);
check('members 不是对象 → 补成 {}；非法群号键丢弃',
  stable(normState.groups['555'].members) === '{}'
  && !('nope' in normState.groups));
check('来源缺失 / 乱写 → message（最弱）',
  normState.privates['7'].source === 'message'
  && normalizeIdentityState({ privates: { '5': { name: 'x', source: 'boss' } } }).privates['5'].source === 'message');
check('updatedAt 负数 / 坏值 / 缺失 → 0',
  normalizeIdentityState({ updatedAt: -5 }).updatedAt === 0
  && normalizeIdentityState({ updatedAt: 'x' }).updatedAt === 0
  && normalizeIdentityState({}).updatedAt === 0);
check('非对象入参 → 空状态（不抛）',
  stable(normalizeIdentityState(null)) === stable(createIdentityState())
  && stable(normalizeIdentityState('x')) === stable(createIdentityState())
  && stable(normalizeIdentityState([])) === stable(createIdentityState())
  && stable(normalizeIdentityState(42)) === stable(createIdentityState()));
check('名字按 code point 截 40（emoji 不会被切出孤立代理对）', (() => {
  const cut = normalizeIdentityState({ privates: { '5': { name: '😀'.repeat(45) } } }).privates['5'].name;
  return Array.from(cut).length === 40 && !/[\ud800-\udbff]$/.test(cut);
})());
check('归一化幂等：二次归一结果一致',
  stable(normalizeIdentityState(normState)) === stable(normState));
check('归一化不改入参', (() => {
  const snapshot = JSON.stringify(rawState);
  normalizeIdentityState(rawState);
  return JSON.stringify(rawState) === snapshot;
})());

// ── fixture：给组4 与组8~12 用的一份「正常」状态 ──────────────────────────
/** 2 个好友、1 个消息来源陌生人、2 个群、3 条群成员（2432829808 在两个群都出现）。 */
function fixtureState() {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '1691642607', name: 'Derp', remark: '主人', at: NOW - 3 * HOUR, source: 'friend' });
  upsertPrivate(state, { qq: '2432829808', name: 'Aurora', remark: '阿芙乐尔', at: NOW - 2 * HOUR, source: 'friend' });
  upsertPrivate(state, { qq: '10001', name: '小明', remark: '', at: NOW - HOUR, source: 'message' });
  upsertGroup(state, { gid: '119212385', name: '联调群', memberCount: 42, at: NOW - HOUR });
  upsertGroup(state, { gid: '999888777', name: '联调群二号', memberCount: 7, at: NOW - 5 * HOUR });
  upsertMember(state, '119212385', { qq: '2432829808', card: '阿芙乐尔', name: 'Aurora', at: NOW - 10 * MINUTE });
  upsertMember(state, '119212385', { qq: '10001', card: '', name: '小明', at: NOW - 20 * MINUTE });
  upsertMember(state, '999888777', { qq: '2432829808', card: '阿芙乐尔', name: 'Aurora', at: NOW - 2 * HOUR });
  return state;
}

// ── 组4：解析 / 序列化 ─────────────────────────────────────────────────────
console.log('\n── 组4：parseIdentityState / serializeIdentityState ──');

check('parse：坏 JSON / 空串 / 非状态对象 → null',
  parseIdentityState('{not json') === null
  && parseIdentityState('') === null
  && parseIdentityState('   ') === null
  && parseIdentityState(null) === null
  && parseIdentityState(undefined) === null
  && parseIdentityState('null') === null
  && parseIdentityState('[]') === null
  && parseIdentityState('42') === null
  && parseIdentityState('"x"') === null);
check('parse(\'{}\') → 空状态（version 1 / updatedAt 0 / 两张空表）',
  stable(parseIdentityState('{}')) === stable(createIdentityState()));
check('serialize → parse 往返结构等价（fixture 全量）',
  stable(parseIdentityState(serializeIdentityState(fixtureState()))) === stable(fixtureState()));
check('serialize 幂等：parse 后再 serialize 得到同一字符串', (() => {
  const text = serializeIdentityState(fixtureState());
  return serializeIdentityState(parseIdentityState(text)) === text;
})());
check('serialize 键按号码排序（写盘 diff 才稳定）', (() => {
  const text = serializeIdentityState({
    version: 1,
    updatedAt: 0,
    privates: { '300': { name: 'c' }, '100': { name: 'a' }, '200': { name: 'b' } },
    groups: {
      '20': { name: '乙', members: { '300': { name: 'c' }, '100': { name: 'a' } } },
      '10': { name: '甲' }
    }
  });
  const parsed = JSON.parse(text);
  return JSON.stringify(Object.keys(parsed.privates)) === JSON.stringify(['100', '200', '300'])
    && JSON.stringify(Object.keys(parsed.groups)) === JSON.stringify(['10', '20'])
    && JSON.stringify(Object.keys(parsed.groups['20'].members)) === JSON.stringify(['100', '300']);
})());
check('serialize 输出是合法 JSON 且字段齐全（脏时间归 0，不出现 null 时间）', (() => {
  const text = serializeIdentityState({
    updatedAt: Number.NaN,
    privates: { '5': { name: 'x', lastSeenAt: Number.NaN } },
    groups: { '6': { name: 'g', memberCount: Number.POSITIVE_INFINITY } }
  });
  const parsed = JSON.parse(text);
  return parsed.version === 1 && parsed.updatedAt === 0
    && parsed.privates['5'].lastSeenAt === 0
    && parsed.privates['5'].source === 'message'
    && parsed.groups['6'].memberCount === 0;
})());
check('serialize 不改入参', (() => {
  const state = fixtureState();
  const snapshot = JSON.stringify(state);
  serializeIdentityState(state);
  return JSON.stringify(state) === snapshot;
})());

// ── 组5：upsertPrivate ─────────────────────────────────────────────────────
console.log('\n── 组5：upsertPrivate 写入与覆盖规则 ──');

check('首次写入返回 true、字段齐全、号码是字符串', (() => {
  const state = createIdentityState();
  const changed = upsertPrivate(state, {
    qq: '2432829808', name: 'Aurora', remark: '阿芙乐尔', at: NOW, source: 'friend'
  });
  const entry = state.privates['2432829808'];
  return changed === true && entry.qq === '2432829808' && entry.name === 'Aurora'
    && entry.remark === '阿芙乐尔' && entry.source === 'friend' && entry.lastSeenAt === NOW;
})());
check('号码是 number 也收（归一成字符串键）', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: 1691642607, name: 'Derp', at: NOW, source: 'friend' });
  return '1691642607' in state.privates && state.privates['1691642607'].qq === '1691642607';
})());
check('同样的数据再写一次 → false（没有变化）', (() => {
  const state = createIdentityState();
  const payload = { qq: '2432829808', name: 'Aurora', remark: '阿芙乐尔', at: NOW, source: 'friend' };
  return upsertPrivate(state, payload) === true
    && upsertPrivate(state, payload) === false;
})());
check('改名 → true 且写进去', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: '旧名', at: NOW, source: 'friend' });
  const changed = upsertPrivate(state, { qq: '5', name: '新名', at: NOW + 1, source: 'friend' });
  return changed === true && state.privates['5'].name === '新名';
})());
check('只推进 lastSeenAt → false（名字没变就不触发落盘）', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: '阿甲', at: NOW, source: 'friend' });
  const changed = upsertPrivate(state, { qq: '5', name: '阿甲', at: NOW + HOUR, source: 'friend' });
  return changed === false && state.privates['5'].lastSeenAt === NOW + HOUR;
})());
check('lastSeenAt 只增不减：更旧的 at 不会让它倒退', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: '阿甲', at: NOW, source: 'friend' });
  upsertPrivate(state, { qq: '5', name: '阿甲', at: NOW - 10 * HOUR, source: 'friend' });
  return state.privates['5'].lastSeenAt === NOW;
})());
check('message 不覆盖 friend 的名字和备注（但会推进活跃时间）', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: 'Aurora', remark: '阿芙乐尔', at: NOW, source: 'friend' });
  const changed = upsertPrivate(state, {
    qq: '5', name: '群里的小A', remark: '群备注', at: NOW + HOUR, source: 'message'
  });
  const entry = state.privates['5'];
  return changed === false && entry.name === 'Aurora' && entry.remark === '阿芙乐尔'
    && entry.source === 'friend' && entry.lastSeenAt === NOW + HOUR;
})());
check('message 可以补 friend 的空字段（空备注被补上 → true）', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: 'Aurora', remark: '', at: NOW, source: 'friend' });
  const changed = upsertPrivate(state, { qq: '5', remark: '群名片', at: NOW + 1, source: 'message' });
  return changed === true && state.privates['5'].remark === '群名片'
    && state.privates['5'].name === 'Aurora' && state.privates['5'].source === 'friend';
})());
check('friend 覆盖 message（来源升级、名字采纳）', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: '小号', remark: '', at: NOW, source: 'message' });
  const changed = upsertPrivate(state, { qq: '5', name: 'Aurora', remark: '主人', at: NOW + 1, source: 'friend' });
  const entry = state.privates['5'];
  return changed === true && entry.name === 'Aurora' && entry.remark === '主人' && entry.source === 'friend';
})());
check('空名字 / 空备注不会清空已有字段', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: 'Aurora', remark: '阿芙乐尔', at: NOW, source: 'friend' });
  const changed = upsertPrivate(state, { qq: '5', name: '', remark: '   ', at: NOW + 1, source: 'friend' });
  return changed === false && state.privates['5'].name === 'Aurora' && state.privates['5'].remark === '阿芙乐尔';
})());
check('一个名字都没有的新号码不建条目（不占 maxFriends 配额）', (() => {
  const state = createIdentityState();
  const changed = upsertPrivate(state, { qq: '777', name: '  ', remark: '', at: NOW });
  return changed === false && !('777' in state.privates) && Object.keys(state.privates).length === 0;
})());
check('非法号码 / 坏 state → false 且不改 state',
  (() => {
    const state = createIdentityState();
    const snapshot = JSON.stringify(state);
    return upsertPrivate(state, { qq: 'abc', name: 'x' }) === false
      && upsertPrivate(state, { qq: 3.7, name: 'x' }) === false
      && upsertPrivate(state, { qq: -1, name: 'x' }) === false
      && upsertPrivate(state, null) === false
      && upsertPrivate(null, { qq: '5', name: 'x' }) === false
      && upsertPrivate('x', { qq: '5', name: 'x' }) === false
      && JSON.stringify(state) === snapshot;
  })());
check('源缺失 → message（最弱来源）', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: 'x', at: NOW });
  return state.privates['5'].source === 'message';
})());
check('中文名字里的换行压成空格、超 40 字截断', (() => {
  const state = createIdentityState();
  upsertPrivate(state, { qq: '5', name: '张\n三', at: NOW, source: 'friend' });
  upsertPrivate(state, { qq: '6', name: 'x'.repeat(50), at: NOW, source: 'friend' });
  return state.privates['5'].name === '张 三' && state.privates['6'].name.length === 40;
})());

// ── 组6：upsertGroup / upsertMember ────────────────────────────────────────
console.log('\n── 组6：upsertGroup / upsertMember ──');

check('建群返回 true，members 初始化为空对象', (() => {
  const state = createIdentityState();
  const changed = upsertGroup(state, { gid: '119212385', name: '联调群', memberCount: 42, at: NOW });
  const group = state.groups['119212385'];
  return changed === true && group.gid === '119212385' && group.name === '联调群'
    && group.memberCount === 42 && group.lastSeenAt === NOW && stable(group.members) === '{}';
})());
check('群同值重写 → false；改名 → true', (() => {
  const state = createIdentityState();
  upsertGroup(state, { gid: '119212385', name: '联调群', memberCount: 42, at: NOW });
  const same = upsertGroup(state, { gid: '119212385', name: '联调群', memberCount: 42, at: NOW + 1 });
  const renamed = upsertGroup(state, { gid: '119212385', name: '新联调群', memberCount: 42, at: NOW + 2 });
  return same === false && renamed === true && state.groups['119212385'].name === '新联调群';
})());
check('memberCount 缺省不清零，给了才覆盖', (() => {
  const state = createIdentityState();
  upsertGroup(state, { gid: '5', name: '群', memberCount: 42, at: NOW });
  upsertGroup(state, { gid: '5', name: '群', at: NOW + 1 });
  const afterMissing = state.groups['5'].memberCount;
  upsertGroup(state, { gid: '5', name: '群', memberCount: 43, at: NOW + 2 });
  return afterMissing === 42 && state.groups['5'].memberCount === 43;
})());
check('群号码非法 / 坏 state → false（不抛）',
  upsertGroup(createIdentityState(), { gid: 'x', name: '群' }) === false
  && upsertGroup(createIdentityState(), { gid: '5' }) === true
  && upsertGroup(null, { gid: '5', name: '群' }) === false);

check('群不存在时 upsertMember → false 且不凭空建群', (() => {
  const state = createIdentityState();
  const changed = upsertMember(state, '404', { qq: '5', card: '甲', at: NOW });
  return changed === false && stable(state.groups) === '{}';
})());
check('成员首次写入 / 同值重写 / 名片变化', (() => {
  const state = createIdentityState();
  upsertGroup(state, { gid: '119212385', name: '联调群', at: NOW });
  const created = upsertMember(state, '119212385', { qq: '2432829808', card: '阿芙乐尔', name: 'Aurora', at: NOW });
  const same = upsertMember(state, '119212385', { qq: '2432829808', card: '阿芙乐尔', name: 'Aurora', at: NOW + 1 });
  const renamed = upsertMember(state, '119212385', { qq: '2432829808', card: '新名片', at: NOW + 2 });
  const member = state.groups['119212385'].members['2432829808'];
  return created === true && same === false && renamed === true
    && member.card === '新名片' && member.name === 'Aurora' && member.lastSeenAt === NOW + 2;
})());
check('成员号码非法 → false；群成员表坏掉也能修补',
  (() => {
    const state = { version: 1, updatedAt: 0, privates: {}, groups: { '5': { gid: '5', name: '群', members: 'x' } } };
    return upsertMember(state, '5', { qq: 'abc', card: '甲' }) === false
      && upsertMember(state, '5', { qq: '7', card: '甲' }) === true
      && isObjectWithKey(state.groups['5'].members, '7');
  })());

/** 小工具：确认 value 是对象且带某个键（避免在断言里写一长串 typeof）。 */
function isObjectWithKey(value, key) {
  return value !== null && typeof value === 'object' && key in value;
}

// ── 组7：apply* 整表合并与淘汰 ─────────────────────────────────────────────
console.log('\n── 组7：applyFriendList / applyGroupList / applyMemberList ──');

check('applyFriendList：合并合法行、跳过非法项、返回合并条数', (() => {
  const state = createIdentityState();
  const merged = applyFriendList(state, [
    { user_id: 1691642607, nickname: 'Derp', remark: '主人' },
    { user_id: '2432829808', nickname: 'Aurora', remark: '' },
    { user_id: 'bad', nickname: '号码不合法' },
    { nickname: '没有号码' },
    null,
    'oops'
  ], NOW);
  return merged === 2 && Object.keys(state.privates).length === 2
    && state.privates['1691642607'].remark === '主人'
    && state.privates['1691642607'].source === 'friend'
    && state.privates['1691642607'].lastSeenAt === NOW;
})());
check('applyFriendList：非数组 / 坏 state → 0',
  applyFriendList(createIdentityState(), null, NOW) === 0
  && applyFriendList(createIdentityState(), 'x', NOW) === 0
  && applyFriendList(null, [{ user_id: '5', nickname: 'x' }], NOW) === 0);
check('applyFriendList：同一份列表再来一次仍返回 2（返回的是合并条数，不是变化条数）', (() => {
  const state = createIdentityState();
  const list = [{ user_id: '5', nickname: '甲' }, { user_id: '6', nickname: '乙' }];
  return applyFriendList(state, list, NOW) === 2 && applyFriendList(state, list, NOW + HOUR) === 2
    && Object.keys(state.privates).length === 2;
})());

check('applyFriendList：超 maxFriends 按 lastSeenAt 淘汰最旧', (() => {
  const state = createIdentityState();
  for (let i = 0; i < 12; i += 1) {
    applyFriendList(state, [{ user_id: String(10000 + i), nickname: `好友${i}` }], NOW + i * MINUTE, { maxFriends: 10 });
  }
  const keys = Object.keys(state.privates);
  return keys.length === 10 && !('10000' in state.privates) && !('10001' in state.privates)
    && '10002' in state.privates && '10011' in state.privates;
})());

check('applyGroupList：合并群与 member_count、跳过非法项', (() => {
  const state = createIdentityState();
  const merged = applyGroupList(state, [
    { group_id: 119212385, group_name: '联调群', member_count: 42 },
    { group_id: '999888777', group_name: '联调群二号', member_count: 7 },
    { group_id: 'x', group_name: '非法群号' },
    null
  ], NOW);
  return merged === 2 && Object.keys(state.groups).length === 2
    && state.groups['119212385'].name === '联调群'
    && state.groups['119212385'].memberCount === 42
    && state.groups['999888777'].memberCount === 7;
})());
check('applyGroupList：超 maxGroups 淘汰最旧，被淘汰群的成员一起消失', (() => {
  const state = createIdentityState();
  for (let i = 0; i < 3; i += 1) {
    applyGroupList(state, [{ group_id: String(900 + i), group_name: `群${i}`, member_count: 5 }], NOW + i * MINUTE, { maxGroups: 2 });
  }
  const kept = Object.keys(state.groups);
  return kept.length === 2 && !('900' in state.groups) && '901' in state.groups && '902' in state.groups;
})());
check('被淘汰的群连同成员一起没了（成员挂在群下面）', (() => {
  const state = createIdentityState();
  applyGroupList(state, [{ group_id: '900', group_name: '旧群', member_count: 1 }], NOW);
  upsertMember(state, '900', { qq: '5', card: '甲', at: NOW });
  applyGroupList(state, [{ group_id: '901', group_name: '新群', member_count: 1 }], NOW + MINUTE, { maxGroups: 1 });
  return !('900' in state.groups) && Object.keys(state.groups).length === 1;
})());

check('applyMemberList：群不存在 → 0（不建群）', (() => {
  const state = createIdentityState();
  const merged = applyMemberList(state, '404', [{ user_id: '5', nickname: 'x' }], NOW);
  return merged === 0 && stable(state.groups) === '{}';
})());
check('applyMemberList：只更新该群 members、返回合并条数、非法项跳过', (() => {
  const state = createIdentityState();
  upsertGroup(state, { gid: '5', name: '甲群', at: NOW });
  upsertGroup(state, { gid: '6', name: '乙群', at: NOW });
  upsertMember(state, '6', { qq: '99', card: '乙群的人', at: NOW - HOUR });
  const merged = applyMemberList(state, '5', [
    { user_id: 2432829808, nickname: 'Aurora', card: '阿芙乐尔' },
    { user_id: '10001', nickname: '小明', card: '' },
    { user_id: 'bad', nickname: '非法号码' },
    'oops'
  ], NOW);
  return merged === 2
    && Object.keys(state.groups['5'].members).length === 2
    && state.groups['5'].members['2432829808'].card === '阿芙乐尔'
    && state.groups['5'].members['10001'].name === '小明'
    && Object.keys(state.groups['6'].members).length === 1;
})());
check('applyMemberList：超 maxGroupMembers 按 lastSeenAt 淘汰最旧', (() => {
  const state = createIdentityState();
  upsertGroup(state, { gid: '777', name: '成员淘汰群', at: NOW });
  for (let i = 0; i < 5; i += 1) {
    applyMemberList(state, '777', [{ user_id: String(500 + i), nickname: `成员${i}` }], NOW + i * MINUTE, { maxGroupMembers: 2 });
  }
  const keys = Object.keys(state.groups['777'].members);
  return keys.length === 2 && '503' in state.groups['777'].members && '504' in state.groups['777'].members;
})());
check('apply* 缺 config 时按出厂上限（小事不裁剪）', (() => {
  const state = createIdentityState();
  return applyFriendList(state, [{ user_id: '5', nickname: '甲' }], NOW) === 1
    && applyGroupList(state, [{ group_id: '6', group_name: '群' }], NOW) === 1
    && applyMemberList(state, '6', [{ user_id: '7', nickname: '乙' }], NOW) === 1
    && Object.keys(state.privates).length === 1
    && Object.keys(state.groups['6'].members).length === 1;
})());

// ── 组8：identityKey ───────────────────────────────────────────────────────
console.log('\n── 组8：identityKey ──');

const fixture8 = fixtureState();
check('私聊：备注优先，label 带 QQ 号',
  (() => {
    const info = identityKey(fixture8, 'private:2432829808');
    return info.kind === 'private' && info.id === '2432829808' && info.key === 'private:2432829808'
      && info.name === '阿芙乐尔' && info.label === '阿芙乐尔（QQ 2432829808）';
  })());
check('私聊查不到 → name 空、label 退回 QQ 号码',
  (() => {
    const info = identityKey(fixture8, 'private:777');
    return info.name === '' && info.label === 'QQ 777';
  })());
check('群：群名 + 群号的 label',
  (() => {
    const info = identityKey(fixture8, 'group:119212385');
    return info.kind === 'group' && info.id === '119212385' && info.name === '联调群'
      && info.label === '联调群（群 119212385）';
  })());
check('群查不到 → label 退回 群 号码',
  identityKey(fixture8, 'group:456').label === '群 456'
  && identityKey(fixture8, 'group:456').name === '');
check('非法 key → null（cross: / 字母 / 缺 id / 非字符串 / 超 20 位）',
  identityKey(fixture8, 'cross:1') === null
  && identityKey(fixture8, 'private:abc') === null
  && identityKey(fixture8, 'private:') === null
  && identityKey(fixture8, 'group') === null
  && identityKey(fixture8, '') === null
  && identityKey(fixture8, null) === null
  && identityKey(fixture8, 42) === null
  && identityKey(fixture8, `group:${'1'.repeat(21)}`) === null);
check('id 是字符串，能直接拿去索引 state', (() => {
  const info = identityKey(fixture8, 'private:1691642607');
  return typeof info.id === 'string' && fixture8.privates[info.id].name === 'Derp';
})());
check('脏 state（null）也能返回兜底 label',
  identityKey(null, 'private:123').label === 'QQ 123'
  && identityKey(null, 'group:123').label === '群 123');

// ── 组9：lookupIdentity ────────────────────────────────────────────────────
console.log('\n── 组9：lookupIdentity 打分 / 去重 / 排序 ──');

const fixture9 = fixtureState();
check('号码精确命中私聊：100 分、key 可直接用',
  (() => {
    const out = lookupIdentity(fixture9, '1691642607');
    return out.ok === true && out.rows.length === 1
      && out.rows[0].kind === 'private' && out.rows[0].key === 'private:1691642607'
      && out.rows[0].qq === '1691642607' && out.rows[0].score === 100;
  })());
check('群名完全相等 100 分（群号精确也是 100）',
  (() => {
    const byName = lookupIdentity(fixture9, '联调群');
    const byNumber = lookupIdentity(fixture9, '119212385');
    return byName.rows[0].kind === 'group' && byName.rows[0].score === 100
      && byName.rows[0].label === '联调群（群 119212385）'
      && byNumber.rows[0].key === 'group:119212385' && byNumber.rows[0].score === 100
      && byNumber.rows[0].gid === '119212385' && byNumber.rows[0].qq === null;
  })());
check('备注命中：\'主人\' → 私聊 1691642607，name 取备注',
  (() => {
    const out = lookupIdentity(fixture9, '主人');
    return out.rows.length === 1 && out.rows[0].key === 'private:1691642607'
      && out.rows[0].name === '主人' && out.rows[0].label === '主人（QQ 1691642607）';
  })());
check('群名片命中 +5：\'阿芙乐尔\' → 成员 105 分排在私聊 100 分之前',
  (() => {
    const out = lookupIdentity(fixture9, '阿芙乐尔');
    return out.rows.length === 2
      && out.rows[0].kind === 'member' && out.rows[0].score === 105
      && out.rows[0].key === 'group:119212385' && out.rows[0].groupName === '联调群'
      && out.rows[0].label === '阿芙乐尔（QQ 2432829808）'
      && out.rows[1].kind === 'private' && out.rows[1].score === 100;
  })());
check('前缀 60 分（成员 +5 → 65）',
  (() => {
    const out = lookupIdentity(fixture9, '阿芙');
    return out.rows.length === 2 && out.rows[0].kind === 'member' && out.rows[0].score === 65
      && out.rows[1].kind === 'private' && out.rows[1].score === 60;
  })());
check('包含 40 分：\'调群二\' 只命中 联调群二号',
  (() => {
    const out = lookupIdentity(fixture9, '调群二');
    return out.rows.length === 1 && out.rows[0].key === 'group:999888777' && out.rows[0].score === 40;
  })());
check('前缀命中两个群时按 lastSeenAt 降序：\'联调\' → 119212385 在前',
  (() => {
    const out = lookupIdentity(fixture9, '联调');
    return out.rows.length === 2
      && out.rows[0].key === 'group:119212385' && out.rows[1].key === 'group:999888777'
      && out.rows[0].score === 60 && out.rows[1].score === 60;
  })());
check('同名群成员去重：2432829808 只留 lastSeenAt 最近的群',
  (() => {
    const out = lookupIdentity(fixture9, '2432829808');
    const members = out.rows.filter((row) => row.kind === 'member');
    return members.length === 1 && members[0].key === 'group:119212385';
  })());
check('成员号码精确命中不加分（100，不是 105）',
  (() => {
    const out = lookupIdentity(fixture9, '2432829808');
    const member = out.rows.find((row) => row.kind === 'member');
    return member.score === 100;
  })());
check('排序：score 降序 → lastSeenAt 降序（成员比私聊更近，成员在前）',
  (() => {
    const out = lookupIdentity(fixture9, '10001');
    return out.rows.length === 2
      && out.rows[0].kind === 'member' && out.rows[0].key === 'group:119212385'
      && out.rows[1].kind === 'private' && out.rows[1].key === 'private:10001';
  })());
check('ASCII 名字大小写不敏感：\'derp\' → Derp',
  (() => {
    const out = lookupIdentity(fixture9, 'derp');
    return out.rows.length === 1 && out.rows[0].key === 'private:1691642607' && out.rows[0].score === 100;
  })());
check('行形状严格 8 个字段（不把内部 lastSeenAt 泄给上游）',
  (() => {
    const out = lookupIdentity(fixture9, '小明');
    const expected = ['kind', 'key', 'name', 'label', 'qq', 'gid', 'groupName', 'score'];
    return out.rows.length > 0
      && Object.keys(out.rows[0]).sort().join(',') === expected.slice().sort().join(',');
  })());
check('空 / 空白 query → ok true + rows []（不抛）',
  (() => {
    const empty = (query) => {
      const out = lookupIdentity(fixture9, query);
      return out.ok === true && out.rows.length === 0 && out.query === '';
    };
    return empty('') && empty('   ') && empty(null) && empty(42) && empty({});
  })());
check('查不到 → rows []（不猜号码）',
  lookupIdentity(fixture9, '查无此人').rows.length === 0);
check('limit 默认 20、钳到 1–50', (() => {
  const many = createIdentityState();
  for (let i = 0; i < 60; i += 1) {
    upsertPrivate(many, { qq: String(20000 + i), name: '同名', at: NOW + i });
  }
  return lookupIdentity(many, '同名').rows.length === 20
    && lookupIdentity(many, '同名', { limit: 0 }).rows.length === 1
    && lookupIdentity(many, '同名', { limit: 3 }).rows.length === 3
    && lookupIdentity(many, '同名', { limit: '5' }).rows.length === 5
    && lookupIdentity(many, '同名', { limit: 99 }).rows.length === 50;
})());
check('limit 截断后仍是 score 最高的那批（同分看 lastSeenAt）',
  (() => {
    const many = createIdentityState();
    for (let i = 0; i < 30; i += 1) {
      upsertPrivate(many, { qq: String(30000 + i), name: '同分', at: NOW + i * MINUTE });
    }
    const out = lookupIdentity(many, '同分', { limit: 2 });
    return out.rows.length === 2 && out.rows[0].qq === '30029' && out.rows[1].qq === '30028';
  })());

// ── 组10：identityPromptBlock ──────────────────────────────────────────────
console.log('\n── 组10：identityPromptBlock ──');

const fixture10 = fixtureState();
check('群会话：current 用群 label、带 groupName',
  (() => {
    const block = identityPromptBlock(fixture10, 'group:119212385');
    return block.enabled === true
      && block.current.key === 'group:119212385'
      && block.current.label === '联调群（群 119212385）'
      && block.groupName === '联调群'
      && !('peer' in block)
      && stable(block.speakers) === '[]';
  })());
check('speakers 用群名片、按传入顺序、非法项跳过且不占名额', (() => {
  const block = identityPromptBlock(fixture10, 'group:119212385', {
    speakers: [
      { qq: '2432829808', name: '旧名' },
      { qq: 10001, name: '小明' },
      { qq: 'bad', name: '号码不合法' },
      null,
      { qq: '1691642607', name: '' }
    ]
  });
  return block.speakers.length === 3
    && stable(block.speakers[0]) === stable({ qq: '2432829808', name: '阿芙乐尔', label: '阿芙乐尔（QQ 2432829808）' })
    && stable(block.speakers[1]) === stable({ qq: '10001', name: '小明', label: '小明（QQ 10001）' })
    && stable(block.speakers[2]) === stable({ qq: '1691642607', name: '主人', label: '主人（QQ 1691642607）' });
})());
check('speakerLimit 截断（默认 8 / 显式 1 / 0 合法 / 上限 50）', (() => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ qq: String(40000 + i), name: `S${i}` }));
  const sixty = Array.from({ length: 60 }, (_, i) => ({ qq: String(50000 + i), name: `T${i}` }));
  return identityPromptBlock(fixture10, 'group:119212385', { speakers: nine }).speakers.length === 8
    && identityPromptBlock(fixture10, 'group:119212385', { speakers: nine, speakerLimit: 1 }).speakers.length === 1
    && identityPromptBlock(fixture10, 'group:119212385', { speakers: nine, speakerLimit: 0 }).speakers.length === 0
    && identityPromptBlock(fixture10, 'group:119212385', { speakers: sixty, speakerLimit: 999 }).speakers.length === 50;
})());
check('speakers 不是数组 → 空数组（不抛）', (() => {
  const block = identityPromptBlock(fixture10, 'group:119212385', { speakers: 'x' });
  return block.enabled === true && stable(block.speakers) === '[]'
    && identityPromptBlock(fixture10, 'group:119212385', null).speakers.length === 0;
})());
check('私聊会话：带 peer、不带 groupName', (() => {
  const block = identityPromptBlock(fixture10, 'private:1691642607', {
    speakers: [{ qq: '1691642607', name: '' }]
  });
  return block.enabled === true
    && block.current.label === '主人（QQ 1691642607）'
    && block.peer.qq === '1691642607'
    && block.peer.label === '主人（QQ 1691642607）'
    && !('groupName' in block)
    && block.speakers[0].label === '主人（QQ 1691642607）';
})());
check('私聊查不到：label 退回 QQ 号码', (() => {
  const block = identityPromptBlock(fixture10, 'private:777');
  return block.current.label === 'QQ 777' && block.peer.label === 'QQ 777'
    && block.speakers.length === 0;
})());
check('非法 key → enabled false / current null / speakers []',
  (() => {
    const block = identityPromptBlock(fixture10, 'cross:1');
    return block.enabled === false && block.current === null && stable(block.speakers) === '[]';
  })());

// ── 组11：formatIdentityRows ───────────────────────────────────────────────
console.log('\n── 组11：formatIdentityRows ──');

check('私聊行与 dev-doc 样板逐字一致',
  formatIdentityRows([{
    kind: 'private', key: 'private:2432829808', name: '阿芙乐尔',
    label: '阿芙乐尔（QQ 2432829808）', qq: '2432829808', gid: null, groupName: '', score: 100
  }]) === '私聊 阿芙乐尔（QQ 2432829808）→ private:2432829808');
check('群行与 dev-doc 样板逐字一致',
  formatIdentityRows([{
    kind: 'group', key: 'group:119212385', name: '联调群',
    label: '联调群（群 119212385）', qq: null, gid: '119212385', groupName: '', score: 100
  }]) === '群 联调群（群 119212385）→ group:119212385');
check('成员行带群名（同一个群可能命中好几个人）',
  formatIdentityRows([{
    kind: 'member', key: 'group:119212385', name: '阿芙乐尔',
    label: '阿芙乐尔（QQ 2432829808）', qq: '2432829808', gid: '119212385',
    groupName: '联调群', score: 105
  }]) === '成员 联调群/阿芙乐尔（QQ 2432829808）→ group:119212385');
check('空数组 / 非数组 / 全是非对象 → 空串',
  formatIdentityRows([]) === ''
  && formatIdentityRows(null) === ''
  && formatIdentityRows('x') === ''
  && formatIdentityRows([null, 'x', 42]) === '');
check('label 缺失时按 kind 兜底（不出现「undefined」）', (() => {
  const line = formatIdentityRows([{ kind: 'private', key: 'private:123', qq: '123' }]);
  return line === '私聊 QQ 123→ private:123' && !line.includes('undefined');
})());
check('多行用 \\n 连接、行内不出现换行污染', (() => {
  const rows = lookupIdentity(fixture9, '阿芙乐尔').rows;
  const text = formatIdentityRows(rows);
  const lines = text.split('\n');
  return lines.length === 2 && lines[0].split('→').length === 2
    && lines[0].startsWith('成员 ') && lines[1].startsWith('私聊 ');
})());

// ── 组12：纯函数性 / 写路径边界 ────────────────────────────────────────────
console.log('\n── 组12：纯函数性与写路径边界 ──');

check('lookup / prompt / format / serialize / identityKey 都不改 state', (() => {
  const state = fixtureState();
  const snapshot = JSON.stringify(state);
  lookupIdentity(state, '阿芙乐尔');
  lookupIdentity(state, '联调群', { limit: 5 });
  identityPromptBlock(state, 'group:119212385', { speakers: [{ qq: '2432829808', name: 'x' }] });
  identityKey(state, 'private:1691642607');
  serializeIdentityState(state);
  formatIdentityRows(lookupIdentity(state, '小明').rows);
  return JSON.stringify(state) === snapshot;
})());
check('同一份输入重复调用结果一致（没有隐藏状态）',
  stable(lookupIdentity(fixture9, '联调')) === stable(lookupIdentity(fixture9, '联调'))
  && stable(identityPromptBlock(fixture10, 'group:119212385', { speakers: [{ qq: '10001', name: 'x' }] }))
  === stable(identityPromptBlock(fixture10, 'group:119212385', { speakers: [{ qq: '10001', name: 'x' }] })));
check('lookup 返回的 rows 是新的数组（改它不会影响下一次查询）', (() => {
  const first = lookupIdentity(fixture9, '联调');
  first.rows[0].label = '被改坏了';
  first.rows.push({ kind: 'private', key: 'private:1' });
  const second = lookupIdentity(fixture9, '联调');
  return second.rows.length === 2 && second.rows[0].label === '联调群（群 119212385）';
})());
check('写路径只有 upsert*/apply*（就地改 state，其余函数只读）', (() => {
  const state = createIdentityState();
  const before = JSON.stringify(state);
  const readOnlyCalls = () => {
    identityKey(state, 'group:1');
    lookupIdentity(state, '任何人');
    identityPromptBlock(state, 'private:1');
    serializeIdentityState(state);
    normalizeIdentityState(state);
    parseIdentityState('{"privates":{}}');
    formatIdentityRows([{ kind: 'private', key: 'private:1', qq: '1' }]);
    normalizeIdentityConfig({});
  };
  readOnlyCalls();
  const after = JSON.stringify(state);
  upsertPrivate(state, { qq: '1', name: '甲', at: NOW, source: 'friend' });
  return before === after && JSON.stringify(state) !== after;
})());

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n结果：${passed}/${passed + failed} passed`);
if (failed > 0) console.error(`失败 ${failed} 条`);
process.exitCode = failed > 0 ? 1 : 0;
