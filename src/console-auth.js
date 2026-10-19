/**
 * 控制台令牌的纯函数集合：页面路径判定、Cookie 头解析、令牌来源解析、会话 Cookie 拼装。
 *
 * 这个模块只做"令牌从哪来"的判定，**不做比较**——定长比较留在 bridge.js 里，
 * 因为它需要 crypto.timingSafeEqual 与真正的令牌值，这里只负责把候选值挑出来。
 *
 * ═══ 安全边界（改这个文件之前先读完；这条边界是设计因果，不是实现细节） ═══
 *
 * `/api/*` 与一切非 GET 请求**永不读 cookie**。cookie 只对 `GET /` 和 `GET /demo`
 * 这两个"人直接在地址栏打开的 HTML 页面"生效，目的是让人只输一次令牌：之后刷新页面、
 * 或者从 /demo 点回控制台首页，都不必再弹 prompt。
 *
 * 为什么接口侧一律不读：接口是脚本与前端代码在调，不需要"少输一次"的便利，却需要
 * 最小的暴露面。一旦 /api/* 认 cookie，攻击面就从"猜一个 192 bit 随机值"退化成
 * "诱导本机浏览器带上一个已有 cookie"，CSRF 就只剩 SameSite 一层在拦。
 * `SameSite=Strict` 是**第二层**，第一层永远是"鉴权路径根本不看这个头"。
 *
 * 没有用 `__Host-` 前缀：它要求 Secure，而控制台是 http://127.0.0.1 明文回环，
 * 带上 Secure 浏览器会直接丢弃这个 cookie，等于开关失效。纯回环 + 无 Secure 时，
 * `__Host-` 带来的额外约束（无 Domain、Path=/）我们已用显式 Path=/ 与不写 Domain 满足。
 *
 * 模块纪律：零依赖、零 I/O（不读环境变量、不写日志、不 import 任何东西、不用 Date.now），
 * 这样它既能被 bridge.js 直接调用，也能在 VM 审计沙盘（scripts/audit-bridge-harness.mjs）
 * 里整个 spread 进上下文而不需要任何桩。别在这里加 console.log 或 fs。
 */

/** 控制台会话 cookie 名。改名等于让所有已登录的浏览器重新 prompt 一次。 */
export const CONSOLE_COOKIE_NAME = 'dsh_console_token';

/** 会话 cookie 有效期：30 天（秒）。令牌本身轮换由 bridge 启动时决定，这里只定浏览器侧寿命。 */
export const CONSOLE_COOKIE_MAX_AGE_SEC = 2592000;

/** 允许读 cookie 的页面路径（**严格相等**，刻意不放宽末尾斜杠与子路径）。 */
export const PAGE_PATHS = Object.freeze(['/', '/demo']);

/**
 * 这个路径是不是"人打开的 HTML 页面"。
 * 严格相等：`/demo/`、`//`、`/api/status` 都返回 false —— 放宽容错只会扩大 cookie 生效面。
 * @param {string} pathname `new URL(req.url, base).pathname`
 * @returns {boolean}
 */
export function isPagePath(pathname) {
  return PAGE_PATHS.includes(String(pathname ?? ''));
}

/**
 * 从 `Cookie` 请求头里取一个同名 cookie 的值。
 *
 * 规则（都为了可预测，不为了宽容）：
 *   - 按 ';' 切段，每段按第一个 '=' 切成名/值，名与值都 trim；
 *   - 只取**第一个**同名项，后面的重复项一律忽略；
 *   - 同名但值为空 → 当作没有（返回 null），不继续找下一个同名项；
 *   - 值做 decodeURIComponent，解不开（畸形 % 序列）就原样返回 —— 解不开不代表值不能用，
 *     反正后面还要和真令牌做定长比较，猜错就是 401。
 * @param {string|undefined|null} headerValue `req.headers.cookie`
 * @param {string} name 要找的 cookie 名
 * @returns {string|null}
 */
export function parseCookieHeader(headerValue, name) {
  const header = String(headerValue ?? '');
  const wanted = String(name ?? '');
  if (!header || !wanted) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== wanted) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * 判定一次请求该用哪个令牌，以及它来自哪里。
 *
 * 优先级 url > header > cookie：
 *   - `?token=` 是人在地址栏/401 页里刚输进来的，最权威；
 *   - `x-console-token` 是控制台脚本自己带的；
 *   - cookie 是"之前输过"的残留，最后兜底，且**只在 page GET 上参与**。
 *
 * 空串一律视作"没有这个来源"，免得 `?token=` 把 header 里的真令牌盖掉。
 * @param {{method?: string, pathname?: string, urlToken?: string|null,
 *          headerToken?: string|string[]|null, cookieHeader?: string|null}} input
 * @returns {{token: string, source: 'url'|'header'|'cookie'|null}}
 */
export function resolveRequestToken(input = {}) {
  const urlToken = String(input.urlToken ?? '');
  if (urlToken) return { token: urlToken, source: 'url' };
  const headerToken = String(input.headerToken ?? '');
  if (headerToken) return { token: headerToken, source: 'header' };
  // cookie 的生效面就是这两行：方法必须是 GET，路径必须是 / 或 /demo。
  // 想让它对 `/api/` 开头的路径也生效 = 把 CSRF 的第一层拆掉，不要这么改。
  if (String(input.method ?? '').toUpperCase() === 'GET' && isPagePath(input.pathname)) {
    const cookieToken = parseCookieHeader(input.cookieHeader, CONSOLE_COOKIE_NAME);
    if (cookieToken) return { token: cookieToken, source: 'cookie' };
  }
  return { token: '', source: null };
}

/**
 * 拼 `Set-Cookie` 的值。
 *
 * HttpOnly 防页面脚本读（XSS 拿不到）；SameSite=Strict 防跨站携带（第二层）；
 * Path=/ 让 /demo 也能带上；不写 Domain 就是 host-only，只对 127.0.0.1 生效。
 * 值用 encodeURIComponent 编码，与 parseCookieHeader 的 decodeURIComponent 对称。
 * @param {string} token
 * @returns {string}
 */
export function buildSessionCookie(token) {
  const value = encodeURIComponent(String(token ?? ''));
  return `${CONSOLE_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CONSOLE_COOKIE_MAX_AGE_SEC}`;
}
