// QQ 空间说说闸门的纯逻辑：配置归一化 / 内容审计 / 配额判定 / 可见范围挑选 / 记录裁剪。
//
// 为什么单独成文件：三道闸门（开关、审计、频率）必须在**不启动桥接、不连接 QQ** 的前提下能被
// 反复验证。桥接只负责「读配置 → 调这里的函数 → 调 OneBot → 写记录」，判断全在本文件，
// 所以本文件不 import 任何模块、不碰文件与网络、时间由调用方以 `now` 注入（毫秒时间戳）。
//
// 与 src/sensitive.js 的关系：那里是**日志/回复脱敏**的口径（本机路径、token= 赋值形态），
// 与社交内容审核完全不同 —— 拿去审核说说会既漏（手机号、裸域名都不匹配）又误伤（正常提到路径
// 就拦）。所以审计规则在这里独立实现，不复用那边的正则。

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// 空间自然日按 Asia/Shanghai（UTC+8）算：QQ 空间的「今天」在北京时间零点切，
// 而服务器可能跑在别的时区（本机就是 UTC+8，但不能依赖这一点）。
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
// 单条命中片段最多回显这么多字：够定位，又不会把整段正文再复制一遍到日志/工具返回里。
const MAX_HIT_TEXT_CHARS = 40;

/** 出厂默认值：`enabled:false`（不启用）、`ugcRight:4`（好友可见，不是所有人可见）。 */
export const QZONE_DEFAULTS = Object.freeze({
  enabled: false,
  adminQQ: Object.freeze([]),
  minIntervalMs: 6 * HOUR_MS,
  dailyCap: 2,
  ugcRight: 4,
  maxChars: 300,
});

/**
 * v1 只认这三档：1 所有人 / 4 好友 / 64 仅自己。
 * 16（部分好友可见）与 128（部分好友不可见）都必须带 `target_uins`，而 v1 不采集好友 uin 列表，
 * 让它们可配置等于允许「部分可见却没指定谁」这种不可用状态 —— 所以一律回落 4。
 */
export const QZONE_UGC_RIGHTS = Object.freeze([1, 4, 64]);

/** clamp 区间：`minIntervalMs` 一分钟都不能让用户配到 0（那是「不限频」），最高 7 天。 */
export const QZONE_LIMITS = Object.freeze({
  minIntervalMs: Object.freeze([HOUR_MS, 7 * DAY_MS]),
  dailyCap: Object.freeze([1, 10]),
  maxChars: Object.freeze([50, 1000]),
});

/**
 * 审计理由的人话文案（逐字定稿，工具层原样回给模型，模型据此跟用户解释）。
 * 键是规则 id；`length` 分空/超长两句。
 */
export const QZONE_AUDIT_REASONS = Object.freeze({
  empty: '空的发什么',
  tooLong: '太长了，空间里没人看小作文',
  url: '带链接等于帮人打广告',
  phone: '别把手机号贴出去',
  email: '邮箱也别留',
  idcard: '证件号绝对不行',
  solicit: '别在空间里拉人',
});

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把配置里的值转成有限数字：数字直接用，纯数字字符串（如 `"300"`）也接受，
 * 布尔/空串/对象/NaN/Infinity 一律当「没给」—— 注意 `true` 不能被当成 1。
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
 * 整数 clamp：数字 → 取整后夹到区间（0 会被抬到下限，不回落默认值，
 * 因为「0」是用户明确表达的一个意图，抬到安全下限比静默改成默认值更可预期）；
 * 非数字 → 默认值。
 */
function clampInt(value, bounds, fallback) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds[1], Math.max(bounds[0], Math.trunc(n)));
}

/** 非整数量的 clamp（目前只用于 `minIntervalMs`，保留小数毫秒没有意义但也不必强制取整）。 */
function clampNumber(value, bounds, fallback) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds[1], Math.max(bounds[0], n));
}

/**
 * 可见范围：`1|4|64` 原样保留，其他（16、128、3、字符串、布尔、缺省）一律回落 4。
 * 注意这里**不信任** `Number(true) === 1` 这种转换：把 `true` 当成「所有人可见」是最坏的错法。
 */
function toUgcRight(value) {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  return QZONE_UGC_RIGHTS.includes(n) ? n : QZONE_DEFAULTS.ugcRight;
}

/** 管理员名单：只留正整数 QQ 号，去重并按数值升序。返回冻结数组（调用方要替换而不是原地 push）。 */
function normalizeAdminQQ(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const kept = new Set();
  for (const item of value) {
    if (typeof item !== 'number') continue;
    if (!Number.isSafeInteger(item) || item <= 0) continue;
    kept.add(item);
  }
  return Object.freeze([...kept].sort((a, b) => a - b));
}

/**
 * 把 `config.json` 里的 `qzone` 块归一化成可直接使用的冻结对象。
 * 任何脏值都不抛错：缺省/非对象 → 全默认；数字类字段 clamp 到 `QZONE_LIMITS`。
 */
export function normalizeQzoneConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.freeze({
    enabled: source.enabled === true,
    adminQQ: normalizeAdminQQ(source.adminQQ),
    minIntervalMs: clampNumber(source.minIntervalMs, QZONE_LIMITS.minIntervalMs, QZONE_DEFAULTS.minIntervalMs),
    dailyCap: clampInt(source.dailyCap, QZONE_LIMITS.dailyCap, QZONE_DEFAULTS.dailyCap),
    ugcRight: toUgcRight(source.ugcRight),
    maxChars: clampInt(source.maxChars, QZONE_LIMITS.maxChars, QZONE_DEFAULTS.maxChars),
  });
}

// ── 内容审计 ────────────────────────────────────────────────────────────────
// 每条规则都独立判定并**收集全部命中**（不短路）：模型一次就能看到所有问题，
// 而不是改掉一处再被拒一次。

const URL_KEYWORDS = ['http://', 'https://', 'www.', 't.cn', 'b23.tv'];
const URL_KEYWORD_RE = new RegExp(URL_KEYWORDS.map(escapeRe).join('|'), 'gi');
// 裸域名：只认常见后缀，且后缀后面必须是词边界（`3.14`、`1.5 小时` 这种不该命中）。
const BARE_DOMAIN_RE = /[a-z0-9-]+\.(?:com|cn|net|org|io|me|xyz)\b/gi;
// 手机号：前后都不能紧邻数字，避免把更长的号码串误报成手机号。
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
// 证件号：15 位纯数字，或 17 位数字 + 校验位（数字或 X）；同样要求前后不紧邻数字。
const IDCARD_RE = /(?<!\d)(?:\d{15}|\d{17}[\dXx])(?!\d)/g;
const SOLICIT_WORDS = ['加群', '拉群', '扫码', '私聊我', '加我', '进群'];
const SOLICIT_RE = new RegExp(SOLICIT_WORDS.map(escapeRe).join('|'), 'g');

/**
 * 用全新副本执行带 g 标志的正则：模块级正则若共享 `lastIndex`，
 * 并发/嵌套调用会漏匹配（本模块虽然同步，但没必要留这个坑）。
 */
function collectMatches(re, text) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  let m = rx.exec(text);
  while (m !== null) {
    out.push({ index: m.index, text: m[0] });
    if (m[0] === '') rx.lastIndex += 1; // 空匹配保护
    m = rx.exec(text);
  }
  return out;
}

/** 同一位置只留一条命中（同一个 `www.qq.com` 会同时命中关键字 `www.` 与裸域名），保留更长的片段。 */
function dedupeByIndex(matches) {
  const byIndex = new Map();
  for (const m of matches) {
    const seen = byIndex.get(m.index);
    if (!seen || m.text.length > seen.text.length) byIndex.set(m.index, m);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function urlMatches(body) {
  return dedupeByIndex([...collectMatches(URL_KEYWORD_RE, body), ...collectMatches(BARE_DOMAIN_RE, body)]);
}

/**
 * 社交内容审计：返回 `{ ok, reasons, hits }`，`ok === (reasons.length === 0)`。
 * - `hits`：`{ rule, index, text }`，`index` 是命中位置在**去掉首尾空白后的正文**里的下标，
 *   `text` 是原文片段（最长 40 字）。
 * - `reasons`：按规则表的顺序去重后的人话理由，可直接拼给模型/用户看。
 *
 * `maxChars` 只影响 `length` 规则；缺省/非法值取 `QZONE_DEFAULTS.maxChars`。
 */
export function auditContent(text, { maxChars } = {}) {
  const body = String(text ?? '').trim();
  const limitRaw = toFiniteNumber(maxChars);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.trunc(limitRaw) : QZONE_DEFAULTS.maxChars;

  const reasons = [];
  const hits = [];
  const addHit = (rule, index, fragment, reason) => {
    hits.push({ rule, index: Math.max(0, Math.trunc(index)), text: String(fragment ?? '').slice(0, MAX_HIT_TEXT_CHARS) });
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  // ① length（空 / 超长互斥，只可能命中一个）
  if (body.length === 0) addHit('length', 0, '', QZONE_AUDIT_REASONS.empty);
  else if (body.length > limit) addHit('length', 0, body, QZONE_AUDIT_REASONS.tooLong);

  // ② url
  for (const m of urlMatches(body)) addHit('url', m.index, m.text, QZONE_AUDIT_REASONS.url);

  // ③ phone
  for (const m of collectMatches(PHONE_RE, body)) addHit('phone', m.index, m.text, QZONE_AUDIT_REASONS.phone);

  // ④ email
  for (const m of collectMatches(EMAIL_RE, body)) addHit('email', m.index, m.text, QZONE_AUDIT_REASONS.email);

  // ⑤ idcard
  for (const m of collectMatches(IDCARD_RE, body)) addHit('idcard', m.index, m.text, QZONE_AUDIT_REASONS.idcard);

  // ⑥ solicit
  for (const m of collectMatches(SOLICIT_RE, body)) addHit('solicit', m.index, m.text, QZONE_AUDIT_REASONS.solicit);

  hits.sort((a, b) => a.index - b.index);
  return { ok: reasons.length === 0, reasons, hits };
}

// ── 频率闸门 ────────────────────────────────────────────────────────────────

/** 北京时间的自然日键（`YYYY-MM-DD`）：把时间戳平移到 UTC+8 再用 ISO 切片。 */
function shanghaiDayKey(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 距下一个北京时间 00:00 的毫秒数（落在 `(0, 24h]`；正好在零点时返回 24h）。 */
function msUntilNextShanghaiMidnight(ms) {
  const shifted = ms + SHANGHAI_OFFSET_MS;
  const nextDayStart = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS;
  return Math.max(1, nextDayStart - shifted);
}

/**
 * 发布配额判定（纯计算，不写任何状态）：
 *   ① 今天（Asia/Shanghai 自然日）已发条数 ≥ `dailyCap` → `daily_cap`，`retryAfterMs` 到次日零点；
 *   ② 最近一条距今 < `minIntervalMs` → `interval`，`retryAfterMs` 是还差多少；
 *   ③ 否则放行。
 *
 * 注意顺序：先判每日上限再判间隔 —— 两条上限都已打满时，模型该被告知的是「今天没额度」，
 * 而不是「再等 3 小时」，否则它会一直等一个永远不会来的额度。
 *
 * `posts` 可以是 `state/qzone-posts.json` 的 `posts` 数组，也可以直接传整个 state 对象（容错）。
 * 脏数据（缺 `createdAt`、非数字）不参与计数，也不会抛错。
 * `now` 由调用方注入（I/O 层传 `Date.now()`），本模块不读系统时钟。
 */
export function checkQuota({ now, posts, cfg } = {}) {
  const nowRaw = toFiniteNumber(now);
  const config = normalizeQzoneConfig(cfg);
  const list = Array.isArray(posts) ? posts : (posts && Array.isArray(posts.posts) ? posts.posts : []);
  const latestAt = list.reduce((max, post) => {
    const createdAt = toFiniteNumber(post && post.createdAt);
    return Number.isFinite(createdAt) && createdAt > 0 && createdAt > max ? createdAt : max;
  }, 0);
  // `now` 必须由调用方注入（I/O 层传 Date.now()）。缺省时退化为「最近一条的时刻」而不是读系统
  // 时钟：纯函数的返回值只能取决于入参，否则单测就会随运行时刻漂移。
  const at = Number.isFinite(nowRaw) && nowRaw > 0 ? nowRaw : latestAt;
  const todayKey = shanghaiDayKey(at);

  let todayCount = 0;
  for (const post of list) {
    const createdAt = toFiniteNumber(post && post.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) continue;
    if (shanghaiDayKey(createdAt) === todayKey) todayCount += 1;
  }

  if (todayCount >= config.dailyCap) {
    return { ok: false, reason: 'daily_cap', retryAfterMs: msUntilNextShanghaiMidnight(at), todayCount };
  }

  if (latestAt > 0) {
    const elapsed = at - latestAt;
    if (elapsed < config.minIntervalMs) {
      return { ok: false, reason: 'interval', retryAfterMs: Math.max(0, config.minIntervalMs - elapsed), todayCount };
    }
  }

  return { ok: true, reason: null, retryAfterMs: 0, todayCount };
}

/** 可见范围：配置里是 1/4/64 就用它，其余（含 16/128/缺省）回落 4（好友可见）。 */
export function pickUgcRight(cfg) {
  const value = cfg && typeof cfg === 'object' ? cfg.ugcRight : undefined;
  return toUgcRight(value);
}

/**
 * 裁剪发布记录：丢掉没有 `createdAt` 的脏数据，按 `createdAt` 倒序保留前 `keep` 条。
 * 返回新数组（不改调用方的数组、也不改记录对象）；`keep` 缺省 50。
 */
export function prunePosts(posts, keep = 50) {
  const list = Array.isArray(posts) ? posts : [];
  const keepRaw = toFiniteNumber(keep);
  const limit = Number.isFinite(keepRaw)
    ? Math.min(10000, Math.max(0, Math.trunc(keepRaw)))
    : 50;

  const dated = [];
  for (const post of list) {
    const createdAt = toFiniteNumber(post && post.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    dated.push({ post, createdAt });
  }
  dated.sort((a, b) => b.createdAt - a.createdAt);
  return dated.slice(0, limit).map((entry) => entry.post);
}
