// 小黑盒纯函数模块（src/heybox-core.js）的单测。
//
// 跑法：`node scripts/test-heybox-core.mjs`（全过 exit 0，有失败 exit 1）。
//
// 零依赖：不碰 state/、不连网络、不读系统时钟 —— 时间全是常量假时钟（NOW 注入）。
// 日界按北京时间（UTC+8）自然日，所有跨日用例都用固定时间戳，不受本机时区影响。
//
// 覆盖（对应 dev-doc 的断言重点）：
//   组1  HEYBOX_DEFAULTS / HEYBOX_LIMITS 常量 + normalizeHeyboxConfig 默认值与钳制
//   组2  dayKeyOf：北京时间 23:59 与 00:01 的日界
//   组3  heyboxQuota：开关 / 暂停 / 日上限 / 间隔的判定顺序与边界
//   组4  auditComment：空 / 太短 / 太长 / 多行 / 无意义 / 复读 / 敏感内容 / 通过
//   组5  nearDuplicate：exact / near / 不同 / 太短 / 脏数组
//   组6  recordAction / createHeyboxState：同日累加与跨日重置、不改入参
//   组7  parseUsage / serializeUsage：坏数据兜底与稳定字段顺序
//   组8  describeCliError：五种 code 与 stderr 文本兜底
//   组9  commentReasonText：五种配额原因翻成人话
//   组10 纯函数性（只读入参、可重复调用）与导出齐全
import {
  HEYBOX_DEFAULTS,
  HEYBOX_LIMITS,
  normalizeHeyboxConfig,
  dayKeyOf,
  heyboxQuota,
  auditComment,
  nearDuplicate,
  recordAction,
  createHeyboxState,
  parseUsage,
  serializeUsage,
  describeCliError,
  commentReasonText
} from '../src/heybox-core.js';
import * as heyboxCore from '../src/heybox-core.js';

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

/** 小黑盒配置里「默认值」的那份期望。 */
const DEFAULT_CONFIG = {
  enabled: true,
  allowComment: false,
  cliPath: 'xiaoheihe-cli',
  dailyComments: 10,
  minGapMs: 360000,
  maxGapMs: 1200000,
  postMaxChars: 200,
  dryRunDefault: true
};

/** 只把评论开关打开的配置：配额用例的基线。 */
const COMMENT_ON = { allowComment: true };

/** 一个「今天还没评论过」的状态。 */
function freshState(now = NOW) {
  return createHeyboxState(now);
}

// ── 组1：常量与 normalizeHeyboxConfig ──────────────────────────────────────
console.log('\n── 组1：常量与 normalizeHeyboxConfig 默认值 / 钳制 ──');

check('HEYBOX_DEFAULTS 开关默认：enabled 开、allowComment 关',
  HEYBOX_DEFAULTS.enabled === true && HEYBOX_DEFAULTS.allowComment === false);
check('HEYBOX_DEFAULTS.cliPath 默认 xiaoheihe-cli',
  HEYBOX_DEFAULTS.cliPath === 'xiaoheihe-cli');
check('HEYBOX_DEFAULTS 数值：日上限 10、间隔 6 分钟到 20 分钟',
  HEYBOX_DEFAULTS.dailyComments === 10
  && HEYBOX_DEFAULTS.minGapMs === 360000
  && HEYBOX_DEFAULTS.maxGapMs === 1200000);
check('HEYBOX_DEFAULTS 其余：postMaxChars 200、dryRunDefault true',
  HEYBOX_DEFAULTS.postMaxChars === 200 && HEYBOX_DEFAULTS.dryRunDefault === true);
check('HEYBOX_LIMITS 上下界与契约一致', stable(HEYBOX_LIMITS) === stable({
  dailyComments: [0, 50],
  minGapMs: [60000, 21600000],
  maxGapMs: [60000, 21600000],
  postMaxChars: [5, 500]
}));
check('常量（含其内部的上下界数组）是冻结的',
  Object.isFrozen(HEYBOX_DEFAULTS) && Object.isFrozen(HEYBOX_LIMITS)
  && Object.isFrozen(HEYBOX_LIMITS.dailyComments) && Object.isFrozen(HEYBOX_LIMITS.minGapMs)
  && Object.isFrozen(HEYBOX_LIMITS.maxGapMs) && Object.isFrozen(HEYBOX_LIMITS.postMaxChars));
check('normalizeHeyboxConfig(undefined) 逐键等于默认值',
  stable(normalizeHeyboxConfig(undefined)) === stable(DEFAULT_CONFIG));
check('normalizeHeyboxConfig({}) 逐键等于默认值',
  stable(normalizeHeyboxConfig({})) === stable(DEFAULT_CONFIG));
check('脏入参（null / 字符串 / 数组）也回落到默认值',
  stable(normalizeHeyboxConfig(null)) === stable(DEFAULT_CONFIG)
  && stable(normalizeHeyboxConfig('x')) === stable(DEFAULT_CONFIG)
  && stable(normalizeHeyboxConfig([])) === stable(DEFAULT_CONFIG));
check('返回值字段顺序稳定（序列化落盘时不会来回抖）',
  Object.keys(normalizeHeyboxConfig({})).join(',')
  === 'enabled,allowComment,cliPath,dailyComments,minGapMs,maxGapMs,postMaxChars,dryRunDefault');
check('布尔只认显式 true/false：0 / 字符串 / null 一律用默认',
  normalizeHeyboxConfig({ enabled: 0, allowComment: 'false', dryRunDefault: 1 }).enabled === true
  && normalizeHeyboxConfig({ enabled: 0, allowComment: 'false', dryRunDefault: 1 }).allowComment === false
  && normalizeHeyboxConfig({ enabled: null, allowComment: 'yes' }).dryRunDefault === true);
check('显式布尔被尊重：enabled false / allowComment true / dryRunDefault false',
  normalizeHeyboxConfig({ enabled: false, allowComment: true, dryRunDefault: false }).enabled === false
  && normalizeHeyboxConfig({ enabled: false, allowComment: true, dryRunDefault: false }).allowComment === true
  && normalizeHeyboxConfig({ enabled: false, allowComment: true, dryRunDefault: false }).dryRunDefault === false);
check('cliPath 空白串回落到默认值', normalizeHeyboxConfig({ cliPath: '   ' }).cliPath === 'xiaoheihe-cli');
check('cliPath 去首尾空白后保留（不是空串就用）',
  normalizeHeyboxConfig({ cliPath: ' /usr/bin/xhh ' }).cliPath === '/usr/bin/xhh');
check('数字字符串能转成数字（配置从 JSON 读出来常是字符串）',
  normalizeHeyboxConfig({ dailyComments: '12', minGapMs: '300000' }).dailyComments === 12
  && normalizeHeyboxConfig({ dailyComments: '12', minGapMs: '300000' }).minGapMs === 300000);
check('非数字字符串回落默认（postMaxChars 200）',
  normalizeHeyboxConfig({ postMaxChars: 'abc' }).postMaxChars === 200);
check('数值钳到上界：日上限 50、间隔 6 小时、字数 500',
  normalizeHeyboxConfig({ dailyComments: 99, minGapMs: 99999999, maxGapMs: 99999999, postMaxChars: 9999 }).dailyComments === 50
  && normalizeHeyboxConfig({ dailyComments: 99, minGapMs: 99999999, maxGapMs: 99999999, postMaxChars: 9999 }).minGapMs === 21600000
  && normalizeHeyboxConfig({ dailyComments: 99, minGapMs: 99999999, maxGapMs: 99999999, postMaxChars: 9999 }).maxGapMs === 21600000
  && normalizeHeyboxConfig({ dailyComments: 99, minGapMs: 99999999, maxGapMs: 99999999, postMaxChars: 9999 }).postMaxChars === 500);
check('数值钳到下界：日上限 0、间隔 1 分钟、字数 5',
  normalizeHeyboxConfig({ dailyComments: -5, minGapMs: 1, maxGapMs: 1, postMaxChars: 1 }).dailyComments === 0
  && normalizeHeyboxConfig({ dailyComments: -5, minGapMs: 1, maxGapMs: 1, postMaxChars: 1 }).minGapMs === 60000
  && normalizeHeyboxConfig({ dailyComments: -5, minGapMs: 1, maxGapMs: 1, postMaxChars: 1 }).maxGapMs === 60000
  && normalizeHeyboxConfig({ dailyComments: -5, minGapMs: 1, maxGapMs: 1, postMaxChars: 1 }).postMaxChars === 5);
check('maxGapMs < minGapMs 时抬到 minGapMs（10 分钟 / 5 分钟 → 都 10 分钟）', (() => {
  const cfg = normalizeHeyboxConfig({ minGapMs: 600000, maxGapMs: 300000 });
  return cfg.minGapMs === 600000 && cfg.maxGapMs === 600000;
})());
check('上界撞在一起时 maxGapMs 仍不小于 minGapMs（6 小时 / 1 分钟 → 都 6 小时）', (() => {
  const cfg = normalizeHeyboxConfig({ minGapMs: 21600000, maxGapMs: 60000 });
  return cfg.minGapMs === 21600000 && cfg.maxGapMs === 21600000;
})());
check('合法间隔原样保留（2 分钟 / 15 分钟）', (() => {
  const cfg = normalizeHeyboxConfig({ minGapMs: 120000, maxGapMs: 900000 });
  return cfg.minGapMs === 120000 && cfg.maxGapMs === 900000;
})());
check('归一化结果本身也是冻结的（下游不能改坏共享配置）',
  Object.isFrozen(normalizeHeyboxConfig({})));

// ── 组2：dayKeyOf 北京时间日界 ─────────────────────────────────────────────
console.log('\n── 组2：dayKeyOf 北京时间自然日 ──');

check('NOW（北京 10:00）→ 2026-10-20', dayKeyOf(NOW) === '2026-10-20');
check('日键是 10 位 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dayKeyOf(NOW)));
check('北京 23:59 还算当天', dayKeyOf(Date.parse('2026-10-20T23:59:00+08:00')) === '2026-10-20');
check('北京 23:59:59.999 还算当天',
  dayKeyOf(Date.parse('2026-10-20T23:59:59.999+08:00')) === '2026-10-20');
check('北京 00:00 整就是新的一天', dayKeyOf(Date.parse('2026-10-21T00:00:00+08:00')) === '2026-10-21');
check('北京 00:01 已跨日（23:59 与 00:01 分属两天）',
  dayKeyOf(Date.parse('2026-10-21T00:01:00+08:00')) === '2026-10-21'
  && dayKeyOf(Date.parse('2026-10-21T00:01:00+08:00')) !== dayKeyOf(Date.parse('2026-10-20T23:59:00+08:00')));
check('按 UTC 算会算错的时刻也对：北京 00:30 仍属当天（UTC 还是前一天 16:30）',
  dayKeyOf(Date.parse('2026-10-20T00:30:00+08:00')) === '2026-10-20');
check('UTC 16:00Z 等于北京次日 00:00 → 次日',
  dayKeyOf(Date.parse('2026-10-20T16:00:00Z')) === '2026-10-21');
check('UTC 15:59:59Z 仍是北京当天',
  dayKeyOf(Date.parse('2026-10-20T15:59:59Z')) === '2026-10-20');
check('加一天正好加一个日键', dayKeyOf(NOW + DAY) === '2026-10-21');
check('epoch 0 → 1970-01-01（北京 UTC+8 也是同一天）', dayKeyOf(0) === '1970-01-01');
check('NaN / undefined / null / 字符串 → 1970-01-01（不抛）',
  dayKeyOf(Number.NaN) === '1970-01-01' && dayKeyOf(undefined) === '1970-01-01'
  && dayKeyOf(null) === '1970-01-01' && dayKeyOf('x') === '1970-01-01');
check('极端时间戳不抛错（返回字符串即可）', (() => {
  try {
    return typeof dayKeyOf(8.64e15) === 'string' && typeof dayKeyOf(-8.64e15) === 'string';
  } catch {
    return false;
  }
})());

// ── 组3：heyboxQuota 判定顺序 ─────────────────────────────────────────────
console.log('\n── 组3：heyboxQuota 开关 / 暂停 / 日上限 / 间隔 ──');

check('全新状态：放行、剩 10 条、下次可评时间为 0', (() => {
  const q = heyboxQuota(freshState(), COMMENT_ON, NOW);
  return q.ok === true && q.reason === null && q.usedToday === 0 && q.remaining === 10 && q.nextAllowedAt === 0;
})());
check('第 10 条（已评 9 条）放行，剩 1 条', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 9, lastTs: NOW - 10 * MINUTE }, COMMENT_ON, NOW);
  return q.ok === true && q.usedToday === 9 && q.remaining === 1;
})());
check('第 11 条（已评 10 条）被日上限拒，剩 0', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 10, lastTs: NOW - 10 * MINUTE }, COMMENT_ON, NOW);
  return q.ok === false && q.reason === 'daily_cap' && q.usedToday === 10 && q.remaining === 0;
})());
check('间隔拦截：距上次 5 分钟 → too_frequent，给出 nextAllowedAt', (() => {
  const lastTs = NOW - 5 * MINUTE;
  const q = heyboxQuota({ day: '2026-10-20', count: 3, lastTs }, COMMENT_ON, NOW);
  return q.ok === false && q.reason === 'too_frequent' && q.nextAllowedAt === lastTs + 360000;
})());
check('间隔刚好到点（6 分钟整）放行', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 3, lastTs: NOW - 360000 }, COMMENT_ON, NOW);
  return q.ok === true && q.reason === null;
})());
check('差 1 毫秒仍被拦（边界取 <）', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 3, lastTs: NOW - 359999 }, COMMENT_ON, NOW);
  return q.ok === false && q.reason === 'too_frequent';
})());
check('lastTs 在未来（时钟回拨）也按 too_frequent 拦下',
  heyboxQuota({ day: '2026-10-20', count: 1, lastTs: NOW + 5000 }, COMMENT_ON, NOW).reason === 'too_frequent');
check('paused 优先于 daily_cap：今天被验证码拦过就报 paused', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 10, pausedUntil: NOW + HOUR }, COMMENT_ON, NOW);
  return q.ok === false && q.reason === 'paused';
})());
check('pausedUntil 已到点（等于 now）不再拦', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 1, pausedUntil: NOW }, COMMENT_ON, NOW);
  return q.ok === true;
})());
check('pausedUntil 过期后继续走常规判定',
  heyboxQuota({ day: '2026-10-20', count: 1, pausedUntil: NOW - 1 }, COMMENT_ON, NOW).ok === true);
check('disabled 最先：即使同时关评论、还在暂停、已满额也只报 disabled', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 10, pausedUntil: NOW + HOUR },
    { enabled: false, allowComment: false }, NOW);
  return q.ok === false && q.reason === 'disabled';
})());
check('comment_disabled 优先于 paused', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 10, pausedUntil: NOW + HOUR },
    { allowComment: false }, NOW);
  return q.ok === false && q.reason === 'comment_disabled';
})());
check('跨日重置：状态还是昨天的 10 条 → 今天从头算（不是 daily_cap）', (() => {
  const q = heyboxQuota({ day: '2026-10-19', count: 10, lastTs: 0 }, COMMENT_ON, NOW);
  return q.ok === true && q.usedToday === 0 && q.remaining === 10;
})());
check('usedToday 取的是 state.count 而非猜的', (() => {
  const q = heyboxQuota({ day: '2026-10-20', count: 3, lastTs: 0 }, COMMENT_ON, NOW);
  return q.usedToday === 3 && q.remaining === 7;
})());
check('count 超额（12 > 10）时 remaining 兜到 0，不出现负数',
  heyboxQuota({ day: '2026-10-20', count: 12 }, COMMENT_ON, NOW).remaining === 0);
check('dailyComments 配成 0 → 直接 daily_cap',
  heyboxQuota(freshState(), { allowComment: true, dailyComments: 0 }, NOW).reason === 'daily_cap');
check('坏 state（null / 字符串）不抛，按全新状态处理', (() => {
  const a = heyboxQuota(null, COMMENT_ON, NOW);
  const b = heyboxQuota('x', COMMENT_ON, NOW);
  return a.ok === true && b.ok === true && a.remaining === 10;
})());
check('返回字段固定为 ok/reason/usedToday/remaining/nextAllowedAt 加上额度快照', (() => {
  const q = heyboxQuota(freshState(), COMMENT_ON, NOW);
  return Object.keys(q).join(',') === 'ok,reason,usedToday,remaining,nextAllowedAt,dailyComments,minGapMs';
})());
check('连续发 10 条全放行、第 11 条被日上限拒（真跑一轮记账）', (() => {
  let state = freshState();
  let cursor = NOW;
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) {
    if (heyboxQuota(state, COMMENT_ON, cursor).ok) allowed += 1;
    state = recordAction(state, cursor);
    cursor += 10 * MINUTE;
  }
  return allowed === 10 && heyboxQuota(state, COMMENT_ON, cursor).reason === 'daily_cap';
})());
check('23:59 用满额度，次日 00:01 不再报 daily_cap（间隔仍可能拦）', (() => {
  const late = { day: '2026-10-20', count: 10, lastTs: Date.parse('2026-10-20T23:59:00+08:00'), pausedUntil: 0, pausedReason: '' };
  const q = heyboxQuota(late, COMMENT_ON, Date.parse('2026-10-21T00:01:00+08:00'));
  return q.usedToday === 0 && q.reason !== 'daily_cap';
})());
check('跨日且间隔够（次日 10:00）→ 完全放行', (() => {
  const state = { day: '2026-10-20', count: 10, lastTs: NOW, pausedUntil: 0, pausedReason: '' };
  return heyboxQuota(state, COMMENT_ON, NOW + DAY).ok === true;
})());

// ── 组4：auditComment ─────────────────────────────────────────────────────
console.log('\n── 组4：auditComment 六种拒绝 + 正常通过 ──');

check('纯空白 → empty', auditComment('', {}).reason === 'empty'
  && auditComment('   \n  ', {}).reason === 'empty'
  && auditComment('\u3000', {}).reason === 'empty');
check('null / undefined → empty（不抛）',
  auditComment(null, {}).reason === 'empty' && auditComment(undefined, {}).reason === 'empty');
check('4 个字 → too_short', auditComment('四个字啊', {}).reason === 'too_short');
check('5 个字刚好通过（长度按码点，下界含）', auditComment('五个字了啊', {}).ok === true);
check('超过 postMaxChars → too_long',
  auditComment('a'.repeat(201), {}).reason === 'too_long');
check('postMaxChars 可配：5 字上限时 6 个字太长、5 个字还行', (() => {
  const cfg = { postMaxChars: 5 };
  return auditComment('六个字了啊哈', cfg).reason === 'too_long' && auditComment('五个字了啊', cfg).ok === true;
})());
check('长度按码点算：200 个 emoji 不算 too_long（→ 更早的 meaningful 判定）',
  auditComment('😀'.repeat(200), {}).reason === 'meaningless');
check('201 个 emoji 才 too_long', auditComment('😀'.repeat(201), {}).reason === 'too_long');
check('含换行 → multiline（\\n 与 \\r 都算）',
  auditComment('第一行\n第二行', {}).reason === 'multiline'
  && auditComment('第一行\r第二行', {}).reason === 'multiline');
check('纯 emoji → meaningless', auditComment('😀😀😀😀😀', {}).reason === 'meaningless');
check('纯标点/全角标点 → meaningless', auditComment('，。！？、', {}).reason === 'meaningless');
check('同一个字连 5 次 → repetitive', auditComment('哈'.repeat(5), {}).reason === 'repetitive');
check('同一个字连 4 次不拦（"哈哈哈哈真好看" 通过）',
  auditComment('哈哈哈哈真好看', {}).ok === true);
check('带链接 → unsafe，detail 是 url', (() => {
  const r = auditComment('看这个 https://example.com/x 笑死', {});
  return r.ok === false && r.reason === 'unsafe' && r.detail === 'url';
})());
check('带手机号 → unsafe，detail 是 phone', (() => {
  const r = auditComment('打 13800138000 找我', {});
  return r.reason === 'unsafe' && r.detail === 'phone';
})());
check('带邮箱 → unsafe，detail 是 email', (() => {
  const r = auditComment('有问题邮件我 test@foo.bar 就行', {});
  return r.reason === 'unsafe' && r.detail === 'email';
})());
check('带身份证号 → unsafe，detail 是 idcard', (() => {
  const r = auditComment('身份证 110101199003077891 别外传', {});
  return r.reason === 'unsafe' && r.detail === 'idcard';
})());
check('拉人加群 → unsafe，detail 是 solicit', (() => {
  const r = auditComment('想一起玩的加群聊', {});
  return r.reason === 'unsafe' && r.detail === 'solicit';
})());
check('多个理由一起命中时 detail 用逗号拼接（url,phone）', (() => {
  const r = auditComment('看 https://a.com 和 13800138000 哈哈', {});
  return r.reason === 'unsafe' && r.detail === 'url,phone';
})());
check('正常吐槽通过：{ok:true, reason:null, detail:""}', (() => {
  const r = auditComment('这游戏是真的挺好玩', {});
  return r.ok === true && r.reason === null && r.detail === '';
})());
check('纯英文 / 纯数字也算有意义（不误判 meaningless）',
  auditComment('abcde', {}).ok === true && auditComment('12345', {}).ok === true);
check('非 unsafe 的拒绝一律不带 detail', (() => {
  const reasons = ['', '四个字啊', '第一行\n第二行', '😀😀😀😀😀', '，。！？、', '哈'.repeat(5)];
  return reasons.every((text) => auditComment(text, {}).detail === '');
})());
check('返回字段固定为 ok/reason/detail',
  Object.keys(auditComment('这游戏是真的挺好玩', {})).sort().join(',') === 'detail,ok,reason');

// ── 组5：nearDuplicate ────────────────────────────────────────────────────
console.log('\n── 组5：nearDuplicate 归一化 / exact / near ──');

check('去空格与标点后完全相同 → exact',
  nearDuplicate('这 个 游戏 真好玩！！', ['这个游戏真好玩']) === 'exact');
check('全角转半角 + 小写后相同 → exact',
  nearDuplicate('GOOD GAME', ['ＧＯＯＤＧＡＭＥ']) === 'exact');
check('大小写不敏感 → exact',
  nearDuplicate('Good Game Bro', ['goodgamebro']) === 'exact');
check('3-gram 相似度刚过 0.55 → near',
  nearDuplicate('这个游戏真的很好玩', ['这个游戏真的很难玩']) === 'near');
check('相似度不足（0.4）→ 空串',
  nearDuplicate('这个游戏真的很好玩', ['这个游戏真的难玩啊']) === '');
check('归一化后不足 6 字一律不判重',
  nearDuplicate('好的', ['好的']) === '' && nearDuplicate('好的', ['这个游戏真的很好玩']) === '');
check('recent 里的短条目直接跳过，不影响后面的长条目',
  nearDuplicate('这个游戏真的很好玩', ['好的', '这个游戏真的很好玩']) === 'exact');
check('空数组 / null → 空串',
  nearDuplicate('这个游戏真的很好玩', []) === ''
  && nearDuplicate('这个游戏真的很好玩', null) === '');
check('recent 里混入脏值不抛，仍能比对出 exact',
  nearDuplicate('这个游戏真的很好玩', [null, 42, {}, [], '第一段无关内容', '这个游戏真的很好玩']) === 'exact');
check('第 6 条重复也查得出来（不只看最近 5 条）', (() => {
  const recent = ['第一段无关内容', '第二段无关内容', '第三段无关内容', '第四段无关内容', '第五段无关内容', '这个游戏真的很好玩'];
  return nearDuplicate('这个游戏真的很好玩', recent) === 'exact';
})());
check('exact 优先于 near（recent 顺序不影响结论）',
  nearDuplicate('这个游戏真的很好玩', ['这个游戏真的很难玩', '这个游戏真的很好玩']) === 'exact');
check('完全不相干 → 空串', nearDuplicate('这个游戏真的很好玩', ['今晚吃什么好呢兄弟']) === '');
check('null 文本不抛（→ 空串）', nearDuplicate(null, ['这个游戏真的很好玩']) === '');

// ── 组6：recordAction / createHeyboxState ──────────────────────────────────
console.log('\n── 组6：recordAction 记账与跨日重置 ──');

check('createHeyboxState 形状：day/count/lastTs/pausedUntil/pausedReason', (() => {
  const state = createHeyboxState(NOW);
  return stable(state) === stable({
    day: '2026-10-20', count: 0, lastTs: 0, pausedUntil: 0, pausedReason: ''
  });
})());
check('createHeyboxState 的 day 就是 dayKeyOf(now)', createHeyboxState(NOW).day === dayKeyOf(NOW));
check('同日累加：count 3 → 4，lastTs 更新为 now', (() => {
  const next = recordAction({ day: '2026-10-20', count: 3, lastTs: NOW - HOUR, pausedUntil: 0, pausedReason: '' }, NOW);
  return next.count === 4 && next.lastTs === NOW && next.day === '2026-10-20';
})());
check('跨日重置：昨天 7 条 → 今天 1 条', (() => {
  const next = recordAction({ day: '2026-10-19', count: 7, lastTs: NOW - DAY, pausedUntil: 0, pausedReason: '' }, NOW);
  return next.count === 1 && next.day === '2026-10-20';
})());
check('暂停信息原样带过（记账不清暂停）', (() => {
  const next = recordAction({ day: '2026-10-20', count: 1, lastTs: 0, pausedUntil: NOW + HOUR, pausedReason: 'captcha' }, NOW);
  return next.pausedUntil === NOW + HOUR && next.pausedReason === 'captcha';
})());
check('返回新对象，且不改入参', (() => {
  const state = { day: '2026-10-20', count: 3, lastTs: NOW - HOUR, pausedUntil: 0, pausedReason: '' };
  const before = stable(state);
  const next = recordAction(state, NOW);
  return next !== state && stable(state) === before;
})());
check('冻结的入参也能记账（不会往里写）',
  recordAction(Object.freeze(createHeyboxState(NOW)), NOW).count === 1);
check('now 非法时退回 state.lastTs（不写 NaN）', (() => {
  const next = recordAction(createHeyboxState(NOW), 'x');
  return next.lastTs === 0 && next.count === 1;
})());
check('记账后字段顺序稳定',
  Object.keys(recordAction(freshState(), NOW)).join(',') === 'day,count,lastTs,pausedUntil,pausedReason');

// ── 组7：parseUsage / serializeUsage ──────────────────────────────────────
console.log('\n── 组7：parseUsage / serializeUsage 序列化 ──');

check('serializeUsage 是紧凑 JSON、字段顺序固定',
  serializeUsage(createHeyboxState(0))
  === '{"day":"1970-01-01","count":0,"lastTs":0,"pausedUntil":0,"pausedReason":""}');
check('serialize → parse 等价往返', (() => {
  const state = { day: '2026-10-20', count: 2, lastTs: 123, pausedUntil: 456, pausedReason: 'captcha' };
  return stable(parseUsage(serializeUsage(state))) === stable(state);
})());
check('坏 JSON → 空状态', stable(parseUsage('{not json')) === stable(createHeyboxState(0)));
check('空串 / null 字面量 / 数组 / 数字 → 空状态', (() => {
  const empty = stable(createHeyboxState(0));
  return stable(parseUsage('')) === empty && stable(parseUsage('null')) === empty
    && stable(parseUsage('[1]')) === empty && stable(parseUsage(42)) === empty
    && stable(parseUsage(undefined)) === empty;
})());
check('对象入参也接受（不必先转字符串）',
  parseUsage({ day: '2026-10-20', count: 3 }).count === 3);
check('count 类型不对 → 0，非法 day → 1970-01-01', (() => {
  const state = parseUsage({ day: '2026-1-2', count: 'x' });
  return state.count === 0 && state.day === '1970-01-01';
})());
check('负数的 count / lastTs / pausedUntil → 0', (() => {
  const state = parseUsage({ day: '2026-10-20', count: -2, lastTs: -5, pausedUntil: -1 });
  return state.count === 0 && state.lastTs === 0 && state.pausedUntil === 0;
})());
check('count 小数向下取整（5.9 → 5）', serializeUsage({ count: 5.9 }).includes('"count":5'));
check('pausedReason 非字符串 → 空串',
  parseUsage({ day: '2026-10-20', pausedReason: 7 }).pausedReason === '');
check('多余字段被丢掉，不污染 state',
  stable(parseUsage({ day: '2026-10-20', count: 3, extra: 1 }))
  === stable({ day: '2026-10-20', count: 3, lastTs: 0, pausedUntil: 0, pausedReason: '' }));
check('serialize 两次结果相同（稳定）', (() => {
  const state = { day: '2026-10-20', count: 4, lastTs: NOW, pausedUntil: 0, pausedReason: '' };
  return serializeUsage(state) === serializeUsage(state);
})());
check('serialize(parse(serialize(x))) 幂等', (() => {
  const state = { day: '2026-10-20', count: 4, lastTs: NOW, pausedUntil: 0, pausedReason: '' };
  return serializeUsage(parseUsage(serializeUsage(state))) === serializeUsage(state);
})());

// ── 组8：describeCliError ─────────────────────────────────────────────────
console.log('\n── 组8：describeCliError 五种 code + stderr 兜底 ──');

check('auth → 让用户重新扫码', (() => {
  const r = describeCliError({ ok: false, error: { code: 'auth', message: 'x' } });
  return r.code === 'auth' && r.text === '小黑盒登录失效，需要重新扫码登录';
})());
check('captcha → 先停一天',
  describeCliError({ ok: false, error: { code: 'captcha' } }).text === '小黑盒要求验证码，先停一天');
check('rate_limit → 今天别再试',
  describeCliError({ ok: false, error: { code: 'rate_limit' } }).text === '小黑盒限流了，今天别再试');
check('network → 连不上',
  describeCliError({ ok: false, error: { code: 'network' } }).text === '连不上小黑盒');
check('未知 code 收敛成 unknown + 通用中文', (() => {
  const r = describeCliError({ ok: false, error: { code: 'boom' } });
  return r.code === 'unknown' && r.text === '小黑盒拒绝了这次操作';
})());
check('五种 code 的文案互不相同', (() => {
  const texts = ['auth', 'captcha', 'rate_limit', 'network', 'boom']
    .map((code) => describeCliError({ ok: false, error: { code } }).text);
  return new Set(texts).size === 5;
})());
check('code 大小写与连字符都归一（RATE-LIMIT → rate_limit）',
  describeCliError({ ok: false, error: { code: 'RATE-LIMIT' } }).code === 'rate_limit');
check('裸 stderr 文本：验证码关键词', (() => {
  const r = describeCliError('触发验证码校验，需要登录');
  return r.code === 'captcha';
})());
check('裸 stderr 文本：频率关键词 → rate_limit',
  describeCliError('请求过于频繁').code === 'rate_limit');
check('裸 stderr 文本：登录失效 → auth',
  describeCliError('登录失效').code === 'auth');
check('裸 stderr 文本：超时 / ECONNRESET → network',
  describeCliError('超时').code === 'network' && describeCliError('ECONNRESET').code === 'network');
check('裸 stderr 文本：认不出来 → unknown',
  describeCliError('some random failure').code === 'unknown');
check('JSON 字符串也能解析',
  describeCliError('{"ok":false,"error":{"code":"auth"}}').code === 'auth');
check('{error:"..."} 这种简写也能认',
  describeCliError({ error: '未登录，请先扫码' }).code === 'auth');
check('null / 数字 / 空对象 → unknown（不抛）', (() => {
  return describeCliError(null).code === 'unknown'
    && describeCliError(42).code === 'unknown'
    && describeCliError({ ok: false }).code === 'unknown';
})());
check('返回字段固定为 code/text',
  Object.keys(describeCliError('x')).sort().join(',') === 'code,text');

// ── 组9：commentReasonText ────────────────────────────────────────────────
console.log('\n── 组9：commentReasonText 配额原因翻译 ──');

check('daily_cap 带上「评论过几条」和上限', (() => {
  const quota = heyboxQuota({ day: '2026-10-20', count: 10 }, COMMENT_ON, NOW);
  return commentReasonText('daily_cap', quota) === '今天已经评论过 10 条了（上限 10 条），明天再来';
})());
check('daily_cap 用 quota 的 usedToday / dailyComments（不是写死 10）', (() => {
  const text = commentReasonText('daily_cap', { usedToday: 3, dailyComments: 5 });
  return text.includes('3 条') && text.includes('上限 5 条') && text.includes('明天再来');
})());
check('daily_cap 没有 quota 时也有可读文案',
  commentReasonText('daily_cap').includes('明天再来'));
check('too_frequent → 默认 6 分钟', (() => {
  const quota = heyboxQuota({ day: '2026-10-20', count: 3, lastTs: NOW - MINUTE }, COMMENT_ON, NOW);
  return commentReasonText('too_frequent', quota) === '距上次评论还不到 6 分钟';
})());
check('too_frequent → 按配置的 minGapMs 算分钟（90 秒向上取整成 2）',
  commentReasonText('too_frequent', { minGapMs: 90000 }) === '距上次评论还不到 2 分钟');
check('paused 文案',
  commentReasonText('paused') === '今天被验证码拦过，先停一天');
check('comment_disabled 文案',
  commentReasonText('comment_disabled') === '评论开关没开');
check('disabled 文案',
  commentReasonText('disabled') === '小黑盒功能没启用');
check('未知 reason 兜底一句人话',
  commentReasonText('whatever') === '现在还不能评论');
check('五种 reason 的文案互不相同', (() => {
  const texts = ['daily_cap', 'too_frequent', 'paused', 'comment_disabled', 'disabled']
    .map((reason) => commentReasonText(reason));
  return new Set(texts).size === 5;
})());

// ── 组10：纯函数性与导出齐全 ──────────────────────────────────────────────
console.log('\n── 组10：纯函数性 / 导出齐全 ──');

check('13 个导出都在且类型正确', (() => {
  const expected = {
    HEYBOX_DEFAULTS: 'object',
    HEYBOX_LIMITS: 'object',
    normalizeHeyboxConfig: 'function',
    dayKeyOf: 'function',
    heyboxQuota: 'function',
    auditComment: 'function',
    nearDuplicate: 'function',
    recordAction: 'function',
    createHeyboxState: 'function',
    parseUsage: 'function',
    serializeUsage: 'function',
    describeCliError: 'function',
    commentReasonText: 'function'
  };
  return Object.entries(expected).every(([name, type]) => {
    if (type === 'function') return typeof heyboxCore[name] === 'function';
    return heyboxCore[name] !== null && typeof heyboxCore[name] === 'object';
  });
})());
check('同一份输入重复调用结果一致（没有隐藏状态）', (() => {
  const cfg = normalizeHeyboxConfig({ allowComment: true });
  const run = () => stable([
    heyboxQuota(freshState(), cfg, NOW),
    auditComment('这游戏是真的挺好玩', cfg),
    nearDuplicate('这个游戏真的很好玩', ['这个游戏真的很难玩'])
  ]);
  return run() === run();
})());
check('normalize 不修改传入的原始对象', (() => {
  const raw = { dailyComments: 3, enabled: false };
  const before = stable(raw);
  normalizeHeyboxConfig(raw);
  return stable(raw) === before;
})());
check('归一化不污染 HEYBOX_DEFAULTS（自己钳自己的那份）', (() => {
  const cfg = normalizeHeyboxConfig({ dailyComments: 99, minGapMs: 1 });
  return cfg.dailyComments === 50 && cfg.minGapMs === 60000
    && HEYBOX_DEFAULTS.dailyComments === 10 && HEYBOX_DEFAULTS.minGapMs === 360000;
})());

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n结果：${passed}/${passed + failed} passed`);
if (failed > 0) console.error(`失败 ${failed} 条`);
process.exitCode = failed > 0 ? 1 : 0;
