#!/usr/bin/env node
// T-035 阶段 C3 的**部署迁移**：旧会话策略基线（三元组）的一次性采纳（dev-doc §9）。
//
// 跑法：node scripts/test-role-policy-migration.mjs（全过 exit 0，有失败 exit 1）。
//
// 背景：C3 之前 sessionPolicy 是 `[模式, preset, ownerQQ]`，之后多了「人格作用域 + 生效内容
// 摘要」。不做迁移的话，升级后第一次启动会把所有既有会话判成「策略已变」而集体退役（每个群
// 的上下文各丢一次），与 §9「第一次装载不强制重建所有会话」冲突。采纳条件必须**三条同时满足**：
//   ① 存的恰好是 3 元素数组；② 与当前策略前 3 项逐项相等；③ 该 key 的生效人格是「继承默认」。
// 这里逐条钉住：满足 → 只改写基线；任一不满足 → 照旧退役（不许被采纳逻辑掩盖）。
//
// 不碰真实 config.json / state/ / roles/：整份桥接在 os.tmpdir() 里跑（audit-bridge-harness）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

const GROUPS = {
  'group:10001': 1,
  'private:20001': 1,
  'group:20002': 2,
  'private:20004': 0
};
const SESSIONS = {
  'group:10001': 'sess-10001',
  'private:20001': 'sess-20001',
  'group:20002': 'sess-20002',
  'private:20004': 'sess-20004'
};

async function makeHarness({ bindings } = {}) {
  const logs = [];
  const collect = (...args) => logs.push(args.map((value) => String(value)).join(' '));
  const h = await bridgeHarness({
    config: {
      // 只放行本测试用到的四个会话：reconcileSessionPolicies 会先看模式白名单。
      allow: { private: ['20001', '20004'], groups: ['10001', '20002'] },
      role: {
        maxInjectChars: 13000,
        // cross:2（group:20002）显式绑「乙」→ 它的旧快照**不该**被采纳；
        // cross:1 没有绑定 → 继承默认「甲」→ 可以被采纳。
        bindings: bindings ?? { 'cross:2': { mode: 'card', name: '乙' } },
        gids: [1, 2]
      },
      socialV2: { cross: { groups: { ...GROUPS } } },
      social: { enabled: false }
    },
    files: {
      'roles/甲.md': '# 甲\n\n- 标记：JIA-ONLY-7Q。\n',
      'roles/乙.md': '# 乙\n\n- 标记：YI-ONLY-3Z。\n',
      'state/current-role.json': JSON.stringify({ role: '甲', mode: 'active' })
    },
    savedState: { sessions: { ...SESSIONS }, sessionPolicies: {} },
    globals: { console: { log: collect, error: collect } }
  });
  return { h, logs };
}

/** 升级前的三元组（= 部署前 state/sessions.json 里存的那一份）：把当前五元组截成前三项。 */
function legacyTriple(h, key) {
  return JSON.stringify(JSON.parse(h.sessionPolicy(key)).slice(0, 3));
}

/** 把「不该被本用例影响」的会话对齐成当前五元组，避免它们在同一个 reconcile 里被退役。 */
function alignOtherSessions(h, target) {
  for (const key of Object.keys(h.state.sessions)) {
    if (key === target) continue;
    h.state.sessionPolicies[key] = h.sessionPolicy(key);
  }
}

const adoptionLogs = (logs) => logs.filter((line) => line.includes('采纳旧会话策略基线'));
const retireLogs = (logs) => logs.filter((line) => line.includes('会话权限已变化'));

// ── 1. 旧三元组 + 继承默认 → 就地采纳（不退役、不换 token）＋ 幂等 ─────────
await test('旧三元组 + 继承默认 → 就地采纳成五元组，不退役且幂等', async () => {
  const { h, logs } = await makeHarness();
  try {
    const key = 'group:10001';
    assert.equal(h.roleFor(key).source, 'default', '这条会话必须处于「继承默认」');
    alignOtherSessions(h, key);
    const fiveTuple = h.sessionPolicy(key);
    const othersBefore = JSON.parse(JSON.stringify(h.state.sessionPolicies));

    h.state.sessionPolicies[key] = legacyTriple(h, key);
    assert.equal(JSON.parse(h.state.sessionPolicies[key]).length, 3);
    assert.equal(h.isCurrentSession(key, SESSIONS[key]), false, '三元组本身当然不算 current');

    h.reconcileSessionPolicies();

    assert.equal(h.state.sessions[key], SESSIONS[key], '继承默认的旧快照不能退役');
    assert.equal(h.state.sessionPolicies[key], fiveTuple, '必须就地改写成这次的五元组');
    assert.equal(JSON.parse(h.state.sessionPolicies[key]).length, 5);
    assert.equal(h.isCurrentSession(key, SESSIONS[key]), true, '采纳之后必须真的算 current');
    assert.equal(adoptionLogs(logs).length, 1, `要留一行采纳日志：\n${logs.join('\n')}`);
    assert.match(adoptionLogs(logs)[0], new RegExp(key), '日志要能看出是哪条会话');
    assert.equal(retireLogs(logs).length, 0, '这条路径不允许退役任何会话');

    // 别的会话的状态字段原样保留（采纳只动自己那一条）
    for (const [other, policy] of Object.entries(othersBefore)) {
      if (other === key) continue;
      assert.equal(h.state.sessionPolicies[other], policy, `不许把 ${other} 的策略弄丢/改写`);
    }
    assert.deepEqual(Object.keys(h.state.sessions).sort(), Object.keys(SESSIONS).sort());

    // 幂等：再跑一次不重复改写、不重复记日志、也不退役
    h.reconcileSessionPolicies();
    assert.equal(h.state.sessionPolicies[key], fiveTuple);
    assert.equal(adoptionLogs(logs).length, 1, '重复启动不能反复记日志');
    assert.equal(h.state.sessions[key], SESSIONS[key]);
  } finally {
    await h.close();
  }
});

// ── 2. 旧三元组 + 显式绑卡 → 照旧退役，且快照不被改写 ─────────────────────
await test('旧三元组 + 该 key 有显式绑定（人格与默认不同）→ 退役，不采纳', async () => {
  const { h, logs } = await makeHarness();
  try {
    const key = 'group:20002';
    assert.equal(h.roleFor(key).source, 'binding');
    assert.equal(h.roleFor(key).roleName, '乙');
    alignOtherSessions(h, key);
    const legacy = legacyTriple(h, key);
    h.state.sessionPolicies[key] = legacy;

    h.reconcileSessionPolicies();

    assert.equal(h.state.sessions[key], undefined, '显式绑卡的旧会话必须重建（人格可能是停机期间改的）');
    // 退役本身会 `delete state.sessionPolicies[key]`，所以这里只验证「没有被改写成五元组」。
    assert.equal(h.state.sessionPolicies[key], undefined, '不采纳就不许把旧快照改写成五元组');
    assert.equal(adoptionLogs(logs).length, 0);
    assert.ok(retireLogs(logs).some((line) => line.includes(key)), `要能看到退役日志：\n${logs.join('\n')}`);
    assert.equal(h.state.sessions['group:10001'], 'sess-10001', '别的会话不受牵连');
  } finally {
    await h.close();
  }
});

// ── 3. 新五元组且一致 → 不退役、不改写、不记采纳日志 ───────────────────────
await test('新五元组且一致 → 原样保留（不退役、不改写、不记日志）', async () => {
  const { h, logs } = await makeHarness();
  try {
    const key = 'group:10001';
    const fiveTuple = h.sessionPolicy(key);
    for (const other of Object.keys(h.state.sessions)) h.state.sessionPolicies[other] = h.sessionPolicy(other);
    assert.equal(h.state.sessionPolicies[key], fiveTuple);

    h.reconcileSessionPolicies();

    assert.equal(h.state.sessions[key], SESSIONS[key]);
    assert.equal(h.state.sessionPolicies[key], fiveTuple);
    assert.equal(adoptionLogs(logs).length, 0, '五元组不该走采纳分支');
    assert.equal(retireLogs(logs).length, 0);
  } finally {
    await h.close();
  }
});

// ── 4. 前三项不等（preset / 模式变了）→ 退役，不许被采纳逻辑掩盖 ───────────
await test('前三项不等（preset 变了 / 模式变了）→ 退役', async () => {
  const { h, logs } = await makeHarness();
  try {
    const presetKey = 'group:10001';
    const modeKey = 'private:20001';
    for (const other of Object.keys(h.state.sessions)) h.state.sessionPolicies[other] = h.sessionPolicy(other);
    const current = JSON.parse(h.sessionPolicy(presetKey));
    h.state.sessionPolicies[presetKey] = JSON.stringify([current[0], 'qq-chat-v2', current[2]]);
    h.state.sessionPolicies[modeKey] = JSON.stringify(['closed-agent', '', current[2]]);

    h.reconcileSessionPolicies();

    assert.equal(h.state.sessions[presetKey], undefined, 'preset 变了就是真的策略变化');
    assert.equal(h.state.sessions[modeKey], undefined, '模式变了同样要重建');
    assert.equal(adoptionLogs(logs).length, 0);
    assert.equal(retireLogs(logs).length, 2, retireLogs(logs).join('\n'));
  } finally {
    await h.close();
  }
});

// ── 5. 显式 none 也不算「继承默认」 → 退役 ─────────────────────────────────
await test('旧三元组 + 该作用域显式 none → 退役（none 不是「继承默认」）', async () => {
  const { h, logs } = await makeHarness({
    bindings: { 'cross:2': { mode: 'card', name: '乙' }, 'isolated:private:20004': { mode: 'none' } }
  });
  try {
    const key = 'private:20004';
    assert.equal(h.roleFor(key).source, 'none');
    alignOtherSessions(h, key);
    const legacy = legacyTriple(h, key);
    h.state.sessionPolicies[key] = legacy;

    h.reconcileSessionPolicies();

    assert.equal(h.state.sessions[key], undefined);
    assert.equal(h.state.sessionPolicies[key], undefined, '退役会清掉该快照（不得被改写成五元组）');
    assert.equal(adoptionLogs(logs).length, 0);
  } finally {
    await h.close();
  }
});

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
if (failures > 0) process.exitCode = 1;
