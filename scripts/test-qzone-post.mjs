// QQ 空间说说纯逻辑模块的单测（`node scripts/test-qzone-post.mjs`，成功 exit 0，失败 exit 1）。
//
// 覆盖任务书 §四 的五组，每条规则正反例各一：
//   ① normalizeQzoneConfig：默认值 / clamp 上下界 / ugcRight 收窄 / adminQQ 过滤 / 冻结 /
//      新键 windowHours·windowCap（含两个 0）/ 老配置 dailyCap 迁移
//   ② auditContent：length、url、phone、email、idcard、solicit 六条规则 + 全量收集 + 理由文案
//   ③ checkQuota：滑动窗口（windowHours·windowCap）/ 两个 0 的语义 / 边界与 retryAfterMs /
//      legacy 键不再参与判定
//   ④ pickUgcRight：1|4|64 保留，16/128/缺省回落 4
//   ⑤ prunePosts：截断、按时间倒序、剔除脏数据、不改输入
// 另加 ⑥ 模块纯净性：源码里没有 import / require / node: 内置模块（零依赖、零 I/O 是硬约束），
// 以及 ⑦ 控制台配置更新（applyQzoneConfigUpdate）：只认四键、取值校验只有一套、越界夹回。
//
// 时间全部用 `Date.parse('...+08:00')` 造出来的假时间戳，不读系统时钟、不碰文件与网络
// （⑥ 只读本模块自己的源码文本）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QZONE_DEFAULTS,
  QZONE_UGC_RIGHTS,
  QZONE_LIMITS,
  QZONE_AUDIT_REASONS,
  QZONE_CONFIG_KEYS,
  normalizeQzoneConfig,
  usesLegacyDailyCap,
  applyQzoneConfigUpdate,
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

// ── ①b 新键 windowHours / windowCap 与老配置迁移 ───────────────────────────
console.log('①b 新键与老配置迁移');

check('默认 windowHours=24 / windowCap=2', dflt.windowHours === 24 && dflt.windowCap === 2);
check('QZONE_LIMITS 声明两个新键的区间', JSON.stringify(QZONE_LIMITS.windowHours) === '[0,24]' && JSON.stringify(QZONE_LIMITS.windowCap) === '[0,100]');

check('windowHours=0 存活（不被吞成默认 24）', normalizeQzoneConfig({ windowHours: 0 }).windowHours === 0);
check('windowCap=0 存活（= 暂停，不被吞成默认 2）', normalizeQzoneConfig({ windowCap: 0 }).windowCap === 0);
check('windowCap=0 与 windowHours=0 可以同时成立', (() => {
  const cfg = normalizeQzoneConfig({ windowHours: 0, windowCap: 0 });
  return cfg.windowHours === 0 && cfg.windowCap === 0;
})());

check('windowHours 上界：48 → 24', normalizeQzoneConfig({ windowHours: 48 }).windowHours === 24);
check('windowHours 取整：2.9 → 2', normalizeQzoneConfig({ windowHours: 2.9 }).windowHours === 2);
check('windowHours 反例：非数字回落 24', normalizeQzoneConfig({ windowHours: 'abc' }).windowHours === 24 && normalizeQzoneConfig({ windowHours: null }).windowHours === 24 && normalizeQzoneConfig({ windowHours: true }).windowHours === 24);
check('windowHours 接受字符串数字 "6"', normalizeQzoneConfig({ windowHours: '6' }).windowHours === 6);

check('windowCap 上界：999 → 100', normalizeQzoneConfig({ windowCap: 999 }).windowCap === 100);
check('windowCap 取整：2.9 → 2', normalizeQzoneConfig({ windowCap: 2.9 }).windowCap === 2);
check('windowCap 反例：非数字回落 2', normalizeQzoneConfig({ windowCap: 'x' }).windowCap === 2 && normalizeQzoneConfig({ windowCap: null }).windowCap === 2);
check('windowCap 接受字符串数字 "5"', normalizeQzoneConfig({ windowCap: '5' }).windowCap === 5);

check('迁移判定：只有 dailyCap 才算老配置', usesLegacyDailyCap({ dailyCap: 2 }) === true && usesLegacyDailyCap({ windowCap: 2, dailyCap: 2 }) === false && usesLegacyDailyCap({ windowCap: 2 }) === false && usesLegacyDailyCap({}) === false && usesLegacyDailyCap(null) === false);

const legacy = normalizeQzoneConfig({ dailyCap: 5 });
check('迁移：windowCap ← dailyCap，windowHours ← 24', legacy.windowCap === 5 && legacy.windowHours === 24);
check('迁移：旧键 dailyCap 仍能被读出', legacy.dailyCap === 5 && legacy.minIntervalMs === 6 * HOUR);
check('迁移：dailyCap 超出 0–100 时夹到 100', normalizeQzoneConfig({ dailyCap: 999 }).windowCap === 100);
check('迁移：dailyCap=0 迁移成 windowCap=0（暂停）', normalizeQzoneConfig({ dailyCap: 0 }).windowCap === 0);
check('新键优先：同时给了 windowCap 与 dailyCap 时不迁移', normalizeQzoneConfig({ dailyCap: 5, windowCap: 3 }).windowCap === 3);
check('没给 windowCap 也没给 dailyCap → 出厂 2/24（不凭空迁移）', normalizeQzoneConfig({}).windowCap === 2 && normalizeQzoneConfig({ ugcRight: 1 }).windowCap === 2);
check('迁移不改写 dailyCap 的 legacy 归一（上界仍是 10）', normalizeQzoneConfig({ dailyCap: 99 }).dailyCap === 10);

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
check('空 posts → 放行且 todayCount/windowCount=0', emptyQuota.ok === true && emptyQuota.reason === null && emptyQuota.retryAfterMs === 0 && emptyQuota.todayCount === 0 && emptyQuota.windowCount === 0);
check('posts 缺失/脏数据不抛错', checkQuota({ now: sh(`${T}T10:00:00`), posts: undefined }).ok === true && checkQuota({ now: sh(`${T}T10:00:00`), posts: [{ tid: 'x' }, null] }).todayCount === 0);

const now5 = sh(`${T}T10:00:00`);
const fiveMinAgo = checkQuota({ now: now5, posts: [{ createdAt: now5 - 5 * 60_000 }], cfg: {} });
check('刚发过 5 分钟但窗口没满 → 放行（最小间隔已取消）', fiveMinAgo.ok === true && fiveMinAgo.reason === null && fiveMinAgo.windowCount === 1 && fiveMinAgo.todayCount === 1);

const nowT = sh(`${T}T10:00:00`);
const twoInWindow = checkQuota({ now: nowT, posts: [{ createdAt: nowT - 7 * HOUR }, { createdAt: nowT - 2 * HOUR }], cfg: {} });
check('24h 窗口内已 2 条 → daily_cap', twoInWindow.ok === false && twoInWindow.reason === 'daily_cap' && twoInWindow.windowCount === 2 && twoInWindow.todayCount === 2);
check('daily_cap 的 retryAfterMs 落在 (0, 24h]', twoInWindow.retryAfterMs > 0 && twoInWindow.retryAfterMs <= DAY, String(twoInWindow.retryAfterMs));
check('retryAfterMs = 最早一条滑出窗口的时刻 − now（20h 前 → 4h）', (() => {
  const at = sh(`${T}T10:00:00`);
  const quota = checkQuota({ now: at, posts: [{ createdAt: at - 20 * HOUR }, { createdAt: at - HOUR }], cfg: {} });
  return quota.retryAfterMs === 4 * HOUR;
})(), String(checkQuota({ now: nowT, posts: [{ createdAt: nowT - 20 * HOUR }, { createdAt: nowT - HOUR }], cfg: {} }).retryAfterMs));

const outsideNow = sh(`${T}T10:00:00`);
const outside = checkQuota({ now: outsideNow, posts: [{ createdAt: outsideNow - 25 * HOUR }, { createdAt: outsideNow - HOUR }], cfg: {} });
check('24 小时外的记录不计入 windowCount', outside.ok === true && outside.windowCount === 1 && outside.todayCount === 1);
const onEdge = checkQuota({ now: outsideNow, posts: [{ createdAt: outsideNow - 24 * HOUR }, { createdAt: outsideNow - HOUR }], cfg: {} });
check('正好 24 小时前已经滑出窗口（左开区间）', onEdge.ok === true && onEdge.windowCount === 1);

const hourly = checkQuota({ now: outsideNow, posts: [{ createdAt: outsideNow - 2 * HOUR }, { createdAt: outsideNow - 30 * 60_000 }], cfg: { windowHours: 1 } });
check('windowHours=1 → 2 小时前那条不算（窗口跟着变短）', hourly.ok === true && hourly.windowCount === 1, String(hourly.windowCount));

const paused = checkQuota({ now: outsideNow, posts: [], cfg: { windowCap: 0 } });
check('windowCap=0 → 直接拒（已暂停），retryAfterMs=0', paused.ok === false && paused.reason === 'daily_cap' && paused.retryAfterMs === 0 && paused.windowCount === 0);
const pausedWithPosts = checkQuota({ now: outsideNow, posts: [{ createdAt: outsideNow - HOUR }], cfg: { windowCap: 0 } });
check('windowCap=0 时即使窗口是空的也拒', pausedWithPosts.ok === false && pausedWithPosts.retryAfterMs === 0);

const dayNow = sh(`${T}T10:00:00`);
const dayTwo = checkQuota({ now: dayNow, posts: [{ createdAt: sh(`${T}T00:30:00`) }, { createdAt: sh(`${T}T09:00:00`) }], cfg: { windowHours: 0 } });
check('windowHours=0 → 按北京自然日计数（今日 2 条即 daily_cap）', dayTwo.ok === false && dayTwo.reason === 'daily_cap' && dayTwo.windowCount === 2 && dayTwo.todayCount === 2);
check('windowHours=0 的 retryAfterMs 到次日零点（10:00 → 14h）', dayTwo.retryAfterMs === 14 * HOUR, String(dayTwo.retryAfterMs));
const dayCrossNow = sh('2026-10-19T00:01:00');
const dayCross = checkQuota({ now: dayCrossNow, posts: [{ createdAt: sh('2026-10-18T23:59:00') }], cfg: { windowHours: 0 } });
check('windowHours=0 跨日 → 计数归零、放行', dayCross.ok === true && dayCross.windowCount === 0 && dayCross.retryAfterMs === 0);
check('windowHours=0 且正好零点 → 整 24h', checkQuota({ now: sh(`${T}T00:00:00`), posts: [{ createdAt: sh(`${T}T00:00:00`) }], cfg: { windowHours: 0, windowCap: 1 } }).retryAfterMs === DAY);
check('windowHours=0 的上限仍由 windowCap 决定（cap=1 时今日 1 条就拒）', checkQuota({ now: dayNow, posts: [{ createdAt: sh(`${T}T01:00:00`) }], cfg: { windowHours: 0, windowCap: 1 } }).reason === 'daily_cap');
check('windowHours=0 但今日 0 条 → 放行', checkQuota({ now: dayNow, posts: [{ createdAt: sh('2026-10-18T09:00:00') }], cfg: { windowHours: 0, windowCap: 1 } }).ok === true);

check('minIntervalMs 已不再参与判定', checkQuota({ now: dayNow, posts: [{ createdAt: dayNow - 60_000 }], cfg: { minIntervalMs: 6 * HOUR } }).ok === true);
check('dailyCap 已不再参与判定（显式给了 windowCap 时 dailyCap 被无视）', checkQuota({ now: dayNow, posts: [{ createdAt: dayNow - 60_000 }], cfg: { dailyCap: 1, windowCap: 2 } }).ok === true);

const migratedCfg = normalizeQzoneConfig({ dailyCap: 1 });
check('迁移后的配置真的参与判定（dailyCap:1 → 窗口内 1 条即拒）', migratedCfg.windowCap === 1 && migratedCfg.windowHours === 24 && checkQuota({ now: dayNow, posts: [{ createdAt: dayNow - HOUR }], cfg: migratedCfg }).reason === 'daily_cap');
check('迁移后的配置：窗口空了就放行', checkQuota({ now: dayNow, posts: [{ createdAt: dayNow - 25 * HOUR }], cfg: migratedCfg }).ok === true);

const futurePost = checkQuota({ now: outsideNow, posts: [{ createdAt: outsideNow + 10 * 60_000 }], cfg: {} });
check('时钟回拨（未来时间戳）→ 仍计入窗口、retryAfterMs 不为负', futurePost.windowCount === 1 && futurePost.retryAfterMs >= 0, String(futurePost.retryAfterMs));

check('也接受整个 state 对象（容错）', checkQuota({ now: outsideNow, posts: { version: 1, posts: [{ createdAt: outsideNow - 2 * HOUR }] }, cfg: {} }).windowCount === 1);

const noNowA = checkQuota({ posts: [{ createdAt: sh(`${T}T10:00:00`) }, { createdAt: sh(`${T}T11:00:00`) }] });
const noNowB = checkQuota({ posts: [{ createdAt: sh(`${T}T10:00:00`) }, { createdAt: sh(`${T}T11:00:00`) }] });
check('未注入 now → 退化为「最近一条的时刻」，两次调用逐字节一致（不读系统时钟）', JSON.stringify(noNowA) === JSON.stringify(noNowB) && noNowA.reason === 'daily_cap' && noNowA.windowCount === 2 && noNowA.retryAfterMs === 23 * HOUR, JSON.stringify(noNowA));

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
check('keep 大于 50 时按传入值保留（不写死 50）', prunePosts(many, 55).length === 55);

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

// ── ⑦ applyQzoneConfigUpdate（控制台改配置的唯一校验源） ───────────────────
console.log('⑦ applyQzoneConfigUpdate');

check('白名单就是四个键', JSON.stringify(QZONE_CONFIG_KEYS) === '["enabled","windowHours","windowCap","ugcRight"]');

const base = normalizeQzoneConfig({ enabled: true, windowHours: 6, windowCap: 3, ugcRight: 1 });
const onlyCap = applyQzoneConfigUpdate(base, { windowCap: 5 });
check('部分更新：只改一个键，其余保持现值', onlyCap.ok === true && onlyCap.qzone.windowCap === 5 && onlyCap.qzone.windowHours === 6 && onlyCap.qzone.enabled === true && onlyCap.qzone.ugcRight === 1);
check('部分更新：返回值被归一化（冻结对象）', onlyCap.ok === true && Object.isFrozen(onlyCap.qzone));
check('部分更新：0 能存进去（暂停 / 自然日）', applyQzoneConfigUpdate(base, { windowCap: 0 }).qzone.windowCap === 0 && applyQzoneConfigUpdate(base, { windowHours: 0 }).qzone.windowHours === 0);

check('未知键 → 拒绝并点名', (() => {
  const r = applyQzoneConfigUpdate(base, { windowCap: 5, dailyCap: 9 });
  return r.ok === false && r.error.includes('dailyCap');
})());
check('空 patch → 要求至少改一项', (() => {
  const r = applyQzoneConfigUpdate(base, {});
  return r.ok === false && r.error.includes('至少要改一项');
})());
check('patch 不是对象 → 要求至少改一项', applyQzoneConfigUpdate(base, null).ok === false && applyQzoneConfigUpdate(base, 'x').ok === false);
check('值为 null/undefined → 点名该键', applyQzoneConfigUpdate(base, { windowCap: null }).error === 'windowCap 不能为空' && applyQzoneConfigUpdate(base, { windowCap: undefined }).ok === false);
check('enabled 必须是真布尔', applyQzoneConfigUpdate(base, { enabled: 'true' }).error === 'enabled 必须是布尔值' && applyQzoneConfigUpdate(base, { enabled: 1 }).error === 'enabled 必须是布尔值' && applyQzoneConfigUpdate(base, { enabled: false }).qzone.enabled === false);
check('ugcRight 只收 1/4/64', applyQzoneConfigUpdate(base, { ugcRight: 16 }).error === 'ugcRight 只支持 1 / 4 / 64' && applyQzoneConfigUpdate(base, { ugcRight: 64 }).qzone.ugcRight === 64);
check('数字项必须能转成数字', applyQzoneConfigUpdate(base, { windowCap: 'abc' }).error === 'windowCap 必须是数字' && applyQzoneConfigUpdate(base, { windowHours: 'abc' }).error === 'windowHours 必须是数字');
check('数字字符串收（和手写 config.json 口径一致）', applyQzoneConfigUpdate(base, { windowCap: '7' }).qzone.windowCap === 7);

const clampedCap = applyQzoneConfigUpdate(base, { windowCap: 999 });
check('越界夹回边界并诚实上报 clamped', clampedCap.ok === true && clampedCap.qzone.windowCap === 100 && clampedCap.clamped.includes('windowCap'));
const clampedHours = applyQzoneConfigUpdate(base, { windowHours: 48 });
check('windowHours 越界同样夹回并上报', clampedHours.qzone.windowHours === 24 && clampedHours.clamped.includes('windowHours'));
const rounded = applyQzoneConfigUpdate(base, { windowCap: 2.9 });
check('取整不算「被夹」：2.9 → 2 且 clamped 为空', rounded.qzone.windowCap === 2 && rounded.clamped.length === 0);
check('正常范围内 clamped 为空数组', Array.isArray(applyQzoneConfigUpdate(base, { windowCap: 4 }).clamped) && applyQzoneConfigUpdate(base, { windowCap: 4 }).clamped.length === 0);

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed`);
process.exitCode = failed > 0 ? 1 : 0;
