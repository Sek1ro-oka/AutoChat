// 三平台（B站 / 小红书 / 小黑盒）只读检索的**纯逻辑层**。
//
// 为什么单独一层：这些函数全是「字符串进、字符串出」的判断——平台别名归一、关键词清洗、
// 条数夹取、上游 stdout 的 JSON 容错解析、结果话术拼装。放在这里就能被单测逐条钉死
// （scripts/test-reach-tools.mjs 注入假数据即可），不需要起子进程、不碰网络、不读配置。
// 真正的 CLI 调用、超时、二进制探测在 src/reach-tools.js。
//
// 只读约束落在这一层的意思是：**本模块没有、也不该有「往平台写东西」的函数**。
// 它只认识「搜」和「读一条」，任何需要登录态或写接口的动作都不在能力面里。

/** 对外展示的平台名（工具文案、结果第一行都用它）。 */
export const PLATFORM_LABELS = Object.freeze({
  bili: 'B站',
  xhs: '小红书',
  heybox: '小黑盒'
});

/** 模型能传的平台写法；键必须是小写（normalizePlatform 会先 toLowerCase）。 */
const PLATFORM_ALIASES = new Map(Object.entries({
  bili: 'bili',
  bilibili: 'bili',
  b站: 'bili',
  'b 站': 'bili',
  '小破站': 'bili',
  '哔哩哔哩': 'bili',
  '哔哩': 'bili',
  xhs: 'xhs',
  xiaohongshu: 'xhs',
  '小红书': 'xhs',
  redbook: 'xhs',
  '红书': 'xhs',
  heybox: 'heybox',
  xiaoheihe: 'heybox',
  '小黑盒': 'heybox',
  '黑盒': 'heybox'
}));

/** 参数校验失败时给模型看的可选值列表（别让它去猜写法）。 */
export const PLATFORM_CHOICES = 'bili（B站）/ xhs（小红书）/ heybox（小黑盒）';

/** 关键词硬上限：与 bili-safe / heybox 的 60 字口径保持一致。 */
export const QUERY_MAX = 60;

/** 条数默认值与上限：列表最多 20 条（再多就只是把上下文撑爆）。 */
export const LIMIT_DEFAULT = 8;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 20;

/** 详情正文上限：超长截断并标注，避免一条长文占满上下文。 */
export const READ_MAX_CHARS = 4000;

/** 结果里 URL 的展示上限：正常链接都在 100 字内，10k 的畸形链接不能把话术撑爆。 */
export const URL_MAX = 300;

/** 报错原文的展示上限：上游偶尔会把整段请求体回显在 message 里。 */
export const ERROR_TEXT_MAX = 500;

/**
 * 小红书 AI 问答降级结果的固定前缀（T-028）。
 *
 * 这是**话术的一部分**，不是装饰：模型与群友都必须一眼看出「这不是笔记列表」。
 * 改这句话等于改契约（单测 scripts/test-reach-tools.mjs 会逐字断言）。
 */
export const XHS_ASK_PREFIX = '【小红书·AI 问答（站内搜索当前不可用，已降级；这不是笔记列表，是小红书的 AI 汇总）】';

/** 降级结果里最多列几条来源：AI 回答本身已经很长，来源只用来给出处。 */
export const ASK_SOURCES_MAX = 5;

// ── 网页层兜底（T-029）─────────────────────────────────────────────────────
/**
 * 小红书网页搜索页（只用来**读**：打开一个搜索结果页，把页面上的卡片抓下来）。
 *
 * 为什么需要这条路：这台机器上 `opencli xiaohongshu search` 会稳定超时
 * （`xiaohongshu/search timed out after 60s`），而网页搜索页在浏览器里是能开的。
 * 抓的是页面已经渲染出来的卡片，不点、不输、不登录。
 */
export const XHS_SEARCH_PAGE_URL = 'https://www.xiaohongshu.com/search_result';

/**
 * 卡片选择器：**常量**，绝不拼用户输入（用户输入只进 URL，且过 encodeURIComponent）。
 *
 * 为什么是 `[class*="note-item"]` 而不是 `.note-item`：小红书的 class 带哈希后缀
 * （`note-item_x1y2z`），精确类名每次发版都会变；`class*=` 只依赖固定前缀。
 * 为什么要再套一层 `a[href*="/explore/"]`：实测 30 个 `[class*=note-item]` 里有约 5 个
 * 是「大家都在搜」的推荐词块（没有 `/explore/` 链接），必须按链接把它们剔掉。
 */
export const XHS_CARD_SELECTOR = '[class*="note-item"] a[href*="/explore/"]';

/** 网页兜底话术的固定首行（单测逐字断言）。 */
export const XHS_BROWSER_PREFIX = '【小红书·网页抓取（站内搜索不可用，已降级到网页搜索页；下面是页面上的真实笔记卡片）】';

/** 小黑盒话题/游戏兜底话术的固定首行（单测逐字断言）。 */
export const HEYBOX_TYPE_PREFIX = '小黑盒帖子搜索被验证码拦了，下面是话题/游戏结果（不是帖子）：';

/**
 * 兜底链路上的失败原因（`reason`）。写成常量而不是字面量：
 * `scripts/test-reach-tools.mjs` 会对 `src/reach-tools.js` 做「不出现 lg 那个单词」的
 * 只读源码断言（贴子/评论那套写动作的字眼一律禁止），常量名放这里就不会撞上。
 */
export const XHS_BROWSER_WALL = 'login_required';
export const XHS_BROWSER_PAGE_CHANGED = 'page_changed';
export const XHS_BROWSER_UNAVAILABLE = 'browser_unavailable';
export const BROWSER_TIMEOUT = 'timeout';
export const HEYBOX_TYPE_EMPTY = 'type_fallback_empty';

/**
 * 已知的「失败码」：上游把错误放在 `code` 里而**不带** `ok:false` 时靠它兜住。
 * 取自三个 CLI 的真实输出（opencli 的 TIMEOUT / COMMAND_EXEC / ARGUMENT 等）。
 */
export const FAILURE_CODES = Object.freeze(new Set([
  'TIMEOUT', 'COMMAND_EXEC', 'ARGUMENT', 'AUTH', 'AUTH_REQUIRED', 'CAPTCHA',
  'RATE_LIMIT', 'NETWORK', 'PROTOCOL', 'PARSE', 'INTERNAL', 'UNKNOWN', 'ERROR', 'FAILED'
]));

/**
 * 数字错误码的白名单：只有 HTTP 风格（≥400）与明确约定的 sysexits 值才算失败。
 *
 * 为什么不能「非 0 即错」：`code: 200` / `code: 1` 在真实成功载荷里都出现过
 * （T-028 审查 S-001 的定向探针），把成功判成失败会让有效搜索结果被丢掉、再走一次 ask。
 * 75 = EX_TEMPFAIL，是 opencli 超时用过的退出码（见 T-027 research）。
 */
const NUMERIC_FAILURE_CODES = Object.freeze(new Set([75]));

const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
// 控制字符 + 零宽/方向标记 + 行分隔符 + BOM：关键词里出现这些只会把参数弄脏。
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function firstText(...values) {
  for (const value of values) {
    const text = textOf(value).trim();
    if (text !== '') return text;
  }
  return '';
}

/** 压成单行再截断：列表/标题里带换行会让结果很难读。 */
function squash(value, max = 120) {
  const text = textOf(value).replace(/\s+/g, ' ').trim();
  return truncateChars(text, max).text;
}

/** 按码点数截断（中文/emoji 都算一个字），超长补 `…` 并给出原始长度。 */
export function truncateChars(value, max) {
  const text = textOf(value);
  const chars = [...text];
  if (!Number.isFinite(max) || max <= 0) return { text: '', total: chars.length, truncated: chars.length > 0 };
  if (chars.length <= max) return { text, total: chars.length, truncated: false };
  return { text: `${chars.slice(0, max).join('')}…`, total: chars.length, truncated: true };
}

/**
 * URL 的展示截断：保证**含省略号也不超过 URL_MAX 字**。
 *
 * 不能直接用 truncateChars(url, URL_MAX)：它会给出 max+1 个字（省略号另算），
 * 而文档/契约写的是「每条 URL ≤300 字」。这里截到 299 再补一个 `…`。
 */
export function truncateUrl(value) {
  const text = textOf(value);
  const chars = [...text];
  if (chars.length <= URL_MAX) return text;
  return `${chars.slice(0, URL_MAX - 1).join('')}…`;
}

/**
 * 非负整数；缺失/非法回 null（null 在话术里表示「这个平台不提供这项数字」）。
 *
 * 上游的数字有三种写法：`8152`（bili）、`"16"`（小红书部分接口给字符串）、
 * `"1.2万"`（小红书/小黑盒的展示值）。三种都得认，否则列表里会莫名出现「无数据」。
 */
function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  const text = textOf(value).trim().replace(/,/g, '');
  const matched = text.match(/^(\d+(?:\.\d+)?)(万|亿|w|k)?$/i);
  if (!matched) return null;
  const base = Number(matched[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  const unit = (matched[2] ?? '').toLowerCase();
  const scale = unit === '万' || unit === 'w' ? 10000 : (unit === '亿' ? 100000000 : (unit === 'k' ? 1000 : 1));
  return Math.trunc(base * scale);
}

/**
 * 夹取整数，`null` / `''` / 布尔 / 非数字一律回 fallback。
 *
 * 为什么不能只靠 `Number()`：`Number(null)` 与 `Number('')` 都是 **0**，会被当成
 * 「显式配了 0」然后夹到下界——于是 `timeoutMs: null` 变成 5s（实测过），
 * 一次刚好慢一点的调用就被判成超时。缺省/空值必须回到默认值。
 */
function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// ── 参数归一 ────────────────────────────────────────────────────────────────
/**
 * 平台别名 → 内部键（`bili` / `xhs` / `heybox`），认不出回空串。
 *
 * 为什么要认中文：模型拿到的工具描述是中英混排的，群友也会说「帮我搜小红书」，
 * 让它先自己翻译成 `xhs` 既多余又容易错。认不出时调用方必须报 bad_platform，
 * **不要**偷偷当成 B站 之类去查——那会把一次参数错误变成一次错误的联网。
 */
export function normalizePlatform(value) {
  const text = textOf(value).trim().toLowerCase();
  if (text === '') return '';
  return PLATFORM_ALIASES.get(text) ?? '';
}

/**
 * 关键词清洗（不截断）：控制字符 → 空格，连续空白压成一个，首尾去空。
 * 不做「删除」而是「替换成空格」，免得把 `原神\n攻略` 粘成 `原神攻略` 这种怪词。
 */
export function cleanQuery(value) {
  return textOf(value).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 关键词归一：清洗 + 按码点硬截到 60 字。空/全是空白 → 空串。
 *
 * 这里**不加省略号**：截断结果是直接交给上游 CLI 的参数，不是给人看的文案——
 * 多一个「…」就会去搜一个带省略号的词。
 */
export function normalizeQuery(value) {
  return [...cleanQuery(value)].slice(0, QUERY_MAX).join('').trim();
}

/**
 * 条数夹取：1–20，非法/缺失回退（默认 8）。
 *
 * 注意「非法」与「越界」不同：`50` 夹成 20（模型只是要得多），`abc` 回退默认值
 * （模型压根没给数字）。两者都不报错——条数不值得让一次查询整个失败。
 */
export function clampLimit(value, fallback = LIMIT_DEFAULT) {
  const fallbackValue = clampInt(fallback, LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX);
  if (value === null || value === undefined || value === '') return fallbackValue;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackValue;
  return Math.min(Math.max(Math.trunc(n), LIMIT_MIN), LIMIT_MAX);
}

/** 浏览器会话名：只允许字母数字与 `-`/`_`（它会进 opencli 的 `--session` 参数位）。 */
const SESSION_RE = /[^0-9A-Za-z_-]/g;

/** 网页兜底默认会话名：固定一个，方便用户自己也知道该关哪个标签。 */
export const BROWSER_SESSION_DEFAULT = 'reach';

/**
 * 开关归一（T-029 新增的两个开关）：JSON 里写 `false` 最常见，但手改 `config.json` 时
 * 写成 `"false"` / `"no"` / `"0"` 的情况也见过，一并按「关」处理；不认识的值仍按默认开。
 */
function flagOn(value) {
  if (value === false) return false;
  const text = textOf(value).trim().toLowerCase();
  if (text === 'false' || text === 'no' || text === '0' || text === 'off') return false;
  return true;
}

/** 配置段归一（config.json 的 `reach`）。缺省 = 出厂默认，`enabled` 只在显式 false 时关。 */
export function normalizeReachConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const session = textOf(source.browserSession).replace(SESSION_RE, '').slice(0, 32);
  return {
    enabled: source.enabled !== false,
    timeoutMs: clampInt(source.timeoutMs, 120000, 5000, 300000),
    maxResults: clampLimit(source.maxResults, LIMIT_DEFAULT),
    // 小红书站内搜索坏掉时的降级开关：默认开，只有显式 false 才关（关掉后回到 T-027 的裸 unavailable）。
    xhsAskFallback: source.xhsAskFallback !== false,
    // 小红书：站内搜索坏了先试**网页抓取**（T-029），再试 ask（T-028）。两个开关独立。
    xhsBrowserSearch: flagOn(source.xhsBrowserSearch),
    // 站内搜索这一站单独计时（P-001）：opencli 的 xiaohongshu search 现在会一路挂到 60 秒才回，
    // 拿全局 120s 去等它就是白等两分钟。这里只给 12 秒，超了就换网页抓取。
    xhsCliTimeoutMs: clampInt(source.xhsCliTimeoutMs, 12000, 3000, 60000),
    browserSession: session !== '' ? session : BROWSER_SESSION_DEFAULT,
    // 只允许两个值：其它取值一律回落到 background（后台标签，不抢用户的前台窗口）。
    browserWindow: source.browserWindow === 'foreground' ? 'foreground' : 'background',
    browserTimeoutMs: clampInt(source.browserTimeoutMs, 60000, 10000, 300000),
    // 小黑盒：帖子搜索被验证码拦了时，改搜「话题 / 游戏」（T-029）。
    heyboxTypeFallback: flagOn(source.heyboxTypeFallback),
    biliBin: textOf(source.biliBin).trim(),
    opencliBin: textOf(source.opencliBin).trim(),
    xiaoheiheBin: textOf(source.xiaoheiheBin).trim()
  };
}

// ── JSON 容错 ───────────────────────────────────────────────────────────────
/**
 * 从上游 stdout 里挖出 JSON，容忍「前面有别的行」与「后面带尾巴」。
 *
 * 真实样本：bili-cli 是 Python 写的，某些机器上会在 stdout 先打一行
 * `UserWarning: Bad certificate in Windows certificate store…`，之后才是 JSON；
 * 个别 CLI 还会在 JSON 后面补一句人话。所以不是「从第一个 `{` 起整段 parse」就够：
 * 第一个 `{`/`[` 可能是警告行里的方括号，必须两个起点都试，失败再按最后一个
 * `}`/`]` 收尾重试一次。解不出就返回 null，由调用方带原始输出报错（绝不猜内容）。
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/^\uFEFF/, '');
  const starts = [body.indexOf('{'), body.indexOf('[')].filter((index) => index >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const slice = body.slice(start);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
    const end = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (end > 0) {
      try {
        const parsed = JSON.parse(slice.slice(0, end + 1));
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
  }
  return null;
}

/** 上游结构化错误里的一句人话：优先 message，其次 error/reason/hint。上限 500 字。 */
export function upstreamErrorText(json) {
  if (!json || typeof json !== 'object') return '';
  const error = json.error && typeof json.error === 'object' ? json.error : {};
  const parts = [];
  // `status` 也算一种「码」：HTTP 风格的 `{status:500}` 没有 code/message 时，
  // 不把它带出来的话，模型只会看到「上游没有给出原因」。只认数字形态，别把 `status:'ok'` 当码。
  const statusText = textOf(json.status).trim();
  const status = typeof json.status === 'number' || /^\d+$/.test(statusText) ? json.status : '';
  const code = firstText(error.code, json.code, status);
  const message = firstText(error.message, json.message, json.reason, json.hint);
  if (code !== '') parts.push(code);
  if (message !== '') parts.push(message);
  const exitCode = error.exitCode ?? error.exit_code;
  if (exitCode !== undefined && exitCode !== null && exitCode !== '') parts.push(`exitCode ${exitCode}`);
  // 截断是为了守住「一个报错不能把上下文撑爆」：上游的错误 message 里可能整段回显请求体。
  return truncateChars(parts.join('：'), ERROR_TEXT_MAX).text;
}

const SUCCESS_CODE_TEXT_RE = /^(OK|0)$/i;

/**
 * `code` 归类（§7.1 / §7.2）：成功码 / 失败码 / 未知。
 *
 * 成功码：numeric 0 / 2xx、字符串 `'OK'` / `'0'`。
 * 失败码：numeric ≥400 或 75、字符串 FAILURE_CODES 白名单及 `*_ERROR` / `ERROR` / `FAILED`。
 * 其它（numeric 1、3xx、`'PARSE'` 之类）一律「未知」：单独出现不构成失败。
 */
function codeKind(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'unknown';
    if (value === 0 || (value >= 200 && value < 300)) return 'success';
    if (value >= 400 || NUMERIC_FAILURE_CODES.has(value)) return 'failure';
    return 'unknown';
  }
  const text = textOf(value).trim();
  if (text === '') return 'unknown';
  if (SUCCESS_CODE_TEXT_RE.test(text)) return 'success';
  const upper = text.toUpperCase();
  if (FAILURE_CODES.has(upper) || /_ERROR$|^ERROR$|^FAILED$/.test(upper)) return 'failure';
  return 'unknown';
}

/**
 * 失败短语（§7.1 权威列表）：
 * `TIMEOUT|timed out|CAPTCHA|验证码|RATE_LIMIT|too many requests|AUTH|unauthorized|forbidden|
 * network|ECONN|ENOTFOUND|search_input_not_available`。
 *
 * 注意：**不含裸 `not_available`**——`cover_not_available` / `title_not_available` 是正常的
 * 字段缺失提示，不能触发降级。`AUTH` 用负向先行断言，避免命中 `author`。
 */
const FAILURE_PHRASE_RE = /(TIMEOUT|timed\s+out|CAPTCHA|验证码|RATE[_\s-]?LIMIT|too many requests|AUTH(?![A-Za-z])|unauthorized|forbidden|network|ECONN|ENOTFOUND|search_input_not_available)/i;

function messageOf(json) {
  return firstText(json?.message, json?.reason, json?.hint);
}

/** 顶层 message / reason / hint 的所有非空文案（§7.1 #6 要求三者都看）。 */
function messagesOf(json) {
  return [json?.message, json?.reason, json?.hint]
    .map((value) => textOf(value).trim())
    .filter((value) => value !== '');
}

/**
 * `data` 是否为空结果（§7.1 #6 与 §7.3 的「结果为空」）。
 *
 * 三种形态都算空：
 *   · `data` 缺失 / null；
 *   · `data` 是空数组；
 *   · `data` 是对象，且它的 `items` / `notes` / `list` 中**存在**的列表全是空数组
 *     （`{items:[]}`、`{notes:[]}`、`{list:[]}`；混合时只要有一个非空就不算空）。
 * 最后一条是 S-002 的非阻断残余：xhs 的空结果对象不能被当成「有数据」而漏掉降级。
 */
function hasEmptyData(json) {
  if (!json || typeof json !== 'object') return true;
  const data = json.data;
  if (data === undefined || data === null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data !== 'object') return false;
  const listKeys = ['items', 'notes', 'list'];
  const present = listKeys.filter((key) => Array.isArray(data[key]));
  return present.length > 0 && present.every((key) => data[key].length === 0);
}

/**
 * §7.3 条件 2：`data` 为空 **且** 顶层 `message`/`reason`/`hint` 精确包含
 * `search_input_not_available`。`searchXhs` 专用，绝不碰非空结果。
 */
export function xhsSearchUnavailableByMessage(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  if (!hasEmptyData(json)) return false;
  return messagesOf(json).some((message) => message.toLowerCase().includes('search_input_not_available'));
}

/**
 * `error` 字段是否「有内容」（§7.2）。
 *
 * 空对象/空数组/空串/`0`/`false` → 无内容；`code` 是成功码 → **无内容**（message 再花哨也不算）；
 * 否则 code 命中失败码，或 message 非空且命中失败短语 → 有内容。
 */
function hasErrorContent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return false;
    const kind = codeKind(text);
    if (kind === 'success') return false;
    if (kind === 'failure') return true;
    // 非空错误文本（如 'boom'）本身就是内容；成功码文本已在上面否决。
    return true;
  }
  if (typeof value === 'number') {
    return codeKind(value) === 'failure';
  }
  if (typeof value === 'boolean') return value === true;
  if (Array.isArray(value)) return value.some((entry) => hasErrorContent(entry));
  if (typeof value !== 'object') return false;
  const kind = codeKind(value.code ?? value.error_code);
  if (kind === 'success') return false;
  if (kind === 'failure') return true;
  return messagesOf(value).some((message) => FAILURE_PHRASE_RE.test(message));
}

function failureResult(json, messageMatch) {
  const error = json?.error && typeof json.error === 'object' && !Array.isArray(json.error) ? json.error : {};
  const codeText = firstText(error.code ?? error.error_code, json?.code, json?.status);
  return {
    failed: true,
    code: codeText || messageMatch?.[1]?.toUpperCase() || 'error',
    text: truncateChars(upstreamErrorText(json) || textOf(json?.error) || messageOf(json) || '上游没有给出原因', ERROR_TEXT_MAX).text
  };
}

/**
 * 这段上游 JSON 是不是**失败**（§7.1 决策表，按优先级自上而下）。
 *
 * 原则：只信结构化信号；成功码一旦出现在 `code` 位置，就绝不因为 message 判失败。
 * message/reason/hint 只在 `ok !== true` 或 `data` 为空时参与判断，且必须是失败短语。
 */
export function failureOf(json) {
  // #1 非对象：交给上层按形状处理
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { failed: false };
  const messageMatch = messagesOf(json)
    .map((value) => value.match(FAILURE_PHRASE_RE))
    .find((match) => match !== null) ?? null;

  // #2 ok/success 显式 false
  if (json.ok === false || json.success === false) return failureResult(json, messageMatch);
  // #3 error 是非空字符串：先认成功码文本（'OK'/'0'），其余非空文本一律算错
  const errorValueKind = typeof json.error === 'string' || typeof json.error === 'number'
    ? codeKind(json.error)
    : 'unknown';
  if (typeof json.error === 'string' && json.error.trim() !== '' && errorValueKind !== 'success') {
    return failureResult(json, messageMatch);
  }

  const errorIsObject = json.error && typeof json.error === 'object' && !Array.isArray(json.error);
  const errorKind = errorIsObject ? codeKind(json.error.code ?? json.error.error_code) : 'unknown';
  const topKind = codeKind(json.code);

  // #4 error 对象的结构化信号（成功码已在 hasErrorContent 内部被否决）
  if (hasErrorContent(json.error)) return failureResult(json, messageMatch);
  // #5 顶层 code 失败码
  if (topKind === 'failure') return failureResult(json, messageMatch);
  // status 是结构化信号（T-027 残余要求保留）：≥400 判失败
  const statusRaw = json.status;
  const statusNumber = statusRaw === null || statusRaw === undefined || statusRaw === '' ? Number.NaN : Number(statusRaw);
  if (Number.isFinite(statusNumber) && statusNumber >= 400) return failureResult(json, messageMatch);
  // 成功码 veto：成功码出现在任何 code/error 位置，就绝不因为 message 判失败
  if (errorValueKind === 'success' || errorKind === 'success' || topKind === 'success') return { failed: false };
  // #6 顶层 message 只在 ok !== true 或 data 为空时生效
  if (messageMatch !== null && (json.ok !== true || hasEmptyData(json))) {
    return failureResult(json, messageMatch);
  }
  return { failed: false };
}

// ── 目标（reach_read 的 target）校验 ────────────────────────────────────────
// URL / id 都是单行 token：换行与控制字符会让「一行参数」变成两行。`new URL()` 会静默吞掉
// 换行，但我们把**原始字符串**当 ref 交给 CLI，所以必须在这里就拒掉（实测过 `…\ncalc` 能过）。
const TARGET_CONTROL_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/;
function targetControlError(text) {
  return TARGET_CONTROL_RE.test(text)
    ? 'target 里不能有换行 / 控制字符：把链接或 id 压成一行再传'
    : '';
}

/**
 * B站目标：BV 号，或 bilibili.com / b23.tv 链接。
 * 能从链接里抠出 BV 就抠（`bili video` 要的是 BV），抠不出就把链接原样交给 CLI，
 * 让上游自己解析——**不替它猜 BV 号**。
 */
export function normalizeBiliTarget(value) {
  const text = textOf(value).trim();
  if (text === '') return { ok: false, error: 'target 不能为空：要给 BV 号或 bilibili.com 视频链接' };
  const control = targetControlError(text);
  if (control !== '') return { ok: false, error: control };
  if (BVID_RE.test(text)) return { ok: true, ref: text, bvid: text };
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, error: '链接格式不对，不是合法 URL' };
    }
    const host = url.hostname.toLowerCase();
    if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(host)) {
      return { ok: false, error: `只接受 B站 链接，收到的是 ${host}` };
    }
    const matched = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    return matched ? { ok: true, ref: matched[1], bvid: matched[1] } : { ok: true, ref: text, bvid: '' };
  }
  if (/^b23\.tv\//i.test(text)) return { ok: false, error: 'b23.tv 短链请带上 https:// 前缀，或直接给 BV 号' };
  return { ok: false, error: 'target 要是 BV 号（BV 开头 12 位）或 bilibili.com 视频链接' };
}

/** 小红书目标：note id（字母数字），或 xiaohongshu.com / xhslink.com 链接。 */
export function normalizeXhsTarget(value) {
  const text = textOf(value).trim();
  if (text === '') return { ok: false, error: 'target 不能为空：要给笔记 id 或 xiaohongshu.com 笔记链接' };
  const control = targetControlError(text);
  if (control !== '') return { ok: false, error: control };
  if (/^[0-9A-Za-z]{8,40}$/.test(text)) return { ok: true, ref: text, id: text };
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, error: '链接格式不对，不是合法 URL' };
    }
    const host = url.hostname.toLowerCase();
    if (!['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com'].includes(host)) {
      return { ok: false, error: `只接受小红书链接，收到的是 ${host}` };
    }
    const fromPath = url.pathname.match(/\/(?:explore|discovery\/item|note)\/([0-9A-Za-z]{8,40})/);
    const fromQuery = url.searchParams.get('noteId') ?? url.searchParams.get('note_id') ?? '';
    const id = firstText(fromPath?.[1], fromQuery);
    if (id !== '' && /^[0-9A-Za-z]{8,40}$/.test(id)) {
      // ref 保留**整条 URL**：opencli 的 note 子命令现在要求带 xsec_token 的签名链接，
      // 只给 id 会被它直接拒掉（实测 exit 2 / code=ARGUMENT），把 token 丢掉等于自断其路。
      return { ok: true, ref: text, id };
    }
    return { ok: false, error: '这个链接里没有笔记 id（xhslink 短链请先在浏览器打开，再把完整链接或 note id 给我）' };
  }
  return { ok: false, error: 'target 要是笔记 id（字母数字）或 xiaohongshu.com 笔记链接' };
}

/** 小黑盒目标：纯数字 linkId（来自 reach_search 的结果）。 */
export function normalizeHeyboxTarget(value) {
  const text = textOf(value).trim();
  if (text === '') return { ok: false, error: 'target 不能为空：要给数字 linkId（reach_search 的 heybox 结果里有）' };
  const control = targetControlError(text);
  if (control !== '') return { ok: false, error: control };
  if (/^\d{1,20}$/.test(text)) return { ok: true, ref: text };
  return { ok: false, error: '小黑盒 target 必须是纯数字 linkId（reach_search 结果里 `小黑盒 id：` 那一行的数字）' };
}

/** 按平台分发 target 校验，统一成 `{ ok, ref, bvid?, error? }`。 */
export function normalizeTarget(platform, value) {
  if (platform === 'bili') return normalizeBiliTarget(value);
  if (platform === 'xhs') return normalizeXhsTarget(value);
  if (platform === 'heybox') return normalizeHeyboxTarget(value);
  return { ok: false, error: `不认识的平台：${textOf(platform) || '（空）'}；可选：${PLATFORM_CHOICES}` };
}

// ── 三个平台的搜索结果解析 ──────────────────────────────────────────────────
const SEARCH_KEYS = Object.freeze({
  bili: ['data', 'data.items', 'data.list', 'items'],
  xhs: ['data', 'data.items', 'data.notes', 'items']
});

function valueAt(json, path) {
  if (path === '') return json;
  return path.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), json);
}

function collectItems(json, keys) {
  for (const key of keys) {
    const value = valueAt(json, key);
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * 判断上游这次到底给了**认得出的列表形状**，返回命中的键路径；认不出返回空串。
 *
 * 为什么要单独判一次：`data` 变成对象（`{unexpected_shape:true}`）时 collectItems 会回空数组，
 * 于是搜索「正常」返回 0 条——那是把**上游坏掉**冒充成「平台没有这个话题」。
 * 形状认不出必须报错（unexpected_shape），空数组 `data:[]` 才真的是没结果。
 */
export function searchShape(platform, json) {
  const keys = SEARCH_KEYS[platform] ?? [];
  for (const key of keys) {
    if (Array.isArray(valueAt(json, key))) return key;
  }
  return '';
}

/**
 * B站搜索：真实形状 `{ok, schema_version, data:[{id,bvid,title,author,play,duration}]}`。
 * 顺带容忍 `data.items` / `data.list`（bili-cli 其它命令是这样给的）。
 */
export function parseBiliSearch(json, limit = LIMIT_DEFAULT) {
  const list = collectItems(json, SEARCH_KEYS.bili);
  return list.slice(0, clampLimit(limit)).map((item) => {
    const bvid = firstText(item?.bvid, item?.id);
    return {
      platform: 'bili',
      id: bvid,
      title: squash(item?.title),
      author: squash(firstText(item?.author, item?.owner?.name), 60),
      play: intOrNull(item?.play ?? item?.stats?.view),
      duration: textOf(item?.duration),
      url: BVID_RE.test(bvid) ? `https://www.bilibili.com/video/${bvid}` : textOf(item?.url)
    };
  });
}

/**
 * 小红书搜索：实测两种形状——
 *   ① `{data:[{note_id,title,desc,liked_count,nickname}]}`（API 直出）
 *   ② `{data:[{id,title,author,likes,url}]}`（opencli 自己的 feed/搜索列表，字段是压平的中文写法）
 *   ③ `{data:{items:[{note_card:{...}, user:{...}}]}}`（页面内嵌结构）
 * 字段缺失一律不抛（上游改名是常态），拿不到就留空，话术里显示“无数据”。
 */
export function parseXhsSearch(json, limit = LIMIT_DEFAULT) {
  const list = collectItems(json, SEARCH_KEYS.xhs);
  return list.slice(0, clampLimit(limit)).map((entry) => {
    const card = entry?.note_card ?? entry?.noteCard ?? entry ?? {};
    const user = card?.user ?? entry?.user ?? {};
    const id = firstText(card?.note_id, card?.noteId, card?.id, entry?.note_id, entry?.id);
    return {
      platform: 'xhs',
      id,
      // 小红书常常只有正文没有标题：那就把正文开头当标题（截短），不编造一个标题出来。
      title: squash(firstText(card?.title, card?.display_title, card?.desc, entry?.title), 80),
      author: squash(firstText(user?.nickname, user?.name, card?.nickname, entry?.author, entry?.nickname), 60),
      liked: intOrNull(card?.liked_count ?? card?.likedCount ?? entry?.liked_count ?? entry?.likes),
      url: id !== '' ? `https://www.xiaohongshu.com/explore/${id}` : textOf(card?.share_url ?? entry?.url)
    };
  });
}

/**
 * 小红书网页层抓取结果的整形（T-029）。
 *
 * 输入是页面里跑完常量脚本拿到的 JSON（**可能是一层编码过的字符串**——opencli 的
 * `eval` 把返回值又 JSON 编码了一次，实测 `data` 是 `"{\"title\":…}"`），形状：
 *   `{title, url, total, cards:[{href, id, lines:[…]}], loginWall, bodyHead}`
 *
 * 卡片的 `innerText` 行序实测是 `[标题, 作者, MM-DD, 点赞数]`；但**有些卡片没有标题**
 * （只有 3 行：`[作者, MM-DD, 点赞数]`）。所以不能按固定下标取，必须先找到日期行
 * （`MM-DD`）来切分「标题/作者」，否则会把作者名当成标题发出去。
 *
 * 返回 `{ ok, title, url, wall, total, items, bodyHead }`：
 * - `ok:false` = 形状认不出（上游改版/拿到的不是页面报告）→ 调用方报 page_changed；
 * - `wall:true` = 页面明确要求先登录（正文出现「登录后查看」）→ 调用方报 login_required；
 * - `items` 只留 `/explore/` 链接的真实笔记（推荐词块没有这个链接，必须剔掉）。
 */
export function parseXhsBrowserCards(raw, limit = LIMIT_MAX) {
  let page = raw;
  if (typeof page === 'string') {
    try {
      page = JSON.parse(page);
    } catch {
      return { ok: false, title: '', url: '', wall: false, total: 0, items: [], bodyHead: '', reason: 'not_json' };
    }
  }
  if (!page || typeof page !== 'object') {
    return { ok: false, title: '', url: '', wall: false, total: 0, items: [], bodyHead: '', reason: 'no_cards_field' };
  }
  // 登录墙先判：它比卡片形状更可靠（撞墙时页面根本没有卡片），
  // 所以即使 cards 字段缺失/损坏，也要把 wall 报给上层，别降级成「结构变了」。
  const bodyHead = squash(page.bodyHead, 200);
  const wall = page.loginWall === true || bodyHead.includes('登录后查看') || bodyHead.includes('扫码登录');
  if (!Array.isArray(page.cards)) {
    return {
      ok: false,
      title: squash(page.title, 120),
      url: truncateUrl(textOf(page.url)),
      wall,
      total: 0,
      items: [],
      bodyHead,
      reason: 'no_cards_field'
    };
  }
  const seen = new Set();
  const items = [];
  for (const card of page.cards) {
    const href = textOf(card?.href);
    const id = firstText(card?.id, (href.match(/\/explore\/([0-9A-Za-z]+)/) ?? [])[1]);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const lines = (Array.isArray(card?.lines) ? card.lines : []).map((line) => squash(line, 120)).filter((line) => line !== '');
    const cut = splitXhsCardLines(lines);
    items.push({
      platform: 'xhs',
      id,
      title: cut.title,
      author: cut.author,
      liked: parseLikedCount(cut.liked),
      url: `https://www.xiaohongshu.com/explore/${id}`
    });
    if (items.length >= clampLimit(limit, LIMIT_MAX)) break;
  }
  return {
    ok: true,
    title: squash(page.title, 120),
    url: truncateUrl(textOf(page.url)),
    wall,
    total: Number.isFinite(Number(page.total)) ? Number(page.total) : items.length,
    items,
    bodyHead
  };
}

/** 把卡片行切成「标题 / 作者 / 点赞数」：日期行 `MM-DD` 是唯一稳定的分界。 */
function splitXhsCardLines(lines) {
  const dateAt = lines.findIndex((line) => /^\d{1,2}-\d{1,2}$/.test(line));
  const head = dateAt === -1 ? lines : lines.slice(0, dateAt);
  const title = head.length >= 2 ? head[0] : '';
  const author = head.length >= 2 ? head[1] : (head[0] ?? '');
  const tail = dateAt === -1 ? lines.slice(head.length) : lines.slice(dateAt + 1);
  const likes = tail.find((line) => /^[\d.]+[万wW]?\+?$/.test(line)) ?? '';
  return { title, author, liked: likes };
}

/**
 * 页面上的点赞数是「222」/「1.2万」这种人读的写法，话术里的 `赞 N` 要的是数字。
 * 认不出（或卡片上根本没给）就返回 `null`——宁可「无数据」，也不编一个数。
 */
function parseLikedCount(text) {
  const raw = textOf(text).trim();
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([万wW亿])?\+?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  if (match[2] === '亿') return Math.round(n * 1e8);
  if (match[2]) return Math.round(n * 1e4);
  return Math.round(n);
}

/**
 * 小黑盒「话题 / 游戏」搜索的整形（T-029，帖子搜索被验证码拦了时的兜底）。
 *
 * 输入是 `xiaoheihe-cli -f json search <词> --type topic|game` 的原始 JSON：
 *   topic → `{data:{result:{topics:[{name,topic_id,show_desc,hot:{raw_hot_value}}]}}}`
 *   game  → `{data:{result:{games:[{name,appid,score,follow_num,release_date_desc}]}}}`
 * 这两个端点实测不触发验证码，但**不是帖子**：只有话题/游戏条目，没有 linkId，
 * 所以不编 id、不编 URL（`reach_read` 读的是帖子，这里给不了）。
 * 形状认不出返回 `null`，由调用方如实报错，绝不冒充「没有结果」。
 */
export function parseHeyboxTypeSearch(json, { type = 'topic', limit = LIMIT_DEFAULT } = {}) {
  const result = json?.data?.result ?? json?.result ?? null;
  if (!result || typeof result !== 'object') return null;
  const list = type === 'game' ? result.games : result.topics;
  if (!Array.isArray(list)) return null;
  const items = [];
  for (const entry of list.slice(0, clampLimit(limit))) {
    const name = squash(entry?.name, 80);
    if (name === '') continue;
    if (type === 'game') {
      const parts = [];
      const score = squash(entry?.score, 12);
      if (score !== '') parts.push(`评分 ${score}`);
      const followers = intOrNull(entry?.follow_num);
      if (Number.isFinite(followers)) parts.push(`关注 ${countText(followers)}`);
      const released = squash(entry?.release_date_desc, 20);
      if (released !== '') parts.push(released);
      items.push({ platform: 'heybox', kind: 'game', id: '', title: name, author: parts.join(' · '), url: '' });
    } else {
      const hot = squash(entry?.show_desc, 24) || (Number.isFinite(intOrNull(entry?.hot?.raw_hot_value))
        ? `热度 ${countText(intOrNull(entry.hot.raw_hot_value))}`
        : '');
      items.push({ platform: 'heybox', kind: 'topic', id: '', title: name, author: hot, url: '' });
    }
  }
  return items;
}

/**
 * 小黑盒搜索的整形：输入是 reach-tools 里 `createHeyboxTools().search()` 的**已瘦身结果**
 * （`{ok, query, count, items:[{linkId,title,summary,author,commentCount}]}`），
 * 不再碰原始 JSON——代理变量、验证码暂停那些坑都在 heybox-tools 里处理过了。
 */
export function parseHeyboxSearch(result, limit = LIMIT_DEFAULT) {
  const list = Array.isArray(result?.items) ? result.items : [];
  return list.slice(0, clampLimit(limit)).map((item) => ({
    platform: 'heybox',
    id: textOf(item?.linkId),
    title: squash(item?.title),
    author: squash(item?.author, 60),
    replies: intOrNull(item?.commentCount),
    summary: squash(item?.summary, 80),
    // 小黑盒的帖子没有稳定可分享的站内地址（share_url 是带签名的接口地址），
    // 所以这里不编 URL：话术里给 id，读正文用 reach_read。
    url: ''
  }));
}

/**
 * 这个「笔记对象」里有没有任何能证明它确实是笔记的**实际内容**。
 *
 * 只用于区分「合法但只有图片/没有正文的笔记」与「上游返回了完全认不出的结构」：
 * 前者应当 `ok:true` + 「没有正文可取」，后者才是 unexpected_shape。
 * 所以不能只看「有没有 user / interact_info 这类空壳对象」——S-004 的反例里
 * `data:{note:{}}` 就是空壳；必须至少有一个真实字段值、非空图片数组或 note_id。
 */
function looksLikeNote(note) {
  if (!note || typeof note !== 'object') return false;
  const hasValue = (value) => textOf(value).trim() !== '';
  if (hasValue(note.note_id) || hasValue(note.noteId) || hasValue(note.id)) return true;
  if (hasValue(note.title) || hasValue(note.display_title)) return true;
  if (hasValue(note.desc) || hasValue(note.content) || hasValue(note.text)) return true;
  if (hasValue(note.share_url)) return true;
  return ['image_list', 'images', 'imageList'].some((key) => Array.isArray(note[key]) && note[key].length > 0);
}

/** 字段对数组形状的同一套收紧：只有真实字段值 / 非空图片数组才算认得出。 */
function fieldPairsLooksLikeNote(pairs) {
  const textFields = ['note_id', 'noteId', 'id', 'title', 'display_title', 'desc', 'content', 'text', 'share_url'];
  if (textFields.some((key) => textOf(pairs?.[key]).trim() !== '')) return true;
  return ['image_list', 'images', 'imageList'].some((key) => Array.isArray(pairs?.[key]) && pairs[key].length > 0);
}

/**
 * 小红书单篇：真实样本（opencli 2.0.0 实测）是**字段对数组**——
 *   `{ok:true, data:[{field:'title',value:'…'},{field:'author',value:'…'},
 *                   {field:'content',value:'…'},{field:'likes',value:'16'},
 *                   {field:'collects',value:'2'},{field:'comments',value:'52'},
 *                   {field:'tags',value:'#…'}]}`
 * 另有页面内嵌结构 `{data:{note:{…}}}`。两种都认；一个都认不出就**不编**，
 * 把原始 JSON 片段放进 `raw` 交给调用方如实展示（research.md §四就是这么定的）。
 *
 * `recognized` 是给 requireReadable 用的：认得出形状但没正文（图片笔记）≠ 上游坏了。
 * 前者应该正常返回，话术里说「没有正文可取」；后者才报 unexpected_shape。
 */
export function parseXhsNote(json) {
  const data = json?.data ?? json ?? {};
  const pairs = fieldPairsOf(data);
  if (pairs) {
    const noteId = firstText(pairs.note_id, pairs.noteId, pairs.id);
    const recognized = fieldPairsLooksLikeNote(pairs);
    const item = {
      platform: 'xhs',
      target: noteId,
      recognized,
      title: squash(firstText(pairs.title, pairs.display_title), 120),
      author: squash(firstText(pairs.author, pairs.nickname), 60),
      liked: intOrNull(pairs.likes ?? pairs.liked_count),
      collected: intOrNull(pairs.collects ?? pairs.collected_count),
      replies: intOrNull(pairs.comments ?? pairs.comment_count),
      tags: textOf(pairs.tags),
      url: noteId !== '' ? `https://www.xiaohongshu.com/explore/${noteId}` : '',
      text: textOf(firstText(pairs.content, pairs.desc, pairs.text))
    };
    if (!recognized) item.raw = truncateChars(JSON.stringify(json ?? null), 800).text;
    return item;
  }

  const note = data?.note ?? data?.note_card ?? data?.noteCard ?? (Array.isArray(data?.items) ? data.items[0]?.note_card ?? data.items[0] : null) ?? data;
  const user = note?.user ?? data?.user ?? {};
  const interact = note?.interact_info ?? note?.interactInfo ?? data?.interact_info ?? {};
  const id = firstText(note?.note_id, note?.noteId, note?.id, data?.note_id);
  const recognized = looksLikeNote(note);
  const item = {
    platform: 'xhs',
    target: id,
    recognized,
    title: squash(firstText(note?.title, note?.display_title), 120),
    author: squash(firstText(user?.nickname, user?.name, note?.nickname), 60),
    liked: intOrNull(interact?.liked_count ?? interact?.likedCount ?? note?.liked_count),
    collected: intOrNull(interact?.collected_count ?? interact?.collectedCount ?? note?.collected_count),
    replies: intOrNull(interact?.comment_count ?? note?.comment_count),
    url: id !== '' ? `https://www.xiaohongshu.com/explore/${id}` : textOf(note?.share_url),
    text: textOf(firstText(note?.desc, note?.content, note?.text, data?.desc, data?.content))
  };
  if (!recognized) {
    // 认不出内容时**不编**：给一段原始 JSON 摘要，模型能看见“后端到底给了什么”，
    // 也能如实告诉群友“这个读不出来”。
    item.raw = truncateChars(JSON.stringify(json ?? null), 800).text;
  }
  return item;
}

/** 把 `[{field, value}]` 这种字段对数组摊成普通对象；不是这个形状返回 null。 */
function fieldPairsOf(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const pairs = {};
  let matched = 0;
  for (const entry of data) {
    const field = textOf(entry?.field).trim();
    if (field === '') continue;
    pairs[field] = entry?.value;
    matched += 1;
  }
  return matched > 0 ? pairs : null;
}

/**
 * 小红书 AI 问答（`opencli xiaohongshu ask <query> -f json`）的解析。
 *
 * 真实形状（2026-10-23 实测）：
 *   `{ok:true,data:{query,answer,source_count,source_total_text,
 *                   sources:[{rank,type,title,url,note_id,author,…}]}}`
 * 只取 answer 与来源标题/作者/链接；`deeplink`、`quote`、xsec_token 这些一律不碰。
 * 来源缺 url 但有 note_id 时用 note_id 拼公开链接（与 parseXhsSearch 同口径）。
 */
export function parseXhsAsk(json) {
  const data = json?.data && typeof json.data === 'object' && !Array.isArray(json.data)
    ? json.data
    : (json && typeof json === 'object' && !Array.isArray(json) ? json : {});
  const answer = textOf(firstText(data.answer, data.content, data.text, data.result?.answer));
  const rawSources = Array.isArray(data.sources)
    ? data.sources
    : (Array.isArray(data.source) ? data.source : (Array.isArray(data.result?.sources) ? data.result.sources : []));
  const sources = rawSources.slice(0, ASK_SOURCES_MAX).map((entry, index) => {
    const noteId = firstText(entry?.note_id, entry?.noteId, entry?.id);
    const url = firstText(
      entry?.url,
      entry?.link,
      noteId !== '' ? `https://www.xiaohongshu.com/explore/${noteId}` : ''
    );
    return {
      rank: index + 1,
      title: squash(entry?.title ?? entry?.name, 80),
      author: squash(entry?.author ?? entry?.nickname, 60),
      url: truncateUrl(url)
    };
  }).filter((entry) => entry.title !== '' || entry.url !== '');
  const countRaw = Number(data.source_count ?? data.sourceCount);
  return {
    answer,
    sources,
    sourceCount: Number.isFinite(countRaw) && countRaw >= 0 ? Math.trunc(countRaw) : rawSources.length,
    sourceTotalText: squash(data.source_total_text ?? data.sourceTotalText, 80)
  };
}

/** 小黑盒单篇：输入是 `createHeyboxTools().post()` 的瘦身结果，正文/作者/评论数都在。 */
export function parseHeyboxPost(result) {
  return {
    platform: 'heybox',
    target: textOf(result?.linkId),
    title: squash(result?.title),
    author: squash(result?.author, 60),
    createAt: textOf(result?.createAt),
    replies: intOrNull(result?.commentCount),
    url: '',
    text: textOf(result?.text)
  };
}

/** B站单篇：`bili video <BV> --json` 的 `data.video`（不带 -s/-c，只取标题/作者/数字/简介）。 */
export function parseBiliVideo(json) {
  const video = json?.data?.video ?? json?.data ?? {};
  const stats = video?.stats ?? {};
  const bvid = firstText(video?.bvid, video?.id);
  return {
    platform: 'bili',
    target: bvid,
    title: squash(video?.title),
    author: squash(firstText(video?.owner?.name, video?.author), 60),
    duration: textOf(video?.duration),
    play: intOrNull(stats?.view),
    liked: intOrNull(stats?.like),
    coin: intOrNull(stats?.coin),
    favorite: intOrNull(stats?.favorite),
    url: firstText(video?.url, BVID_RE.test(bvid) ? `https://www.bilibili.com/video/${bvid}` : ''),
    text: textOf(video?.description)
  };
}

// ── 话术 ────────────────────────────────────────────────────────────────────
function countText(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= 100000000) return `${Math.round((value / 100000000) * 10) / 10}亿`;
  if (value >= 10000) return `${Math.round((value / 10000) * 10) / 10}万`;
  return String(Math.trunc(value));
}

/** 一条结果的「关键数字」：只列这个平台真的给了的项。 */
function metricText(item) {
  const parts = [];
  if (Number.isFinite(item?.play)) parts.push(`播放 ${countText(item.play)}`);
  if (Number.isFinite(item?.liked)) parts.push(`赞 ${countText(item.liked)}`);
  if (Number.isFinite(item?.collected)) parts.push(`收藏 ${countText(item.collected)}`);
  if (Number.isFinite(item?.replies)) parts.push(`评论 ${countText(item.replies)}`);
  if (item?.duration) parts.push(`时长 ${item.duration}`);
  return parts.length > 0 ? parts.join(' · ') : '无数据';
}

function platformLabelOf(platform) {
  return PLATFORM_LABELS[platform] ?? (textOf(platform) || '未知平台');
}

/**
 * 搜索结果话术（模型直接读的纯文本）。
 *
 * 形状固定为：`平台 搜索「词」共 N 条` + 每条「序号. 标题 — 作者（数字 · 时长）」+ 下一行定位信息。
 * 空结果也必须说人话——「没搜到」和「搜索失败」是两件事，后者由 reach-tools 用
 * `code:'unavailable'` 报，绝不在这里伪装成空列表。
 */
export function formatSearchResult({ platform, query, items } = {}) {
  const label = platformLabelOf(platform);
  const word = textOf(query);
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return `${label} 搜索「${word}」没有结果\n（平台这次没返回内容：换个更短的关键词，或过一会儿再试；别当成“这个平台没有这个话题”。）`;
  }
  const lines = [`${label} 搜索「${word}」共 ${list.length} 条`];
  list.forEach((item, index) => {
    const title = textOf(item?.title) || '（没有标题）';
    const author = textOf(item?.author) || '未知作者';
    lines.push(`${index + 1}. ${title} — ${author}（${metricText(item)}）`);
    if (textOf(item?.url) !== '') {
      // 链接也要限长：畸形 URL（几千字的 query）能把一次搜索结果撑到上万字。
      lines.push(`   ${truncateUrl(item.url)}`);
    } else if (textOf(item?.id) !== '') {
      lines.push(`   ${label} id：${item.id}（看正文用 reach_read）`);
    }
  });
  return lines.join('\n');
}

/**
 * 小红书网页抓取降级话术（T-029）。
 *
 * 首行是固定的 `XHS_BROWSER_PREFIX`，然后是页面地址，再套一层普通搜索列表的形状
 * （这样模型读到的仍然是「共 N 条 + 标题 + 链接」，和有站内搜索时一致）。
 */
export function formatBrowserResult({ query, items, pageUrl } = {}) {
  const list = Array.isArray(items) ? items : [];
  const lines = [XHS_BROWSER_PREFIX];
  const url = truncateUrl(textOf(pageUrl));
  if (url !== '') lines.push(`（页面：${url}）`);
  lines.push('', formatSearchResult({ platform: 'xhs', query, items: list }));
  return lines.join('\n');
}

/**
 * 小黑盒话题/游戏降级话术（T-029）。
 *
 * 首行是固定的 `HEYBOX_TYPE_PREFIX`；每条前面标出是【话题】还是【游戏】——
 * 因为这两种条目点不开成帖子，不能让模型以为拿到了帖子列表。
 */
export function formatHeyboxTypeResult({ query, items } = {}) {
  const list = Array.isArray(items) ? items : [];
  const word = textOf(query);
  const lines = [HEYBOX_TYPE_PREFIX, ''];
  if (list.length === 0) {
    lines.push(`小黑盒 话题/游戏 搜索「${word}」没有结果`);
  } else {
    lines.push(`小黑盒 话题/游戏 搜索「${word}」共 ${list.length} 条`);
    list.forEach((item, index) => {
      const kind = item?.kind === 'game' ? '游戏' : '话题';
      const title = textOf(item?.title) || '（没有标题）';
      const extra = textOf(item?.author).trim();
      lines.push(`${index + 1}. 【${kind}】${title}${extra !== '' ? ` — ${extra}` : ''}`);
    });
  }
  lines.push('（这两个端点不触发验证码，但只给话题/游戏条目、没有帖子链接；要帖子正文得等验证码暂停结束。）');
  return lines.join('\n');
}

/**
 * 小红书 AI 问答降级话术（T-028）。
 *
 * 形状固定：第一行是 `XHS_ASK_PREFIX`，之后是 answer（≤4000 字，超长标注），
 * 最后是来源（≤5 条，每条 URL ≤300 字）。**它不是笔记列表**，所以不套
 * formatSearchResult 的「共 N 条」；`count:0` 由调用方负责。
 */
export function formatXhsAsk({ answer, sources, sourceCount, sourceTotalText } = {}) {
  const body = truncateChars(answer, READ_MAX_CHARS);
  const lines = [XHS_ASK_PREFIX];
  if (body.text.trim() !== '') {
    lines.push('', body.text);
    if (body.truncated) lines.push(`…（AI 回答已截断，原文共 ${body.total} 字）`);
  } else {
    lines.push('', '（AI 问答没有返回可读的正文）');
  }
  const list = (Array.isArray(sources) ? sources : []).slice(0, ASK_SOURCES_MAX);
  const totalText = textOf(sourceTotalText);
  if (list.length > 0) {
    lines.push('', `参考来源（这是 AI 汇总，点开链接才是原笔记${totalText !== '' ? `；${totalText}` : ''}）：`);
    list.forEach((entry, index) => {
      const title = textOf(entry?.title) || '（没有标题）';
      const author = textOf(entry?.author) !== '' ? ` — ${textOf(entry.author)}` : '';
      lines.push(`${index + 1}. ${title}${author}`);
      const url = textOf(entry?.url);
      if (url !== '') lines.push(`   ${truncateUrl(url)}`);
    });
  } else if (Number.isFinite(sourceCount) && sourceCount > 0) {
    lines.push('', `（AI 汇总参考了 ${sourceCount} 篇笔记，但这次没给出来源链接）`);
  }
  return lines.join('\n');
}

/** 详情话术：标题 / 作者 + 关键数字 / 定位信息 / 正文（≤4000 字，截断标注）。 */
export function formatReadResult({ platform, item } = {}) {
  const label = platformLabelOf(platform);
  const kind = platform === 'bili' ? '视频' : (platform === 'xhs' ? '笔记' : '帖子');
  const target = item ?? {};
  const meta = [`作者 ${textOf(target.author) || '未知'}`];
  if (textOf(target.createAt) !== '') meta.push(`发表于 ${target.createAt}`);
  const metrics = metricText({ ...target, duration: '' });
  if (metrics !== '无数据') meta.push(metrics);
  if (textOf(target.duration) !== '') meta.push(`时长 ${target.duration}`);

  const lines = [`${label} ${kind}：${textOf(target.title) || '（没有标题）'}`, meta.join(' · ')];
  const locatorRaw = textOf(target.url)
    ? truncateUrl(target.url)
    : (textOf(target.target) !== '' ? `${label} id：${target.target}` : '');
  if (locatorRaw !== '') lines.push(locatorRaw);

  const body = truncateChars(target.text, READ_MAX_CHARS);
  lines.push('');
  if (body.text.trim() !== '') {
    lines.push(body.text);
    if (body.truncated) lines.push(`…（正文已截断，原文共 ${body.total} 字）`);
  } else if (textOf(target.raw) !== '') {
    lines.push('（上游返回里没有可识别的标题/正文，下面是原始 JSON 片段）');
    lines.push(target.raw);
  } else {
    lines.push('（这条没有正文可取：可能只有图片/视频，或者平台没给文字内容）');
  }
  return lines.join('\n');
}
