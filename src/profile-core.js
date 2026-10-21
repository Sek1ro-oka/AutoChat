// 机器人自助改资料（账号昵称 / 个性签名 / 群名片）的内容闸门与频率额度。
//
// 口径来自 work/agent-tasks/T-014/dev-doc.md §2（API 契约）与 research.md §2–§3：
// SnowLuma 侧对这三项既没有长度校验也没有频控，改太勤只会以 retcode 100 透出，
// 所以「能不能改、能改成什么、还能改几次」必须由桥接侧先判死。
//
// 三条硬约束（与 affect-core.js 同源）：
//   1. **纯函数**：不碰磁盘、不读系统时钟 —— `now` 一律由调用方注入（毫秒），
//      单测才能把「等 4 小时」压成一次函数调用；本文件只 import 一个纯函数模块。
//   2. **不改入参**：归一化与记账都返回新对象，桥接写成 `state = recordChange(state, …)`。
//   3. **判定集中在这里**：bridge 只做「读配置 → 调这里 → 调 OneBot → 写盘」，不自己写 if。
//
// 为什么长度按 Unicode 码点（Array.from）而不是 `.length`：昵称和签名里 emoji 很常见，
// UTF-16 会把一个 emoji 算成 2，导致「6 个 emoji」被自己的长度闸门误判成超长。
import { auditContent } from './qzone-post.js';

const HOUR_MS = 60 * 60 * 1000;

/** 三种可改的资料。顺序固定：配置归一、额度判定与状态文件都按它来。 */
export const PROFILE_KINDS = Object.freeze(['nickname', 'signature', 'groupCard']);

/**
 * 出厂额度（T-015 拍板）：**滑动窗口 4 小时 5 次** + **两次之间至少 60 秒**。
 *
 * 三种资料共用同一组窗口参数：昵称 / 签名各自独立计数，群名片按群独立计数。
 * 60 秒是「别连着改」的防抖动下限；4 小时 5 次是「别改太勤」的上限 ——
 * 资料字段最容易被别人注意到，改勤了既像被盗号也容易撞风控。
 */
const WINDOW_DEFAULTS = Object.freeze({ windowHours: 4, windowCap: 5, minGapMs: 60 * 1000 });

/**
 * 出厂配置（dev-doc §2 逐字段）。
 *
 * `enabled: true` 是用户明确要的（改自己的资料不该默认被关死）。
 */
export const PROFILE_DEFAULTS = Object.freeze({
  enabled: true,
  nickname: Object.freeze({ minChars: 2, maxChars: 12, ...WINDOW_DEFAULTS }),
  signature: Object.freeze({ minChars: 0, maxChars: 60, ...WINDOW_DEFAULTS }),
  groupCard: Object.freeze({ minChars: 0, maxChars: 20, ...WINDOW_DEFAULTS })
});

/** 头像尺寸只认这两档：research §1 只验证过 640 / 100，别的值 qlogo 不一定认。 */
export const AVATAR_SIZES = Object.freeze([640, 100]);

/**
 * 配置项的合法区间（任务书细则逐条）。越界一律钳回边界而不是回落默认：
 * 用户写 `windowCap: 999` 的意思是「想多改」，钳到 50 比偷偷改回 5 更贴近他的意图。
 */
export const PROFILE_LIMITS = Object.freeze({
  minChars: Object.freeze({ min: 0, max: 12 }),
  maxChars: Object.freeze({ min: 1, max: 60 }),
  windowHours: Object.freeze({ min: 1, max: 168 }),
  windowCap: Object.freeze({ min: 1, max: 50 }),
  // 0 是合法值（= 不设最小间隔）：白天自己连改两次不该被硬拦，写 0 就是明确要关掉它。
  minGapMs: Object.freeze({ min: 0, max: 60 * 60 * 1000 })
});

// 群名片在 QQ 侧的硬上限是 20：配置把 maxChars 放到 60 也不能越过它
// （60 是签名上限，不能顺手把群名片一起放开）。
const GROUP_CARD_MAX_CHARS = 20;
// 变更理由只留 40 字：它是给日志/面板看的一句话，不是正文。
const REASON_MAX_CHARS = 40;
// 历史值最长按 60 留（三种资料里上限最大的那种），旧配置写进来的长串不会撑爆状态文件。
const VALUE_MAX_CHARS = 60;
// 只保留最近 100 条变更：够复盘，又不会让状态文件无限长。
const MAX_CHANGES = 100;
// QQ 号：5–12 位纯数字（qlogo 只认这个形状，别的拼出来也是 404）。
const QQ_UIN_RE = /^\d{5,12}$/;
// 「有内容」的判据：至少一个字母 / 数字 / 汉字。纯 emoji、纯标点都不算。
const HAS_WORD_RE = /[\p{L}\p{N}]/u;

// ── 小工具（全部是纯函数） ──────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松取数：数字 / 非空数字字符串都认（手写 config.json 常见）；其余给 NaN。 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  }
  return Number.NaN;
}

/** 整数钳制：0 是合法数字（会被抬到 min 而不是回落默认值）。 */
function clampInt(value, spec, fallback) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(spec.max, Math.max(spec.min, Math.trunc(numeric)));
}

function codePointLength(text) {
  return Array.from(text).length;
}

function truncateByCodePoints(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * 压成单行：换行 / 制表 / 全角空格一律折成单个空格，再把残留的控制字符删掉。
 *
 * 顺序不能反：`\u000a`（换行）本身就在控制字符区间里，先删控制字符会把
 * `a\nb` 粘成 `ab`；先折空白、后删控制字符，`a\u0001b` 才是 `ab`（删掉而不是留个空格）。
 */
function sanitizeProfileText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

/**
 * 清洗并截断（dev-doc §2）。返回字符串，永不抛。
 *
 * `maxChars` 缺省取 60（三种资料里最宽的上限）：调用方漏传时宁可多留，
 * 也不要因为默认值太小把正文截成半句话。非数字 / 小于 1 同样回落 60。
 */
export function cleanProfileText(raw, opts = {}) {
  const wanted = toFiniteNumber(isPlainObject(opts) ? opts.maxChars : undefined);
  const limit = Number.isFinite(wanted) && wanted >= 1 ? Math.trunc(wanted) : PROFILE_DEFAULTS.signature.maxChars;
  return truncateByCodePoints(sanitizeProfileText(raw), limit);
}

// ── 配置归一化 ──────────────────────────────────────────────────────────────

function normalizeKindConfig(raw, dflt) {
  const source = isPlainObject(raw) ? raw : {};
  const maxChars = clampInt(source.maxChars, PROFILE_LIMITS.maxChars, dflt.maxChars);
  const minChars = clampInt(source.minChars, PROFILE_LIMITS.minChars, dflt.minChars);
  return Object.freeze({
    // minChars 不能大于 maxChars：否则「太短」和「太长」两条闸门同时成立，任何输入都会被拒，
    // 配置写错一次就再也改不了资料。
    minChars: Math.min(minChars, maxChars),
    maxChars,
    // 窗口参数同样是「越界钳到边界、坏值回落默认」：`'x'` / null / {} 都当坏值。
    // 注意 minGapMs 的 0 是**真值**（= 关掉最小间隔），clampInt 的「0 是合法数字」正好对味。
    windowHours: clampInt(source.windowHours, PROFILE_LIMITS.windowHours, dflt.windowHours),
    windowCap: clampInt(source.windowCap, PROFILE_LIMITS.windowCap, dflt.windowCap),
    minGapMs: clampInt(source.minGapMs, PROFILE_LIMITS.minGapMs, dflt.minGapMs)
  });
}

/**
 * 配置归一化：补默认 + 钳制，**永不抛**（dev-doc §2 / §6）。
 *
 * `enabled` 只有**显式 `false`** 才算关：`'false'`、`0` 这类「看起来像关」的值一律当开。
 * 这与 qzone 的「只认显式 true 才开」方向相反 —— 那边的出厂值是关，这边的出厂值是开，
 * 判断方向自然跟着默认值走。
 */
export function normalizeProfileConfig(source) {
  const raw = isPlainObject(source) ? source : {};
  return Object.freeze({
    enabled: raw.enabled !== false,
    nickname: normalizeKindConfig(raw.nickname, PROFILE_DEFAULTS.nickname),
    signature: normalizeKindConfig(raw.signature, PROFILE_DEFAULTS.signature),
    groupCard: normalizeKindConfig(raw.groupCard, PROFILE_DEFAULTS.groupCard)
  });
}

// ── 内容闸门 ────────────────────────────────────────────────────────────────

function fail(code, message, hits = []) {
  return { ok: false, reasons: [{ code, message }], hits, value: '', cleared: false };
}

/**
 * auditContent 的失败结果转成闸门的 reasons：**每条**审计理由都保留成 `{ code: 'unsafe', message }`，
 * 而不是压成一句。模型一次就能看到全部问题（链接 + 拉人话术），不用改一处被拒一次。
 */
function failFromAudit(audit) {
  const messages = Array.isArray(audit.reasons) && audit.reasons.length > 0
    ? audit.reasons
    : ['内容不合规'];
  return {
    ok: false,
    reasons: messages.map((message) => ({ code: 'unsafe', message: String(message) })),
    hits: Array.isArray(audit.hits) ? audit.hits : [],
    value: '',
    cleared: false
  };
}

function pass(value, cleared = false) {
  return { ok: true, reasons: [], hits: [], value, cleared };
}

/**
 * 三种资料共用的五步闸门（dev-doc §2）：空 → 长度 → 单行/形状 → auditContent →
 * （昵称额外的联系方式形状）。
 *
 * 为什么先判长度再截断：`cleanProfileText` 会按 maxChars 截断，若先截断再量长度，
 * 超长就永远量不出来（会被静默收货）。所以这里用**未截断**的清洗结果量长度，
 * 只有通过后才把（本来就 ≤ maxChars 的）值放进 `value`。
 *
 * `auditContent` 的 maxChars 传 2×上限：它用 UTF-16 长度判超长，而本模块用码点；
 * emoji 混排时 UTF-16 长度最多是码点的 2 倍，传 2× 才能保证「长度」不在这里被误判成 unsafe。
 */
function gateText(raw, { kind, minChars, maxChars, allowEmpty }) {
  const hadLineBreak = typeof raw === 'string' && /[\r\n]/.test(raw);
  const text = sanitizeProfileText(raw);
  if (text === '') {
    // 清除签名 / 群名片是合法操作，而且空串不占内容闸门；昵称则不能为空。
    if (allowEmpty) return pass('', true);
    return fail('empty', '不能是空的');
  }
  const length = codePointLength(text);
  if (length < minChars) return fail('too_short', `太短了，至少要 ${minChars} 个字`);
  if (length > maxChars) return fail('too_long', `太长了，最多 ${maxChars} 个字`);
  if (hadLineBreak) return fail('bad_shape', '不能有换行');
  if (!HAS_WORD_RE.test(text)) return fail('bad_shape', '不能只有表情或标点');
  const audit = auditContent(text, { maxChars: Math.max(1, maxChars * 2) });
  if (!audit.ok) return failFromAudit(audit);
  if (kind === 'nickname') {
    // 昵称是最容易被当成联系方式的字段：以数字开头、带 @、带长数字串都不像「名字」。
    if (/^\d/.test(text)) return fail('looks_like_contact', '别用数字开头');
    if (text.includes('@')) return fail('looks_like_contact', '别带 @');
    if (/\d{5,}/.test(text)) return fail('looks_like_contact', '别写成 QQ 号 / 手机号');
  }
  return pass(truncateByCodePoints(text, maxChars));
}

/**
 * 取某一项的生效配置。允许两种入参：
 * - 整块 profile 配置（`{enabled, nickname, signature, groupCard}`，桥接的正常传法）；
 * - 该种类的子配置（`{minChars, maxChars, ...}`）。
 *
 * 为什么容忍第二种：调用方手滑写 `checkSignature(text, cfg.signature)` 时，若这里
 * 强行按整块配置归一，自定义的 maxChars 会被**静默**换成默认 60 —— 排查起来像见鬼。
 */
function pickKindConfig(cfg, kind) {
  const kindKeys = ['minChars', 'maxChars', 'windowHours', 'windowCap', 'minGapMs'];
  if (isPlainObject(cfg) && kindKeys.some((key) => Object.prototype.hasOwnProperty.call(cfg, key))) {
    return normalizeKindConfig(cfg, PROFILE_DEFAULTS[kind]);
  }
  return normalizeProfileConfig(cfg)[kind];
}

function checkKind(kind, text, cfg) {
  const config = pickKindConfig(cfg, kind);
  const maxChars = kind === 'groupCard'
    ? Math.min(config.maxChars, GROUP_CARD_MAX_CHARS)
    : config.maxChars;
  return gateText(text, {
    kind,
    minChars: config.minChars,
    maxChars,
    allowEmpty: kind !== 'nickname'
  });
}

/** 昵称闸门：共用五步 + 联系方式形状（数字开头 / @ / 连续 5 位数字）。 */
export function checkNickname(text, cfg) {
  return checkKind('nickname', text, cfg);
}

/** 签名闸门：空串 = 清除签名（合法），非空按码点量长度并过同一套内容规则。 */
export function checkSignature(text, cfg) {
  return checkKind('signature', text, cfg);
}

/** 群名片闸门：空串 = 清除名片；QQ 侧 20 字是硬上限，配置放大也不越界。 */
export function checkGroupCard(text, cfg) {
  return checkKind('groupCard', text, cfg);
}

// ── 频率额度 ────────────────────────────────────────────────────────────────

function normalizeGroupId(value) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.trunc(numeric);
}

function groupKeyOf(groupId) {
  const numeric = normalizeGroupId(groupId);
  return numeric > 0 ? String(numeric) : '';
}

/**
 * 数一个滑动窗口里的成功改动次数，并带回窗口内**最早**那次的 ts。
 *
 * 窗口是 `(now - windowMs, now]`：右闭左开。左边界不含是刻意的 —— 正好 4 小时前那条
 * 必须已经滑出窗口，否则「等满 4 小时」会把人卡在原地（差 1 毫秒也算没过）。
 * 未来时间戳（时钟回拨造成）同样不算：它还没发生，不该挤占现在的额度。
 */
function windowStats(changes, kind, groupKey, at, windowMs) {
  const since = at - windowMs;
  let count = 0;
  let earliest = 0;
  for (const item of changes) {
    if (item.kind !== kind) continue;
    // 群名片按群分开数；groupKey 为空（调用方没给群号）时按全部群名片变更合并数 ——
    // 宁可少放行一次，也不能让「不带群号」变成绕过额度的后门。
    if (kind === 'groupCard' && groupKey !== '' && String(item.groupId) !== groupKey) continue;
    if (!(item.ts > since) || item.ts > at) continue;
    count += 1;
    if (earliest === 0 || item.ts < earliest) earliest = item.ts;
  }
  return { count, earliest };
}

/**
 * 现在能不能改（dev-doc §3）。纯计算，不写状态。
 *
 * 顺序：enabled → unknown_kind → too_frequent（距上次成功不足 minGapMs）→
 * window_cap（窗口内已满 windowCap 次）→ ok。最小间隔先算是因为它能给出**更准的**
 * `retryAfterMs`（几十秒后就能再试）；窗口满了要一直等到最早那次滑出窗口。
 *
 * `kind` 只有三种；传错（代码 bug，不是用户输入）时给 `unknown_kind` 而不是抛错，
 * 也绝不返回 ok:true —— 宁可拦住一次，也不能在参数错位时真去改资料。
 *
 * 返回值固定九个字段，桥接侧的 429 与 GET 快照直接拿它拼响应，不再各算一遍：
 * `{ ok, reason, retryAfterMs, windowCount, remaining, lastTs, windowHours, windowCap, minGapMs }`。
 */
export function quotaFor(state, cfg, kind, groupId, now) {
  const config = normalizeProfileConfig(cfg);
  const source = normalizeProfileState(state);
  const nowRaw = toFiniteNumber(now);
  const at = Number.isFinite(nowRaw) && nowRaw > 0 ? nowRaw : 0;
  const known = PROFILE_KINDS.includes(kind);
  const params = known ? config[kind] : null;
  const windowHours = params ? params.windowHours : 0;
  const windowCap = params ? params.windowCap : 0;
  const minGapMs = params ? params.minGapMs : 0;
  // 被 disabled / 坏参数挡住时没有任何一次计数成立：九个字段照样给齐，
  // 调用方（429 响应、快照视图）就不用为这两种分支写特例。
  const blocked = (reason) => ({
    ok: false,
    reason,
    retryAfterMs: 0,
    windowCount: 0,
    remaining: 0,
    lastTs: 0,
    windowHours,
    windowCap,
    minGapMs
  });
  if (config.enabled === false) return blocked('disabled');
  if (!known) return blocked('unknown_kind');

  const windowMs = windowHours * HOUR_MS;
  const groupKey = kind === 'groupCard' ? groupKeyOf(groupId) : '';
  // 群号缺失（私聊 / 控制台直调）时不存在「上一次改的是哪个群」：lastTs 归零 ⇒
  // 跳过最小间隔判定，计数按全部群名片合并（见 windowStats 里那条例外）。
  const last = kind === 'groupCard'
    ? (groupKey === '' ? null : source.last.groupCard[groupKey] ?? null)
    : source.last[kind];
  const lastTs = last ? last.ts : 0;
  const window = windowStats(source.changes, kind, groupKey, at, windowMs);
  const windowCount = window.count;
  const remaining = Math.max(0, windowCap - windowCount);

  if (lastTs > 0 && at - lastTs < minGapMs) {
    return {
      ok: false,
      reason: 'too_frequent',
      // 时钟回拨时 at - lastTs 是负数，等的时间会比 minGapMs 更长 —— 这是故意的：
      // 把系统时间往前拨一下不该等于解除最小间隔。
      retryAfterMs: Math.max(1, Math.ceil(minGapMs - (at - lastTs))),
      windowCount,
      remaining,
      lastTs,
      windowHours,
      windowCap,
      minGapMs
    };
  }
  if (windowCount >= windowCap) {
    return {
      ok: false,
      reason: 'window_cap',
      // 等窗口里最早那一次滑出左边界，就多出一次额度。
      retryAfterMs: Math.max(1, Math.ceil(window.earliest + windowMs - at)),
      windowCount,
      remaining: 0,
      lastTs,
      windowHours,
      windowCap,
      minGapMs
    };
  }
  return {
    ok: true,
    reason: '',
    retryAfterMs: 0,
    windowCount,
    remaining,
    lastTs,
    windowHours,
    windowCap,
    minGapMs
  };
}

// ── 状态：新建 / 修复 / 记账 / 序列化 ───────────────────────────────────────

/** 单条变更的修复：缺 ts / 坏 kind 的直接丢（这类条目对额度判定没有意义）。 */
function normalizeChangeEntry(raw, valueMaxChars = VALUE_MAX_CHARS) {
  if (!isPlainObject(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!PROFILE_KINDS.includes(kind)) return null;
  const ts = toFiniteNumber(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return {
    ts,
    kind,
    groupId: normalizeGroupId(raw.groupId),
    oldValue: cleanProfileText(raw.oldValue, { maxChars: valueMaxChars }),
    newValue: cleanProfileText(raw.newValue, { maxChars: valueMaxChars }),
    reason: truncateByCodePoints(sanitizeProfileText(raw.reason), REASON_MAX_CHARS)
  };
}

function normalizeLastEntry(raw, ceiling) {
  const source = isPlainObject(raw) ? raw : {};
  const rawTs = toFiniteNumber(source.ts);
  let ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : 0;
  // 时钟回拨 / 手改文件造出的「未来时间」会把最小间隔顶到很久以后：钳到 now 仍然保持一段间隔，
  // 只是不会因为一个 2099 年的时间戳让资料再也改不了。
  if (ceiling > 0 && ts > ceiling) ts = ceiling;
  return { ts, value: cleanProfileText(source.value, { maxChars: VALUE_MAX_CHARS }) };
}

/** 新状态：三项 last 都留空，changes 为空。`last.groupCard` 用普通对象，方便原样 JSON 落盘。 */
export function createProfileState() {
  return {
    version: 1,
    last: {
      nickname: { ts: 0, value: '' },
      signature: { ts: 0, value: '' },
      groupCard: {}
    },
    changes: []
  };
}

/**
 * 状态修复（dev-doc §3）：读文件之后、记账之前都先过这里，**永不抛**。
 *
 * `version` 固定 1：这一版只有一种结构，别的版本号只说明文件来自别的分支/手改过。
 * `changes` 按时间倒序保留最近 100 条 —— 文件可能是手改的，也可能被旧版本按正序写过，
 * 排序后再截断才确保丢掉的是最旧的那几条，而不是最前面那几条。
 */
export function normalizeProfileState(state, now) {
  const source = isPlainObject(state) ? state : {};
  const nowRaw = toFiniteNumber(now);
  const ceiling = Number.isFinite(nowRaw) && nowRaw > 0 ? nowRaw : 0;
  const rawLast = isPlainObject(source.last) ? source.last : {};
  const rawCards = isPlainObject(rawLast.groupCard) ? rawLast.groupCard : {};
  const groupCard = {};
  for (const [key, value] of Object.entries(rawCards)) {
    // 群号只认纯数字键：别的键（含手滑写进来的 'undefined'）留着只会污染额度查询。
    if (!/^\d{1,12}$/.test(key)) continue;
    const entry = normalizeLastEntry(value, ceiling);
    if (entry.ts > 0 || entry.value !== '') groupCard[key] = entry;
  }
  const changes = (Array.isArray(source.changes) ? source.changes : [])
    .map((item) => normalizeChangeEntry(item))
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_CHANGES);
  return {
    version: 1,
    last: {
      nickname: normalizeLastEntry(rawLast.nickname, ceiling),
      signature: normalizeLastEntry(rawLast.signature, ceiling),
      groupCard
    },
    changes
  };
}

/**
 * 记一次**成功**的改动（失败绝不调用它，dev-doc §3：失败不记账）。
 *
 * 先归一化（等价于深拷贝）再写：桥接那边是 `state = recordChange(state, …)`，即便
 * 某个分支忘了回写，也不会出现「内存里改了、盘上没改」的半截状态。
 *
 * `reason` 只留 40 字（它会进日志与面板）；群名片按群号分别记 `last.groupCard`，
 * 群号缺失（0）时只记进 changes、不写 last —— 没有群号就无从判断最小间隔该套给哪个群。
 */
export function recordChange(state, change, cfg) {
  const config = normalizeProfileConfig(cfg);
  const base = normalizeProfileState(state);
  if (!isPlainObject(change)) return base;
  const kind = typeof change.kind === 'string' ? change.kind.trim() : '';
  if (!PROFILE_KINDS.includes(kind)) return base;
  const ts = toFiniteNumber(change.ts);
  if (!Number.isFinite(ts) || ts <= 0) return base;
  const params = config[kind];
  const valueMaxChars = kind === 'groupCard'
    ? Math.min(params.maxChars, GROUP_CARD_MAX_CHARS)
    : params.maxChars;
  const entry = normalizeChangeEntry({ ...change, ts, kind }, valueMaxChars);
  if (entry === null) return base;

  const last = { ...base.last };
  if (kind === 'groupCard') {
    if (entry.groupId > 0) {
      last.groupCard = { ...base.last.groupCard, [String(entry.groupId)]: { ts, value: entry.newValue } };
    }
  } else {
    last[kind] = { ts, value: entry.newValue };
  }
  return {
    version: 1,
    last,
    changes: [entry, ...base.changes].slice(0, MAX_CHANGES)
  };
}

/**
 * 落盘用序列化（紧凑 JSON，一行一个文件）。NaN / Infinity 会被 JSON 写成 null，
 * 这里统一换成 0 —— 读回来 `normalizeProfileState` 再兜一次，坏文件不会把桥接弄挂。
 */
export function serializeProfileState(state) {
  return JSON.stringify(state ?? null, (key, value) => (
    typeof value === 'number' && !Number.isFinite(value) ? 0 : value
  ));
}

/**
 * 解析状态文件。坏 JSON / 空文件 / 非对象 → **出厂新状态**（不是 null）：
 * 调用方拿到的一定是个能直接用的 state，少一个「你是不是忘了判空」的分支。
 */
export function parseProfileState(text) {
  if (typeof text !== 'string' || text.trim() === '') return createProfileState();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return createProfileState();
  }
  if (!isPlainObject(parsed)) return createProfileState();
  return normalizeProfileState(parsed);
}

// ── 头像地址 ────────────────────────────────────────────────────────────────

/**
 * qlogo 头像直链（research §1：WebUI 服务端也是这么拼的，不需要 cookie/gtk）。
 *
 * uin 形状不对直接返回空串：拼一个 404 链接给 `<img>`，比明确说「这不是 QQ 号」更难查。
 * `size` 只认 640 / 100，其余（含查询串里的 '300'）回落 640 —— 640 失败时桥接会自己再用 100 重试。
 */
export function avatarUrl(uin, size = 640) {
  const qq = typeof uin === 'number'
    ? (Number.isSafeInteger(uin) ? String(uin) : '')
    : (typeof uin === 'string' ? uin.trim() : '');
  if (!QQ_UIN_RE.test(qq)) return '';
  const sizeRaw = typeof size === 'number' ? size : toFiniteNumber(size);
  const picked = AVATAR_SIZES.includes(sizeRaw) ? sizeRaw : 640;
  return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=${picked}`;
}
