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
 * 已知的「失败码」：上游把错误放在 `code` 里而**不带** `ok:false` 时靠它兜住。
 * 取自三个 CLI 的真实输出（opencli 的 TIMEOUT / COMMAND_EXEC / ARGUMENT 等）。
 */
export const FAILURE_CODES = Object.freeze(new Set([
  'TIMEOUT', 'COMMAND_EXEC', 'ARGUMENT', 'AUTH', 'AUTH_REQUIRED', 'CAPTCHA',
  'RATE_LIMIT', 'NETWORK', 'PROTOCOL', 'PARSE', 'INTERNAL', 'UNKNOWN', 'ERROR', 'FAILED'
]));

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

/** 配置段归一（config.json 的 `reach`）。缺省 = 出厂默认，`enabled` 只在显式 false 时关。 */
export function normalizeReachConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled !== false,
    timeoutMs: clampInt(source.timeoutMs, 120000, 5000, 300000),
    maxResults: clampLimit(source.maxResults, LIMIT_DEFAULT),
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
  const code = firstText(error.code, json.code);
  const message = firstText(error.message, json.message, json.reason, json.hint);
  if (code !== '') parts.push(code);
  if (message !== '') parts.push(message);
  const exitCode = error.exitCode ?? error.exit_code;
  if (exitCode !== undefined && exitCode !== null && exitCode !== '') parts.push(`exitCode ${exitCode}`);
  // 截断是为了守住「一个报错不能把上下文撑爆」：上游的错误 message 里可能整段回显请求体。
  return truncateChars(parts.join('：'), ERROR_TEXT_MAX).text;
}

/**
 * 这段上游 JSON 是不是**失败**。
 *
 * 踩过的坑：opencli 超时返回 `{"error":{"code":"TIMEOUT",…}}`（**没有** `ok:false`），
 * 只判 `ok === false` 会让它一路走到「解析出 0 条」→ 模型看到「没有结果」。
 * 失败与「搜不到」是两件事，这里必须宁可多报失败。
 */
export function failureOf(json) {
  if (!json || typeof json !== 'object') return { failed: false };
  const errorValue = json.error;
  const hasErrorObject = errorValue && typeof errorValue === 'object';
  const hasErrorString = typeof errorValue === 'string' && errorValue.trim() !== '';
  const code = firstText(hasErrorObject ? errorValue.code : '', json.code, json.status);
  const byCode = code !== '' && (FAILURE_CODES.has(code.toUpperCase()) || /_ERROR$|^ERROR$|^FAILED$/i.test(code));
  if (json.ok === false || json.success === false || hasErrorObject || hasErrorString || byCode) {
    return {
      failed: true,
      code: code || 'error',
      text: truncateChars(upstreamErrorText(json) || textOf(errorValue) || '上游没有给出原因', ERROR_TEXT_MAX).text
    };
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
 * 小红书单篇：真实样本（opencli 2.0.0 实测）是**字段对数组**——
 *   `{ok:true, data:[{field:'title',value:'…'},{field:'author',value:'…'},
 *                   {field:'content',value:'…'},{field:'likes',value:'16'},
 *                   {field:'collects',value:'2'},{field:'comments',value:'52'},
 *                   {field:'tags',value:'#…'}]}`
 * 另有页面内嵌结构 `{data:{note:{…}}}`。两种都认；一个都认不出就**不编**，
 * 把原始 JSON 片段放进 `raw` 交给调用方如实展示（research.md §四就是这么定的）。
 */
export function parseXhsNote(json) {
  const data = json?.data ?? json ?? {};
  const pairs = fieldPairsOf(data);
  if (pairs) {
    const noteId = firstText(pairs.note_id, pairs.noteId, pairs.id);
    return {
      platform: 'xhs',
      target: noteId,
      title: squash(firstText(pairs.title, pairs.display_title), 120),
      author: squash(firstText(pairs.author, pairs.nickname), 60),
      liked: intOrNull(pairs.likes ?? pairs.liked_count),
      collected: intOrNull(pairs.collects ?? pairs.collected_count),
      replies: intOrNull(pairs.comments ?? pairs.comment_count),
      tags: textOf(pairs.tags),
      url: noteId !== '' ? `https://www.xiaohongshu.com/explore/${noteId}` : '',
      text: textOf(firstText(pairs.content, pairs.desc, pairs.text))
    };
  }

  const note = data?.note ?? data?.note_card ?? data?.noteCard ?? (Array.isArray(data?.items) ? data.items[0]?.note_card ?? data.items[0] : null) ?? data;
  const user = note?.user ?? data?.user ?? {};
  const interact = note?.interact_info ?? note?.interactInfo ?? data?.interact_info ?? {};
  const id = firstText(note?.note_id, note?.noteId, note?.id, data?.note_id);
  const item = {
    platform: 'xhs',
    target: id,
    title: squash(firstText(note?.title, note?.display_title), 120),
    author: squash(firstText(user?.nickname, user?.name, note?.nickname), 60),
    liked: intOrNull(interact?.liked_count ?? interact?.likedCount ?? note?.liked_count),
    collected: intOrNull(interact?.collected_count ?? interact?.collectedCount ?? note?.collected_count),
    replies: intOrNull(interact?.comment_count ?? note?.comment_count),
    url: id !== '' ? `https://www.xiaohongshu.com/explore/${id}` : textOf(note?.share_url),
    text: textOf(firstText(note?.desc, note?.content, note?.text, data?.desc, data?.content))
  };
  if (item.title === '' && item.text === '') {
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
      lines.push(`   ${truncateChars(item.url, URL_MAX).text}`);
    } else if (textOf(item?.id) !== '') {
      lines.push(`   ${label} id：${item.id}（看正文用 reach_read）`);
    }
  });
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
    ? truncateChars(target.url, URL_MAX).text
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
