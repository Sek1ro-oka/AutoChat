// QQ 空间说说纯逻辑模块的单测（`node scripts/test-qzone-post.mjs`，成功 exit 0，失败 exit 1）。
//
// 覆盖任务书 §四 的五组，每条规则正反例各一：
//   ① normalizeQzoneConfig：默认值 / clamp 上下界 / ugcRight 收窄 / adminQQ 过滤 / 冻结
//   ② auditContent：length、url、phone、email、idcard、solicit 六条规则 + 全量收集 + 理由文案
//   ③ checkQuota：空记录 / 间隔 / 每日上限 / 跨日 / dailyCap=1 边界 / 时钟回拨
//   ④ pickUgcRight：1|4|64 保留，16/128/缺省回落 4
//   ⑤ prunePosts：截断到 50、按时间倒序、剔除脏数据、不改输入
// 另加 ⑥ 模块纯净性：源码里没有 import / require / node: 内置模块（零依赖、零 I/O 是硬约束）。
//
// 时间全部用 `Date.parse('...+08:00')` 造出来的假时间戳，不读系统时钟、不碰文件与网络
// （⑥ 只读本模块自己的源码文本）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QZONE_DEFAULTS,
  QZONE_UGC_RIGHTS,
  QZONE_AUDIT_REASONS,
  normalizeQzoneConfig,
  auditContent,
  checkQuota,
  pickUgcRight,
  prunePosts,
} from '../src/qzone-post.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 把「北京时间某个时刻」转成毫秒时间戳：注入给 checkQuota，不依赖本机时区。 */
const sh = (iso) => Date.parse(`${iso}+08:00`);
const T = '2026-10-19';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? `  — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

// ── ① normalizeQzoneConfig ──────────────────────────────────────────────────
console.log('① normalizeQzoneConfig');

const dflt = normalizeQzoneConfig();
check('默认 enabled=false', dflt.enabled === false);
check('默认 adminQQ=[]', Array.isArray(dflt.adminQQ) && dflt.adminQQ.length === 0);
check('默认 minIntervalMs=6h', dflt.minIntervalMs === 6 * HOUR, String(dflt.minIntervalMs));
check('默认 dailyCap=2 / ugcRight=4 / maxChars=300', dflt.dailyCap === 2 && dflt.ugcRight === 4 && dflt.maxChars === 300);
check('缺省/非对象输入不抛错', normalizeQzoneConfig().dailyCap === 2 && normalizeQzoneConfig(null).maxChars === 300 && normalizeQzoneConfig('x').ugcRight === 4);
check('常量被冻结且档位只有 1|4|64', Object.isFrozen(QZONE_DEFAULTS) && Object.isFrozen(QZONE_UGC_RIGHTS) && JSON.stringify(QZONE_UGC_RIGHTS) === '[1,4,64]');
check('enabled 正例：只有 true 算开', normalizeQzoneConfig({ enabled: true }).enabled === true);
check('enabled 反例："true" / 1 都不算开', normalizeQzoneConfig({ enabled: 'true' }).enabled === false && normalizeQzoneConfig({ enabled: 1 }).enabled === false);

check('minIntervalMs 下界：0 → 1h', normalizeQzoneConfig({ minIntervalMs: 0 }).minIntervalMs === HOUR, String(normalizeQzoneConfig({ minIntervalMs: 0 }).minIntervalMs));
check('minIntervalMs 上界：999 天 → 7 天', normalizeQzoneConfig({ minIntervalMs: 999 * DAY }).minIntervalMs === 7 * DAY);
check('minIntervalMs 反例：非数字回落 6h', normalizeQzoneConfig({ minIntervalMs: 'abc' }).minIntervalMs === 6 * HOUR && normalizeQzoneConfig({ minIntervalMs: null }).minIntervalMs === 6 * HOUR);
check('minIntervalMs 接受字符串数字', normalizeQzoneConfig({ minIntervalMs: String(2 * HOUR) }).minIntervalMs === 2 * HOUR);

check('dailyCap 下界：0 → 1', normalizeQzoneConfig({ dailyCap: 0 }).dailyCap === 1);
check('dailyCap 上界：99 → 10', normalizeQzoneConfig({ dailyCap: 99 }).dailyCap === 10);
check('dailyCap 取整：2.9 → 2', normalizeQzoneConfig({ dailyCap: 2.9 }).dailyCap === 2);
check('dailyCap 反例：非数字回落 2', normalizeQzoneConfig({ dailyCap: 'x' }).dailyCap === 2 && normalizeQzoneConfig({}).dailyCap === 2);

check('maxChars 下界：10 → 50', normalizeQzoneConfig({ maxChars: 10 }).maxChars === 50);
check('maxChars 上界：9999 → 1000', normalizeQzoneConfig({ maxChars: 9999 }).maxChars === 1000);
check('maxChars 接受字符串 "300"', normalizeQzoneConfig({ maxChars: '300' }).maxChars === 300);
check('maxChars 反例：非数字回落 300', normalizeQzoneConfig({ maxChars: 'abc' }).maxChars === 300 && normalizeQzoneConfig({ maxChars: null }).maxChars === 300);

check('ugcRight 保留 1', normalizeQzoneConfig({ ugcRight: 1 }).ugcRight === 1);
check('ugcRight 保留 64', normalizeQzoneConfig({ ugcRight: 64 }).ugcRight === 64);
check('ugcRight 16 → 4（需 target_uins，v1 不采集）', normalizeQzoneConfig({ ugcRight: 16 }).ugcRight === 4);
check('ugcRight 128 → 4（需 target_uins，v1 不采集）', normalizeQzoneConfig({ ugcRight: 128 }).ugcRight === 4);
check('ugcRight 反例：3 / "x" → 4', normalizeQzoneConfig({ ugcRight: 3 }).ugcRight === 4 && normalizeQzoneConfig({ ugcRight: 'x' }).ugcRight === 4);
check('ugcRight 反例：true 不被当成 1', normalizeQzoneConfig({ ugcRight: true }).ugcRight === 4);

const adm = normalizeQzoneConfig({ adminQQ: [10001, '10001', null, 0, -7, 1.5, 10001, 42, Number.NaN] }).adminQQ;
check('adminQQ 过滤字符串/非正整数，去重并升序', JSON.stringify(adm) === '[42,10001]', JSON.stringify(adm));
check('adminQQ 非数组 → []', normalizeQzoneConfig({ adminQQ: 10001 }).adminQQ.length === 0 && normalizeQzoneConfig({ adminQQ: null }).adminQQ.length === 0);
check('adminQQ 数组被冻结', Object.isFrozen(adm) && Object.isFrozen(normalizeQzoneConfig({}).adminQQ));

const frozenCfg = normalizeQzoneConfig({ dailyCap: 3 });
check('返回对象被冻结', Object.isFrozen(frozenCfg));
check('冻结后赋值无效（严格模式抛错也算）', (() => {
  try { frozenCfg.dailyCap = 9; } catch { /* ESM 严格模式会抛 TypeError，这正是期望 */ }
  return frozenCfg.dailyCap === 3;
})());

// ── ② auditContent ─────────────────────────────────────────────────────────
console.log('② auditContent');

const normal = '今天把窗户打开透了透气，阳光有点晃眼，泡了杯茶。';
const normalResult = auditContent(normal);
check('正常中文 → ok 且无理由', normalResult.ok === true && normalResult.reasons.length === 0 && normalResult.hits.length === 0);

const emptyResult = auditContent('');
check('length 正例：空正文被拒', emptyResult.ok === false && emptyResult.reasons.length === 1 && emptyResult.reasons[0] === '空的发什么', JSON.stringify(emptyResult.reasons));
check('length 正例：纯空白也算空', auditContent('   \n\t ').reasons[0] === QZONE_AUDIT_REASONS.empty && auditContent('   \n\t ').hits[0].rule === 'length');
check('length 正例：超 300 字被拒', auditContent('x'.repeat(301)).reasons[0] === '太长了，空间里没人看小作文');
check('length 反例：正好 300 字放行', auditContent('x'.repeat(300)).ok === true);
check('length 反例：首尾空白不计入长度', auditContent(`   ${'x'.repeat(300)}   `).ok === true);
check('length 支持自定义 maxChars：51 拒 / 50 放', auditContent('x'.repeat(51), { maxChars: 50 }).ok === false && auditContent('x'.repeat(50), { maxChars: 50 }).ok === true);
check('maxChars 非法值（"abc" / 0）回落 300', auditContent('x'.repeat(300), { maxChars: 'abc' }).ok === true && auditContent('x'.repeat(301), { maxChars: 0 }).ok === false);
check('非字符串输入按空正文处理', auditContent(null).reasons[0] === '空的发什么' && auditContent(undefined).ok === false);

const urlPositive = [
  '看这里 http://a.example/x',
  '看这里 https://a.example/x',
  '看这里 www.example.com',
  '看这里 t.cn/abc',
  '看这里 b23.tv/xyz',
  '看这里 example.com',
];
check('url 正例：六种写法都命中', urlPositive.every((t) => auditContent(t).hits.some((h) => h.rule === 'url')), urlPositive.map((t) => auditContent(t).reasons[0] ?? '-').join(' / '));
check('url 正例：其他裸域名后缀（.xyz/.io）也命中', auditContent('看 qq.xyz').hits.some((h) => h.rule === 'url') && auditContent('看 a.io').hits.some((h) => h.rule === 'url'));
const urlNegative = ['3.14', '第一点 3.14 倍', '今天看了 1.5 小时视频', 'com 不是网址', '这不是 www 前缀'];
check('url 反例：小数点/无域名形态不误伤', urlNegative.every((t) => !auditContent(t).hits.some((h) => h.rule === 'url')), urlNegative.join(' | '));

check('phone 正例：11 位手机号命中', auditContent('有事电话 17800000000 找我').hits.some((h) => h.rule === 'phone') && auditContent('有事电话 17800000000 找我').reasons.includes('别把手机号贴出去'));
check('phone 反例：日期与 10 位数字不误伤', !auditContent('2026 年 10 月 19 日').hits.some((h) => h.rule === 'phone') && !auditContent('订单号 1780000000').hits.some((h) => h.rule === 'phone'));

check('email 正例：a@b.co 命中', auditContent('发我 a@b.co 就行').hits.some((h) => h.rule === 'email') && auditContent('发我 a@b.co 就行').reasons.includes('邮箱也别留'));
check('email 反例：@所有人 / 无点的 a@b 不误伤', !auditContent('@所有人 注意一下').hits.some((h) => h.rule === 'email') && !auditContent('发我 a@b 就行').hits.some((h) => h.rule === 'email'));

const idcard15 = '110101900307123';
const idcard18 = '11010119900307123X';
check('idcard 正例：15 位命中', auditContent(`证件号 ${idcard15}`).hits.some((h) => h.rule === 'idcard') && auditContent(`证件号 ${idcard15}`).reasons.includes('证件号绝对不行'));
check('idcard 正例：17 位数字 + 校验位命中', auditContent(`证件号 ${idcard18}`).hits.some((h) => h.rule === 'idcard'));
check('idcard 反例：14 位 / 16 位不误伤', !auditContent(`号 ${'12345678901234'}`).hits.some((h) => h.rule === 'idcard') && !auditContent(`号 ${'1234567890123456'}`).hits.some((h) => h.rule === 'idcard'));

const solicitWords = ['加群', '拉群', '扫码', '私聊我', '加我', '进群'];
check('solicit 正例：六个词各自命中', solicitWords.every((w) => auditContent(`想聊天的${w}吧`).hits.some((h) => h.rule === 'solicit')), solicitWords.join(' / '));
check('solicit 反例：加油 / 群里 不误伤', !auditContent('一起加油吧').hits.some((h) => h.rule === 'solicit') && !auditContent('班级群里聊得挺热闹').hits.some((h) => h.rule === 'solicit'));

const mixed = auditContent('看 https://a.example/x 电话 17800000000 邮箱 a@b.co 想聊天的加群');
check('六条规则全部收集（不短路）：四条同时命中', mixed.reasons.length === 4 && ['url', 'phone', 'email', 'solicit'].every((r) => mixed.hits.some((h) => h.rule === r)), JSON.stringify(mixed.reasons));
check('同一条规则多次命中只留一条理由', (() => {
  const r = auditContent('http://a.example/x 和 https://b.example/y');
  return r.reasons.length === 1 && r.reasons[0] === '带链接等于帮人打广告' && r.hits.filter((h) => h.rule === 'url').length === 2;
})());

const reasonSamples = {
  url: ['看 http://a.example/x', '带链接等于帮人打广告'],
  phone: ['有事电话 17800000000', '别把手机号贴出去'],
  email: ['发我 a@b.co', '邮箱也别留'],
  idcard: [`证件号 ${idcard15}`, '证件号绝对不行'],
  solicit: ['想聊天的加群', '别在空间里拉人'],
};
check('理由文案逐字一致', Object.values(reasonSamples).every(([sample, reason]) => auditContent(sample).reasons.includes(reason)));

const shape = auditContent('看 http://a.example/x 电话 17800000000');
check('hits 结构：rule/index/text 齐全且片段 ≤ 40 字', shape.hits.every((h) => typeof h.rule === 'string' && Number.isInteger(h.index) && h.index >= 0 && typeof h.text === 'string' && h.text.length <= 40));
check('hits 按命中位置升序', shape.hits.every((h, i) => i === 0 || shape.hits[i - 1].index <= h.index));
check('ok 等价于「理由为空」', shape.ok === false && shape.ok === (shape.reasons.length === 0) && normalResult.ok === (normalResult.reasons.length === 0));

// ── ③ checkQuota ───────────────────────────────────────────────────────────
console.log('③ checkQuota');

const emptyQuota = checkQuota({ now: sh(`${T}T10:00:00`), posts: [], cfg: {} });
check('空 posts → 放行且 todayCount=0', emptyQuota.ok === true && emptyQuota.reason === null && emptyQuota.retryAfterMs === 0 && emptyQuota.todayCount === 0);
check('posts 缺失/脏数据不抛错', checkQuota({ now: sh(`${T}T10:00:00`), posts: undefined }).ok === true && checkQuota({ now: sh(`${T}T10:00:00`), posts: [{ tid: 'x' }, null] }).todayCount === 0);

const now5 = sh(`${T}T10:00:00`);
const fiveMinAgo = checkQuota({ now: now5, posts: [{ createdAt: now5 - 5 * 60_000 }], cfg: {} });
check('刚发过 5 分钟 → interval', fiveMinAgo.ok === false && fiveMinAgo.reason === 'interval' && fiveMinAgo.todayCount === 1);
check('interval 的 retryAfterMs = 6h − 5min', fiveMinAgo.retryAfterMs === 6 * HOUR - 5 * 60_000, String(fiveMinAgo.retryAfterMs));

const nowT = sh(`${T}T10:00:00`);
const twoToday = checkQuota({ now: nowT, posts: [{ createdAt: nowT - 7 * HOUR }, { createdAt: nowT - 2 * HOUR }], cfg: {} });
check('今天已 2 条 → daily_cap', twoToday.ok === false && twoToday.reason === 'daily_cap' && twoToday.todayCount === 2);
check('daily_cap 的 retryAfterMs 落在 (0, 24h]', twoToday.retryAfterMs > 0 && twoToday.retryAfterMs <= DAY, String(twoToday.retryAfterMs));
check('daily_cap 的 retryAfterMs 正好到次日零点（10:00 → 14h）', twoToday.retryAfterMs === 14 * HOUR, String(twoToday.retryAfterMs));
const atMidnight = checkQuota({ now: sh(`${T}T00:00:00`), posts: [{ createdAt: sh(`${T}T00:00:00`) }], cfg: { dailyCap: 1 } });
check('daily_cap 边界：正好零点 → 整 24h', atMidnight.retryAfterMs === DAY, String(atMidnight.retryAfterMs));

const crossNow = sh(`${T}T00:01:00`);
const crossPost = sh('2026-10-18T23:59:00');
const cross = checkQuota({ now: crossNow, posts: [{ createdAt: crossPost }], cfg: {} });
check('跨日：今日计数归零', cross.todayCount === 0, String(cross.todayCount));
check('跨日：间隔仍按最近一条算（2 分钟前发过 → interval）', cross.ok === false && cross.reason === 'interval' && cross.retryAfterMs === 6 * HOUR - 2 * 60_000, String(cross.retryAfterMs));
const crossLater = checkQuota({ now: sh(`${T}T06:30:00`), posts: [{ createdAt: crossPost }], cfg: {} });
check('跨日 6.5 小时后放行', crossLater.ok === true && crossLater.todayCount === 0 && crossLater.retryAfterMs === 0);
const utcEdge = checkQuota({ now: sh(`${T}T08:00:00`), posts: [{ createdAt: sh(`${T}T07:00:00`) }], cfg: {} });
check('日界按 UTC+8 而非 UTC（08:00 与 07:00 同属北京今日）', utcEdge.todayCount === 1, String(utcEdge.todayCount));

const capNow = sh(`${T}T10:00:00`);
const cap1 = checkQuota({ now: capNow, posts: [{ createdAt: capNow - 7 * HOUR }], cfg: { dailyCap: 1 } });
check('dailyCap=1：今天 1 条即 daily_cap', cap1.ok === false && cap1.reason === 'daily_cap' && cap1.todayCount === 1);
const cap1Free = checkQuota({ now: capNow, posts: [{ createdAt: sh('2026-10-18T09:00:00') }], cfg: { dailyCap: 1 } });
check('dailyCap=1：今天 0 条且已过间隔 → 放行', cap1Free.ok === true && cap1Free.todayCount === 0);
check('dailyCap 的 clamp 在 checkQuota 内生效（0 → 1）', checkQuota({ now: capNow, posts: [{ createdAt: capNow - 7 * HOUR }], cfg: { dailyCap: 0 } }).reason === 'daily_cap');

check('也接受整个 state 对象（容错）', checkQuota({ now: capNow, posts: { version: 1, posts: [{ createdAt: capNow - 2 * HOUR }] }, cfg: {} }).todayCount === 1);
const futurePost = checkQuota({ now: capNow, posts: [{ createdAt: capNow + 10 * 60_000 }], cfg: {} });
check('时钟回拨（未来时间戳）→ interval 且 retry 不为负', futurePost.ok === false && futurePost.reason === 'interval' && futurePost.retryAfterMs >= 6 * HOUR, String(futurePost.retryAfterMs));
const noNowA = checkQuota({ posts: [{ createdAt: sh(`${T}T10:00:00`) }] });
const noNowB = checkQuota({ posts: [{ createdAt: sh(`${T}T10:00:00`) }] });
check('未注入 now → 退化为「最近一条」，两次调用逐字节一致（不读系统时钟）', JSON.stringify(noNowA) === JSON.stringify(noNowB) && noNowA.reason === 'interval' && noNowA.retryAfterMs === 6 * HOUR, JSON.stringify(noNowA));

// ── ④ pickUgcRight ─────────────────────────────────────────────────────────
console.log('④ pickUgcRight');

check('保留 1 / 4 / 64', pickUgcRight({ ugcRight: 1 }) === 1 && pickUgcRight({ ugcRight: 4 }) === 4 && pickUgcRight({ ugcRight: 64 }) === 64);
check('16 → 4', pickUgcRight({ ugcRight: 16 }) === 4);
check('128 → 4', pickUgcRight({ ugcRight: 128 }) === 4);
check('缺省 / 非法值 → 4', pickUgcRight(undefined) === 4 && pickUgcRight(null) === 4 && pickUgcRight({}) === 4 && pickUgcRight({ ugcRight: 3 }) === 4 && pickUgcRight({ ugcRight: 'abc' }) === 4);
check('与 normalizeQzoneConfig 口径一致', [0, 1, 3, 4, 16, 64, 128].every((v) => pickUgcRight({ ugcRight: v }) === normalizeQzoneConfig({ ugcRight: v }).ugcRight));

// ── ⑤ prunePosts ───────────────────────────────────────────────────────────
console.log('⑤ prunePosts');

const many = Array.from({ length: 60 }, (_, i) => ({ tid: `t${i}`, createdAt: 1_760_000_000_000 + i * 60_000 }));
const pruned = prunePosts(many);
check('60 条 → 保留 50 条', pruned.length === 50, String(pruned.length));
check('保留的是最新的 50 条', pruned[0].tid === 't59' && pruned[49].tid === 't10', `${pruned[0].tid}..${pruned[49].tid}`);
check('乱序输入按 createdAt 倒序', (() => {
  const out = prunePosts([...many].reverse(), 60);
  return out.every((p, i) => i === 0 || out[i - 1].createdAt >= p.createdAt);
})());
check('剔除 createdAt 缺失/非法（null / undefined）', (() => {
  const out = prunePosts([{ createdAt: null, tid: 'n' }, { createdAt: 5, tid: 'a' }, {}, { createdAt: '7', tid: 'b' }], 50);
  return out.length === 2 && out[0].tid === 'b' && out[1].tid === 'a';
})());
check('不改动输入数组', (() => {
  const input = [...many];
  const before = input.map((p) => p.tid).join(',');
  prunePosts(input, 5);
  return input.length === 60 && input.map((p) => p.tid).join(',') === before;
})());
check('keep=0 → 空数组', prunePosts(many, 0).length === 0);
check('非数组输入 → 空数组', prunePosts(null).length === 0 && prunePosts(undefined, 10).length === 0);
check('keep 非法值回落 50', prunePosts(many, 'abc').length === 50);

// ── ⑥ 模块纯净性（零依赖 + 零 I/O） ────────────────────────────────────────
console.log('⑥ 模块纯净性');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'qzone-post.js'), 'utf8');
// 注释里可以提到 `Date.now()` / `import` 这些字样（文档本来就该解释它们），
// 所以纯检性只看代码行：整行注释丢掉，行尾注释去掉。
const moduleCode = moduleSource
  .split('\n')
  .map((line) => line.replace(/\s{2,}\/\/.*$/, ''))
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');
check('没有 import 语句', !/^\s*import\b/m.test(moduleCode));
check('没有 require / node: 内置模块', !/\brequire\s*\(/.test(moduleCode) && !/\bnode:/.test(moduleCode));
check('没有 process / fetch 等宿主或网络依赖', !/\bprocess\b/.test(moduleCode) && !/\bfetch\s*\(/.test(moduleCode) && !/\brequire\./.test(moduleCode));
check('只用注入的时间戳（不调用 Date.now()、不 new Date() 取当前时刻）', !/\bDate\.now\s*\(/.test(moduleCode) && !/new\s+Date\s*\(\s*\)/.test(moduleCode));

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed`);
process.exitCode = failed > 0 ? 1 : 0;
