// 情感状态机（src/affect-core.js）的单测。
//
// 跑法：`node scripts/test-affect-core.mjs`（全过 exit 0，有失败 exit 1）。
//
// 覆盖任务清单的 10 条，另加状态/序列化/总和上限/调度建议/抖动确定性等边界：
//   ① 配置归一化：空对象 / undefined / 坏值（threshold 5、halfLife 0）都被钳制
//   ② 累积软饱和：连续 3 次 anger step=1 confidence=1，第 3 次 < 1 且递增
//   ③ 重复抑制：5 分钟窗口内第 2 次增量约 0.6 倍（m_r 本身恰好 0.6），第 5 次起压到 0.15
//   ④ 半衰期：1.0 注入 30 分钟 → 0.5，60 分钟 → 0.25；sadness 180 分钟 → 0.5
//   ⑤ 剂量：静置 10 分钟 dose 增加 I·10
//   ⑥ canVent：阈值 / 剂量 / 冷却 / 最小间隔 / 日配额各返回正确 reason，且顺序固定
//   ⑦ applyVent：强度 0.4 倍、dose=0、cooldown 正确、lastVentTs 写入、ventLog 记账
//   ⑧ 纯函数性：所有导出函数调用后原对象 JSON.stringify 不变
//   ⑨ normalizeState 修复坏 state（强度 -1 / 5、dose NaN、events 200 条、坏 ventLog）
//   ⑩ parseState 坏 JSON → null
//   ⑪ 其它：createState / scoreOf / listCandidates 排序 / 跨维总和 2.5 / scheduleDelay / 抖动可复现
//
// 时间全部是常量假时钟（不读系统时钟、不碰 state/、不连网络）。
import {
  AFFECT_DEFAULTS,
  AFFECT_EMOTIONS,
  AFFECT_LIMITS,
  normalizeAffectConfig,
  createState,
  normalizeState,
  decayTo,
  addEvent,
  scoreOf,
  canVent,
  applyVent,
  listCandidates,
  serializeState,
  parseState,
  scheduleDelay
} from '../src/affect-core.js';

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

/** 浮点近似（默认容差 1e-9）。 */
function near(actual, expected, tolerance = 1e-9) {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

/** 假时钟：北京时间 2026-10-20 10:00（注入给纯函数，不依赖本机时区）。 */
const T0 = Date.parse('2026-10-20T10:00:00+08:00');
const MINUTE = 60 * 1000;

// ── ① 默认配置归一化 ───────────────────────────────────────────────────────
console.log('① normalizeAffectConfig');

const cfg = normalizeAffectConfig({});

check('空对象 → 四维出厂参数（§4 表格逐项）',
  cfg.emotions.anger.halfLifeMin === 30 && cfg.emotions.anger.sensitivity === 0.35
  && cfg.emotions.anger.threshold === 0.70 && cfg.emotions.anger.doseMin === 12 && cfg.emotions.anger.cooldownMin === 45
  && cfg.emotions.sadness.halfLifeMin === 180 && cfg.emotions.sadness.sensitivity === 0.20
  && cfg.emotions.sadness.threshold === 0.75 && cfg.emotions.sadness.doseMin === 30 && cfg.emotions.sadness.cooldownMin === 120
  && cfg.emotions.joy.halfLifeMin === 90 && cfg.emotions.joy.sensitivity === 0.30
  && cfg.emotions.joy.threshold === 0.85 && cfg.emotions.joy.doseMin === 20 && cfg.emotions.joy.cooldownMin === 60
  && cfg.emotions.boredom.halfLifeMin === 120 && cfg.emotions.boredom.sensitivity === 0.15
  && cfg.emotions.boredom.threshold === 0.80 && cfg.emotions.boredom.doseMin === 60 && cfg.emotions.boredom.cooldownMin === 180);

check('顶层默认：enabled 开 / 三出口开 + group 关 / 2h / 0.25 / 23:30–07:30 / 2-3-5',
  cfg.enabled === true
  && cfg.vents.qzone === true && cfg.vents.private === true && cfg.vents.diary === true && cfg.vents.group === false
  && cfg.minIntervalMs === 7200000 && cfg.jitterRatio === 0.25
  && cfg.quietHours.start === '23:30' && cfg.quietHours.end === '07:30'
  && cfg.dailyCap.qzone === 2 && cfg.dailyCap.private === 3 && cfg.dailyCap.diary === 5);

check('缺省 / 非对象输入不抛错',
  normalizeAffectConfig().emotions.anger.threshold === 0.70
  && normalizeAffectConfig(null).enabled === true
  && normalizeAffectConfig('x').dailyCap.qzone === 2
  && normalizeAffectConfig([]).minIntervalMs === 7200000
  && normalizeAffectConfig(42).emotions.joy.doseMin === 20);

const bad = normalizeAffectConfig({
  emotions: { anger: { threshold: 5, halfLifeMin: 0, sensitivity: 9, doseMin: 0, cooldownMin: -5 } },
  minIntervalMs: 1,
  jitterRatio: 9,
  dailyCap: { qzone: 99, private: -1 }
});

check('坏值钳制：threshold 5→0.99 / halfLife 0→1 / sensitivity 9→0.6 / doseMin 0→1 / cooldown -5→0',
  bad.emotions.anger.threshold === 0.99
  && bad.emotions.anger.halfLifeMin === 1
  && bad.emotions.anger.sensitivity === 0.6
  && bad.emotions.anger.doseMin === 1
  && bad.emotions.anger.cooldownMin === 0);

check('坏值钳制：minIntervalMs 1→600000 / jitterRatio 9→0.5 / dailyCap 99→10、-1→0',
  bad.minIntervalMs === 600000 && bad.jitterRatio === 0.5
  && bad.dailyCap.qzone === 10 && bad.dailyCap.private === 0);

check('上限也钳：halfLife 99999→1440 / sensitivity 0.01→0.05 / threshold 0.1→0.3',
  normalizeAffectConfig({ emotions: { anger: { halfLifeMin: 99999, sensitivity: 0.01, threshold: 0.1 } } })
    .emotions.anger.halfLifeMin === 1440
  && normalizeAffectConfig({ emotions: { anger: { sensitivity: 0.01 } } }).emotions.anger.sensitivity === 0.05
  && normalizeAffectConfig({ emotions: { anger: { threshold: 0.1 } } }).emotions.anger.threshold === 0.3);

check('坏类型回落默认值：\'x\' / NaN / {} 都不抛',
  normalizeAffectConfig({ emotions: { anger: { threshold: 'x', halfLifeMin: Number.NaN } } }).emotions.anger.threshold === 0.70
  && normalizeAffectConfig({ emotions: { anger: {} } }).emotions.anger.halfLifeMin === 30
  && normalizeAffectConfig({ emotions: 'nope', vents: 'nope', quietHours: null }).vents.qzone === true);

check('数字字符串被接受（手写 config.json 常见）：\'45\' → 45、\'0.8\' → 0.8',
  normalizeAffectConfig({ emotions: { anger: { cooldownMin: '45', threshold: '0.8' } } }).emotions.anger.cooldownMin === 45
  && normalizeAffectConfig({ emotions: { anger: { threshold: '0.8' } } }).emotions.anger.threshold === 0.8);

check('enabled 只有显式 false 才关（出厂就是要开）',
  normalizeAffectConfig({ enabled: false }).enabled === false
  && normalizeAffectConfig({ enabled: 'false' }).enabled === true
  && normalizeAffectConfig({ enabled: 0 }).enabled === true);

check('vents 非布尔回落各自的默认值',
  normalizeAffectConfig({ vents: { qzone: false, group: true } }).vents.qzone === false
  && normalizeAffectConfig({ vents: { qzone: false, group: true } }).vents.group === true
  && normalizeAffectConfig({ vents: { qzone: 'false' } }).vents.qzone === true);

check('quietHours 坏值回落默认：25:00 / 7:3 / 数字',
  normalizeAffectConfig({ quietHours: { start: '25:00' } }).quietHours.start === '23:30'
  && normalizeAffectConfig({ quietHours: { end: '7:30' } }).quietHours.end === '07:30'
  && normalizeAffectConfig({ quietHours: { start: 2330 } }).quietHours.start === '23:30');

check('合法 quietHours 保留：00:00 / 07:05',
  normalizeAffectConfig({ quietHours: { start: '00:00', end: '07:05' } }).quietHours.start === '00:00'
  && normalizeAffectConfig({ quietHours: { start: '00:00', end: '07:05' } }).quietHours.end === '07:05');

check('常量被冻结（默认值不该被运行期改坏）',
  Object.isFrozen(AFFECT_DEFAULTS) && Object.isFrozen(AFFECT_DEFAULTS.emotions.anger)
  && Object.isFrozen(AFFECT_DEFAULTS.vents) && Object.isFrozen(AFFECT_DEFAULTS.dailyCap)
  && Object.isFrozen(AFFECT_EMOTIONS) && Object.isFrozen(AFFECT_LIMITS.minIntervalMs)
  && AFFECT_LIMITS.minIntervalMs.min === 600000 && AFFECT_LIMITS.minIntervalMs.max === 86400000);

check('归一化结果冻结、且幂等',
  Object.isFrozen(cfg) && Object.isFrozen(cfg.emotions.anger)
  && JSON.stringify(normalizeAffectConfig(cfg)) === JSON.stringify(cfg));

check('不改入参（raw / raw.emotions.anger / raw.dailyCap 都不被写）',
  (() => {
    const raw = { enabled: 'no', emotions: { anger: { threshold: 5 } }, dailyCap: { qzone: 99 } };
    normalizeAffectConfig(raw);
    return raw.enabled === 'no' && raw.emotions.anger.threshold === 5 && raw.dailyCap.qzone === 99;
  })());

// ── ② 累积软饱和 ───────────────────────────────────────────────────────────
console.log('\n② addEvent 软饱和');

const seeded = createState(T0, cfg);
check('createState 形状：version 1 / 四维基线 / 空数组 / lastVentTs 0',
  seeded.version === 1 && seeded.emotions.anger.intensity === 0.02
  && seeded.emotions.anger.baseline === 0.02 && seeded.emotions.joy.intensity === 0.05
  && seeded.emotions.boredom.intensity === 0.10 && seeded.events.length === 0
  && seeded.ventLog.length === 0 && seeded.lastVentTs === 0 && Array.isArray(seeded.deferred));

/** 记一次 anger 事件；config 可换（③ 要用低敏感度才看得清 m_r 台阶）。 */
const hitWith = (config) => (state, now, event = {}) => addEvent(state, {
  kind: 'anger', step: 1, confidence: 1, causeSummary: '被骂了', ...event
}, config, now);
const hit = hitWith(cfg);

const e1 = hit(seeded, T0);
const e2 = hit(e1, T0 + MINUTE);
const e3 = hit(e2, T0 + 2 * MINUTE);
const i1 = e1.emotions.anger.intensity;
const i2 = e2.emotions.anger.intensity;
const i3 = e3.emotions.anger.intensity;

check('连续 3 次 anger step=1 conf=1：强度递增且始终 < 1',
  i1 > 0.02 && i2 > i1 && i3 > i2 && i3 < 1,
  `I1=${i1.toFixed(4)} I2=${i2.toFixed(4)} I3=${i3.toFixed(4)}`);

check('第 1 次增量 = k·(1-基线) = 0.35×0.98（研究 §2 累积行）', near(i1 - 0.02, 0.343, 1e-9), String(i1));

check('软饱和：越接近 1 加得越少（第 3 次增量 < 第 1 次）',
  (i3 - i2) < (i1 - 0.02));

check('事件写进 events：id / ts / 情绪 / 档位 / 置信度 / 一句话原因',
  e3.events.length === 3
  && typeof e3.events[0].id === 'string' && e3.events[0].id.startsWith('evt-')
  && e3.events[0].ts === T0 && e3.events[0].kind === 'anger'
  && e3.events[0].step === 1 && e3.events[0].confidence === 1
  && e3.events[2].causeSummary === '被骂了');

check('step 越界钳到 0–1、confidence 缺省 0.7',
  hit(seeded, T0, { step: 9, confidence: 7 }).events[0].step === 1
  && hit(seeded, T0, { step: 9, confidence: 7 }).events[0].confidence === 1
  && hit(seeded, T0, { confidence: undefined }).events[0].confidence === 0.7
  && hit(seeded, T0, { step: -3 }).events[0].step === 0);

check('未知 kind 不计分、不排事件（返回修复后的 state）',
  (() => {
    const weird = addEvent(seeded, { kind: 'fear', step: 1 }, cfg, T0);
    return weird.emotions.anger.intensity === 0.02 && weird.events.length === 0;
  })());

check('causeSummary 去控制字符、截到 60 字',
  (() => {
    const long = `a\u0001b${'x'.repeat(80)}`;
    const record = hit(seeded, T0, { causeSummary: long }).events[0];
    return record.causeSummary.length === 60 && !record.causeSummary.includes('\u0001');
  })());

// ── ③ 重复抑制 ─────────────────────────────────────────────────────────────
console.log('\n③ 重复抑制 0.6^(n-1)');

// 敏感度取最小值 0.05，让「软饱和」对增量的压缩尽量小，才看得清 0.6 的台阶。
const cfgLow = normalizeAffectConfig({ emotions: { anger: { sensitivity: 0.05 } } });
const hitLow = hitWith(cfgLow);
const lowSeed = createState(T0, cfgLow);
const before2 = hitLow(lowSeed, T0, {});
const after2 = hitLow(before2, T0, { causeSummary: '第二次' });
const inc1 = before2.emotions.anger.intensity - lowSeed.emotions.anger.intensity;
const inc2 = after2.emotions.anger.intensity - before2.emotions.anger.intensity;
const m1 = inc1 / ((1 - lowSeed.emotions.anger.intensity) * 0.05 * 1 * 1);
const m2 = inc2 / ((1 - before2.emotions.anger.intensity) * 0.05 * 1 * 1);

check('5 分钟内第 2 次增量 < 第 1 次（比值 ≈0.6，软饱和再折一点）',
  inc2 < inc1 && inc2 / inc1 > 0.5 && inc2 / inc1 < 0.62,
  `增量比 ${(inc2 / inc1).toFixed(4)}`);

check('m_r 本身恰好 0.6：1.0 → 0.6（软饱和是分母 (1-I) 造成的偏差）',
  near(m1, 1, 1e-9) && near(m2, 0.6, 1e-9),
  `m1=${m1.toFixed(6)} m2=${m2.toFixed(6)}`);

check('m_r 序列：1 / 0.6 / 0.36 / 0.216 / 0.15（第 5 次起压到地板）', (() => {
  const expected = [1, 0.6, 0.36, 0.216, 0.15, 0.15];
  let state = lowSeed;
  for (let i = 0; i < expected.length; i += 1) {
    const before = state.emotions.anger.intensity;
    const next = hitLow(state, T0, { causeSummary: `第${i}次` });
    const inc = next.emotions.anger.intensity - before;
    const m = inc / ((1 - before) * 0.05);
    if (!near(m, expected[i], 1e-9)) return false;
    state = next;
  }
  return true;
})());

check('超出 5 分钟窗口后重复抑制恢复（第 2 次又是满档）', (() => {
  const first = hitLow(lowSeed, T0, {});
  const later = hitLow(first, T0 + 6 * MINUTE, {});
  // 衰减会让 (1-I) 变大，所以只断言 m_r 回到 1
  const before = decayTo(first.emotions.anger, T0 + 6 * MINUTE, cfgLow, 'anger').intensity;
  const inc = later.emotions.anger.intensity - before;
  return near(inc / ((1 - before) * 0.05), 1, 1e-9);
})());

// ── ④ 半衰期 ───────────────────────────────────────────────────────────────
console.log('\n④ 半衰期衰减 2^(-Δt/T½)');

const full = normalizeState({ emotions: { anger: { intensity: 1, dose: 0, lastTs: T0, peak: 1 } } }, T0, cfg);
const half = decayTo(full.emotions.anger, T0 + 30 * MINUTE, cfg, 'anger');
const quarter = decayTo(full.emotions.anger, T0 + 60 * MINUTE, cfg, 'anger');

check('注入到 1.0 后 30 分钟 anger ≈ 0.5（±0.02）', Math.abs(half.intensity - 0.5) <= 0.02, String(half.intensity));
check('60 分钟 anger ≈ 0.25（±0.02）', Math.abs(quarter.intensity - 0.25) <= 0.02, String(quarter.intensity));
check('sadness 半衰期 180 分钟：180 分钟后 ≈ 0.5',
  Math.abs(decayTo(normalizeState({ emotions: { sadness: { intensity: 1, lastTs: T0 } } }, T0, cfg)
    .emotions.sadness, T0 + 180 * MINUTE, cfg, 'sadness').intensity - 0.5) <= 0.02);
check('joy 半衰期 90 分钟：90 分钟后 ≈ 0.5',
  Math.abs(decayTo(normalizeState({ emotions: { joy: { intensity: 1, lastTs: T0 } } }, T0, cfg)
    .emotions.joy, T0 + 90 * MINUTE, cfg, 'joy').intensity - 0.5) <= 0.02);
check('boredom 半衰期 120 分钟：120 分钟后 ≈ 0.5',
  Math.abs(decayTo(normalizeState({ emotions: { boredom: { intensity: 1, lastTs: T0 } } }, T0, cfg)
    .emotions.boredom, T0 + 120 * MINUTE, cfg, 'boredom').intensity - 0.5) <= 0.02);

check('Δt ≤ 0 返回原值（强度与 lastTs 都不动）', (() => {
  const same = decayTo(full.emotions.anger, T0, cfg, 'anger');
  const past = decayTo(full.emotions.anger, T0 - 5 * MINUTE, cfg, 'anger');
  return same.intensity === 1 && same.lastTs === T0 && past.intensity === 1 && past.lastTs === T0;
})());

check('衰减不改 peak（历史最高只增不减）', half.peak === 1);

check('事件累积出来的状态，30 分钟后正好剩一半（比例与初值无关）', (() => {
  const built = hit(hit(seeded, T0), T0);
  const start = built.emotions.anger.intensity;
  const decayed = decayTo(built.emotions.anger, T0 + 30 * MINUTE, cfg, 'anger');
  return near(decayed.intensity / start, 0.5, 1e-9);
})());

// ── ⑤ 剂量 ─────────────────────────────────────────────────────────────────
console.log('\n⑤ 剂量 dose（强度·分钟）');

const doseState = normalizeState({ emotions: { anger: { intensity: 0.5, dose: 0, lastTs: T0 } } }, T0, cfg);
const dosed = decayTo(doseState.emotions.anger, T0 + 10 * MINUTE, cfg, 'anger');

check('静置 10 分钟 dose +I·10（0.5×10 = 5）', near(dosed.dose, 5, 1e-9), String(dosed.dose));
check('同时强度按半衰期掉：0.5×2^(-1/3) ≈ 0.39685',
  near(dosed.intensity, 0.5 * 2 ** (-1 / 3), 1e-9), String(dosed.intensity));
check('剂量本身也半衰：dose 10、I 0 → 30 分钟后 5', (() => {
  const zero = normalizeState({ emotions: { anger: { intensity: 0, dose: 10, lastTs: T0 } } }, T0, cfg);
  return near(decayTo(zero.emotions.anger, T0 + 30 * MINUTE, cfg, 'anger').dose, 5, 1e-9);
})());
check('dose 不为负（坏 lastTs 也不会算出负剂量）', decayTo({ intensity: 1, dose: 3, lastTs: T0 + 5 * MINUTE }, T0, cfg, 'anger').dose === 3);

// ── ⑥ canVent 判定 ─────────────────────────────────────────────────────────
console.log('\n⑥ canVent 闸门与顺序');

const NOW = T0;
function stateWith(over = {}) {
  return normalizeState({
    emotions: {
      anger: {
        intensity: over.intensity ?? 0.8,
        dose: over.dose ?? 20,
        cooldownUntil: over.cooldownUntil ?? 0,
        lastTs: over.lastTs ?? NOW,
        peak: over.intensity ?? 0.8
      }
    },
    ventLog: over.ventLog ?? [],
    lastVentTs: over.lastVentTs ?? 0
  }, NOW, cfg);
}

const verdictOk = canVent(stateWith(), 'anger', cfg, NOW);
check('四条件全满足 → {ok:true}', verdictOk.ok === true && verdictOk.reason === undefined);

check('enabled=false → disabled',
  canVent(stateWith(), 'anger', normalizeAffectConfig({ enabled: false }), NOW).reason === 'disabled');

check('强度低于阈值 → below_threshold（0.5 < 0.70）', (() => {
  const r = canVent(stateWith({ intensity: 0.5 }), 'anger', cfg, NOW);
  return r.ok === false && r.reason === 'below_threshold';
})());

check('剂量不足 → below_dose（0 < 12，且等待估算 = (12/0.8) 分钟）', (() => {
  const r = canVent(stateWith({ dose: 0 }), 'anger', cfg, NOW);
  return r.ok === false && r.reason === 'below_dose' && r.retryAfterMs === 15 * MINUTE;
})());

check('冷却中 → cooldown + retryAfterMs 是剩余时间', (() => {
  const r = canVent(stateWith({ cooldownUntil: NOW + 10 * MINUTE }), 'anger', cfg, NOW);
  return r.ok === false && r.reason === 'cooldown' && r.retryAfterMs === 10 * MINUTE;
})());

check('最小间隔没到 → min_interval + 剩余时间在 [1-r, 1+r] 区间内', (() => {
  const r = canVent(stateWith({ lastVentTs: NOW - 10 * MINUTE }), 'anger', cfg, NOW);
  return r.ok === false && r.reason === 'min_interval'
    && r.retryAfterMs >= 4.8e6 && r.retryAfterMs <= 8.4e6;
})());

check('日配额用完 → daily_cap（10 条 = 2+3+5）', (() => {
  const log = [];
  for (let i = 0; i < 10; i += 1) {
    log.push({ id: `v${i}`, ts: NOW - i * 1000, channel: 'qzone', emotion: 'anger', ok: true });
  }
  const r = canVent(stateWith({ ventLog: log }), 'anger', cfg, NOW);
  return r.ok === false && r.reason === 'daily_cap' && r.retryAfterMs > 0;
})());

check('日配额只数 24h 内的：9 条成功不触发 daily_cap（此时拦它的是最小间隔）', (() => {
  const log = [];
  for (let i = 0; i < 9; i += 1) log.push({ ts: NOW - i * 1000, channel: 'private', emotion: 'joy', ok: true });
  return canVent(stateWith({ ventLog: log }), 'anger', cfg, NOW).reason === 'min_interval';
})());

check('日配额不数 24h 前的旧账', (() => {
  const log = [];
  for (let i = 0; i < 10; i += 1) log.push({ ts: NOW - 25 * 60 * MINUTE - i * 1000, channel: 'qzone', ok: true });
  return canVent(stateWith({ ventLog: log }), 'anger', cfg, NOW).ok === true;
})());

check('失败记录（ok:false）不占日配额', (() => {
  const log = [];
  for (let i = 0; i < 10; i += 1) log.push({ ts: NOW - i * 1000, channel: 'qzone', ok: false });
  return canVent(stateWith({ ventLog: log }), 'anger', cfg, NOW).ok === true;
})());

check('关掉的出口不贡献配额：只开 diary（5 条）时 5 条就满', (() => {
  const closed = normalizeAffectConfig({ vents: { qzone: false, private: false, diary: true } });
  const log = [];
  for (let i = 0; i < 5; i += 1) log.push({ ts: NOW - i * 1000, channel: 'diary', ok: true });
  return canVent(stateWith({ ventLog: log }), 'anger', closed, NOW).reason === 'daily_cap';
})());

check('顺序：disabled 先于强度', (() => {
  const r = canVent(stateWith({ intensity: 0 }), 'anger', normalizeAffectConfig({ enabled: false }), NOW);
  return r.reason === 'disabled';
})());

check('顺序：强度先于剂量（强度不够 + 剂量也不够 → below_threshold）', (() => {
  const r = canVent(stateWith({ intensity: 0.5, dose: 0 }), 'anger', cfg, NOW);
  return r.reason === 'below_threshold';
})());

check('顺序：剂量先于冷却（dose 0 + 冷却中 → below_dose）', (() => {
  const r = canVent(stateWith({ dose: 0, cooldownUntil: NOW + 10 * MINUTE }), 'anger', cfg, NOW);
  return r.reason === 'below_dose';
})());

check('顺序：冷却先于日配额（冷却中 + 配额满 → cooldown）', (() => {
  const log = [];
  for (let i = 0; i < 10; i += 1) log.push({ ts: NOW - i * 1000, ok: true });
  const r = canVent(stateWith({ cooldownUntil: NOW + 10 * MINUTE, ventLog: log }), 'anger', cfg, NOW);
  return r.reason === 'cooldown';
})());

check('空状态 → below_threshold（没人惹它就不该说话）',
  canVent(createState(T0, cfg), 'anger', cfg, NOW).reason === 'below_threshold');

check('非白名单情绪 key → below_threshold（不抛）',
  canVent(stateWith(), 'fear', cfg, NOW).reason === 'below_threshold');

// ── ⑦ applyVent ────────────────────────────────────────────────────────────
console.log('\n⑦ applyVent 回落 / 冷却 / 记账');

const preVent = stateWith({ intensity: 0.8, dose: 20 });
const vented = applyVent(preVent, 'anger', cfg, NOW, 'vent-abc');

check('强度回落到 0.4 倍：0.8 → 0.32', near(vented.emotions.anger.intensity, 0.32, 1e-9),
  String(vented.emotions.anger.intensity));
check('dose 归零', vented.emotions.anger.dose === 0);
check('cooldownUntil = now + 45 分钟', vented.emotions.anger.cooldownUntil === NOW + 45 * MINUTE);
check('lastVentTs 写入 now', vented.lastVentTs === NOW);
check('ventLog 追加一条：id / ts / 情绪（channel/ok 留给调用方补）', (() => {
  const entry = vented.ventLog[vented.ventLog.length - 1];
  return vented.ventLog.length === 1 && entry.id === 'vent-abc' && entry.ts === NOW
    && entry.emotion === 'anger' && entry.ok === false && entry.channel === '';
})());
check('宣泄完立刻 canVent → below_threshold（判定顺序：强度先于冷却，0.32 < 0.70）',
  canVent(vented, 'anger', cfg, NOW).reason === 'below_threshold');
check('强度手动拉回 0.9 后立刻 canVent → cooldown（45 分钟冷却真的挡住）', (() => {
  const hot = {
    ...vented,
    emotions: { ...vented.emotions, anger: { ...vented.emotions.anger, intensity: 0.9, dose: 20 } }
  };
  return canVent(hot, 'anger', cfg, NOW).reason === 'cooldown';
})());
check('45 分钟后、剂量也够了才可能重新通过', (() => {
  const later = normalizeState({ ...vented, lastVentTs: 0, events: [] }, NOW + 46 * MINUTE, cfg);
  // 剂量在这个时间点还不够（0 → 46 分钟 × 约 0.3 ≈ 14，够 12），强度已衰减到 0.32 → 阈值挡住
  return canVent(later, 'anger', cfg, NOW + 46 * MINUTE).reason === 'below_threshold';
})());
check('强度很低时回落到 baseline 而不是 0', (() => {
  const low = applyVent(stateWith({ intensity: 0.03, dose: 20 }), 'anger', cfg, NOW, 'v-low');
  return low.emotions.anger.intensity === 0.02;
})());
check('ventLog 只留最近 50 条', (() => {
  let state = stateWith();
  for (let i = 0; i < 60; i += 1) state = applyVent(state, 'anger', cfg, NOW, `v${i}`);
  return state.ventLog.length === 50 && state.ventLog[49].id === 'v59';
})());

// ── ⑧ 纯函数性 ─────────────────────────────────────────────────────────────
console.log('\n⑧ 纯函数：调用后原对象不变');

check('addEvent / applyVent / canVent / listCandidates / scoreOf / scheduleDelay / normalizeState 都不改入参', (() => {
  const original = stateWith({ intensity: 0.9, dose: 30, lastVentTs: NOW - 3 * 60 * MINUTE });
  const snapshot = JSON.stringify(original);
  const stateSnapshot = JSON.stringify(createState(T0, cfg));
  addEvent(original, { kind: 'anger', step: 1, confidence: 1 }, cfg, NOW);
  applyVent(original, 'anger', cfg, NOW, 'v');
  canVent(original, 'anger', cfg, NOW);
  listCandidates(original, cfg, NOW);
  scoreOf(original, cfg);
  scheduleDelay(original, cfg, NOW);
  normalizeState(original, NOW, cfg);
  serializeState(original);
  return JSON.stringify(original) === snapshot && JSON.stringify(createState(T0, cfg)) === stateSnapshot;
})());

check('decayTo 不改入参（emotion 原样）', (() => {
  const emotion = { intensity: 0.8, baseline: 0.02, dose: 5, cooldownUntil: 0, lastTs: T0, peak: 0.9 };
  const snapshot = JSON.stringify(emotion);
  decayTo(emotion, T0 + 30 * MINUTE, cfg, 'anger');
  return JSON.stringify(emotion) === snapshot;
})());

check('canVent 不改配置对象', (() => {
  const snapshot = JSON.stringify(cfg);
  canVent(stateWith(), 'anger', cfg, NOW);
  return JSON.stringify(cfg) === snapshot;
})());

// ── ⑨ normalizeState 修复 ──────────────────────────────────────────────────
console.log('\n⑨ normalizeState 修复坏 state');

const brokenEvents = [];
for (let i = 0; i < 200; i += 1) {
  brokenEvents.push({ ts: T0 - i * 1000, kind: i % 7 === 0 ? 'fear' : 'anger', step: 9, confidence: -1 });
}
const repaired = normalizeState({
  version: 'x',
  emotions: {
    anger: { intensity: -1, dose: Number.NaN, lastTs: 'oops', cooldownUntil: -5 },
    sadness: { intensity: 5 },
    joy: {},
    boredom: 'nope'
  },
  events: brokenEvents,
  ventLog: 'nope',
  lastVentTs: -5,
  deferred: 'nope'
}, T0, cfg);

check('强度钳制：-1 → 0、5 → 1、缺失 → 基线（joy 0.05）',
  repaired.emotions.anger.intensity === 0 && repaired.emotions.sadness.intensity === 1
  && repaired.emotions.joy.intensity === 0.05);
check('dose NaN → 0、cooldownUntil -5 → 0、坏 lastTs → now',
  repaired.emotions.anger.dose === 0 && repaired.emotions.anger.cooldownUntil === 0
  && repaired.emotions.anger.lastTs === T0);
check('events 200 条 → 只留最近 50 条', repaired.events.length === 50);
check('events 里的坏 kind 被丢弃、step/confidence 钳到 0–1',
  repaired.events.every((item) => AFFECT_EMOTIONS.includes(item.kind))
  && repaired.events.every((item) => item.step >= 0 && item.step <= 1)
  && repaired.events.every((item) => item.confidence >= 0 && item.confidence <= 1));
check('version 坏值/缺省 → 1', repaired.version === 1
  && normalizeState({}, T0, cfg).version === 1
  && normalizeState({ version: 2 }, T0, cfg).version === 2);
check('坏 ventLog → []、lastVentTs -5 → 0、坏 deferred → []',
  repaired.ventLog.length === 0 && repaired.lastVentTs === 0 && repaired.deferred.length === 0);
check('四维齐全（缺少的维度用基线补齐）',
  AFFECT_EMOTIONS.every((key) => repaired.emotions[key] && Number.isFinite(repaired.emotions[key].intensity)));
check('null / undefined / 字符串 state 都能救',
  normalizeState(null, T0, cfg).emotions.anger.intensity === 0.02
  && normalizeState(undefined, T0, cfg).events.length === 0
  && normalizeState('nope', T0, cfg).ventLog.length === 0);
check('peak 不会小于强度', (() => {
  const state = normalizeState({ emotions: { anger: { intensity: 0.7, peak: 0.2 } } }, T0, cfg);
  return state.emotions.anger.peak === 0.7;
})());

// ── ⑩ parseState / serializeState ──────────────────────────────────────────
console.log('\n⑩ serializeState / parseState');

check('parseState 坏 JSON → null', parseState('{not json') === null && parseState('') === null
  && parseState(null) === null && parseState(undefined) === null && parseState('   ') === null);
check('parseState 非对象 JSON → null', parseState('[]') === null && parseState('null') === null
  && parseState('"x"') === null && parseState('42') === null);
check('parseState 好 JSON → 对象', (() => {
  const parsed = parseState('{"version":1}');
  return parsed !== null && parsed.version === 1;
})());
check('serialize → parse 往返一致（状态与宣泄记录都保住）', (() => {
  const state = applyVent(stateWith({ intensity: 0.9, dose: 30 }), 'anger', cfg, NOW, 'v-round');
  const text = serializeState(state);
  const back = normalizeState(parseState(text), NOW, cfg);
  return JSON.stringify(back) === JSON.stringify(state);
})());
check('serializeState 把 NaN/Infinity 写成 0（JSON 里不出现 null 强度）', (() => {
  const dirty = { ...createState(T0, cfg) };
  dirty.emotions.anger.intensity = Number.NaN;
  dirty.emotions.anger.dose = Number.POSITIVE_INFINITY;
  const text = serializeState(dirty);
  const parsed = JSON.parse(text);
  return parsed.emotions.anger.intensity === 0 && parsed.emotions.anger.dose === 0;
})());

// ── ⑪ 其它：主导维 / 候选 / 总和上限 / 调度 / 抖动 ─────────────────────────
console.log('\n⑪ scoreOf / listCandidates / 总和上限 / scheduleDelay');

check('scoreOf 取最强一维', (() => {
  const score = scoreOf(normalizeState({
    emotions: { anger: { intensity: 0.9, dose: 14 }, joy: { intensity: 0.5, dose: 3 } }
  }, T0, cfg), cfg);
  return score.dominant === 'anger' && near(score.intensity, 0.9, 1e-9) && score.dose === 14;
})());
check('scoreOf 全零 → anger / 0（不返回 undefined）', (() => {
  const zeros = { anger: { intensity: 0 }, sadness: { intensity: 0 }, joy: { intensity: 0 }, boredom: { intensity: 0 } };
  const score = scoreOf(normalizeState({ emotions: zeros }, T0, cfg), cfg);
  return score.dominant === 'anger' && score.intensity === 0;
})());

check('listCandidates 按 (I-T)/T 降序：anger > sadness > joy', (() => {
  const state = normalizeState({
    emotions: {
      anger: { intensity: 0.9 }, sadness: { intensity: 0.8 }, joy: { intensity: 0.9 }
    }
  }, T0, cfg);
  return JSON.stringify(listCandidates(state, cfg, T0)) === JSON.stringify(['anger', 'sadness', 'joy']);
})());
check('listCandidates 没有过阈值 → []', (() => {
  const state = normalizeState({ emotions: { anger: { intensity: 0.69 }, joy: { intensity: 0.84 } } }, T0, cfg);
  return listCandidates(state, cfg, T0).length === 0;
})());

check('跨维总和超 2.5 时缩放其它维、保持主导维', (() => {
  const crowded = normalizeState({
    emotions: {
      anger: { intensity: 0.6 }, sadness: { intensity: 0.9 },
      joy: { intensity: 0.95 }, boredom: { intensity: 0.9 }
    }
  }, T0, cfg);
  const capped = addEvent(crowded, { kind: 'anger', step: 0.75, confidence: 1 }, cfg, T0);
  const total = AFFECT_EMOTIONS.reduce((sum, key) => sum + capped.emotions[key].intensity, 0);
  return total <= 2.5 + 1e-9 && capped.emotions.joy.intensity === 0.95
    && capped.emotions.anger.intensity < 0.705;
})(), '总和 ≤ 2.5');

check('scheduleDelay：没有候选 → 10 分钟',
  scheduleDelay(createState(T0, cfg), cfg, T0) === 10 * MINUTE);
check('scheduleDelay：有候选且能发 → 60 秒',
  scheduleDelay(stateWith({ intensity: 0.9, dose: 30 }), cfg, T0) === 60 * 1000);
check('scheduleDelay：冷却中 → 返回剩余时间',
  scheduleDelay(stateWith({ intensity: 0.9, dose: 30, cooldownUntil: T0 + 10 * MINUTE }), cfg, T0) === 10 * MINUTE);
check('scheduleDelay：最小间隔没到 → 返回剩余间隔（不是 0）', (() => {
  const delay = scheduleDelay(stateWith({ intensity: 0.9, dose: 30, lastVentTs: T0 - 10 * MINUTE }), cfg, T0);
  return delay >= 4.8e6 && delay <= 8.4e6;
})());

check('抖动可复现：同一状态连续两次 canVent 的 retryAfterMs 完全一致', (() => {
  const state = stateWith({ intensity: 0.9, dose: 30, lastVentTs: T0 - 10 * MINUTE });
  return canVent(state, 'anger', cfg, T0).retryAfterMs === canVent(state, 'anger', cfg, T0).retryAfterMs;
})());
check('抖动在 ±25% 内：不同 lastVentTs 的间隔都落在 [1.5h, 2.5h]', (() => {
  for (let i = 1; i <= 20; i += 1) {
    const start = NOW - (10 + i) * MINUTE;
    const lastVentTs = start;
    const retry = canVent(stateWith({ intensity: 0.9, dose: 30, lastVentTs }), 'anger', cfg, start + 10 * MINUTE).retryAfterMs;
    const total = retry + 10 * MINUTE;
    if (total < 90 * MINUTE || total > 150 * MINUTE) return false;
  }
  return true;
})());

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
