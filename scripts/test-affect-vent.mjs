// 宣泄决策器（src/affect-vent.js）的单测。
//
// 跑法：`node scripts/test-affect-vent.mjs`（全过 exit 0，有失败 exit 1）。
//
// 覆盖任务清单的 6 条：
//   ① 七种失败原因各一次且 reason 字符串精确：disabled / below_threshold / min_interval /
//      quiet_hours / disabled_channel / daily_cap / all_denied（后三个是出口级，出现在 detail 里，
//      all_denied 是顶层结论）
//   ② 出口降级链：qzone 关 → private；qzone+private 关 → diary；三个都关 → all_denied
//   ③ pickStep 边界：0.24→0.25、0.5→0.5、0.74→0.75、0.99→1
//   ④ checkVentText：URL / @ / 手机号 / 邮箱 / 长数字 / 证件号 / 感叹号过多 / 问号过多 /
//      连续重复 / 空文本 / 仅标点 / 与前文相同 / 3-gram 相似 各被拒，正常文本通过
//   ⑤ plan 数组非空且包含被拒出口的原因
//   ⑥ 纯函数性：调用后 `JSON.stringify(state)` 不变（caps / recentTexts 也不变）
//
// 时间全部是常量假时钟（不读系统时钟、不碰 state/、不连网络）。
import {
  planVent,
  checkVentText,
  pickStep,
  buildVentPlan,
  VENT_CHANNELS
} from '../src/affect-vent.js';
import { normalizeAffectConfig, normalizeState, createState } from '../src/affect-core.js';

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

/** 假时钟：北京时间 2026-10-20 10:00（注入给纯函数，不依赖本机时区）。 */
const T0 = Date.parse('2026-10-20T10:00:00+08:00');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const cfg = normalizeAffectConfig({});
/** 上层传进来的「今天还有额度吗」：默认三个出口都有，空间也配置好了。 */
const CAPS = Object.freeze({ qzone: true, private: true, diary: true, qzoneConfigured: true });

/** 造一个 anger 已过阈值+剂量的状态（口径与 test-affect-core 的 stateWith 一致）。 */
function stateWith(over = {}, now = T0) {
  const emotions = over.emotions ?? {
    anger: {
      intensity: over.intensity ?? 0.8,
      dose: over.dose ?? 20,
      cooldownUntil: over.cooldownUntil ?? 0,
      lastTs: over.lastTs ?? now,
      peak: over.intensity ?? 0.8
    }
  };
  return normalizeState({
    emotions,
    ventLog: over.ventLog ?? [],
    lastVentTs: over.lastVentTs ?? 0
  }, now, cfg);
}

// ── ① 七种失败原因 ─────────────────────────────────────────────────────────
console.log('① planVent 失败原因（reason 逐字）');

const disabled = planVent({ state: stateWith(), cfg: normalizeAffectConfig({ enabled: false }), now: T0 });
check('enabled=false → disabled',
  disabled.ok === false && disabled.reason === 'disabled', `reason=${disabled.reason}`);

const below = planVent({ state: createState(T0, cfg), cfg, now: T0, caps: CAPS });
check('四维都没过阈值 → below_threshold',
  below.ok === false && below.reason === 'below_threshold' && below.detail.anger === 'below_threshold',
  `reason=${below.reason}`);

const noInterval = planVent({ state: stateWith({ lastVentTs: T0 - 10 * MINUTE }), cfg, now: T0, caps: CAPS });
check('距上次宣泄只有 10 分钟 → min_interval',
  noInterval.ok === false && noInterval.reason === 'min_interval'
  && noInterval.retryAfterMs > 0 && noInterval.retryAfterMs <= 2.5 * HOUR,
  `retryAfterMs=${noInterval.retryAfterMs}`);
check('min_interval 可复现（抖动确定性，不读随机数）',
  planVent({ state: stateWith({ lastVentTs: T0 - 10 * MINUTE }), cfg, now: T0, caps: CAPS }).retryAfterMs
  === noInterval.retryAfterMs);

const quiet = planVent({
  state: stateWith(),
  cfg: normalizeAffectConfig({ vents: { diary: false } }),
  now: T0,
  quiet: true,
  caps: CAPS
});
check('静默时段且日记出口也关 → quiet_hours',
  quiet.ok === false && quiet.reason === 'quiet_hours'
  && quiet.detail.qzone === 'quiet_hours' && quiet.detail.private === 'quiet_hours'
  && quiet.detail.diary === 'disabled_channel',
  `reason=${quiet.reason}`);

const qzoneOff = planVent({ state: stateWith(), cfg: normalizeAffectConfig({ vents: { qzone: false } }), now: T0, caps: CAPS });
check('qzone 出口关 → detail.qzone === disabled_channel，落到 private',
  qzoneOff.ok === true && qzoneOff.channel === 'private' && qzoneOff.detail.qzone === 'disabled_channel',
  `channel=${qzoneOff.channel}`);

const qzoneCapped = planVent({
  state: stateWith(),
  cfg,
  now: T0,
  caps: { qzone: false, private: true, diary: true, qzoneConfigured: true }
});
check('qzone 今天没额度 → detail.qzone === daily_cap，落到 private',
  qzoneCapped.ok === true && qzoneCapped.channel === 'private' && qzoneCapped.detail.qzone === 'daily_cap');

const allDenied = planVent({
  state: stateWith(),
  cfg: normalizeAffectConfig({ vents: { qzone: false, private: false, diary: false } }),
  now: T0,
  caps: CAPS
});
check('三个出口全关 → all_denied + 每个出口的拒因',
  allDenied.ok === false && allDenied.reason === 'all_denied'
  && allDenied.detail.qzone === 'disabled_channel'
  && allDenied.detail.private === 'disabled_channel'
  && allDenied.detail.diary === 'disabled_channel',
  `reason=${allDenied.reason}`);

const allCapped = planVent({
  state: stateWith(),
  cfg,
  now: T0,
  caps: { qzone: false, private: false, diary: false, qzoneConfigured: true }
});
check('三个出口今天都没额度 → all_denied + daily_cap',
  allCapped.ok === false && allCapped.reason === 'all_denied'
  && allCapped.detail.qzone === 'daily_cap'
  && allCapped.detail.private === 'daily_cap'
  && allCapped.detail.diary === 'daily_cap');

check('出口关闭优先于额度：关掉的出口报 disabled_channel 而不是 daily_cap',
  planVent({
    state: stateWith(),
    cfg: normalizeAffectConfig({ vents: { qzone: false } }),
    now: T0,
    caps: { qzone: false, private: true, diary: true, qzoneConfigured: true }
  }).detail.qzone === 'disabled_channel');

// ── ② 出口降级链 ───────────────────────────────────────────────────────────
console.log('\n② 降级链 qzone → private → diary');

check('qzone 关 → private',
  qzoneOff.ok === true && qzoneOff.channel === 'private' && qzoneOff.detail.private === undefined);
check('qzone + private 关 → diary', (() => {
  const result = planVent({
    state: stateWith(),
    cfg: normalizeAffectConfig({ vents: { qzone: false, private: false } }),
    now: T0,
    caps: CAPS
  });
  return result.ok === true && result.channel === 'diary'
    && result.detail.qzone === 'disabled_channel' && result.detail.private === 'disabled_channel';
})());
check('三个都关 → all_denied（不再降级到 group：group 不是宣泄出口）',
  allDenied.ok === false && allDenied.reason === 'all_denied');
check('静默时段 + 日记开 → 只走 diary', (() => {
  const result = planVent({ state: stateWith(), cfg, now: T0, quiet: true, caps: CAPS });
  return result.ok === true && result.channel === 'diary'
    && result.detail.qzone === 'quiet_hours' && result.detail.private === 'quiet_hours';
})());
check('qzone 未配置（caps.qzoneConfigured 缺省）→ qzone_unconfigured，落到 private', (() => {
  const result = planVent({
    state: stateWith(),
    cfg,
    now: T0,
    caps: { qzone: true, private: true, diary: true }
  });
  return result.ok === true && result.channel === 'private' && result.detail.qzone === 'qzone_unconfigured';
})());

// ── ③ pickStep 边界 ────────────────────────────────────────────────────────
console.log('\n③ pickStep 档位');

check('pickStep(0.24) === 0.25', pickStep(0.24) === 0.25);
check('pickStep(0.5) === 0.5', pickStep(0.5) === 0.5);
check('pickStep(0.74) === 0.75', pickStep(0.74) === 0.75);
check('pickStep(0.99) === 1', pickStep(0.99) === 1);
check('边界补测：0 / NaN / 1 / 越界都落在四档内',
  pickStep(0) === 0.25 && pickStep(-1) === 0.25 && pickStep(Number.NaN) === 0.25
  && pickStep(1) === 1 && pickStep(2) === 1 && pickStep(0.75) === 0.75,
  `0→${pickStep(0)} 1→${pickStep(1)} 2→${pickStep(2)}`);
check('planVent 成功时 step 与 pickStep(intensity) 一致', (() => {
  const result = planVent({ state: stateWith({ intensity: 0.8 }), cfg, now: T0, caps: CAPS });
  return result.ok === true && result.step === pickStep(result.intensity)
    && result.step === 1 && result.emotion === 'anger';
})(), `intensity=0.8 → step=1`);

// ── ④ checkVentText 质量闸门 ───────────────────────────────────────────────
console.log('\n④ checkVentText 质量闸门');

/** 只取 reasons（通过时给空数组，方便断言「不包含某条」）。 */
function reasonsOf(text, recentTexts, channel, opts) {
  const result = checkVentText(text, recentTexts, channel, opts);
  return result.ok === true ? [] : (result.reasons ?? []);
}
function rejectedWith(text, id, recentTexts = [], channel = 'qzone', opts) {
  return reasonsOf(text, recentTexts, channel, opts).includes(id);
}

const OK_QZONE = '今天走了很远的路，回来的时候天已经黑了，忽然觉得有点累，但心里还算安静。';
const OK_DIARY = '今天从早到晚都在想一些没什么用的事情。'.repeat(6);
const PRIVATE_OK = '今天还不错';

check('正常说说文本通过（长度落在 15–300）',
  checkVentText(OK_QZONE, [], 'qzone').ok === true && OK_QZONE.length >= 15 && OK_QZONE.length <= 300,
  `${OK_QZONE.length} 字`);
check('正常私聊短句通过（5–120）', checkVentText(PRIVATE_OK, [], 'private').ok === true);
check('正常日记通过（100–300）',
  checkVentText(OK_DIARY, [], 'diary').ok === true && OK_DIARY.length >= 100 && OK_DIARY.length <= 300,
  `${OK_DIARY.length} 字`);
check('与不同主题的旧文案不相似 → 通过',
  checkVentText('那阵风把窗台上的纸吹跑了，我愣了几秒才弯腰去捡。', [OK_QZONE], 'qzone').ok === true);

check('URL（https://）被拒', rejectedWith('看看这个 https://example.com/a 挺有意思的', 'url'));
check('URL（www.）被拒', rejectedWith('你去 www.qq.com 看看就知道了，我记得是那个', 'url'));
check('@ 被拒', rejectedWith('今天想 @某人 一起吃饭，但是一直没等到回复', 'at'));
check('手机号（11 位）被拒', rejectedWith('我的手机号 13812345678，随时可以打过来', 'digits'));
check('5 位以上连续数字被拒', rejectedWith('订单号 12345 一直查不到，真是服了', 'digits'));
check('邮箱被拒（且不再重复报 at）', (() => {
  const reasons = reasonsOf('给我发邮件吧，账号是 someone@example.com，我等着', [], 'qzone');
  return reasons.includes('email') && !reasons.includes('at');
})());
check('身份证式 18 位被拒（且不再重复报 digits）', (() => {
  const reasons = reasonsOf('身份证号是 110101199003071234，别乱传', [], 'qzone');
  return reasons.includes('idcard') && !reasons.includes('digits');
})());
check('感叹号 > 3 被拒', rejectedWith('今天真是好！真好！真好！真好！这一天天的', 'exclaim'));
check('问号 > 3 被拒', rejectedWith('怎么会这样？真的吗？不会吧？你说呢？我也是', 'question'));
check('同一字符连续重复 > 4 被拒', rejectedWith('啊啊啊啊啊啊啊，烦死了，一点都不想说话，就这样吧', 'repeat'));
check('空白 → empty', (() => {
  const reasons = reasonsOf('   \n\t ', [], 'qzone');
  return reasons.length === 1 && reasons[0] === 'empty';
})());
check('仅标点 → empty', (() => {
  const reasons = reasonsOf('！！！？？？……', [], 'qzone');
  return reasons.length === 1 && reasons[0] === 'empty';
})());
check('与最近一条完全相同 → duplicate（不再报 too_similar）', (() => {
  const reasons = reasonsOf(OK_QZONE, [OK_QZONE], 'qzone');
  return reasons.includes('duplicate') && !reasons.includes('too_similar');
})());
check('3-gram Jaccard ≥ 0.4 → too_similar', (() => {
  const similar = '今天走了很远的路，回来的时候天已经黑透了，忽然觉得有点累，但心里还算安静。';
  const reasons = reasonsOf(similar, [OK_QZONE], 'qzone');
  return reasons.length === 1 && reasons[0] === 'too_similar';
})());
check('只跟最近 5 条比：第 6 条更早的旧文案不再拦截', (() => {
  // 同一条放在第 1 位，后面 5 条都是新的 → 已经出了「最近 5 条」窗口，不再拦截
  const older = [OK_QZONE, '新的第一条', '新的第二条', '新的第三条', '新的第四条', '新的第五条'];
  return checkVentText(OK_QZONE, older, 'qzone').ok === true;
})());
check('说说太短（<15）被拒', rejectedWith('太短了', 'too_short'));
check('说说超长（>300）被拒', rejectedWith('这段时间一直在想很多事情，'.repeat(30), 'too_long'));
check('私聊太短（<5）被拒', rejectedWith('这样吧', 'too_short', [], 'private'));
check('私聊超长（>120）被拒', rejectedWith('今天在外面走了很久，'.repeat(13), 'too_long', [], 'private'));
check('日记太短（<100）被拒', rejectedWith('今天有点累，不太想说话，但还是想写点什么。', 'too_short', [], 'diary'));
check('opts.maxChars 更小则取小（54 字文本 + maxChars:50 → too_long）', (() => {
  const sixty = '这是一段用来测试说说字数上限的文字，'.repeat(3);
  const loose = checkVentText(sixty, [], 'qzone').ok === true;
  const strict = reasonsOf(sixty, [], 'qzone', { maxChars: 50 });
  return loose && strict.includes('too_long') && sixty.length > 50 && sixty.length <= 300;
})(), '默认通过、maxChars=50 被拒');

// ── ⑤ plan 数组 ────────────────────────────────────────────────────────────
console.log('\n⑤ plan（面板直接显示的中文判定行）');

check('成功时 plan 非空且包含被拒出口的原因', (() => {
  const joined = qzoneOff.plan.join('\n');
  return Array.isArray(qzoneOff.plan) && qzoneOff.plan.length > 0
    && joined.includes('qzone') && joined.includes('disabled_channel')
    && joined.includes('出口 private');
})());
check('失败时 plan 同样非空（why 一律可解释）', (() => {
  const joined = allDenied.plan.join('\n');
  return Array.isArray(allDenied.plan) && allDenied.plan.length > 0
    && joined.includes('all_denied');
})());
check('plan 每行都带 ✓ / ✗ 标记', (() => {
  return allDenied.plan.every((line) => line.startsWith('✓ ') || line.startsWith('✗ '));
})());
check('buildVentPlan 能把结构化记录排版成行、坏输入给空数组', (() => {
  const lines = buildVentPlan([
    { ok: false, step: '出口 qzone', text: '出口已关闭（disabled_channel）' },
    { ok: true, step: '出口 private', text: '可用，选中' },
    { bad: true }
  ]);
  return lines.length === 2
    && lines[0].startsWith('✗ ') && lines[0].includes('disabled_channel')
    && lines[1].startsWith('✓ ')
    && buildVentPlan(null).length === 0 && buildVentPlan('x').length === 0;
})());
check('降级链顺序常量固定为 qzone → private → diary',
  VENT_CHANNELS.length === 3 && VENT_CHANNELS[0] === 'qzone'
  && VENT_CHANNELS[1] === 'private' && VENT_CHANNELS[2] === 'diary');

// ── ⑥ 纯函数性 ─────────────────────────────────────────────────────────────
console.log('\n⑥ 纯函数性（不改入参）');

const pureState = stateWith({ lastVentTs: T0 - 10 * MINUTE });
const pureStateBefore = JSON.stringify(pureState);
const pureCaps = { qzone: true, private: true, diary: true, qzoneConfigured: true };
const pureCapsBefore = JSON.stringify(pureCaps);
const pureRecent = ['第一条旧文案', '第二条旧文案'];
const pureRecentBefore = JSON.stringify(pureRecent);
const pureCfgBefore = JSON.stringify(cfg);

planVent({
  state: pureState,
  cfg,
  now: T0,
  quiet: true,
  caps: pureCaps,
  recentTexts: pureRecent,
  lastVentTs: T0 - 10 * MINUTE
});
planVent({ state: stateWith(), cfg, now: T0, caps: pureCaps, recentTexts: pureRecent });

check('调用后 JSON.stringify(state) 不变', JSON.stringify(pureState) === pureStateBefore);
check('caps / recentTexts / cfg 也不被改写',
  JSON.stringify(pureCaps) === pureCapsBefore
  && JSON.stringify(pureRecent) === pureRecentBefore
  && JSON.stringify(cfg) === pureCfgBefore);
check('checkVentText 不改 recentTexts', (() => {
  const recent = [OK_QZONE];
  const before = JSON.stringify(recent);
  checkVentText(OK_QZONE, recent, 'qzone');
  return JSON.stringify(recent) === before;
})());
check('同一输入连算两次结果一致（无隐藏状态）', (() => {
  const first = planVent({ state: stateWith(), cfg, now: T0, caps: CAPS });
  const second = planVent({ state: stateWith(), cfg, now: T0, caps: CAPS });
  return JSON.stringify(first) === JSON.stringify(second);
})());

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
