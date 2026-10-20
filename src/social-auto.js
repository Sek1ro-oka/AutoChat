// 社交自动化（入群邀请 / 好友申请）的纯逻辑模块。
//
// 口径来自 work/agent-tasks/T-009/dev-doc.md（§3 配置契约 / §4 导出 / §5 状态与审计 /
// §7 四条流程 / §10 文案）。三条容易做错的硬约束：
//
//   1. **fail-closed**：开关只有 `=== true` 才算开；`"true"`、`1`、缺省一律当关。
//      这与二代工具开关（bridge.js 的 v2ToolEnabled，`!== false` 即开）**相反**，
//      故意不复用那一套：本模块是「桥接自己动手同意别人的请求」，默认必须是什么都不做。
//   2. **额度 0 合法**：`dailyLimits` 夹到 [0, 50]，0 表示「今天不做这类动作」。
//      所以这里绝不能写 `Number(v) || 默认值`（0 会被 `||` 吞成默认值）。
//   3. **审计 `text` 是人话**：控制台「最近自动动作」直接显示这一行，不是给机器看的字段堆。
//      审计文件同时是 GET /api/socialV2/automation 里 `recent` 的**唯一数据源**。
//
// I/O 只有两个口子：`appendAuditLine`（追加一行审计）与调用方传入的文本；
// 时钟一律由调用方传 `now`（毫秒），这样单测不用碰真实 state/、不用等真实时间。

import fs from 'node:fs';
import path from 'node:path';

export const AUTOMATION_DEFAULTS = Object.freeze({
  acceptInvite: false,
  groupWhitelist: false,
  friendFromGroup: false,
  privateWhitelist: false,
  // 唯一 fail-open 的键：自动动作默认要通知管理员（关掉才静默）。
  notifyOwner: true,
  dailyLimits: Object.freeze({ friendApprove: 5, inviteApprove: 3, whitelistWrite: 5 })
});

/** 控制台可改的 5 个布尔开关（dailyLimits 不在控制台可调，见 clarify.md §8）。 */
export const AUTOMATION_KEYS = Object.freeze([
  'acceptInvite',
  'groupWhitelist',
  'friendFromGroup',
  'privateWhitelist',
  'notifyOwner'
]);

export const AUTOMATION_LIMITS = Object.freeze({ min: 0, max: 50 });

/** 三个额度类别的机器名，顺序固定（GET 的 today.counts 按这个顺序输出）。 */
export const AUTOMATION_LIMIT_KINDS = Object.freeze(['friendApprove', 'inviteApprove', 'whitelistWrite']);

/** 额度类别的人话名（用在「今天的自动同意额度用完了：…」里）。 */
export const AUTOMATION_LIMIT_LABELS = Object.freeze({
  friendApprove: '好友申请',
  inviteApprove: '入群邀请',
  whitelistWrite: '白名单写入'
});

/** 开关的人话名（用在控制台回执「已保存：… = 开」里）。 */
export const AUTOMATION_LABELS = Object.freeze({
  acceptInvite: '自动同意入群邀请',
  groupWhitelist: '自主添加群聊白名单',
  friendFromGroup: '白名单群里的人添加好友',
  privateWhitelist: '自主添加私聊白名单',
  notifyOwner: '私聊通知管理员'
});

/** 三条错误文案：一字不差（dev-doc §3.1 / §4 / §9）。 */
export const AUTOMATION_ERRORS = Object.freeze({
  unknownKey: (key) => `不认识的配置项：${key}`,
  emptyPatch: '至少要改一项（acceptInvite / groupWhitelist / friendFromGroup / privateWhitelist / notifyOwner）',
  notBoolean: '开关必须是布尔值'
});

const SHANGHAI = 'Asia/Shanghai';
// 上海自 1991 年起不再用夏令时（固定 UTC+8），所以审计时间戳可以直接用偏移量算；
// dayKey/at 仍然走 Intl（显式时区名，比手算偏移更难写错跨日逻辑）。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const CLOCK_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHANGHAI,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function toMillis(now) {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatParts(formatter, ms) {
  const parts = formatter.formatToParts(new Date(ms));
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

/** 上海自然日的 key，形如 '2026-10-20'。 */
export function dayKey(now = Date.now()) {
  const parts = formatParts(DAY_FORMATTER, toMillis(now));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 上海时区的 'HH:mm'（审计记录折算出来的 at）。 */
export function clockKey(now = Date.now()) {
  const parts = formatParts(CLOCK_FORMATTER, toMillis(now));
  return `${parts.hour}:${parts.minute}`;
}

/** 上海时区的 ISO 时间戳，形如 '2026-10-20T20:31:02.441+08:00'（审计的 ts 字段）。 */
export function shanghaiTimestamp(now = Date.now()) {
  const local = new Date(toMillis(now) + SHANGHAI_OFFSET_MS);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const clock = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${date}T${clock}.${pad(local.getUTCMilliseconds(), 3)}+08:00`;
}

/** 把额度值归一化：整数、夹到 [0, 50]、非数字回落默认值；**0 保留**。 */
function clampLimit(value, fallback) {
  let numeric = Number.NaN;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return Math.min(AUTOMATION_LIMITS.max, Math.max(AUTOMATION_LIMITS.min, truncated));
}

function toCount(value) {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.trunc(numeric);
}

/** 配置归一化：布尔 fail-closed，额度 0 合法。返回冻结的新对象，不改入参。 */
export function normalizeAutomation(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const automation = {};
  for (const key of AUTOMATION_KEYS) {
    if (key === 'notifyOwner') {
      // notifyOwner 是唯一 fail-open 的键（dev-doc §3.1 表）：缺省 = 开 —— 「不通知管理员」
      // 必须显式写 false 才生效；写了认不出的值仍按 fail-closed 当关，避免 `"yes"` 被猜成开。
      automation[key] = source[key] === undefined ? AUTOMATION_DEFAULTS.notifyOwner : source[key] === true;
    } else {
      automation[key] = source[key] === true;
    }
  }
  const limits = {};
  for (const kind of AUTOMATION_LIMIT_KINDS) {
    limits[kind] = clampLimit(source.dailyLimits?.[kind], AUTOMATION_DEFAULTS.dailyLimits[kind]);
  }
  automation.dailyLimits = Object.freeze(limits);
  return Object.freeze(automation);
}

/**
 * 控制台提交的部分更新：白名单键 + 形状检查 + 归一化。
 *
 * 返回 `{ok:true, automation, changed:[...]}` 或 `{ok:false, error}`。
 * `changed` 只列**真的变了**的键（同一值重复提交时为空数组），控制台回执按它拼文案。
 */
export function applyAutomationUpdate(rawAutomation, patch) {
  const current = normalizeAutomation(rawAutomation);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: AUTOMATION_ERRORS.emptyPatch };
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, error: AUTOMATION_ERRORS.emptyPatch };
  for (const key of keys) {
    if (!AUTOMATION_KEYS.includes(key)) return { ok: false, error: AUTOMATION_ERRORS.unknownKey(key) };
  }
  for (const key of keys) {
    if (typeof patch[key] !== 'boolean') return { ok: false, error: AUTOMATION_ERRORS.notBoolean };
  }
  const next = {};
  for (const key of AUTOMATION_KEYS) next[key] = patch[key] === undefined ? current[key] : patch[key];
  const automation = normalizeAutomation({ ...next, dailyLimits: current.dailyLimits });
  const changed = keys.filter((key) => current[key] !== automation[key]);
  return { ok: true, automation, changed };
}

/** 读/初始化额度状态；跨天自动清零（返回新对象，不改入参）。 */
export function rollQuotaState(state, now = Date.now()) {
  const today = dayKey(now);
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const sameDay = source.day === today;
  const counts = {};
  const alerted = {};
  for (const kind of AUTOMATION_LIMIT_KINDS) {
    counts[kind] = sameDay ? toCount(source.counts?.[kind]) : 0;
    alerted[kind] = sameDay ? source.alerted?.[kind] === true : false;
  }
  return { day: today, counts, alerted };
}

/** 试占一次额度：返回 {ok:true, state} / {ok:false, reason:'limit', state}。纯函数。 */
export function takeQuota(state, kind, limits, now = Date.now()) {
  const rolled = rollQuotaState(state, now);
  if (!AUTOMATION_LIMIT_KINDS.includes(kind)) return { ok: false, reason: 'limit', state: rolled };
  const limit = clampLimit(limits?.[kind], AUTOMATION_DEFAULTS.dailyLimits[kind]);
  const used = rolled.counts[kind] ?? 0;
  // 额度 0 = 当天不做这类动作：0 >= 0 直接挡住，不能因为「0 是假值」放行。
  if (used >= limit) return { ok: false, reason: 'limit', state: rolled };
  return {
    ok: true,
    state: { day: rolled.day, counts: { ...rolled.counts, [kind]: used + 1 }, alerted: { ...rolled.alerted } }
  };
}

/** 记下「这一类额度已经告过警」，避免同一天反复私聊刷屏。返回新对象。 */
export function markAlerted(state, kind) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    day: typeof source.day === 'string' ? source.day : '',
    counts: { ...(source.counts ?? {}) },
    alerted: { ...(source.alerted ?? {}), [kind]: true }
  };
}

// ── 通知文案（私聊 ownerQQ）与审计文案（控制台「最近自动动作」） ─────────────
// 私聊文案严格照 dev-doc §10 的表格，一个字都不改；审计的 text 是同一件事的**记录式**说法
// （§5 的例子：「已同意好友申请 234567（来自群「摸鱼大队」119212385）」）。

/** §10 row 1 / row 2：同意好友申请；④ 没开时追加一句「私聊白名单没开…」。
 *  群名查不到（get_group_info 失败/退群）时降级成「（来自群 <群号>）」，不留空引号。 */
export function formatApprovedFriend({ qq, groupId, groupName, privateWhitelist } = {}) {
  const name = String(groupName ?? '').trim();
  const from = name ? `（来自群「${name}」 ${groupId ?? ''}）` : `（来自群 ${groupId ?? ''}）`;
  const base = `已自动同意好友申请：${qq ?? ''}${from}`;
  return privateWhitelist === true ? base : `${base}。私聊白名单没开，它现在发消息不会回。`;
}

/** §10 row 3：同意入群邀请。 */
export function formatInviteApproved({ groupId } = {}) {
  return `已自动同意入群邀请：群 ${groupId ?? ''}`;
}

/** §10 row 4：进群后自动加群聊白名单。 */
export function formatJoinedGroup({ groupId } = {}) {
  return `已把群 ${groupId ?? ''} 加入群聊白名单，现在会响应这个群的消息了。`;
}

/** §10 row 4 / row 5：白名单写入（groups → 群，private → QQ）。 */
export function formatWhitelistAdded({ kind, id } = {}) {
  return kind === 'groups'
    ? `已把群 ${id ?? ''} 加入群聊白名单，现在会响应这个群的消息了。`
    : `已把 ${id ?? ''} 加入私聊白名单。`;
}

/** §10 row 6：额度用完（每天只发一次）。 */
export function formatQuotaExhausted({ kind, limit } = {}) {
  const label = AUTOMATION_LIMIT_LABELS[kind] ?? kind;
  return `今天的自动同意额度用完了：${label} 上限 ${limit} 次。剩下的请求留到明天或你手动处理。`;
}

/** 审计用：同意好友申请（§5 的例子逐字一致，注意「」与群号之间没有空格）。
 *  群名查不到时同样降级成「（来自群 <群号>）」。 */
export function formatApprovedFriendLog({ qq, groupId, groupName } = {}) {
  const name = String(groupName ?? '').trim();
  const from = name ? `（来自群「${name}」${groupId ?? ''}）` : `（来自群 ${groupId ?? ''}）`;
  return `已同意好友申请 ${qq ?? ''}${from}`;
}

/** 审计用：同意入群邀请。 */
export function formatInviteApprovedLog({ groupId } = {}) {
  return `已同意入群邀请：群 ${groupId ?? ''}`;
}

/** 审计用：白名单写入。 */
export function formatWhitelistAddedLog({ kind, id } = {}) {
  return kind === 'groups' ? `已把群 ${id ?? ''} 加入群聊白名单` : `已把 ${id ?? ''} 加入私聊白名单`;
}

/** 控制台回执：`已保存：自动同意入群邀请 = 开（不重启即生效）`，多项用顿号连接。 */
export function formatAutomationChange(changed, automation) {
  const keys = Array.isArray(changed) ? changed : [];
  const parts = keys.map((key) => {
    const label = AUTOMATION_LABELS[key] ?? key;
    const on = automation ? automation[key] === true : true;
    return `${label} = ${on ? '开' : '关'}`;
  });
  return `已保存：${parts.join('、')}（不重启即生效）`;
}

// ── 审计日志 ────────────────────────────────────────────────────────────────
// 一行一条 JSON：{ts, kind, ok, 明细…, text}。
// kind ∈ friendApprove | inviteApprove | whitelistWrite | skip | quota | notify。
// 不写 token、不写消息正文。

/** 补上 ts 并保持字段顺序：ts / kind / ok / 明细 / text。不写 undefined 字段。 */
export function auditEntry(entry = {}, now = Date.now()) {
  const { kind, ok, text, ...detail } = entry;
  const record = { ts: shanghaiTimestamp(now), kind: String(kind ?? ''), ok: ok === true };
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null) continue;
    record[key] = value;
  }
  record.text = String(text ?? '');
  return record;
}

/**
 * 追加一行审计（本模块唯一的写盘口子）。
 * 返回写入的那条记录，调用方可直接拿去断言/复用。
 */
export function appendAuditLine(file, entry) {
  const record = entry && typeof entry.ts === 'string' ? entry : auditEntry(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

/**
 * 读审计文件尾部最多 `limit` 条，按时间正序返回，每项
 * `{at:'HH:mm', kind, ok, text}`。坏行（不是 JSON / 不是对象）跳过，不抛错 ——
 * 审计文件是运行期追加的，写一半断电留下的半行不能把 GET 弄成 500。
 */
export function parseAuditTail(text, limit = 10) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const lines = String(text ?? '').split('\n');
  const items = [];
  for (let i = lines.length - 1; i >= 0 && items.length < max; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    let at = typeof entry.at === 'string' ? entry.at.trim() : '';
    if (!at && typeof entry.ts === 'string') {
      const ms = Date.parse(entry.ts);
      if (Number.isFinite(ms)) at = clockKey(ms);
    }
    items.push({
      at,
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      ok: entry.ok === true,
      text: typeof entry.text === 'string' ? entry.text : ''
    });
  }
  items.reverse();
  return items;
}
