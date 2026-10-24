#!/usr/bin/env node
// T-035 阶段 C3：人格注入（按会话 key 解析）+ 会话策略快照的**隔离**回归（真跑桥接）。
//
// 跑法：node scripts/test-role-injection.mjs（全过 exit 0，有失败 exit 1）。
//
// 不碰真实 config.json / state/ / roles/：整份桥接在 os.tmpdir() 里跑（audit-bridge-harness），
// 人格卡与 current-role.json 都是临时文件。钉住这几件事：
//   1. 同组（群 + 私聊）拿到同一段人格正文，不同组拿到不同正文，三个提示词入口一致；
//   2. gid=0 会话继承默认人格，两条 gid=0 会话互不影响（绝不聚合成「0 号组」）；
//   3. 显式 none → 正文空串、prompt 的 role 段 source:'none' / name:null；
//   4. 绑定的卡文件缺失 → 不注入、missing:true，且**不偷偷换成默认人格**；
//   5. 默认人格变更只影响继承者，固定卡与 none 不动；
//   6. sessionPolicy：组变了但内容相同 → 变（会重建）；只改绑法、摘要不变 → 不变（rebindOnly）；
//   7. GET /api/socialV2/prompt 的 role 段含 scope/source/revision 且随 key 不同；鉴权照旧；
//   8. A/B/A 交替（两个组来回切）不串卡：正文与 revision 始终对应当前绑定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

const ADMIN = { 'x-console-token': 'fixture-console-token' };

// 会话 → 组号：1 组是「群 + 私聊」，2 组是另一个群，两条 gid=0 的私聊互不共享。
const GROUPS = {
  'group:10001': 1,
  'private:20001': 1,
  'group:20002': 2,
  'private:20004': 0,
  'private:20005': 0
};

// 每张卡都带一个独一无二的标记：断言「注入了哪张卡」时看标记，不靠卡名撞运气。
const CARD_JIA = '# 角色卡：甲\n\n## 一、你是谁\n- 你是甲，说话简短。\n- 标记：JIA-ONLY-7Q。\n';
const CARD_YI = '# 角色卡：乙\n\n## 一、你是谁\n- 你是乙，说话啰嗦。\n- 标记：YI-ONLY-3Z。\n';
const CARD_BING = '# 角色卡：丙\n\n## 一、你是谁\n- 你是丙。\n- 标记：BING-ONLY-5X。\n';

const BASE_BINDINGS = {
  'cross:1': { mode: 'card', name: '甲' },
  'cross:2': { mode: 'card', name: '乙' },
  'isolated:private:20005': { mode: 'card', name: '丙' }
};

function baseConfig(bindings) {
  return {
    role: { maxInjectChars: 13000, bindings: bindings ?? { ...BASE_BINDINGS }, gids: [1, 2] },
    socialV2: { cross: { groups: { ...GROUPS } } },
    social: { enabled: false }
  };
}

async function makeHarness({ config, roles, roleState = '甲' } = {}) {
  return bridgeHarness({
    config: config ?? baseConfig(),
    files: {
      ...(roles ?? { 'roles/甲.md': CARD_JIA, 'roles/乙.md': CARD_YI, 'roles/丙.md': CARD_BING }),
      'state/current-role.json': JSON.stringify({ role: roleState, mode: 'active' })
    }
  });
}

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 取 `GET /api/socialV2/prompt?key=…` 里的 role 段（每次单开一个服务器，测试之间不共享状态）。 */
async function roleSegment(h, key, headers = ADMIN) {
  let segment = null;
  await withServer(h, async (port) => {
    const res = await call(port, `/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers });
    assert.equal(res.status, 200, `${key} 的 prompt 端点应 200：${String(res.body).slice(0, 400)}`);
    segment = res.json?.role;
  });
  assert.ok(segment && typeof segment === 'object', `${key} 的 role 段必须存在`);
  return segment;
}

// ── 1. 同组一致 / 组间不同 / 三个入口一致 ─────────────────────────────────
await test('同组（群 + 私聊）同一段正文，不同组不同正文，提示词入口一致', async () => {
  const h = await makeHarness();
  try {
    const groupBody = h.roleRawContent('group:10001');
    const privateBody = h.roleRawContent('private:20001');
    const otherBody = h.roleRawContent('group:20002');

    assert.match(groupBody, /JIA-ONLY-7Q/, '1 组应注入「甲」');
    assert.equal(privateBody, groupBody, '同组的群聊与私聊必须解析到同一张卡');
    assert.match(otherBody, /YI-ONLY-3Z/, '2 组应注入「乙」');
    assert.notEqual(otherBody, groupBody);

    // 三个入口（唤醒/v1 提示词、二代提示词、原始卡）必须是同一个解析结果
    assert.equal(h.currentRoleHint('private:20001'), h.currentRoleHint('group:10001'));
    assert.equal(h.currentRoleHintV2('private:20001'), h.currentRoleHintV2('group:10001'));
    assert.match(h.currentRoleHint('group:20002'), /YI-ONLY-3Z/);
    assert.doesNotMatch(h.currentRoleHint('group:20002'), /JIA-ONLY-7Q/);
    // 两代筛选后内容一致（测试卡没有模式标记），说明 v2 那条路径没有自己再读一次默认人格
    assert.equal(h.roleHintForMode('v2', 'group:10001'), h.currentRoleHintV2('group:10001'));

    assert.equal(h.roleFor('group:10001').scope, 'cross:1');
    assert.equal(h.roleFor('private:20001').scope, 'cross:1');
    assert.equal(h.roleFor('group:20002').scope, 'cross:2');
    assert.equal(h.roleFor('group:10001').source, 'binding');
  } finally {
    await h.close();
  }
});

// ── 2. gid=0：继承默认 + 互不影响 ──────────────────────────────────────────
await test('gid=0 会话继承默认人格，两条 gid=0 会话互不影响', async () => {
  const h = await makeHarness();
  try {
    const inherit = h.roleFor('private:20004');
    assert.equal(inherit.scope, 'isolated:private:20004', 'gid=0 是独立作用域，绝不能聚合成「0 号组」');
    assert.equal(inherit.source, 'default');
    assert.equal(inherit.roleName, '甲');
    assert.match(h.roleRawContent('private:20004'), /JIA-ONLY-7Q/);

    // 配置里完全没有的会话：同样是自己的 isolated 作用域，仍继承默认
    const fresh = h.roleFor('private:29999');
    assert.equal(fresh.scope, 'isolated:private:29999');
    assert.equal(fresh.source, 'default');
    assert.equal(fresh.roleName, '甲');

    const own = h.roleFor('private:20005');
    assert.equal(own.scope, 'isolated:private:20005');
    assert.equal(own.source, 'binding');
    assert.match(h.roleRawContent('private:20005'), /BING-ONLY-5X/);

    // 改一条 gid=0 的绑定，不牵连另一条
    h.cfg.role.bindings = { ...h.cfg.role.bindings, 'isolated:private:20005': { mode: 'none' } };
    assert.equal(h.roleFor('private:20004').roleName, '甲', '另一条 gid=0 必须保持原样');
    assert.equal(h.roleFor('private:20005').source, 'none');
    assert.equal(h.roleRawContent('private:20005'), '');
    assert.match(h.roleRawContent('private:20004'), /JIA-ONLY-7Q/);
  } finally {
    await h.close();
  }
});

// ── 3. 显式 none ──────────────────────────────────────────────────────────
await test('显式 none：正文空串，prompt 的 role 段 source=none / name=null', async () => {
  const h = await makeHarness({ config: baseConfig({ 'cross:1': { mode: 'none' } }) });
  try {
    assert.equal(h.roleRawContent('group:10001'), '');
    assert.equal(h.currentRoleHint('group:10001'), '');
    assert.equal(h.currentRoleHintV2('group:10001'), '');
    assert.equal(h.currentRoleLine('group:10001'), '');
    const resolved = h.roleFor('group:10001');
    assert.equal(resolved.mode, 'none');
    assert.equal(resolved.roleName, null);
    assert.equal(h.roleContentRevision(resolved), 'none');

    const segment = await roleSegment(h, 'group:10001');
    assert.equal(segment.source, 'none');
    assert.equal(segment.name, null);
    assert.equal(segment.hint, '');
    assert.equal(segment.revision, 'none');
    assert.equal(segment.scope, 'cross:1');
    assert.equal(segment.missing, false, 'none 是「本来就不用」，不是「卡丢了」');
  } finally {
    await h.close();
  }
});

// ── 4. 绑定的卡文件缺失：不注入、不回落默认 ────────────────────────────────
await test('绑定卡缺失：不注入、missing:true，不偷偷换成默认人格', async () => {
  const h = await makeHarness({ config: baseConfig({ 'cross:2': { mode: 'card', name: '幽灵' } }) });
  try {
    const resolved = h.roleFor('group:20002');
    assert.equal(resolved.source, 'binding', '缺卡时来源仍是 binding，不是 default');
    assert.equal(resolved.roleName, '幽灵');
    assert.equal(h.roleRawContent('group:20002'), '');
    assert.equal(h.currentRoleHint('group:20002'), '');
    assert.doesNotMatch(h.currentRoleHint('group:20002'), /JIA-ONLY-7Q/, '绝不能回落成默认人格');
    assert.equal(h.roleContentRevision(resolved), 'missing:幽灵');

    const segment = await roleSegment(h, 'group:20002');
    assert.equal(segment.missing, true);
    assert.equal(segment.name, null);
    assert.equal(segment.hint, '');
    assert.equal(segment.source, 'binding');
    assert.equal(segment.revision, 'missing:幽灵');
    // 缺卡只影响它自己的作用域：别的组照常注入
    assert.match(h.roleRawContent('group:10001'), /JIA-ONLY-7Q/);
  } finally {
    await h.close();
  }
});

// ── 5. 默认人格变更只影响继承者 ─────────────────────────────────────────────
await test('默认人格变更：只有继承者的 role 段变化，固定卡与 none 不变', async () => {
  const h = await makeHarness();
  try {
    const beforeInherit = await roleSegment(h, 'private:20004');
    const beforeFixed = await roleSegment(h, 'group:10001');
    const beforeOther = await roleSegment(h, 'group:20002');
    assert.equal(beforeInherit.name, '甲');
    assert.equal(beforeInherit.source, 'default');

    // 改默认人格（真实的写入路径是 POST /api/role → writeRoleState，这里直接改同一个文件）
    fs.writeFileSync(
      path.join(h.temp, 'state', 'current-role.json'),
      JSON.stringify({ role: '丙', mode: 'active' })
    );
    assert.equal(h.roleFor('private:20004').roleName, '丙', '继承者必须跟着默认走');
    assert.match(h.roleRawContent('private:20004'), /BING-ONLY-5X/);
    assert.equal(h.roleFor('group:10001').roleName, '甲', '显式绑卡不受默认变化影响');
    assert.equal(h.roleFor('private:20005').roleName, '丙', '显式绑了同一张卡的也不受「默认」影响');

    const afterInherit = await roleSegment(h, 'private:20004');
    const afterFixed = await roleSegment(h, 'group:10001');
    const afterOther = await roleSegment(h, 'group:20002');
    assert.equal(afterInherit.name, '丙');
    assert.notEqual(afterInherit.revision, beforeInherit.revision, '继承者的内容版本必须变');
    assert.match(afterInherit.hint, /BING-ONLY-5X/);
    assert.equal(afterFixed.name, '甲');
    assert.equal(afterFixed.revision, beforeFixed.revision, '固定卡的内容版本不该被默认变化带动');
    assert.equal(afterOther.name, '乙');
    assert.equal(afterOther.revision, beforeOther.revision);
  } finally {
    await h.close();
  }
});

// ── 6. sessionPolicy：组变了必变，只改绑法不变 ─────────────────────────────
await test('sessionPolicy 含作用域+内容摘要：组变（内容同）会变，只改绑法不变', async () => {
  // 两个组绑同一张内容相同的卡：只搬组号，生效内容摘要完全一样。
  const h = await makeHarness({
    config: baseConfig({ 'cross:1': { mode: 'card', name: '甲' }, 'cross:2': { mode: 'card', name: '甲' } })
  });
  try {
    const policyBefore = h.sessionPolicy('group:10001');
    assert.ok(policyBefore.includes('cross:1'), '策略里必须有作用域');
    assert.match(policyBefore, /甲@[0-9a-f]{8}/, '策略里必须有生效内容摘要');

    // 组 1 → 组 2：人格内容一模一样，但共享边界变了，旧会话不能沿用
    h.cfg.socialV2.cross.groups = { 'group:10001': 2, 'group:20002': 2 };
    const policyAfterScope = h.sessionPolicy('group:10001');
    assert.equal(h.roleFor('group:10001').roleName, '甲', '内容确实没变');
    assert.notEqual(policyAfterScope, policyBefore, '组变了但人格内容相同，策略也必须变（要重建）');

    // 同内容原地重写：内容哈希变了 → 策略也要变（不能只看 mtime+size）
    h.cfg.socialV2.cross.groups = { ...GROUPS };
    const policyBeforeEdit = h.sessionPolicy('group:10001');
    fs.writeFileSync(path.join(h.temp, 'roles', '甲.md'), CARD_JIA.replace('说话简短', '说话很简短'));
    assert.notEqual(h.sessionPolicy('group:10001'), policyBeforeEdit, '卡内容变了，策略必须变');
  } finally {
    await h.close();
  }

  // 只改绑法：继承 → 显式绑同名同内容的卡，摘要不变 → 策略不变（rebindOnly 不重建）
  const rebind = await makeHarness({ config: baseConfig({}) });
  try {
    assert.equal(rebind.roleFor('group:10001').source, 'default');
    const policyDefault = rebind.sessionPolicy('group:10001');
    rebind.cfg.role.bindings = { 'cross:1': { mode: 'card', name: '甲' } };
    assert.equal(rebind.roleFor('group:10001').source, 'binding');
    assert.equal(rebind.sessionPolicy('group:10001'), policyDefault, '只改绑法、摘要不变时策略必须不变');
  } finally {
    await rebind.close();
  }
});

// ── 7. GET /api/socialV2/prompt 的 role 段 + 鉴权 ───────────────────────────
await test('prompt 的 role 段含 scope/source/revision，随 key 不同；agent token 照旧拒绝', async () => {
  const h = await makeHarness({
    config: baseConfig({ ...BASE_BINDINGS, 'isolated:private:20004': { mode: 'none' } })
  });
  try {
    h.setMode('reserved2');
    const jia = await roleSegment(h, 'group:10001');
    assert.equal(jia.scope, 'cross:1');
    assert.equal(jia.source, 'binding');
    assert.equal(jia.name, '甲');
    assert.match(jia.revision, /^甲@[0-9a-f]{8}$/);
    assert.match(jia.hint, /JIA-ONLY-7Q/);
    assert.equal(jia.missing, false);

    const yi = await roleSegment(h, 'group:20002');
    assert.equal(yi.scope, 'cross:2');
    assert.equal(yi.name, '乙');
    assert.match(yi.revision, /^乙@[0-9a-f]{8}$/);
    assert.notEqual(yi.revision, jia.revision, '不同 key 的 revision 必须不同');
    assert.notEqual(yi.hint, jia.hint);

    const none = await roleSegment(h, 'private:20004');
    assert.equal(none.scope, 'isolated:private:20004');
    assert.equal(none.source, 'none');
    assert.equal(none.name, null);
    assert.equal(none.hint, '');
    assert.equal(none.revision, 'none');

    // 三个 key 的 role 段互不相同（不是「都回全局默认人格」）
    assert.equal(new Set([jia.revision, yi.revision, none.revision]).size, 3);

    await withServer(h, async (port) => {
      // 连控制台令牌都没有：控制台令牌关卡先拒（401），不会因为「这是读接口」就放行
      const bare = await call(port, '/api/socialV2/prompt?key=group%3A10001');
      assert.equal(bare.status, 401);
      // 无会话令牌的智能体调用：照既有「confused deputy」关卡拒绝（MCP 只带控制台令牌）
      const tokenless = await call(port, '/api/socialV2/prompt?key=group%3A10001', {
        headers: { ...ADMIN, 'x-agent-call': '1' }
      });
      assert.equal(tokenless.status, 403);
      // 带一个无效会话令牌：端点自己的绑定校验拒绝（读类接口仍是 agentTokenOk）
      const bogus = await call(port, '/api/socialV2/prompt?key=group%3A10001', {
        headers: { ...ADMIN, 'x-agent-token': 'not-a-real-token' }
      });
      assert.equal(bogus.status, 403);
      // 控制台令牌仍然可以读（C4 的查看入口依赖这条）
      const ok = await call(port, '/api/socialV2/prompt?key=group%3A10001', { headers: ADMIN });
      assert.equal(ok.status, 200);
    });
  } finally {
    await h.close();
  }
});

// ── 8. A/B/A 交替不串卡 ───────────────────────────────────────────────────
await test('A/B/A 交替取文本不串卡：正文与 revision 始终对应当前绑定', async () => {
  const h = await makeHarness();
  try {
    const expectA = { marker: /JIA-ONLY-7Q/, scope: 'cross:1', name: '甲' };
    const expectB = { marker: /YI-ONLY-3Z/, scope: 'cross:2', name: '乙' };
    for (let round = 0; round < 8; round += 1) {
      const a = h.roleFor('group:10001');
      assert.equal(a.scope, expectA.scope);
      assert.equal(a.roleName, expectA.name);
      assert.match(h.roleRawContent('group:10001'), expectA.marker);
      const b = h.roleFor('group:20002');
      assert.equal(b.scope, expectB.scope);
      assert.equal(b.roleName, expectB.name);
      assert.match(h.roleRawContent('group:20002'), expectB.marker);
      assert.doesNotMatch(h.roleRawContent('group:20002'), expectA.marker);
      assert.doesNotMatch(h.roleRawContent('group:10001'), expectB.marker);
      // 交替取「摘要」也不能错位
      assert.match(h.roleContentRevision(a), /^甲@/);
      assert.match(h.roleContentRevision(b), /^乙@/);
    }

    // 绑定在运行中改掉：解析缓存必须按快照失效，立刻返回新卡（不是上一张）
    h.cfg.role.bindings = { ...h.cfg.role.bindings, 'cross:1': { mode: 'card', name: '丙' } };
    assert.equal(h.roleFor('group:10001').roleName, '丙');
    assert.match(h.roleRawContent('group:10001'), /BING-ONLY-5X/);
    assert.match(h.roleContentRevision(h.roleFor('group:10001')), /^丙@/);
    assert.match(h.roleRawContent('group:20002'), /YI-ONLY-3Z/, '改组 1 不影响组 2');
  } finally {
    await h.close();
  }
});

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
if (failures > 0) process.exitCode = 1;
