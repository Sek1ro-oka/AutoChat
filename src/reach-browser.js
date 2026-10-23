// 小红书**网页层**抓取（T-029）：站内搜索（`opencli xiaohongshu search`）坏掉时，
// 用浏览器打开一个搜索结果页，把页面已经渲染出来的笔记卡片抓下来。
//
// 为什么单独一层：
//   · 这里只做「打开 → 等卡片 → 读 DOM → 整形」，**不含 spawn**：真正的进程启动在
//     `src/reach-tools.js` 里（与 bili / 小黑盒共用同一套 `spawnTarget` 安全逻辑），
//     所以单测可以注入一个 `runBrowser` 桩，完全不碰真浏览器。
//   · 抓取脚本必须是**常量字符串**：用户输入只进 URL（且过 `encodeURIComponent`），
//     绝不拼进 JS。否则「搜索词」就是一条注入面（`'); fetch(...)` 之类）。
//
// 只读边界（本文件必须一直满足）：
//   · 只调 opencli 的 `browser open / wait selector / eval` 三个动作，只读 DOM；
//     不点击、不输入、不发帖、不登录——撞到登录墙就如实报 `login_required`。
//   · 不缓存：每次调用都真的开页、真的抓一次（同参数连续两次 = 两次真实执行）。
import {
  BROWSER_TIMEOUT,
  XHS_BROWSER_PAGE_CHANGED,
  XHS_BROWSER_UNAVAILABLE,
  XHS_BROWSER_WALL,
  XHS_CARD_SELECTOR,
  XHS_SEARCH_PAGE_URL,
  parseXhsBrowserCards
} from './reach-core.js';

/**
 * 兜底链路自己的错误类型：只带 `reason` 与给模型看的话术，
 * 由 `src/reach-tools.js` 转成 reach 的 `{ ok:false, code:'unavailable', reason, error }`。
 */
export class ReachBrowserError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ReachBrowserError';
    this.reason = reason;
  }
}

/** 搜索页地址：用户输入**只**出现在这里，且过 `encodeURIComponent`。 */
export function xhsSearchPageUrl(word) {
  return `${XHS_SEARCH_PAGE_URL}?keyword=${encodeURIComponent(String(word ?? ''))}`;
}

/**
 * 在页面里跑的常量脚本：只读 DOM，返回一个纯数据对象。
 *
 * 选择器的来历（实测，2026-10-23）：
 *   · `[class*="note-item"]` = 卡片容器，但**其中约 5 个是「大家都在搜」推荐词块**，
 *     它们没有 `/explore/` 链接 → 必须再套 `a[href*="/explore/"]` 才能剔掉；
 *   · 卡片的 `innerText` 行序是 `[标题, 作者, MM-DD, 点赞数]`，个别卡片没有标题，
 *     所以原样把前 6 行交给上层（`parseXhsBrowserCards` 用日期行切分，不按固定下标猜）；
 *   · 登录墙**不会**改标题（标题照样是 `咖啡 - 小红书搜索`），只有正文出现
 *     「登录后查看搜索结果」，所以判定标志从 `body.innerText` 里取。
 */
export const XHS_EXTRACT_SCRIPT = `(() => {
  const nodes = Array.from(document.querySelectorAll('[class*="note-item"]'));
  const cards = [];
  for (const el of nodes.slice(0, 40)) {
    const link = el.querySelector('a[href*="/explore/"]');
    const href = link ? String(link.getAttribute('href') || '') : '';
    const hit = href.match(/\\/explore\\/([0-9A-Za-z]+)/);
    if (!hit) continue;
    const lines = (el.innerText || '').split('\\n').map((s) => s.trim()).filter((s) => s !== '');
    cards.push({ href: '/explore/' + hit[1], id: hit[1], lines: lines.slice(0, 6) });
  }
  const body = document.body ? String(document.body.innerText || '') : '';
  return {
    title: String(document.title || ''),
    url: String(location.href || ''),
    total: nodes.length,
    cards: cards,
    loginWall: body.indexOf('登录后查看') >= 0 || body.indexOf('扫码登录') >= 0,
    bodyHead: body.slice(0, 400)
  };
})()`;

/**
 * 等卡片选择器出现的最长时间：页面是 SPA，`open` 之后立刻 eval 只有空壳。
 * 实测正常页面 0.3–3.5 秒就能等到；等不到基本就是登录墙或改版，早点把判定交给 `eval`。
 */
const WAIT_MS_DEFAULT = 15000;

/**
 * `open` 自己最多等多久。实测（2026-10-23）：搜索结果页正常时 6–12 秒返回；
 * 一旦撞上登录墙，导航事件迟迟不齐，`open` 会一路挂到调用方的超时（60 秒）才被我们的
 * timeout 打断，于是「要登录」被误报成「超时」。导航慢**不等于**失败——页面在不在、
 * 是不是登录墙，交给后面的 `wait selector` 与 DOM 报告判断，所以这里只给它 15 秒。
 */
const OPEN_MS_DEFAULT = 15000;

/**
 * `wait` / `eval` 这两步的**进程**超时（不是选择器自己的 --timeout）。
 *
 * 为什么要单独限：`wait` 的 `--timeout` 是 opencli 自己数的时间，扩展一旦掉线它就不数了，
 * 实测出现过「选择器 25 秒预算却让整条命令挂到 60 秒调用方上限」——一次搜索因此拖到 84.8 秒。
 * 现在每一步都只拿到自己的那点预算，超了就当这一步失败，由后面的判定决定原因。
 */
const STEP_MS_DEFAULT = 20000;

/**
 * 跑完就还标签租约（`browser close --session <s>`）最多等多久。
 *
 * 为什么必须还：opencli 的 session 是一个真实 Chrome 标签的租约。实测（2026-10-23）连续抓十几次
 * 之后，残留的租约会把下一条命令拖到超时（`eval` 挂满 60 秒、随后 AI 问答也挂满 120 秒）；
 * 手动 `browser close` 之后立刻恢复到 8–20 秒。所以每次抓完（成功或失败都算）都还一次，
 * 释放失败也不影响本次结果。
 */
const CLOSE_MS_DEFAULT = 10000;

/**
 * @param {object} [deps]
 * @param {(bin: string, argv: string[], options?: object) => Promise<{stdout:string,stderr:string,code:number}>} deps.runBrowser
 *   「跑一次 opencli browser 命令」的注入点（单测用桩；默认由 reach-tools 传 defaultRunCli）。
 */
export function createReachBrowser({ runBrowser } = {}) {
  if (typeof runBrowser !== 'function') {
    throw new TypeError('createReachBrowser 需要 runBrowser（跑 opencli browser 命令的函数）');
  }

  /** 跑一条 browser 子命令并解析 opencli 的 `{ok, data|error}` 外壳。 */
  async function browserCommand(argv, { timeoutMs, step }) {
    let result;
    try {
      result = await runBrowser(argv.bin, argv.args, { timeoutMs });
    } catch (error) {
      const detail = String(error?.message ?? error);
      // 进程级失败：起不来 / 超时 / 输出超限。超时要单独标出来，便于模型判断「等会儿再试」。
      const reason = /超时|timed out/i.test(detail) ? BROWSER_TIMEOUT : XHS_BROWSER_UNAVAILABLE;
      throw new ReachBrowserError(reason, `打开浏览器${step}失败：${detail.slice(0, 300)}`);
    }
    const text = String(result?.stdout ?? '');
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== 'object') {
      const raw = text.trim().slice(0, 300) || String(result?.stderr ?? '').trim().slice(0, 300) || '（没有任何输出）';
      throw new ReachBrowserError(XHS_BROWSER_UNAVAILABLE, `浏览器${step}没有返回 JSON（exit ${result?.code ?? '?'}）：${raw}`);
    }
    return payload;
  }

  function errorText(payload) {
    const error = payload?.error;
    if (!error) return '（没有错误详情）';
    const code = String(error.code ?? '');
    const message = String(error.message ?? '');
    return [code, message].filter((part) => part !== '').join(': ') || '（没有错误详情）';
  }

  /**
   * 抓一次小红书搜索页，返回 `{ items, pageUrl }`（`items` 已过了链接过滤与去重）。
   *
   * 失败一律抛 `ReachBrowserError`，`reason` 是三个之一：
   *   · `browser_unavailable` —— 浏览器起不来 / opencli 报错 / 没有 JSON；
   *   · `login_required`      —— 页面要求先登录（正文出现「登录后查看」）；
   *   · `page_changed`        —— 页面能开但结构变了 / 会话跑到别的页面去了 / 一张卡都没有。
   * **绝不返回空列表冒充成功**。
   */
  async function searchXhsPage({ bin, query, limit, timeoutMs } = {}, base) {
    const pageUrl = xhsSearchPageUrl(query);
    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    // 每一步只拿「自己那一份」：任何一步卡住都不许把整条链拖过预算（实测 `wait` 曾挂到 60s，
    // 一次搜索因此变成 84.8 秒）。剩余时间不足时给个下限，避免算出 0 直接打不开页面。
    const startedAt = Date.now();
    const remaining = () => Math.max(3000, budget - (Date.now() - startedAt));
    const openMs = Math.min(OPEN_MS_DEFAULT, remaining());
    const waitMs = Math.min(WAIT_MS_DEFAULT, Math.max(3000, remaining() - 2000));

    // ① 打开搜索页：只用 GET，不提交任何表单。
    //    `open` 超时（导航事件一直不齐）不算失败：页面往往已经在了，接着往下等卡片、读 DOM，
    //    真撞登录墙会在第 ③ 步被认成 `login_required`，比笼统的「超时」有用得多。
    try {
      const opened = await browserCommand(
        { bin, args: [...base, 'open', pageUrl] },
        { timeoutMs: openMs, step: '打开搜索页' }
      );
      if (opened.ok !== true) {
        throw new ReachBrowserError(XHS_BROWSER_UNAVAILABLE, `打开小红书搜索页失败：${errorText(opened)}`);
      }
    } catch (error) {
      if (!(error instanceof ReachBrowserError) || error.reason !== BROWSER_TIMEOUT) throw error;
    }

    // ② 等卡片出现（SPA 渲染需要时间）。等不到**不算**最终失败：登录墙 / 改版都会等不到，
    //    真正的判定交给下一步的 DOM 报告（那里能区分「要登录」和「结构变了」）。
    //    注意 opencli 的 `wait` 超时是**正常返回** `{ok:false, error:{message:'Selector not found'}}`，
    //    不是进程失败；真起不来才会抛，那种必须原样上抛（进程级超时例外，同样交给第 ③ 步）。
    try {
      await browserCommand(
        { bin, args: [...base, 'wait', 'selector', XHS_CARD_SELECTOR, '--timeout', String(waitMs)] },
        { timeoutMs: Math.min(STEP_MS_DEFAULT, waitMs + 5000), step: '等待卡片' }
      );
    } catch (error) {
      if (!(error instanceof ReachBrowserError) || error.reason !== BROWSER_TIMEOUT) throw error;
    }

    // ③ 读 DOM（常量脚本，不掺任何用户输入）。
    const evaluated = await browserCommand(
      { bin, args: [...base, 'eval', XHS_EXTRACT_SCRIPT] },
      { timeoutMs: Math.min(STEP_MS_DEFAULT, remaining()), step: '读取页面' }
    );
    if (evaluated.ok !== true) {
      throw new ReachBrowserError(XHS_BROWSER_PAGE_CHANGED, `读取小红书搜索页失败：${errorText(evaluated)}`);
    }

    const parsed = parseXhsBrowserCards(evaluated.data, limit);
    if (parsed.ok !== false && parsed.wall) {
      throw new ReachBrowserError(
        XHS_BROWSER_WALL,
        `小红书的搜索页要求先登录（页面正文：${parsed.bodyHead.slice(0, 80) || '登录后查看搜索结果'}）；reach 不会自己登录，去浏览器里登录一次再试`
      );
    }
    if (parsed.ok === false) {
      throw new ReachBrowserError(XHS_BROWSER_PAGE_CHANGED, `小红书搜索页的返回形状认不出（${parsed.reason}），可能是站点改版`);
    }
    // 会话是真实浏览器的标签租约：用户可能刚在这个标签里点去了别的页面。
    if (!String(parsed.url).includes('search_result')) {
      throw new ReachBrowserError(XHS_BROWSER_PAGE_CHANGED, `这个浏览器标签已经不在搜索页了（当前 ${parsed.url || '未知地址'}），再搜一次会重新打开`);
    }
    if (parsed.items.length === 0) {
      throw new ReachBrowserError(
        XHS_BROWSER_PAGE_CHANGED,
        `小红书搜索页能开但一张笔记卡片都没抓到（匹配到 ${parsed.total} 个卡片容器、0 个带笔记链接），站点可能改版了`
      );
    }
    return { items: parsed.items, pageUrl: parsed.url || pageUrl, title: parsed.title };
  }

  /** 还掉本次占用的标签租约；失败不回传（释放不了也不该让一次成功的抓取变成失败）。 */
  async function releaseSession(bin, base) {
    try {
      await runBrowser(bin, [...base, 'close'], { timeoutMs: CLOSE_MS_DEFAULT });
    } catch {
      // 忽略：下一次 open 会用同一个 session 名字重新拿租约。
    }
  }

  /**
   * 抓一次小红书搜索页（对外入口）：成功返回 `{ items, pageUrl, title }`，失败抛 `ReachBrowserError`。
   * 无论成功失败都把标签租约还掉——不然残留租约会拖垮下一次调用（见 `CLOSE_MS_DEFAULT`）。
   */
  async function searchXhs(options = {}) {
    const { bin, session, windowMode } = options;
    const base = ['browser', '--session', String(session), '--window', String(windowMode)];
    try {
      return await searchXhsPage(options, base);
    } finally {
      await releaseSession(bin, base);
    }
  }

  return { searchXhs };
}
