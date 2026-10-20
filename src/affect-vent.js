// 宣泄决策器：在 affect-core 的「情绪够不够」之上，回答「这次走哪条出口、为什么」。
//
// 口径来自 work/agent-tasks/T-012/dev-doc.md §6（决策器）与 §4（配置），
// 质量闸门与坑来自 research.md §3（与 LLM 的接口）/ §4（防滥发闸门）/ §5（已知坑）。
//
// 三条硬约束（与 affect-core.js 相同）：
//   1. **纯函数**：不碰 IO、不读系统时钟、不用 Math.random —— `now` / `quiet` 全由调用方传；
//   2. **不改入参**：state / cfg / caps / recentTexts 只读，每次返回新对象（面板可以放心展示）；
//   3. **判定不重写**：情绪够不够格一律问 affect-core 的 listCandidates / canVent，
//      本文件只负责「出口选择」与「文案质量闸门」，不自己算强度、剂量、冷却、抖动。
//
// reason 字符串是**对外契约**（控制台「当前判断」一行、日志、MCP 返回都按它分支，
// dev-doc §9）：只能新增值，不能改旧值。本文件可能返回的值：
//   顶层：disabled / quiet_hours / below_threshold / min_interval / all_denied
//         + canVent 原样上抛的 below_dose / cooldown / daily_cap
//   出口级（只出现在 detail 里）：disabled_channel / daily_cap / quiet_hours / qzone_unconfigured

import {
  AFFECT_EMOTIONS,
  canVent,
  decayTo,
  listCandidates,
  normalizeAffectConfig,
  normalizeState
} from './affect-core.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 出口降级阶梯（dev-doc §6 第 5 条 / research §4 第 9 条）：说说 → 私聊 → 日记。 */
export const VENT_CHANNELS = Object.freeze(['qzone', 'private', 'diary']);

/** 文案档位（research §2.1）：只认这四档，`planVent` 返回的 `step` 一定落在其中。 */
export const VENT_STEPS = Object.freeze([0.25, 0.5, 0.75, 1]);

/**
 * 各出口的字数区间（按 trim 后的字符数计）：
 * - `qzone` 15–300：`opts.maxChars`（对应 `qzone.maxChars`，出厂 300）更小就取更小；
 * - `private` 5–120：私聊是短句；
 * - `diary` 100–300：日记是唯一鼓励写长的出口（dev-doc §7「日记 100–300 字」）。
 */
const TEXT_RULES = Object.freeze({
  qzone: Object.freeze({ min: 15, max: 300 }),
  private: Object.freeze({ min: 5, max: 120 }),
  diary: Object.freeze({ min: 100, max: 300 })
});

/** 只跟最近 5 条比（dev-doc §6 第 6 条 / research §4 第 5 条）。 */
const RECENT_WINDOW = 5;
/** 3-gram Jaccard 阈值（research §4 第 5/6 条：去重 0.55、质量闸门 0.4，这里统一取严的 0.4）。 */
const SIMILARITY_LIMIT = 0.4;
/** 感叹号 / 问号各 ≤ 3（research §4 第 6 条）。 */
const MAX_BANGS = 3;
/** 同一字符连续重复 ≤ 4（research §4 第 6 条）。 */
const MAX_RUN = 4;

const URL_RE = /(https?:\/\/|www\.)/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const AT_RE = /@/;
const IDCARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/;
const DIGITS_RE = /\d{5,}/;
const RUN_RE = /([^\s])\1{4,}/u;
const PUNCT_ONLY_RE = /[\p{P}\p{Z}\s]/gu;

// ── 小工具（纯函数） ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松取数：数字 / 非空数字字符串都认，其余（NaN、Infinity、'x'、''）给 fallback。 */
function toNumber(value, fallback) {
  let numeric = Number.NaN;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** 用等长空格盖掉命中片段：既保住下标，又能让后续规则不重复报同一处。 */
function maskMatches(text, re) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return text.replace(rx, (hit) => ' '.repeat(hit.length));
}

/** 只跟最近 5 条非空字符串比（调用方传进来的脏数据直接忽略，不抛）。 */
function recentTextsList(recentTexts) {
  if (!Array.isArray(recentTexts)) return [];
  const kept = [];
  for (const item of recentTexts) {
    if (typeof item !== 'string') continue;
    const body = item.trim();
    if (body === '') continue;
    kept.push(body);
  }
  return kept.slice(-RECENT_WINDOW);
}

/** 去重用的规范化：去掉空白/标点/符号再小写（「天黑了，」与「天黑了」算同一串）。 */
function normalizeForGrams(text) {
  return String(text).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** 3-gram 集合：不足 3 字就整串当一个 gram，避免短文本 Jaccard 恒为 0。 */
function trigrams(text) {
  const norm = normalizeForGrams(text);
  const set = new Set();
  if (norm === '') return set;
  if (norm.length < 3) {
    set.add(norm);
    return set;
  }
  for (let i = 0; i + 3 <= norm.length; i += 1) set.add(norm.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── 档位 ────────────────────────────────────────────────────────────────────

/**
 * 强度 → 文案档位（research §2.1 的四档 0.25 / 0.5 / 0.75 / 1）。
 *
 * 取「不小于强度的最小档」而不是四舍五入：强度是**连续**的，档位是给模型看的粗粒度指令，
 * 过完 0.70 阈值的怒意不该只说「一点点」（0.70 四舍五入会落到 0.75，但 0.76 就会跳 1 ——
 * 用向上取整这条规则在面板上更好解释：过一档说一档）。
 * 坏值（NaN / 负 / >1）按 0 或 1 钳，永不抛。
 */
export function pickStep(intensity) {
  const value = Math.min(1, Math.max(0, toNumber(intensity, 0)));
  for (const step of VENT_STEPS) {
    if (value <= step) return step;
  }
  return 1;
}

// ── 文案质量闸门 ────────────────────────────────────────────────────────────

/** `opts` 既接受 `{ maxChars }` 也接受裸数字（bridge 直接把 `qzone.maxChars` 传进来）。 */
function readMaxChars(opts) {
  const raw = isPlainObject(opts) ? opts.maxChars : opts;
  const value = toNumber(raw, Number.NaN);
  return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/** qzone 的字数上限：`maxChars` 更小就取小，但不许把下限压到 min 以下（那就永远发不出去）。 */
function textLimit(channel, rule, opts) {
  if (channel !== 'qzone') return rule.max;
  const maxChars = readMaxChars(opts);
  if (!Number.isFinite(maxChars)) return rule.max;
  return Math.max(rule.min, Math.min(rule.max, maxChars));
}

/**
 * 文案质量闸门（dev-doc §6 第 6 条 / research §4 第 5、6 条 / §5「提示词注入」行）。
 *
 * 一次收集**全部**命中（不短路）：模型照着 reasons 改一遍就能过，而不是改一处再被拒一次
 * （与 qzone-post.auditContent 同一套口径）。
 *
 * 规则与 reason：
 *   empty（空白/仅标点）· too_short / too_long · url · at · digits（5 位以上连续数字）
 *   · email · idcard（18 位）· exclaim / question（各 ≤3）· repeat（同字符连续 ≤4）
 *   · duplicate（与最近 5 条完全相同）· too_similar（3-gram Jaccard ≥ 0.4）
 *
 * 省略重复命中：邮箱里的 `@` 不再报 `at`、身份证号里的数字不再报 `digits` —— 一处问题一条根因，
 * 免得模型以为要改三处。
 *
 * @param {string} text        待检文案（生成后才调，纯函数不改它）
 * @param {string[]} recentTexts 最近发过的文案（取最后 5 条）
 * @param {'qzone'|'private'|'diary'} channel 出口（未知出口按 qzone 的区间，fail-closed）
 * @param {{maxChars?: number}|number} [opts] qzone 上限更小时取小
 * @returns {{ok:true}|{ok:false, reasons:string[]}}
 */
export function checkVentText(text, recentTexts, channel, opts = {}) {
  const body = (typeof text === 'string' ? text : '').trim();
  // 空白 / 仅标点：其余规则对空文本没有意义，直接短路成 empty（不堆一串噪音理由）
  if (body === '' || body.replace(PUNCT_ONLY_RE, '') === '') {
    return { ok: false, reasons: ['empty'] };
  }

  const rule = TEXT_RULES[channel] ?? TEXT_RULES.qzone;
  const limit = textLimit(channel, rule, opts);
  const reasons = [];
  const add = (id) => {
    if (!reasons.includes(id)) reasons.push(id);
  };

  // ① 长度
  if (body.length < rule.min) add('too_short');
  if (body.length > limit) add('too_long');

  // ② 联系方式：邮箱先盖掉再查 @，身份证先盖掉再查长数字
  const withoutEmail = maskMatches(body, EMAIL_RE);
  const withoutIdcard = maskMatches(body, IDCARD_RE);
  const hits = {
    url: URL_RE.test(body),
    at: AT_RE.test(withoutEmail),
    digits: DIGITS_RE.test(withoutIdcard),
    email: EMAIL_RE.test(body),
    idcard: IDCARD_RE.test(body),
    exclaim: (body.match(/[!！]/g) || []).length > MAX_BANGS,
    question: (body.match(/[?？]/g) || []).length > MAX_BANGS,
    repeat: RUN_RE.test(body)
  };
  for (const id of ['url', 'at', 'digits', 'email', 'idcard', 'exclaim', 'question', 'repeat']) {
    if (hits[id]) add(id);
  }

  // ③ 去重：完全相同 → duplicate；否则才对每条不同文本算 3-gram Jaccard
  const recent = recentTextsList(recentTexts);
  const self = trigrams(body);
  for (const item of recent) {
    if (item === body) {
      add('duplicate');
      continue;
    }
    if (jaccard(self, trigrams(item)) >= SIMILARITY_LIMIT) add('too_similar');
  }

  if (reasons.length === 0) return { ok: true };
  return { ok: false, reasons };
}

// ── 决策记录 → 面板行 ──────────────────────────────────────────────────────

/**
 * 把决策器逐步积累的结构化记录（`{ step, ok, text }`）格式化成面板/调试端点可直接渲染的行。
 *
 * `planVent` 的 `plan` 就是它的输出（`✓ 开关：开（enabled=true）` 这种）；
 * 调试端点 `POST /api/socialV2/affect/vent`（dev-doc §5 表格最后一行）拿到 result.plan 直接显示即可，
 * 只存了 `notes` 的复盘场景也能用它重新排版 —— 排版与判定是同一份数据，不会各说各话。
 */
export function buildVentPlan(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const lines = [];
  for (const note of list) {
    if (!isPlainObject(note)) continue;
    const text = typeof note.text === 'string' ? note.text.trim() : '';
    if (text === '') continue;
    const mark = note.ok === true ? '✓' : '✗';
    const step = typeof note.step === 'string' && note.step !== '' ? `${note.step}：` : '';
    lines.push(`${mark} ${step}${text}`);
  }
  return lines;
}

// ── 决策器 ──────────────────────────────────────────────────────────────────

/**
 * 「最小间隔」探针：canVent 里的抖动（jitterFactor）是模块私有的，
 * 自己再算一遍等于养出第二个版本 —— 这里造一维「必过」的假情绪去问 canVent，
 * 只取它 `min_interval` 这一条结论（dev-doc §6 第 3 条要求复用，不重算抖动）。
 *
 * 假情绪：强度 1（任何阈值都过）、剂量 1e9（任何下限都过）、无冷却、lastTs = now（不衰减）。
 * 探针配置把 vents 全打开、dailyCap 顶到上限，免得「出口都关着」把日配额算成 0 而误报 daily_cap。
 */
function intervalProbe(state, lastVentTs, now, config) {
  const emotions = {};
  for (const key of AFFECT_EMOTIONS) {
    emotions[key] = { intensity: 1, baseline: 0.02, dose: 1e9, cooldownUntil: 0, lastTs: now, peak: 1 };
  }
  const probeState = { ...state, emotions, lastVentTs };
  const probeConfig = normalizeAffectConfig({
    ...config,
    vents: { qzone: true, private: true, diary: true, group: false },
    dailyCap: { qzone: 10, private: 10, diary: 10 }
  });
  return canVent(probeState, AFFECT_EMOTIONS[0], probeConfig, now);
}

/**
 * 这次该不该宣泄、走哪个出口（dev-doc §6 的判定顺序，逐条短路）。
 *
 * 判定顺序（理由字符串固定，见文件头）：
 *   ① enabled（§6 第 1 条）→ disabled
 *   ② 静默时段（§6 第 4 条）→ 只许 diary；diary 也关着就是 quiet_hours
 *   ③ 候选为空（§6 第 2 条）→ below_threshold
 *   ④ 全局最小间隔（§6 第 3 条）→ min_interval（抖动由 canVent 算，不复制）
 *   ⑤ 候选按 (I-T)/T 降序逐个问 canVent，第一个 ok 的进出口选择（§6 第 5 条）
 *   ⑥ 出口 qzone → private → diary：开关 → 通道额度 → qzone 是否已配置
 *   ⑦ 全被拒 → all_denied + 每个出口的拒因（面板要展示，§6 第 7 条）
 *   ⑧ 成功 → channel / emotion / intensity / dose / step(档位) / plan
 *
 * `detail` 的键有两组、天然不相交：出口名（qzone/private/diary）是出口拒因，
 * 情绪名（anger/sadness/joy/boredom）是「这一维被 canVent 拒了」的原因。
 * `plan` 是给人看的中文判定记录（每行带 ✓/✗），面板直接显示。
 *
 * @param {object} input
 * @param {object} input.state        affect-core 的状态（会被 normalizeState 容错修复，但不改动原对象）
 * @param {object} input.cfg          socialV2.affect 原始配置（内部归一化）
 * @param {number} input.now          当前毫秒时间戳（由调用方注入）
 * @param {boolean} [input.quiet]     true = 处在静默时段（由调用方按 quietHours 判断，本文件不知道时区）
 * @param {object} [input.caps]       `{ qzone, private, diary, qzoneConfigured }`：false = 该出口今天没额度了
 * @param {string[]} [input.recentTexts] 最近发过的文案（生成后过 checkVentText 用，这里只记进 plan）
 * @param {number} [input.lastVentTs] 上一次宣泄时间（与 state.lastVentTs 取较晚者）
 * @returns {{ok:false, reason:string, detail:object, plan:string[], notes:object[]}
 *          |{ok:true, channel:string, emotion:string, intensity:number, dose:number,
 *            step:number, detail:object, plan:string[], notes:object[]}}
 */
export function planVent({ state, cfg, now, quiet, caps, recentTexts, lastVentTs } = {}) {
  const config = normalizeAffectConfig(cfg);
  const ts = toNumber(now, 0);
  // 用 normalizeState 兜底：坏 state（手改文件 / 旧版本）不该让决策器抛错，也不该改入参
  const normalized = normalizeState(state, ts, config);
  const capMap = isPlainObject(caps) ? caps : {};
  const recent = recentTextsList(recentTexts);
  const notes = [];
  const detail = {};
  const finish = (extra) => ({ ...extra, detail, plan: buildVentPlan(notes), notes });

  // ① 总开关（dev-doc §6 第 1 条）
  if (config.enabled !== true) {
    notes.push({ ok: false, step: '开关', text: '情绪宣泄已关闭（enabled=false）→ disabled' });
    return finish({ ok: false, reason: 'disabled' });
  }
  notes.push({ ok: true, step: '开关', text: '开（enabled=true）' });

  // ② 静默时段（dev-doc §6 第 4 条 / research §4 第 4 条）：只允许日记，其余出口记 quiet_hours
  const inQuiet = quiet === true;
  if (inQuiet) {
    if (config.vents.diary !== true) {
      detail.qzone = 'quiet_hours';
      detail.private = 'quiet_hours';
      detail.diary = 'disabled_channel';
      notes.push({ ok: false, step: '静默时段', text: '静默中只许日记，但 vents.diary 也关着 → quiet_hours' });
      return finish({ ok: false, reason: 'quiet_hours' });
    }
    notes.push({ ok: true, step: '静默时段', text: '静默中，只有日记出口可用（其余出口记 quiet_hours）' });
  } else {
    notes.push({ ok: true, step: '静默时段', text: '不在静默时段' });
  }

  // ③ 候选（dev-doc §6 第 2 条）：listCandidates 已按 (I-T)/T 降序，这里不重排
  const candidates = listCandidates(normalized, config, ts);
  if (candidates.length === 0) {
    for (const key of AFFECT_EMOTIONS) {
      const item = decayTo(normalized.emotions[key], ts, config, key);
      const threshold = config.emotions[key].threshold;
      detail[key] = 'below_threshold';
      notes.push({
        ok: false,
        step: `候选 ${key}`,
        text: `强度 ${item.intensity.toFixed(2)} < 阈值 ${threshold.toFixed(2)}`
      });
    }
    notes.push({ ok: false, step: '候选', text: '四维都没过阈值 → below_threshold' });
    return finish({ ok: false, reason: 'below_threshold' });
  }
  notes.push({
    ok: true,
    step: '候选',
    text: `${candidates.join(' / ')}（按 (I-T)/T 降序；最近 ${recent.length} 条文案留到生成后过 checkVentText）`
  });

  // ④ 全局最小间隔（dev-doc §6 第 3 条）：复用 canVent 的抖动，不自算
  const effectiveLastVentTs = Math.max(0, toNumber(lastVentTs, 0), toNumber(normalized.lastVentTs, 0));
  const gate = intervalProbe(normalized, effectiveLastVentTs, ts, config);
  if (gate.ok !== true && gate.reason === 'min_interval') {
    const retryAfterMs = Math.max(0, toNumber(gate.retryAfterMs, 0));
    const waitMin = Math.max(1, Math.ceil(retryAfterMs / 60000));
    notes.push({
      ok: false,
      step: '最小间隔',
      text: `还差 ${waitMin} 分钟（${Math.round(config.minIntervalMs / 60000)} 分钟 ±${Math.round(config.jitterRatio * 100)}%）→ min_interval`
    });
    return finish({ ok: false, reason: 'min_interval', retryAfterMs });
  }
  if (gate.ok !== true) {
    // 理论到不了：探针都过不了别的闸门，说明状态异常。不在这里静默放行，交给按维判定去报真实原因。
    notes.push({ ok: false, step: '最小间隔', text: `探针返回 ${gate.reason}，交给按维判定` });
  } else {
    notes.push({ ok: true, step: '最小间隔', text: '全局间隔已满足' });
  }

  // ⑤ 逐个候选问 canVent（dev-doc §6 第 5 条）：第一个过的进出口选择
  //
  // 先处理一个特例：三个出口全关时，canVent 的最后一道闸（全通道日配额）会把状态报成
  // `daily_cap`——那是**出口级**结论，不是情绪级结论（dev-doc §6 第 6 条）。如果让按维判定
  // 先跑，面板会显示「今天额度用完了」，而真实原因是「出口全关了」。所以这里按出口配置
  // 直接短路成 all_denied + 每个出口的拒因（§6 第 7 条），也与「先配置、后情绪」的直觉一致。
  if (!inQuiet && VENT_CHANNELS.every((key) => config.vents[key] !== true)) {
    for (const key of VENT_CHANNELS) {
      detail[key] = 'disabled_channel';
      notes.push({ ok: false, step: `出口 ${key}`, text: '出口已关闭（disabled_channel）' });
    }
    notes.push({ ok: false, step: '出口', text: '三个出口全被拒 → all_denied' });
    return finish({ ok: false, reason: 'all_denied' });
  }

  let emotion = '';
  for (const key of candidates) {
    const verdict = canVent(normalized, key, config, ts);
    if (verdict.ok === true) {
      const item = decayTo(normalized.emotions[key], ts, config, key);
      notes.push({
        ok: true,
        step: `候选 ${key}`,
        text: `可宣泄（强度 ${item.intensity.toFixed(2)} ≥ ${config.emotions[key].threshold.toFixed(2)}，`
          + `剂量 ${item.dose.toFixed(1)} ≥ ${config.emotions[key].doseMin}）`
      });
      emotion = key;
      break;
    }
    detail[key] = verdict.reason;
    notes.push({ ok: false, step: `候选 ${key}`, text: `${verdict.reason}，跳过` });
  }
  if (emotion === '') {
    // 没有一维过得了 canVent：把**第一个候选**的拒因原样上抛 —— 面板要显示「冷却到 23:41」
    // 这种具体结论，而不是笼统的 all_denied（research §4 第 9 条：降级阶梯之前先如实报原因）
    const first = candidates[0];
    const reason = detail[first] || 'below_threshold';
    notes.push({ ok: false, step: '候选', text: `没有一维能宣泄（首个候选 ${first}：${reason}）→ ${reason}` });
    return finish({ ok: false, reason });
  }

  // ⑥ 出口选择（dev-doc §6 第 5 条）：qzone → private → diary
  let channel = '';
  for (const key of VENT_CHANNELS) {
    if (inQuiet && key !== 'diary') {
      detail[key] = 'quiet_hours';
      notes.push({ ok: false, step: `出口 ${key}`, text: '静默时段不对外发（quiet_hours）' });
      continue;
    }
    if (config.vents[key] !== true) {
      detail[key] = 'disabled_channel';
      notes.push({ ok: false, step: `出口 ${key}`, text: '出口已关闭（disabled_channel）' });
      continue;
    }
    if (capMap[key] === false) {
      detail[key] = 'daily_cap';
      notes.push({ ok: false, step: `出口 ${key}`, text: '今天这个出口的额度用完了（daily_cap）' });
      continue;
    }
    // 说说要额外确认空间功能已启用并配置好：没配置就发等于让桥接去报 OneBot 错误
    if (key === 'qzone' && capMap.qzoneConfigured !== true) {
      detail[key] = 'qzone_unconfigured';
      notes.push({ ok: false, step: `出口 ${key}`, text: '空间功能没开或没配置（qzone_unconfigured）' });
      continue;
    }
    channel = key;
    notes.push({ ok: true, step: `出口 ${key}`, text: '可用，选中' });
    break;
  }

  // ⑦ 全被拒（dev-doc §6 第 7 条）
  if (channel === '') {
    notes.push({ ok: false, step: '出口', text: '三个出口全被拒 → all_denied' });
    return finish({ ok: false, reason: 'all_denied' });
  }

  // ⑧ 成功：强度/剂量取 now 时刻的衰减值，档位按强度给（research §2.1）
  const item = decayTo(normalized.emotions[emotion], ts, config, emotion);
  const step = pickStep(item.intensity);
  notes.push({ ok: true, step: '结论', text: `走 ${channel}，情绪 ${emotion}，档位 ${step}` });
  return finish({
    ok: true,
    channel,
    emotion,
    intensity: item.intensity,
    dose: item.dose,
    step
  });
}
