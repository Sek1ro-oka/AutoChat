// 生图纯函数层（src/image-core.js）的单测。
//
// 跑法：`node scripts/test-image-core.mjs`（全过 exit 0，有失败 exit 1）。
//
// 覆盖 dev-doc §三 的十一个函数：
//   ① 配置归一：缺省 / 钳制 / 脏值 / 数字字符串 / 冻结 / 不改入参
//   ② cleanImagePrompt：trim / 折行 / 控制字符 / 全角空格 / 码点截断 / emoji
//   ③ checkImagePrompt 长度：空 / 太短 / 3 边界 / promptMaxChars 边界 / 自定义上限
//   ④ checkImagePrompt 审计：URL / 裸域名 / 手机 / 邮箱 / 身份证 / 拉人
//   ⑤ 黑名单与真人照片意图：命中词、日常词不误伤、四种真人意图
//   ⑥ normalizeSize：缺省 / 0 / 负数 / 超上限 / 保比例 / 最小 256 / 面积上限
//   ⑦ buildPollinationsUrl：中文 / 空格 / & / 斜杠 / seed / safe / nologo / 兜底尺寸
//   ⑧ parseImageResult：200 四种图片 / 402 Retry-After / 4xx·5xx / 非图片 / 201
//   ⑨ imageQuota：空 / 第 2 次 too_frequent / 窗口边界 / 未来时间戳 / cap / disabled / 未知 kind
//   ⑩ 用量状态：record 不改入参 / 坏输入 / 500 条裁剪 / 序列化往返 / 坏 JSON
//   ⑪ isAllowedImageSource：https / 白名单精确匹配 / 子域名与后缀伪造 / 端口 / 凭据
//
// 时间全部是假时钟：`NOW = Date.UTC(2026, 9, 20, 2)`，窗口边界用例因此不依赖运行机器时区；
// 不读系统时钟、不碰 state/、不连网络。断言用 node:assert/strict，逐条打印 pass/fail。
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  IMAGE_DEFAULTS,
  IMAGE_LIMITS,
  IMAGE_SOURCE_HOSTS,
  IMAGE_BANNED_TERMS,
  IMAGE_KINDS,
  normalizeImageConfig,
  cleanImagePrompt,
  checkImagePrompt,
  normalizeSize,
  buildPollinationsUrl,
  parseImageResult,
  imageQuota,
  recordImageUsage,
  serializeImageUsage,
  parseImageUsage,
  isAllowedImageSource,
} from '../src/image-core.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 2, 0, 0);

let passed = 0;
let failed = 0;

function eq(actual, expected, name) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`✅ ${name}`);
  } catch {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   actual:   ${inspect(actual, { depth: 4 })}`);
    console.error(`   expected: ${inspect(expected, { depth: 4 })}`);
  }
}

function truthy(value, name) {
  try {
    assert.ok(value);
    passed += 1;
    console.log(`✅ ${name}`);
  } catch {
    failed += 1;
    console.error(`❌ ${name}`);
  }
}

function usageOf(entries) {
  return { version: 1, entries };
}

function entry(kind, ts, imageId) {
  const out = { kind, ts };
  if (imageId !== undefined) out.imageId = imageId;
  return out;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = Buffer.from('GIF89a______________');
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

// ── ① 配置归一 ──────────────────────────────────────────────────────────────
console.log('\n① normalizeImageConfig');

const dflt = normalizeImageConfig({});
eq(dflt.enabled, true, 'enabled 出厂开');
eq(dflt.provider, 'pollinations', 'provider 出厂 pollinations');
eq([dflt.maxWidth, dflt.maxHeight], [768, 768], 'maxWidth/maxHeight 768×768');
eq(dflt.promptMaxChars, 300, 'promptMaxChars 300');
eq(dflt.safe, true, 'safe 出厂 true');
eq(dflt.generate, { windowHours: 24, windowCap: 20, minGapMs: 45000 }, 'generate 24h/20 次/45 秒');
eq(dflt.sticker, { windowHours: 24, windowCap: 5, minGapMs: 5000 }, 'sticker 24h/5 次/5 秒');
eq(dflt.avatar, { windowHours: 24, windowCap: 1, minGapMs: 6 * HOUR }, 'avatar 24h/1 次/6 小时');
eq(normalizeImageConfig(null), dflt, 'null 输入 = 全默认');
eq(normalizeImageConfig(undefined), dflt, 'undefined 输入 = 全默认');
eq(normalizeImageConfig('x'), dflt, '字符串输入 = 全默认');
eq(normalizeImageConfig([]), dflt, '数组输入 = 全默认');
eq(normalizeImageConfig(42), dflt, '数字输入 = 全默认');
eq(normalizeImageConfig({ generate: { windowHours: 48 } }).generate,
  { windowHours: 48, windowCap: 20, minGapMs: 45000 }, '缺段补默认（只写 windowHours 也不丢其余字段）');
eq(normalizeImageConfig({ maxWidth: '512', generate: { windowCap: '7' } }).maxWidth, 512,
  '数字字符串 maxWidth 被接受');
eq(normalizeImageConfig({ generate: { windowCap: '7' } }).generate.windowCap, 7,
  '数字字符串 windowCap 被接受');
eq(normalizeImageConfig({ generate: { windowHours: 0 } }).generate.windowHours, 1,
  'windowHours 0 钳到 1');
eq(normalizeImageConfig({ generate: { windowHours: 999 } }).generate.windowHours, 168,
  'windowHours 999 钳到 168');
eq(normalizeImageConfig({ generate: { windowCap: 0 } }).generate.windowCap, 1,
  'windowCap 0 钳到 1');
eq(normalizeImageConfig({ generate: { windowCap: 999 } }).generate.windowCap, 100,
  'windowCap 999 钳到 100');
eq(normalizeImageConfig({ generate: { minGapMs: -5 } }).generate.minGapMs, 0,
  'minGapMs -5 钳到 0');
eq(normalizeImageConfig({ generate: { minGapMs: 1e12 } }).generate.minGapMs, DAY,
  'minGapMs 1e12 钳到 86400000');
eq(normalizeImageConfig({ maxWidth: 0 }).maxWidth, 256, 'maxWidth 0 钳到 256');
eq(normalizeImageConfig({ maxWidth: 5000 }).maxWidth, 1024, 'maxWidth 5000 钳到 1024');
eq(normalizeImageConfig({ maxHeight: 100 }).maxHeight, 256, 'maxHeight 100 钳到 256');
eq(normalizeImageConfig({ promptMaxChars: 0 }).promptMaxChars, 10, 'promptMaxChars 0 钳到 10');
eq(normalizeImageConfig({ promptMaxChars: 5000 }).promptMaxChars, 1000, 'promptMaxChars 5000 钳到 1000');
eq(normalizeImageConfig({ promptMaxChars: 'x' }).promptMaxChars, 300, "promptMaxChars 'x' 回落 300");
eq(normalizeImageConfig({ enabled: false }).enabled, false, 'enabled 只认显式 false');
eq(normalizeImageConfig({ enabled: 'false' }).enabled, true, "enabled 'false' 仍算开");
eq(normalizeImageConfig({ enabled: 0 }).enabled, true, 'enabled 0 仍算开');
eq(normalizeImageConfig({ safe: false }).safe, false, 'safe:false 被保留');
eq(normalizeImageConfig({ safe: 'false' }).safe, true, "safe 'false' 仍算安全（只认显式 false）");
eq(normalizeImageConfig({ provider: 'openai' }).provider, 'pollinations', '未知 provider 回落 pollinations');
truthy(Object.isFrozen(dflt), '配置对象冻结');
truthy(Object.isFrozen(dflt.generate), '窗口子对象冻结');
const rawConfig = { maxWidth: 9999, promptMaxChars: 1, generate: { windowCap: 999 } };
const rawSnapshot = JSON.stringify(rawConfig);
normalizeImageConfig(rawConfig);
eq(JSON.stringify(rawConfig), rawSnapshot, '归一化不改入参');
eq(IMAGE_LIMITS.maxArea, 768 * 768, 'IMAGE_LIMITS.maxArea = 768×768');
eq(IMAGE_KINDS, ['generate', 'sticker', 'avatar'], 'IMAGE_KINDS 三档');

// ── ② cleanImagePrompt ──────────────────────────────────────────────────────
console.log('\n② cleanImagePrompt');

eq(cleanImagePrompt('  一只猫  '), '一只猫', 'trim 首尾空白');
eq(cleanImagePrompt('一只\n猫'), '一只 猫', '换行折成空格');
eq(cleanImagePrompt('a\r\nb'), 'a b', 'CRLF 折成单个空格');
eq(cleanImagePrompt('a\t\tb'), 'a b', '连续制表符压成一个空格');
eq(cleanImagePrompt('a\u0001b'), 'ab', '控制字符直接删除');
eq(cleanImagePrompt('a  b'), 'a b', '连续空格压成一个');
eq(cleanImagePrompt('a\u3000b'), 'a b', '全角空格折成半角空格');
eq(cleanImagePrompt(''), '', '空串');
eq(cleanImagePrompt('   '), '', '纯空白 = 空串');
eq(cleanImagePrompt(null), '', 'null 不抛，返回空串');
eq(cleanImagePrompt(undefined), '', 'undefined 不抛，返回空串');
eq(cleanImagePrompt(42), '', '数字不抛，返回空串');
eq(cleanImagePrompt({ text: '猫' }), '', '对象不抛，返回空串');
eq(cleanImagePrompt('猫'.repeat(320)), '猫'.repeat(300), '按码点截到 300');
eq(Array.from(cleanImagePrompt('🐱'.repeat(320))).length, 300, 'emoji 按码点截到 300（不是 UTF-16）');
eq(cleanImagePrompt('🐱'.repeat(3)), '🐱'.repeat(3), 'emoji 三个码点原样保留');
eq(cleanImagePrompt('a'.repeat(20), 10), 'a'.repeat(10), '自定义 maxChars 生效');
eq(cleanImagePrompt('a'.repeat(20), 'x'), 'a'.repeat(20), '非法 maxChars 回落 300');

// ── ③ checkImagePrompt：长度 ────────────────────────────────────────────────
console.log('\n③ checkImagePrompt 长度');

eq(checkImagePrompt('', {}).reason, 'too_short', '空串 → too_short');
eq(checkImagePrompt('ab', {}).reason, 'too_short', '2 码点 → too_short');
eq(checkImagePrompt('abc', {}).ok, true, '3 码点边界放行');
eq(checkImagePrompt('  abc  ', {}).ok, true, '首尾空白 trim 后计长度');
eq(checkImagePrompt('画'.repeat(300), {}).ok, true, '300 码点边界放行');
eq(checkImagePrompt('画'.repeat(301), {}).reason, 'too_long', '301 码点 → too_long');
eq(checkImagePrompt('画'.repeat(10), { promptMaxChars: 10 }).ok, true, '自定义上限 10 的边界放行');
eq(checkImagePrompt('画'.repeat(11), { promptMaxChars: 10 }).reason, 'too_long',
  '自定义上限 10 时 11 码点 → too_long');
eq(checkImagePrompt('画'.repeat(150), { promptMaxChars: 9999 }).ok, true,
  'promptMaxChars 9999 被钳到 1000，150 字仍放行');
eq(checkImagePrompt('', {}).hits, [], 'too_short 不带命中');
eq(checkImagePrompt(null, {}).reason, 'too_short', 'null 当空串处理');

// ── ④ checkImagePrompt：auditContent ────────────────────────────────────────
console.log('\n④ checkImagePrompt 审计');

const urlPrompt = checkImagePrompt('https://example.com 画一只猫', {});
eq(urlPrompt.reason, 'audit', 'URL → audit');
eq(urlPrompt.hits[0].rule, 'url', 'URL 命中的 rule 是 url');
const bareDomain = checkImagePrompt('www.qq.com 画一只猫', {});
eq(bareDomain.reason, 'audit', '裸域名 → audit');
eq(bareDomain.hits[0].rule, 'url', '裸域名命中的 rule 是 url');
eq(checkImagePrompt('13800138000 画一只猫', {}).hits[0].rule, 'phone', '手机号 → phone');
truthy(checkImagePrompt('a@b.com 画一只猫', {}).hits.some((hit) => hit.rule === 'email'),
  '邮箱 → email（可能同时命中裸域名）');
eq(checkImagePrompt('110101199003071234 画一只猫', {}).hits[0].rule, 'idcard', '身份证号 → idcard');
eq(checkImagePrompt('扫码加群画画', {}).hits[0].rule, 'solicit', '扫码/加群 → solicit');
eq(checkImagePrompt('私聊我画画', {}).hits[0].rule, 'solicit', '私聊我 → solicit');
eq(checkImagePrompt('画一只猫', {}).ok, true, '普通提示词放行');

// ── ⑤ 黑名单与真人照片意图 ──────────────────────────────────────────────────
console.log('\n⑤ 黑名单 / 真人照片意图');

const bannedPorn = checkImagePrompt('画一张色情的图', {});
eq(bannedPorn.reason, 'banned_term', '中文色情词 → banned_term');
truthy(bannedPorn.hits.includes('色情'), 'hits 带命中的词');
const bannedNude = checkImagePrompt('a beautiful nude woman', {});
eq(bannedNude.reason, 'banned_term', '英文 nude → banned_term');
truthy(bannedNude.hits.includes('nude'), '英文 hits 带 nude');
truthy(checkImagePrompt('pornographic scene', {}).hits.includes('pornographic'), 'pornographic 命中');
eq(checkImagePrompt('斩首现场', {}).reason, 'banned_term', '斩首 → banned_term');
const bomb = checkImagePrompt('制作炸弹教程', {});
eq(bomb.reason, 'banned_term', '炸弹教程 → banned_term');
truthy(bomb.hits.includes('制作炸弹') && bomb.hits.includes('炸弹教程'), '同一句可命中多个词');
eq(checkImagePrompt('两个小孩在打架', {}).ok, true, '「打架」这类日常词不误伤');
eq(checkImagePrompt('血红色的晚霞', {}).ok, true, '「血」不在黑名单里');
eq(checkImagePrompt('画真实人物', {}).reason, 'real_person', '真实人物 → real_person');
eq(checkImagePrompt('真人照', {}).reason, 'real_person', '真人照 → real_person');
eq(checkImagePrompt('身份证照', {}).reason, 'real_person', '身份证照 → real_person');
eq(checkImagePrompt('画真实照片', {}).reason, 'real_person', '真实照片 → real_person');
eq(checkImagePrompt('画一张裸照', {}).reason, 'real_person', '裸照 → real_person');
eq(checkImagePrompt('真实的猫', {}).ok, true, '「真实的猫」不误判成真人照');
truthy(IMAGE_BANNED_TERMS.every((term) => typeof term === 'string' && term.length > 0),
  'IMAGE_BANNED_TERMS 全是非空字符串');

// ── ⑥ normalizeSize ────────────────────────────────────────────────────────
console.log('\n⑥ normalizeSize');

eq(normalizeSize(undefined, undefined), { width: 768, height: 768 }, '缺省 → 768×768');
eq(normalizeSize(0, 0), { width: 256, height: 256 }, '0 → 最小边 256');
eq(normalizeSize(-100, -50), { width: 256, height: 256 }, '负数 → 最小边 256');
eq(normalizeSize(5000, 5000), { width: 768, height: 768 }, '超上限 → 削到 768×768');
eq(normalizeSize('800', '600'), { width: 768, height: 600 }, '数字字符串 + 单边超上限');
eq(normalizeSize(Number.NaN, 300), { width: 768, height: 300 }, 'NaN 那边回落默认');
eq(normalizeSize(300, 100), { width: 300, height: 256 }, '低于最小边的一边抬到 256');
eq(normalizeSize(256, 256), { width: 256, height: 256 }, '正好最小边不变');
eq(normalizeSize(800, 400, { maxWidth: 512, maxHeight: 512 }),
  { width: 512, height: 400 }, '自定义 maxWidth 生效');
eq(normalizeSize(1024, 512, { maxWidth: 1024, maxHeight: 1024 }),
  { width: 1024, height: 512 }, '单边 1024、面积未超限时保留');
eq(normalizeSize(1024, 1024, { maxWidth: 1024, maxHeight: 1024 }),
  { width: 768, height: 768 }, '1024×1024 等比缩回 768×768');
eq(normalizeSize(1000, 1000, { maxWidth: 1024, maxHeight: 1024 }),
  { width: 768, height: 768 }, '1000×1000 等比缩回 768×768');
eq(normalizeSize(900, 450, { maxWidth: 1024, maxHeight: 1024 }),
  { width: 900, height: 450 }, '面积未超限时保比例');
const nonSquare = normalizeSize(1024, 768, { maxWidth: 1024, maxHeight: 1024 });
truthy(nonSquare.width * nonSquare.height <= IMAGE_LIMITS.maxArea, '缩放后面积 ≤ 768×768');
truthy(Math.abs(nonSquare.width / nonSquare.height - 4 / 3) < 0.01, '缩放后仍近似 4:3');
eq(normalizeSize(256, 1024, { maxWidth: 1024, maxHeight: 1024 }),
  { width: 256, height: 1024 }, '256×1024 面积合法，不缩放');
eq(normalizeSize('600', 'oops'), { width: 600, height: 768 }, '脏高度回落默认');
eq(normalizeSize(512, 512, {}).width, 512, '默认配置下的常规尺寸原样保留');

// ── ⑦ buildPollinationsUrl ─────────────────────────────────────────────────
console.log('\n⑦ buildPollinationsUrl');

const baseUrl = buildPollinationsUrl({ prompt: '一只猫' });
truthy(baseUrl.startsWith('https://image.pollinations.ai/prompt/'), 'URL 前缀正确');
const parsedBase = new URL(baseUrl);
eq(parsedBase.hostname, 'image.pollinations.ai', 'hostname 正确');
eq(parsedBase.pathname, '/prompt/%E4%B8%80%E5%8F%AA%E7%8C%AB', '中文按 UTF-8 百分号编码');
eq(new URL(buildPollinationsUrl({ prompt: 'a cat' })).pathname, '/prompt/a%20cat', '空格编码成 %20');
eq(new URL(buildPollinationsUrl({ prompt: 'a&b=c' })).pathname, '/prompt/a%26b%3Dc',
  '& 与 = 都被编码（不会被当成查询参数截断）');
eq(new URL(buildPollinationsUrl({ prompt: 'a/b' })).pathname, '/prompt/a%2Fb', '斜杠被编码，不会多一层路径');
eq(parsedBase.searchParams.get('width'), '768', '默认 width=768');
eq(parsedBase.searchParams.get('height'), '768', '默认 height=768');
eq(parsedBase.searchParams.get('nologo'), 'true', '默认 nologo=true');
eq(parsedBase.searchParams.get('safe'), 'true', '默认 safe=true');
eq(parsedBase.searchParams.has('seed'), false, '缺省不带 seed（每次随机）');
eq(new URL(buildPollinationsUrl({ prompt: '猫', seed: 42 })).searchParams.get('seed'), '42',
  'seed 数字被带上');
eq(new URL(buildPollinationsUrl({ prompt: '猫', seed: '7' })).searchParams.get('seed'), '7',
  'seed 数字字符串被带上');
eq(new URL(buildPollinationsUrl({ prompt: '猫', seed: 0 })).searchParams.get('seed'), '0',
  'seed 0 是有效值（不被 falsy 吞掉）');
eq(new URL(buildPollinationsUrl({ prompt: '猫', safe: false })).searchParams.get('safe'), 'false',
  'safe:false 透传');
eq(new URL(buildPollinationsUrl({ prompt: '猫', nologo: false })).searchParams.get('nologo'), 'false',
  'nologo:false 透传');
const sized = new URL(buildPollinationsUrl({ prompt: '猫', width: 512, height: 384 }));
eq([sized.searchParams.get('width'), sized.searchParams.get('height')], ['512', '384'],
  '显式尺寸写入查询参数');
eq(new URL(buildPollinationsUrl({ prompt: '猫', width: 0 })).searchParams.get('width'), '768',
  'width 0 兜底成 768');
eq(new URL(buildPollinationsUrl({ prompt: '猫', width: 5000 })).searchParams.get('width'), '1024',
  'width 5000 兜底夹到 1024');
eq(new URL(buildPollinationsUrl({ prompt: '猫', width: 100 })).searchParams.get('width'), '256',
  'width 100 兜底夹到 256');
eq(new URL(buildPollinationsUrl({ prompt: null })).pathname, '/prompt/', 'null 提示词拼出合法 URL');
eq(new URL(buildPollinationsUrl(null)).pathname, '/prompt/', 'null 选项不抛，拼出默认 URL');
eq(Array.from(decodeURIComponent(new URL(buildPollinationsUrl({ prompt: '猫'.repeat(400) })).pathname.slice(8))).length,
  300, '超长提示词在 URL 层被截到 300 码点');

// ── ⑧ parseImageResult ─────────────────────────────────────────────────────
console.log('\n⑧ parseImageResult');

const jpegResult = parseImageResult({ status: 200, buffer: JPEG });
eq(jpegResult.ok, true, '200 + JPEG → ok');
eq(jpegResult.mime, 'image/jpeg', 'JPEG mime');
eq(jpegResult.bytes, JPEG.length, 'bytes 是实际长度');
eq(parseImageResult({ status: 200, buffer: PNG }).mime, 'image/png', 'PNG 嗅探');
eq(parseImageResult({ status: 200, buffer: GIF }).mime, 'image/gif', 'GIF 嗅探');
eq(parseImageResult({ status: 200, buffer: WEBP }).mime, 'image/webp', 'WebP 嗅探');
eq(parseImageResult({ status: 200, buffer: Buffer.from('not an image') }).reason, 'bad_content',
  '200 非图片 → bad_content');
eq(parseImageResult({ status: 200, buffer: Buffer.alloc(0) }).reason, 'bad_content', '200 空 buffer → bad_content');
const limited = parseImageResult({ status: 402, retryAfter: '30', buffer: Buffer.alloc(0) });
eq(limited.reason, 'rate_limited', '402 → rate_limited');
eq(limited.retryAfterMs, 30000, 'Retry-After 秒数字符串 → 毫秒');
eq(limited.status, 402, '402 结果带 status');
eq(parseImageResult({ status: 402, retryAfter: 12.5 }).retryAfterMs, 12500, 'Retry-After 数字也接受');
eq(parseImageResult({ status: 402 }).retryAfterMs, 45000, '缺 Retry-After → 45000');
eq(parseImageResult({ status: 402, retryAfter: 'abc' }).retryAfterMs, 45000, '坏 Retry-After → 45000');
eq(parseImageResult({ status: 402, retryAfter: '0' }).retryAfterMs, 45000, 'Retry-After 0 → 45000');
eq(parseImageResult({ status: 402, retryAfter: '-5' }).retryAfterMs, 45000, '负 Retry-After → 45000');

// Pollinations 真实 402：没有 Retry-After 头，秒数在 JSON body 的 error.message 里。
const upstream402 = Buffer.from(JSON.stringify({
  status: 402,
  success: false,
  error: {
    code: 'FREE_LIMIT',
    message: 'Free limit reached: 1 image every 45 seconds per IP. Retry after 18s, '
      + 'or get unlimited images with a pollen key ...',
  },
}));
eq(parseImageResult({ status: 402, buffer: upstream402 }).retryAfterMs, 18000,
  '402 JSON body 的 “Retry after 18s” 被采纳（无 Retry-After 头）');
eq(parseImageResult({ status: 402, retryAfter: '30', buffer: upstream402 }).retryAfterMs, 18000,
  'body 的真实秒数优先于 Retry-After 头');
eq(parseImageResult({
  status: 402,
  retryAfter: '12',
  buffer: Buffer.from(JSON.stringify({ status: 402, error: { message: 'slow down' } })),
}).retryAfterMs, 12000, 'body 没有 retry 字段 → 退回 Retry-After 头');
eq(parseImageResult({
  status: 402,
  buffer: Buffer.from(JSON.stringify({ status: 402, error: { message: 'slow down' } })),
}).retryAfterMs, 45000, 'body 没有 retry 字段且无头 → 45000');
eq(parseImageResult({
  status: 402,
  buffer: Buffer.from(JSON.stringify({ error: { message: 'Retry after 0s' } })),
}).retryAfterMs, 1000, 'body 秒数 0 → 钳到 1000ms');
eq(parseImageResult({
  status: 402,
  buffer: Buffer.from(JSON.stringify({ error: { message: 'Retry after 999999s' } })),
}).retryAfterMs, 86400000, 'body 秒数超大 → 钳到 24h');
eq(parseImageResult({
  status: 402,
  buffer: Buffer.from('Retry after 9s，但这不是 JSON'),
}).retryAfterMs, 45000, '非 JSON body 不猜 → 45000');
eq(parseImageResult({
  status: 402,
  buffer: Buffer.from(JSON.stringify({ note: 'Retry after 7s' })),
}).retryAfterMs, 7000, 'error.message 缺失时从整个 body 文本抽秒数');
eq(parseImageResult({ status: 500, buffer: Buffer.alloc(0) }).reason, 'upstream_error', '500 → upstream_error');
eq(parseImageResult({ status: 500 }).status, 500, '500 结果带 status');
eq(parseImageResult({ status: 404 }).status, 404, '404 结果带 status');
eq(parseImageResult({ status: 201, buffer: JPEG }).reason, 'upstream_error',
  '201 不是 200 → upstream_error（严格只认 200）');
eq(parseImageResult({ buffer: JPEG }).status, 0, '缺 status → status 0');
eq(parseImageResult({ status: '200', buffer: PNG }).ok, true, '字符串 status "200" 也认');
eq(parseImageResult({ status: 200, contentType: 'text/html', buffer: JPEG }).ok, true,
  'content-type 不参与判定，只看魔数');
eq(parseImageResult({ status: 200, contentType: 'image/jpeg', buffer: Buffer.from('html') }).reason,
  'bad_content', 'content-type 说图片、正文不是图片 → bad_content');
eq(parseImageResult().reason, 'upstream_error', '无参数不抛');
eq(parseImageResult(null).reason, 'upstream_error', 'null 选项不抛');
eq(parseImageResult([]).reason, 'upstream_error', '数组选项不抛');

// ── ⑨ imageQuota ───────────────────────────────────────────────────────────
console.log('\n⑨ imageQuota');

const empty = usageOf([]);
const q0 = imageQuota(empty, {}, 'generate', NOW);
eq(q0.ok, true, '空用量 → 放行');
eq(q0.reason, '', '放行时 reason 是空串');
eq(q0.windowCount, 0, '空用量 windowCount 0');
eq(q0.remaining, 20, '空用量 remaining 20');
eq(q0.windowHours, 24, 'windowHours 24');
eq(q0.windowCap, 20, 'windowCap 20');
eq(q0.minGapMs, 45000, 'minGapMs 45000');
eq(q0.retryAfterMs, 0, '放行时 retryAfterMs 0');
eq(Object.keys(q0).join(','), 'ok,reason,retryAfterMs,windowCount,remaining,windowHours,windowCap,minGapMs',
  '返回字段与 profile-core.quotaFor 同口径（八项、顺序固定）');

const oneRecent = imageQuota(usageOf([entry('generate', NOW - 1000)]), {}, 'generate', NOW);
eq(oneRecent.ok, false, '1 秒前画过 → 拒绝');
eq(oneRecent.reason, 'too_frequent', '1 秒前 → too_frequent');
eq(oneRecent.retryAfterMs, 44000, '还要等 44 秒');
eq(oneRecent.windowCount, 1, '窗口计数仍为 1');
eq(oneRecent.remaining, 19, 'remaining 19');

eq(imageQuota(usageOf([entry('generate', NOW - 45000)]), {}, 'generate', NOW).ok, true,
  '正好 45 秒前 → 放行（边界不含更早）');
const justInside = imageQuota(usageOf([entry('generate', NOW - 44999)]), {}, 'generate', NOW);
eq(justInside.reason, 'too_frequent', '44999ms 前 → 仍太频繁');
eq(justInside.retryAfterMs, 1, '还差 1ms 时 retryAfterMs 取 1（不为 0）');

eq(imageQuota(usageOf([entry('generate', NOW - DAY)]), {}, 'generate', NOW).windowCount, 0,
  '正好 24 小时前滑出窗口（左开）');
eq(imageQuota(usageOf([entry('generate', NOW - DAY)]), {}, 'generate', NOW).ok, true,
  '滑出窗口后恢复');
eq(imageQuota(usageOf([entry('generate', NOW - DAY + 1)]), {}, 'generate', NOW).windowCount, 1,
  '24 小时差 1ms → 仍在窗口内');
const future = imageQuota(usageOf([entry('generate', NOW + 5000)]), {}, 'generate', NOW);
eq(future.windowCount, 0, '未来时间戳不计入窗口');
eq(future.reason, 'too_frequent', '未来时间戳仍按 now 卡住最小间隔');
eq(future.retryAfterMs, 45000, '未来时间戳不会把等待时间顶到几年后');

const fullEntries = [];
for (let i = 1; i <= 20; i += 1) fullEntries.push(entry('generate', NOW - i * 60000));
const full = imageQuota(usageOf(fullEntries), {}, 'generate', NOW);
eq(full.reason, 'window_cap', '20 条 → window_cap');
eq(full.retryAfterMs, 86400000 - 1200000, '等最早那条滑出窗口（24h - 20min）');
eq(full.remaining, 0, 'cap 用尽 remaining 0');
const nineteen = imageQuota(usageOf(fullEntries.slice(0, 19)), {}, 'generate', NOW);
eq(nineteen.ok, true, '19 条 → 还能画');
eq(nineteen.remaining, 1, '19 条 remaining 1');

const disabled = imageQuota(usageOf([entry('generate', NOW - 1000)]), { enabled: false }, 'generate', NOW);
eq(disabled.reason, 'disabled', '总开关关掉 → disabled');
eq(disabled.retryAfterMs, 0, 'disabled retryAfterMs 0');
eq(disabled.windowHours, 24, 'disabled 仍带窗口参数（调用方拼 429 不用特例）');
eq([disabled.windowCount, disabled.remaining], [0, 0], 'disabled 计数归零');

const unknownKind = imageQuota(empty, {}, 'video', NOW);
eq(unknownKind.reason, 'unknown_kind', '未知 kind → unknown_kind');
eq(unknownKind.windowCount, 0, '未知 kind 计数归零');
eq(unknownKind.windowHours, 0, '未知 kind 窗口参数归零');

const mixed = usageOf([entry('generate', NOW - 1000)]);
eq(imageQuota(mixed, {}, 'sticker', NOW).ok, true, 'generate 的用量不影响 sticker 额度');
eq(imageQuota(mixed, {}, 'sticker', NOW).windowCount, 0, '按 kind 独立计数');
eq(imageQuota(mixed, {}, 'generate', NOW).reason, 'too_frequent', '同 kind 仍然受限');
eq(imageQuota(usageOf([entry('sticker', NOW - 5000)]), {}, 'sticker', NOW).ok, true,
  'sticker 正好 5 秒放行');
eq(imageQuota(usageOf([entry('sticker', NOW - 4999)]), {}, 'sticker', NOW).retryAfterMs, 1,
  'sticker 差 1ms 时 retryAfterMs 1');

const avatarCap = imageQuota(usageOf([entry('avatar', NOW - 7 * HOUR)]), {}, 'avatar', NOW);
eq(avatarCap.reason, 'window_cap', '头像 7 小时前换过 → 24h cap 1 已满');
eq(avatarCap.retryAfterMs, 17 * HOUR, '等 17 小时（24h - 7h）');
eq(imageQuota(usageOf([entry('avatar', NOW - 5 * HOUR)]), {}, 'avatar', NOW).reason, 'too_frequent',
  '头像 5 小时前 → 先撞 6 小时最小间隔');
eq(imageQuota(usageOf([entry('avatar', NOW - 5 * HOUR)]), {}, 'avatar', NOW).retryAfterMs, HOUR,
  '头像还要等 1 小时');

const customCfg = { generate: { windowHours: 1, windowCap: 2, minGapMs: 0 } };
const customFull = usageOf([entry('generate', NOW - 600000), entry('generate', NOW - 300000)]);
eq(imageQuota(customFull, customCfg, 'generate', NOW).reason, 'window_cap', '自定义窗口 1h/2 次用尽');
eq(imageQuota(customFull, customCfg, 'generate', NOW).retryAfterMs, 3000000,
  '自定义窗口等最早那条滑出（1h - 10min）');

eq(imageQuota(null, {}, 'generate', NOW).ok, true, 'usage null 不抛');
const dirtyUsage = usageOf([null, { kind: 'video', ts: NOW }, { kind: 'generate', ts: 'x' },
  entry('generate', NOW - 100000)]);
eq(imageQuota(dirtyUsage, {}, 'generate', NOW).windowCount, 1, '脏条目被忽略，只数合法条目');
const noNow = imageQuota(usageOf([entry('generate', NOW - 1000)]), {}, 'generate');
eq(noNow.windowCount, 0, '缺 now 时无法判断窗口，不把未来条目算进来');
eq(noNow.ok, true, '缺 now 不抛');

eq(imageQuota(usageOf([entry('generate', NOW - 60000)]), { generate: { windowCap: 0 } }, 'generate', NOW)
  .reason, 'window_cap', 'windowCap 0 被钳到 1，一条即满');

// ── ⑩ 用量记录与序列化 ─────────────────────────────────────────────────────
console.log('\n⑩ recordImageUsage / serialize / parse');

const recorded = recordImageUsage(usageOf([]), 'generate', NOW, { imageId: 'img-1' });
eq(recorded.entries, [{ kind: 'generate', ts: NOW, imageId: 'img-1' }], 'record 追加带 imageId 的条目');
const untouched = usageOf([]);
recordImageUsage(untouched, 'generate', NOW);
eq(untouched.entries, [], 'record 不改入参');
eq(recordImageUsage(usageOf([]), 'video', NOW).entries, [], '未知 kind 不记录');
eq(recordImageUsage(usageOf([]), 'generate', Number.NaN).entries, [], 'NaN 时间不记录');
eq(recordImageUsage(usageOf([]), 'generate', 0).entries, [], '0 时间不记录');
eq(recordImageUsage(usageOf([]), 'generate', NOW, { imageId: 42 }).entries,
  [{ kind: 'generate', ts: NOW }], '非字符串 imageId 不记录');
eq(recordImageUsage(usageOf([]), 'sticker', NOW).entries[0].kind, 'sticker', 'sticker 用量可记录');

let capped = usageOf([]);
for (let i = 1; i <= 505; i += 1) capped = recordImageUsage(capped, 'generate', i);
eq(capped.entries.length, 500, '用量最多保留 500 条');
eq(capped.entries[0].ts, 6, '裁剪丢的是最旧 5 条');

const roundTripUsage = recordImageUsage(recordImageUsage(usageOf([]), 'generate', NOW), 'avatar', NOW + 1);
const serialized = serializeImageUsage(roundTripUsage);
eq(JSON.parse(serialized).version, 1, '序列化带 version 1');
eq(parseImageUsage(serialized), roundTripUsage, '序列化往返一致');
eq(parseImageUsage('{oops'), { version: 1, entries: [] }, '坏 JSON → 空状态');
eq(parseImageUsage(''), { version: 1, entries: [] }, '空文本 → 空状态');
eq(parseImageUsage(null), { version: 1, entries: [] }, 'null → 空状态');
eq(parseImageUsage('null'), { version: 1, entries: [] }, 'JSON null → 空状态');
eq(parseImageUsage(JSON.stringify([{ kind: 'sticker', ts: NOW }])).entries,
  [{ kind: 'sticker', ts: NOW }], '顶层数组也接受');
eq(parseImageUsage(JSON.stringify({ entries: [{ kind: 'nope', ts: NOW }, { kind: 'sticker', ts: 0 }] })).entries,
  [], '坏 kind / 坏 ts 被丢弃');
eq(parseImageUsage(JSON.stringify({ entries: [{ kind: 'generate', ts: NOW }, { kind: 'generate', ts: NOW - 1000 }] }))
  .entries.map((item) => item.ts), [NOW - 1000, NOW], 'parse 按 ts 升序排列');
const huge = [];
for (let i = 1; i <= 505; i += 1) huge.push({ kind: 'generate', ts: i });
eq(parseImageUsage(JSON.stringify({ entries: huge })).entries.length, 500, 'parse 也裁到 500 条');

// ── ⑪ isAllowedImageSource ─────────────────────────────────────────────────
console.log('\n⑪ isAllowedImageSource');

eq(IMAGE_SOURCE_HOSTS, ['image.pollinations.ai', 'q1.qlogo.cn'], '白名单两个主机');
eq(isAllowedImageSource('https://image.pollinations.ai/prompt/cat'), true, 'pollinations https 放行');
eq(isAllowedImageSource('https://q1.qlogo.cn/g?b=qq&nk=10001&s=100'), true, 'qlogo https 放行');
eq(isAllowedImageSource('https://IMAGE.POLLINATIONS.AI/x'), true, 'hostname 大小写不敏感');
eq(isAllowedImageSource('http://image.pollinations.ai/x'), false, 'http 拒绝');
eq(isAllowedImageSource('ftp://image.pollinations.ai/x'), false, 'ftp 拒绝');
eq(isAllowedImageSource('https://evil.com/x'), false, '别的主机拒绝');
eq(isAllowedImageSource('https://image.pollinations.ai.evil.com/x'), false, '后缀伪造拒绝');
eq(isAllowedImageSource('https://sub.image.pollinations.ai/x'), false, '子域名拒绝');
eq(isAllowedImageSource('https://www.q1.qlogo.cn/x'), false, 'www. 变体未显式列出 → 拒绝');
eq(isAllowedImageSource('https://q1.qlogo.cn.evil.com/x'), false, 'qlogo 后缀伪造拒绝');
eq(isAllowedImageSource('https://image.pollinations.ai:8443/x'), false, '显式非默认端口拒绝');
eq(isAllowedImageSource('https://user:pass@image.pollinations.ai/x'), false, '带凭据的 URL 拒绝');
eq(isAllowedImageSource('https://image.pollinations.ai./x'), false, '结尾点号不匹配白名单');
eq(isAllowedImageSource('not a url'), false, '非 URL 拒绝');
eq(isAllowedImageSource(''), false, '空串拒绝');
eq(isAllowedImageSource(null), false, 'null 拒绝');
eq(isAllowedImageSource(42), false, '非字符串拒绝');
eq(isAllowedImageSource('javascript:alert(1)'), false, 'javascript: 拒绝');

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 条断言）`);
process.exitCode = failed === 0 ? 0 : 1;
