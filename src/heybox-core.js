// 小黑盒（heybox）闸门的纯逻辑：配置归一 / 当日额度与最小间隔 / 评论审计 / 近似去重 /
// usage 状态解析与序列化 / CLI 错误与拒绝理由的中文话术。
//
// 为什么单独成文件：评论前的四道闸门（功能开关、额度与间隔、内容审计、重复内容）必须能在
// **不启动 MCP、不碰文件、不调 xiaoheihe-cli** 的前提下被反复验证。MCP 层只负责
// 「读 config.json → 调这里的函数 → 调 CLI → 写 usage.json」，判断全在本文件。
//
// 依赖：只有一处 import —— src/qzone-post.js 的 auditContent（社交内容审计的规则已经在那儿
// 调好了，手机号 / 裸域名 / 证件号这些坑都踩过，再抄一份只会两边漂移）。
// 约束：不碰 fs / 网络 / child_process / 定时器；时间一律由调用方以 `now`（毫秒时间戳）注入，
// 本模块**不读系统时钟** —— 纯函数的返回值只能取决于入参，否则单测会随运行时刻漂移。

import { auditContent } from './qzone-post.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// 小黑盒的「今天」按北京时间（UTC+8）切：服务器可能跑在别的时区，不能依赖进程时区。
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
// Date 能表示的最大时间戳；超出它 toISOString() 会抛 RangeError。
const MAX_DATE_MS = 8.64e15;
// 评论长度下限（按码点计）：一两个字的「好」「牛」不算评论。
const MIN_COMMENT_CHARS = 5;
// 连续同一个字符超过这个次数即算灌水（「哈哈哈哈哈」5 个就拒）。
const MAX_REPEAT_RUN = 4;
// 去重口径：3-gram Jaccard ≥ 0.55 判近似；归一化后不足 6 字的文本不参与判定（太短没有区分度）。
const SHINGLE_SIZE = 3;
const NEAR_DUPLICATE_RATIO = 0.55;
const MIN_COMPARE_CHARS = 6;

/**
 * 出厂默认值。`allowComment:false` 是刻意的：只读能力（feed / post / search）先上线，
 * 评论要显式打开——「默认能发东西」是最不该有的默认值。
 *
 * `minGapMs` / `maxGapMs` 是评论间隔的抖动区间：MCP 层在两者之间取一个随机间隔，
 * 固定间隔太像脚本。`dryRunDefault:true` 表示 CLI 层默认只演练、不真发。
 */
export const HEYBOX_DEFAULTS = Object.freeze({
  enabled: true,
  allowComment: false,
  cliPath: 'xiaoheihe-cli',
  dailyComments: 10,
  minGapMs: 6 * MINUTE_MS,
  maxGapMs: 20 * MINUTE_MS,
  postMaxChars: 200,
  dryRunDefault: true,
});

/**
 * clamp 区间。两端都是**显式语义**，不是「不限」：
 * - `dailyComments` 的 0 表示「一条都不发」，所以下限必须是 0；
 * - `minGapMs` / `maxGapMs` 的 1 分钟是硬下限（再快就是机器行为），6 小时是硬上限
 *   （再慢等于功能停摆，用户会以为坏了）。
 */
export const HEYBOX_LIMITS = Object.freeze({
  dailyComments: Object.freeze([0, 50]),
  minGapMs: Object.freeze([MINUTE_MS, 6 * HOUR_MS]),
  maxGapMs: Object.freeze([MINUTE_MS, 6 * HOUR_MS]),
  postMaxChars: Object.freeze([5, 500]),
});

/** 只认对象，数组/字符串/null 一律当「没给」。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 转有限数字：数字直接用，纯数字字符串（如 `"300"`）也接受，布尔 / 空串 / 对象 / NaN /
 * Infinity 一律当「没给」——注意 `true` 不能被当成 1。
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 整数 clamp：数字 → 取整后夹到区间（越界会被抬到边界，不回落默认值，因为「0」是用户
 * 明确表达的一个意图，抬到安全下限比静默改成默认值更可预期）；非数字 → 默认值。
 */
function clampInt(value, bounds, fallback) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds[1], Math.max(bounds[0], Math.trunc(n)));
}

/** 布尔项只认字面 true / false；`0`、`'false'`、`null` 都算「没给」，回落默认值。 */
function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 命令名/路径：非空字符串才用（去首尾空白），其它一律默认。 */
function toCliPath(value) {
  if (typeof value !== 'string') return HEYBOX_DEFAULTS.cliPath;
  const trimmed = value.trim();
  return trimmed === '' ? HEYBOX_DEFAULTS.cliPath : trimmed;
}

/** 时间戳：非法值回落 `fallback`，并夹在 Date 能表示的范围内（保证下面不会抛 RangeError）。 */
function toTimestamp(value, fallback = 0) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DATE_MS, Math.max(-MAX_DATE_MS, Math.trunc(n)));
}

/** 计数 / 时间戳类字段：非正数或非数字都归 0（脏数据不能变成负数或 NaN 传下去）。 */
function toCount(value) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/**
 * 北京时间自然日键（`YYYY-MM-DD`）：把时间戳平移到 UTC+8 再切 ISO 前 10 位。
 * 不用 `toLocaleDateString` —— 那依赖 ICU 与进程时区，单测会随机器漂。
 */
export function dayKeyOf(now) {
  const at = toTimestamp(now, 0);
  const shifted = Math.min(MAX_DATE_MS, Math.max(-MAX_DATE_MS, at + BEIJING_OFFSET_MS));
  return new Date(shifted).toISOString().slice(0, 10);
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把 `config.json` 里的 `heybox` 块归一化成可直接使用的冻结对象。
 * 任何脏值都不抛错：缺省 / 非对象 → 全默认；数字类字段 clamp 到 `HEYBOX_LIMITS`。
 *
 * `maxGapMs` 必须 ≥ `minGapMs`：反过来的配置会让「随机间隔」的取值区间为空，
 * 所以这里直接把 maxGap 抬到 minGap（等于固定间隔），而不是偷偷换回默认值——
 * 用户配的 minGap 是他真实表达的下限，不能被忽略。
 */
export function normalizeHeyboxConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const minGapMs = clampInt(source.minGapMs, HEYBOX_LIMITS.minGapMs, HEYBOX_DEFAULTS.minGapMs);
  const maxGapMs = clampInt(source.maxGapMs, HEYBOX_LIMITS.maxGapMs, HEYBOX_DEFAULTS.maxGapMs);
  // 字段顺序与 HEYBOX_DEFAULTS 一致：控制台/日志里 diff 才稳定。
  return Object.freeze({
    enabled: toBool(source.enabled, HEYBOX_DEFAULTS.enabled),
    allowComment: toBool(source.allowComment, HEYBOX_DEFAULTS.allowComment),
    cliPath: toCliPath(source.cliPath),
    dailyComments: clampInt(source.dailyComments, HEYBOX_LIMITS.dailyComments, HEYBOX_DEFAULTS.dailyComments),
    minGapMs,
    maxGapMs: Math.max(minGapMs, maxGapMs),
    postMaxChars: clampInt(source.postMaxChars, HEYBOX_LIMITS.postMaxChars, HEYBOX_DEFAULTS.postMaxChars),
    dryRunDefault: toBool(source.dryRunDefault, HEYBOX_DEFAULTS.dryRunDefault),
  });
}

/**
 * usage 状态的字段级兜底：`parseUsage` / `heyboxQuota` / `recordAction` / `serializeUsage`
 * 共用同一份口径，避免「写进去一个值、读出来另一个值」。
 * 非对象 → 空状态（`day` 取 1970-01-01，于是任何真实日期都不等于它，计数自然是 0）。
 */
function normalizeUsage(raw) {
  const seed = { day: dayKeyOf(0), count: 0, lastTs: 0, pausedUntil: 0, pausedReason: '' };
  if (!isPlainObject(raw)) return seed;
  return {
    day: typeof raw.day === 'string' && DAY_KEY_RE.test(raw.day) ? raw.day : seed.day,
    count: toCount(raw.count),
    lastTs: toCount(raw.lastTs),
    pausedUntil: toCount(raw.pausedUntil),
    pausedReason: typeof raw.pausedReason === 'string' ? raw.pausedReason : '',
  };
}

/** 当日已用条数：`state.day` 不是今天就是 0（跨日计数归零的唯一来源）。 */
function usedTodayOf(usage, todayKey) {
  return usage.day === todayKey ? usage.count : 0;
}

/**
 * 评论额度判定（纯计算，不写任何状态）。顺序是**定死的**，因为拒绝理由决定用户下一步做什么：
 *   ① `enabled === false` → `disabled`（整个功能关着，改评论开关也没用）
 *   ② `allowComment === false` → `comment_disabled`
 *   ③ `state.pausedUntil > now` → `paused`（验证码/限流的风控暂停，**必须**压过日上限：
 *      否则用户看到「今天满 10 条了」，以为明天就能好，实际还在暂停里）
 *   ④ 当日已用 ≥ `dailyComments` → `daily_cap`
 *   ⑤ `now - lastTs < minGapMs` → `too_frequent`（`nextAllowedAt = lastTs + minGapMs`）
 *   ⑥ 否则放行
 *
 * 时间戳在未来的 `lastTs`（时钟回拨 / 手工改文件）会让 ⑤ 的差值为负，照样判 `too_frequent`
 * ——把系统时间往前拨一次不能换来一次评论机会。
 *
 * 返回值除约定的 5 个键外另外带 `dailyComments` / `minGapMs`：`commentReasonText(reason, quota)`
 * 只有 quota 一个入参，需要这两个值才能拼出「上限 M 条」「不到 X 分钟」。
 */
export function heyboxQuota(state, cfg, now) {
  const config = normalizeHeyboxConfig(cfg);
  const usage = normalizeUsage(state);
  const at = toTimestamp(now, 0);
  const usedToday = usedTodayOf(usage, dayKeyOf(at));
  const remaining = Math.max(0, config.dailyComments - usedToday);
  const make = (ok, reason, nextAllowedAt = 0) => ({
    ok,
    reason,
    usedToday,
    remaining,
    nextAllowedAt,
    dailyComments: config.dailyComments,
    minGapMs: config.minGapMs,
  });

  if (!config.enabled) return make(false, 'disabled');
  if (!config.allowComment) return make(false, 'comment_disabled');
  if (usage.pausedUntil > at) return make(false, 'paused');
  if (usedToday >= config.dailyComments) return make(false, 'daily_cap');
  if (at - usage.lastTs < config.minGapMs) return make(false, 'too_frequent', usage.lastTs + config.minGapMs);
  return make(true, null);
}

/** 码点长度（不是 UTF-16 长度）：一个 emoji 算一个字，否则「200 字上限」对 emoji 会腰斩。 */
function codePointLength(text) {
  return [...text].length;
}

/** 有没有连续同一个字符超过 `MAX_REPEAT_RUN` 次（按码点逐字比，emoji 也算一个字符）。 */
function hasRepeatedRun(chars) {
  let run = 1;
  for (let i = 1; i < chars.length; i += 1) {
    run = chars[i] === chars[i - 1] ? run + 1 : 1;
    if (run > MAX_REPEAT_RUN) return true;
  }
  return false;
}

// 只要还有「汉字 / 字母 / 数字」就算有信息量；emoji、标点、符号都不算。
const MEANINGFUL_RE = /[\p{L}\p{N}]/u;
// auditContent 的规则顺序（同时是 detail 里 rule id 的拼接顺序）。
const AUDIT_RULE_ORDER = Object.freeze(['length', 'url', 'phone', 'email', 'idcard', 'solicit']);

/**
 * 评论内容审计：返回 `{ ok, reason, detail }`，`reason` 是机器可判的短 id（英文），
 * `detail` 只在 `unsafe` 时有内容。
 *
 * 检查顺序（前面的先拒，用户一次只看到最该改的那条）：
 *   ① 去首尾空白后为空 → `empty`
 *   ② 码点长度 < 5 → `too_short`；> `postMaxChars` → `too_long`
 *   ③ 含换行 → `multiline`（评论框里换行会被平台吞成空格，看起来像乱码）
 *   ④ 去掉空白与标点后没有汉字/字母/数字（纯 emoji、纯标点）→ `meaningless`
 *   ⑤ 连续同一个字符超过 4 次 → `repetitive`
 *   ⑥ 交给 `auditContent`（URL / 手机号 / 邮箱 / 证件号 / 拉人话术）→ `unsafe`，
 *      `detail` 是命中的规则 id（按规则表顺序、逗号分隔，如 `url,phone`）
 *
 * 关于 `detail`：`auditContent` 的 `reasons` 是**中文话术**（如「带链接等于帮人打广告」），
 * 规则 id 在 `hits[].rule` 里。这里回的是 rule id —— 它是给日志/MCP 层分支用的稳定枚举，
 * 中文话术随时会改，id 不会。
 */
export function auditComment(text, cfg) {
  const config = normalizeHeyboxConfig(cfg);
  const body = String(text ?? '').trim();
  if (body === '') return { ok: false, reason: 'empty', detail: '' };

  const chars = [...body];
  if (chars.length < MIN_COMMENT_CHARS) return { ok: false, reason: 'too_short', detail: '' };
  if (chars.length > config.postMaxChars) return { ok: false, reason: 'too_long', detail: '' };
  if (/[\r\n]/.test(body)) return { ok: false, reason: 'multiline', detail: '' };
  if (!MEANINGFUL_RE.test(body.replace(/[\s\p{P}]/gu, ''))) {
    return { ok: false, reason: 'meaningless', detail: '' };
  }
  if (hasRepeatedRun(chars)) return { ok: false, reason: 'repetitive', detail: '' };

  const audit = auditContent(body, { maxChars: config.postMaxChars });
  if (!audit.ok) {
    const hitRules = new Set(audit.hits.map((hit) => hit.rule));
    const detail = AUDIT_RULE_ORDER.filter((rule) => hitRules.has(rule)).join(',');
    return { ok: false, reason: 'unsafe', detail };
  }
  return { ok: true, reason: null, detail: '' };
}

/** 全角 ASCII（！～）转半角，顺带把全角空格变成普通空格。 */
function toHalfWidth(text) {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/**
 * 去重用的归一化：全角转半角 → 小写 → 去掉空白与标点。
 * 只去空白/标点，不去 emoji（emoji 是内容的一部分，抹掉会让两条不同的评论变成同一条）。
 */
function normalizeForCompare(value) {
  return toHalfWidth(String(value ?? '')).toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/** 字符 n-gram 集合（按码点切，中文不会被切成半个字）。 */
function shingles(text) {
  const chars = [...text];
  const set = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= chars.length; i += 1) {
    set.add(chars.slice(i, i + SHINGLE_SIZE).join(''));
  }
  return set;
}

/** Jaccard = |交| / |并|；任一方为空集算 0（没有可比性）。 */
function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 最近评论去重：返回 `'exact'` / `'near'` / `''`。
 *
 * - `exact`：归一化后完全相同（空白、标点、全角、大小写差异都不算不同）；
 * - `near`：字符 3-gram Jaccard ≥ 0.55（「这游戏真的很好玩」vs「这游戏真的很难玩」
 *   是 5/9 ≈ 0.556，正好压线，属于该拦的范围）；
 * - 归一化后不足 6 字的一律不判（「好的」「牛」这种短句没有区分度，判了全是误伤）；
 *   目标文本自己不足 6 字直接返回 `''`。
 *
 * `recentTexts` 由调用方给（最近几条原文，顺序无关紧要）；本函数**不截断条数** ——
 * 「只比最近 5 条」是调用方的口径，放在这里会让「第 6 条重复」静默漏过。
 * `exact` 优先于 `near`：先扫到 near 也会继续找 exact。
 */
export function nearDuplicate(text, recentTexts) {
  const target = normalizeForCompare(text);
  if (codePointLength(target) < MIN_COMPARE_CHARS) return '';
  const list = Array.isArray(recentTexts) ? recentTexts : [];
  const targetGrams = shingles(target);
  let near = false;
  for (const item of list) {
    const other = normalizeForCompare(item);
    if (codePointLength(other) < MIN_COMPARE_CHARS) continue;
    if (other === target) return 'exact';
    if (!near && jaccard(targetGrams, shingles(other)) >= NEAR_DUPLICATE_RATIO) near = true;
  }
  return near ? 'near' : '';
}

/** 空状态：`day` 是传入时刻的北京日键，计数为 0、没有暂停。 */
export function createHeyboxState(now) {
  return { day: dayKeyOf(now), count: 0, lastTs: 0, pausedUntil: 0, pausedReason: '' };
}

/**
 * 记一次动作，返回**新对象**（不改入参，调用方写盘前可以安全地先算后写）。
 * 同日 +1，跨日重置为 1；`lastTs` 记这次的时刻；暂停标记原样带过去
 * （`pausedUntil` 是绝对时间戳，跨日后是否仍生效由 `heyboxQuota` 用 `> now` 判断）。
 *
 * `now` 非法时退回 `state.lastTs`：宁可记成「刚刚」，也不要写一个 NaN 进 usage.json。
 */
export function recordAction(state, now) {
  const previous = normalizeUsage(state);
  const at = toTimestamp(now, previous.lastTs);
  const day = dayKeyOf(at);
  return {
    day,
    count: previous.day === day ? previous.count + 1 : 1,
    lastTs: at,
    pausedUntil: previous.pausedUntil,
    pausedReason: previous.pausedReason,
  };
}

/**
 * 读 `state/heybox/usage.json` 的容错解析：接受对象或 JSON 字符串。
 * 坏 JSON / 不是对象 → `createHeyboxState(0)`；单字段类型不对则逐字段兜底（只坏一个字段
 * 不该让整份计数清零——那等于给用户凭空多发几条的机会）。
 */
export function parseUsage(raw) {
  if (isPlainObject(raw)) return normalizeUsage(raw);
  if (typeof raw !== 'string' || raw.trim() === '') return createHeyboxState(0);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createHeyboxState(0);
  }
  return isPlainObject(parsed) ? normalizeUsage(parsed) : createHeyboxState(0);
}

/** 落盘用序列化：字段顺序固定（day / count / lastTs / pausedUntil / pausedReason）。 */
export function serializeUsage(state) {
  const usage = normalizeUsage(state);
  return JSON.stringify({
    day: usage.day,
    count: usage.count,
    lastTs: usage.lastTs,
    pausedUntil: usage.pausedUntil,
    pausedReason: usage.pausedReason,
  });
}

/** CLI 错误码 → 中文可读原因（逐字定稿，MCP 层原样回给模型，模型据此跟用户解释）。 */
const CLI_ERROR_TEXTS = Object.freeze({
  auth: '小黑盒登录失效，需要重新扫码登录',
  captcha: '小黑盒要求验证码，先停一天',
  rate_limit: '小黑盒限流了，今天别再试',
  network: '连不上小黑盒',
  unknown: '小黑盒拒绝了这次操作',
});

/** stderr 文本的兜底识别：顺序即优先级 —— 验证码最具体，先判；最后才看网络。 */
const CLI_ERROR_PATTERNS = Object.freeze([
  ['captcha', /验证码|captcha|verif|challenge|risk.?control|风控/i],
  ['rate_limit', /限流|过于频繁|请求太多|太频繁|rate.?limit|too.?many|429/i],
  ['auth', /登录|登陆|未授权|鉴权|session|token|401|403|auth|log.?in/i],
  ['network', /网络|连不上|连接失败|超时|timeout|econn|enotfound|etimedout|dns|socket|reset/i],
]);

/** CLI 自己的 code 可能带连字符/大小写/近义写法，这里收敛到 4 个规范码。 */
const CLI_CODE_ALIASES = Object.freeze({
  auth: 'auth',
  auth_required: 'auth',
  unauthorized: 'auth',
  unauthenticated: 'auth',
  not_logged_in: 'auth',
  login_required: 'auth',
  token_expired: 'auth',
  captcha: 'captcha',
  captcha_required: 'captcha',
  verify: 'captcha',
  verification: 'captcha',
  challenge: 'captcha',
  risk_control: 'captcha',
  rate_limit: 'rate_limit',
  ratelimit: 'rate_limit',
  too_many_requests: 'rate_limit',
  network: 'network',
  network_error: 'network',
  timeout: 'network',
  econn: 'network',
});

function normalizeCliCode(code) {
  const key = String(code ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(CLI_CODE_ALIASES, key) ? CLI_CODE_ALIASES[key] : 'unknown';
}

/** 从 `{ok,error}` / `{code,message}` / `{error:'文本'}` 里取出 code 与 message。 */
function readErrorFields(payload) {
  const nested = isPlainObject(payload.error) ? payload.error : {};
  const code = [nested.code, payload.code]
    .find((value) => typeof value === 'string' && value.trim() !== '') ?? '';
  const message = [
    nested.message,
    payload.message,
    typeof payload.error === 'string' ? payload.error : '',
    payload.stderr,
  ].find((value) => typeof value === 'string' && value.trim() !== '') ?? '';
  return { code, message };
}

/**
 * 把 CLI 的失败翻成人话：返回 `{ code, text }`。
 *
 * 入参三种形态都吃：
 *   - `{ ok:false, error:{ code, message } }`（`-f json` 的结构化输出）→ 按 code 映射
 *   - `{ code, message }` / `{ error: '文本' }` / `{ stderr }` → 先看 code，再按文本关键词
 *   - stderr 纯文本（CLI 崩了、没输出 JSON）→ 按关键词识别
 *
 * 认不出的 code 一律收敛成 `unknown` + 通用文案：把上游的原始 code 透给模型，它只会
 * 编一个听起来合理的解释。
 */
export function describeCliError(payload) {
  let fields = { code: '', message: '' };
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed)) fields = readErrorFields(parsed);
      } catch {
        // 不是 JSON：当 stderr 文本用
      }
    }
    if (fields.code === '' && fields.message === '') fields = { code: '', message: trimmed };
  } else if (isPlainObject(payload)) {
    fields = readErrorFields(payload);
  }

  if (fields.code !== '') {
    const code = normalizeCliCode(fields.code);
    return { code, text: CLI_ERROR_TEXTS[code] };
  }
  for (const [code, pattern] of CLI_ERROR_PATTERNS) {
    if (pattern.test(fields.message)) return { code, text: CLI_ERROR_TEXTS[code] };
  }
  return { code: 'unknown', text: CLI_ERROR_TEXTS.unknown };
}

/**
 * 把 `heyboxQuota` 的 reason 翻成给人看的一句话。
 *
 * 只吃 `(reason, quota)` 两个入参：`quota.usedToday` / `remaining` / `dailyComments` /
 * `minGapMs` 都在 quota 里（所以 `heyboxQuota` 多带了后两个字段），缺了就按默认值凑 ——
 * 文案里宁可写一个近似数字，也不要给用户看 `undefined 条`。
 */
export function commentReasonText(reason, quota) {
  const info = isPlainObject(quota) ? quota : {};
  const used = toCount(info.usedToday);
  const remaining = toCount(info.remaining);
  const capRaw = toFiniteNumber(info.dailyComments);
  const cap = Number.isFinite(capRaw) && capRaw >= 0
    ? Math.trunc(capRaw)
    : (used + remaining > 0 ? used + remaining : HEYBOX_DEFAULTS.dailyComments);

  switch (reason) {
    case 'daily_cap':
      return `今天已经评论过 ${used} 条了（上限 ${cap} 条），明天再来`;
    case 'too_frequent': {
      const gapRaw = toFiniteNumber(info.minGapMs);
      const gapMs = Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw : HEYBOX_DEFAULTS.minGapMs;
      // 向上取整：间隔 90 秒时说「不到 2 分钟」才是实话，说「不到 1 分钟」是骗人。
      return `距上次评论还不到 ${Math.max(1, Math.ceil(gapMs / MINUTE_MS))} 分钟`;
    }
    case 'paused':
      return '今天被验证码拦过，先停一天';
    case 'comment_disabled':
      return '评论开关没开';
    case 'disabled':
      return '小黑盒功能没启用';
    default:
      return '现在还不能评论';
  }
}
