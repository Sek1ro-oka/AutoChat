// 情感状态机（四维情绪 / 衰减 / 累积 / 剂量 / 宣泄判定）的纯逻辑模块。
//
// 口径来自 work/agent-tasks/T-012/dev-doc.md（§2 数据结构、§3 纯函数 API、§4 配置）
// 与 work/agent-tasks/T-012/research.md（§2 数学模型、§4 防滥发闸门、§5 已知坑）。
//
// 三条硬约束：
//   1. **纯函数**：不碰 IO，也不读系统时钟 —— 时间一律由调用方传 `now`（毫秒）。
//      单测因此能把「等 30 分钟」压成一次函数调用；桥接侧也能用假时钟复盘某一天。
//      本文件连 import 都没有（不需要 fs / path），`node --check` 就能过。
//   2. **不改入参**：每个导出函数都返回新对象。桥接那边写成
//      `affectState = addEvent(affectState, …)` 就够了，不用怕某个分支漏了赋值。
//   3. **判定集中在 `canVent`**：bridge 只调它，不自己写「强度够不够」的 if（dev-doc §3 规则）。
//      「哪个出口开着、这个出口今天还剩几条」属于上层 affect-vent.js；
//      本模块只做「情绪本身够不够、今天还能不能发」的粗判（日配额按全通道总量算）。
//
// 单位约定：时间参数一律毫秒；`halfLifeMin` / `cooldownMin` / `doseMin` 是分钟；
// `dose` 的单位是「强度·分钟」（research §2 剂量行）。

// ── 常量与出厂配置（dev-doc §4 / research §2.1） ────────────────────────────

/** 四个情绪维度，顺序固定：面板、候选排序、主导维平局都按它来。 */
export const AFFECT_EMOTIONS = Object.freeze(['anger', 'sadness', 'joy', 'boredom']);

/** 有日配额的出口（dev-doc §4 的 dailyCap 只有这三个，group 没有配额字段）。 */
const AFFECT_CAPPED_CHANNELS = Object.freeze(['qzone', 'private', 'diary']);

/** vents 里的全部出口（group 默认关，见 dev-doc §4）。 */
const AFFECT_VENT_CHANNELS = Object.freeze(['qzone', 'private', 'diary', 'group']);

// 出厂基线（dev-doc §2.1 的 baseline）：新建状态的初始强度，也是宣泄回落的地板。
// 「回落而非清零，留一点余温」—— research §2 的宣泄后那行。
const AFFECT_BASELINE = Object.freeze({ anger: 0.02, sadness: 0.02, joy: 0.05, boredom: 0.10 });

// 日配额与紧急度都按「最近 24 小时滑动窗口」算，而不是自然日：
// 这样纯函数不需要时区知识（自然日要 Asia/Shanghai，那是 bridge / 控制台的事）。
const VENT_WINDOW_MS = 24 * 60 * 60 * 1000;
// 剂量增速估计的下限，防止 intensity≈0 时算出 Infinity。
const DOSE_RATE_FLOOR = 1e-6;
// 单维重复抑制的窗口（research §2 重复抑制行：同一类事件 5 分钟内第 n 次）。
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
// 四维强度总和的硬上限（research §2 全局约束行）。
const TOTAL_INTENSITY_CAP = 2.5;

/** 配置各项的合法区间（dev-doc §4 / 本任务约束）：超界钳制，坏值回落默认。 */
export const AFFECT_LIMITS = Object.freeze({
  halfLifeMin: Object.freeze({ min: 1, max: 1440 }),
  sensitivity: Object.freeze({ min: 0.05, max: 0.6 }),
  threshold: Object.freeze({ min: 0.3, max: 0.99 }),
  doseMin: Object.freeze({ min: 1, max: 240 }),
  cooldownMin: Object.freeze({ min: 0, max: 1440 }),
  dailyCap: Object.freeze({ min: 0, max: 10 }),
  minIntervalMs: Object.freeze({ min: 600000, max: 86400000 }),
  jitterRatio: Object.freeze({ min: 0, max: 0.5 })
});

/**
 * 出厂默认配置（dev-doc §4 逐字段；参数来自 research §2.1 的四维表）。
 *
 * `enabled: true` 是用户明确要的（clarify 里「出厂就开」），其余保守：
 * 三个出口开、群聊关，最小间隔 2 小时 ± 25%，深夜静默。
 */
export const AFFECT_DEFAULTS = Object.freeze({
  enabled: true,
  vents: Object.freeze({ qzone: true, private: true, diary: true, group: false }),
  minIntervalMs: 7200000,
  jitterRatio: 0.25,
  quietHours: Object.freeze({ start: '23:30', end: '07:30' }),
  dailyCap: Object.freeze({ qzone: 2, private: 3, diary: 5 }),
  emotions: Object.freeze({
    //              半衰期      敏感度      阈值        剂量下限   冷却
    anger: Object.freeze({ halfLifeMin: 30, sensitivity: 0.35, threshold: 0.70, doseMin: 12, cooldownMin: 45 }),
    sadness: Object.freeze({ halfLifeMin: 180, sensitivity: 0.20, threshold: 0.75, doseMin: 30, cooldownMin: 120 }),
    joy: Object.freeze({ halfLifeMin: 90, sensitivity: 0.30, threshold: 0.85, doseMin: 20, cooldownMin: 60 }),
    boredom: Object.freeze({ halfLifeMin: 120, sensitivity: 0.15, threshold: 0.80, doseMin: 60, cooldownMin: 180 })
  })
});

// ── 小工具（全部是纯函数） ──────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松取数：数字 / 非空数字字符串都认；其余（含 NaN、Infinity、'x'、''）一律给 fallback。 */
function toNumeric(value, fallback) {
  let numeric = Number.NaN;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

/** 按区间钳制；非数字回落默认值（注意：0 是合法数字，会被钳到 min 而不是回落）。 */
function clampTo(value, spec, fallback) {
  const numeric = toNumeric(value, Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(numeric, spec.min, spec.max);
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 'HH:mm' 校验：认不出就回落默认，永不抛。 */
function clockOr(value, fallback) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

/** 去掉控制字符（dev-doc §2.2：causeSummary 去控制字符、≤60 字），再裁长度。 */
function toText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, maxLength);
}

/**
 * FNV-1a 32 位哈希：给事件 id / 抖动播种用。
 * 故意**不用** Math.random —— 抖动必须可复现（research §4：抖动由 ventId 派生，
 * 同一次宣泄无论重算多少遍都得是同一个间隔，否则单测和「复盘」都没法做）。
 */
function hashSeed(text) {
  let hash = 2166136261;
  const source = String(text);
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 确定性抖动因子：把 seed 映射到 [1-r, 1+r]。
 * `ratio` 为 0 时恒等 1（配置里关掉抖动就不会有任何随机性）。
 */
function jitterFactor(seed, ratio) {
  const r = clamp(toNumeric(ratio, 0), 0, AFFECT_LIMITS.jitterRatio.max);
  if (r <= 0) return 1;
  const unit = hashSeed(seed) / 0xffffffff; // [0, 1]
  return 1 - r + unit * 2 * r;
}

/** 取单维的生效参数：缺字段/坏值用出厂值补，越界钳制。canVent / decayTo 都走这里。 */
function emotionConfig(cfg, key) {
  const dflt = AFFECT_DEFAULTS.emotions[key];
  const item = isPlainObject(cfg) && isPlainObject(cfg.emotions) && isPlainObject(cfg.emotions[key])
    ? cfg.emotions[key]
    : {};
  return {
    halfLifeMin: clampTo(item.halfLifeMin, AFFECT_LIMITS.halfLifeMin, dflt.halfLifeMin),
    sensitivity: clampTo(item.sensitivity, AFFECT_LIMITS.sensitivity, dflt.sensitivity),
    threshold: clampTo(item.threshold, AFFECT_LIMITS.threshold, dflt.threshold),
    doseMin: clampTo(item.doseMin, AFFECT_LIMITS.doseMin, dflt.doseMin),
    cooldownMin: clampTo(item.cooldownMin, AFFECT_LIMITS.cooldownMin, dflt.cooldownMin)
  };
}

// ── 配置归一化 ──────────────────────────────────────────────────────────────

/**
 * 配置归一化：补默认 + 钳制，**永不抛**（dev-doc §3 / §4）。
 *
 * 语义与 social-auto.js 的开关相反：这边 `enabled` / `vents` 出厂就是「开」，
 * 所以只有写对了布尔值才生效，写错类型（'false'、0）回落默认值而**不是**当关 ——
 * 用户要的是开箱即用；真要关，配置里写 `false` 就够了。
 */
export function normalizeAffectConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const emotions = {};
  for (const key of AFFECT_EMOTIONS) {
    const dflt = AFFECT_DEFAULTS.emotions[key];
    const item = isPlainObject(source.emotions?.[key]) ? source.emotions[key] : {};
    emotions[key] = Object.freeze({
      halfLifeMin: clampTo(item.halfLifeMin, AFFECT_LIMITS.halfLifeMin, dflt.halfLifeMin),
      sensitivity: clampTo(item.sensitivity, AFFECT_LIMITS.sensitivity, dflt.sensitivity),
      threshold: clampTo(item.threshold, AFFECT_LIMITS.threshold, dflt.threshold),
      doseMin: clampTo(item.doseMin, AFFECT_LIMITS.doseMin, dflt.doseMin),
      cooldownMin: clampTo(item.cooldownMin, AFFECT_LIMITS.cooldownMin, dflt.cooldownMin)
    });
  }
  const vents = {};
  for (const channel of AFFECT_VENT_CHANNELS) {
    vents[channel] = booleanOr(source.vents?.[channel], AFFECT_DEFAULTS.vents[channel]);
  }
  const dailyCap = {};
  for (const channel of AFFECT_CAPPED_CHANNELS) {
    dailyCap[channel] = clampTo(source.dailyCap?.[channel], AFFECT_LIMITS.dailyCap, AFFECT_DEFAULTS.dailyCap[channel]);
  }
  return Object.freeze({
    enabled: typeof source.enabled === 'boolean' ? source.enabled : AFFECT_DEFAULTS.enabled,
    vents: Object.freeze(vents),
    minIntervalMs: clampTo(source.minIntervalMs, AFFECT_LIMITS.minIntervalMs, AFFECT_DEFAULTS.minIntervalMs),
    jitterRatio: clampTo(source.jitterRatio, AFFECT_LIMITS.jitterRatio, AFFECT_DEFAULTS.jitterRatio),
    quietHours: Object.freeze({
      start: clockOr(source.quietHours?.start, AFFECT_DEFAULTS.quietHours.start),
      end: clockOr(source.quietHours?.end, AFFECT_DEFAULTS.quietHours.end)
    }),
    dailyCap: Object.freeze(dailyCap),
    emotions: Object.freeze(emotions)
  });
}

// ── 状态创建 / 修复 ─────────────────────────────────────────────────────────

/**
 * 新建出厂状态（dev-doc §2.1）。初始强度就是基线：anger/sadness 0.02、
 * joy 0.05、boredom 0.10 —— 什么都不发生的时候，人也不是四条零线。
 *
 * `config` 目前不参与计算（基线是常量），留着参数是为了以后「按角色调基线」时
 * 不用改所有调用点；现在传不传都一样。
 */
export function createState(now, config) {
  void config;
  const ts = toNumeric(now, 0);
  const emotions = {};
  for (const key of AFFECT_EMOTIONS) {
    const baseline = AFFECT_BASELINE[key];
    emotions[key] = {
      intensity: baseline,
      baseline,
      dose: 0,
      cooldownUntil: 0,
      lastTs: ts,
      peak: baseline
    };
  }
  return { version: 1, emotions, events: [], ventLog: [], lastVentTs: 0, deferred: [] };
}

/** 单条事件修复：kind 不在白名单或 ts 坏掉的直接丢（dev-doc §2.2 的校验口径）。 */
function normalizeEvent(raw) {
  if (!isPlainObject(raw)) return null;
  if (!AFFECT_EMOTIONS.includes(raw.kind)) return null;
  const ts = toNumeric(raw.ts, Number.NaN);
  if (!Number.isFinite(ts)) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    ts,
    source: typeof raw.source === 'string' ? raw.source : '',
    actorQQ: Math.max(0, Math.trunc(toNumeric(raw.actorQQ, 0))),
    kind: raw.kind,
    step: clamp01(toNumeric(raw.step, 0)),
    confidence: clamp01(toNumeric(raw.confidence, 0.7)),
    causeSummary: toText(raw.causeSummary, 60)
  };
}

/**
 * 单条宣泄记录修复。`ok` 缺省按 **true** 算：老版本文件或半途崩溃留下的记录
 * 我们不知道成没成功，宁可算成「已用过配额」也不能算成「没发过」——
 * 多发一条说说的代价比少发一条大（research §4 防滥发）。
 */
function normalizeVentEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const ts = toNumeric(raw.ts, Number.NaN);
  if (!Number.isFinite(ts)) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    ts,
    channel: typeof raw.channel === 'string' ? raw.channel : '',
    emotion: AFFECT_EMOTIONS.includes(raw.emotion) ? raw.emotion : '',
    ok: raw.ok !== false,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    text: typeof raw.text === 'string' ? raw.text : ''
  };
}

/**
 * 读文件后的修复（dev-doc §3）：旧版本 / 缺字段 / 坏值都要能救回来，永不抛。
 *
 * - 强度钳 0–1、dose ≥ 0、events / ventLog 只留最近 50 条、version 缺省 1；
 * - `lastTs` 不许晚于 `now`（时钟回拨 / 手改文件导致的「未来时间」会让情绪永久不衰减）；
 * - 坏 emotion / 坏数组直接重建，绝不让桥接启动失败（dev-doc §2.1 容错）。
 */
export function normalizeState(raw, now, config) {
  void config;
  const source = isPlainObject(raw) ? raw : {};
  const ts = toNumeric(now, 0);
  const rawEmotions = isPlainObject(source.emotions) ? source.emotions : {};
  const emotions = {};
  for (const key of AFFECT_EMOTIONS) {
    const item = isPlainObject(rawEmotions[key]) ? rawEmotions[key] : {};
    const baseline = AFFECT_BASELINE[key];
    const intensity = clamp01(toNumeric(item.intensity, baseline));
    const lastTsRaw = toNumeric(item.lastTs, Number.NaN);
    emotions[key] = {
      intensity,
      baseline,
      dose: Math.max(0, toNumeric(item.dose, 0)),
      cooldownUntil: Math.max(0, toNumeric(item.cooldownUntil, 0)),
      lastTs: Number.isFinite(lastTsRaw) ? Math.min(lastTsRaw, ts) : ts,
      peak: clamp01(Math.max(toNumeric(item.peak, intensity), intensity))
    };
  }
  const events = (Array.isArray(source.events) ? source.events : [])
    .map(normalizeEvent)
    .filter(Boolean)
    .slice(-50);
  const ventLog = (Array.isArray(source.ventLog) ? source.ventLog : [])
    .map(normalizeVentEntry)
    .filter(Boolean)
    .slice(-50);
  return {
    version: Math.max(1, Math.trunc(toNumeric(source.version, 1))),
    emotions,
    events,
    ventLog,
    lastVentTs: Math.max(0, toNumeric(source.lastVentTs, 0)),
    deferred: Array.isArray(source.deferred) ? [...source.deferred] : []
  };
}

// ── 衰减 / 累积 ────────────────────────────────────────────────────────────

/**
 * 懒衰减（research §2 衰减行）：`I(t) = I₀ · 2^(-Δt / T½)`，返回新对象、不改入参。
 *
 * - `Δt ≤ 0`（同一时刻重复读、或时钟回拨）原样返回，连 `lastTs` 都不动；
 * - 剂量按 research §2 剂量行同时结算：`dose·2^(-Δt/T½) + I·Δt`，`Δt` 取**分钟**，
 *   即剂量的单位是「强度·分钟」（研究文档里的 `/60` 是把秒折算成分钟，这里已先换成分钟），
 *   这里的 `I` 取**区间起点**的强度，所以静置 10 分钟正好 +I·10，单测能精确断言；
 * - `peak` 只增不减：它是「历史最高」，面板拿它画残影，不参与判定。
 */
export function decayTo(emotion, now, cfg, key = AFFECT_EMOTIONS[0]) {
  const source = isPlainObject(emotion) ? emotion : {};
  const baseline = AFFECT_BASELINE[key] ?? 0;
  const ts = toNumeric(now, Number.NaN);
  const lastTsRaw = toNumeric(source.lastTs, Number.NaN);
  const base = {
    intensity: clamp01(toNumeric(source.intensity, baseline)),
    baseline: clamp(toNumeric(source.baseline, baseline), 0, 0.5),
    dose: Math.max(0, toNumeric(source.dose, 0)),
    cooldownUntil: Math.max(0, toNumeric(source.cooldownUntil, 0)),
    // 没记录时间就按「就是现在」算：宁可少衰减一次，也不能把 NaN 带进状态文件。
    lastTs: Number.isFinite(lastTsRaw) ? lastTsRaw : (Number.isFinite(ts) ? ts : 0),
    peak: clamp01(toNumeric(source.peak, 0))
  };
  if (!Number.isFinite(ts) || ts <= base.lastTs) return base;
  const dtMin = (ts - base.lastTs) / 60000;
  const { halfLifeMin } = emotionConfig(cfg, key);
  const factor = 2 ** (-dtMin / halfLifeMin);
  const intensity = clamp01(base.intensity * factor);
  const dose = Math.max(0, base.dose * factor + base.intensity * dtMin);
  return { ...base, intensity, dose, lastTs: ts, peak: Math.max(base.peak, intensity) };
}

/**
 * 记一次事件（research §2 累积行）：软饱和 `I += (1-I)·k·step·m_r·confidence`。
 *
 * 为什么是软饱和而不是 `I += k·step`：连续注入不会把强度顶到 1 以上，越接近 1
 * 每次加得越少，「一直很生气」也不会溢出成 2.0（再由跨维总和上限兜底）。
 *
 * `m_r = max(0.15, 0.6^(n-1))`，n 是同一 kind 在 5 分钟窗口内的**已有**事件数；
 * 于是第 1 次 m_r=1、第 2 次 0.6、第 3 次 0.36……第 5 次起压到地板 0.15。
 *
 * 返回新 state（不可变）。kind 不在白名单时只做衰减，不记分、不抛错。
 */
export function addEvent(state, event, cfg, now) {
  const source = isPlainObject(event) ? event : {};
  const base = normalizeState(state, now, cfg);
  const ts = toNumeric(now, 0);
  if (!AFFECT_EMOTIONS.includes(source.kind)) return base;
  const kind = source.kind;
  const config = normalizeAffectConfig(cfg);

  // 先把四维都折算到 now：既是为了下面算总和，也让「读」永远是新鲜的。
  const emotions = {};
  for (const key of AFFECT_EMOTIONS) {
    emotions[key] = decayTo(base.emotions[key], ts, config, key);
  }

  // 同一 kind、5 分钟窗口内已经有几次（不看 actor：同一个人连骂也算重复）。
  let repeats = 0;
  for (const item of base.events) {
    if (item.kind !== kind) continue;
    const dt = ts - item.ts;
    if (dt >= 0 && dt <= REPEAT_WINDOW_MS) repeats += 1;
  }
  const repeatFactor = Math.max(0.15, 0.6 ** repeats);

  const { sensitivity } = emotionConfig(config, kind);
  const step = clamp01(toNumeric(source.step, 0));
  const confidence = clamp01(toNumeric(source.confidence, 0.7));
  const before = emotions[kind].intensity;
  const intensity = clamp01(before + (1 - before) * sensitivity * step * repeatFactor * confidence);
  emotions[kind] = {
    ...emotions[kind],
    intensity,
    peak: Math.max(emotions[kind].peak, intensity)
  };

  // 跨维总和上限 2.5（research §2 全局约束行）：按比例缩放「其它维」，主导维保持原样。
  const total = AFFECT_EMOTIONS.reduce((sum, key) => sum + emotions[key].intensity, 0);
  if (total > TOTAL_INTENSITY_CAP) {
    let dominant = AFFECT_EMOTIONS[0];
    for (const key of AFFECT_EMOTIONS) {
      if (emotions[key].intensity > emotions[dominant].intensity) dominant = key;
    }
    const others = total - emotions[dominant].intensity;
    const allowed = TOTAL_INTENSITY_CAP - emotions[dominant].intensity;
    if (others > 0 && allowed > 0 && allowed < others) {
      const scale = allowed / others;
      for (const key of AFFECT_EMOTIONS) {
        if (key === dominant) continue;
        emotions[key] = { ...emotions[key], intensity: clamp01(emotions[key].intensity * scale) };
      }
    }
  }

  const record = {
    id: `evt-${hashSeed(`${ts}|${kind}|${repeats}|${toText(source.causeSummary, 60)}`).toString(36)}`,
    ts,
    source: typeof source.source === 'string' ? source.source : '',
    actorQQ: Math.max(0, Math.trunc(toNumeric(source.actorQQ, 0))),
    kind,
    step,
    confidence,
    causeSummary: toText(source.causeSummary, 60)
  };
  const events = [...base.events, record].slice(-50);
  return { ...base, emotions, events };
}

// ── 判定 ───────────────────────────────────────────────────────────────────

/** 取当前最强的一维（面板顶栏、proactive 调概率都用它）。同分按 AFFECT_EMOTIONS 顺序。 */
export function scoreOf(state, cfg) {
  void cfg;
  const source = isPlainObject(state) ? state : {};
  const emotions = isPlainObject(source.emotions) ? source.emotions : {};
  let dominant = AFFECT_EMOTIONS[0];
  let intensity = 0;
  let dose = Math.max(0, toNumeric(emotions[AFFECT_EMOTIONS[0]]?.dose, 0));
  for (const key of AFFECT_EMOTIONS) {
    const item = isPlainObject(emotions[key]) ? emotions[key] : {};
    const value = clamp01(toNumeric(item.intensity, 0));
    if (value > intensity) {
      dominant = key;
      intensity = value;
      dose = Math.max(0, toNumeric(item.dose, 0));
    }
  }
  return { dominant, intensity, dose };
}

/** 最近 24h 里「算成功」的宣泄条数与最早那条的时间：日配额用（滑动窗口）。 */
function ventWindow(state, now) {
  let count = 0;
  let oldest = Number.POSITIVE_INFINITY;
  const list = Array.isArray(state?.ventLog) ? state.ventLog : [];
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const ts = toNumeric(entry.ts, Number.NaN);
    if (!Number.isFinite(ts)) continue;
    if (ts > now || now - ts >= VENT_WINDOW_MS) continue;
    if (entry.ok === false) continue;
    count += 1;
    if (ts < oldest) oldest = ts;
  }
  return { count, oldest };
}

/**
 * 能不能宣泄（dev-doc §3：所有阈值判定都在这里，bridge 不自己写 if）。
 *
 * 判定顺序固定（研究 §4 闸门顺序的纯函数版）：
 *   enabled → 强度 ≥ 阈值 → 剂量 ≥ 下限 → 冷却 → 日配额 → 全局最小间隔。
 * 出口开关（`cfg.vents.qzone === false`）与静默时段由上层 affect-vent.js 判 ——
 * 这里不知道、也不该知道这次要走哪个通道。
 *
 * `retryAfterMs` 是给调度器的「建议下次再看」：0 表示「等下去也没用，要有新事件」。
 */
export function canVent(state, key, cfg, now) {
  const source = isPlainObject(state) ? state : {};
  const config = normalizeAffectConfig(cfg);
  const ts = toNumeric(now, 0);
  if (config.enabled !== true) return { ok: false, reason: 'disabled', retryAfterMs: 0 };
  if (!AFFECT_EMOTIONS.includes(key)) return { ok: false, reason: 'below_threshold', retryAfterMs: 0 };

  const emotion = decayTo(source.emotions?.[key], ts, config, key);
  const params = emotionConfig(config, key);

  // ① 强度：低于阈值就没什么可说；衰减只会更小，所以 retryAfterMs 给 0。
  if (emotion.intensity < params.threshold) {
    return { ok: false, reason: 'below_threshold', retryAfterMs: 0 };
  }

  // ② 剂量：防「闪一下就发泄」。估算等待时长用当前剂量增速 ≈ I/分钟（忽略衰减，偏乐观）。
  if (emotion.dose < params.doseMin) {
    const rate = Math.max(emotion.intensity, DOSE_RATE_FLOOR);
    const waitMs = Math.ceil(((params.doseMin - emotion.dose) / rate) * 60000);
    return { ok: false, reason: 'below_dose', retryAfterMs: Math.max(0, waitMs) };
  }

  // ③ 冷却：这一维刚宣泄过，留一点余温（research §2 宣泄后那行）。
  if (ts < emotion.cooldownUntil) {
    return { ok: false, reason: 'cooldown', retryAfterMs: Math.ceil(emotion.cooldownUntil - ts) };
  }

  // ④ 日配额（全通道总量）：三个出口的日配额相加 vs 最近 24h 已成功条数。
  //    分通道的「说说还剩几条」由 affect-vent.js 用 qzone-post.checkQuota 再判一次。
  let totalCap = 0;
  for (const channel of AFFECT_CAPPED_CHANNELS) {
    if (config.vents[channel] === true) totalCap += config.dailyCap[channel];
  }
  const { count: used, oldest } = ventWindow(source, ts);
  if (used >= totalCap) {
    const retryAfterMs = Number.isFinite(oldest) ? Math.max(0, oldest + VENT_WINDOW_MS - ts) : 0;
    return { ok: false, reason: 'daily_cap', retryAfterMs };
  }

  // ⑤ 全局最小间隔：两次宣泄之间至少 minInterval × (1 ± jitter)，
  //    抖动由 lastVentTs 派生（确定性），所以「同一个状态重算多少遍结果都一样」。
  //    老状态文件可能只写了 ventLog 没写 lastVentTs，这里取两者的较晚值兜底。
  let lastVentTs = Math.max(0, toNumeric(source.lastVentTs, 0));
  if (Number.isFinite(oldest)) lastVentTs = Math.max(lastVentTs, oldest);
  if (lastVentTs > 0) {
    const interval = config.minIntervalMs * jitterFactor(String(lastVentTs), config.jitterRatio);
    const readyAt = lastVentTs + interval;
    if (ts < readyAt) return { ok: false, reason: 'min_interval', retryAfterMs: Math.ceil(readyAt - ts) };
  }

  return { ok: true };
}

// ── 宣泄执行 / 候选排序 / 调度建议 ─────────────────────────────────────────

/**
 * 执行一次宣泄（不改入参）：强度回落到 `max(I·0.4, baseline)`（不是清零，
 * research §2 宣泄后那行）、剂量归零、写冷却与 `lastVentTs`、ventLog 追加一条。
 *
 * ventLog 这条记录只保证 `id / ts / emotion` 是对的；`channel / ok / reason / text`
 * 由真正发送的调用方补（`ok` 先占位 false —— 没发出去之前绝不能算一次成功）。
 */
export function applyVent(state, key, cfg, now, ventId) {
  const base = normalizeState(state, now, cfg);
  const ts = toNumeric(now, 0);
  if (!AFFECT_EMOTIONS.includes(key)) return base;
  const config = normalizeAffectConfig(cfg);
  const emotions = {};
  for (const emotionKey of AFFECT_EMOTIONS) {
    emotions[emotionKey] = decayTo(base.emotions[emotionKey], ts, config, emotionKey);
  }
  const current = emotions[key];
  const { cooldownMin } = emotionConfig(config, key);
  const intensity = clamp01(Math.max(current.intensity * 0.4, current.baseline));
  emotions[key] = {
    ...current,
    intensity,
    dose: 0,
    cooldownUntil: ts + cooldownMin * 60000,
    peak: Math.max(current.peak, intensity)
  };
  const entry = {
    id: typeof ventId === 'number' ? String(ventId) : toText(ventId, 80),
    ts,
    channel: '',
    emotion: key,
    ok: false,
    reason: '',
    text: ''
  };
  return {
    ...base,
    emotions,
    ventLog: [...base.ventLog, entry].slice(-50),
    lastVentTs: ts
  };
}

/**
 * 候选情绪：已过阈值的那几维，按 `(I - T) / T` 降序（dev-doc §3 最后一条）。
 * 返回的是 key 数组，越靠前越「超阈值多」；同分按 AFFECT_EMOTIONS 的固定顺序（排序稳定）。
 */
export function listCandidates(state, cfg, now) {
  const source = isPlainObject(state) ? state : {};
  const config = normalizeAffectConfig(cfg);
  const ts = toNumeric(now, 0);
  const scored = [];
  for (const key of AFFECT_EMOTIONS) {
    const emotion = decayTo(source.emotions?.[key], ts, config, key);
    const { threshold } = emotionConfig(config, key);
    if (emotion.intensity < threshold) continue;
    scored.push({ key, score: (emotion.intensity - threshold) / threshold });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.key);
}

/**
 * 给上层算下一次评估间隔（毫秒），口径按 dev-doc §3：
 * - 没有候选 → 10 分钟（等事件累积，别空转）；
 * - 有候选 → 60 秒（有情绪可表达，尽快再看一次）；
 * - 冷却 / 最小间隔没到 → 老实等到点（上限收到 24h，防止手改出来的离谱值把定时器挂死）。
 */
export function scheduleDelay(state, cfg, now) {
  const config = normalizeAffectConfig(cfg);
  const ts = toNumeric(now, 0);
  const candidates = listCandidates(state, config, ts);
  if (candidates.length === 0) return 10 * 60 * 1000;
  const verdict = canVent(state, candidates[0], config, ts);
  if (verdict.ok) return 60 * 1000;
  if ((verdict.reason === 'cooldown' || verdict.reason === 'min_interval') && verdict.retryAfterMs > 0) {
    return Math.min(verdict.retryAfterMs, 24 * 60 * 60 * 1000);
  }
  return 60 * 1000;
}

// ── 序列化 ─────────────────────────────────────────────────────────────────

/**
 * 落盘用序列化（紧凑 JSON，一行一个文件）。NaN / Infinity 会被 JSON 写成 null，
 * 这里统一换成 0 —— 读回来 normalizeState 再兜一次，坏文件不会把桥接弄挂。
 */
export function serializeState(state) {
  return JSON.stringify(state ?? null, (key, value) => (
    typeof value === 'number' && !Number.isFinite(value) ? 0 : value
  ));
}

/** 解析失败 / 不是对象 → null（dev-doc §2.1：坏文件记日志、用默认状态重建，不抛）。 */
export function parseState(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}
