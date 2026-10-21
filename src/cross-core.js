// 跨渠道互通（分组编号 / 消息缓冲滚动 / 跨会话检索 / 落盘序列化）的纯逻辑模块。
//
// 口径来自 work/agent-tasks/T-016/dev-doc.md（§一 模型、§二 数据落盘、§三 纯函数 API）。
// 本文件以**任务契约**为准：dev-doc §三 的 `assignGroups → { map, changed }`、
// `recallEntries({ gids })`、`crossIndex → { total }` 是阶段三草稿形态，落地改成
// `{ map, assigned }`、`({ groups, gid })`、`{ gid, others }`。
//
// 三条硬约束：
//   1. **不碰 IO、不读系统时钟**：`now` / `sinceMs` 全部由调用方传毫秒。桥接侧能复盘
//      某一天的检索结果，单测也能把「等一小时」压成一次函数调用。本文件连 import
//      都没有（不需要 fs / path），`node --check` 就能过。
//   2. **脏输入不抛**：null / 'x' / [] / 手改坏的状态文件一律「回落默认或返回空」。
//      这个模块跑在每条消息的入口路径上，抛一次异常就会让整个桥接停摆。
//   3. **只有 appendEntry 就地改 store**（dev-doc §2.2 的滚动缓冲）：每来一条消息
//      复制 500 条 entry 不现实，所以它原地 push / splice 并返回 { added, dropped }。
//      其余导出函数全部只读入参、返回新对象。
//
// 单位约定：时间一律毫秒；`sinceMs` 是「回溯多久」而不是绝对时刻；
// `score` 是 0–1 的实数（三项权重之和最大正好是 1）。

// ── 常量与出厂配置（dev-doc §2.1 / §三） ───────────────────────────────────

/** 检索条数上限：dev-doc §三 第 5 条「limit 默认 50、上限 200」。 */
export const CROSS_MAX_LIMIT = 200;

/** 回溯窗口默认值：24 小时（dev-doc §三 第 4 条）。 */
export const CROSS_DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

/** 出厂配置。`enabled: true` 是用户明确要的（clarify 里「出厂就开」）。 */
export const CROSS_DEFAULTS = Object.freeze({
  enabled: true,
  bufferPerConversation: 500,
  // T-020：prompt 里自动带上的「同组最近消息」。5 条 × 2 小时是用户拍板的默认值
  // （够看清刚才聊了什么，又不至于把整段历史灌进上下文）；设 0 等于关掉自动带。
  recentPerKey: 5,
  recentHours: 2
});

/**
 * 各项合法区间：`bufferPerConversation` 50–2000（50 是「至少能翻几条」的下限，
 * 2000 是「一个会话的文件别把内存撑爆」的上限）；`limit` 1–200。
 * `recentPerKey` 0–20 / `recentHours` 0–72：0 都表示「不在 prompt 里自动带」，
 * 上限防手滑写出一个把整个缓冲灌进上下文的配置。
 * 超界一律钳制，不报错 —— 配置是用户手写的，写错不该让服务起不来。
 */
export const CROSS_LIMITS = Object.freeze({
  bufferPerConversation: Object.freeze([50, 2000]),
  limit: Object.freeze([1, CROSS_MAX_LIMIT]),
  recentPerKey: Object.freeze([0, 20]),
  recentHours: Object.freeze([0, 72])
});

// 会话 key 的唯一合法形态（与 src/diary-store.js:15-23、social-v2.json 的 conversations 一致）。
// 数字段最宽 20 位：QQ 号最长 11 位，群号 + 预留足够，再长就是脏数据。
// 注意两个捕获组都要留：humanKeyLabel 直接把 match[1]/match[2] 拼成人话，
// 少了第二组就会拼出「群 undefined」。
const CROSS_KEY_RE = /^(group|private):(\d{1,20})$/;

// 单条缓冲的字段上限（dev-doc §2.2：text 存全文但上限 2000 字，超了截断并标 truncated）。
const ENTRY_TEXT_MAX = 2000;
const ENTRY_FROM_MAX = 40;
const ENTRY_IMPORTANCE_DEFAULT = 3;
const ENTRY_IMPORTANCE_MAX = 10;
const ENTRY_QQ_MAX = 32;

// 中文 bigram 宽松命中的阈值（dev-doc §三 第 3 条：覆盖率 ≥0.6 才算命中）。
const BIGRAM_COVERAGE_MIN = 0.6;
// 只按「常用汉字区」切段：扩展区 / 生僻字当非中文处理 —— 少命中一次不会误伤，
// 但把 [\u3400-\u4dbf] 也纳进来会让「㐀㐁」这类罕见字拼出无意义的 bigram。
const CHINESE_SEGMENT_RE = /[\u4e00-\u9fff]+/g;

// 打分权重（dev-doc §三 第 5 条）：0.5*kw + 0.3*0.995^小时差 + 0.2*(importance/10)。
// 三项权重之和 1.0，所以 score 落在 [0, 1]，跨会话比较时不用再归一。
const WEIGHT_KEYWORD = 0.5;
const WEIGHT_RECENCY = 0.3;
const WEIGHT_IMPORTANCE = 0.2;
const RECENCY_DECAY_PER_HOUR = 0.995;

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
 * 按 [min, max] 钳制的整数（limit / buffer 这类「条数」都用它）。
 * 非数字回落 fallback；小数向下取整（499.9 条没意义，取 499 再钳）；
 * 注意 0 是合法数字，会被钳到 min 而不是回落（limit:0 → 1）。
 */
function clampIntTo(value, fallback, range) {
  const numeric = toNumeric(value, Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(Math.trunc(numeric), range[0], range[1]);
}

/** 会话 key 校验：'group:123' / 'private:123'。所有入口都走它，避免脏 key 落盘。 */
function isCrossKey(value) {
  return typeof value === 'string' && CROSS_KEY_RE.test(value);
}

/** 渠道显示名：前缀决定（dev-doc §2.3 的「来自 群 119212385 / 私聊」）。 */
function channelOf(key) {
  if (typeof key !== 'string') return '';
  if (key.startsWith('group:')) return '群';
  if (key.startsWith('private:')) return '私聊';
  return '';
}

/**
 * 发送者显示名：压成单行（换行 / 制表符 / 控制字符都换成空格）、去首尾空白、裁 40 字。
 * 为什么压单行：这个值会出现在工具返回的逐行文本里，一个换行就会把「一行一条」拆散。
 */
function normalizeFrom(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, ENTRY_FROM_MAX);
}

/**
 * QQ 号统一成字符串（或 null）。
 * 为什么数字也收：桥接从消息体里取 sender.userId 时可能是 number，若原样存进缓冲，
 * recall 的 `person='2432829808'`（字符串精确比较）就永远匹配不上。
 * 为什么不校验位数：群号 / QQ 号长度不一，这里只负责「类型统一」，格式错误由上层兜。
 */
function normalizeQq(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text.slice(0, ENTRY_QQ_MAX);
  }
  return null;
}

/** 中文连续段 → 相邻两字 bigram（不去重，调用方按需去重）。 */
function bigramsOf(text) {
  const out = [];
  if (typeof text !== 'string' || text === '') return out;
  const segments = text.match(CHINESE_SEGMENT_RE) || [];
  for (const segment of segments) {
    for (let i = 0; i + 1 < segment.length; i += 1) out.push(segment.slice(i, i + 2));
  }
  return out;
}

/** 去重后的 bigram 集合：既是 query 的分母，也是文档的命中集。 */
function bigramSetOf(text) {
  return new Set(bigramsOf(text));
}

// ── 编号归一（dev-doc §一 编号规则） ────────────────────────────────────────

/**
 * gid 归一：**只认非负整数**。
 *
 * - `'3'` → 3（控制台的 `<input type=number>` 与 config.json 里都可能是字符串）；
 * - `0` → 0（合法值：表示「不共享」，与「没设置」必须区分开，所以不能用 0 当 null）；
 * - 负数 / 小数 / NaN / '' / null / undefined / 对象 / 布尔 → null。
 *
 * dev-doc §一 第 4 条要求「负数/小数/非数字 → 400，不做静默归一」，那是**端点**的
 * 责任；纯函数这一层只回答「这是不是一个合法编号」，所以坏值给 null 而不是 0 ——
 * 给 0 会让调用方误以为用户主动选了「不共享」。
 */
export function normalizeGid(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  // 字符串只认纯数字（'/^\d+$/'）：'3.0' / '3e1' / ' 3 ' 一律不认，
  // 与「小数不合法」保持一致，避免 3.7 被 String() 后静默变成 3。
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : null;
  }
  return null;
}

/**
 * 配置归一化：补默认 + 钳制，永不抛（dev-doc §2.1 的 cross 配置）。
 *
 * `enabled` 只有**显式 `false`** 才关：写错类型（'false'、0、null）回落「开」——
 * 用户要的是开箱即用，真要关，配置里写 `false` 就够了。
 *
 * `groups` 只保留「key 合法 **且** value 归一成功」的项。注意 0 是合法 value
 * （「这个会话不共享」也可以显式写出来），必须留住；否则控制台保存的 0 会在下次
 * 启动时被悄悄删掉，用户会以为「我明明设了 0，怎么又被分到组里了」。
 *
 * 返回值不加 Object.freeze：桥接把它当作运行期可变配置持有，`assignGroups` 的结果
 * 也要能直接写回 `cfg.socialV2.cross.groups`。
 */
export function normalizeCrossConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const groups = {};
  const rawGroups = isPlainObject(source.groups) ? source.groups : {};
  for (const key of Object.keys(rawGroups)) {
    if (!isCrossKey(key)) continue;
    const gid = normalizeGid(rawGroups[key]);
    if (gid === null) continue;
    groups[key] = gid;
  }
  return {
    enabled: source.enabled !== false,
    bufferPerConversation: clampIntTo(
      source.bufferPerConversation,
      CROSS_DEFAULTS.bufferPerConversation,
      CROSS_LIMITS.bufferPerConversation
    ),
    recentPerKey: clampIntTo(source.recentPerKey, CROSS_DEFAULTS.recentPerKey, CROSS_LIMITS.recentPerKey),
    recentHours: clampIntTo(source.recentHours, CROSS_DEFAULTS.recentHours, CROSS_LIMITS.recentHours),
    groups
  };
}

// ── 分组：找空号 / 补号 / 查号 / 取同组成员 ─────────────────────────────────

/**
 * 当前未占用的最小正整数（dev-doc §一 编号规则第 2 条）。
 *
 * 只看 value，不看 key；0 不占号（「不共享」的会话不参与编号，否则第一个新会话
 * 会从 1 开始被 0 顶掉）。`used.size + 1` 一定不在 used 里，所以循环必然终止 ——
 * 即使 groups 被手改成一个从 1 排到 100 万的连续块，也只会多走一轮。
 */
export function nextFreeGid(groups) {
  const source = isPlainObject(groups) ? groups : {};
  const used = new Set();
  for (const value of Object.values(source)) {
    const gid = normalizeGid(value);
    if (gid !== null && gid > 0) used.add(gid);
  }
  let gid = 1;
  while (used.has(gid)) gid += 1;
  return gid;
}

/**
 * 给一批会话补号：已存在且合法的号**原样保留**（0 也保留，绝不被覆盖成新号），
 * 缺失 / value 非法的键分配 `nextFreeGid`。
 *
 * 返回 `{ map, assigned }`：
 * - `map` 是 groups 的浅拷贝再补键（不改入参，调用方决定什么时候整体写回 config）；
 * - `assigned` 只装**这次真正写了号**的键（新键 + value 非法的旧键），桥接据此决定
 *   「要不要落盘」与「日志里报哪几个会话被自动编号」。
 *
 * key 不合法（如 'cross:1'、'foo'）直接跳过：给了号也存不进 config，反而让
 * `assigned` 里出现一个永远对不上的键。
 */
export function assignGroups(keys, groups) {
  const source = isPlainObject(groups) ? groups : {};
  const map = { ...source };
  const assigned = {};
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    if (!isCrossKey(key)) continue;
    const existing = normalizeGid(map[key]);
    if (existing !== null) {
      // 合法（含 0）就保留，顺便把 '3' 这类字符串归一成数字，后面的 === 比较才可靠。
      map[key] = existing;
      continue;
    }
    const gid = nextFreeGid(map);
    map[key] = gid;
    assigned[key] = gid;
  }
  return { map, assigned };
}

/** 取某个会话的互通组号：合法 gid（含 0）或 0（没有 / 非法 / key 不认识）。 */
export function groupOf(groups, key) {
  if (!isCrossKey(key)) return 0;
  const source = isPlainObject(groups) ? groups : {};
  const gid = normalizeGid(source[key]);
  return gid === null ? 0 : gid;
}

/**
 * 同 gid 的全部会话 key，**保持 groups 的插入顺序**（控制台列表、README 里的
 * 「同组还有谁」都按这个顺序展示，重排会让人以为分组变了）。
 * `gid <= 0` 一律空数组：0 表示不共享，没有「0 号组」这种东西。
 */
export function membersOf(groups, gid) {
  const target = normalizeGid(gid);
  if (target === null || target <= 0) return [];
  const source = isPlainObject(groups) ? groups : {};
  const out = [];
  for (const key of Object.keys(source)) {
    if (!isCrossKey(key)) continue;
    if (normalizeGid(source[key]) === target) out.push(key);
  }
  return out;
}

// ── 消息缓冲：单条归一 + 滚动追加 ───────────────────────────────────────────

/**
 * 单条缓冲归一到固定形状；不合法（没有 ts / ts<=0 / 不是对象）返回 null。
 *
 * 为什么 ts 必须 >0：`0` 是「没记时间」，它会让时间窗过滤和 0.995^小时差 全部失效
 * （小时差算出来是几万小时，排序垫底但仍在结果里）。宁可丢一条，也不让脏数据进缓冲。
 *
 * `text` 原样保留（不 trim、不去控制字符）：这是「原话」，包含换行也照存，
 * 只有在 formatRecallLines 才压成单行。
 */
function normalizeEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const ts = toNumeric(raw.ts, Number.NaN);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const entry = {
    ts,
    from: normalizeFrom(raw.from),
    fromQq: normalizeQq(raw.fromQq),
    isSelf: raw.isSelf === true,
    text,
    importance: Number.isFinite(toNumeric(raw.importance, Number.NaN))
      ? clamp(toNumeric(raw.importance, ENTRY_IMPORTANCE_DEFAULT), 0, ENTRY_IMPORTANCE_MAX)
      : ENTRY_IMPORTANCE_DEFAULT
  };
  // 超长截断：保留上游已经打过的 truncated 标记（桥接可能已经截过一次全文），
  // 这样「这条话被截过」这个事实不会在第二次归一里丢掉。
  let truncated = raw.truncated === true;
  if (entry.text.length > ENTRY_TEXT_MAX) {
    entry.text = entry.text.slice(0, ENTRY_TEXT_MAX);
    truncated = true;
  }
  if (truncated) entry.truncated = true;
  return entry;
}

/** 取（必要时就地创建 / 修补）某个会话的缓冲记录。store 结构坏了也只补不抛。 */
function ensureConversation(store, key) {
  if (!isPlainObject(store.conversations)) store.conversations = {};
  let conv = store.conversations[key];
  if (!isPlainObject(conv)) {
    conv = { gid: 0, entries: [], evicted: 0 };
    store.conversations[key] = conv;
  }
  if (!Array.isArray(conv.entries)) conv.entries = [];
  conv.evicted = Math.max(0, Math.trunc(toNumeric(conv.evicted, 0)));
  const gid = normalizeGid(conv.gid);
  conv.gid = gid === null ? 0 : gid;
  return conv;
}

/**
 * 往某个会话的缓冲尾部追加一条，超限时从头部丢弃（dev-doc §2.2 滚动缓冲）。
 *
 * **就地改 store**（唯一一个这么做的函数）：每条消息都要走这里，复制整份缓冲不现实。
 *
 * 返回 `{ added, dropped }`：
 * - `added:false` 表示这条没进缓冲（key 非法 / entry 非法 / store 不是对象），
 *   调用方**不要**把它当成「记上了」，也不要因此报错 —— 消息照常处理，只是没留档；
 * - `dropped` 是这次被挤掉的条数，已经累加进 `conv.evicted`。
 *   evicted 只增不减：它是「这个会话丢过多少条」的长期计数，控制台拿它判断
 *   「是不是该调大 bufferPerConversation 了」。
 *
 * `gid` 传了合法值（含 0）就同步到会话上：控制台把会话改成 0 之后，缓冲里那条
 * 旧号必须跟着改，否则 `crossIndex` 会拿旧号算出一个已经不属于它的组。
 */
export function appendEntry(store, options) {
  const miss = { added: false, dropped: 0 };
  if (!isPlainObject(store)) return miss;
  const opts = isPlainObject(options) ? options : {};
  const key = opts.key;
  if (!isCrossKey(key)) return miss;
  const entry = normalizeEntry(opts.entry);
  if (!entry) return miss;

  if (store.version !== 1) store.version = 1;
  const conv = ensureConversation(store, key);
  const gid = normalizeGid(opts.gid);
  if (gid !== null) conv.gid = gid;

  conv.entries.push(entry);
  const limit = clampIntTo(opts.limit, CROSS_DEFAULTS.bufferPerConversation, CROSS_LIMITS.bufferPerConversation);
  const dropped = Math.max(0, conv.entries.length - limit);
  if (dropped > 0) {
    conv.entries.splice(0, dropped);
    conv.evicted += dropped;
  }
  return { added: true, dropped };
}

// ── 检索 ───────────────────────────────────────────────────────────────────

/**
 * 关键词得分：原串大小写不敏感命中给满 1；否则中文 bigram 覆盖率 ≥0.6 给 0.6。
 *
 * 为什么不用「前 10 字 substring」（dev-doc 第 3 条明确不复用 activeTopics 的逻辑）：
 * 中文没有词边界，前 10 字截断在长句里几乎必中，等于没有过滤。
 *
 * 为什么 bigram 只取连续中文字符段：'你好，世界' 按标点切段后不会生成 '好世'
 * 这种跨标点的假词，命中率才是「说的是同一件事」的可信信号。
 *
 * query 的 bigram 先**去重**：query='哈哈哈' 只有 '哈哈' 一个有效词，
 * 分母算 2 会让一句只含 '哈哈' 的话覆盖率只有 0.5，反而漏掉。
 */
function keywordScore(text, query, queryBigrams) {
  if (query === '') return 0;
  const loweredQuery = query.toLowerCase();
  if (typeof text === 'string' && text.toLowerCase().includes(loweredQuery)) return 1;
  if (queryBigrams.size === 0) return 0;
  const docBigrams = bigramSetOf(text);
  let hit = 0;
  for (const gram of queryBigrams) {
    if (docBigrams.has(gram)) hit += 1;
  }
  return hit / queryBigrams.size >= BIGRAM_COVERAGE_MIN ? 0.6 : 0;
}

/**
 * 跨会话检索（dev-doc §三 检索规则的纯函数版）。
 *
 * 可见范围 = `membersOf(groups, gid)` 去掉 `excludeKey`（当前会话自己的话没必要
 * 再「回忆」一遍，模型本来就在上下文里）。`gid <= 0` 直接空 —— 不共享就是查不到，
 * 这是「私聊内容被说给群里第三方」那条风险的唯一技术闸门。
 *
 * 过滤顺序：时间窗 → 发言人 → 关键词。关键词一关是**排除性**的：给了 query 却
 * 没命中（kw=0）的条目不会以「垫底」身份混进结果 —— 工具返回的是「找到的记录」，
 * 混进去就会变成「我查到了但内容无关」，模型很容易顺势编。
 *
 * 返回的 `total` 是**截断前**的命中条数：上层要能告诉模型「一共 37 条，只给你 5 条」，
 * 不然模型会以为「同组只有 5 条相关消息」。
 *
 * `now` 缺省按 0 处理（不是系统时钟）：纯函数不读时钟，缺参数时宁可让结果保守地
 * 全落在窗口外，也不要偷偷用 Date.now() 造出无法复现的结果。
 */
export function recallEntries(options) {
  const opts = isPlainObject(options) ? options : {};
  const gid = normalizeGid(opts.gid);
  if (gid === null || gid <= 0) return { total: 0, rows: [] };

  const store = isPlainObject(opts.store) ? opts.store : {};
  const conversations = isPlainObject(store.conversations) ? store.conversations : {};
  const groups = opts.groups;
  const now = toNumeric(opts.now, 0);
  const sinceRaw = toNumeric(opts.sinceMs, Number.NaN);
  // sinceMs 缺省 24h；0 是合法值（「只看此刻之后」），负数当没给 —— 负的时间窗
  // 会把 now 之后的所有条目全漏掉，属于典型的「手滑多打一个减号」。
  const sinceMs = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : CROSS_DEFAULT_SINCE_MS;
  const floor = now - sinceMs;

  const limit = clampIntTo(opts.limit, 50, CROSS_LIMITS.limit);
  const excludeKey = typeof opts.excludeKey === 'string' ? opts.excludeKey : '';
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  const person = typeof opts.person === 'string' ? opts.person.trim() : '';
  const loweredPerson = person.toLowerCase();
  const queryBigrams = bigramSetOf(query);

  const rows = [];
  for (const key of membersOf(groups, gid)) {
    if (key === excludeKey) continue;
    const conv = conversations[key];
    if (!isPlainObject(conv) || !Array.isArray(conv.entries)) continue;
    for (const item of conv.entries) {
      const ts = toNumeric(isPlainObject(item) ? item.ts : Number.NaN, Number.NaN);
      if (!Number.isFinite(ts) || ts <= 0 || ts < floor) continue;
      const from = normalizeFrom(item.from);
      const fromQq = normalizeQq(item.fromQq);
      if (person !== '') {
        const byQq = fromQq !== null && fromQq === person;
        const byName = from.toLowerCase().includes(loweredPerson);
        if (!byQq && !byName) continue;
      }
      const text = typeof item.text === 'string' ? item.text.slice(0, ENTRY_TEXT_MAX) : '';
      const kw = keywordScore(text, query, queryBigrams);
      if (query !== '' && kw <= 0) continue;
      // 未来时间（时钟回拨 / 手改文件）按「刚刚」算：负数的小时差会让 0.995^x > 1，
      // 把一条脏数据顶到所有真实消息前面，score 还会超过 1。
      const hours = Math.max(0, (now - ts) / 3600000);
      const importanceNumeric = toNumeric(isPlainObject(item) ? item.importance : Number.NaN, Number.NaN);
      const importance = Number.isFinite(importanceNumeric)
        ? clamp(importanceNumeric, 0, ENTRY_IMPORTANCE_MAX)
        : ENTRY_IMPORTANCE_DEFAULT;
      const score = WEIGHT_KEYWORD * kw
        + WEIGHT_RECENCY * Math.pow(RECENCY_DECAY_PER_HOUR, hours)
        + WEIGHT_IMPORTANCE * (importance / ENTRY_IMPORTANCE_MAX);
      rows.push({
        key,
        ts,
        from,
        fromQq,
        isSelf: isPlainObject(item) && item.isSelf === true,
        text,
        score,
        importance
      });
    }
  }

  // 同分按 ts 降序：都是刚说过的话时，后说的那句更可能是「当下在聊的事」。
  rows.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  const total = rows.length;
  return { total, rows: rows.slice(0, limit) };
}

/**
 * 同组其它会话的概览（dev-doc §4.2 提示词元数据的数据源）：
 * `{ gid, others: [{ key, count, lastAt }] }`，按 lastAt 降序。
 *
 * **只给条数和时间，不含任何内容** —— 用户明确要求提示里不能带正文，否则模型
 * 会以为自己已经知道了别处的对话，转头就编。
 *
 * `count` 取缓冲里实际存了多少条（entries.length，含 ts 已经不合法的脏条目），
 * 因为它的用途是「文件有多大 / 还有多少可查」；`lastAt` 只认合法 ts，没有就是 0，
 * 排序时自然沉底。
 *
 * `now` 目前不参与计算，保留参数是为了后续「只数 lastAt 之后的新消息」时
 * 不用改所有调用点。
 */
export function crossIndex(store, options) {
  const opts = isPlainObject(options) ? options : {};
  const gid = normalizeGid(opts.gid);
  if (gid === null || gid <= 0) return { gid: 0, others: [] };
  void opts.now;
  const source = isPlainObject(store) ? store : {};
  const conversations = isPlainObject(source.conversations) ? source.conversations : {};
  const selfKey = typeof opts.key === 'string' ? opts.key : '';
  const others = [];
  for (const key of membersOf(opts.groups, gid)) {
    if (key === selfKey) continue;
    const conv = conversations[key];
    const entries = isPlainObject(conv) && Array.isArray(conv.entries) ? conv.entries : [];
    let lastAt = 0;
    for (const item of entries) {
      const ts = toNumeric(isPlainObject(item) ? item.ts : Number.NaN, Number.NaN);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (ts > lastAt) lastAt = ts;
    }
    others.push({ key, count: entries.length, lastAt });
  }
  others.sort((a, b) => b.lastAt - a.lastAt);
  return { gid, others };
}

// ── 展示 ───────────────────────────────────────────────────────────────────

/** 毫秒 → 本地 'HH:mm'；坏 ts 给 '--:--'（不是 'NaN:NaN'，那会污染整行）。 */
function clockOf(ts) {
  const value = toNumeric(ts, Number.NaN);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 检索结果 → 逐行文本（工具返回给模型的紧凑形态）。
 *
 * 用**本机时区**的时分：桥接、控制台、模型看到的是同一台机器上的同一份时间，
 * 强行转 UTC 会让北京时间早上八点的事显示成「00:00」，比不精确更难理解。
 * 代价是这个函数的输出依赖进程时区，所以单测只断言形状，不断言具体时分。
 *
 * 正文压成单行：一条带换行的消息会把「一行一条」拆成两行，模型会把它读成两条。
 */
export function formatRecallLines(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  for (const row of list) {
    if (!isPlainObject(row)) continue;
    const channel = channelOf(row.key) || '未知';
    const from = normalizeFrom(row.from);
    const who = from !== '' ? from : (row.isSelf === true ? '我' : '未知');
    const text = (typeof row.text === 'string' ? row.text : '').replace(/\r?\n/g, ' ');
    lines.push(`${clockOf(row.ts)} ${channel} ${who}：${text}`);
  }
  return lines;
}

/**
 * 会话 key → 人话：'group:119212385' → '群 119212385'、'private:1691642607' → '私聊 1691642607'。
 * 认不出就原样 `String(key)`：控制台 / 日志里出现一个陌生 key 也比出现 undefined 强。
 */
export function humanKeyLabel(key) {
  if (typeof key === 'string') {
    const match = CROSS_KEY_RE.exec(key);
    if (match) return `${match[1] === 'group' ? '群' : '私聊'} ${match[2]}`;
  }
  return String(key);
}

// ── 序列化 ─────────────────────────────────────────────────────────────────

/**
 * 落盘用序列化：**conversations 按 key 排序**。
 *
 * 为什么要排序：这个文件每次滚动都会整份重写，不排序时 JSON 顺序取决于对象插入
 * 顺序，git diff 会把「一条消息变了」显示成「整块重排」，人工 review 完全没法看。
 * 排序之后 diff 只有真正变化的那几行。
 *
 * 非有限数字（NaN / Infinity）统一写成 0：JSON 会把它们写成 null，读回来再被当成
 * 0 处理，不如写盘时就干净。非法 entry（不是对象）直接丢，别写进文件。
 */
export function serializeCrossState(store) {
  const source = isPlainObject(store) ? store : {};
  const conversations = isPlainObject(source.conversations) ? source.conversations : {};
  const sorted = {};
  for (const key of Object.keys(conversations).sort()) {
    const conv = conversations[key];
    if (!isPlainObject(conv)) continue;
    const gid = normalizeGid(conv.gid);
    const entries = (Array.isArray(conv.entries) ? conv.entries : []).filter(isPlainObject);
    // 字段顺序固定为 gid / entries / evicted：与 emptyCrossState 和 appendEntry 新建的
    // 会话一致，这样 serialize → parse → serialize 得到完全相同的字符串。
    sorted[key] = {
      gid: gid === null ? 0 : gid,
      entries,
      evicted: Math.max(0, Math.trunc(toNumeric(conv.evicted, 0)))
    };
  }
  return JSON.stringify({ version: 1, conversations: sorted }, (key, value) => (
    typeof value === 'number' && !Number.isFinite(value) ? 0 : value
  ));
}

/** 空状态（dev-doc §2.2 的文件骨架）。 */
export function emptyCrossState() {
  return { version: 1, conversations: {} };
}

/**
 * 读盘后的容错解析（dev-doc §2.2 / §三）。
 *
 * - 非法 JSON、空串、根本不是对象、conversations 不是对象 → 空 store；
 * - 会话 key 不是 `group:/private:` 形态 → 丢弃（这种会话永远进不了 membersOf，
 *   留着只会让文件越滚越大）；
 * - 单条 entry 走同一个 normalizeEntry，非法（ts 坏）的直接丢；
 * - 会话 gid 非法 → 归 0（dev-doc §三）：坏号绝不能变成「1 号组」，那会让两个
 *   本来不相干的会话突然互相可见。
 *
 * 不按 bufferPerConversation 裁剪：上限是运行期配置，写进文件里反而会让
 * 「改小 buffer 再改大」丢失历史；裁剪交给下一条消息的 appendEntry。
 */
export function parseCrossState(text) {
  if (typeof text !== 'string' || text.trim() === '') return emptyCrossState();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyCrossState();
  }
  const store = emptyCrossState();
  if (!isPlainObject(parsed) || !isPlainObject(parsed.conversations)) return store;
  for (const key of Object.keys(parsed.conversations)) {
    if (!isCrossKey(key)) continue;
    const conv = parsed.conversations[key];
    if (!isPlainObject(conv)) continue;
    const entries = [];
    for (const item of Array.isArray(conv.entries) ? conv.entries : []) {
      const entry = normalizeEntry(item);
      if (entry) entries.push(entry);
    }
    const gid = normalizeGid(conv.gid);
    store.conversations[key] = {
      gid: gid === null ? 0 : gid,
      entries,
      evicted: Math.max(0, Math.trunc(toNumeric(conv.evicted, 0)))
    };
  }
  return store;
}
