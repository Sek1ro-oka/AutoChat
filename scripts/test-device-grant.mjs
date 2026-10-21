#!/usr/bin/env node
/**
 * T-024：平板授权（`src/device-grant.js`）的纯函数单测。
 *
 * 覆盖：
 *   一 授权口令（各种说法 / 分钟数钳制 / @前缀）
 *   二 撤销口令（别玩了 / 不玩了 / 回来 / 停下 / 先别玩）
 *   三 误伤反例（普通聊天绝不能被当成授权或撤销）
 *   四 授权生命周期（创建 / 过期边界 / 撤销 / 容错解析）
 *   五 grantSummary（四种状态 + 剩余分钟）
 *
 * 全部零 I/O、零依赖，时钟用固定值（T0）注入，所以跑多少次结果都一样。
 *
 * 跑法：node scripts/test-device-grant.mjs
 */
import {
  DEVICE_GRANT_FILE,
  GRANT_DEFAULTS,
  GRANT_LIMITS,
  NOT_GRANTED_MESSAGE,
  createGrant,
  grantRemainingMs,
  grantSummary,
  isGrantActive,
  parseGrant,
  parseGrantIntent,
  revokeGrant,
} from '../src/device-grant.js';

// ── 脚手架 ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  const detail = extra === undefined ? '' : `  ← ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  console.error(`❌ ${name}${detail}`);
}

const MIN = 60 * 1000;
// 固定假时钟：本地时间 2026-03-15 14:30（只看毫秒数，不受时区影响）。
const T0 = new Date(2026, 2, 15, 14, 30, 0, 0).getTime();
const QQ = 1691642607;

/** 断言一条消息被解析成「授权 N 分钟」。 */
function expectGrant(text, minutes) {
  const intent = parseGrantIntent(text);
  check(`「${text}」→ 授权 ${minutes} 分钟`, intent.action === 'grant' && intent.minutes === minutes, intent);
}

/** 断言一条消息被解析成「撤销」。 */
function expectRevoke(text) {
  const intent = parseGrantIntent(text);
  check(`「${text}」→ 撤销`, intent.action === 'revoke', intent);
}

/** 断言一条消息**不**被当成任何口令。 */
function expectNothing(text, label) {
  const intent = parseGrantIntent(text);
  check(`${label ?? `「${text}」`} → 不是口令`, intent.action === null, intent);
}

// ── 一 授权口令 ────────────────────────────────────────────────────────────
{
  expectGrant('去玩平板', GRANT_DEFAULTS.minutes);
  expectGrant('玩会儿平板', GRANT_DEFAULTS.minutes);
  expectGrant('去玩会儿平板', GRANT_DEFAULTS.minutes);
  expectGrant('玩平板', GRANT_DEFAULTS.minutes);
  expectGrant('去玩玩平板', GRANT_DEFAULTS.minutes);
  expectGrant('去玩一下平板', GRANT_DEFAULTS.minutes);
  expectGrant('去玩平板吧', GRANT_DEFAULTS.minutes);
  expectGrant('好，去玩平板 15 分钟', 15);
  expectGrant('去玩平板 20 分钟', 20);
  expectGrant('去玩平板20分钟', 20);
  expectGrant('玩会儿平板　45分钟', 45); // 全角空格
  expectGrant('去玩平板 25 min', 25);
  expectGrant('去玩平板 30m', 30);
  expectGrant('@樰 去玩平板 10 分钟', 10); // 群里 @ 一下再下口令
  expectGrant('现在去玩平板', GRANT_DEFAULTS.minutes);

  // 钳制：少于 5 分钟按 5 算（还没坐稳就过期没意义），多于 120 分钟按 120 算。
  expectGrant('玩平板 3 分钟', GRANT_LIMITS.minMinutes);
  expectGrant('玩平板 0 分钟', GRANT_DEFAULTS.minutes); // 0 = 没说时长
  expectGrant('玩平板 999 分钟', GRANT_LIMITS.maxMinutes);
  expectGrant('玩平板 5 分钟', 5);
  expectGrant('玩平板 120 分钟', 120);

  // 返回形状：grant 一定带 minutes（数字），不带别的字段。
  const shape = parseGrantIntent('去玩平板 20 分钟');
  check('grant 回执形状是 { action, minutes }', Object.keys(shape).sort().join(',') === 'action,minutes', shape);
  check('grant 的 minutes 是数字', typeof shape.minutes === 'number');
}

// ── 二 撤销口令 ────────────────────────────────────────────────────────────
{
  expectRevoke('别玩了');
  expectRevoke('别玩啦');
  expectRevoke('先别玩');
  expectRevoke('先别玩了');
  expectRevoke('不玩了');
  expectRevoke('不要玩了');
  expectRevoke('别玩平板了');
  expectRevoke('回来');
  expectRevoke('回来吧');
  expectRevoke('快回来');
  expectRevoke('停下');
  expectRevoke('停下来');
  expectRevoke('停一下');
  expectRevoke('先停下');
  expectRevoke('@樰 别玩了');

  const shape = parseGrantIntent('别玩了');
  check('revoke 回执只有 action', Object.keys(shape).join(',') === 'action', shape);
}

// ── 三 误伤反例 ────────────────────────────────────────────────────────────
{
  // 「我回来啦」是陈述「我回来了」，不是喊机器人回来 —— 这条是需求里点名的反例。
  expectNothing('我回来啦');
  expectNothing('我回来了');
  expectNothing('我回来啦，你继续');
  expectNothing('刚刚玩了会儿平板');
  expectNothing('我昨天玩平板玩到两点');
  expectNothing('我想去玩平板');
  expectNothing('群友说去玩平板');
  expectNothing('今天天气不错，去玩平板');
  expectNothing('去玩平板然后帮我写代码');
  expectNothing('平板玩起来真爽');
  expectNothing('这平板挺好玩的');
  expectNothing('别玩了，回来吧'); // 一句话两个意图：不认
  expectNothing('');
  expectNothing('   ');
  expectNothing('随便聊聊');
  expectNothing(null, 'null 不是口令');
  expectNothing(undefined, 'undefined 不是口令');
  expectNothing(123, '数字不是口令');
  expectNothing({ text: '去玩平板' }, '对象不是口令');

  // 超长句子：哪怕开头就是「去玩平板」，后面挂了一堆诉求也不认（短句才是一句话的命令）。
  expectNothing(`去玩平板${'然后'.repeat(20)}`);
}

// ── 四 授权生命周期 ────────────────────────────────────────────────────────
{
  const grant = createGrant(T0, { grantedBy: String(QQ), viaKey: 'private:' + QQ, minutes: 20 });
  check('createGrant 七个键', Object.keys(grant).join(',') === 'grantedBy,viaKey,grantedAt,expiresAt,minutes,steps,revokedAt', Object.keys(grant));
  check('grantedBy 归一成数字', grant.grantedBy === QQ, grant.grantedBy);
  check('viaKey 原样保留', grant.viaKey === `private:${QQ}`);
  check('grantedAt = now', grant.grantedAt === T0);
  check('expiresAt = now + 20 分钟', grant.expiresAt === T0 + 20 * MIN);
  check('minutes 记录本次时长', grant.minutes === 20);
  check('steps 缺省 60', grant.steps === GRANT_DEFAULTS.steps);
  check('revokedAt 初始为 0', grant.revokedAt === 0);

  const defaults = createGrant(T0, {});
  check('缺省 30 分钟', defaults.minutes === GRANT_DEFAULTS.minutes && defaults.expiresAt === T0 + 30 * MIN);
  check('认不出授权人给 null', defaults.grantedBy === null);
  check('viaKey 缺省空串', defaults.viaKey === '');
  check('分钟数 <5 钳到 5', createGrant(T0, { minutes: 1 }).minutes === GRANT_LIMITS.minMinutes);
  check('分钟数 >120 钳到 120', createGrant(T0, { minutes: 500 }).minutes === GRANT_LIMITS.maxMinutes);
  check('分钟数非数字回缺省 30', createGrant(T0, { minutes: '一会儿' }).minutes === GRANT_DEFAULTS.minutes);
  check('步数可显式指定', createGrant(T0, { steps: 12 }).steps === 12);
  check('步数超上限钳到 600', createGrant(T0, { steps: 9999 }).steps === GRANT_LIMITS.maxSteps);
  check('now 是 Date 也认', createGrant(new Date(T0), {}).grantedAt === T0);

  // 有效期判定（边界：expiresAt 那一毫秒就已经不算数）
  check('刚授权时有效', isGrantActive(grant, T0) === true);
  check('到期前一毫秒仍有效', isGrantActive(grant, grant.expiresAt - 1) === true);
  check('到期那一刻即失效', isGrantActive(grant, grant.expiresAt) === false);
  check('过期之后再晚也失效', isGrantActive(grant, grant.expiresAt + 60 * MIN) === false);
  check('剩余毫秒数', grantRemainingMs(grant, T0 + 5 * MIN) === 15 * MIN);
  check('过期后剩余 0', grantRemainingMs(grant, grant.expiresAt + 1) === 0);
  check('now 非法 → 判失效（fail-closed）', isGrantActive(grant, NaN) === false && isGrantActive(grant, 'later') === false);

  // 撤销
  const revoked = revokeGrant(grant, T0 + 2 * MIN);
  check('撤销写 revokedAt', revoked.revokedAt === T0 + 2 * MIN);
  check('撤销返回新对象（不改入参）', grant.revokedAt === 0);
  check('撤销后立刻失效', isGrantActive(revoked, T0 + 2 * MIN) === false);
  check('撤销后剩余 0', grantRemainingMs(revoked, T0 + 2 * MIN) === 0);
  const again = revokeGrant(revoked, T0 + 10 * MIN);
  check('重复撤销保留第一次的时间', again.revokedAt === T0 + 2 * MIN);
  check('撤销保留原时长', revoked.minutes === 20 && revoked.expiresAt === grant.expiresAt);

  // 容错解析（坏文件只能是「没授权」，绝不能变成「有授权」）
  check('parseGrant 接受 JSON 字符串', parseGrant(JSON.stringify(grant)).expiresAt === grant.expiresAt);
  check('parseGrant(null) → 空授权', parseGrant(null).expiresAt === 0);
  check('parseGrant 坏 JSON → 空授权', parseGrant('{not json').expiresAt === 0);
  check('parseGrant 数组 → 空授权', parseGrant([1, 2]).expiresAt === 0);
  check('空授权永远判过期', isGrantActive(parseGrant(null), T0) === false);
  check('负数 revokedAt 归 0', parseGrant({ revokedAt: -5 }).revokedAt === 0);
  check('字符串时间戳也接受', parseGrant({ expiresAt: String(T0 + MIN) }).expiresAt === T0 + MIN);
  check('grantedBy 脏值 → null', parseGrant({ grantedBy: 'abc' }).grantedBy === null);
  check('BOM 前缀不影响解析', parseGrant(`\uFEFF${JSON.stringify(grant)}`).grantedBy === QQ);

  check('授权文件名固定', DEVICE_GRANT_FILE === 'device-grant.json');
  check('未授权文案点名管理员与触发词', NOT_GRANTED_MESSAGE.includes('管理员') && NOT_GRANTED_MESSAGE.includes('去玩平板'));
}

// ── 五 grantSummary ────────────────────────────────────────────────────────
{
  const grant = createGrant(T0, { grantedBy: QQ, minutes: 30 });

  const active = grantSummary(grant, T0 + 15 * MIN + 30 * 1000);
  check('有效授权 active=true', active.active === true && active.reason === 'active', active);
  check('剩余分钟向上取整（14.5 → 15）', active.leftMinutes === 15, active.leftMinutes);
  check('摘要带授权人与时长', active.grantedBy === QQ && active.minutes === 30);
  check('摘要一句话里有「还剩」与剩余分钟', active.text.includes('还剩') && active.text.includes('15'), active.text);
  check('摘要带步数上限（给人看的值）', active.steps === GRANT_DEFAULTS.steps);

  const justIn = grantSummary(grant, T0);
  check('刚授权时剩余整 30 分钟', justIn.leftMinutes === 30);

  const revoked = grantSummary(revokeGrant(grant, T0 + MIN), T0 + 2 * MIN);
  check('已撤销 active=false / reason=revoked', revoked.active === false && revoked.reason === 'revoked', revoked);
  check('已撤销剩余 0', revoked.leftMinutes === 0);
  check('已撤销文案里有「撤销」', revoked.text.includes('撤销'), revoked.text);

  const expired = grantSummary(grant, grant.expiresAt);
  check('已过期 reason=expired', expired.active === false && expired.reason === 'expired', expired);
  check('已过期文案里有「过期」', expired.text.includes('过期'), expired.text);

  const missing = grantSummary(parseGrant(null), T0);
  check('没有授权 reason=missing', missing.active === false && missing.reason === 'missing', missing);
  check('没有授权文案里有「还没有」', missing.text.includes('还没有'), missing.text);

  const unknown = grantSummary({ expiresAt: T0 + MIN }, NaN);
  check('时间戳坏了 reason=unknown', unknown.active === false && unknown.reason === 'unknown', unknown);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
if (failed > 0) process.exitCode = 1;
