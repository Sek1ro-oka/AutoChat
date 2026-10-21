// 平板授权（T-024）：**管理员先说一句「去玩平板」，agent 才能玩平板**。
//
// 为什么单独一个纯函数模块：授权是平板能力的**第二道闸门**（第一道是
// `src/device-core.js` 的预算），它要在两个进程里用同一套规则：
// - 桥接（`src/bridge.js`）听管理员的话，落 `state/device-grant.json`（唯一写入方）；
// - MCP 工具层（`src/device-tools.js`）每个工具入口读这份文件，没有有效授权就直接
//   `not_granted`，**不碰 adb、不记步**。
//
// 约定（与 device-core 同口径）：
// - 零 I/O、零依赖，文件长什么样由调用方读好再传进来；
// - 时钟由调用方注入（`now` 是毫秒时间戳），所以「过期 / 撤销」这类时间规则不依赖
//   系统时钟也能被单测钉住；
// - 永不抛：脏输入一律归一成「没有授权」——fail-closed，宁可多问管理员一句，
//   也不能因为一个坏字段把闸门判成打开。
const MINUTE_MS = 60 * 1000;

/** 授权文件（桥接写、工具层读）。两侧必须逐字一致，所以只在这里定义一次。 */
export const DEVICE_GRANT_FILE = 'device-grant.json';

/** 时长 / 步数的允许区间与缺省值。分钟钳制 5–120：少于 5 分钟还没坐稳就过期了。 */
export const GRANT_LIMITS = Object.freeze({ minMinutes: 5, maxMinutes: 120, maxSteps: 600 });
export const GRANT_DEFAULTS = Object.freeze({ minutes: 30, steps: 60 });

/**
 * 未授权时给模型看的一句话。
 *
 * 必须说清「**谁**在**哪里**做什么」：模型收到 `not_granted` 之后最容易犯的错是换个坐标
 * 再点一次，或跟群友讨价还价。所以文案点名「管理员」+「在 QQ 里」+「说去玩平板」。
 */
export const NOT_GRANTED_MESSAGE = '现在没有玩平板的授权：要管理员在 QQ 里说一句「去玩平板」（可以带分钟数，例如「去玩平板 20 分钟」）才会放行。';

// ── 小工具 ──────────────────────────────────────────────────────────────────
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 正整数计数：非有限 / ≤0 / 非数字一律 0（`revokedAt: 0` 就是「没撤销」）。 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 毫秒时间戳：接受数字、Date、数字字符串；其它给 NaN（由调用方判「没给」）。 */
function toMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? Math.trunc(value.getTime()) : NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  }
  return NaN;
}

/** QQ 号归一：数字 / 数字字符串都可以，其它给 `null`（宁可不认，也不认错人）。 */
function normalizeQq(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 授权时长：缺省 30 分钟，给了就钳到 5–120（小数向下取整）。 */
function clampMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return GRANT_DEFAULTS.minutes;
  const int = Math.trunc(n);
  if (int <= 0) return GRANT_DEFAULTS.minutes;
  return Math.min(GRANT_LIMITS.maxMinutes, Math.max(GRANT_LIMITS.minMinutes, int));
}

/** 本轮步数上限：缺省 60，钳到 1–600（它只是「这一轮建议别超过」，硬闸门仍是日预算）。 */
function clampSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return GRANT_DEFAULTS.steps;
  const int = Math.trunc(n);
  if (int <= 0) return GRANT_DEFAULTS.steps;
  return Math.min(GRANT_LIMITS.maxSteps, int);
}

/**
 * 意图文本归一：全角转半角、去掉所有空白与标点、CQ 码清掉。
 *
 * 为什么连标点一起去掉：群里的口令常写成「好，去玩平板 20 分钟」「去玩平板~」，
 * 标点不该影响判定；而「一句话里有两个意图」由下面的**整句锚定**兜住
 * （拼接后的句子对不上任何一条完整口令，自然判 null）。
 */
function normalizeIntentText(text) {
  if (typeof text !== 'string') return '';
  let s = text.normalize('NFKC');
  s = s.replace(/\[CQ:[^\]]*\]/g, ' ');
  s = s.replace(/[\s\u00a0\u3000]+/g, '');
  s = s.replace(/[，。！？、；：,.!?;:~～…—\-"'“”‘’()（）【】\[\]<>《》]+/g, '');
  return s;
}

// ── 口令 ────────────────────────────────────────────────────────────────────
// 授权：整句必须是「(去)玩(会儿/一下)平板 (+ N 分钟)」这一种形状。
// `@[^@]{0,24}?` 是可选的「@某人」前缀（群消息里 @樰 去玩平板 很常见）；
// 用惰性量词，前缀只吃到命令开头就停，不会把整句话吞掉。
const GRANT_RE = /^(?:@[^@]{0,24}?)?(?:那|好|嗯|行|ok)?你?(?:现在|今天|这就|就|先|可以)?(?:去)?(?:玩玩|玩|耍)(?:一会儿|一会|会儿|一下|下)?(?:平板|pad)(?:吧|呗|啊|呀|哈|哦|咯)?(?:(?:就|玩|总共|大概|最多|给)?(\d{1,3})(?:分钟|分|min(?:ute)?s?|m))?(?:吧|呗|啊|呀|哈|哦|咯)?$/;

// 撤销：三种都能独立成句——「别玩了 / 先别玩 / 不玩了」、「回来(吧)」、「停下 / 停下来」。
// 注意「回来」只认裸句：管理员说「我回来啦」是陈述「我回来了」，不是喊机器人回来。
const REVOKE_PLAY_RE = /^(?:@[^@]{0,24}?)?(?:那|好|嗯|行)?你?(?:先|快|赶紧|现在|马上)?(?:别|不要|不用|不许|甭|不)(?:再)?(?:玩玩|玩|耍)(?:平板|pad)?(?:了|啦|了啊|了哦|了吧)?$/;
const REVOKE_BACK_RE = /^(?:@[^@]{0,24}?)?(?:你|快点|快|赶紧|先)?回来(?:吧|呀|啊|哦)?$/;
const REVOKE_STOP_RE = /^(?:@[^@]{0,24}?)?(?:先|快|赶紧|马上)?(?:停|停下|停下来|停一下|打住|住手|暂停)(?:吧|呀|啊|了)?$/;

// 「短句」的上限：口令是**一句话的事**，掺了别的诉求就不该被当成授权。
const GRANT_MAX_CHARS = 32;
const REVOKE_MAX_CHARS = 14;

// ── 意图解析 ────────────────────────────────────────────────────────────────
/**
 * 把一条消息解析成授权意图（**纯文本判断，不管发送者是谁**）。
 *
 * 权限判断在桥接侧（只有管理员集合里的人说才算），这样本模块不用知道 cfg，
 * 也能被单测穷举各种说法而不掺权限。
 *
 * 返回：
 * - `{ action: 'grant', minutes }`：认到「去玩平板」一类口令，`minutes` 已钳到 5–120
 *   （没说时长就是 30）；
 * - `{ action: 'revoke' }`：认到「别玩了 / 不玩了 / 回来 / 停下 / 先别玩」一类口令；
 * - `{ action: null }`：普通聊天（**绝大多数消息都走这里**）。
 *
 * 为什么整句锚定、还要限长：群友聊天里「我回来啦」「刚刚玩了会儿平板」满地都是，
 * 宽松的「包含关键词」会把它们全变成授权/撤销。
 */
export function parseGrantIntent(text) {
  const s = normalizeIntentText(text);
  if (s === '') return { action: null };

  if (s.length <= GRANT_MAX_CHARS) {
    const matched = GRANT_RE.exec(s);
    if (matched) {
      // `matched[1]` 是分钟数；没写就取缺省 30（`clampMinutes(undefined)` 会给 30）。
      return { action: 'grant', minutes: clampMinutes(matched[1]) };
    }
  }
  if (s.length <= REVOKE_MAX_CHARS) {
    if (REVOKE_PLAY_RE.test(s) || REVOKE_BACK_RE.test(s) || REVOKE_STOP_RE.test(s)) {
      return { action: 'revoke' };
    }
  }
  return { action: null };
}

// ── 授权对象 ────────────────────────────────────────────────────────────────
/**
 * 造一份新授权（**不改时间戳之外的任何东西**，也绝不读时钟）。
 *
 * 文件形状（固定七个键，方便手看也方便断言）：
 * `{ grantedBy, viaKey, grantedAt, expiresAt, minutes, steps, revokedAt }`
 * - `grantedBy`：授权人的 QQ 号（数字；认不出来就是 null —— 桥接只在管理员消息上调用，
 *   正常不会是 null）；
 * - `viaKey`：在哪个会话里说的（`private:123` / `group:456`），出问题时要能回溯；
 * - `revokedAt: 0`：没撤销。撤销是**改这个字段**，不是删文件（要留痕）。
 */
export function createGrant(now, { grantedBy = null, viaKey = '', minutes, steps } = {}) {
  const at = toMs(now);
  const base = Number.isFinite(at) ? at : 0;
  const mins = clampMinutes(minutes);
  const cap = clampSteps(steps);
  return {
    grantedBy: normalizeQq(grantedBy),
    viaKey: typeof viaKey === 'string' ? viaKey.trim().slice(0, 120) : '',
    grantedAt: base,
    expiresAt: base + mins * MINUTE_MS,
    minutes: mins,
    steps: cap,
    revokedAt: 0,
  };
}

/**
 * 读回来的容错解析：接受对象或 JSON 字符串。
 *
 * 坏 JSON / 不是对象 / 字段类型不对 → 逐字段兜底成「空授权」（`expiresAt: 0`，永远判过期）。
 * 永不抛：一个坏文件不能让八个工具全部变成 500，只能是「没授权」。
 */
export function parseGrant(raw) {
  let source = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      source = null;
    }
  }
  if (!isPlainObject(source)) source = {};
  return {
    grantedBy: normalizeQq(source.grantedBy),
    viaKey: typeof source.viaKey === 'string' ? source.viaKey.trim().slice(0, 120) : '',
    grantedAt: toCount(source.grantedAt),
    expiresAt: toCount(source.expiresAt),
    minutes: clampMinutes(source.minutes),
    steps: clampSteps(source.steps),
    revokedAt: toCount(source.revokedAt),
  };
}

/**
 * 现在这份授权还算不算数（纯判断，不改入参）。
 *
 * 规则只有两条，但**顺序固定**：先看撤销（撤销是人的决定，一旦发生就不再翻案），
 * 再看是否过期（`expiresAt <= now` 就算过期 —— 边界上不允许「最后一毫秒再点一下」）。
 * `now` 不是合法时间戳时一律判**无效**（fail-closed：判不了就当没有）。
 */
export function isGrantActive(grant, now) {
  const parsed = parseGrant(grant);
  const at = toMs(now);
  if (!Number.isFinite(at)) return false;
  if (parsed.revokedAt > 0) return false;
  return parsed.expiresAt > at;
}

/** 还能玩多少毫秒：没有有效授权就是 0（不返回负数）。 */
export function grantRemainingMs(grant, now) {
  const parsed = parseGrant(grant);
  const at = toMs(now);
  if (!isGrantActive(parsed, at)) return 0;
  return Math.max(0, parsed.expiresAt - at);
}

/**
 * 撤销：返回**新对象**，不改入参。
 *
 * 已经撤销过的不覆盖第一次的时间（第一次撤销才是有意义的那一刻）；
 * `now` 非法时保留原值，绝不写 NaN 进文件。
 */
export function revokeGrant(grant, now) {
  const parsed = parseGrant(grant);
  const at = toMs(now);
  const revokedAt = Number.isFinite(at) && at > 0 ? Math.trunc(at) : parsed.revokedAt;
  return { ...parsed, revokedAt: parsed.revokedAt > 0 ? parsed.revokedAt : revokedAt };
}

/**
 * 给人看的一句话 + 剩余分钟（prompt、日志、status 回执共用同一份文案来源）。
 *
 * 返回 `{ active, reason, grantedBy, minutes, steps, leftMinutes, expiresAt, revokedAt, text }`：
 * - `reason` 是 `active` / `revoked` / `expired` / `missing` / `unknown`（时间戳坏了）；
 * - `leftMinutes` 向上取整（还能玩 14 分 10 秒 → 说 15 分钟；乐观但不撒谎），
 *   没有有效授权时是 0。
 */
export function grantSummary(grant, now) {
  const parsed = parseGrant(grant);
  const at = toMs(now);
  const hasNow = Number.isFinite(at);
  let reason;
  if (parsed.revokedAt > 0) reason = 'revoked';
  else if (parsed.expiresAt <= 0) reason = 'missing';
  else if (!hasNow) reason = 'unknown';
  else if (parsed.expiresAt > at) reason = 'active';
  else reason = 'expired';

  const active = reason === 'active';
  const leftMinutes = active ? Math.ceil((parsed.expiresAt - at) / MINUTE_MS) : 0;
  const who = parsed.grantedBy === null ? '管理员' : `管理员（${parsed.grantedBy}）`;
  let text;
  switch (reason) {
    case 'active':
      text = `${who}授权玩平板 ${parsed.minutes} 分钟，还剩 ${leftMinutes} 分钟`;
      break;
    case 'revoked':
      text = `这次平板授权已经被撤销了（原定 ${parsed.minutes} 分钟）`;
      break;
    case 'expired':
      text = `这次平板授权已经过期了（原定 ${parsed.minutes} 分钟）`;
      break;
    case 'unknown':
      text = '平板授权状态读不出来（时间戳不对），按没有授权处理';
      break;
    default:
      text = '还没有管理员授权玩平板';
      break;
  }
  return {
    active,
    reason,
    grantedBy: parsed.grantedBy,
    minutes: parsed.minutes,
    steps: parsed.steps,
    leftMinutes,
    expiresAt: parsed.expiresAt,
    revokedAt: parsed.revokedAt,
    text,
  };
}
