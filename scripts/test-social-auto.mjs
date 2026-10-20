// 社交自动化（入群邀请 / 好友申请）纯逻辑模块的单测。
//
// 跑法：`node scripts/test-social-auto.mjs`（全过 exit 0，有失败 exit 1）。
//
// 覆盖 dev-doc §11.1 的 16 条，另加常量/纯净性/边界：
//   ① normalizeAutomation：默认全关 + notifyOwner:true；fail-closed（"true"/1 都不算开）；
//      额度 0 合法、999 夹到 50、-3 夹到 0、'x' 回落默认；未知键忽略；不改入参
//   ② applyAutomationUpdate：三条错误文案逐字、部分更新、changed 只列真变了的键
//   ③ dayKey：上海时区跨日边界（23:59 / 00:01）
//   ④ rollQuotaState / takeQuota / markAlerted：跨天清零、取到上限拒绝、纯函数、额度 0
//   ⑤ 通知文案：§10 六行逐字；审计文案与 §5 例子逐字
//   ⑥ formatAutomationChange：单项 / 多项顿号
//   ⑦ parseAuditTail：空串、坏行、只取尾部、时间正序、at 按 Asia/Shanghai 折算
//   ⑧ appendAuditLine + parseAuditTail 往返：只写临时目录，绝不碰真实 state/
//
// 时间全部用 `Date.parse('...+08:00')` 造出来的假时间戳；除 ⑧ 的临时目录（os.tmpdir()）外
// 不碰文件、不连网络、不读系统时钟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_KEYS,
  AUTOMATION_LIMITS,
  AUTOMATION_LIMIT_KINDS,
  AUTOMATION_LIMIT_LABELS,
  AUTOMATION_LABELS,
  AUTOMATION_ERRORS,
  normalizeAutomation,
  applyAutomationUpdate,
  dayKey,
  clockKey,
  shanghaiTimestamp,
  rollQuotaState,
  takeQuota,
  markAlerted,
  formatApprovedFriend,
  formatInviteApproved,
  formatJoinedGroup,
  formatWhitelistAdded,
  formatQuotaExhausted,
  formatApprovedFriendLog,
  formatInviteApprovedLog,
  formatWhitelistAddedLog,
  formatAutomationChange,
  auditEntry,
  appendAuditLine,
  parseAuditTail
} from '../src/social-auto.js';

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

/** 北京时间某个时刻 → 毫秒时间戳（注入给纯函数，不依赖本机时区）。 */
const sh = (iso) => Date.parse(`${iso}+08:00`);

// ── ① normalizeAutomation ───────────────────────────────────────────────────
console.log('① normalizeAutomation');

const dflt = normalizeAutomation({});
check('默认五个开关：四个 false + notifyOwner true',
  dflt.acceptInvite === false && dflt.groupWhitelist === false && dflt.friendFromGroup === false
  && dflt.privateWhitelist === false && dflt.notifyOwner === true);
check('默认额度 5 / 3 / 5',
  dflt.dailyLimits.friendApprove === 5 && dflt.dailyLimits.inviteApprove === 3 && dflt.dailyLimits.whitelistWrite === 5);
check('缺省/非对象输入不抛错', normalizeAutomation().acceptInvite === false
  && normalizeAutomation(null).notifyOwner === true
  && normalizeAutomation('x').dailyLimits.friendApprove === 5
  && normalizeAutomation([]).acceptInvite === false);
check('常量被冻结且键表就是 5 个布尔键',
  Object.isFrozen(AUTOMATION_DEFAULTS) && Object.isFrozen(AUTOMATION_DEFAULTS.dailyLimits)
  && Object.isFrozen(AUTOMATION_KEYS) && Object.isFrozen(AUTOMATION_LIMITS)
  && JSON.stringify(AUTOMATION_KEYS) === JSON.stringify(['acceptInvite', 'groupWhitelist', 'friendFromGroup', 'privateWhitelist', 'notifyOwner'])
  && AUTOMATION_LIMITS.min === 0 && AUTOMATION_LIMITS.max === 50);
check('normalize 返回冻结对象', Object.isFrozen(dflt) && Object.isFrozen(dflt.dailyLimits));

check('acceptInvite 正例：只有 true 算开', normalizeAutomation({ acceptInvite: true }).acceptInvite === true);
check('acceptInvite 反例："true" 不算开', normalizeAutomation({ acceptInvite: 'true' }).acceptInvite === false);
check('acceptInvite 反例：1 不算开', normalizeAutomation({ acceptInvite: 1 }).acceptInvite === false);
check('notifyOwner 也是 fail-closed：只有 true 算开（"yes"/1 都关）',
  normalizeAutomation({ notifyOwner: false }).notifyOwner === false
  && normalizeAutomation({ notifyOwner: 'yes' }).notifyOwner === false
  && normalizeAutomation({ notifyOwner: 1 }).notifyOwner === false);
check('五个开关一起给 true 才全开',
  (() => {
    const all = normalizeAutomation({ acceptInvite: true, groupWhitelist: true, friendFromGroup: true, privateWhitelist: true, notifyOwner: true });
    return AUTOMATION_KEYS.every((k) => all[k] === true);
  })());

check('额度 0 保留（不被 || / ?? 吞成默认值）',
  normalizeAutomation({ dailyLimits: { friendApprove: 0 } }).dailyLimits.friendApprove === 0
  && normalizeAutomation({ dailyLimits: { inviteApprove: 0, whitelistWrite: 0 } }).dailyLimits.whitelistWrite === 0);
check('额度上界：999 → 50', normalizeAutomation({ dailyLimits: { friendApprove: 999 } }).dailyLimits.friendApprove === 50);
check('额度下界：-3 → 0', normalizeAutomation({ dailyLimits: { friendApprove: -3 } }).dailyLimits.friendApprove === 0);
check('额度非数字回落默认值：\'x\' → 5', normalizeAutomation({ dailyLimits: { friendApprove: 'x' } }).dailyLimits.friendApprove === 5);
check('额度取整：2.9 → 2', normalizeAutomation({ dailyLimits: { inviteApprove: 2.9 } }).dailyLimits.inviteApprove === 2);
check('额度接受数字字符串（手写 config.json 常见）', normalizeAutomation({ dailyLimits: { whitelistWrite: '7' } }).dailyLimits.whitelistWrite === 7);
check('额度空字符串/ null / undefined 一律回落默认',
  normalizeAutomation({ dailyLimits: { friendApprove: '' } }).dailyLimits.friendApprove === 5
  && normalizeAutomation({ dailyLimits: { friendApprove: null } }).dailyLimits.friendApprove === 5
  && normalizeAutomation({ dailyLimits: null }).dailyLimits.friendApprove === 5);
check('未知键忽略（不报错，便于以后加）',
  normalizeAutomation({ foo: true, dailyLimits: { bar: 9, friendApprove: 4 } }).dailyLimits.friendApprove === 4
  && normalizeAutomation({ foo: true }).acceptInvite === false);
check('不改入参（raw 与 raw.dailyLimits 都不被写）',
  (() => {
    const raw = { acceptInvite: 'true', dailyLimits: { friendApprove: 999 } };
    normalizeAutomation(raw);
    return raw.acceptInvite === 'true' && raw.dailyLimits.friendApprove === 999;
  })());
check('三维度键表与标签齐全',
  JSON.stringify(AUTOMATION_LIMIT_KINDS) === JSON.stringify(['friendApprove', 'inviteApprove', 'whitelistWrite'])
  && AUTOMATION_LIMIT_LABELS.friendApprove === '好友申请'
  && AUTOMATION_LIMIT_LABELS.inviteApprove === '入群邀请'
  && AUTOMATION_LIMIT_LABELS.whitelistWrite === '白名单写入');

// ── ② applyAutomationUpdate ────────────────────────────────────────────────
console.log('\n② applyAutomationUpdate');

const EMPTY_PATCH = '至少要改一项（acceptInvite / groupWhitelist / friendFromGroup / privateWhitelist / notifyOwner）';
check('第三条错误文案逐字：至少要改一项…', AUTOMATION_ERRORS.emptyPatch === EMPTY_PATCH && EMPTY_PATCH.includes('（acceptInvite / groupWhitelist / friendFromGroup / privateWhitelist / notifyOwner）'));
check('空 patch → 至少要改一项', (() => {
  const r = applyAutomationUpdate({}, {});
  return r.ok === false && r.error === EMPTY_PATCH;
})());
check('patch 不是对象（null / 字符串 / 数组）→ 至少要改一项',
  applyAutomationUpdate({}, null).error === EMPTY_PATCH
  && applyAutomationUpdate({}, 'x').error === EMPTY_PATCH
  && applyAutomationUpdate({}, []).error === EMPTY_PATCH);
check('未知键 → 不认识的配置项：foo', (() => {
  const r = applyAutomationUpdate({}, { foo: true });
  return r.ok === false && r.error === '不认识的配置项：foo';
})());
check('dailyLimits 不归控制台管 → 不认识的配置项：dailyLimits',
  applyAutomationUpdate({}, { dailyLimits: { friendApprove: 1 } }).error === '不认识的配置项：dailyLimits');
check('未知键与类型错同时出现时先报未知键',
  applyAutomationUpdate({}, { acceptInvite: 'yes', foo: true }).error === '不认识的配置项：foo');
check('类型错 → 开关必须是布尔值', (() => {
  const r = applyAutomationUpdate({}, { acceptInvite: 'yes' });
  return r.ok === false && r.error === '开关必须是布尔值';
})());
check('类型错：1 / null / undefined 都拒绝',
  applyAutomationUpdate({}, { acceptInvite: 1 }).error === '开关必须是布尔值'
  && applyAutomationUpdate({}, { acceptInvite: null }).error === '开关必须是布尔值'
  && applyAutomationUpdate({}, { acceptInvite: undefined }).error === '开关必须是布尔值');
check('正例：{acceptInvite:true} → ok + changed:[\'acceptInvite\']', (() => {
  const r = applyAutomationUpdate({}, { acceptInvite: true });
  return r.ok === true && r.automation.acceptInvite === true && JSON.stringify(r.changed) === '["acceptInvite"]';
})());
check('部分更新：只改被提交的键，其余保留原值', (() => {
  const r = applyAutomationUpdate({ privateWhitelist: true, acceptInvite: true }, { acceptInvite: false });
  return r.ok === true && r.automation.acceptInvite === false && r.automation.privateWhitelist === true;
})());
check('改回默认值也算 changed（真正的开→关）', (() => {
  const r = applyAutomationUpdate({ acceptInvite: true }, { acceptInvite: false });
  return r.ok === true && r.automation.acceptInvite === false && r.changed.includes('acceptInvite');
})());
check('同值重复提交 → changed 为空数组（控制台回执不会谎报「已改」）', (() => {
  const r = applyAutomationUpdate({ acceptInvite: true }, { acceptInvite: true });
  return r.ok === true && r.changed.length === 0;
})());
check('多键更新：changed 按提交顺序列出', (() => {
  const r = applyAutomationUpdate({}, { groupWhitelist: true, acceptInvite: true });
  return r.ok === true && JSON.stringify(r.changed) === '["groupWhitelist","acceptInvite"]';
})());
check('dailyLimits 原样保留（控制台改开关不会把额度冲掉）', (() => {
  const r = applyAutomationUpdate({ dailyLimits: { friendApprove: 0, inviteApprove: 50, whitelistWrite: 2 } }, { notifyOwner: false });
  return r.automation.dailyLimits.friendApprove === 0 && r.automation.dailyLimits.inviteApprove === 50
    && r.automation.dailyLimits.whitelistWrite === 2;
})());
check('返回的 automation 仍是冻结对象', Object.isFrozen(applyAutomationUpdate({}, { acceptInvite: true }).automation));
check('不改入参 rawAutomation', (() => {
  const raw = { acceptInvite: false };
  applyAutomationUpdate(raw, { acceptInvite: true });
  return raw.acceptInvite === false;
})());

// ── ③ dayKey / 时间格式 ────────────────────────────────────────────────────
console.log('\n③ dayKey / 时间格式');

check('dayKey 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dayKey(sh('2026-10-20T12:00:00'))), dayKey(sh('2026-10-20T12:00:00')));
check('dayKey 按上海时区：UTC 12:00 = 上海 20:00 仍是同一天',
  dayKey(Date.parse('2026-10-19T16:00:00.000Z')) === '2026-10-20');
check('dayKey 跨日边界：23:59 与 00:01 是两天',
  dayKey(sh('2026-10-19T23:59:00')) === '2026-10-19' && dayKey(sh('2026-10-20T00:01:00')) === '2026-10-20');
check('dayKey 跨日边界：UTC 23:59:59 已是上海次日 07:59',
  dayKey(Date.parse('2026-10-19T23:59:59.000Z')) === '2026-10-20');
check('clockKey 是 HH:mm', /^\d{2}:\d{2}$/.test(clockKey(sh('2026-10-20T20:31:00'))), clockKey(sh('2026-10-20T20:31:00')));
check('clockKey 按上海时区折算：12:34Z → 20:34', clockKey(Date.parse('2026-10-20T12:34:56.000Z')) === '20:34');
check('shanghaiTimestamp 形如 2026-10-20T20:31:02.441+08:00',
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/.test(shanghaiTimestamp(sh('2026-10-20T20:31:02.441'))),
  shanghaiTimestamp(sh('2026-10-20T20:31:02.441')));
check('shanghaiTimestamp 里的小时是上海本地小时（UTC 12:00 → 20 点）',
  shanghaiTimestamp(Date.parse('2026-10-20T12:00:00.000Z')).startsWith('2026-10-20T20:00:00.000+08:00'));

// ── ④ 额度 ─────────────────────────────────────────────────────────────────
console.log('\n④ rollQuotaState / takeQuota / markAlerted');

const DAY1 = sh('2026-10-20T10:00:00');
const DAY2 = sh('2026-10-21T10:00:00');
const LIMITS = { friendApprove: 2, inviteApprove: 1, whitelistWrite: 5 };

check('rollQuotaState 空状态 → 今天 + 全 0', (() => {
  const s = rollQuotaState(null, DAY1);
  return s.day === '2026-10-20' && s.counts.friendApprove === 0 && s.counts.inviteApprove === 0
    && s.counts.whitelistWrite === 0 && s.alerted.friendApprove === false;
})());
check('rollQuotaState 同一天保留计数', (() => {
  const s = rollQuotaState({ day: '2026-10-20', counts: { friendApprove: 1 }, alerted: { friendApprove: true } }, DAY1);
  return s.counts.friendApprove === 1 && s.alerted.friendApprove === true;
})());
check('rollQuotaState 跨天清零（含 alerted）', (() => {
  const s = rollQuotaState({ day: '2026-10-20', counts: { friendApprove: 2, inviteApprove: 1, whitelistWrite: 3 }, alerted: { friendApprove: true } }, DAY2);
  return s.day === '2026-10-21' && s.counts.friendApprove === 0 && s.counts.inviteApprove === 0
    && s.counts.whitelistWrite === 0 && s.alerted.friendApprove === false;
})());
check('rollQuotaState 不改入参', (() => {
  const raw = { day: '2026-10-20', counts: { friendApprove: 2 }, alerted: {} };
  rollQuotaState(raw, DAY2);
  return raw.counts.friendApprove === 2 && raw.day === '2026-10-20';
})());

let quotaState = rollQuotaState(null, DAY1);
const q1 = takeQuota(quotaState, 'friendApprove', LIMITS, DAY1);
quotaState = q1.state;
const q2 = takeQuota(quotaState, 'friendApprove', LIMITS, DAY1);
quotaState = q2.state;
const q3 = takeQuota(quotaState, 'friendApprove', LIMITS, DAY1);
check('takeQuota 连续取到上限前都 ok', q1.ok === true && q2.ok === true && quotaState.counts.friendApprove === 2);
check('takeQuota 到上限后返回 {ok:false, reason:\'limit\'}', q3.ok === false && q3.reason === 'limit');
check('takeQuota 被拒时不加计数', q3.state.counts.friendApprove === 2);
check('takeQuota 跨天后重新可发', takeQuota(quotaState, 'friendApprove', LIMITS, DAY2).ok === true);
check('takeQuota 不改入参（纯函数）', (() => {
  const raw = { day: '2026-10-20', counts: { friendApprove: 0, inviteApprove: 0, whitelistWrite: 0 }, alerted: {} };
  const before = JSON.stringify(raw);
  takeQuota(raw, 'friendApprove', LIMITS, DAY1);
  takeQuota(raw, 'inviteApprove', LIMITS, DAY1);
  return JSON.stringify(raw) === before;
})());
check('takeQuota 各类别互相独立', (() => {
  const base = rollQuotaState(null, DAY1);
  const one = takeQuota(base, 'inviteApprove', LIMITS, DAY1).state;
  return one.counts.inviteApprove === 1 && one.counts.friendApprove === 0 && one.counts.whitelistWrite === 0;
})());
check('额度 0 → 当天第一次就拒绝（0 是合法值，不是「没设置」）',
  takeQuota(rollQuotaState(null, DAY1), 'whitelistWrite', { friendApprove: 5, inviteApprove: 3, whitelistWrite: 0 }, DAY1).ok === false);
check('额度 0 的拒绝不会写计数',
  takeQuota(rollQuotaState(null, DAY1), 'whitelistWrite', { whitelistWrite: 0 }, DAY1).state.counts.whitelistWrite === 0);
check('额度上界 50 生效：50 次后拒绝', (() => {
  let s = rollQuotaState(null, DAY1);
  for (let i = 0; i < 50; i += 1) {
    const r = takeQuota(s, 'inviteApprove', { inviteApprove: 100 }, DAY1);
    if (!r.ok) return false;
    s = r.state;
  }
  return takeQuota(s, 'inviteApprove', { inviteApprove: 100 }, DAY1).ok === false;
})());

check('markAlerted 置位并返回新对象', (() => {
  const base = rollQuotaState(null, DAY1);
  const marked = markAlerted(base, 'friendApprove');
  return marked.alerted.friendApprove === true && base.alerted.friendApprove === false;
})());
check('markAlerted 不改入参', (() => {
  const base = { day: '2026-10-20', counts: {}, alerted: {} };
  markAlerted(base, 'quota');
  return base.alerted.quota === undefined;
})());
check('markAlerted 保留其它类别的告警位', (() => {
  const marked = markAlerted({ day: '2026-10-20', counts: {}, alerted: { inviteApprove: true } }, 'friendApprove');
  return marked.alerted.inviteApprove === true && marked.alerted.friendApprove === true;
})());

// ── ⑤ 通知文案（§10 逐字） ─────────────────────────────────────────────────
console.log('\n⑤ 通知文案');

check('同意好友申请（④ 开）逐字',
  formatApprovedFriend({ qq: 234567, groupId: 119212385, groupName: '摸鱼大队', privateWhitelist: true })
  === '已自动同意好友申请：234567（来自群「摸鱼大队」 119212385）',
  formatApprovedFriend({ qq: 234567, groupId: 119212385, groupName: '摸鱼大队', privateWhitelist: true }));
check('同意好友申请（④ 没开）逐字追加一句',
  formatApprovedFriend({ qq: 678901, groupId: 119212385, groupName: '摸鱼大队', privateWhitelist: false })
  === '已自动同意好友申请：678901（来自群「摸鱼大队」 119212385）。私聊白名单没开，它现在发消息不会回。',
  formatApprovedFriend({ qq: 678901, groupId: 119212385, groupName: '摸鱼大队' }));
check('同意入群邀请逐字', formatInviteApproved({ groupId: 119212385 }) === '已自动同意入群邀请：群 119212385',
  formatInviteApproved({ groupId: 119212385 }));
check('进群后加群聊白名单逐字',
  formatJoinedGroup({ groupId: 119212385, groupName: '摸鱼大队' }) === '已把群 119212385 加入群聊白名单，现在会响应这个群的消息了。',
  formatJoinedGroup({ groupId: 119212385 }));
check('加私聊白名单逐字（formatWhitelistAdded 两种 kind）',
  formatWhitelistAdded({ kind: 'private', id: 234567 }) === '已把 234567 加入私聊白名单。'
  && formatWhitelistAdded({ kind: 'groups', id: 119212385 }) === '已把群 119212385 加入群聊白名单，现在会响应这个群的消息了。');
check('额度用完逐字（好友申请）',
  formatQuotaExhausted({ kind: 'friendApprove', limit: 5 })
  === '今天的自动同意额度用完了：好友申请 上限 5 次。剩下的请求留到明天或你手动处理。',
  formatQuotaExhausted({ kind: 'friendApprove', limit: 5 }));
check('额度用完逐字（入群邀请 / 白名单写入）',
  formatQuotaExhausted({ kind: 'inviteApprove', limit: 3 }) === '今天的自动同意额度用完了：入群邀请 上限 3 次。剩下的请求留到明天或你手动处理。'
  && formatQuotaExhausted({ kind: 'whitelistWrite', limit: 5 }) === '今天的自动同意额度用完了：白名单写入 上限 5 次。剩下的请求留到明天或你手动处理。');
check('审计文案：同意好友申请（§5 例子逐字）',
  formatApprovedFriendLog({ qq: 234567, groupId: 119212385, groupName: '摸鱼大队' })
  === '已同意好友申请 234567（来自群「摸鱼大队」119212385）',
  formatApprovedFriendLog({ qq: 234567, groupId: 119212385, groupName: '摸鱼大队' }));
check('群名查不到时降级成「（来自群 <群号>）」，不留空引号', (() => {
  const notify = formatApprovedFriend({ qq: 234567, groupId: 119212385, groupName: '', privateWhitelist: true });
  const audit = formatApprovedFriendLog({ qq: 234567, groupId: 119212385, groupName: '  ' });
  return notify === '已自动同意好友申请：234567（来自群 119212385）'
    && audit === '已同意好友申请 234567（来自群 119212385）';
})(),
  formatApprovedFriend({ qq: 234567, groupId: 119212385, groupName: '' }));
check('审计文案：同意入群邀请 / 白名单写入',
  formatInviteApprovedLog({ groupId: 119212385 }) === '已同意入群邀请：群 119212385'
  && formatWhitelistAddedLog({ kind: 'private', id: 234567 }) === '已把 234567 加入私聊白名单'
  && formatWhitelistAddedLog({ kind: 'groups', id: 119212385 }) === '已把群 119212385 加入群聊白名单');
check('缺字段不抛错、不留 undefined', (() => {
  const a = formatApprovedFriend({});
  const b = formatApprovedFriendLog({});
  return typeof a === 'string' && !a.includes('undefined') && typeof b === 'string' && !b.includes('undefined');
})());

// ── ⑥ formatAutomationChange ───────────────────────────────────────────────
console.log('\n⑥ formatAutomationChange');

check('单项回执逐字（不带 automation 时按「开」）',
  formatAutomationChange(['acceptInvite']) === '已保存：自动同意入群邀请 = 开（不重启即生效）',
  formatAutomationChange(['acceptInvite']));
check('多项用顿号连接',
  formatAutomationChange(['acceptInvite', 'groupWhitelist']) === '已保存：自动同意入群邀请 = 开、自主添加群聊白名单 = 开（不重启即生效）',
  formatAutomationChange(['acceptInvite', 'groupWhitelist']));
check('带 automation 时按实际值写开/关',
  formatAutomationChange(['acceptInvite', 'notifyOwner'], { acceptInvite: false, notifyOwner: true })
  === '已保存：自动同意入群邀请 = 关、私聊通知管理员 = 开（不重启即生效）');
check('空数组不抛错', typeof formatAutomationChange([]) === 'string' && formatAutomationChange([]).startsWith('已保存：'));
check('五个键都有中文标签', AUTOMATION_KEYS.every((k) => typeof AUTOMATION_LABELS[k] === 'string' && AUTOMATION_LABELS[k].length > 0));

// ── ⑦ parseAuditTail ───────────────────────────────────────────────────────
console.log('\n⑦ parseAuditTail');

check('空串 → []', JSON.stringify(parseAuditTail('', 10)) === '[]');
check('null / undefined → []', parseAuditTail(null).length === 0 && parseAuditTail(undefined).length === 0);
check('坏行跳过不抛（"not json" + 空行）', (() => {
  const text = 'not json\n\n{"ts":"2026-10-20T20:31:02.441+08:00","kind":"friendApprove","ok":true,"text":"甲"}\n';
  const items = parseAuditTail(text, 10);
  return items.length === 1 && items[0].text === '甲';
})());
check('坏行夹在中间也跳过', (() => {
  const text = [
    '{"ts":"2026-10-20T20:31:00.000+08:00","kind":"skip","ok":false,"text":"一"}',
    '{"broken":',
    '{"ts":"2026-10-20T20:32:00.000+08:00","kind":"notify","ok":true,"text":"二"}'
  ].join('\n');
  const items = parseAuditTail(text, 10);
  return items.length === 2 && items[0].text === '一' && items[1].text === '二';
})());
check('超过 10 行只取尾部 10 行', (() => {
  const lines = [];
  for (let i = 0; i < 15; i += 1) {
    lines.push(JSON.stringify({ ts: `2026-10-20T2${i % 10}:00:00.000+08:00`, kind: 'skip', ok: false, text: `第${i}条` }));
  }
  const items = parseAuditTail(lines.join('\n'), 10);
  return items.length === 10 && items[0].text === '第5条' && items[9].text === '第14条';
})());
check('返回顺序是时间正序（最早在前）', (() => {
  const text = [
    '{"ts":"2026-10-20T20:30:00.000+08:00","kind":"skip","ok":false,"text":"早"}',
    '{"ts":"2026-10-20T20:40:00.000+08:00","kind":"quota","ok":false,"text":"晚"}'
  ].join('\n');
  const items = parseAuditTail(text, 10);
  return items[0].text === '早' && items[1].text === '晚';
})());
check('at 按 Asia/Shanghai 折算：12:34:56Z → 20:34', (() => {
  const items = parseAuditTail('{"ts":"2026-10-20T12:34:56.000Z","kind":"friendApprove","ok":true,"text":"x"}', 10);
  return items[0].at === '20:34';
})());
check('每项都有 at / kind / ok / text 四个键', (() => {
  const items = parseAuditTail('{"ts":"2026-10-20T20:34:00.000+08:00","kind":"quota","ok":false,"text":"额度"}', 10);
  const keys = Object.keys(items[0]).sort();
  return JSON.stringify(keys) === JSON.stringify(['at', 'kind', 'ok', 'text']) && items[0].ok === false && items[0].kind === 'quota';
})());
check('ok 只认 === true（缺省 / "true" / 1 都是 false）', (() => {
  const a = parseAuditTail('{"ts":"2026-10-20T20:00:00.000+08:00","kind":"x","text":"a"}', 1)[0];
  const b = parseAuditTail('{"ts":"2026-10-20T20:00:00.000+08:00","kind":"x","ok":"true","text":"b"}', 1)[0];
  const c = parseAuditTail('{"ts":"2026-10-20T20:00:00.000+08:00","kind":"x","ok":1,"text":"c"}', 1)[0];
  return a.ok === false && b.ok === false && c.ok === false;
})());
check('缺 ts 的条目 at 为空串、不抛错',
  parseAuditTail('{"kind":"skip","ok":false,"text":"无时间"}', 1)[0].at === '');
check('limit 非正整数时回落 10', (() => {
  const lines = [];
  for (let i = 0; i < 12; i += 1) lines.push(JSON.stringify({ ts: '2026-10-20T20:00:00.000+08:00', kind: 'skip', ok: false, text: `第${i}条` }));
  const text = lines.join('\n');
  return parseAuditTail(text, 0).length === 10 && parseAuditTail(text, -1).length === 10 && parseAuditTail(text, 3).length === 3;
})());

// ── ⑧ 审计写入往返（只碰临时目录） ─────────────────────────────────────────
console.log('\n⑧ auditEntry / appendAuditLine 往返');

check('auditEntry 补 ts 且 ts 是上海时区 ISO', (() => {
  const entry = auditEntry({ kind: 'friendApprove', ok: true, qq: 234567, text: '已同意' }, sh('2026-10-20T20:31:02.441'));
  return entry.ts === '2026-10-20T20:31:02.441+08:00' && entry.kind === 'friendApprove' && entry.ok === true
    && entry.qq === 234567 && entry.text === '已同意';
})());
check('auditEntry 字段顺序：ts / kind / ok / 明细 / text',
  JSON.stringify(Object.keys(auditEntry({ kind: 'skip', ok: false, qq: 1, groupId: 2, groupName: '群', text: 't' }, 0)))
  === JSON.stringify(['ts', 'kind', 'ok', 'qq', 'groupId', 'groupName', 'text']));
check('auditEntry 丢掉 undefined / null 明细', (() => {
  const entry = auditEntry({ kind: 'skip', ok: false, qq: null, groupId: 119212385, text: 't' }, 0);
  return !Object.prototype.hasOwnProperty.call(entry, 'qq') && entry.groupId === 119212385;
})());
check('auditEntry ok 只认 === true', auditEntry({ kind: 'skip', ok: 'true', text: 't' }, 0).ok === false);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-auto-test-'));
const auditFile = path.join(tmpDir, 'nested', 'social-auto.jsonl');
try {
  appendAuditLine(auditFile, auditEntry({ kind: 'friendApprove', ok: true, qq: 234567, groupId: 119212385, groupName: '摸鱼大队', text: formatApprovedFriendLog({ qq: 234567, groupId: 119212385, groupName: '摸鱼大队' }) }, sh('2026-10-20T20:31:02.441')));
  appendAuditLine(auditFile, auditEntry({ kind: 'notify', ok: true, text: formatApprovedFriend({ qq: 234567, groupId: 119212385, groupName: '摸鱼大队' }) }, sh('2026-10-20T20:31:03.000')));
  const raw = fs.readFileSync(auditFile, 'utf8');
  check('追加写入是两个独立行（一行一条）', raw.trim().split('\n').length === 2);
  check('写入的是紧凑 JSON（一行一条，便于 tail 读）', raw.includes('"kind":"friendApprove"') && !raw.includes('\n  '));
  const items = parseAuditTail(raw, 10);
  check('往返：读回 2 条、时间正序、at 为上海 HH:mm',
    items.length === 2 && items[0].at === '20:31' && items[1].at === '20:31',
    items.map((i) => `${i.at} ${i.kind}`).join(' | '));
  check('往返：text 原样（控制台直接显示这一行）',
    items[0].text === '已同意好友申请 234567（来自群「摸鱼大队」119212385）'
    && items[1].text === '已自动同意好友申请：234567（来自群「摸鱼大队」 119212385）。私聊白名单没开，它现在发消息不会回。');
  check('appendAuditLine 返回写入的记录', appendAuditLine(auditFile, auditEntry({ kind: 'skip', ok: false, text: 'x' }, 0)).kind === 'skip');
  check('审计文件里没有 token / 消息正文（只带 text 与明细白名单）', !raw.includes('Bearer') && !raw.includes('token'));
  check('审计文件权限是 0600', (fs.statSync(auditFile).mode & 0o777) === 0o600 || process.platform === 'win32',
    process.platform === 'win32' ? 'Windows 不校验 POSIX 权限位' : String(fs.statSync(auditFile).mode & 0o777));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed`);
process.exitCode = failed > 0 ? 1 : 0;
