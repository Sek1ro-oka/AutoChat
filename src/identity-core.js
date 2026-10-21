// 名字映射表（好友 / 群 / 群成员的名字、号码与最近活跃时间）的纯逻辑内核。
//
// 口径来自 work/agent-tasks/T-018/dev-doc.md（§二 配置、§三 状态文件、§四 纯函数 API）。
// 这张表要回答两个问题：「这个号码叫什么」和「叫这个名字的号码是几号」。
// 读写在下面全部实现完，桥接只负责「什么时候拉列表 / 什么时候写盘」。
//
// 三条硬约束（与 src/cross-core.js 同一套口径）：
//   1. **不碰 IO、不读系统时钟**：`at` 一律由调用方传毫秒。名字表的刷新是定时任务，
//      单测里不可能真等六小时；时间注入之后，「十天没说话的好友被淘汰」这种断言
//      就只是十几次函数调用。本文件连 import 都没有（不需要 fs / path），
//      `node --check` 就能过。
//   2. **脏输入不抛**：null / 'x' / [] / 手改坏的状态文件一律「回落默认或跳过」。
//      这个模块跑在每条消息的入口路径上（增量 upsert），抛一次就会让桥接停摆。
//   3. **只有 upsert* / apply* 就地改 state**，其余导出函数只读入参、返回新对象。
//      整表合并每来一份列表过成百上千条，逐条复制整张表不现实；而
//      identityKey / lookupIdentity / identityPromptBlock 是「读一眼就渲染」，
//      必须能随便调、不改坏状态。
//
// 单位约定：时间一律毫秒；号码（QQ / 群号）一律纯数字字符串；
// `name` 永远单行、无控制字符、最多 40 个字符（按 code point 数，不是 UTF-16）。

// ── 常量与出厂配置（dev-doc §二） ───────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 名字长度上限（dev-doc §三：「名字一律 … 最多 40 字」）。 */
const NAME_MAX = 40;

/** 号码形态：纯数字、最多 20 位。QQ 号最长 11 位，20 位是留给「别把脏数据当号码」的余量。 */
const ID_RE = /^\d{1,20}$/;

/** 会话 key 的唯一合法形态，与 src/cross-core.js:46、src/diary-store.js 保持一致。 */
const KEY_RE = /^(group|private):(\d{1,20})$/;

/** 私聊条目的来源：好友列表（权威）/ 消息里见到（最弱）。 */
const SOURCE_FRIEND = 'friend';
const SOURCE_MESSAGE = 'message';

/** 提示词里最多列几个最近说话的人（dev-doc §四：speakerLimit 默认 8）。 */
const SPEAKER_DEFAULT_LIMIT = 8;
const SPEAKER_LIMIT_MAX = 50;

// 打分（dev-doc §四 lookupIdentity）：号码 / 名字完全相等 100，前缀 60，包含 40，
// 群成员的名字命中再 +5。为什么要给成员加分：群名片和好友备注重名是常态
// （「小明」满天下），此时用户更可能是在找「刚才在群里说话的那个人」，
// 加权能让成员行挤进 limit 之内，而不是被一堆同名的私聊好友挤掉。
const SCORE_HIT = 100;
const SCORE_PREFIX = 60;
const SCORE_CONTAINS = 40;
const SCORE_MEMBER_BONUS = 5;

/**
 * 出厂配置：`enabled: true` 是用户明确要的「出厂即开」（dev-doc §二）。
 * 冻结：这份对象会被 normalizeIdentityConfig 当回落值反复读，运行期被谁改一笔
 * 就会让「明明没配置却开始拉好友列表」变得无法解释。
 */
export const IDENTITY_DEFAULTS = Object.freeze({
  enabled: true,
  refreshIntervalMs: 6 * HOUR_MS,
  maxFriends: 1000,
  maxGroups: 200,
  maxGroupMembers: 2000,
  queryLimit: 20
});

/**
 * 各项合法区间：`refreshIntervalMs` 30 分钟–7 天（比 30 分钟更勤就是白烧 QQ 接口，
 * 比 7 天更懒则名字表基本没用）；`maxFriends` 10–10000、`maxGroups` 1–500、
 * `maxGroupMembers` 0–20000（0 合法：代表「一个成员都不存」，与 profile-core 的
 * 0 值合法口径一致）；`queryLimit` 1–50。
 *
 * 超界一律钳制，不报错 —— 配置是用户手写的，写错不该让服务起不来。
 */
export const IDENTITY_LIMITS = Object.freeze({
  refreshIntervalMs: Object.freeze([30 * MINUTE_MS, 7 * DAY_MS]),
  maxFriends: Object.freeze([10, 10000]),
  maxGroups: Object.freeze([1, 500]),
  maxGroupMembers: Object.freeze([0, 20000]),
  queryLimit: Object.freeze([1, 50])
});

// ── 小工具（全是纯函数，且永不对坏输入抛错） ────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松取数：数字 / 非空数字字符串都认；其余（含 NaN、Infinity、'x'、''）一律 fallback。 */
function toNumeric(value, fallback) {
  let numeric = Number.NaN;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 按 [min, max] 钳制的整数（条数 / 毫秒数都用它）。
 * 非数字回落 fallback；小数向下取整（1000.9 个好友没意义）；
 * 注意 0 是合法数字，会被钳到 min 而不是回落（maxGroupMembers:0 → 0、-5 → 0）。
 */
function clampIntTo(value, fallback, range) {
  const numeric = toNumeric(value, Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(Math.trunc(numeric), range[0], range[1]);
}

/**
 * 时间戳归一：有限、非负 → 整数毫秒；其余（含 NaN / 负数 / 字符串乱写）→ fallback。
 * 负数直接归零而不是「保留负值」：lastSeenAt 是用来排序和淘汰的，
 * 一个 -1 会让这条永远最旧，看起来像「这人从没出现过」。
 */
function toTimestamp(value, fallback = 0) {
  const numeric = toNumeric(value, Number.NaN);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.trunc(numeric);
}

/** 可选计数：明确给了非负数字才返回数字，否则 null（“没给”和“给了 0”必须能区分）。 */
function toOptionalCount(value) {
  const numeric = toNumeric(value, Number.NaN);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

/**
 * 号码归一成纯数字字符串；不合法 → null。
 *
 * - 数字也收：桥接从 OneBot 拿到的 `user_id` / `group_id` 经常是 number，
 *   原样存进去之后 `privates['2432829808']`（字符串索引）就永远查不到它；
 * - 字符串只认 `^\d{1,20}$`：`' 123 '` 会被 trim 后收下（手写配置常见），
 *   但 `'12.0'` / `'1e3'` / `'-1'` 一律拒绝 —— 号码不是「能转成数就行」，
 *   静默把 12.0 变成 12 只会让两条不同的脏数据撞成一个键。
 * - 超出安全整数的 number 直接拒绝（已经被 IEEE754 改过的号码存下来也是错的）。
 */
function normalizeId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return ID_RE.test(text) ? text : null;
}

/**
 * 单行化：控制字符（含换行 / 制表符 / NUL）压成一个空格，连续空白合并，去首尾空白。
 * 为什么用「换成空格」而不是「删掉」：`A\u0000B` 变成 `A B` 还能看出中间有东西，
 * 变成 `AB` 就是凭空造了个新名字。
 * 为什么不截断：label 是「名字（QQ 123）」拼出来的，名字被截到 40 之后
 * 整个 label 还剩 58 个字符 —— 这里截断会把「（QQ …）」的右括号切掉。
 */
function singleLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 名字归一（dev-doc §三）：单行 + 最多 40 字。
 *
 * 按 **code point** 截断而不是 `slice(0, 40)`：QQ 昵称里 emoji 极常见，
 * UTF-16 切一半会留下孤立代理对，JSON.stringify 出来是 `\ud83d` 这种
 * 还原不回去的碎砖，控制台和提示词里都会显示成乱码。
 * 数字也收（有人会把昵称写成 123），其余类型（null / 对象 / 数组）→ 空串。
 */
function sanitizeName(value) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  const single = singleLine(text);
  if (single === '') return '';
  const points = Array.from(single);
  return points.length > NAME_MAX ? points.slice(0, NAME_MAX).join('') : single;
}

/** 来源归一：只认 'friend'，其余（含 'group' / 缺失 / 乱写）一律降级成 'message'。 */
function normalizeSource(value) {
  return value === SOURCE_FRIEND ? SOURCE_FRIEND : SOURCE_MESSAGE;
}

/** 私聊显示名：备注优先（备注是用户自己起的名字，比对方昵称更能认人）。 */
function displayNameOfPrivate(entry) {
  return sanitizeName(entry.remark) || sanitizeName(entry.name);
}

/** 群成员显示名：群名片优先（群里认的就是名片），退到昵称。 */
function displayNameOfMember(member) {
  return sanitizeName(member.card) || sanitizeName(member.name);
}

/** 私聊 label：有名字 `阿芙乐尔（QQ 2432829808）`，没名字退回 `QQ 2432829808`。 */
function privateLabel(name, qq) {
  const display = singleLine(name);
  return display === '' ? `QQ ${qq}` : `${display}（QQ ${qq}）`;
}

/** 群 label：有名字 `联调群（群 119212385）`，没名字退回 `群 119212385`。 */
function groupLabel(name, gid) {
  const display = singleLine(name);
  return display === '' ? `群 ${gid}` : `${display}（群 ${gid}）`;
}

/** 字符串比较（不用 localeCompare：不同机器的 ICU 排序可能不一致，单测要能复现）。 */
function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function ensurePrivates(state) {
  if (!isPlainObject(state.privates)) state.privates = {};
  return state.privates;
}

function ensureGroups(state) {
  if (!isPlainObject(state.groups)) state.groups = {};
  return state.groups;
}

/** 取出（必要时修补）某条私聊记录；结构坏成非对象时按「不存在」处理。 */
function ensurePrivateEntry(privates, qq) {
  const entry = privates[qq];
  if (isPlainObject(entry)) return entry;
  delete privates[qq];
  return null;
}

// ── 配置归一（dev-doc §二） ─────────────────────────────────────────────────

/**
 * 配置归一化：补默认 + 钳制，永不抛。
 *
 * `enabled` 的口径比其他模块**更严**（dev-doc §四 原话「布尔只认显式 true」）：
 * 缺省（`undefined`）时回落出厂的 true（§二「出厂即开」），但只要配置里写了值，
 * 就必须是字面量 `true` 才算开 —— `'true'` / `1` / `'yes'` / `null` 全部当关。
 * 为什么和 cross-core 的 `!== false` 不一样：identity 开着的时候会**按定时器
 * 反复调 QQ 的接口**（好友列表、每群成员列表），代价比「少记几个名字」高得多。
 * 一个手抖写出来的 `"enabled": "false"` 如果被当成开，用户会发现机器在悄悄
 * 全量拉数据却找不到关它的地方；反过来误关最多是查名字时查不到，看得见。
 *
 * 返回值**不加 Object.freeze**：桥接把它当运行期可变配置持有（与 cross-core 一致）。
 */
export function normalizeIdentityConfig(source) {
  const raw = isPlainObject(source) ? source : {};
  return {
    enabled: raw.enabled === undefined ? IDENTITY_DEFAULTS.enabled === true : raw.enabled === true,
    refreshIntervalMs: clampIntTo(
      raw.refreshIntervalMs,
      IDENTITY_DEFAULTS.refreshIntervalMs,
      IDENTITY_LIMITS.refreshIntervalMs
    ),
    maxFriends: clampIntTo(raw.maxFriends, IDENTITY_DEFAULTS.maxFriends, IDENTITY_LIMITS.maxFriends),
    maxGroups: clampIntTo(raw.maxGroups, IDENTITY_DEFAULTS.maxGroups, IDENTITY_LIMITS.maxGroups),
    maxGroupMembers: clampIntTo(
      raw.maxGroupMembers,
      IDENTITY_DEFAULTS.maxGroupMembers,
      IDENTITY_LIMITS.maxGroupMembers
    ),
    queryLimit: clampIntTo(raw.queryLimit, IDENTITY_DEFAULTS.queryLimit, IDENTITY_LIMITS.queryLimit)
  };
}

// ── 状态：建 / 归一 / 解析 / 序列化（dev-doc §三） ──────────────────────────

/** 空状态。每次调用都是新对象（调用方要就地 upsert，不能共享）。 */
export function createIdentityState() {
  return { version: 1, updatedAt: 0, privates: {}, groups: {} };
}

/**
 * 状态容错归一（读盘之后、以及手改文件之后都走它）。
 *
 * - 号码不合法（`/^\d{1,20}$/` 不匹配）的键直接丢：这种键永远查不到，
 *   留着只会让文件越滚越大、还会占配额把真条目淘汰掉；
 * - **键才是号码**：`privates['123']` 里写着 `qq: '999'` 时以键为准。
 *   键是索引，value 是内容，索引错了就是找不到，不能反过来相信内容；
 * - 名字 / 名片走同一套 sanitizeName（单行、40 字）；
 * - `members` 补成对象（不是数组 / 字符串）：下游全都按对象遍历，
 *   这里不补，任何一个函数碰到手改坏的 group 都会抛；
 * - `updatedAt` 收数字或数字字符串，其余归 0（它不是 0 也合法，「从没写过盘」就是 0）。
 *
 * 不按 maxFriends 等上限裁剪：上限是运行期配置，写进文件里反而会让
 * 「先调大再调小」丢失历史；裁剪交给下一次 apply*（那里才有 config）。
 */
export function normalizeIdentityState(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const state = createIdentityState();
  state.updatedAt = toTimestamp(source.updatedAt, 0);

  const privates = isPlainObject(source.privates) ? source.privates : {};
  for (const key of Object.keys(privates)) {
    const qq = normalizeId(key);
    if (qq === null) continue;
    const entry = privates[key];
    if (!isPlainObject(entry)) continue;
    state.privates[qq] = {
      qq,
      name: sanitizeName(entry.name),
      remark: sanitizeName(entry.remark),
      source: normalizeSource(entry.source),
      lastSeenAt: toTimestamp(entry.lastSeenAt, 0)
    };
  }

  const groups = isPlainObject(source.groups) ? source.groups : {};
  for (const key of Object.keys(groups)) {
    const gid = normalizeId(key);
    if (gid === null) continue;
    const group = groups[key];
    if (!isPlainObject(group)) continue;
    const members = {};
    const rawMembers = isPlainObject(group.members) ? group.members : {};
    for (const memberKey of Object.keys(rawMembers)) {
      const qq = normalizeId(memberKey);
      if (qq === null) continue;
      const member = rawMembers[memberKey];
      if (!isPlainObject(member)) continue;
      members[qq] = {
        qq,
        card: sanitizeName(member.card),
        name: sanitizeName(member.name),
        lastSeenAt: toTimestamp(member.lastSeenAt, 0)
      };
    }
    const memberCount = toOptionalCount(group.memberCount);
    state.groups[gid] = {
      gid,
      name: sanitizeName(group.name),
      memberCount: memberCount === null ? 0 : memberCount,
      lastSeenAt: toTimestamp(group.lastSeenAt, 0),
      members
    };
  }
  return state;
}

/**
 * 读盘容错解析。
 *
 * 与 cross-core 的取舍**不同**：那边坏 JSON 给空 store，这边给 `null`。
 * 原因在调用方语义：cross 的空 store 可以直接用（追加一条就活了），
 * identity 的「空表」和「文件坏了」必须分得开 —— 文件坏了要打日志、要重新拉列表，
 * 而 `null` 是不会被误当成「用户真的一个好友都没有」的信号（dev-doc §四 明确要求 null）。
 */
export function parseIdentityState(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // 数组 / 数字 / 字符串 / null 都「不像状态文件」：归一化会把它们静默洗成空表，
  // 那等于把「文件被写坏」伪装成「还没有数据」，所以这里直接 null。
  if (!isPlainObject(parsed)) return null;
  return normalizeIdentityState(parsed);
}

/**
 * 落盘序列化：先归一，再按号码排序（privates / groups / 每群的 members 都排）。
 *
 * 为什么要排序：这个文件每次刷新都整份重写，不排序时顺序取决于对象的插入顺序
 * （先来的好友在前、后加的群在后），git diff 会把「一个群名变了」显示成
 * 「整块重排」，人工 review 完全没法看。排序之后 diff 只有真正变化的那几行。
 *
 * 字段顺序固定成 dev-doc §三 的形状（qq / name / remark / source / lastSeenAt、
 * gid / name / memberCount / lastSeenAt / members）。normalizeIdentityState 已经
 * 按这个顺序建对象，这里只重排键、不重排字段，所以 `serialize → parse → serialize`
 * 得到完全相同的字符串（写盘幂等，测试也拿它做断言）。
 *
 * 注意一个 JS 事实：纯数字键（QQ 号 ≤ 2^32-1 时）会被引擎按数值升序枚举，
 * 不遵守插入顺序。所以排序结果「一部分按数值、一部分按字典序」——
 * 无所谓，只要每次一致，diff 就是稳的。
 */
export function serializeIdentityState(state) {
  const normalized = normalizeIdentityState(state);
  const privates = {};
  for (const qq of Object.keys(normalized.privates).sort()) {
    privates[qq] = normalized.privates[qq];
  }
  const groups = {};
  for (const gid of Object.keys(normalized.groups).sort()) {
    const group = normalized.groups[gid];
    const members = {};
    for (const qq of Object.keys(group.members).sort()) {
      members[qq] = group.members[qq];
    }
    groups[gid] = {
      gid: group.gid,
      name: group.name,
      memberCount: group.memberCount,
      lastSeenAt: group.lastSeenAt,
      members
    };
  }
  return JSON.stringify({ version: 1, updatedAt: normalized.updatedAt, privates, groups });
}

// ── upsert：增量写入（就地改 state） ────────────────────────────────────────

/**
 * 写入（或新建）一条私聊记录，返回「名字/备注/来源有没有变化」。
 *
 * dev-doc §三 / §四 的覆盖规则：
 * - `source: 'friend'` 是权威，`source: 'message'` 只能补空字段 ——
 *   好友备注是用户亲手写的，消息里飘过来的群昵称绝不能把它盖掉；
 * - `source` 只会升级（message → friend），不会降级；
 * - 只写非空字段：传进来的空名字不清空已有的名字（清空是「删除」语义，
 *   应该由专门的操作做，不该在一条聊天消息的副作用里发生）。
 *
 * 返回值的口径要精确，桥接拿它决定「要不要落盘」：
 * - 新建条目、名字 / 备注 / 来源发生变化 → `true`；
 * - **只推进 `lastSeenAt`（名字没变）→ `false`**。否则每条消息都会触发一次整份
 *   JSON 落盘（dev-doc §五.5 明确要避免），而活跃时间照旧在内存里前进，
 *   最坏情况只是进程重启后少了几分钟的活跃度。
 *
 * 两个额外的自保：
 * - 一个名字都没有的号码**不建条目**：maxFriends 是有限配额，让它被一堆空壳
 *   条目吃掉，真正的好友就会在淘汰时被挤掉；
 * - `lastSeenAt` 只增不减：时钟回拨 / 手改文件写了个旧时间，都不能让「刚说过话的人」
 *   在排序里突然沉底。
 */
export function upsertPrivate(state, options) {
  if (!isPlainObject(state)) return false;
  const opts = isPlainObject(options) ? options : {};
  const qq = normalizeId(opts.qq);
  if (qq === null) return false;

  const name = sanitizeName(opts.name);
  const remark = sanitizeName(opts.remark);
  const at = toTimestamp(opts.at, 0);
  const source = normalizeSource(opts.source);
  const privates = ensurePrivates(state);
  const entry = ensurePrivateEntry(privates, qq);

  if (!entry) {
    if (name === '' && remark === '') return false;
    privates[qq] = { qq, name, remark, source, lastSeenAt: at };
    return true;
  }

  // 先把旧值过一遍归一（手改文件可能留下 ' 张三 ' / 乱写的 source）。
  // 不把「这次归一改掉了脏字符」算成变化：它只是把同一份内容写成规范形态，
  // 算成变化会让桥接在一条完全相同的消息上反复落盘。
  const currentName = sanitizeName(entry.name);
  const currentRemark = sanitizeName(entry.remark);
  const currentSource = normalizeSource(entry.source);
  const currentAt = toTimestamp(entry.lastSeenAt, 0);

  // friend 来源的条目被 message 命中时上锁：只允许补空字段。
  const locked = currentSource === SOURCE_FRIEND && source !== SOURCE_FRIEND;
  let nextName = currentName;
  let nextRemark = currentRemark;
  let changed = false;

  if (name !== '' && (!locked || currentName === '') && name !== currentName) {
    nextName = name;
    changed = true;
  }
  if (remark !== '' && (!locked || currentRemark === '') && remark !== currentRemark) {
    nextRemark = remark;
    changed = true;
  }

  const nextSource = source === SOURCE_FRIEND ? SOURCE_FRIEND : currentSource;
  if (nextSource !== currentSource) changed = true;

  // 就地赋值（不换对象）：桥接可能已经持有这条 entry 的引用，
  // 换掉会让它手里的引用指向旧数据。字段顺序由 serializeIdentityState 负责。
  entry.qq = qq;
  entry.name = nextName;
  entry.remark = nextRemark;
  entry.source = nextSource;
  entry.lastSeenAt = at > currentAt ? at : currentAt;
  return changed;
}

/**
 * 写入（或新建）一个群，返回是否有变化（口径同 upsertPrivate：只推进 lastSeenAt 不算）。
 *
 * `memberCount` 只在**明确给了非负数字**时覆盖：QQ 的 `get_group_list` 偶尔回 0
 * （没权限 / 字段缺失），把它当成「这个群只有 0 人」写进去，会覆盖掉上一轮
 * 已经拿到的 42，而 42 才是控制台和提示词真正想显示的东西。
 *
 * 群名沿用「只写非空」：群改名是可能的，但空名字只意味着「这次没拿到」。
 */
export function upsertGroup(state, options) {
  if (!isPlainObject(state)) return false;
  const opts = isPlainObject(options) ? options : {};
  const gid = normalizeId(opts.gid);
  if (gid === null) return false;

  const name = sanitizeName(opts.name);
  const memberCount = toOptionalCount(opts.memberCount);
  const at = toTimestamp(opts.at, 0);
  const groups = ensureGroups(state);
  const group = groups[gid];

  if (!isPlainObject(group)) {
    groups[gid] = { gid, name, memberCount: memberCount === null ? 0 : memberCount, lastSeenAt: at, members: {} };
    return true;
  }

  const currentName = sanitizeName(group.name);
  const currentCount = toOptionalCount(group.memberCount);
  const currentAt = toTimestamp(group.lastSeenAt, 0);

  const nextName = name !== '' ? name : currentName;
  const nextCount = memberCount === null ? (currentCount === null ? 0 : currentCount) : memberCount;
  const changed = nextName !== currentName
    || nextCount !== (currentCount === null ? 0 : currentCount);

  group.gid = gid;
  group.name = nextName;
  group.memberCount = nextCount;
  group.lastSeenAt = at > currentAt ? at : currentAt;
  if (!isPlainObject(group.members)) group.members = {};
  return changed;
}

/**
 * 写入（或新建）某个群里的一条成员记录，返回是否有变化。
 *
 * 群不存在直接 `false`，**不凭空建群**：消息里出现一个没在白名单里的群号时，
 * 凭空建群会让名字表里混进一堆「只知道号码、不知道群名」的空群，
 * 还会白占 maxGroups 配额。群的来源只能是好友列表 / 群列表（applyGroupList）。
 *
 * 群名片的取舍：`card` 和 `name` 都存（同一个 QQ 在不同群可以有不同的名片，
 * 而昵称是账号级的），显示时用 displayNameOfMember 取 `card || name`。
 */
export function upsertMember(state, gid, options) {
  if (!isPlainObject(state)) return false;
  const target = normalizeId(gid);
  if (target === null) return false;
  const groups = ensureGroups(state);
  const group = groups[target];
  if (!isPlainObject(group)) return false;
  if (!isPlainObject(group.members)) group.members = {};

  const opts = isPlainObject(options) ? options : {};
  const qq = normalizeId(opts.qq);
  if (qq === null) return false;

  const card = sanitizeName(opts.card);
  const name = sanitizeName(opts.name);
  const at = toTimestamp(opts.at, 0);
  const members = group.members;
  const member = members[qq];

  if (!isPlainObject(member)) {
    if (card === '' && name === '') return false;
    members[qq] = { qq, card, name, lastSeenAt: at };
    return true;
  }

  const currentCard = sanitizeName(member.card);
  const currentName = sanitizeName(member.name);
  const currentAt = toTimestamp(member.lastSeenAt, 0);

  let changed = false;
  const nextCard = card !== '' ? card : currentCard;
  const nextName = name !== '' ? name : currentName;
  if (nextCard !== currentCard || nextName !== currentName) changed = true;

  member.qq = qq;
  member.card = nextCard;
  member.name = nextName;
  member.lastSeenAt = at > currentAt ? at : currentAt;
  return changed;
}

// ── 整表合并（apply*，就地改 state，按 lastSeenAt 淘汰） ────────────────────

/**
 * 按 `lastSeenAt` 淘汰超出上限的最旧条目，返回删除条数。
 *
 * 同一时间戳的条目按号码升序淘汰：没有这个决胜规则，同一份输入在不同 JS 引擎
 * （对象键枚举顺序不一样）里会淘汰掉不同的人，控制台每次刷新都会「随机少一个人」。
 * `lastSeenAt === 0`（从没活跃过）自然排在最前面，是第一批被淘汰的 —— 这正是想要的。
 */
function evictOldest(container, max) {
  const keys = Object.keys(container);
  if (keys.length <= max) return 0;
  const ordered = keys.slice().sort((left, right) => {
    const leftAt = toTimestamp(isPlainObject(container[left]) ? container[left].lastSeenAt : 0, 0);
    const rightAt = toTimestamp(isPlainObject(container[right]) ? container[right].lastSeenAt : 0, 0);
    if (leftAt !== rightAt) return leftAt - rightAt;
    return compareText(left, right);
  });
  const drop = keys.length - max;
  for (const key of ordered.slice(0, drop)) delete container[key];
  return drop;
}

/**
 * 好友列表整表合并，返回**合并条数**（有合法 user_id 的行数，不是变化条数）。
 *
 * 为什么返回合并条数而不是变化条数：桥接拿它打「好友 N」的日志（dev-doc §五.4）。
 * 如果返回「改了几条」，第二轮刷新之后日志会变成「好友 0」，看起来像拉取失败。
 * 逐条要不要落盘由 upsertPrivate 的布尔值决定，两件事分开。
 *
 * 第 4 个参数是可选的配置（只用到 maxFriends）。传 undefined 时按出厂默认，
 * 所以老调用点（三个参数）不用改。
 */
export function applyFriendList(state, list, at, config) {
  if (!isPlainObject(state)) return 0;
  const cfg = normalizeIdentityConfig(config);
  const items = Array.isArray(list) ? list : [];
  const stamp = toTimestamp(at, 0);
  let merged = 0;
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const qq = normalizeId(item.user_id);
    if (qq === null) continue;
    upsertPrivate(state, {
      qq,
      name: item.nickname,
      remark: item.remark,
      at: stamp,
      source: SOURCE_FRIEND
    });
    merged += 1;
  }
  evictOldest(ensurePrivates(state), cfg.maxFriends);
  return merged;
}

/**
 * 群列表整表合并，返回合并条数。口径同 applyFriendList。
 * 淘汰是按群自己的 `lastSeenAt`：整表刷新时所有群拿到同一个 `at`，
 * 所以「刚刷新过、但名字表里早就有」和「这次新出现的群」时间一样，
 * 决胜落到群号升序 —— 结果确定，不会每次刷新换一批群。
 */
export function applyGroupList(state, list, at, config) {
  if (!isPlainObject(state)) return 0;
  const cfg = normalizeIdentityConfig(config);
  const items = Array.isArray(list) ? list : [];
  const stamp = toTimestamp(at, 0);
  let merged = 0;
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const gid = normalizeId(item.group_id);
    if (gid === null) continue;
    upsertGroup(state, {
      gid,
      name: item.group_name,
      memberCount: item.member_count,
      at: stamp
    });
    merged += 1;
  }
  evictOldest(ensureGroups(state), cfg.maxGroups);
  return merged;
}

/**
 * 某个群的成员列表整表合并，返回合并条数（群不存在 → 0，不建群）。
 *
 * 只动 `state.groups[gid].members`，别的群一个字节都不碰：成员列表是按群
 * 分批拉的（dev-doc §五.4），一轮刷新要调 N 次，这里如果顺手整理全局，
 * 一次失败就会把别的群刚拉到的数据弄丢。
 *
 * 第 5 个参数是可选的配置（只用到 maxGroupMembers）。
 */
export function applyMemberList(state, gid, list, at, config) {
  if (!isPlainObject(state)) return 0;
  const target = normalizeId(gid);
  if (target === null) return 0;
  const groups = ensureGroups(state);
  const group = groups[target];
  if (!isPlainObject(group)) return 0;
  if (!isPlainObject(group.members)) group.members = {};
  const cfg = normalizeIdentityConfig(config);
  const items = Array.isArray(list) ? list : [];
  const stamp = toTimestamp(at, 0);
  let merged = 0;
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const qq = normalizeId(item.user_id);
    if (qq === null) continue;
    upsertMember(state, target, {
      qq,
      card: item.card,
      name: item.nickname,
      at: stamp
    });
    merged += 1;
  }
  evictOldest(group.members, cfg.maxGroupMembers);
  return merged;
}

// ── 按 key 取名字（提示词 / 控制台都用它） ──────────────────────────────────

/**
 * `private:123` / `group:456` → `{kind, id, key, name, label}`；key 不合法 → `null`。
 *
 * 为什么非法 key 给 null 而不是一个「未知会话」对象：调用方全都拿它做
 * `if (info) …` 的判空，返回一个假对象只会让「跨渠道互通里那个 key 打错了」
 * 这种问题被静默吞掉。
 *
 * `name` 对私聊取 `remark || name`（备注是用户自己起的，比对方昵称好认），
 * 对群取群名。查不到时 `name: ''`，label 退回 `QQ 123` / `群 456` ——
 * 提示词里出现「QQ 2432829808」至少还能让人去搜号码，出现空串就只有噪音。
 *
 * `id` 是**字符串**（与 state 的键同型），方便调用方直接 `state.privates[id]`。
 */
export function identityKey(state, key) {
  const match = typeof key === 'string' ? KEY_RE.exec(key) : null;
  if (!match) return null;
  const source = isPlainObject(state) ? state : {};
  const id = match[2];

  if (match[1] === 'private') {
    const privates = isPlainObject(source.privates) ? source.privates : {};
    const entry = privates[id];
    const name = isPlainObject(entry) ? displayNameOfPrivate(entry) : '';
    return { kind: 'private', id, key, name, label: privateLabel(name, id) };
  }

  const groups = isPlainObject(source.groups) ? source.groups : {};
  const group = groups[id];
  const name = isPlainObject(group) ? sanitizeName(group.name) : '';
  return { kind: 'group', id, key, name, label: groupLabel(name, id) };
}

// ── 检索（dev-doc §四 lookupIdentity） ──────────────────────────────────────

/**
 * 单段文本的打分：完全相等 100 / 前缀 60 / 包含 40，都不中 0。
 * 大小写不敏感（`Derp` 能被 `derp` 搜到）：QQ 昵称里英文很多，
 * 让用户先想清楚大小写属于纯粹的人为障碍。
 */
function textScore(text, loweredQuery) {
  const candidate = sanitizeName(text);
  if (candidate === '' || loweredQuery === '') return 0;
  const lowered = candidate.toLowerCase();
  if (lowered === loweredQuery) return SCORE_HIT;
  if (lowered.startsWith(loweredQuery)) return SCORE_PREFIX;
  if (lowered.includes(loweredQuery)) return SCORE_CONTAINS;
  return 0;
}

/**
 * 按名字 / 备注 / 群名片 / 群名 / QQ 号 / 群号查人和群。
 *
 * 打分（dev-doc §四）：
 * - 号码**只做精确匹配** 100。为什么不给号码也做前缀：QQ 号打半截（`1192`）
 *   会把整本通讯录翻出来，比查不到更没用；名字才有「前缀/包含」的意义。
 * - 名字类字段取**其中的最高分**，不累加：一个人既有备注又有昵称时，
 *   两段文本各中一次就翻倍，会让 limit 完全失控（100 + 100 = 200 毫无意义）。
 * - 群成员的名字命中再 +5（理由见文件头的 SCORE_MEMBER_BONUS 注释）；
 *   只命中号码不加分 —— 号码已经是精确匹配，再加就超过「满分」了。
 *
 * 同一个 QQ 在多个群里命中时只留一个：`lastSeenAt` 最近的群（dev-doc §四），
 * 时间相同留群号小的那个（只是为了同一份状态永远渲染出同一行）。
 *
 * 排序：score 降序 → lastSeenAt 降序 → key 字典序，最后再按 qq 兜一层。
 * 最后这层是必要的：同一个群里两个成员命中的话 key 完全相同（都是 `group:<gid>`），
 * 只有 key 的话顺序取决于插入顺序，等于没有稳定排序。
 *
 * 返回的行**严格是 8 个字段**（kind / key / name / label / qq / gid / groupName / score）：
 * 上游把它直接塞进 JSON 给 MCP 工具，多一个内部字段（比如 lastSeenAt）
 * 就会变成对外契约的一部分，以后想改都改不掉。
 */
export function lookupIdentity(state, query, options) {
  const opts = isPlainObject(options) ? options : {};
  const text = typeof query === 'string' ? query.trim() : '';
  if (text === '') return { ok: true, query: '', rows: [] };

  const limit = clampIntTo(opts.limit, IDENTITY_DEFAULTS.queryLimit, IDENTITY_LIMITS.queryLimit);
  const source = isPlainObject(state) ? state : {};
  const loweredQuery = text.toLowerCase();
  const candidates = [];

  const privates = isPlainObject(source.privates) ? source.privates : {};
  for (const key of Object.keys(privates)) {
    const entry = privates[key];
    if (!isPlainObject(entry)) continue;
    // 键是索引，取键（与 normalizeIdentityState 一致）；键坏了才退到 entry.qq。
    const qq = normalizeId(key) === null ? normalizeId(entry.qq) : normalizeId(key);
    if (qq === null) continue;
    const name = displayNameOfPrivate(entry);
    let score = Math.max(textScore(entry.remark, loweredQuery), textScore(entry.name, loweredQuery));
    if (qq === text) score = Math.max(score, SCORE_HIT);
    if (score <= 0) continue;
    candidates.push({
      kind: 'private',
      key: `private:${qq}`,
      name,
      label: privateLabel(name, qq),
      qq,
      gid: null,
      groupName: '',
      score,
      lastSeenAt: toTimestamp(entry.lastSeenAt, 0)
    });
  }

  const groups = isPlainObject(source.groups) ? source.groups : {};
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    if (!isPlainObject(group)) continue;
    const gid = normalizeId(key) === null ? normalizeId(group.gid) : normalizeId(key);
    if (gid === null) continue;
    const name = sanitizeName(group.name);
    let score = textScore(name, loweredQuery);
    if (gid === text) score = Math.max(score, SCORE_HIT);
    // 群名/群号没中也要继续扫成员：查的是「阿芙乐尔」时命中在群名片上，
    // 群本身不参与打分，但不能因此把整群的成员跳过去。
    if (score > 0) {
      candidates.push({
        kind: 'group',
        key: `group:${gid}`,
        name,
        label: groupLabel(name, gid),
        qq: null,
        gid,
        groupName: '',
        score,
        lastSeenAt: toTimestamp(group.lastSeenAt, 0)
      });
    }

    const members = isPlainObject(group.members) ? group.members : {};
    for (const memberKey of Object.keys(members)) {
      const member = members[memberKey];
      if (!isPlainObject(member)) continue;
      const qq = normalizeId(memberKey) === null ? normalizeId(member.qq) : normalizeId(memberKey);
      if (qq === null) continue;
      const nameHit = Math.max(
        textScore(member.card, loweredQuery),
        textScore(member.name, loweredQuery)
      );
      const numberHit = qq === text ? SCORE_HIT : 0;
      let score = Math.max(nameHit, numberHit);
      if (score <= 0) continue;
      if (nameHit > 0) score += SCORE_MEMBER_BONUS;
      const display = displayNameOfMember(member);
      candidates.push({
        kind: 'member',
        key: `group:${gid}`,
        name: display,
        label: privateLabel(display, qq),
        qq,
        gid,
        groupName: name,
        score,
        lastSeenAt: toTimestamp(member.lastSeenAt, 0)
      });
    }
  }

  // 同一个 QQ 在多个群命中 → 收成一个（按 lastSeenAt 最近，时间相同取群号小的）。
  const bestMember = new Map();
  const rows = [];
  for (const item of candidates) {
    if (item.kind !== 'member') {
      rows.push(item);
      continue;
    }
    const kept = bestMember.get(item.qq);
    if (!kept) {
      bestMember.set(item.qq, item);
      continue;
    }
    if (item.lastSeenAt > kept.lastSeenAt
      || (item.lastSeenAt === kept.lastSeenAt && compareText(item.gid, kept.gid) < 0)) {
      bestMember.set(item.qq, item);
    }
  }
  for (const item of bestMember.values()) rows.push(item);

  rows.sort((left, right) => (
    (right.score - left.score)
    || (right.lastSeenAt - left.lastSeenAt)
    || compareText(left.key, right.key)
    || compareText(left.qq === null ? '' : left.qq, right.qq === null ? '' : right.qq)
  ));

  return {
    ok: true,
    query: text,
    rows: rows.slice(0, limit).map((item) => ({
      kind: item.kind,
      key: item.key,
      name: item.name,
      label: item.label,
      qq: item.qq,
      gid: item.gid,
      groupName: item.groupName,
      score: item.score
    }))
  };
}

// ── 提示词块（dev-doc §四 identityPromptBlock） ─────────────────────────────

/**
 * 说话人显示名的来源顺序：本群成员名片 → 私聊备注/昵称 → 调用方传进来的名字。
 *
 * 为什么要去查表：`socialV2` 的 recentMessages 里只存了 `fromQq` 和当时的 `from`，
 * 那个 `from` 可能是昵称、也可能是没设置过的空串；名字表里的群名片才是
 * 「这个人现在在这个群里叫什么」的权威答案。
 */
function resolveSpeakerName(state, info, qq, fallback) {
  const source = isPlainObject(state) ? state : {};
  if (info.kind === 'group') {
    const groups = isPlainObject(source.groups) ? source.groups : {};
    const group = groups[info.id];
    const members = isPlainObject(group) && isPlainObject(group.members) ? group.members : {};
    const member = members[qq];
    if (isPlainObject(member)) {
      const display = displayNameOfMember(member);
      if (display !== '') return display;
    }
  }
  const privates = isPlainObject(source.privates) ? source.privates : {};
  const entry = privates[qq];
  if (isPlainObject(entry)) {
    const display = displayNameOfPrivate(entry);
    if (display !== '') return display;
  }
  return sanitizeName(fallback);
}

/**
 * 当前会话的提示词块。
 *
 * 只做「把传入的 speaker 列表映射成 label」：core 不依赖桥接状态
 * （dev-doc §四 明确否掉了「从 socialV2 的 recentMessages 读」的方案）。
 *
 * - key 不合法 → `{enabled:false, current:null, speakers:[]}`。桥接只需看
 *   `enabled` 就知道能不能渲染，不用再自己判 key。注意这里的 `enabled` 是
 *   「key 合法、这一块能用」，**不是**配置里的 `socialV2.identity.enabled` ——
 *   配置开关在桥接那一层判（关掉时整块不该被调用），core 拿不到配置。
 * - `speakers` 按传入顺序取前 `speakerLimit` 个，非法项（不是对象 / 号码不合法）
 *   跳过且**不占名额** —— 桥接塞进来一条脏数据不该挤掉一个真人。
 * - `speakerLimit` 钳到 0–50：0 合法（「只给当前会话的名字，不列说话人」）。
 * - 群会话额外 `groupName`，私聊额外 `peer`（dev-doc §四）。
 */
export function identityPromptBlock(state, key, options) {
  const opts = isPlainObject(options) ? options : {};
  const info = identityKey(state, key);
  if (!info) return { enabled: false, current: null, speakers: [] };

  const limit = clampIntTo(opts.speakerLimit, SPEAKER_DEFAULT_LIMIT, [0, SPEAKER_LIMIT_MAX]);
  const list = Array.isArray(opts.speakers) ? opts.speakers : [];
  const speakers = [];
  for (const item of list) {
    if (speakers.length >= limit) break;
    if (!isPlainObject(item)) continue;
    const qq = normalizeId(item.qq);
    if (qq === null) continue;
    const name = resolveSpeakerName(state, info, qq, item.name);
    speakers.push({ qq, name, label: privateLabel(name, qq) });
  }

  const block = {
    enabled: true,
    current: { key: info.key, label: info.label },
    speakers
  };
  if (info.kind === 'group') {
    const groups = isPlainObject(state) && isPlainObject(state.groups) ? state.groups : {};
    const group = groups[info.id];
    block.groupName = isPlainObject(group) ? sanitizeName(group.name) : '';
  } else {
    block.peer = { qq: info.id, label: info.label };
  }
  return block;
}

// ── 文案（MCP 工具 / 控制台） ───────────────────────────────────────────────

/**
 * 一条命中行 → 人话。dev-doc §四 给的两个样板必须逐字一致：
 *   私聊 阿芙乐尔（QQ 2432829808）→ private:2432829808
 *   群 联调群（群 119212385）→ group:119212385
 * 注意 `）` 和 `→` 之间没有空格，`→` 和 key 之间有一个 —— 照抄样本，
 * 因为模型是拿这行字当「可以复制的 key」用的，多一个空格就可能被一起抄走。
 *
 * 成员行 dev-doc 没给样板，取 `成员 <群名>/<名字（QQ n）>→ group:<gid>`：
 * 同一个群可能命中好几个人，行首的群名让人一眼看出「这几行是同一个群里的」，
 * 而 key 又完全相同，只有名字能区分。
 *
 * label 缺失时按 kind 兜底拼一个（宁可显示 `QQ 123`，也不要留空让模型去猜）：
 * 这个函数同时给控制台用，行数据可能来自手拼的对象。
 */
export function formatIdentityRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  for (const row of list) {
    if (!isPlainObject(row)) continue;
    const kind = row.kind === 'group' ? 'group' : row.kind === 'member' ? 'member' : 'private';
    const qq = normalizeId(row.qq);
    const gid = normalizeId(row.gid);
    let key = typeof row.key === 'string' ? singleLine(row.key) : '';
    if (key === '') key = qq !== null ? `private:${qq}` : gid !== null ? `group:${gid}` : '';

    let label = singleLine(row.label);
    if (label === '') {
      if (kind === 'group') label = groupLabel('', gid === null ? '' : gid);
      else label = privateLabel('', qq === null ? '' : qq);
    }

    if (kind === 'group') {
      lines.push(`群 ${label}→ ${key}`);
    } else if (kind === 'member') {
      const groupName = singleLine(row.groupName);
      lines.push(`成员 ${groupName === '' ? '' : `${groupName}/`}${label}→ ${key}`);
    } else {
      lines.push(`私聊 ${label}→ ${key}`);
    }
  }
  return lines.join('\n');
}
