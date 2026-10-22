#!/usr/bin/env node
/**
 * T-017 生图 / 发图 / 存表情 / 换头像 —— 桥接侧端点契约测试（静态切片）。
 *
 * 为什么是静态断言而不是起服务真打请求：src/bridge.js 顶层就 loadConfig() + 建目录，
 * import 一次等于把整条桥接真跑起来（还会去连 SnowLuma）。所以和
 * scripts/test-profile-endpoints.mjs 一样：读源码 → 切片 → 断言闸门顺序与响应形状；
 * 能真跑的纯函数（429 文案、图片 id 正则）用 extractFunction 抠出来在这里跑。
 *
 * 断言分成八组：
 *   一 端点存在 / 顺序 / 白名单      二 生成端点的闸门顺序
 *   三 429 与 400 文案（真跑）       四 取图（base64 JSON）
 *   五 发图（sendChain + 守卫）      六 存表情
 *   七 换头像（来源白名单）          八 prompt payload / 常量 / 状态 / 配置归一
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`❌ ${name}${extra === undefined ? '' : `\n   ↳ ${extra}`}`);
  }
}

const lineOf = (text, needle) => {
  const at = text.indexOf(needle);
  return at < 0 ? -1 : text.slice(0, at).split('\n').length;
};

/** 从 a 切到 b（含 a 不含 b）；任一端缺失给空串 —— 缺端点本身会由「存在」那组抓出来。 */
function sliceBetween(text, a, b) {
  const start = text.indexOf(a);
  if (start < 0) return '';
  const end = text.indexOf(b, start + a.length);
  if (end < 0) return '';
  return text.slice(start, end);
}

/**
 * 抠出一个函数的完整源码（先配平参数表的圆括号，再配平函数体的花括号）。
 *
 * 参数表必须单独配平：`function f(x = {})` 里的 `{}` 是默认值，先数花括号的话
 * 会在那里就「闭合」出一个半截函数（sendImageV2 的 options = {} 正是这种情况）。
 */
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return '';
  let i = text.indexOf('(', start);
  if (i < 0) return '';
  let parens = 0;
  for (; i < text.length; i++) {
    if (text[i] === '(') parens++;
    else if (text[i] === ')') {
      parens--;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/** 把函数源码编译成可调用函数，依赖（profileWaitText / imageConfig…）由调用方注入。 */
function compile(name, deps = {}) {
  const src = extractFunction(bridge, `function ${name}(`);
  if (!src) return null;
  const names = Object.keys(deps);
  try {
    return new Function(...names, `${src}\nreturn ${name};`)(...names.map((n) => deps[n]));
  } catch {
    return null;
  }
}

const bridge = read('src/bridge.js');
const esc = (p) => p.replace(/\//g, '\\/');

// ── 一 端点存在、顺序、白名单 ────────────────────────────────────────────────
console.log('\n一 端点存在 / 顺序 / 白名单');

const P_GENERATE = '/api/socialV2/images/generate';
const P_GET_IMAGE = '/api/images/generated/';
const P_SEND_IMAGE = '/api/send/image';
const P_STICKER = '/api/socialV2/images/sticker';
const P_AVATAR = '/api/socialV2/profile/avatar';

const routeGenerate = `if (req.method === 'POST' && url.pathname === '${P_GENERATE}') {`;
const routeGet = 'if (req.method === \'GET\' && url.pathname.startsWith(IMAGE_GET_PREFIX)) {';
const routeSend = `if (req.method === 'POST' && url.pathname === '${P_SEND_IMAGE}') {`;
const routeSticker = `if (req.method === 'POST' && url.pathname === '${P_STICKER}') {`;
const routeAvatar = `if (req.method === 'POST' && url.pathname === '${P_AVATAR}') {`;

check('POST /api/socialV2/images/generate 存在', lineOf(bridge, routeGenerate) > 0, lineOf(bridge, routeGenerate));
check('GET /api/images/generated/:id 存在', lineOf(bridge, routeGet) > 0, lineOf(bridge, routeGet));
check('POST /api/send/image 存在', lineOf(bridge, routeSend) > 0, lineOf(bridge, routeSend));
check('POST /api/socialV2/images/sticker 存在', lineOf(bridge, routeSticker) > 0, lineOf(bridge, routeSticker));
check('POST /api/socialV2/profile/avatar 存在', lineOf(bridge, routeAvatar) > 0, lineOf(bridge, routeAvatar));

const posGenerate = lineOf(bridge, routeGenerate);
const posGet = lineOf(bridge, routeGet);
const posSend = lineOf(bridge, routeSend);
const posSticker = lineOf(bridge, routeSticker);
const posAvatar = lineOf(bridge, routeAvatar);
check(
  '五个端点顺序 = 画 → 取 → 发 → 存表情 → 换头像（dev-doc §五）',
  posGenerate > 0 && posGenerate < posGet && posGet < posSend && posSend < posSticker && posSticker < posAvatar,
  `generate=${posGenerate} get=${posGet} send=${posSend} sticker=${posSticker} avatar=${posAvatar}`
);

// 令牌关卡之前就 return 的端点会绕过鉴权；五个都必须在 resolveRequestToken 之后。
const posTokenGate = lineOf(bridge, 'resolveRequestToken({');
check('五个端点都在全局令牌关卡之后', posTokenGate > 0 && posGenerate > posTokenGate, `tokenGate=${posTokenGate}`);
check(
  '五个端点都在 profile 三个端点之后（挨着资料区块）',
  posGenerate > lineOf(bridge, "url.pathname === '/api/socialV2/profile/group-card'")
);

const adminOnly = sliceBetween(bridge, 'const adminOnlyV2Paths = [', '];');
check('adminOnlyV2Paths 不含 images/generate', adminOnly.length > 0 && !adminOnly.includes(P_GENERATE));
check('adminOnlyV2Paths 不含 images/sticker', adminOnly.length > 0 && !adminOnly.includes(P_STICKER));
check('adminOnlyV2Paths 不含 profile/avatar', adminOnly.length > 0 && !adminOnly.includes(P_AVATAR));
check('adminOnlyV2Paths 仍含 profile/ 之外的 cross（没被误删）', adminOnly.includes('/api/socialV2/cross'));

// agent 通道：/api/send/img 与 /api/images/generated 都必须够得着，否则 MCP 一调就 403。
const posAgentAllow = lineOf(bridge, 'const agentAllowed =');
const agentBlock = sliceBetween(bridge, 'const agentAllowed =', '};');
check('agentAllowed 放行 /api/send/ 前缀（发图可达）', agentBlock.includes("startsWith('/api/send/')"));
check('agentAllowed 放行 /api/images/ 前缀（取图可达）', agentBlock.includes("startsWith('/api/images/')"));
check('agentAllowed 在端点之前定义', posAgentAllow > 0 && posAgentAllow < posGenerate);

const tokenlessBlock = sliceBetween(bridge, 'const tokenlessAgentAllowed', '};');
check('tokenlessAgentAllowed 放行 /api/images/', tokenlessBlock.includes("startsWith('/api/images/')"));
check('tokenlessAgentAllowed 放行 /api/send/', tokenlessBlock.includes("startsWith('/api/send/')"));

// 取的图不是文件系统里的任意路径：id 走索引，路由用常量前缀而不是裸字面量。
check('取图路由复用 IMAGE_GET_PREFIX 常量', bridge.includes("const IMAGE_GET_PREFIX = '/api/images/generated/';"));
check('取图从 pathname 里 slice 出 id 后再 decodeURIComponent', sliceBetween(bridge, routeGet, routeSend).includes('decodeURIComponent(url.pathname.slice(IMAGE_GET_PREFIX.length))'));

// ── 二 生成端点的闸门顺序 ───────────────────────────────────────────────────
console.log('\n二 生成端点的闸门顺序');

const genBlock = sliceBetween(bridge, routeGenerate, 'url.pathname.startsWith(IMAGE_GET_PREFIX)');
check('生成端点切片非空', genBlock.length > 1000, genBlock.length);

const genSteps = {
  '请求体解析': 'await readImageBody(req)',
  '鉴权': "if (imageAuthFailed(req, '')) return;",
  '总开关': 'imageCfg.enabled === false',
  '提示词清洗': 'cleanImagePrompt(body.prompt, imageCfg.promptMaxChars)',
  '提示词审计': 'checkImagePrompt(cleaned, imageCfg)',
  '尺寸归一': 'normalizeSize(body.width, body.height, imageCfg)',
  '生成额度': "readImageUsageFor('generate', now)",
  '上游取图': 'fetchGeneratedImage({ prompt: cleaned',
  '落盘': 'saveGeneratedImage({ dir: IMAGE_DIR',
  '写索引': 'await writeImageIndex({',
  '记账': "recordImageUsage(readImageUsage(), 'generate', now, { imageId: entry.id })"
};
const genPos = {};
for (const [label, needle] of Object.entries(genSteps)) genPos[label] = genBlock.indexOf(needle);
const genOrder = Object.entries(genPos);
const genSorted = [...genOrder].sort((a, b) => a[1] - b[1]);
check(
  '闸门顺序：body → 鉴权 → 开关 → 提示词 → 尺寸 → 额度 → 上游 → 落盘 → 索引 → 记账',
  genOrder.every(([, at]) => at >= 0) && genSorted.every(([label], i) => label === genOrder[i][0]),
  JSON.stringify(genPos)
);
check('记账在写索引之后（先有 id 才记 imageId）', genPos['记账'] > genPos['写索引']);

check('403 disabled 带 reason 与中文文案', genBlock.includes("reason: 'disabled', error: '生图功能已关闭（socialV2.images.enabled = false）' }, 403)"));
// 只停生图（2026-10-21）：渠道质量不行时保留发图/存表情/换头像，所以生图这条腿
// 必须有自己的一档拒绝，且排在提示词清洗之前（否则模型会先收到 bad_prompt 去改词）。
check('只停生图的分档 403 generate_disabled', genBlock.includes("reason: 'generate_disabled'"));
check('generate_disabled 在提示词清洗之前', genBlock.indexOf('imageCfg.generateEnabled === false') > genPos['总开关']
  && genBlock.indexOf('imageCfg.generateEnabled === false') < genPos['提示词清洗']);
check('400 bad_prompt 带 reason', genBlock.includes("reason: 'bad_prompt'"));
check('400 bad_prompt 回 hits（MCP 会拼进给模型的提示）', genBlock.includes('hits: verdict.hits }, 400'));
check('400 bad_prompt 另带 code 说明具体哪一条', genBlock.includes('code: verdict.reason'));
check('额度不足走 imageQuotaRejected', genBlock.includes("imageQuotaRejected('generate', quota)"));
check('取图失败回 502', genBlock.includes("reason: generated.reason || 'upstream_error'") && genBlock.includes('}, 502)'));
check('上游 402 回 429 + reason rate_limited', genBlock.includes("reason: 'rate_limited', retryAfterMs"));
check('上游冷却文案「上游还在冷却，约 N 秒后再试」', genBlock.includes('上游还在冷却，约 ${Math.ceil(retryAfterMs / 1000)} 秒后再试'));
check(
  '成功回包含 id/width/height/mime/bytes/ts/prompt/source',
  genBlock.includes('image: { id: entry.id, width: size.width, height: size.height, mime: entry.mime, bytes: entry.bytes, ts: entry.ts, prompt: entry.prompt, source: imageCfg.provider }')
);
check('宽度高度进索引的 meta（顶层会被 image-gen 丢掉）', genBlock.includes('const meta = { width: size.width, height: size.height, source: imageCfg.provider };'));
check('日志 [images] 已生成', genBlock.includes('[images] 已生成 ${entry.id}'));
check('落盘失败回 500 而不是 502（图生成了、盘没写成）', genBlock.includes("reason: 'internal', error: '图片已生成但落盘失败，详情见桥接日志' }, 500)"));

// ── 三 文案（真跑） ──────────────────────────────────────────────────────────
console.log('\n三 429 / 400 文案（真跑）');

const stubWait = (ms) => (Number(ms) > 0 ? '24 小时' : '');
const quotaText = compile('imageQuotaErrorText', { profileWaitText: stubWait });
check('imageQuotaErrorText 能编译（依赖 profileWaitText）', typeof quotaText === 'function');

if (typeof quotaText === 'function') {
  const tooFrequent = quotaText('generate', { reason: 'too_frequent', retryAfterMs: 45000, minGapMs: 45000 });
  check('too_frequent 文案含「出图太频繁了，45 秒后才能再画」', tooFrequent.includes('出图太频繁了，45 秒后才能再画'), tooFrequent);
  check('too_frequent 文案含「上游限制 45 秒一张」', tooFrequent.includes('（上游限制 45 秒一张）'), tooFrequent);

  const windowCap = quotaText('generate', { reason: 'window_cap', windowHours: 24, windowCap: 20, retryAfterMs: 3600000 });
  check('window_cap 文案含「24 小时内画了 20 张」', windowCap.includes('24 小时内画了 20 张'), windowCap);
  check('window_cap 文案含「额度用完了」', windowCap.includes('额度用完了'), windowCap);

  const stickerCap = quotaText('sticker', { reason: 'window_cap', windowHours: 24, windowCap: 5, retryAfterMs: 3600000 });
  check('表情 window_cap 文案含「24 小时内收藏表情额度用完了（5 个）」', stickerCap.includes('24 小时内收藏表情额度用完了（5 个）'), stickerCap);
  const stickerGap = quotaText('sticker', { reason: 'too_frequent', retryAfterMs: 5000 });
  check('表情 too_frequent 文案含「收藏表情太频繁了，5 秒后才能再收」', stickerGap.includes('收藏表情太频繁了，5 秒后才能再收'), stickerGap);

  const avatarGap = quotaText('avatar', { reason: 'too_frequent', windowHours: 24, windowCap: 1, minGapMs: 21600000, retryAfterMs: 21599000 });
  check('头像 too_frequent 文案含「24 小时最多换 1 次」', avatarGap.includes('24 小时最多换 1 次'), avatarGap);
  check('头像 too_frequent 文案含「至少隔 6 小时」', avatarGap.includes('两次之间至少隔 6 小时'), avatarGap);
  check('头像 too_frequent 文案含「约 24 小时后再换」', avatarGap.includes('约 24 小时后再换'), avatarGap);
  const avatarCap = quotaText('avatar', { reason: 'window_cap', windowHours: 24, windowCap: 1, retryAfterMs: 1000 });
  check('头像 window_cap 文案交代次数上限', avatarCap.includes('24 小时最多换 1 次'), avatarCap);
  check('未知 reason 有兜底文案（不吐 undefined）', quotaText('generate', {}).includes('未知原因') && !quotaText('generate', {}).includes('undefined'));

  const promptText = compile('imagePromptErrorText', { imageConfig: () => ({ promptMaxChars: 300 }) });
  check('imagePromptErrorText 能编译', typeof promptText === 'function');
  if (typeof promptText === 'function') {
    check('too_short 文案让模型「说清想画什么」', promptText({ reason: 'too_short', hits: [] }).includes('说清想画什么'));
    check('real_person 文案是「不画真人照片」', promptText({ reason: 'real_person', hits: ['张三'] }).includes('不画真人照片'));
    check('too_long 文案带上配置的字数上限 300', promptText({ reason: 'too_long', hits: [] }).includes('300'));
    check('audit 文案带命中项（截断到 40 字）', promptText({ reason: 'audit', hits: [{ term: 'x'.repeat(80) }] }).includes('…'));
  }
}

const quotaRejectSrc = extractFunction(bridge, 'function imageQuotaRejected(');
check('imageQuotaRejected 把额度字段铺在顶层（MCP 读 body.retryAfterMs）', quotaRejectSrc.includes('...imageQuotaView(quota)'));
check('imageQuotaRejected 对 disabled 回 403', quotaRejectSrc.includes("reason: 'disabled'") && quotaRejectSrc.includes('}, 403)'));

// ── 四 取图 ─────────────────────────────────────────────────────────────────
console.log('\n四 GET /api/images/generated/:id');

const getBlock = sliceBetween(bridge, routeGet, routeSend);
check('取图切片非空', getBlock.length > 500, getBlock.length);
check('400 bad_image（id 不是 uuid）', getBlock.includes("reason: 'bad_image', error: '图片 id 不是合法的 uuid' }, 400)"));
check('decodeURIComponent 失败也回 400 而不是 500', getBlock.includes("reason: 'bad_image', error: '图片 id 无法解析' }, 400)"));
check('先查索引再读文件（只按索引查）', getBlock.indexOf('const index = await readImageIndex()') < getBlock.indexOf('await readStoredImage('));
check('索引里没有 → 404 not_found', getBlock.includes("reason: 'not_found', error: '找不到这张图（可能已被索引清理）' }, 404)"));
check('索引有但文件丢了 → 404（两种 not_found 分开报）', getBlock.includes("reason: 'not_found', error: '索引里有这张图，但文件已经不在了' }, 404)"));
check('回 base64 JSON：mimeType', getBlock.includes('mimeType: stored.mime'));
check('回 base64 JSON：data', getBlock.includes("data: stored.buffer.toString('base64')"));
check('回包里带上索引条目并补 meta 里的宽高', getBlock.includes('image: { ...entry, width: Number(meta.width) || null, height: Number(meta.height) || null }'));
check('取图端点不直接回裸字节（不回 image/* 的 Content-Type）', !getBlock.includes("'content-type': stored.mime"));
check('id 正则要求 uuid 形状', bridge.includes('const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;'));

const idReSrc = (bridge.match(/const IMAGE_ID_RE = (\/\^\[0-9a-f\]\{8\}[\s\S]*?\/i);/) ?? [])[1];
const idRe = idReSrc ? (() => { try { return new Function(`return ${idReSrc};`)(); } catch { return null; } })() : null;
check('IMAGE_ID_RE 能取出来真跑', idRe instanceof RegExp);
if (idRe instanceof RegExp) {
  check('IMAGE_ID_RE 接受 randomUUID 形状', idRe.test('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'));
  check('IMAGE_ID_RE 拒绝路径穿越', !idRe.test('../../etc/passwd') && !idRe.test('..%2F..%2Fetc%2Fpasswd'));
  check('IMAGE_ID_RE 拒绝空串与短串', !idRe.test('') && !idRe.test('abc'));
}

// ── 五 发图 ─────────────────────────────────────────────────────────────────
console.log('\n五 POST /api/send/image');

const sendBlock = sliceBetween(bridge, routeSend, routeSticker);
check('发图切片非空', sendBlock.length > 500, sendBlock.length);
check('key 形状闸门 /^(group|private):\\d{1,20}$/', sendBlock.includes('/^(group|private):\\d{1,20}$/'));
check('400 bad_key', sendBlock.includes("reason: 'bad_key', error: 'key 必须形如 group:群号 或 private:QQ号' }, 400)"));
check('400 bad_image（imageId 不是 uuid）', sendBlock.includes("reason: 'bad_image', error: 'imageId 不是合法的 uuid' }, 400)"));
check('鉴权带 key（agent token 要归属于这个会话）', sendBlock.includes('if (imageAuthFailed(req, key)) return;'));
check('静默模式拦截（图也是东西）', sendBlock.includes('if (shouldBlockSilentReply(key))'));
check('先建守卫再读图', sendBlock.indexOf('captureSendGuard(key)') < sendBlock.indexOf('await readStoredImage('));
check('守卫先试跑一次（不能等到 sleep 完才发现被切走）', sendBlock.includes('assertSendAllowed();'));
check('交给 sendImageV2 并复用同一个守卫', sendBlock.includes('await sendImageV2(key, stored.buffer, { assertSendAllowed })'));
check('400 too_large（超过 IMAGE_MAX_BYTES）', sendBlock.includes("reason: 'too_large'") && sendBlock.includes('stored.buffer.length > IMAGE_MAX_BYTES'));
check('发送频率闸门：st.sendTimes.push(now)', sendBlock.includes('st.sendTimes.push(now);'));
check('失败回滚发送名额', sendBlock.includes('st.sendTimes.splice(at, 1);'));
check('失败回 502 并带上原因', sendBlock.includes("reason: 'send_failed'"));
check('成功回 messageId', sendBlock.includes('messageId: sent.messageId'));
check('recentMessages 里只留一句「[图片]」（并带回话出处）', sendBlock.includes("recordSentMessagesV2(key, ['[图片]'], crossSendSourceV2(key, req));"));
check('成功后排一次回复检查', sendBlock.includes('scheduleReplyCheckV2(key);'));
check('日志 [images] 已发送', sendBlock.includes('[images] 已发送 ${imageId}'));

const sendImageSrc = extractFunction(bridge, 'async function sendImageV2(');
check('sendImageV2 存在', sendImageSrc.length > 300, sendImageSrc.length);
check('sendImageV2 串进 sendChain', sendImageSrc.includes('sendChain = sendChain.then(async () => {'));
check('sendImageV2 在链内 sleep(randInt(800, 2000))', sendImageSrc.includes('await sleep(randInt(800, 2000));'));
check('sendImageV2 在链内（入队之后）才 assertSendAllowed()', sendImageSrc.includes('assertSendAllowed();') && sendImageSrc.indexOf('sendChain = sendChain.then') < sendImageSrc.indexOf('assertSendAllowed();'));
check('sendImageV2 带 authorization（cfg.snowluma.accessToken）', sendImageSrc.includes('authorization: `Bearer ${cfg.snowluma.accessToken}`'));
check('sendImageV2 用 image 段 + base64://, 不给网关本地路径', sendImageSrc.includes("{ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } }"));
check('sendImageV2 按 kind 选 send_group_msg / send_private_msg', sendImageSrc.includes("const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';"));
check('sendImageV2 校验 status/retcode', sendImageSrc.includes("body.status !== 'ok' || body.retcode !== 0"));
check('sendImageV2 回 messageId', sendImageSrc.includes('return { messageId: data?.message_id ?? null };'));

// ── 六 存表情 ───────────────────────────────────────────────────────────────
console.log('\n六 POST /api/socialV2/images/sticker');

const stickerBlock = sliceBetween(bridge, routeSticker, routeAvatar);
check('表情切片非空', stickerBlock.length > 400, stickerBlock.length);
check('额度 sticker 在 add_custom_face 之前判', stickerBlock.indexOf("readImageUsageFor('sticker', now)") < stickerBlock.indexOf("profileOneBot('add_custom_face'"));
check('add_custom_face 走 base64://', stickerBlock.includes("profileOneBot('add_custom_face', { file: 'base64://' + stored.buffer.toString('base64') })"));
check('成功后 modify_custom_face 写备注', stickerBlock.includes("profileOneBot('modify_custom_face', { emoji_id: emojiId, desc })"));
check('备注失败只 log（不影响收藏成功）', stickerBlock.includes('[images] 表情备注失败'));
check('没拿到 emoji_id 就抛（不记一笔空账）', stickerBlock.includes("if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');"));
check('desc 截到 12 字', stickerBlock.includes("String(body.desc ?? '').trim().slice(0, 12)"));
check('回 emojiId', stickerBlock.includes('sendJson({ ok: true, emojiId'));
check('429 文案由 imageQuotaRejected 统一给', stickerBlock.includes("imageQuotaRejected('sticker', quota)"));

// ── 七 换头像 ───────────────────────────────────────────────────────────────
console.log('\n七 POST /api/socialV2/profile/avatar');

const avatarBlock = sliceBetween(bridge, routeAvatar, '// ── 跨会话互通（T-016）');
check('头像切片非空', avatarBlock.length > 800, avatarBlock.length);
check('支持 imageId 与 url 两种来源', avatarBlock.includes('const imageId = String(body.imageId') && avatarBlock.includes('const rawUrl = String(body.url'));
check('都没给 → 400 bad_image 并说明二选一', avatarBlock.includes("reason: 'bad_image', error: '要么给 imageId（本地生成过的图），要么给 url（白名单域名）' }, 400)"));
check('url 走 isAllowedImageSource 白名单', avatarBlock.includes('!isAllowedImageSource(rawUrl)'));
check('400 bad_url 且把白名单列出来', avatarBlock.includes("reason: 'bad_url'") && avatarBlock.includes('IMAGE_SOURCE_HOSTS.join('));
check('url 下载走 safeFetchBuffer 并限 IMAGE_AVATAR_MAX_BYTES', avatarBlock.includes('await safeFetchBuffer(rawUrl, IMAGE_AVATAR_MAX_BYTES)'));
check('400 too_large（头像 2MB 上限单独算）', avatarBlock.includes('buffer.length > IMAGE_AVATAR_MAX_BYTES'));
check('set_qq_avatar 走 base64://', avatarBlock.includes("profileOneBot('set_qq_avatar', { file: 'base64://' + buffer.toString('base64') })"));
check('回 {ok:true,bytes}', avatarBlock.includes('sendJson({ ok: true, bytes: buffer.length, mimeType: mime || null })'));
check('头像没有读回，不写 verified', !avatarBlock.includes('verified'));
check('日志 [images] 头像已更新', avatarBlock.includes('[images] 头像已更新'));
check('不通知 owner（头像变化是 AI 自己的事）', !avatarBlock.includes('sendToQQ(') && !avatarBlock.includes('notifyOwner'));
check('429 由 imageQuotaRejected 统一给', avatarBlock.includes("imageQuotaRejected('avatar', quota)"));

// ── 八 prompt payload / 常量 / 状态 / 配置归一 ───────────────────────────────
console.log('\n八 prompt payload / 常量 / 状态 / 配置');

const payload = sliceBetween(bridge, 'images: (() => {', 'cross: (() => {');
check('prompt 里有 images 块', payload.length > 200, payload.length);
check('images 块在 profile 之后、cross 之前', lineOf(bridge, 'images: (() => {') > lineOf(bridge, 'profile: (() => {') && lineOf(bridge, 'images: (() => {') < lineOf(bridge, 'cross: (() => {'));
check('enabled:false 时短路（关掉就别去读账本）', payload.includes('if (!imagesEnabled) return { enabled: false };'));
check('tools 按生图开关分两档（停生图时摘掉 qq_draw_image）', payload.includes("tools: (canDraw") && payload.includes("? ['qq_draw_image', 'qq_send_image', 'qq_save_sticker', 'qq_set_avatar']") && payload.includes(": ['qq_send_image', 'qq_save_sticker', 'qq_set_avatar']),"));
check('payload 带 generateEnabled 字段', payload.includes('generateEnabled: canDraw,'));
check('quota 三档剩余额度现算', payload.includes("quota: { drawLeft: left('generate'), stickerLeft: left('sticker'), avatarLeft: left('avatar') },"));
check('hint 按生图开关分两句（停了就明确说别调、用现成图片）', payload.includes("hint: canDraw") && payload.includes('生图渠道暂时停了'));
check('剩余额度用 imageQuota 现算（不缓存）', payload.includes('readImageUsageFor(kind, now, usage)'));

check('imageToolFlags 覆盖四个新工具', bridge.includes("const imageToolFlags = new Set(['drawImage', 'sendImage', 'saveSticker', 'setAvatar']);"));
check('enabledTools 会因 images 关闭而摘掉四个工具', bridge.includes('!(imageToolFlags.has(flag) && (!imagesEnabled'));
check('只停生图时 enabledTools 单独摘掉 drawImage', bridge.includes("(flag === 'drawImage' && !drawEnabled)"));
check('toolMap 登记了四个 flag', bridge.includes("drawImage: 'qq_draw_image'") && bridge.includes("sendImage: 'qq_send_image'") && bridge.includes("saveSticker: 'qq_save_sticker'") && bridge.includes("setAvatar: 'qq_set_avatar'"));

check("常量 IMAGE_DIR = state/images", bridge.includes("const IMAGE_DIR = path.join(STATE_DIR, 'images');"));
check("常量 IMAGE_INDEX_FILE = state/image-index.json", bridge.includes("const IMAGE_INDEX_FILE = path.join(STATE_DIR, 'image-index.json');"));
check("常量 IMAGE_USAGE_FILE = state/image-usage.json", bridge.includes("const IMAGE_USAGE_FILE = path.join(STATE_DIR, 'image-usage.json');"));
check('常量 IMAGE_MAX_BYTES = 8MB', bridge.includes('const IMAGE_MAX_BYTES = 8 * 1024 * 1024;'));
check('常量 IMAGE_AVATAR_MAX_BYTES = 2MB', bridge.includes('const IMAGE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;'));
check('常量 IMAGE_INDEX_MAX = 200', bridge.includes('const IMAGE_INDEX_MAX = 200;'));

check('配置归一只有一处（cfg.socialV2.images）', (bridge.match(/cfg\.socialV2\.images =/g) ?? []).length === 1
  && (bridge.match(/normalizeImageConfig\(/g) ?? []).length === 2
  && bridge.includes('cfg.socialV2.images = normalizeImageConfig(cfg.socialV2?.images);'));
const imageCoreImport = sliceBetween(bridge, 'import {\n  IMAGE_SOURCE_HOSTS,', "from './image-core.js';");
check('image-core 的 import 齐全（含 IMAGE_SOURCE_HOSTS）', ['cleanImagePrompt', 'checkImagePrompt', 'normalizeSize', 'imageQuota', 'recordImageUsage', 'serializeImageUsage', 'parseImageUsage', 'isAllowedImageSource', 'normalizeImageConfig'].every((name) => imageCoreImport.includes(name)), imageCoreImport.slice(0, 120));
const imageGenImport = sliceBetween(bridge, '// 落盘与索引维护全在 image-gen.js', "from './image-gen.js';");
check('image-gen 的 import 齐全（含索引读写）', ['saveGeneratedImage', 'readStoredImage', 'readIndex', 'saveIndexEntry'].every((name) => imageGenImport.includes(name)));

check('readImageUsage() 用 parseImageUsage 兜底坏文件', bridge.includes('return parseImageUsage(readJsonSafe(IMAGE_USAGE_FILE, null));'));
check('writeImageUsage() 走 serialize → parse → atomicWriteJson', bridge.includes('atomicWriteJson(IMAGE_USAGE_FILE, parseImageUsage(serializeImageUsage(usage)));'));
check('readImageIndex() 复用 image-gen 的 readIndex', bridge.includes('async function readImageIndex()') && bridge.includes('return readIndex(IMAGE_INDEX_FILE);'));
check('writeImageIndex(entry) 复用 saveIndexEntry 并带上限', bridge.includes('async function writeImageIndex(entry)') && bridge.includes('return saveIndexEntry(IMAGE_INDEX_FILE, entry, IMAGE_INDEX_MAX);'));
check('索引写失败不让端点 500（saveIndexEntry 内部吞错）', !extractFunction(bridge, 'async function writeImageIndex(').includes('catch'));
check(
  'readImageUsageFor 只是把参数转给 imageQuota（判定留在 image-core）',
  extractFunction(bridge, 'function readImageUsageFor(').includes('return imageQuota(usage, imageConfig(), kind, now);')
);

// ── 汇总 ────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log(`\n结果：${passed}/${total} passed`);
if (failures.length > 0) {
  console.log('\n失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
