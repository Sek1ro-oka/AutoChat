// 人格绑定纯函数（src/role-binding.js）的单测。
//
// 跑法：`node scripts/test-role-binding.mjs`（全过 exit 0，有失败 exit 1）。
//
// 零 IO：不读 config.json / roles/、不碰 state/、不连网络、不读时钟。
// 覆盖（对应 tasks/T-035 的 C1 验收点）：
//   组1  normalizeRoleBindings：三态、丢弃非法项、inherit = 删除、scope 归一、allowScopes
//   组2  normalizeRoleGids / effectiveGids / nextGidFor / idleGids：升序、去重、0 不占号、
//        闲置组占号（gids=[1,2,3] 且组 3 无成员 → next=4）
//   组3  scopeForConversation / resolveRoleBinding：同组一致、组间不同、gid=0 互不影响、
//        inherit（无记录）vs none（有记录）、只读不分配组号
//   组4  listRoleReferences / roleCardDigest / effectiveRoleDigest：引用范围与卡缺失
//   组5  planRoleChanges：默认变化只影响继承者、scope 变化即使内容相同也重建、
//        绑法变化但内容相同 → rebindOnly、卡缺失、invalid 残留号、新会话
//   组6  合并冲突：人格相同不拦、人格不同 409（candidates 两个组）
//   组7  revisionOf：同内容同 revision（键序无关）、被引用卡改内容 → revision 变但 rebuild 为空、
//        未被引用的卡改内容 → revision 不变
import {
  normalizeRoleBindings,
  normalizeRoleGids,
  effectiveGids,
  nextGidFor,
  idleGids,
  scopeForConversation,
  resolveRoleBinding,
  resolveScopeRole,
  listRoleReferences,
  roleCardDigest,
  effectiveRoleDigest,
  referencedRoleNames,
  planRoleChanges,
  revisionOf
} from '../src/role-binding.js';

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failures.push(name);
  console.log(`FAIL ${name}${extra === undefined ? '' : ` —— ${extra}`}`);
}

/** 递归按键名排序后 JSON 化：结构等价比较（不受字段顺序影响）。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const same = (actual, expected) => stable(actual) === stable(expected);

// ── 基础夹具 ────────────────────────────────────────────────────────────────
// 组 1：一个群 + 一个私聊；组 2：一个群；gid=0：两条互不相干的私聊；组 3：闲置（无成员，只靠 gids 保号）。
const GROUPS = {
  'group:10001': 1,
  'private:20001': 1,
  'group:20002': 2,
  'private:20004': 0,
  'private:20005': 0
};
const BINDINGS = {
  'cross:1': { mode: 'card', name: '甲' },
  'cross:2': { mode: 'card', name: '乙' },
  'isolated:private:20004': { mode: 'none' }
};
const CARDS = { 甲: 'aaaa1111', 乙: 'bbbb2222', 丙: 'cccc3333' };

function snapshot(overrides = {}) {
  return {
    groups: { ...GROUPS },
    gids: [1, 2, 3],
    bindings: { ...BINDINGS },
    defaultRole: '甲',
    cards: { ...CARDS },
    ...overrides
  };
}

// ── 组1：normalizeRoleBindings ──────────────────────────────────────────────
console.log('\n── 组1：normalizeRoleBindings ────────────────────────────');

{
  const result = normalizeRoleBindings({
    'cross:1': { mode: 'card', name: '  甲  ' },
    'cross:05': { mode: 'card', name: '丙' },
    'cross:0': { mode: 'card', name: '甲' },
    'cross:2': { mode: 'weird' },
    'cross:3': { mode: 'card' },
    'cross:4': 'not-an-object',
    'foo:1': { mode: 'none' },
    'isolated:private:20004': { mode: 'none' }
  });
  check('card 模式保留并去掉名字两端空白', result.bindings['cross:1']?.name === '甲');
  check('cross:05 归一成 cross:5（前导零不另起一个组）', result.bindings['cross:5']?.name === '丙');
  check('cross:0 不是合法作用域（0 = 不共享，作用域是 isolated）', !result.bindings['cross:0']);
  check('非法 mode 丢弃并记账', !result.bindings['cross:2'] && result.dropped.some((d) => d.scope === 'cross:2'));
  check('card 缺 name 丢弃', !result.bindings['cross:3'] && result.dropped.some((d) => d.scope === 'cross:3'));
  check('绑定值不是对象丢弃', !result.bindings['cross:4']);
  check('不认识的 key 丢弃', !result.bindings['foo:1']);
  check('none 只保留 mode（不留多余字段）', same(result.bindings['isolated:private:20004'], { mode: 'none' }));
  check('丢弃项数量对得上（cross:0/cross:2/cross:3/cross:4/foo:1）', result.dropped.length === 5, result.dropped.length);
  check('返回形状是 { bindings, dropped }', Object.keys(result).sort().join(',') === 'bindings,dropped');
}

{
  const result = normalizeRoleBindings({ 'cross:1': { mode: 'inherit' } });
  check('mode=inherit 表示删除（不落记录、也不算非法）',
    Object.keys(result.bindings).length === 0 && result.dropped.length === 0);
  const allow = normalizeRoleBindings({ 'cross:1': { mode: 'none' }, 'cross:2': { mode: 'none' } }, { allowScopes: ['cross:1'] });
  check('allowScopes 只留列表里的作用域', Object.keys(allow.bindings).join(',') === 'cross:1'
    && allow.dropped.some((d) => d.scope === 'cross:2'));
  check('缺省 / null / 坏形状都不抛', [
    normalizeRoleBindings(undefined).bindings,
    normalizeRoleBindings(null).bindings,
    normalizeRoleBindings([]).bindings,
    normalizeRoleBindings('x').bindings
  ].every((bindings) => same(bindings, {})));
}

// ── 组2：编号归一 / 有效编号 / 下一号 / 闲置组 ─────────────────────────────
console.log('\n── 组2：编号归一与闲置组 ────────────────────────────────');

check('normalizeRoleGids 升序去重并只留正整数',
  same(normalizeRoleGids(['3', 3, 0, -1, 2.5, 'x', null, 1]), [1, 3]));
check('normalizeRoleGids 坏形状回空数组', same(normalizeRoleGids('nope'), []) && same(normalizeRoleGids(undefined), []));
check('effectiveGids = gids ∪ groups 里的号（0 不算）',
  same(effectiveGids({ 'group:1': 1, 'group:2': 3, 'private:9': 0 }, [2]), [1, 2, 3]));
check('下一号 = max(有效编号)+1，闲置组占号不回头填空号',
  nextGidFor({ 'group:1': 1, 'group:2': 2 }, [1, 2, 3]) === 4);
check('没有编号时下一号从 1 开始', nextGidFor({}, []) === 1);
check('0 号会话不参与编号（不然第一个新会话会从 1 被顶成 2）',
  nextGidFor({ 'private:9': 0 }, []) === 1);
check('idleGids 只报「写在 gids 里但没成员」的号', same(idleGids({ 'group:1': 1, 'group:2': 2 }, [1, 2, 3]), [3]));
check('idleGids 保留也有成员的号不在里面', same(idleGids({ 'group:1': 1 }, [1, 3]), [3]));
check('idleGids 不把 gid=0 的会话算成「0 号组」', same(idleGids({ 'private:9': 0 }, [1]), [1]));

// ── 组3：作用域与人格解析 ───────────────────────────────────────────────────
console.log('\n── 组3：作用域与人格解析 ────────────────────────────────');

const bindingsOf = (raw) => normalizeRoleBindings(raw).bindings;
const bindings = bindingsOf(BINDINGS);

{
  const a = resolveRoleBinding('group:10001', GROUPS, bindings, '甲');
  const b = resolveRoleBinding('private:20001', GROUPS, bindings, '甲');
  check('同组两个会话解析完全一致', same(a, b), stable(a));
  check('同组解析到 cross:1 且来源是显式绑定',
    a.scope === 'cross:1' && a.gid === 1 && a.source === 'binding' && a.mode === 'card' && a.roleName === '甲');
  const c = resolveRoleBinding('group:20002', GROUPS, bindings, '甲');
  check('组间解析不同（cross:2 → 乙）', c.scope === 'cross:2' && c.roleName === '乙' && c.roleName !== a.roleName);

  const zeroA = resolveRoleBinding('private:20004', GROUPS, bindings, '甲');
  const zeroB = resolveRoleBinding('private:20005', GROUPS, bindings, '甲');
  check('gid=0 的作用域是 isolated:<会话key>（没有 0 号组）',
    zeroA.scope === 'isolated:private:20004' && zeroA.gid === 0);
  check('两条 gid=0 会话作用域不同、互不影响',
    zeroA.scope !== zeroB.scope && zeroA.mode === 'none' && zeroB.mode === 'inherit' && zeroB.roleName === '甲');

  const inherit = resolveScopeRole('cross:9', bindings, '甲');
  const none = resolveScopeRole('isolated:private:20004', bindings, '甲');
  check('inherit（无记录）与 none（有记录）必须可区分',
    inherit.mode === 'inherit' && inherit.source === 'default' && inherit.roleName === '甲'
    && none.mode === 'none' && none.source === 'none' && none.roleName === null);
  check('继承但默认也没配 = 无人格', resolveScopeRole('cross:9', {}, null).roleName === null);
  check('还没分组的会话解析成 isolated，**不**替它分配组号',
    scopeForConversation('private:99999', GROUPS).gid === 0
    && scopeForConversation('private:99999', GROUPS).scope === 'isolated:private:99999');
}

{
  const before = JSON.parse(JSON.stringify(snapshot()));
  resolveRoleBinding('group:10001', before.groups, before.bindings, before.defaultRole);
  scopeForConversation('private:77777', before.groups);
  planRoleChanges(before, before, { keys: Object.keys(before.groups) });
  check('整条解析链路都是只读（不往 groups / bindings 里塞东西）', same(before, snapshot()));
}

// ── 组4：引用范围与摘要 ─────────────────────────────────────────────────────
console.log('\n── 组4：引用范围与摘要 ──────────────────────────────────');

{
  const refsA = listRoleReferences('甲', bindings, '甲');
  check('默认人格被算作一处引用', refsA.isDefault === true);
  check('引用摘要列出绑定它的作用域', same(refsA.bindings, ['cross:1']) && refsA.count === 2);
  const refsB = listRoleReferences('乙', bindings, '甲');
  check('非默认卡只有绑定处', refsB.isDefault === false && refsB.count === 1);
  const refsC = listRoleReferences('丙', bindings, '甲');
  check('没人引用时 count=0', refsC.count === 0 && refsC.bindings.length === 0);
  check('被引用的卡名（revision 只关心它们）',
    same([...referencedRoleNames(bindings, '甲')].sort(), ['乙', '甲']));
  check('卡摘要：有卡给 8 位摘要、没卡给 null',
    roleCardDigest('甲', CARDS) === 'aaaa1111' && roleCardDigest('不存在', CARDS) === null);
  check('卡缺失的生效摘要写成 missing:<卡名>',
    effectiveRoleDigest({ mode: 'card', roleName: '不存在' }, CARDS) === '不存在@missing:不存在');
  check('none 的生效摘要是 none', effectiveRoleDigest({ mode: 'none', roleName: null }, CARDS) === 'none');
}

// ── 组5：影响计算 ───────────────────────────────────────────────────────────
console.log('\n── 组5：影响计算 ──────────────────────────────────────────');

{
  const base = snapshot();
  const noChange = planRoleChanges(base, snapshot(), { keys: Object.keys(base.groups) });
  check('什么都没改时没有任何重建', noChange.rebuild.length === 0 && noChange.rebindOnly.length === 0);
  check('什么都没改时列出全部未变作用域（cross:1 有 2 个成员）',
    same(noChange.unchangedScopes, [
      { scope: 'cross:1', members: 2 },
      { scope: 'cross:2', members: 1 },
      { scope: 'isolated:private:20004', members: 1 },
      { scope: 'isolated:private:20005', members: 1 }
    ]), stable(noChange.unchangedScopes));
}

{
  // 默认人格 甲 → 丙：只有「继承默认」的那条 gid=0 会话受影响。
  const after = snapshot({ defaultRole: '丙' });
  const impact = planRoleChanges(snapshot(), after, { keys: Object.keys(GROUPS) });
  check('默认变化只影响继承者（rebuild 只有 private:20005）',
    same(impact.rebuild.map((item) => item.key), ['private:20005']), stable(impact.rebuild));
  check('继承者重建的原因是 default', impact.rebuild[0]?.reason === 'default');
  check('显式绑卡的会话不因默认变化而重建',
    !impact.rebuild.some((item) => item.key === 'group:10001' || item.key === 'group:20002'));
  check('显式 none 的会话不因默认变化而重建',
    !impact.rebuild.some((item) => item.key === 'private:20004'));
  check('默认变化时重建项的 before/after 卡名正确',
    impact.rebuild[0].roleBefore === '甲' && impact.rebuild[0].roleAfter === '丙');
}

{
  // 换卡：cross:2 从乙换成丙（内容不同）→ content。
  const after = snapshot({ bindings: { ...BINDINGS, 'cross:2': { mode: 'card', name: '丙' } } });
  const impact = planRoleChanges(snapshot(), after, { keys: Object.keys(GROUPS) });
  check('换卡 → 受影响会话重建且原因是 content',
    same(impact.rebuild.map((item) => item.key), ['group:20002'])
    && impact.rebuild[0].reason === 'content');
}

{
  // 绑法变了、但作用域与生效内容都没变：继承（无记录）→ 显式绑默认那张卡。
  const before = snapshot({ bindings: {} });
  const after = snapshot({ bindings: { 'cross:1': { mode: 'card', name: '甲' } } });
  const impact = planRoleChanges(before, after, { keys: Object.keys(GROUPS) });
  check('绑法变化但内容相同 → 只进 rebindOnly（不重建）', impact.rebuild.length === 0, stable(impact.rebuild));
  check('rebindOnly 列出该作用域的两个会话',
    same(impact.rebindOnly.map((item) => item.key), ['group:10001', 'private:20001'])
    && impact.rebindOnly.every((item) => item.scope === 'cross:1' && item.roleName === '甲'));
}

{
  // 组号变化但卡相同：cross:2 的会话搬到 cross:1（两张卡都绑「甲」）。
  const before = snapshot({ bindings: { 'cross:1': { mode: 'card', name: '甲' }, 'cross:2': { mode: 'card', name: '甲' } } });
  const after = snapshot({
    groups: { ...GROUPS, 'group:20002': 1 },
    bindings: { 'cross:1': { mode: 'card', name: '甲' }, 'cross:2': { mode: 'card', name: '甲' } }
  });
  const impact = planRoleChanges(before, after, { keys: Object.keys(GROUPS) });
  check('scope 变了即使人格内容相同也必须重建',
    impact.rebuild.length === 1 && impact.rebuild[0].key === 'group:20002'
    && impact.rebuild[0].reason === 'scope'
    && impact.rebuild[0].scopeBefore === 'cross:2' && impact.rebuild[0].scopeAfter === 'cross:1');
  check('人格相同的两组合并**不**报冲突', impact.conflicts.length === 0, stable(impact.conflicts));
}

{
  // 卡缺失：闲置组 cross:3 绑了一张不存在的卡。
  const before = snapshot({ bindings: { ...BINDINGS, 'cross:3': { mode: 'card', name: '傲娇助手' } } });
  const impact = planRoleChanges(before, before, { keys: Object.keys(GROUPS) });
  check('闲置组绑定的卡被删掉也能报出来',
    same(impact.missing, [{ scope: 'cross:3', name: '傲娇助手' }]), stable(impact.missing));
  check('闲置组缺卡不影响任何会话（没有成员就没有重建）', impact.rebuild.length === 0);

  const deleted = snapshot({ bindings: { ...BINDINGS, 'cross:1': { mode: 'card', name: '傲娇助手' } } });
  const real = planRoleChanges(snapshot(), deleted, { keys: Object.keys(GROUPS) });
  check('有成员的作用域缺卡 → missing + 两个会话重建',
    same(real.missing, [{ scope: 'cross:1', name: '傲娇助手' }])
    && same(real.rebuild.map((item) => item.key), ['group:10001', 'private:20001']));
}

{
  // 残留绑定：cross:99 既不在 gids 里也没成员。
  const before = snapshot({ bindings: { ...BINDINGS, 'cross:99': { mode: 'none' } } });
  const impact = planRoleChanges(before, before, { keys: Object.keys(GROUPS) });
  check('绑定指向不存在的组号 → invalid',
    same(impact.invalid, [{ scope: 'cross:99', reason: 'gid 不在 gids 里且无成员' }]), stable(impact.invalid));
  const ok = snapshot({ bindings: { ...BINDINGS, 'cross:3': { mode: 'none' } } });
  check('写进 gids 的闲置组号不算 invalid', planRoleChanges(ok, ok, {}).invalid.length === 0);
}

{
  // 新会话：group:30003 上一版配置里根本没有。
  const before = snapshot();
  const after = snapshot({ groups: { ...GROUPS, 'group:30003': 4 }, gids: [1, 2, 3, 4] });
  const impact = planRoleChanges(before, after, { keys: [...Object.keys(GROUPS), 'group:30003'] });
  check('新会话按 new 记（继承默认，不需要旧上下文退役）',
    same(impact.rebuild.map((item) => item.key), ['group:30003'])
    && impact.rebuild[0].reason === 'new');
  check('新会话没有来源绑定也算进 unchangedScopes 之外的 scope',
    same(impact.rebuild[0].scopeAfter, 'cross:4'));
}

// ── 组6：合并冲突 ───────────────────────────────────────────────────────────
console.log('\n── 组6：合并冲突 ──────────────────────────────────────────');

{
  // 组 2 的会话整个搬进组 1；两组人格不同。
  const before = snapshot();
  const after = snapshot({ groups: { ...GROUPS, 'group:20002': 1 } });
  const impact = planRoleChanges(before, after, { keys: Object.keys(GROUPS) });
  check('两个不同人格的完整组合并 → 一条 merge-persona', impact.conflicts.length === 1, stable(impact.conflicts));
  check('冲突形状：type/scope/candidates/message',
    impact.conflicts[0]?.type === 'merge-persona'
    && impact.conflicts[0]?.scope === 'cross:1'
    && same(impact.conflicts[0]?.candidates, [{ gid: 1, name: '甲' }, { gid: 2, name: '乙' }])
    && impact.conflicts[0]?.message === '合并后两个人格不同，必须选择最终人格',
    stable(impact.conflicts[0]));
  check('冲突不阻止「已经算出来的重建项」（界面要用它展示影响）',
    impact.rebuild.some((item) => item.key === 'group:20002' && item.reason === 'scope'));

  // 单个成员搬进现有组：不是完整合并，按目标组人格解析，不报冲突。
  const partial = snapshot({ groups: { ...GROUPS, 'private:20011': 2, 'private:20001': 2 } });
  const beforePartial = snapshot({ groups: { ...GROUPS, 'private:20011': 2 } });
  const partialImpact = planRoleChanges(beforePartial, partial, { keys: [...Object.keys(GROUPS), 'private:20011'] });
  check('只搬一个成员进现有组不算完整合并（不报冲突）', partialImpact.conflicts.length === 0, stable(partialImpact.conflicts));
}

// ── 组7：revision ───────────────────────────────────────────────────────────
console.log('\n── 组7：revision ──────────────────────────────────────────');

{
  const one = revisionOf(snapshot());
  check('revision 形状是 r- + 8 位十六进制', /^r-[0-9a-f]{8}$/.test(one), one);
  check('同内容同 revision', revisionOf(snapshot()) === one);

  const reordered = {
    cards: { 丙: 'cccc3333', 乙: 'bbbb2222', 甲: 'aaaa1111' },
    bindings: { 'isolated:private:20004': { mode: 'none' }, 'cross:2': { mode: 'card', name: '乙' }, 'cross:1': { mode: 'card', name: '甲' } },
    defaultRole: '甲',
    gids: [3, 1, 2],
    groups: { 'private:20005': 0, 'private:20004': 0, 'group:20002': 2, 'private:20001': 1, 'group:10001': 1 }
  };
  check('键序 / 字段顺序不同但内容相同 → revision 相同', revisionOf(reordered) === one);

  // 只被闲置组引用的卡：改它的内容 → revision 变，但不重建任何会话。
  const idleBefore = snapshot({ bindings: { ...BINDINGS, 'cross:3': { mode: 'card', name: '丙' } } });
  const idleAfter = snapshot({ bindings: { ...BINDINGS, 'cross:3': { mode: 'card', name: '丙' } }, cards: { ...CARDS, 丙: 'dddd4444' } });
  const revisionBefore = revisionOf(idleBefore);
  const revisionAfter = revisionOf(idleAfter);
  check('改被引用卡的内容 → revision 变', revisionBefore !== revisionAfter);
  check('改被引用卡的内容 → 没有会话需要重建（rebuild 为空）',
    planRoleChanges(idleBefore, idleAfter, { keys: Object.keys(GROUPS) }).rebuild.length === 0);

  // 没被任何作用域引用的卡：改它不该让别人的保存失效。
  const withExtra = snapshot({ cards: { ...CARDS, 丁: 'eeee5555' } });
  check('没被引用的卡不影响 revision', revisionOf(withExtra) === one);
  const changedUnused = snapshot({ cards: { ...CARDS, 丁: 'ffff6666' } });
  check('改没被引用的卡 → revision 不变', revisionOf(changedUnused) === revisionOf(withExtra));

  const bindingChanged = snapshot({ bindings: { ...BINDINGS, 'cross:2': { mode: 'none' } } });
  check('改 bindings → revision 变', revisionOf(bindingChanged) !== one);
  const defaultChanged = snapshot({ defaultRole: '乙' });
  check('改默认人格 → revision 变', revisionOf(defaultChanged) !== one);
  const gidAdded = snapshot({ gids: [1, 2, 3, 4] });
  check('新增闲置组号 → revision 变', revisionOf(gidAdded) !== one);
  check('缺失的卡不编进 revision（同一份快照重复算稳定）', revisionOf(snapshot({ cards: {} })) === revisionOf(snapshot({ cards: {} })));
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
