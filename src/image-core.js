// 生图 / 发图功能的纯逻辑层：配置归一、提示词清洗与闸门、尺寸归一、URL 构造、
// 上游响应解析、额度窗口与用量状态序列化。
//
// 为什么单独成文件：这五道闸门（开关、提示词、尺寸、上游、额度）必须能在**不启动桥接、
// 不联网、不读写 state/** 的前提下被反复验证。`src/image-gen.js` 只负责「拼 URL → 抓字节 →
// 落盘」，判断全在这里。所以本文件不碰文件/网络/系统时钟：`now` 一律由调用方注入（毫秒），
// 唯一 import 是 `auditContent` —— 与 `src/profile-core.js` 同一口径，避免两套关键词规则漂移。
//
// 与 dev-doc §三 的对应关系逐函数注释；与文档有出入的取舍写在注释里，也写在任务报告里。

import { auditContent } from './qzone-post.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 三种写操作。顺序固定：配置归一、额度判定、用量状态都按它来。 */
export const IMAGE_KINDS = Object.freeze(['generate', 'sticker', 'avatar']);

/**
 * 出厂默认值（dev-doc §二逐字段）。
 *
 * `enabled: true` + `safe: true`：生图本身是模型主动画图，不是替人代发；开关默认开，
 * 但提示词闸门、尺寸上限、45 秒间隔三道闸门都不依赖开关。
 */
export const IMAGE_DEFAULTS = Object.freeze({
  enabled: true,
  provider: 'pollinations',
  maxWidth: 768,
  maxHeight: 768,
  promptMaxChars: 300,
  safe: true,
  // windowHours / windowCap / minGapMs 三种操作各一套。
  // generate 的 45 秒与上游免费层「单 IP 至少 45 秒一张、否则 402」对齐：本地先拦，省一次 402。
  generate: Object.freeze({ windowHours: 24, windowCap: 20, minGapMs: 45 * 1000 }),
  sticker: Object.freeze({ windowHours: 24, windowCap: 5, minGapMs: 5 * 1000 }),
  // 头像 24 小时 1 次 + 6 小时间隔：换错头像没有读回校验，只能靠低频降低影响面。
  avatar: Object.freeze({ windowHours: 24, windowCap: 1, minGapMs: 6 * HOUR_MS }),
});

/**
 * 配置钳制区间（dev-doc §二）。
 *
 * 用数组 `[min, max]` 与 `src/qzone-post.js` 保持一致；越界钳回边界而不是回落默认值 ——
 * 用户写 `windowCap: 999` 的意思是「想多画」，钳到 100 比偷偷改回 20 更贴近意图。
 *
 * 文档只写了 maxWidth/maxHeight 的 `256–1024` 与「面积上限 768×768（上游限制）」：
 * 单边钳制放这里，面积上限在 `normalizeSize` 里按比例缩放（`maxArea`）。
 * `promptMaxChars` 文档没给区间，这里补 `[10, 1000]`：0 会让任何提示词都非法，
 * 无限大则等于关掉长度闸门，两个极端都不该由配置静默造成。
 */
export const IMAGE_LIMITS = Object.freeze({
  windowHours: Object.freeze([1, 168]),
  windowCap: Object.freeze([1, 100]),
  minGapMs: Object.freeze([0, DAY_MS]),
  maxSide: Object.freeze([256, 1024]),
  promptMaxChars: Object.freeze([10, 1000]),
  // 上游面积上限：768×768。超过的部分由 normalizeSize 等比缩回。
  maxArea: 768 * 768,
  minSide: 256,
});

/**
 * 允许抓取的图片来源（research §四）：生图站 + QQ 头像 CDN。
 * `src/image-bridge` 的头像 URL 分支与 `image-core.isAllowedImageSource` 共用这一份表。
 */
export const IMAGE_SOURCE_HOSTS = Object.freeze(['image.pollinations.ai', 'q1.qlogo.cn']);

// ── 小工具（纯函数） ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松取数：数字 / 非空数字字符串都认；布尔、空串、对象、NaN/Infinity 一律 NaN。 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  }
  return Number.NaN;
}

/** 整数钳制：非法值回落默认；0 这种合法数字会被抬到下限而不是回落默认。 */
function clampInt(value, bounds, fallback) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(bounds[1], Math.max(bounds[0], Math.trunc(numeric)));
}

function codePointLength(text) {
  return Array.from(text).length;
}

function truncateByCodePoints(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * 压成单行：换行 / 制表 / 全角空格折成单个空格，再删残留控制字符，最后 trim。
 *
 * 顺序与 `src/profile-core.js:sanitizeProfileText` 一致：先折空白再删控制字符，
 * 否则 `a\nb` 会先被删掉换行、粘成 `ab`。这里额外把 U+2028/U+2029 当换行处理，
 * 它们不在 `\s` 里的老引擎上会漏（Node 24 已覆盖，但显式写出来不吃亏）。
 */
function sanitizePromptText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    // 先把所有空白（换行/制表/全角空格/不换行空格）折成半角空格，再删残留控制字符。
    // 顺序不能反：制表符 \u0009 本身在控制字符区间里，先删就会把 `a\tb` 粘成 `ab`。
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

// ── 配置归一 ────────────────────────────────────────────────────────────────

function normalizeWindowConfig(raw, dflt) {
  const source = isPlainObject(raw) ? raw : {};
  return Object.freeze({
    windowHours: clampInt(source.windowHours, IMAGE_LIMITS.windowHours, dflt.windowHours),
    windowCap: clampInt(source.windowCap, IMAGE_LIMITS.windowCap, dflt.windowCap),
    minGapMs: clampInt(source.minGapMs, IMAGE_LIMITS.minGapMs, dflt.minGapMs),
  });
}

/**
 * 把 `config.json` 的 `socialV2.images` 块归一化成可直接使用的冻结对象。
 * 缺段 / 非对象 / 脏值都不抛错；数字字符串（手写配置文件常见）照收。
 *
 * `enabled` / `safe` 只有**显式 false** 才算关：出厂值都是开，判断方向跟着默认值走
 * （与 profile-core 同口径）。`provider` 只认实现过的值，未知值回落 pollinations，
 * 避免手滑写 `provider:"openai"` 后请求仍发到 pollinations 却以为切了通道。
 */
export function normalizeImageConfig(source) {
  const raw = isPlainObject(source) ? source : {};
  return Object.freeze({
    enabled: raw.enabled !== false,
    // 只停「生图」的细分开关：出图渠道质量不行时关掉它，发图 / 存表情 / 换头像
    // 三条腿仍可用（换头像还能吃收藏表情或图片链接）。与 enabled 同口径：
    // 只有显式 false 才算关。
    generateEnabled: raw.generateEnabled !== false,
    provider: raw.provider === 'pollinations' ? raw.provider : IMAGE_DEFAULTS.provider,
    maxWidth: clampInt(raw.maxWidth, IMAGE_LIMITS.maxSide, IMAGE_DEFAULTS.maxWidth),
    maxHeight: clampInt(raw.maxHeight, IMAGE_LIMITS.maxSide, IMAGE_DEFAULTS.maxHeight),
    promptMaxChars: clampInt(raw.promptMaxChars, IMAGE_LIMITS.promptMaxChars, IMAGE_DEFAULTS.promptMaxChars),
    safe: raw.safe !== false,
    generate: normalizeWindowConfig(raw.generate, IMAGE_DEFAULTS.generate),
    sticker: normalizeWindowConfig(raw.sticker, IMAGE_DEFAULTS.sticker),
    avatar: normalizeWindowConfig(raw.avatar, IMAGE_DEFAULTS.avatar),
  });
}

// ── 提示词：清洗与闸门 ──────────────────────────────────────────────────────

/**
 * 提示词清洗：单行化 + 截断（按**码点**，emoji 算一个）。
 *
 * `maxChars` 缺省取 300（出厂 `promptMaxChars`）；非数字 / 小于 1 回落默认。
 * 截断放在最后：先删控制字符再量长度，`a\u0001b` 才不会白占一格。
 */
export function cleanImagePrompt(raw, maxChars = IMAGE_DEFAULTS.promptMaxChars) {
  const wanted = toFiniteNumber(maxChars);
  const limit = Number.isFinite(wanted) && wanted >= 1
    ? Math.trunc(wanted)
    : IMAGE_DEFAULTS.promptMaxChars;
  return truncateByCodePoints(sanitizePromptText(raw), limit);
}

/**
 * 生图提示词黑名单（dev-doc §三「黑名单（色情/暴力/真实人名意图）」）。
 *
 * 只收**明确**的类别词，避免把「打架」「血」「死」这类日常词也拦下来：
 * 画一只受伤的猫、画晚霞的红色都不该被自己的闸门误伤。中文按子串匹配；
 * 英文按词边界匹配（`porn` 不会命中 `Sussex`，`nude` 不会命中 `denuded` 之外的地方）。
 */
export const IMAGE_BANNED_TERMS = Object.freeze([
  // 色情 / 性暴力
  // 注：「裸照」不在这里，只由下面的 REAL_PERSON_RE 拒绝 —— 两条闸门都拦得住，
  // 但保留在正则里才能让「画真人照片意图」的命中理由统一是 real_person。
  '色情', '黄图', '裸体', '做爱', '性交', '口交', '肛交', '乱伦',
  '强奸', '轮奸', '迷奸', '性虐待', '兽交',
  'porn', 'pornography', 'pornographic', 'nude', 'naked', 'nsfw', 'hentai',
  'explicit sex', 'sexual violence',
  // 未成年性化
  '儿童色情', '幼女', '未成年裸照',
  'child porn', 'child pornography', 'underage sex', 'lolicon',
  // 写实血腥 / 肢解
  '开膛', '剖腹', '内脏外露', '斩首', '肢解', '碎尸', '虐杀', '血淋淋',
  'gore', 'dismember', 'dismemberment', 'decapitate', 'decapitation', 'snuff',
  // 恐怖袭击 / 危险品教程
  '制作炸弹', '炸弹配方', '炸弹教程', '爆炸物制作', '制毒', '恐怖袭击', '劫机',
  'bomb recipe', 'how to make a bomb', 'pipe bomb', 'terrorist attack',
]);

// 中文词用 includes；英文词预编译成带边界的正则（英文不区分大小写）。
const CJK_RE = /[\u3400-\u9fff]/;
const BANNED_MATCHERS = Object.freeze(IMAGE_BANNED_TERMS.map((term) => {
  if (CJK_RE.test(term)) return { term, test: (text) => text.includes(term) };
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
  return { term, test: (text) => re.test(text.toLowerCase()) };
}));

/**
 * 「画真人照片」意图（dev-doc §三最后一行给的形状，逐字实现）。
 * 这一类不是靠词表能穷举的：模型被诱导「发一张某某的照片」时必须在这里就拒掉，
 * 只允许画风描述、不做图生图（research §四）。
 */
const REAL_PERSON_RE = /真实(?:人物|照片)|真人照|身份证照|裸照/;

const MIN_PROMPT_CHARS = 3;

/**
 * 提示词闸门（dev-doc §三）：
 *   长度 3..promptMaxChars（按码点）→ auditContent → 黑名单 → 真人照片意图。
 *
 * `auditContent` 按 profile-core 的口径传 `promptMaxChars * 2`：它用 UTF-16 长度判超长，
 * 而这里用码点判，emoji 混排时 UTF-16 最多是码点的 2 倍。即使如此，它的 `length` 命中
 * 也一律过滤掉 —— 长度已经由上面的码点判定负责，否则一个刚满 300 码点的 emoji 提示词
 * 会被审计层再拒一次。空串/太短在进入审计前就返回，不会看到「空的发什么」这种奇怪理由。
 *
 * `reason` 是稳定的代码（不是人话文案）：`too_short` / `too_long` / `audit` / `banned_term` /
 * `real_person`。`audit` 的 `hits` 原样带 `rule`（url/phone/email/idcard/solicit），
 * 桥接与 MCP 层据此拼中文解释。
 */
export function checkImagePrompt(text, cfg) {
  const config = normalizeImageConfig(cfg);
  const body = sanitizePromptText(text);
  const length = codePointLength(body);
  if (length < MIN_PROMPT_CHARS) return { ok: false, reason: 'too_short', hits: [] };
  if (length > config.promptMaxChars) return { ok: false, reason: 'too_long', hits: [] };

  const audit = auditContent(body, { maxChars: Math.max(1, config.promptMaxChars * 2) });
  const auditHits = Array.isArray(audit.hits) ? audit.hits.filter((hit) => hit.rule !== 'length') : [];
  if (auditHits.length > 0) return { ok: false, reason: 'audit', hits: auditHits };

  const banned = BANNED_MATCHERS.filter((matcher) => matcher.test(body)).map((matcher) => matcher.term);
  if (banned.length > 0) return { ok: false, reason: 'banned_term', hits: banned };

  const realPerson = body.match(REAL_PERSON_RE);
  if (realPerson) return { ok: false, reason: 'real_person', hits: [realPerson[0]] };

  return { ok: true, reason: '', hits: [] };
}

// ── 尺寸归一 ────────────────────────────────────────────────────────────────

/** 单边取值：非法/非正 → 默认边；有效值夹到 [256, 配置上限]。 */
function clampSide(value, max, fallback) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(IMAGE_LIMITS.minSide, Math.trunc(numeric)));
}

/**
 * 尺寸归一（dev-doc §三）：保比例、面积为上限、最小 256。
 *
 * 顺序：先按配置上限夹单边（超上限的请求被削到上限），再在面积超限时对两边开根号缩放。
 * 缩放后取整可能让乘积比上限多出几个像素（向下取整两边反而会缩过头），所以最后再逐像素
 * 减较大的一边，保证 `width * height <= 768 * 768` —— 上游是按面积忽略/缩回请求的，
 * 多出的几个像素等于白丢一次出图机会。
 *
 * 0 / 负数按「用户明确写了一个不可用值」处理：抬到最小边 256，而不是静默回落 768
 * （与 profile-core 的 clampInt 口径一致）。缺省/非数字才回落配置上限。
 */
export function normalizeSize(width, height, cfg) {
  const config = normalizeImageConfig(cfg);
  let w = clampSide(width, config.maxWidth, config.maxWidth);
  let h = clampSide(height, config.maxHeight, config.maxHeight);
  if (w * h > IMAGE_LIMITS.maxArea) {
    const scale = Math.sqrt(IMAGE_LIMITS.maxArea / (w * h));
    w = Math.max(IMAGE_LIMITS.minSide, Math.round(w * scale));
    h = Math.max(IMAGE_LIMITS.minSide, Math.round(h * scale));
    while (w * h > IMAGE_LIMITS.maxArea) {
      if (w >= h) w -= 1;
      else h -= 1;
    }
  }
  return { width: w, height: h };
}

// ── 上游 URL ────────────────────────────────────────────────────────────────

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';

function clampUrlSide(value, fallback) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(IMAGE_LIMITS.maxSide[1], Math.max(IMAGE_LIMITS.minSide, Math.trunc(numeric)));
}

/**
 * 拼 pollinations 生图 URL（research §一）：
 * `GET /prompt/<urlencoded prompt>?width=&height=&seed=&nologo=true&safe=true`
 *
 * 提示词只放在 path 里并用 `encodeURIComponent` 整体编码 —— 中文、空格、`&`、`/`
 * 都必须编码，否则 `a&b` 会被上游当成查询参数截断（画出来的东西和用户说的无关）。
 * 尺寸在这里再做一次兜底夹取：调用方漏传/传 0/传超上限时，URL 仍然是一个合法请求。
 * `seed` 缺省不出现（每次随机）；`safe` / `nologo` 缺省都 true。
 */
export function buildPollinationsUrl(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { prompt, width, height, seed, safe, nologo } = source;
  const text = cleanImagePrompt(prompt);
  const url = new URL(`${POLLINATIONS_BASE}${encodeURIComponent(text)}`);
  url.searchParams.set('width', String(clampUrlSide(width, IMAGE_DEFAULTS.maxWidth)));
  url.searchParams.set('height', String(clampUrlSide(height, IMAGE_DEFAULTS.maxHeight)));
  const seedValue = toFiniteNumber(seed);
  if (Number.isFinite(seedValue)) url.searchParams.set('seed', String(Math.trunc(seedValue)));
  url.searchParams.set('nologo', nologo === false ? 'false' : 'true');
  url.searchParams.set('safe', safe === false ? 'false' : 'true');
  return url.toString();
}

// ── 上游响应解析 ────────────────────────────────────────────────────────────

/** 只认 DSH/QQ 都支持的四种图片魔数；返回 mime 或 null。 */
function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6) {
    const head = buffer.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const DEFAULT_RETRY_AFTER_MS = IMAGE_DEFAULTS.generate.minGapMs;

/**
 * `Retry-After` → 毫秒。上游按**秒数**给（research §一），也兼容数字字符串。
 * 缺省 / 非数字 / 非正数一律 45000（与 generate.minGapMs 对齐）；上限 24 小时，
 * 避免一个荒唐的头把 `retryAfterMs` 顶到几年后（桥接会原样回给用户）。
 */
function retryAfterMsFrom(value) {
  const seconds = toFiniteNumber(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(DAY_MS, Math.max(1000, Math.round(seconds * 1000)));
}

/**
 * 402 的 JSON body → 毫秒。Pollinations 的 402 **没有 Retry-After 头**，真实等待时间在
 * `error.message` 里（例：`Free limit reached: ... Retry after 18s, or ...`）。
 * 只有能解析成 JSON 才抽（避免把 HTML 错误页里的巧合文本当等待时间），
 * 优先 `error.message`，没有再搜整个 body 文本；抽不到返回 0 交给头/45000 兜底。
 * 秒数夹到 [1000, 24h]：0 秒没有意义，超大值不能让桥接把几年后的时间回给用户。
 */
function retryAfterMsFromBody(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 0;
  let text;
  try {
    text = buffer.toString('utf8');
  } catch {
    return 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : '';
  const match = message.match(/retry after\s*(\d+)\s*s/i) || text.match(/retry after\s*(\d+)\s*s/i);
  if (!match) return 0;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(DAY_MS, Math.max(1000, Math.round(seconds * 1000)));
}

/**
 * 上游响应归一（dev-doc §三）：
 *   - 200 + 图片魔数 → `{ ok:true, mime, bytes }`
 *   - 402 → `{ ok:false, reason:'rate_limited', retryAfterMs, status:402 }`（不重试）
 *   - 200 但不是图片 → `{ ok:false, reason:'bad_content', status:200 }`
 *   - 其余（含 201 / 缺 status）→ `{ ok:false, reason:'upstream_error', status }`
 *
 * 只看魔数、**不看 content-type**：上游把 JPEG 标成 octet-stream 也照样能用，
 * 而 content-type 写着 image/jpeg 正文却是 HTML 错误页的情况反而更常见。
 * 缺 status 记 0：调用方日志里能看出「根本没拿到状态码」，而不是伪装成 500。
 */
export function parseImageResult(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { status, retryAfter, contentType, buffer } = source;
  // contentType 保留在签名里是为了调用方少拆一层；判定不依赖它（见上）。
  void contentType;
  const statusRaw = toFiniteNumber(status);
  const statusCode = Number.isFinite(statusRaw) ? Math.trunc(statusRaw) : 0;

  if (statusCode === 402) {
    // 顺序：body 里的真实秒数 → Retry-After 头 → 45000。上游 402 通常没有头，body 才是准的。
    const fromBody = retryAfterMsFromBody(buffer);
    const retryAfterMs = fromBody > 0 ? fromBody : retryAfterMsFrom(retryAfter);
    return { ok: false, reason: 'rate_limited', retryAfterMs, status: 402 };
  }
  if (statusCode !== 200) return { ok: false, reason: 'upstream_error', status: statusCode };

  const mime = sniffImageMime(buffer);
  if (!mime) return { ok: false, reason: 'bad_content', status: 200 };
  return { ok: true, mime, bytes: buffer.length };
}

// ── 额度窗口 ────────────────────────────────────────────────────────────────

const MAX_USAGE_ENTRIES = 500;

function normalizeUsageEntry(raw) {
  if (!isPlainObject(raw)) return null;
  if (!IMAGE_KINDS.includes(raw.kind)) return null;
  const ts = toFiniteNumber(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const entry = { kind: raw.kind, ts: Math.trunc(ts) };
  if (typeof raw.imageId === 'string' && raw.imageId.trim() !== '') {
    entry.imageId = truncateByCodePoints(raw.imageId.trim(), 64);
  }
  return entry;
}

/**
 * 用量状态归一的内部实现：接受 `{ entries:[…] }`、`state` 对象或裸数组，脏条目丢弃。
 * 按 ts 升序排列并只留最近 500 条 —— 状态文件可能被手改/旧版本倒序写过，
 * 排序后再截断才确保丢的是最旧的，而不是文件最前面的。
 */
function normalizeImageUsage(input) {
  const source = Array.isArray(input) ? { entries: input } : input;
  const list = isPlainObject(source) && Array.isArray(source.entries) ? source.entries : [];
  const entries = list
    .map(normalizeUsageEntry)
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_USAGE_ENTRIES);
  return { version: 1, entries };
}

/**
 * 额度判定（dev-doc §三），与 `profile-core.quotaFor` 同口径的**八个字段**：
 * `{ ok, reason, retryAfterMs, windowCount, remaining, windowHours, windowCap, minGapMs }`。
 *
 * 顺序固定：disabled → unknown_kind → too_frequent → window_cap → ok。
 * 最小间隔先判：它能给出更准的 `retryAfterMs`（几十秒后就能再试），窗口满了要等到
 * 最早那次滑出窗口。
 *
 * 窗口 `(now - windowHours, now]`：正好落在左边界上的已经滑出去，未来时间戳不计
 * （时钟回拨不该挤占现在的额度）。但**最小间隔**用最近一次的实际 ts：若它来自未来
 * （手改文件 / 时钟回拨），按 `now` 计（`lastForGap`），既不会白送一次，也不会因为一个
 * 2099 年的时间戳让人再也画不了。
 *
 * `usage` 传整个 `state/image-usage.json` 或 `{ entries }` 均可；脏数据不抛错。
 */
export function imageQuota(usage, cfg, kind, now) {
  const config = normalizeImageConfig(cfg);
  const state = normalizeImageUsage(usage);
  const nowRaw = toFiniteNumber(now);
  const at = Number.isFinite(nowRaw) && nowRaw > 0 ? nowRaw : 0;
  const known = IMAGE_KINDS.includes(kind);
  const params = known ? config[kind] : null;
  const windowHours = params ? params.windowHours : 0;
  const windowCap = params ? params.windowCap : 0;
  const minGapMs = params ? params.minGapMs : 0;

  // 被 disabled / 坏参数挡住时没有一次计数成立：八个字段照样给齐，调用方不用写特例。
  const blocked = (reason) => ({
    ok: false,
    reason,
    retryAfterMs: 0,
    windowCount: 0,
    remaining: 0,
    windowHours,
    windowCap,
    minGapMs,
  });
  if (config.enabled === false) return blocked('disabled');
  if (!known) return blocked('unknown_kind');

  const windowMs = windowHours * HOUR_MS;
  const windowStart = at - windowMs;
  let windowCount = 0;
  let earliest = 0;
  let lastTs = 0;
  for (const item of state.entries) {
    if (item.kind !== kind) continue;
    if (item.ts > lastTs) lastTs = item.ts;
    if (item.ts > windowStart && item.ts <= at) {
      windowCount += 1;
      if (earliest === 0 || item.ts < earliest) earliest = item.ts;
    }
  }
  const remaining = Math.max(0, windowCap - windowCount);
  const lastForGap = lastTs > at ? at : lastTs;

  if (lastForGap > 0 && at - lastForGap < minGapMs) {
    return {
      ok: false,
      reason: 'too_frequent',
      // 时钟回拨时 at - lastForGap 是负数，等的时间会比 minGapMs 更长 —— 故意的：
      // 把系统时间往前拨一下不该等于解除最小间隔。
      retryAfterMs: Math.max(1, Math.ceil(minGapMs - (at - lastForGap))),
      windowCount,
      remaining,
      windowHours,
      windowCap,
      minGapMs,
    };
  }
  if (windowCount >= windowCap) {
    return {
      ok: false,
      reason: 'window_cap',
      // 窗口内至少有一条（windowCount ≥ 1），earliest 一定有效。
      retryAfterMs: Math.max(1, Math.ceil(earliest + windowMs - at)),
      windowCount,
      remaining: 0,
      windowHours,
      windowCap,
      minGapMs,
    };
  }
  return {
    ok: true,
    reason: '',
    retryAfterMs: 0,
    windowCount,
    remaining,
    windowHours,
    windowCap,
    minGapMs,
  };
}

/**
 * 记一次成功用量：追加 `{ kind, ts, imageId? }`，返回**新**状态（不改入参）。
 *
 * 坏 kind / 坏 now 一律原样返回归一后的状态，不抛错也不记一条无意义的 ts=0
 * （它会永远留在窗口外，除了撑大文件没有作用）。`imageId` 只收非空字符串并截 64 字。
 */
export function recordImageUsage(usage, kind, now, meta) {
  const state = normalizeImageUsage(usage);
  const tsRaw = toFiniteNumber(now);
  if (!IMAGE_KINDS.includes(kind) || !Number.isFinite(tsRaw) || tsRaw <= 0) return state;
  const entry = { kind, ts: Math.trunc(tsRaw) };
  if (isPlainObject(meta) && typeof meta.imageId === 'string') {
    const imageId = meta.imageId.trim();
    if (imageId !== '') entry.imageId = truncateByCodePoints(imageId, 64);
  }
  const entries = [...state.entries, entry].sort((a, b) => a.ts - b.ts).slice(-MAX_USAGE_ENTRIES);
  return { version: 1, entries };
}

/** 用量状态 → JSON 文本（缩进 2，方便人工排查；桥接侧用原子写落盘）。 */
export function serializeImageUsage(usage) {
  return JSON.stringify(normalizeImageUsage(usage), null, 2);
}

/**
 * JSON 文本 → 用量状态，**永不抛**：坏 JSON / null / 缺字段都返回空状态。
 * 也接受已解析的对象/数组（调用方从内存传回来时少一次 stringify）。
 */
export function parseImageUsage(text) {
  if (isPlainObject(text) || Array.isArray(text)) return normalizeImageUsage(text);
  if (typeof text !== 'string' || text.trim() === '') return { version: 1, entries: [] };
  try {
    return normalizeImageUsage(JSON.parse(text));
  } catch {
    return { version: 1, entries: [] };
  }
}

// ── 图片来源 ────────────────────────────────────────────────────────────────

/**
 * 图片 URL 白名单（research §四）：只认 https + hostname **精确**等于
 * `IMAGE_SOURCE_HOSTS`。`https://image.pollinations.ai.evil.com`、`www.` 变体、
 * 子域名一律拒绝（子串匹配会被这些形状绕过）。
 *
 * 额外拒绝：带凭据的 URL（日志/转发时容易泄露）、显式端口（白名单域没有非 443 的服务，
 * 免得把请求指到内网转发器）。
 */
export function isAllowedImageSource(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '') return false;
  return IMAGE_SOURCE_HOSTS.includes(parsed.hostname.toLowerCase());
}
