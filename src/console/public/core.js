/* 控制台共享底座：令牌、格式化、请求、错误码文案、事件委派注册表、通用 HTML 片段。
 *
 * 这些是经典脚本里的顶层绑定（不是 module）：index.html 里 <script> 的先后顺序就是依赖顺序，
 * core.js 必须排在所有页面脚本与 app.js 之前，否则页面脚本读不到 esc()/api() 这些函数。
 *
 * CSP 约束（见 server.js 的 Content-Security-Policy）：页面里不许有内联 <script>、内联 on* 事件、
 * 内联 style= 与 style.cssText。所有交互走 data-act 属性 + 这里登记的动作表，再由 app.js 的
 * 单一监听器分发；所有样式走 console.css 的类名，尺寸类由 CSSOM（style.width/height）设置，
 * 那是 CSSOM 赋值而不是内联 style 属性，CSP 不拦。
 */

const TOKEN_STORAGE_KEY = 'autochat.console.token';

// 地址栏里的 ?token= 会留在历史记录、截图和聊天记录里：存下之后立刻从地址栏抹掉。
try {
  const given = new URLSearchParams(location.search || '').get('token');
  if (given) {
    localStorage.setItem(TOKEN_STORAGE_KEY, given);
    history.replaceState(null, '', location.pathname || '/');
  }
} catch {
  // 隐私模式可能禁用 localStorage：当作没有令牌，app.js 会提示怎么给令牌。
}

const token = (() => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
})();

const $ = selector => document.querySelector(selector);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ESCAPES[ch]);

// 缺口统一用这个字符占位：拿不到的数据就显示它，绝不编一个看起来像真的数字。
const DASH = '—';

const num = value => Number(value || 0).toLocaleString('zh-CN');
const cny = (micro, digits = 4) => '¥' + (Number(micro || 0) / 1e6).toFixed(digits);
const time = value => (value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : DASH);
const dur = ms => {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分`;
  return `${minutes}分${total % 60}秒`;
};

const api = async path => {
  const response = await fetch(path, token ? { headers: { 'x-console-token': token } } : undefined);
  if (response.status === 401) throw new Error('未授权：请用带 ?token= 的地址打开控制台');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
};

const post = async (path, body) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status);
  return data;
};

// 后端只回错误码，不回报文：翻译成人话是控制台的责任，不许把 SOCIAL_PARAM_INVALID 直接甩给用户。
const CODE_TEXT = {
  bad_json: '请求体不是合法 JSON',
  BODY_TOO_LARGE: '请求体太大，超过这个接口的上限',
  unauthorized: '令牌不对或没带令牌',
  header_token_required: '这个动作只接受请求头里的令牌，不能放在网址参数里',
  origin_rejected: '只接受从本机控制台页面发起的写入',
  not_found: '没有这个接口',
  CONFIG_PARAM_INVALID: '这个参数名或参数值不被接受',
  CONFIG_READ_ONLY: '这一项是只读的，控制台改不了',
  // N-01：群白名单是运行时字段（runtime-config 的 groupIds），改它不用重启、更不用改
  // .env，所以提示指向控制台的设置页，而不是让用户去动启动期配置。
  GROUP_NOT_FOUND: '这个群还没登记：在「系统设置」页把群号加进「群白名单」（保存后立即生效），再让机器人在群里跑一次',
  GROUP_PARAM_INVALID: '群参数不合法',
  GROUP_UNAVAILABLE: '群管理功能不可用',
  PERSONA_CONTENT_EMPTY: '人格内容不能为空',
  PERSONA_CONTENT_INVALID: '人格内容不合法',
  PERSONA_CONTENT_TOO_LARGE: '人格内容超过单卡上限',
  PERSONA_LIMIT: '人格卡数量到上限了，先删一张',
  PERSONA_NAME_INVALID: '人格卡名字不合法',
  PERSONA_NOT_FOUND: '找不到这张人格卡',
  PERSONA_UNAVAILABLE: '人格功能不可用',
  SOCIAL_PARAM_INVALID: '仿真参数不合法',
  SOCIAL_PARAM_NOT_GROUP_SCOPED: '这个参数不能按群单独设置，只能改全局',
  SOCIAL_UNAVAILABLE: '仿真功能不可用',
  SLANG_PARAM_INVALID: '黑话参数不合法',
  SLANG_NOT_FOUND: '找不到这条黑话',
  SLANG_UNAVAILABLE: '黑话功能不可用',
  SLANG_TERM_INVALID: '词条不合法',
  SLANG_DISABLED: '黑话功能没开',
  SLANG_IMPORT_INVALID: '导入的文件不是这个控制台导出的格式',
  SLANG_LOOKUP_EMPTY: '没查到这个词的释义',
  SLANG_LOOKUP_UNVERIFIED: '查到了，但可信度不够，不能自动入库',
  SLANG_SEARCH_DISABLED: '联网检索没开',
  SLANG_SEARCH_LIMIT: '今天的检索次数用完了',
  SLANG_MODEL_FAILED: '模型这次没给出可解析的回复',
  SLANG_EXTRACT_UNPARSABLE: '模型的回复解析不了',
  SLANG_BUDGET_BLOCKED: '预算不够，这次没有调用模型',
  STICKER_ID_INVALID: '表情包编号不合法',
  STICKER_NOT_FOUND: '找不到这张表情包',
  STICKER_PARAM_INVALID: '表情包参数不合法',
  STICKER_UNAVAILABLE: '表情包功能不可用',
  STICKER_UPLOAD_INVALID: '上传内容不是可用的图片',
};

const explain = code => CODE_TEXT[String(code)] || String(code);

// 后端抛的错误只有两种形态：HTTP 状态（"HTTP 500"）和业务码（"SLANG_LOOKUP_EMPTY"）。
const reason = error => {
  const raw = String((error && error.message) || error || '');
  return CODE_TEXT[raw.replace(/^HTTP \d+\s*/, '')] || raw || DASH;
};

/* --- 为什么停了（D-19 / E-10）---------------------------------------------
 * `/停止` 与「连续发送失败自动熔断」翻的是同一个开关，但对运维的意思正好相反：
 * 前者是人按了按钮，后者通常意味着 OneBot 掉线或账号被限制。后端在翻开关的那一刻
 * 把原因一起写进 enabled_reason / groupEnabled_reason，这里据实分开说，
 * 不再把两种情况糊成一句「模型回复已停止」。没见过的原因只给通用文案 ——
 * 旧版本留下的状态没有原因，不能替它编一个。
 */
const STOP_REASONS = {
  admin_stop: {
    tag: '手动停止',
    row: '这是管理员在 QQ 里手动关掉的。',
    alert: ['你手动停止了模型回复', '这是你在 QQ 里发 /停止 的结果，不是故障。要继续就让管理员发 /启动。'],
  },
  send_failures: {
    tag: '自动熔断',
    row: '连续 3 次发送失败后自动熔断。',
    alert: ['连续发送失败，已自动熔断', '连续 3 次发送失败后自动停止：多半是 OneBot 掉线或账号被限制。先检查消息通道，再发 /启动 恢复。'],
  },
};

const stopInfo = value => STOP_REASONS[String(value === null || value === undefined ? '' : value)] || null;

// 顶栏那一格只放得下一个短标签，所以原因压缩成括号里的两个字。
const stopLabel = value => {
  const info = stopInfo(value);
  return info ? `模型回复已停止（${info.tag}）` : '模型回复已停止';
};

// 表格里的一行：原因 + 恢复命令。模型与群回复的恢复命令不是一个，所以由调用方给。
const stopRow = (value, recover) => {
  const info = stopInfo(value);
  return String(info ? info.row : '原因没有记录（可能是旧版本留下的状态）。') + String(recover || '');
};

// 页面脚本往这里登记自己的渲染函数：app.js 按 data-page 的 id 取用，键名就是页签名。
const pages = {};

/* --- 动作表 ---------------------------------------------------------------
 * 页面脚本把自己的处理器登记进来（data-act 的值 → 函数），app.js 只装一个监听器。
 * 这一层就是为了兑现 CSP 的「禁止内联事件」：HTML 里只留 data-act/data-value 这些数据属性。
 */
const ACTIONS = new Map();
const action = (name, handler) => {
  ACTIONS.set(name, handler);
};

// app.js 在加载完后把自己的 render() 挂进来；页面脚本要「保存后重绘」时调这个，不直连 app.js。
const REPAINT = { now: () => {} };
const rerender = () => REPAINT.now();

/* --- 提示 ---------------------------------------------------------------- */
let toastTimer = null;

const toast = (text, level) => {
  const node = $('#toast');
  if (!node) return;
  node.textContent = String(text);
  node.className = 'toast on' + (level === 'err' ? ' toast-err' : level === 'ok' ? ' toast-ok' : '');
  if (typeof clearTimeout === 'function') clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, 2600);
};

// 就地拦下时用：不改页面、不发请求，只在表单顶部插一条可见说明（原来那个 .banner）。
const flash = (anchor, text, level = 'warn') => {
  const node = document.createElement('div');
  node.className = 'alert alert-' + level + ' banner';
  node.setAttribute('role', level === 'err' ? 'alert' : 'status');
  node.textContent = String(text);
  if (anchor && typeof anchor.before === 'function') anchor.before(node);
  return node;
};

/* --- 通用片段 ------------------------------------------------------------ */
const dot = kind => `<span class="dot dot-${kind}"></span>`;
const badge = (text, kind = 'muted') => `<span class="badge badge-${kind}">${esc(text)}</span>`;

const ALERT_ICON = { ok: '✓', warn: '!', err: '×', info: 'i' };

const alertBox = (level, title, body) =>
  `<div class="alert alert-${level}"><div class="alert-ico">${ALERT_ICON[level] || 'i'}</div>` +
  `<div><div class="alert-title">${esc(title)}</div>${body ? `<div class="alert-body">${esc(body)}</div>` : ''}</div></div>`;

const pageHead = (title, desc) =>
  `<div class="page-head"><h2 class="page-title">${esc(title)}</h2><p class="page-desc">${esc(desc)}</p></div>`;

const card = (title, sub, body, extra = '') =>
  `<div class="card"><div class="card-head"><h3 class="card-title">${esc(title)}` +
  `${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}</h3>${extra}</div>${body}</div>`;

const stat = (label, value, hint) =>
  `<div class="card"><div class="stat-label">${esc(label)}</div>` +
  `<div class="stat-value">${value}</div>${hint ? `<div class="stat-hint">${esc(hint)}</div>` : ''}</div>`;

const kv = rows =>
  `<dl class="kv">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value}</dd>`).join('')}</dl>`;

const table = (headers, rows, options = {}) => {
  if (!rows.length) return `<div class="empty">${esc(options.empty || '还没有数据')}</div>`;
  const head = headers.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.label === undefined ? h : h.label)}</th>`).join('');
  const body = rows
    .map(cells => `<tr>${cells.map((cell, i) => `<td${headers[i] && headers[i].num ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

// 设计稿的开关是 <button class="sw"><span class="sw-knob">：轨道底色的 on/off 全由类决定。
const sw = (on, label, attrs = '') =>
  `<button type="button" class="sw${on ? ' sw-on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}"` +
  ` aria-label="${esc(label)}" ${attrs}><span class="sw-knob"></span></button>`;

const switchRow = (label, control, why) =>
  `<div class="switchrow">${control}<div class="sw-text"><div class="sw-name">${esc(label)}</div>` +
  `<div class="sw-why">${why}</div></div></div>`;

const field = (label, key, control, hint) =>
  `<div class="field"><div class="flabel"><span class="lname">${esc(label)}</span>` +
  `${key ? `<code class="lkey">${esc(key)}</code>` : ''}</div><div class="fctl">${control}</div>` +
  `${hint ? `<div class="fhint">${hint}</div>` : ''}</div>`;

const seg = (options, current, act) =>
  `<div class="seg">${options
    .map(
      option =>
        `<button type="button" class="seg-btn${option.value === current ? ' on' : ''}" data-act="${act}"` +
        ` data-value="${esc(option.value)}">${esc(option.label)}</button>`,
    )
    .join('')}</div>`;

/* --- 数字输入的就地校验 --------------------------------------------------
 * 空值 / 非负整数都要在发请求之前拦下来：这些页面的输入框一旦发出去，后端也只会回一个码，
 * 而用户丢掉的是已经填了一半的表单。所以校验失败时只插一条说明，不重绘、不清空。
 */
const readNumbers = entries => {
  const patch = {};
  const missing = [];
  for (const entry of entries) {
    const input = document.getElementById(entry.id);
    const raw = input ? String(input.value).trim() : '';
    const value = Number(raw);
    if (raw === '' || !Number.isInteger(value) || value < 0) {
      missing.push(entry.label + (raw === '' ? '不能为空' : '要填 0 或正整数'));
      if (input) input.classList.add('is-invalid');
      continue;
    }
    if (input) input.classList.remove('is-invalid');
    patch[entry.key] = value;
  }
  return { patch, missing };
};

// 校验失败的标准回复：给一条「没保存任何改动」的横幅，并说清是哪几项。
const refuse = (anchor, missing) => flash(anchor, `${missing.join('；')}。本次没有保存任何改动。`, 'warn');
