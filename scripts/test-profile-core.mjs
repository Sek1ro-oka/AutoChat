// 机器人自助改资料（src/profile-core.js）的纯函数单测。
//
// 跑法：`node scripts/test-profile-core.mjs`（全过 exit 0，有失败 exit 1）。
//
// 覆盖任务书的九个分组，真正调用被测函数（不硬编码期望值、不 mock）：
//   ① 配置归一：缺省 / 坏类型 / 越界钳位 / enabled / 不改入参 / 冻结
//   ② cleanProfileText：首尾空白 / 换行折叠 / 控制字符 / 截断 / 空串
//   ③ 昵称：合法 / 太短 / 太长 / 数字开头 / @ / 5 位数字 / 纯表情 / 链接 / 手机号
//   ④ 签名：空串清除 / 60 码点边界 / 61 拒 / URL / 拉人话术 / 换行
//   ⑤ 群名片：空串清除 / 20 边界 / 21 拒 / 拉人话术 / 硬上限
//   ⑥ 额度：滑动窗口边界 / 最小间隔 / 次数上限 / 按群独立 / 窗口收缩 / 钳制 / disabled
//   ⑦ recordChange：last / changes / 最近在前 / 100 条截断 / 不改入参 / reason 截断
//   ⑧ 状态序列化：坏 JSON / 往返一致 / 缺字段 / version 固定 / 未来时间戳
//   ⑨ avatarUrl：640/100 / 非法 size / 非法 uin
//
// 时间全部是假时钟：`new Date(2026, 9, 20, 10)` 造一个固定时刻，窗口边界用例因此
// 不依赖运行机器的时区；不读系统时钟、不碰 state/、不连网络。
import {
  PROFILE_DEFAULTS,
  PROFILE_LIMITS,
  PROFILE_KINDS,
  AVATAR_SIZES,
  normalizeProfileConfig,
  cleanProfileText,
  checkNickname,
  checkSignature,
  checkGroupCard,
  quotaFor,
  recordChange,
  createProfileState,
  normalizeProfileState,
  serializeProfileState,
  parseProfileState,
  avatarUrl
} from '../src/profile-core.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let passed = 0;
let failed = 0;

function ok(cond, name, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? `  — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

// ── ① 配置归一化 ────────────────────────────────────────────────────────────
console.log('① normalizeProfileConfig');

const cfg = normalizeProfileConfig({});

ok(
  cfg.enabled === true
  && cfg.nickname.minChars === 2 && cfg.nickname.maxChars === 12
  && cfg.nickname.windowHours === 4 && cfg.nickname.windowCap === 5 && cfg.nickname.minGapMs === 60000
  && cfg.signature.minChars === 0 && cfg.signature.maxChars === 60
  && cfg.signature.windowHours === 4 && cfg.signature.windowCap === 5 && cfg.signature.minGapMs === 60000
  && cfg.groupCard.minChars === 0 && cfg.groupCard.maxChars === 20
  && cfg.groupCard.windowHours === 4 && cfg.groupCard.windowCap === 5 && cfg.groupCard.minGapMs === 60000,
  '空对象 → 三组出厂默认（enabled 开 / 2-12 / 0-60 / 0-20；窗口统一 4 小时 5 次 / 60 秒）'
);
ok(
  normalizeProfileConfig().nickname.maxChars === 12
  && normalizeProfileConfig(null).enabled === true
  && normalizeProfileConfig('x').signature.maxChars === 60
  && normalizeProfileConfig([]).groupCard.windowCap === 5
  && normalizeProfileConfig(42).nickname.minChars === 2,
  '缺省 / null / 字符串 / 数组 / 数字输入都不抛'
);
ok(
  normalizeProfileConfig({ nickname: { maxChars: 'x', minChars: {} } }).nickname.maxChars === 12
  && normalizeProfileConfig({ nickname: { maxChars: 'x', minChars: {} } }).nickname.minChars === 2,
  "坏类型回落默认（'x' / {} 都不当数字）"
);
ok(
  normalizeProfileConfig({ nickname: { minChars: 99 } }).nickname.minChars === 12
  && normalizeProfileConfig({ nickname: { maxChars: 0 } }).nickname.maxChars === 1
  && normalizeProfileConfig({ signature: { maxChars: 61 } }).signature.maxChars === 60,
  '越界钳位：minChars 99→12 / maxChars 0→1 / maxChars 61→60'
);
ok(
  normalizeProfileConfig({ signature: { windowHours: 0 } }).signature.windowHours === 1
  && normalizeProfileConfig({ signature: { windowHours: 999 } }).signature.windowHours === 168,
  'windowHours 钳到 1–168 小时（写 0 → 1、写 999 → 168）'
);
ok(
  normalizeProfileConfig({ groupCard: { windowCap: 0 } }).groupCard.windowCap === 1
  && normalizeProfileConfig({ groupCard: { windowCap: 999 } }).groupCard.windowCap === 50,
  'windowCap 钳到 1–50（写 0 → 1、写 999 → 50）'
);
ok(
  normalizeProfileConfig({ nickname: { minGapMs: -5 } }).nickname.minGapMs === 0
  && normalizeProfileConfig({ nickname: { minGapMs: 0 } }).nickname.minGapMs === 0
  && normalizeProfileConfig({ nickname: { minGapMs: 9999999 } }).nickname.minGapMs === 3600000,
  'minGapMs 钳到 0–3600000（0 是合法值 = 关掉最小间隔）'
);
ok(
  normalizeProfileConfig({ enabled: false }).enabled === false
  && normalizeProfileConfig({ enabled: 'false' }).enabled === true
  && normalizeProfileConfig({ enabled: 0 }).enabled === true,
  "enabled 只认显式 false（'false' / 0 仍算开）"
);
ok(
  normalizeProfileConfig({ nickname: { maxChars: '10', windowCap: '2' } }).nickname.maxChars === 10
  && normalizeProfileConfig({ nickname: { windowCap: '2' } }).nickname.windowCap === 2
  && normalizeProfileConfig({ nickname: { minGapMs: '90000' } }).nickname.minGapMs === 90000,
  '手写 config.json 的数字字符串被接受'
);
ok(
  (() => {
    const raw = { enabled: 'no', nickname: { maxChars: 99 }, signature: { windowHours: 999 } };
    normalizeProfileConfig(raw);
    return raw.enabled === 'no' && raw.nickname.maxChars === 99 && raw.signature.windowHours === 999;
  })(),
  '不改入参（raw.nickname.maxChars 仍是 99）'
);
ok(
  Object.isFrozen(cfg) && Object.isFrozen(cfg.nickname)
  && JSON.stringify(normalizeProfileConfig(cfg)) === JSON.stringify(cfg),
  '返回值冻结且幂等'
);
ok(
  normalizeProfileConfig({ nickname: { minChars: 12, maxChars: 3 } }).nickname.minChars === 3,
  'minChars > maxChars 时收敛到 maxChars（避免永远改不了资料）'
);
ok(
  Object.isFrozen(PROFILE_DEFAULTS) && Object.isFrozen(PROFILE_DEFAULTS.nickname)
  && Object.isFrozen(AVATAR_SIZES) && Object.isFrozen(PROFILE_LIMITS)
  && JSON.stringify(PROFILE_KINDS) === '["nickname","signature","groupCard"]',
  '常量冻结，PROFILE_KINDS 顺序固定'
);

// ── ② cleanProfileText ─────────────────────────────────────────────────────
console.log('\n② cleanProfileText');

ok(cleanProfileText('  小鲸鱼  ', {}) === '小鲸鱼', '去首尾空白');
ok(cleanProfileText('第一行\n第二行', {}) === '第一行 第二行', '换行折成单个空格');
ok(cleanProfileText('a\t\t b    c', {}) === 'a b c', '连续空白折成单个空格');
ok(cleanProfileText('\u3000a\u3000\u3000b\u3000', {}) === 'a b', '全角空格也折（\\s 覆盖 U+3000）');
ok(cleanProfileText('a\u0001b\u0007', {}) === 'ab', '去掉控制字符（删掉而不是换成空格）');
ok(cleanProfileText('一二三四五', { maxChars: 3 }) === '一二三', '按 maxChars 截断');
ok(Array.from(cleanProfileText('😀😀😀', { maxChars: 2 })).length === 2, '截断按码点：2 个 emoji 仍是 2 个字符');
ok(cleanProfileText('', {}) === '' && cleanProfileText('   \n\t ', {}) === '', '空串 / 纯空白 → 空串');
ok(cleanProfileText(null, {}) === '' && cleanProfileText(undefined, {}) === '' && cleanProfileText(42, {}) === '', '非字符串 → 空串');
ok(cleanProfileText('\n 小鲸鱼 \r\n', {}) === '小鲸鱼', '首尾换行随 trim 一起去掉');
ok(cleanProfileText('字'.repeat(80), {}) === '字'.repeat(60), 'maxChars 缺省 60');
ok(
  cleanProfileText(' a\u0001\nb ', {}) === 'a b' && !/[\u0000-\u001f\u007f]/.test(cleanProfileText(' a\u0001\nb ', {})),
  '清洗后不残留控制字符，也不留下双空格'
);

// ── ③ 昵称 ─────────────────────────────────────────────────────────────────
console.log('\n③ checkNickname');

const nickCfg = normalizeProfileConfig({});

ok(
  checkNickname('小鲸鱼', nickCfg).ok === true && checkNickname('小鲸鱼', nickCfg).value === '小鲸鱼',
  '合法中文昵称通过，并回清洗后的值'
);
ok(
  checkNickname('小鲸鱼🐳', nickCfg).ok === true
  && Array.from(checkNickname('小鲸鱼🐳', nickCfg).value).length === 4,
  '中文 + emoji 通过（emoji 算 1 个码点）'
);
ok(checkNickname('鲸', nickCfg).reasons[0]?.code === 'too_short', '太短 → too_short');
ok(checkNickname('一二三四五六七八九十一二三', nickCfg).reasons[0]?.code === 'too_long', '13 字 → too_long');
ok(checkNickname('123abc', nickCfg).reasons[0]?.code === 'looks_like_contact', '数字开头 → looks_like_contact');
ok(checkNickname('abc@def', nickCfg).reasons[0]?.code === 'looks_like_contact', '含 @ → looks_like_contact（没点不成邮箱）');
ok(checkNickname('abc12345', nickCfg).reasons[0]?.code === 'looks_like_contact', '连续 5 位数字 → looks_like_contact');
ok(
  checkNickname('🐳🐳', nickCfg).reasons[0]?.code === 'bad_shape'
  && checkNickname('……', nickCfg).reasons[0]?.code === 'bad_shape',
  '纯 emoji / 纯标点 → bad_shape'
);
ok(
  (() => {
    const verdict = checkNickname('a.com 加群', nickCfg);
    return verdict.reasons.length === 2
      && verdict.reasons.every((item) => item.code === 'unsafe')
      && verdict.hits.some((hit) => hit.rule === 'url')
      && verdict.hits.some((hit) => hit.rule === 'solicit');
  })(),
  '含链接 + 拉人话术 → unsafe，auditContent 每条 reason 都并进 reasons'
);
ok(checkNickname('打13800138000', nickCfg).reasons[0]?.code === 'unsafe', '含手机号 → unsafe（走 auditContent）');
ok(
  checkNickname('', nickCfg).reasons[0]?.code === 'empty'
  && checkNickname('   ', nickCfg).reasons[0]?.code === 'empty',
  '空串 / 纯空白 → empty（昵称不能清除）'
);
ok(checkNickname('第一行\n第二行', nickCfg).reasons[0]?.code === 'bad_shape', '含换行 → bad_shape');

// ── ④ 签名 ─────────────────────────────────────────────────────────────────
console.log('\n④ checkSignature');

const sigCfg = normalizeProfileConfig({});
const clearedSig = checkSignature('', sigCfg);

ok(
  clearedSig.ok === true && clearedSig.cleared === true && clearedSig.value === '',
  '空串 = 清除签名（ok + cleared）'
);
ok(
  checkSignature('   \n  ', sigCfg).ok === true && checkSignature('   \n  ', sigCfg).cleared === true,
  '纯空白也当清除，不算内容错误'
);
ok(
  checkSignature('字'.repeat(60), sigCfg).ok === true
  && Array.from(checkSignature('字'.repeat(60), sigCfg).value).length === 60,
  '60 码点边界通过'
);
ok(checkSignature('字'.repeat(61), sigCfg).reasons[0]?.code === 'too_long', '61 码点 → too_long');
ok(
  checkSignature('字'.repeat(59) + '🐳', sigCfg).ok === true,
  '59 汉字 + 1 emoji = 60 码点通过（UTF-16 长度是 61）'
);
ok(checkSignature('看这里 https://example.com', sigCfg).reasons[0]?.code === 'unsafe', '含 URL → unsafe');
ok(checkSignature('联系 a@b.com', sigCfg).reasons[0]?.code === 'unsafe', '含邮箱 → unsafe');
ok(checkSignature('想进的加群', sigCfg).reasons[0]?.code === 'unsafe', '含拉人话术「加群」→ unsafe');
ok(checkSignature('第一行\n第二行', sigCfg).reasons[0]?.code === 'bad_shape', '含换行 → bad_shape');
ok(checkSignature('🌙', sigCfg).reasons[0]?.code === 'bad_shape', '纯 emoji → bad_shape（三种资料同一套形状闸门）');
ok(
  checkSignature('一二三四五六', { maxChars: 5 }).reasons[0]?.code === 'too_long',
  '子配置 { maxChars: 5 } 也生效（6 字拒）'
);
ok(
  (() => {
    const verdict = checkSignature('x'.repeat(61), sigCfg);
    return verdict.ok === false && verdict.value === ''
      && verdict.reasons.every((item) => typeof item.code === 'string' && typeof item.message === 'string')
      && Array.isArray(verdict.hits);
  })(),
  '被拒时 value 为空、reasons 是 {code,message}、hits 是数组'
);

// ── ⑤ 群名片 ───────────────────────────────────────────────────────────────
console.log('\n⑤ checkGroupCard');

const cardCfg = normalizeProfileConfig({});

ok(
  checkGroupCard('', cardCfg).ok === true && checkGroupCard('', cardCfg).cleared === true,
  '空串 = 清除群名片'
);
ok(checkGroupCard('一二三四五六七八九十一二三四五六七八九十', cardCfg).ok === true, '20 字边界通过');
ok(
  checkGroupCard('一二三四五六七八九十一二三四五六七八九十一', cardCfg).reasons[0]?.code === 'too_long',
  '21 字 → too_long'
);
ok(checkGroupCard('进群聊', cardCfg).reasons[0]?.code === 'unsafe', '含拉人话术「进群」→ unsafe');
ok(checkGroupCard('www.qq.com', cardCfg).reasons[0]?.code === 'unsafe', '含裸域名 → unsafe');
ok(checkGroupCard('第一行\n第二行', cardCfg).reasons[0]?.code === 'bad_shape', '含换行 → bad_shape');
ok(checkGroupCard('2024级1班', cardCfg).ok === true, '数字开头不拦（联系方式规则只对昵称生效）');
ok(checkGroupCard('🐳🐳', cardCfg).reasons[0]?.code === 'bad_shape', '纯 emoji → bad_shape');
ok(
  checkGroupCard('一二三四五六七八九十一二三四五六七八九十一', { maxChars: 60 }).reasons[0]?.code === 'too_long',
  '配置放大到 60 也只认 20（QQ 侧硬上限）'
);
ok(checkGroupCard('一二三四五六', { maxChars: 5 }).reasons[0]?.code === 'too_long', '子配置 maxChars 5 → 6 字拒');
ok(checkGroupCard('  夜班中  ', cardCfg).value === '夜班中', 'value 是清洗后的单行文本');
ok(
  (() => {
    const raw = { maxChars: 3 };
    const snapshot = JSON.stringify(raw);
    checkGroupCard('一二三四', raw);
    return JSON.stringify(raw) === snapshot;
  })(),
  'checkGroupCard 不改配置对象'
);

// ── ⑥ 额度（滑动窗口） ─────────────────────────────────────────────────────
console.log('\n⑥ quotaFor');

// 本地 2026-10-20 10:00：固定时刻，窗口边界用例不依赖运行机器时区。
const NOW = new Date(2026, 9, 20, 10, 0, 0, 0).getTime();
const fresh = createProfileState();
const qFresh = quotaFor(fresh, cfg, 'nickname', 0, NOW);

ok(
  qFresh.ok === true && qFresh.windowCount === 0 && qFresh.remaining === 5
  && qFresh.retryAfterMs === 0 && qFresh.lastTs === 0
  && qFresh.windowHours === 4 && qFresh.windowCap === 5 && qFresh.minGapMs === 60000,
  '首次可改：ok / 窗口内 0 次 / 剩 5 次 / 回显窗口参数'
);

// 造状态的工具：changes 是「成功改动」的流水，last 决定最小间隔。
const change = (ts, kind = 'nickname', groupId = 0, newValue = '新') => ({
  ts, kind, groupId, oldValue: '旧', newValue, reason: ''
});
const stateOf = (changes = [], last = {}) => normalizeProfileState({ last, changes }, NOW);

const qGap = quotaFor(stateOf([change(NOW - 55000)], {
  nickname: { ts: NOW - 55000, value: '新' }
}), cfg, 'nickname', 0, NOW);

ok(
  qGap.ok === false && qGap.reason === 'too_frequent'
  && qGap.retryAfterMs === 5000 && qGap.lastTs === NOW - 55000 && qGap.windowCount === 1,
  '59 秒内第二次 → too_frequent，retryAfterMs = 60s − 55s = 5000'
);

const qGapEdge = quotaFor(stateOf([change(NOW - MINUTE)], {
  nickname: { ts: NOW - MINUTE, value: '新' }
}), cfg, 'nickname', 0, NOW);

ok(
  qGapEdge.ok === true && qGapEdge.windowCount === 1 && qGapEdge.remaining === 4,
  '正好满 60 秒就放行（Δt = minGapMs 不算「太频繁」）'
);

const edgeChanges = [0, 1, 2, 3, 4].map((i) => change(NOW - 4 * HOUR, 'nickname', 0, `边${i}`));
const qEdge = quotaFor(stateOf(edgeChanges, { nickname: { ts: NOW - 4 * HOUR, value: '边4' } }), cfg, 'nickname', 0, NOW);

ok(
  qEdge.ok === true && qEdge.windowCount === 0 && qEdge.remaining === 5,
  '窗口左开：正好 4 小时前那 5 条已滑出窗口，一次都不算'
);

const capChanges = [
  change(NOW - 3 * HOUR),
  change(NOW - 2 * HOUR),
  change(NOW - 90 * MINUTE),
  change(NOW - 30 * MINUTE),
  change(NOW - 5 * MINUTE)
];
const capped = stateOf(capChanges, { nickname: { ts: NOW - 5 * MINUTE, value: '新' } });
const qCap = quotaFor(capped, cfg, 'nickname', 0, NOW);

ok(
  qCap.ok === false && qCap.reason === 'window_cap'
  && qCap.windowCount === 5 && qCap.remaining === 0 && qCap.retryAfterMs === HOUR,
  '窗口内满 5 次：第 6 次 window_cap，最早那条 3 小时前 + 4h − now = 1 小时'
);

ok(
  quotaFor(capped, cfg, 'signature', 0, NOW).ok === true
  && quotaFor(capped, cfg, 'signature', 0, NOW).windowCount === 0,
  '签名与昵称互不影响：昵称满了，签名仍有完整额度'
);

const cardChanges = [
  change(NOW - 3 * HOUR, 'groupCard', 111, 'A'),
  change(NOW - 2 * HOUR, 'groupCard', 111, 'B'),
  change(NOW - 90 * MINUTE, 'groupCard', 111, 'C'),
  change(NOW - 30 * MINUTE, 'groupCard', 111, 'D'),
  change(NOW - 5 * MINUTE, 'groupCard', 111, 'E'),
  change(NOW - 20 * MINUTE, 'groupCard', 222, 'X')
];
const cardState = stateOf(cardChanges, {
  groupCard: {
    111: { ts: NOW - 5 * MINUTE, value: 'E' },
    222: { ts: NOW - 20 * MINUTE, value: 'X' }
  }
});
const qCardA = quotaFor(cardState, cfg, 'groupCard', 111, NOW);
const qCardB = quotaFor(cardState, cfg, 'groupCard', 222, NOW);

ok(
  qCardA.reason === 'window_cap' && qCardA.windowCount === 5
  && qCardB.ok === true && qCardB.windowCount === 1 && qCardB.remaining === 4,
  '群名片按群独立计数：111 满 5 次、222 只用了 1 次'
);

const cardGapState = stateOf([change(NOW - 30 * 1000, 'groupCard', 111, 'A')], {
  groupCard: { 111: { ts: NOW - 30 * 1000, value: 'A' } }
});

ok(
  quotaFor(cardGapState, cfg, 'groupCard', 111, NOW).reason === 'too_frequent'
  && quotaFor(cardGapState, cfg, 'groupCard', 222, NOW).ok === true,
  '群名片最小间隔也按群独立：111 刚改过、222 可改'
);

const qCardAll = quotaFor(cardState, cfg, 'groupCard', undefined, NOW);

ok(
  qCardAll.ok === false && qCardAll.reason === 'window_cap'
  && qCardAll.windowCount === 6 && qCardAll.lastTs === 0,
  '不带群号：lastTs 归零（跳过最小间隔判定），计数按全部群名片合并（5+1=6）'
);
ok(
  quotaFor(fresh, cfg, 'groupCard', undefined, NOW).ok === true
  && quotaFor(fresh, cfg, 'groupCard', undefined, NOW).lastTs === 0,
  '不带群号且没改过：仍可改（不因为「缺群号」直接拒）'
);

const narrowCfg = normalizeProfileConfig({ signature: { windowHours: 1 } });
const narrowState = stateOf([
  change(NOW - 3 * HOUR, 'signature', 0, '旧1'),
  change(NOW - 2 * HOUR, 'signature', 0, '旧2'),
  change(NOW - 90 * MINUTE, 'signature', 0, '旧3'),
  change(NOW - 10 * MINUTE, 'signature', 0, '新1'),
  change(NOW - 5 * MINUTE, 'signature', 0, '新2')
], { signature: { ts: NOW - 5 * MINUTE, value: '新2' } });
const qNarrow = quotaFor(narrowState, narrowCfg, 'signature', 0, NOW);

ok(
  qNarrow.ok === true && qNarrow.windowCount === 2 && qNarrow.remaining === 3
  && qNarrow.windowHours === 1,
  'windowHours:1 缩小窗口：3 小时前那 3 条不算，窗口内只数到 2 条'
);

const cap1Cfg = normalizeProfileConfig({ nickname: { windowCap: 1 } });

ok(
  quotaFor(stateOf([change(NOW - HOUR)], { nickname: { ts: NOW - HOUR, value: '新' } }), cap1Cfg, 'nickname', 0, NOW).reason === 'window_cap',
  'windowCap:1 → 改过一次就满（窗口内 1 ≥ 1）'
);

const noGapCfg = normalizeProfileConfig({ nickname: { minGapMs: 0 } });

ok(
  quotaFor(stateOf([change(NOW - 1000)], { nickname: { ts: NOW - 1000, value: '新' } }), noGapCfg, 'nickname', 0, NOW).ok === true,
  'minGapMs:0 = 关掉最小间隔（1 秒前刚改过也能再改）'
);

// 时钟回拨：直接 normalizeProfileState（不给 now，避免把未来时间戳钳回现在），
// 模拟「账本里有一条比当前时间还晚的记录」。
const futureState = normalizeProfileState({
  last: { nickname: { ts: NOW + 30000, value: '新' } },
  changes: [change(NOW + 30000)]
});
const qRollback = quotaFor(futureState, cfg, 'nickname', 0, NOW);

ok(
  qRollback.reason === 'too_frequent' && qRollback.retryAfterMs === 90000
  && qRollback.windowCount === 0,
  '时钟回拨（上次记录在未来 30 秒）：等待变成 90 秒，未来的记录不占窗口次数'
);

const bothBad = stateOf([
  change(NOW - 3 * HOUR), change(NOW - 2 * HOUR), change(NOW - HOUR),
  change(NOW - 30 * MINUTE), change(NOW - 10 * 1000)
], { nickname: { ts: NOW - 10 * 1000, value: '新' } });

ok(
  quotaFor(bothBad, cfg, 'nickname', 0, NOW).reason === 'too_frequent',
  '判定顺序：最小间隔先于窗口上限（两条都成立时报 too_frequent）'
);

const qOff = quotaFor(fresh, normalizeProfileConfig({ enabled: false }), 'nickname', 0, NOW);

ok(
  qOff.ok === false && qOff.reason === 'disabled' && qOff.retryAfterMs === 0
  && qOff.windowCount === 0 && qOff.windowCap === 5,
  'enabled:false → disabled（九个字段照样给齐）'
);
ok(
  quotaFor(fresh, cfg, 'avatar', 0, NOW).reason === 'unknown_kind'
  && quotaFor(fresh, cfg, 'avatar', 0, NOW).windowCap === 0,
  '未知 kind 拒绝（不抛），窗口参数归零'
);
ok(
  (() => {
    const stateSnapshot = JSON.stringify(capped);
    const cfgSnapshot = JSON.stringify(cfg);
    quotaFor(capped, cfg, 'nickname', 0, NOW);
    return JSON.stringify(capped) === stateSnapshot && JSON.stringify(cfg) === cfgSnapshot;
  })(),
  'quotaFor 不改 state / config'
);

// ── ⑦ recordChange ─────────────────────────────────────────────────────────
console.log('\n⑦ recordChange');

const baseState = createProfileState();
const recorded = recordChange(baseState, {
  ts: NOW, kind: 'nickname', oldValue: '旧名字', newValue: '新名字', reason: '想换个心情'
}, cfg);

ok(
  recorded.last.nickname.ts === NOW && recorded.last.nickname.value === '新名字',
  '写 last.nickname（ts + value）'
);
ok(
  recorded.changes.length === 1
  && recorded.changes[0].ts === NOW && recorded.changes[0].kind === 'nickname'
  && recorded.changes[0].groupId === 0
  && recorded.changes[0].oldValue === '旧名字' && recorded.changes[0].newValue === '新名字'
  && recorded.changes[0].reason === '想换个心情',
  'changes 条目字段齐全（含 groupId 0）'
);

const twice = recordChange(recorded, {
  ts: NOW + 1000, kind: 'signature', oldValue: '', newValue: '新签名', reason: ''
}, cfg);

ok(
  twice.changes[0].newValue === '新签名' && twice.changes[1].newValue === '新名字'
  && twice.last.signature.ts === NOW + 1000,
  '最近一次在前'
);
ok(
  (() => {
    let many = createProfileState();
    for (let i = 0; i < 130; i += 1) {
      many = recordChange(many, {
        ts: NOW + i, kind: 'signature', oldValue: '', newValue: `第${i}次`, reason: ''
      }, cfg);
    }
    return many.changes.length === 100
      && many.changes[0].newValue === '第129次'
      && many.changes[99].newValue === '第30次';
  })(),
  '超过 100 条截断，丢的是最旧的'
);
ok(
  (() => {
    const snapshot = JSON.stringify(recorded);
    recordChange(recorded, {
      ts: NOW + 5, kind: 'groupCard', groupId: 999, oldValue: '', newValue: '群名', reason: ''
    }, cfg);
    return JSON.stringify(recorded) === snapshot;
  })(),
  '不改入参（深拷贝后写）'
);
ok(
  recordChange(baseState, {
    ts: NOW, kind: 'signature', oldValue: '', newValue: 'x', reason: '字'.repeat(45)
  }, cfg).changes[0].reason.length === 40,
  'reason 截到 40 字'
);

const cardRecorded = recordChange(baseState, {
  ts: NOW, kind: 'groupCard', groupId: 123456, oldValue: '', newValue: '夜班中', reason: ''
}, cfg);

ok(
  cardRecorded.last.groupCard['123456'].ts === NOW
  && cardRecorded.last.groupCard['123456'].value === '夜班中'
  && cardRecorded.changes[0].groupId === 123456,
  '群名片按群号写 last.groupCard'
);

const cardNoGroup = recordChange(baseState, {
  ts: NOW, kind: 'groupCard', oldValue: '', newValue: '夜班中', reason: ''
}, cfg);

ok(
  cardNoGroup.changes[0].groupId === 0 && Object.keys(cardNoGroup.last.groupCard).length === 0,
  '群号缺失：groupId 记 0，不写 last.groupCard'
);
ok(
  recordChange(recorded, { ts: NOW + 1, kind: 'avatar', oldValue: '', newValue: 'x', reason: '' }, cfg).changes.length === 1
  && recordChange(recorded, { ts: 'x', kind: 'nickname', oldValue: '', newValue: 'x', reason: '' }, cfg).changes.length === 1,
  '未知 kind / 坏 ts 都忽略（返回归一化后的原状态）'
);
ok(
  recordChange(baseState, {
    ts: NOW, kind: 'signature', oldValue: '', newValue: '  a\nb  ', reason: ''
  }, cfg).changes[0].newValue === 'a b',
  'old/newValue 走同一套清洗（单行）'
);
ok(
  recordChange(null, {
    ts: NOW, kind: 'nickname', oldValue: '', newValue: '小鲸鱼', reason: ''
  }, cfg).last.nickname.value === '小鲸鱼',
  'state 为 null 也能记（先归一化）'
);
ok(
  recordChange(createProfileState(), {
    ts: NOW, kind: 'nickname', oldValue: '', newValue: '一二三四五六', reason: ''
  }, normalizeProfileConfig({ nickname: { maxChars: 3 } })).changes[0].newValue === '一二三',
  'newValue 按该种类 maxChars 截断'
);

// ── ⑧ 状态序列化 ───────────────────────────────────────────────────────────
console.log('\n⑧ 状态序列化');

const emptyState = createProfileState();

ok(
  emptyState.version === 1 && emptyState.changes.length === 0
  && emptyState.last.nickname.ts === 0 && emptyState.last.signature.ts === 0
  && Object.keys(emptyState.last.groupCard).length === 0,
  'createProfileState 形状（version 1 / 两个空 last / 空群名片表）'
);
ok(
  JSON.stringify(parseProfileState('{not json')) === JSON.stringify(createProfileState()),
  'parseProfileState 坏 JSON → createProfileState()（不是 null）'
);
ok(
  JSON.stringify(parseProfileState('')) === JSON.stringify(createProfileState())
  && JSON.stringify(parseProfileState('[]')) === JSON.stringify(createProfileState())
  && JSON.stringify(parseProfileState(null)) === JSON.stringify(createProfileState()),
  '空串 / 非对象 JSON / null → createProfileState()'
);
ok(
  (() => {
    const state = recordChange(createProfileState(), {
      ts: NOW, kind: 'nickname', oldValue: '旧', newValue: '新', reason: '换心情'
    }, cfg);
    return JSON.stringify(parseProfileState(serializeProfileState(state))) === JSON.stringify(state);
  })(),
  'serialize → parse 往返一致'
);
ok(
  JSON.stringify(normalizeProfileState(undefined, NOW)) === JSON.stringify(createProfileState())
  && JSON.stringify(normalizeProfileState({}, NOW)) === JSON.stringify(createProfileState())
  && JSON.stringify(normalizeProfileState('nope', NOW)) === JSON.stringify(createProfileState()),
  'normalizeProfileState 容忍 null / 缺字段 / 字符串'
);
ok(normalizeProfileState({ version: 9 }, NOW).version === 1, 'version 固定 1');
ok(
  (() => {
    const fixed = normalizeProfileState({
      last: { nickname: { ts: 'x', value: 42 }, signature: { ts: -5, value: null } }
    }, NOW);
    return fixed.last.nickname.ts === 0 && fixed.last.nickname.value === ''
      && fixed.last.signature.ts === 0 && fixed.last.signature.value === '';
  })(),
  '坏 last 条目被修复（坏 ts → 0、非字符串值 → 空串）'
);
ok(
  (() => {
    const fixed = normalizeProfileState({
      changes: [
        { kind: 'nickname' },
        { ts: 'x', kind: 'signature' },
        { ts: NOW, kind: 'avatar' },
        { ts: NOW, kind: 'nickname', newValue: '好' }
      ]
    }, NOW);
    return fixed.changes.length === 1 && fixed.changes[0].kind === 'nickname';
  })(),
  '坏 changes 条目丢弃（缺 ts / 坏 kind）'
);
ok(
  (() => {
    const list = [];
    for (let i = 0; i < 130; i += 1) {
      list.push({ ts: NOW - i * 1000, kind: 'signature', oldValue: '', newValue: `第${i}次`, reason: '' });
    }
    const fixed = normalizeProfileState({ changes: list }, NOW);
    return fixed.changes.length === 100
      && fixed.changes[0].ts === NOW && fixed.changes[99].ts === NOW - 99 * 1000;
  })(),
  'changes 只留最近 100 条（按时间倒序）'
);
ok(
  normalizeProfileState({ last: { nickname: { ts: NOW + DAY, value: '未来' } } }, NOW).last.nickname.ts === NOW,
  '未来时间戳被 now 钳住（时钟回拨不会永久锁死）'
);
ok(
  (() => {
    const text = serializeProfileState({
      version: 1,
      last: { nickname: { ts: Number.NaN, value: 'x' }, signature: { ts: 0, value: '' }, groupCard: {} },
      changes: []
    });
    return JSON.parse(text).last.nickname.ts === 0;
  })(),
  'serializeProfileState 把 NaN 写成 0'
);
ok(
  (() => {
    const source = {
      last: { nickname: { ts: NOW, value: '旧' } },
      changes: [{ ts: NOW, kind: 'nickname', oldValue: '', newValue: '旧', reason: '' }]
    };
    const snapshot = JSON.stringify(source);
    normalizeProfileState(source, NOW);
    parseProfileState(serializeProfileState(source));
    return JSON.stringify(source) === snapshot;
  })(),
  'normalize / parse / serialize 都不改入参'
);

// ── ⑨ avatarUrl ────────────────────────────────────────────────────────────
console.log('\n⑨ avatarUrl');

ok(avatarUrl('10001') === 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=640', '默认 640');
ok(avatarUrl('10001', 100) === 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100', 'size=100');
ok(
  avatarUrl('10001', 300).endsWith('&s=640') && avatarUrl('10001', 0).endsWith('&s=640'),
  '非法 size 回落 640'
);
ok(avatarUrl('10001', '100').endsWith('&s=100'), "查询串里的 '100' 也认");
ok(avatarUrl('abc') === '' && avatarUrl('1000a') === '', '非数字 uin → 空串');
ok(avatarUrl('1234') === '' && avatarUrl('1234567890123') === '', 'uin 不是 5–12 位 → 空串');
ok(avatarUrl(10001) === 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=640', 'number 类型 uin 也认');
ok(avatarUrl(' 10001 ') === 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=640', 'uin 两端空白被 trim');
ok(avatarUrl(undefined) === '' && avatarUrl(null) === '' && avatarUrl(10001.5) === '', '缺省 / null / 非整数 → 空串');
ok(
  /^https:\/\/q1\.qlogo\.cn\/g\?b=qq&nk=\d{5,12}&s=(640|100)$/.test(avatarUrl('123456', '640')),
  'URL 形状固定（qlogo 直链）'
);
ok(
  Object.isFrozen(AVATAR_SIZES) && AVATAR_SIZES.length === 2
  && AVATAR_SIZES[0] === 640 && AVATAR_SIZES[1] === 100,
  'AVATAR_SIZES 只有 640/100 且冻结'
);
ok(
  avatarUrl('10001', '640') === avatarUrl('10001', 640)
  && avatarUrl('10001', '750') === avatarUrl('10001', 640),
  '字符串 size 归一后与数字等价、未知尺寸同回落'
);

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
process.exitCode = failed > 0 ? 1 : 0;
