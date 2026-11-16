/**
 * 分享卡片（T-063）：把一条链接变成 QQ 里的**结构化卡片**，而不是裸链接或下载下来的文件。
 *
 * 为什么不做"下载视频再发文件"：
 *   1. 群里的真人分享视频是**卡片**——封面、标题、UP 主、跳转，一眼就知道是什么；
 *      丢一个 mp4 进群既占带宽又没人点开，还容易触发风控（大文件）。
 *   2. 下载 20MB 视频要几十秒、还要 ffmpeg 转码；卡片只要一次 HTTP 拿元数据，毫秒级。
 *   3. 版权/流量也更干净：分享的是"指向"，不是"复制品"。
 *
 * 实现：OneBot v11 的 `json` 消息段，内容是 QQ 的 `com.tencent.structmsg` ark。
 *   实测 SnowLuma 接受该段（send_private_msg → retcode 0），客户端会渲染成新闻/视频卡。
 *
 * 本模块只做纯逻辑（URL 判定、元数据抓取、ark 组包），不碰桥接状态，方便单测。
 */

/**
 * 明显指向内网的 host：直接拒，避免被 prompt injection 拿来探本机端口。
 *
 * ⚠️ 曾经写成 /^(127\.|10\.|…)$/ —— 锚点 `$` 让 "127.0.0.1" 反而匹配不上，
 * 实测 http://127.0.0.1:3100 一路穿透到控制台。所以这里必须把整条 IPv4 写全。
 */
const PRIVATE_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1|\[::1\]|.*\.local)$/i;
const PRIVATE_IPV4 = /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/;

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 只放行公网 http(s)。返回规范化后的 URL 对象，不合法返回 null。
 *
 * 这道闸不是"防君子"：模型看到的是群聊内容，而群聊内容可以被别人投毒。
 * 一旦允许它去 http://127.0.0.1:3100 抓页面，卡片标题就能变成控制台里的敏感信息。
 */
export function parseSafeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || PRIVATE_IPV4.test(host)) return null;
  if (!host.includes('.')) return null;
  return url;
}

/** 把 BV 号 / av 号 / b23.tv 短链 / 完整链接统一认出来。 */
export function parseBilibili(url) {
  const text = String(url ?? '').trim();
  const bv = /\b(BV[0-9A-Za-z]{10})\b/.exec(text);
  if (bv) return { kind: 'video', bvid: bv[1] };
  const av = /\bav(\d{1,12})\b/i.exec(text);
  if (av) return { kind: 'video', aid: Number(av[1]) };
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)bilibili\.com$/.test(host)) return null;
    if (u.pathname.startsWith('/video/')) return { kind: 'video', bvid: u.pathname.split('/')[2] || '' };
    if (u.pathname.startsWith('/bangumi/play/')) return { kind: 'bangumi', id: u.pathname.split('/')[3] || '' };
    if (u.pathname.startsWith('/read/')) return { kind: 'read', id: u.pathname.split('/')[2] || '' };
  } catch { /* 非 URL：上面 BV/av 已经覆盖 */ }
  return null;
}

/** 播放量按中文习惯缩写：12345 → 1.2万。 */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

/** 秒 → m:ss / h:mm:ss。 */
export function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 抓取文本（限字节、限时），任何失败都返回 {ok:false}，不抛。 */
export async function fetchTextOnce(url, { fetchImpl = fetch, maxBytes = 512 * 1024, timeoutMs = 12000, headers = {} } = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': DEFAULT_UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, text: buf.subarray(0, maxBytes).toString('utf8'), bytes: buf.length, finalUrl: res.url || String(url) };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 从 HTML 里捞 og:/twitter:/<title> 三件套。纯字符串匹配，不引 HTML 解析器。 */
export function extractPageMeta(html, baseUrl = '') {
  const text = String(html ?? '');
  const pick = (re) => {
    const m = re.exec(text);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i)
    || pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = pick(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i);
  let image = pick(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (image && baseUrl) {
    try { image = new URL(image, baseUrl).toString(); } catch { /* 保留原样 */ }
  }
  return { title, desc, image };
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * 组装 QQ 的 com.tencent.structmsg 新闻/视频卡。
 *
 * 字段是被 QQ 客户端渲染时才用的，所以这里只放"确实会显示"的：
 * title / desc / preview / jumpUrl / tag。少即是多——多塞字段反而容易让卡片渲染失败。
 */
export function buildNewsArk({ title, desc = '', jumpUrl, preview = '', tag = '', uin = 0, promptPrefix = '[分享]' } = {}) {
  const cleanTitle = String(title ?? '').trim().slice(0, 120);
  const cleanDesc = String(desc ?? '').trim().slice(0, 160);
  const cleanUrl = String(jumpUrl ?? '').trim();
  // 封面统一升到 https：QQ 客户端在部分网络下会拒收 http 图，卡片就变成一块灰。
  const cleanCover = String(preview ?? '').trim().replace(/^http:\/\//i, 'https://');
  const news = {
    title: cleanTitle || cleanUrl,
    desc: cleanDesc,
    jumpUrl: cleanUrl,
    tag: String(tag ?? '').trim().slice(0, 24),
    uin: Number(uin) || 0
  };
  if (cleanCover) news.preview = cleanCover;
  return {
    app: 'com.tencent.structmsg',
    config: { ctime: Math.floor(Date.now() / 1000), forward: true, type: 'normal' },
    desc: '新闻',
    extra: { app_type: 1, appid: 1, uin: Number(uin) || 0 },
    meta: { news },
    prompt: `${promptPrefix}${news.title}`.slice(0, 120),
    ver: '0.0.0.1',
    view: 'news'
  };
}

/**
 * 拉 B 站视频元数据。公开接口，不需要登录（也就不会碰用户账号的风控）。
 * 失败返回 {ok:false}，由上层退回"通用 og 抓取"。
 */
export async function fetchBilibiliVideo({ bvid, aid, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const qs = bvid ? `bvid=${encodeURIComponent(bvid)}` : (aid ? `aid=${Number(aid)}` : '');
  if (!qs) return { ok: false, error: '缺少 bvid/aid' };
  const r = await fetchTextOnce(`https://api.bilibili.com/x/web-interface/view?${qs}`, {
    fetchImpl,
    timeoutMs,
    headers: { referer: 'https://www.bilibili.com/', accept: 'application/json' }
  });
  if (!r.ok) return { ok: false, error: r.error };
  let data;
  try { data = JSON.parse(r.text); } catch { return { ok: false, error: 'B站返回不是 JSON' }; }
  if (Number(data?.code) !== 0 || !data?.data) {
    return { ok: false, error: `B站接口 ${data?.code ?? '?'}：${data?.message ?? '无数据'}` };
  }
  const v = data.data;
  const url = v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : `https://www.bilibili.com/video/av${v.aid}`;
  const parts = [];
  if (v.owner?.name) parts.push(v.owner.name);
  if (v.stat?.view !== undefined) parts.push(`${formatCount(v.stat.view)}播放`);
  if (v.duration) parts.push(formatDuration(v.duration));
  return {
    ok: true,
    title: String(v.title ?? '').trim(),
    desc: parts.join(' · '),
    longDesc: String(v.desc ?? '').trim().slice(0, 120),
    cover: String(v.pic ?? ''),
    url,
    tag: '哔哩哔哩',
    owner: v.owner?.name ?? '',
    duration: Number(v.duration) || 0,
    views: Number(v.stat?.view) || 0
  };
}

/**
 * 通用兜底：抓页面 og 标签，凑一张卡。
 * og 抓不到 title 就返回失败——宁可让模型改发文字，也不要发一张全是空白的卡。
 */
export async function fetchGenericCard({ url, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const safe = parseSafeUrl(url);
  if (!safe) return { ok: false, error: '链接不合法（只接受公网 http/https）' };
  const r = await fetchTextOnce(safe.toString(), { fetchImpl, timeoutMs });
  if (!r.ok) return { ok: false, error: r.error };
  const meta = extractPageMeta(r.text, r.finalUrl || safe.toString());
  if (!meta.title) return { ok: false, error: '页面里没有 og:title / title，凑不出卡片' };
  return {
    ok: true,
    title: meta.title,
    desc: meta.desc.slice(0, 80),
    cover: meta.image,
    url: safe.toString(),
    tag: safe.hostname.replace(/^www\./, '')
  };
}

/**
 * 一站式：给一个链接 + 可选的人工覆盖字段，返回 ark + 说明。
 * 顺序：B站专用接口 → 通用 og → 都失败就报错（**不发裸链接**，用户明确说过不要）。
 */
export async function buildShareCard({ url, title, desc, cover, tag, uin = 0, fetchImpl = fetch } = {}) {
  const safe = parseSafeUrl(url);
  if (!safe) return { ok: false, error: '链接不合法（只接受公网 http/https）' };
  const hit = parseBilibili(safe.toString());
  let meta = null;
  if (hit?.kind === 'video') {
    meta = await fetchBilibiliVideo({ bvid: hit.bvid, aid: hit.aid, fetchImpl });
  }
  if (!meta || !meta.ok) {
    const generic = await fetchGenericCard({ url: safe.toString(), fetchImpl });
    if (generic.ok) {
      // B 站接口挂了但页面能抓：用页面标题，tag 仍按 B 站标
      meta = { ...generic, tag: hit ? '哔哩哔哩' : generic.tag };
    } else if (meta && !meta.ok) {
      return { ok: false, error: `拿不到元数据：${meta.error}；页面抓取也失败：${generic.error}` };
    } else {
      return { ok: false, error: `拿不到元数据：${generic.error}` };
    }
  }
  const ark = buildNewsArk({
    title: String(title ?? '').trim() || meta.title,
    desc: String(desc ?? '').trim() || meta.desc,
    jumpUrl: String(url ?? '').trim() || meta.url,
    preview: String(cover ?? '').trim() || meta.cover,
    tag: String(tag ?? '').trim() || meta.tag,
    uin
  });
  return {
    ok: true,
    ark,
    meta: {
      title: ark.meta.news.title,
      desc: ark.meta.news.desc,
      tag: ark.meta.news.tag,
      preview: ark.meta.news.preview ?? '',
      url: ark.meta.news.jumpUrl
    }
  };
}
