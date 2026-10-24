// 人格绑定（T-035 阶段 C1）：会话 → 作用域 → 生效人格的解析，以及保存前的影响计算。
//
// 三态语义（dev-doc §3.2），**必须能区分**，所以绝不用 null 同时表达两者：
//   继承默认 = bindings 里**没有**这个 scope 的记录；
//   指定卡   = { mode: 'card', name: '<卡名>' }；
//   不用人格 = { mode: 'none' }（保留仿真预设，只是不注入人格卡）。
//
// 作用域（dev-doc §3.1）：
//   gid > 0 → cross:<gid>（同组共用一份绑定，组内不允许再叠成员级覆盖）；
//   gid = 0 → isolated:<会话key>（彼此独立，**绝不**聚合成「0 号组」）。
//
// 本模块是纯逻辑层：零 IO（不读 config.json / roles/）、不分配组号、不读时钟、
// 不依赖任何第三方模块。组号语义（0 = 不共享、只认非负整数、坏值给 null）刻意复用
// cross-core.js 的同一份实现 —— 这类规则各写一份必然漂移，而「0 是不是一个组」一旦
// 漂移就是人格串组。除了 node:crypto（revision 哈希）之外没有 import 之外的依赖。
//
// 为什么解析必须只读：打开控制台或查提示词不能顺带替会话创建组号（那会让「看一眼」
// 变成一次写盘，也会让两个并发的页面互相改号）。
import { createHash } from 'node:crypto';
import { groupOf, membersOf, normalizeGid } from './cross-core.js';

// 会话 key 的形状与 cross-core 保持一致（那里是模块私有的正则，这里只用来判断
// 「这个 key 认不认识」，真正的取值仍走 groupOf / membersOf）。
const CROSS_KEY_RE = /^(group|private):\d{1,20}$/;
const ISOLATED_SCOPE_RE = /^isolated:((?:group|private):\d{1,20})$/;
const BINDING_MODES = new Set(['card', 'none']);
// 卡缺失时的摘要前缀：'missing:<卡名>' 让「卡被删了」与「卡内容是空的」在比较时不等。
const MISSING_CARD_PREFIX = 'missing:';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return isPlainObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 按字符串排序（不用 localeCompare：revision 要跨机器稳定，只认码点序）。 */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * scope 归一：只认 `cross:<正整数>` 与 `isolated:<会话key>`。
 *
 * `cross:0` 不是合法作用域（0 = 不共享，作用域是 isolated:<key>），`cross:01` 归一成
 * `cross:1`（前端下拉框给字符串）。不认识的一律 null —— 调用方据此丢弃并记账。
 */
function normalizeScope(raw) {
  const scope = trimmed(raw);
  if (!scope) return null;
  const cross = /^cross:(\d+)$/.exec(scope);
  if (cross) {
    const gid = Number(cross[1]);
    return Number.isSafeInteger(gid) && gid > 0 ? `cross:${gid}` : null;
  }
  const isolated = ISOLATED_SCOPE_RE.exec(scope);
  return isolated ? `isolated:${isolated[1]}` : null;
}

/** 规范化后的普通对象（键按码点排序），保证 revision 与遍历顺序无关。 */
function sortedObject(object) {
  const out = {};
  for (const key of Object.keys(object).sort(byString)) out[key] = object[key];
  return out;
}

/**
 * 清洗 bindings：只留合法的 scope 与三态里的两种落地形态。
 *
 * 非法项**丢弃并记账**，不抛错 —— 配置是用户可手改的文件，一条写坏不能让桥接起不来，
 * 也不能让整块绑定被静默清空（那等于把所有人的选择换回默认人格）。
 *
 * `mode: 'inherit'` 是「删除该 scope 的绑定」的接口表达（dev-doc §5）：它不是非法项，
 * 归一结果里直接不出现（继承 = 没有记录），所以也不进 `dropped`。
 *
 * @param {unknown} raw
 * @param {{ allowScopes?: string[]|Set<string> }} [options]
 * @returns {{ bindings: Record<string, {mode:'card',name:string}|{mode:'none'}>, dropped: {scope:string, reason:string}[] }}
 */
export function normalizeRoleBindings(raw, options = {}) {
  const bindings = {};
  const dropped = [];
  const allowSource = options && options.allowScopes;
  const allowList = allowSource instanceof Set ? [...allowSource]
    : Array.isArray(allowSource) ? allowSource
      : null;
  const allow = allowList ? new Set(allowList.map((scope) => normalizeScope(scope)).filter(Boolean)) : null;

  if (raw === undefined || raw === null) return { bindings, dropped };
  if (!isPlainObject(raw)) {
    dropped.push({ scope: '(root)', reason: 'bindings 必须是对象' });
    return { bindings, dropped };
  }

  for (const rawScope of Object.keys(raw)) {
    const scope = normalizeScope(rawScope);
    if (!scope) {
      dropped.push({ scope: String(rawScope), reason: 'key 只允许 cross:<正整数> 或 isolated:<会话key>' });
      continue;
    }
    if (allow && !allow.has(scope)) {
      dropped.push({ scope, reason: '不在允许的作用域列表里' });
      continue;
    }
    const value = raw[rawScope];
    if (!isPlainObject(value)) {
      dropped.push({ scope, reason: '绑定值必须是对象' });
      continue;
    }
    const mode = trimmed(value.mode).toLowerCase();
    if (mode === 'inherit') continue; // 删除意图：不落记录，不算非法
    if (!BINDING_MODES.has(mode)) {
      dropped.push({ scope, reason: 'mode 只允许 card / none' });
      continue;
    }
    if (mode === 'none') {
      bindings[scope] = { mode: 'none' };
      continue;
    }
    const name = trimmed(value.name);
    if (!name) {
      dropped.push({ scope, reason: 'mode=card 时必须给 name' });
      continue;
    }
    bindings[scope] = { mode: 'card', name };
  }
  return { bindings, dropped };
}

/**
 * 互通组编号列表归一：升序去重正整数。
 *
 * 0 不是组（不共享），负数/小数/字符串垃圾一律丢弃 —— 这里是 `role.gids`（闲置组保号）
 * 的唯一清洗入口，坏值混进来会让 `nextGidFor` 直接跳到不存在的号上。
 */
export function normalizeRoleGids(raw) {
  const list = Array.isArray(raw) ? raw : raw instanceof Set ? [...raw] : [];
  const out = [];
  for (const item of list) {
    const gid = normalizeGid(item);
    if (gid === null || gid <= 0) continue;
    if (!out.includes(gid)) out.push(gid);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 有效编号集合 = `gids` ∪ groups 里出现过的 gid（只算 >0），升序。
 *
 * 「有效」= 这个号现在有意义（有成员，或被人格绑定保号）。会话编号 0 永远不在里面：
 * 它不是组，也没有「0 号组」可以让两个 gid=0 的会话共享人格。
 */
export function effectiveGids(groups, gids) {
  const set = new Set(normalizeRoleGids(gids));
  const source = isPlainObject(groups) ? groups : {};
  for (const key of Object.keys(source)) {
    const gid = groupOf(source, key);
    if (gid > 0) set.add(gid);
  }
  return [...set].sort((a, b) => a - b);
}

/** 新增互通组的编号 = max(有效编号 ∪ {0}) + 1（addendum §2：升序、不回头填空号）。 */
export function nextGidFor(groups, gids) {
  const list = effectiveGids(groups, gids);
  return (list.length ? list[list.length - 1] : 0) + 1;
}

/** 闲置组：写在 `gids` 里、但当前没有任何成员的号（绑定还在，编号继续占着）。 */
export function idleGids(groups, gids) {
  const used = new Set(effectiveGids(groups, []));
  return normalizeRoleGids(gids).filter((gid) => !used.has(gid));
}

/**
 * 会话 → 作用域。**只读，不分配组号**：没分组的会话是 isolated，而不是「补一个号」。
 * @returns {{ scope: string, gid: number }}
 */
export function scopeForConversation(key, groups) {
  const gid = groupOf(groups, key);
  return { scope: gid > 0 ? `cross:${gid}` : `isolated:${String(key ?? '').trim()}`, gid };
}

/**
 * 单个作用域的生效人格（组总览、独立会话行、冲突候选都用它，保证只有一条解析路径）。
 *
 * @param {string} scope `cross:<gid>` / `isolated:<key>`
 * @param {Record<string, any>} bindings
 * @param {string|null} defaultRole
 * @returns {{ scope: string, source: 'binding'|'none'|'default', mode: 'card'|'none'|'inherit', roleName: string|null }}
 */
export function resolveScopeRole(scope, bindings, defaultRole) {
  const record = own(bindings, scope) ? bindings[scope] : null;
  const fallback = trimmed(defaultRole) || null;
  if (isPlainObject(record) && record.mode === 'none') {
    return { scope, source: 'none', mode: 'none', roleName: null };
  }
  if (isPlainObject(record) && record.mode === 'card' && trimmed(record.name)) {
    return { scope, source: 'binding', mode: 'card', roleName: trimmed(record.name) };
  }
  // 没有记录 / 记录坏掉 → 继承默认。注意「继承 + 默认也没配」= 无人格（roleName null）。
  return { scope, source: 'default', mode: 'inherit', roleName: fallback };
}

/**
 * 会话的生效人格：作用域的显式设置 → 全局默认 → 无人格（不拼接多张卡）。
 * @returns {{ scope: string, gid: number, source: 'binding'|'none'|'default', mode: 'card'|'none'|'inherit', roleName: string|null }}
 */
export function resolveRoleBinding(key, groups, bindings, defaultRole) {
  const { scope, gid } = scopeForConversation(key, groups);
  const resolved = resolveScopeRole(scope, bindings, defaultRole);
  return { scope, gid, source: resolved.source, mode: resolved.mode, roleName: resolved.roleName };
}

/**
 * 某张卡被谁引用（改名 / 删除 / 编辑影响预览用）。
 *
 * `isDefault` 单独给出来：默认人格不是一条 scope 绑定，但在「删卡」这档事上它同样会让
 * 所有继承者失去人格，界面必须把它算进受影响范围（count = 绑定处 + 默认这一处）。
 */
export function listRoleReferences(name, bindings, defaultRole) {
  const target = trimmed(name);
  const normalized = normalizeRoleBindings(bindings).bindings;
  const refs = [];
  if (target) {
    for (const scope of Object.keys(normalized)) {
      const record = normalized[scope];
      if (record.mode === 'card' && record.name === target) refs.push(scope);
    }
  }
  const isDefault = Boolean(target) && trimmed(defaultRole) === target;
  return { isDefault, bindings: refs.sort(byString), count: refs.length + (isDefault ? 1 : 0) };
}

/** 卡片内容摘要（卡名 → 文件内容 sha1 前 8 位）里的那一项；没这张卡 / 没摘要返回 null。 */
export function roleCardDigest(roleName, cards) {
  const name = trimmed(roleName);
  if (!name) return null;
  const source = isPlainObject(cards) ? cards : {};
  const digest = trimmed(source[name]);
  return digest || null;
}

/**
 * 生效内容摘要：`<卡名>@<内容摘要>`，`none` 用 `'none'`，卡缺失用 `'missing:<卡名>'`。
 *
 * 为什么把卡名写进摘要：卡名会出现在注入文本里（「你是 <卡名>」这类小节很常见），
 * 换一张同内容但不同名的卡，模型看到的东西并不一样。宁可多重建一次，也不要让会话
 * 顶着旧名字继续说话。
 */
export function effectiveRoleDigest(resolved, cards) {
  const name = trimmed(resolved?.roleName);
  if (!resolved || resolved.mode === 'none' || !name) return 'none';
  const digest = roleCardDigest(name, cards);
  return `${name}@${digest ?? `${MISSING_CARD_PREFIX}${name}`}`;
}

/** 被 bindings / 默认人格点名的卡名（升序）；revision 只关心这些卡的内容。 */
export function referencedRoleNames(bindings, defaultRole) {
  const names = new Set();
  const normalized = normalizeRoleBindings(bindings).bindings;
  for (const scope of Object.keys(normalized)) {
    const record = normalized[scope];
    if (record.mode === 'card' && record.name) names.add(record.name);
  }
  const fallback = trimmed(defaultRole);
  if (fallback) names.add(fallback);
  return [...names].sort(byString);
}

/** 快照归一：缺字段补空、坏值丢弃，永远返回同一形状（plan / revision 共用）。 */
function normalizeSnapshot(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const groups = {};
  if (isPlainObject(source.groups)) {
    for (const key of Object.keys(source.groups)) {
      if (!CROSS_KEY_RE.test(key)) continue;
      const gid = normalizeGid(source.groups[key]);
      if (gid === null) continue;
      groups[key] = gid;
    }
  }
  const cards = {};
  if (isPlainObject(source.cards)) {
    for (const name of Object.keys(source.cards)) {
      if (!name) continue;
      const digest = trimmed(source.cards[name]);
      if (digest) cards[name] = digest;
    }
  }
  return {
    groups,
    gids: normalizeRoleGids(source.gids),
    bindings: normalizeRoleBindings(source.bindings).bindings,
    defaultRole: trimmed(source.defaultRole) || null,
    cards,
  };
}

/** 参与影响计算的会话 key：显式给的 + 两个快照里出现过的（后者保证新会话不会被漏算）。 */
function normalizeKeys(raw, prev, next) {
  const keys = new Set();
  for (const key of Array.isArray(raw) ? raw : []) {
    const value = trimmed(key);
    if (value) keys.add(value);
  }
  for (const snapshot of [prev, next]) {
    for (const key of Object.keys(snapshot.groups)) keys.add(key);
    for (const scope of Object.keys(snapshot.bindings)) {
      const isolated = ISOLATED_SCOPE_RE.exec(scope);
      if (isolated) keys.add(isolated[1]);
    }
  }
  return [...keys].sort(byString);
}

/** 快照里所有 cross 作用域的组号（有效编号 ∪ 绑定里点名的号），升序。 */
function crossScopeGids(snapshot) {
  const gids = new Set(effectiveGids(snapshot.groups, snapshot.gids));
  for (const scope of Object.keys(snapshot.bindings)) {
    const match = /^cross:(\d+)$/.exec(scope);
    if (match) gids.add(Number(match[1]));
  }
  return [...gids].filter((gid) => gid > 0).sort((a, b) => a - b);
}

/**
 * 合并冲突（dev-doc §6 / addendum §2）。
 *
 * 只认「**完整合并**」：某个 before 组的成员**全部**搬进了目标号，才算两组并成一组；
 * 单个成员搬进现有组是「迁入」，按目标组人格解析，不该报冲突。
 *
 * 判定比较的是**摘要**（卡名 + 内容），不是卡名：两组各绑一张内容相同的卡合并时不该
 * 拦人，而同一张卡在两个组里被复制成两份不同内容的卡时必须拦。
 */
function mergeConflicts(prev, next) {
  const conflicts = [];
  for (const gid of crossScopeGids(next)) {
    const scope = `cross:${gid}`;
    const members = membersOf(next.groups, gid);
    if (members.length === 0) continue;
    const beforeGids = new Set();
    for (const key of members) {
      const gidBefore = groupOf(prev.groups, key);
      if (gidBefore > 0) beforeGids.add(gidBefore);
    }
    if (beforeGids.size < 2) continue;
    const completeSources = [...beforeGids]
      .filter((beforeGid) => beforeGid !== gid)
      .filter((beforeGid) => {
        const beforeMembers = membersOf(prev.groups, beforeGid);
        return beforeMembers.length > 0 && beforeMembers.every((key) => groupOf(next.groups, key) === gid);
      });
    if (completeSources.length === 0) continue;
    const candidates = [];
    for (const candidateGid of [gid, ...completeSources].sort((a, b) => a - b)) {
      const resolved = resolveScopeRole(`cross:${candidateGid}`, prev.bindings, prev.defaultRole);
      if (!resolved.roleName) continue; // 没有合格人格的组不参与「人格不同」的比较
      candidates.push({
        gid: candidateGid,
        name: resolved.roleName,
        digest: effectiveRoleDigest(resolved, prev.cards),
      });
    }
    const digests = new Set(candidates.map((candidate) => candidate.digest));
    if (digests.size < 2) continue;
    conflicts.push({
      type: 'merge-persona',
      scope,
      candidates: candidates.map(({ gid: candidateGid, name }) => ({ gid: candidateGid, name })),
      message: '合并后两个人格不同，必须选择最终人格',
    });
  }
  return conflicts.sort((a, b) => byString(a.scope, b.scope));
}

/**
 * 保存前的影响计算（**只读**，不落盘、不退役）。
 *
 * @param {{groups?:object,gids?:number[],bindings?:object,defaultRole?:string|null,cards?:object}} before
 * @param {typeof before} after
 * @param {{ keys?: string[] }} [options] keys = 当前所有会话 key（含只存在于 bindings 的 isolated 作用域）
 * @returns {{
 *   rebuild: {key:string,scopeBefore:string,scopeAfter:string,roleBefore:string|null,roleAfter:string|null,reason:'new'|'scope'|'content'|'default'}[],
 *   rebindOnly: {key:string,scope:string,roleName:string|null}[],
 *   unchangedScopes: {scope:string,members:number}[],
 *   missing: {scope:string,name:string}[],
 *   conflicts: {type:'merge-persona',scope:string,candidates:{gid:number,name:string}[],message:string}[],
 *   invalid: {scope:string,reason:string}[]
 * }}
 */
export function planRoleChanges(before, after, options = {}) {
  const prev = normalizeSnapshot(before);
  const next = normalizeSnapshot(after);
  const keys = normalizeKeys(options?.keys, prev, next);

  const rebuild = [];
  const rebindOnly = [];
  const changedScopes = new Set();
  const scopeMembers = new Map();

  for (const key of keys) {
    const prevResolved = resolveRoleBinding(key, prev.groups, prev.bindings, prev.defaultRole);
    const nextResolved = resolveRoleBinding(key, next.groups, next.bindings, next.defaultRole);
    scopeMembers.set(nextResolved.scope, (scopeMembers.get(nextResolved.scope) ?? 0) + 1);

    const digestBefore = effectiveRoleDigest(prevResolved, prev.cards);
    const digestAfter = effectiveRoleDigest(nextResolved, next.cards);
    // 「这个会话之前就存在吗」：只看两个能留下痕迹的地方（分组表 / 独立会话绑定）。
    // 新会话（第一次进 config）没有痕迹，按 new 记 —— 它本来就没有旧上下文要退役。
    const existed = own(prev.groups, key) || own(prev.bindings, `isolated:${key}`);
    const entry = {
      key,
      scopeBefore: prevResolved.scope,
      scopeAfter: nextResolved.scope,
      roleBefore: prevResolved.roleName,
      roleAfter: nextResolved.roleName,
    };

    if (!existed) {
      rebuild.push({ ...entry, reason: 'new' });
      changedScopes.add(nextResolved.scope);
      continue;
    }
    // 作用域变了就必须重建：共享边界换了，旧会话里的上下文属于另一组（dev-doc §6）。
    // 哪怕生效人格一模一样（例如组 1 → 组 2 都绑同一张卡），也不能沿用。
    if (prevResolved.scope !== nextResolved.scope) {
      rebuild.push({ ...entry, reason: 'scope' });
      changedScopes.add(nextResolved.scope);
      continue;
    }
    if (digestBefore !== digestAfter) {
      // 继承者因默认人格变化而变 → default；其余（换卡、改卡内容、显式 none）→ content。
      const reason = nextResolved.source === 'default' && prev.defaultRole !== next.defaultRole ? 'default' : 'content';
      rebuild.push({ ...entry, reason });
      changedScopes.add(nextResolved.scope);
      continue;
    }
    // 作用域与生效摘要都没变，只是「继承」变成「显式绑同一张卡」（或反过来）：
    // 未来的行为不同（显式卡不再跟随默认），但此刻不需要重建会话。
    if (prevResolved.source !== nextResolved.source || prevResolved.mode !== nextResolved.mode) {
      rebindOnly.push({ key, scope: nextResolved.scope, roleName: nextResolved.roleName });
      changedScopes.add(nextResolved.scope);
    }
  }

  // 卡缺失：解析出 card 但 cards 里没有这张。含闲置组（组上绑的卡被删了）与
  // 被默认选中的卡（默认卡被删 → 所有继承者都缺卡）。按 scope 去重。
  const missingByScope = new Map();
  const scopeList = new Set();
  for (const gid of crossScopeGids(next)) scopeList.add(`cross:${gid}`);
  for (const key of keys) {
    if (groupOf(next.groups, key) <= 0) scopeList.add(`isolated:${key}`);
  }
  for (const scope of Object.keys(next.bindings)) {
    if (ISOLATED_SCOPE_RE.test(scope)) scopeList.add(scope);
  }
  for (const scope of [...scopeList].sort(byString)) {
    const resolved = resolveScopeRole(scope, next.bindings, next.defaultRole);
    if (resolved.mode !== 'card' || !resolved.roleName) continue;
    if (!roleCardDigest(resolved.roleName, next.cards)) {
      missingByScope.set(scope, { scope, name: resolved.roleName });
    }
  }
  const missing = [...missingByScope.values()].sort((a, b) => byString(a.scope, b.scope));

  const unchangedScopes = [...scopeMembers.entries()]
    .filter(([scope]) => !changedScopes.has(scope))
    .map(([scope, members]) => ({ scope, members }))
    .sort((a, b) => byString(a.scope, b.scope));

  // 绑定指向「既不在 gids 里、也没有成员」的组号：属于配置残留（通常是手改或删组成员
  // 时漏清绑定），保存前要能看见，否则它会变成一个永远不出现的幽灵组。
  const effective = new Set(effectiveGids(next.groups, next.gids));
  const invalid = Object.keys(next.bindings)
    .filter((scope) => scope.startsWith('cross:'))
    .map((scope) => ({ scope, gid: Number(scope.slice('cross:'.length)) }))
    .filter(({ gid }) => !effective.has(gid))
    .map(({ scope }) => ({ scope, reason: 'gid 不在 gids 里且无成员' }))
    .sort((a, b) => byString(a.scope, b.scope));

  return {
    rebuild,
    rebindOnly,
    unchangedScopes,
    missing,
    conflicts: mergeConflicts(prev, next),
    invalid,
  };
}

/**
 * 快照版本（opaque revision）：`'r-' + sha1(规范化 JSON) 前 8 位`。
 *
 * 参与的项：groups / gids / bindings / defaultRole / **被引用或被默认选中的卡**的内容摘要。
 * 不参与：卡片的 mtime / size（同一秒同一长度重写必须能被认出来）、没被任何作用域引用的
 * 卡（改它不该让别人的保存失效）。
 *
 * 入参先规范化（键排序、gids 升序、bindings 清洗），所以同内容必然同 revision ——
 * 两个页面同时打开时，409 只会在**真的**有人改过东西时出现。
 */
export function revisionOf(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const cards = {};
  for (const name of referencedRoleNames(normalized.bindings, normalized.defaultRole)) {
    const digest = roleCardDigest(name, normalized.cards);
    if (digest) cards[name] = digest;
  }
  const payload = JSON.stringify({
    groups: sortedObject(normalized.groups),
    gids: normalized.gids,
    bindings: sortedObject(normalized.bindings),
    defaultRole: normalized.defaultRole,
    cards: sortedObject(cards),
  });
  return `r-${createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 8)}`;
}
