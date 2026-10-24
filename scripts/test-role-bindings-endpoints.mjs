#!/usr/bin/env node
// T-035 阶段 C2：人格绑定三个端点的**隔离 HTTP** 回归（真跑 startConsoleServer）。
//
// 跑法：node scripts/test-role-bindings-endpoints.mjs（全过 exit 0，有失败 exit 1）。
//
// 不碰真实 config.json / state/ / roles/：整份桥接在 os.tmpdir() 里跑（audit-bridge-harness），
// 人格卡与 current-role.json 都是临时文件。钉住这几件事：
//   1. 鉴权：三个端点带 agent token 一律 403（AI 不能自己改组号/换人格），console token 200；
//   2. GET 形状：revision / nextGid / idleGids / scopes（含闲置组与独立会话）/ cards；
//   3. plan 只读：跑完 config.json **字节不变**，且 revision 就是 GET 那一份；
//   4. apply：一次写入 role.bindings + role.gids + socialV2.cross.groups 三处，
//      无关段（qzone / social / socialV2.voice）原样保留；
//   5. apply 的退役范围 = impact.rebuild：rebindOnly / unchanged 的会话**不许**被退役；
//   6. 旧 baseRevision → 409 零修改；合并冲突 → 409 零修改；写盘失败 → 500 内存 revision 不变；
//   7. 既有写路径（POST /api/socialV2/config、POST /api/socialV2/cross）不能丢 role.bindings；
//   8. GET /api/roles 的 defaultRole / refs；POST /api/role 改默认只重建继承者。
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
// 带 agent token 的调用模拟「AI 自己来调」：MCP 工具同时带 console token + agent token。
const AGENT = { ...ADMIN, 'x-agent-token': 'agent-token-should-not-pass' };

const GROUPS = {
  'group:10001': 1,
  'private:20001': 1,
  'group:20002': 2,
  'private:20004': 0
};

function baseConfig(bindings) {
  return {
    role: {
      maxInjectChars: 13000,
      bindings: bindings ?? {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      },
      gids: [1, 2, 3]
    },
    socialV2: {
      cross: { groups: { ...GROUPS } },
      voice: { enabled: true }
    },
    qzone: { enabled: true, adminQQ: ['123'] },
    social: { enabled: false }
  };
}

async function makeHarness({ config, fsOverride } = {}) {
  const logs = [];
  const collect = (...args) => logs.push(args.map((value) => String(value)).join(' '));
  const globals = { console: { log: collect, error: collect } };
  if (fsOverride) globals.fs = fsOverride;
  const h = await bridgeHarness({
    config: config ?? baseConfig(),
    files: {
      'roles/甲.md': '# 你是谁\n\n你是甲。\n',
      'roles/乙.md': '# 你是谁\n\n你是乙。\n',
      'roles/丙.md': '# 你是谁\n\n你是丙。\n',
      'state/current-role.json': JSON.stringify({ role: '甲', mode: 'active' })
    },
    savedState: {
      sessions: {
        'group:10001': 'sess-10001',
        'private:20001': 'sess-20001',
        'group:20002': 'sess-20002',
        'private:20004': 'sess-20004'
      }
    },
    globals
  });
  return { h, logs };
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

const configBytes = (h) => fs.readFileSync(path.join(h.temp, 'config.json'));
const readConfig = (h) => JSON.parse(configBytes(h).toString('utf8'));
const retireLogs = (logs) => logs.filter((line) => line.includes('人格绑定变化'));

// ── 1. 鉴权：agent token 一律 403 ───────────────────────────────────────────
await test('三个端点带 agent token 一律 403，console token 200', async () => {
  const { h } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      for (const [pathname, body] of [
        ['/api/roles/bindings', undefined],
        ['/api/roles/bindings/plan', {}],
        ['/api/roles/bindings/apply', { baseRevision: 'r-00000000' }]
      ]) {
        const denied = await call(port, pathname, {
          method: body === undefined ? 'GET' : 'POST',
          headers: AGENT,
          body
        });
        assert.equal(denied.status, 403, `${pathname} 必须拒绝 agent token`);
        assert.equal(denied.json.ok, false);
      }
      for (const [pathname, body] of [
        ['/api/roles/bindings', undefined],
        ['/api/roles/bindings/plan', {}],
        ['/api/roles/bindings/apply', { baseRevision: 'r-00000000' }]
      ]) {
        const allowed = await call(port, pathname, {
          method: body === undefined ? 'GET' : 'POST',
          headers: ADMIN,
          body
        });
        assert.equal(allowed.status === 403, false, `${pathname} 不该对 console token 403`);
      }
    });
  } finally {
    await h.close();
  }
});

// ── 2. GET 形状 + plan 只读 ────────────────────────────────────────────────
await test('GET bindings 返回 revision/scopes/cards，plan 只读（config 字节不变）', async () => {
  const { h, logs } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const bytesBefore = configBytes(h);
      const sessionsBefore = JSON.stringify(h.state.sessions);

      const res = await call(port, '/api/roles/bindings', { headers: ADMIN });
      assert.equal(res.status, 200);
      const body = res.json;
      assert.equal(body.ok, true);
      assert.match(body.revision, /^r-[0-9a-f]{8}$/);
      assert.equal(body.defaultRole, '甲');
      assert.equal(body.maxInjectChars, 13000);
      assert.equal(body.nextGid, 4, '闲置组 3 占号 → 下一号 4');
      assert.deepEqual(body.idleGids, [3]);
      assert.deepEqual(body.gids, [1, 2, 3], '整块替换接口要能原样回填 gids');
      assert.deepEqual(body.groups, GROUPS);
      assert.deepEqual(body.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      });

      const cardByName = Object.fromEntries(body.cards.map((card) => [card.name, card]));
      assert.deepEqual(Object.keys(cardByName).sort(), ['丙', '乙', '甲'].sort());
      assert.match(cardByName['甲'].revision, /^[0-9a-f]{8}$/);
      assert.deepEqual(cardByName['甲'].refs, ['cross:1']);
      assert.deepEqual(cardByName['乙'].refs, ['cross:2']);
      assert.ok(cardByName['甲'].chars > 0, '卡片字数来自按模式筛选后的实际注入长度');

      const scopeByName = Object.fromEntries(body.scopes.map((scope) => [scope.scope, scope]));
      assert.deepEqual(scopeByName['cross:1'].members, ['group:10001', 'private:20001']);
      assert.equal(scopeByName['cross:1'].mode, 'card');
      assert.equal(scopeByName['cross:1'].roleName, '甲');
      assert.equal(scopeByName['cross:1'].source, 'binding');
      assert.equal(scopeByName['cross:1'].missing, false);
      assert.equal(scopeByName['cross:1'].idle, false);
      assert.equal(scopeByName['cross:3'].idle, true, '没人但有绑定的号 = 闲置组');
      assert.equal(scopeByName['cross:3'].source, 'default');
      assert.equal(scopeByName['cross:3'].roleName, '甲');
      assert.equal(scopeByName['isolated:private:20004'].gid, 0);
      assert.equal(scopeByName['isolated:private:20004'].label, '独立会话');
      assert.equal(scopeByName['isolated:private:20004'].mode, 'inherit');

      const plan = await call(port, '/api/roles/bindings/plan', {
        method: 'POST',
        headers: ADMIN,
        body: {
          bindings: {
            'cross:1': { mode: 'card', name: '丙' },
            'cross:2': { mode: 'card', name: '乙' }
          }
        }
      });
      assert.equal(plan.status, 200, plan.body);
      assert.equal(plan.json.revision, body.revision, 'plan 的 revision = 提交前的最新 revision');
      assert.equal(plan.json.before.revision, body.revision);
      assert.deepEqual(plan.json.impact.rebuild.map((item) => item.key), ['group:10001', 'private:20001']);
      assert.equal(plan.json.impact.rebuild[0].reason, 'content');
      assert.ok(plan.json.impact.unchangedScopes.some((scope) => scope.scope === 'cross:2' && scope.members === 1));

      assert.ok(configBytes(h).equals(bytesBefore), 'plan 不得改写 config.json');
      assert.equal(JSON.stringify(h.state.sessions), sessionsBefore, 'plan 不得退役任何会话');
      assert.equal(retireLogs(logs).length, 0, 'plan 不得调用 retireSession');
    });
  } finally {
    await h.close();
  }
});

// ── 2b. scopes[].revision / missing：继承默认也要有内容版本（T-035 C3 修） ──
await test('GET bindings 的 scopes[].revision 与 prompt 的 role.revision 逐字一致', async () => {
  const { h } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const body = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const inherit = body.scopes.find((scope) => scope.scope === 'isolated:private:20004');
      assert.equal(inherit.source, 'default', 'gid=0 且没有绑定 → 继承默认');
      // 旧写法只在 mode==='card' 时算摘要，继承默认（mode==='inherit'）永远是 null。
      assert.match(inherit.revision, /^甲@[0-9a-f]{8}$/, '继承默认的作用域也必须给出内容版本');
      assert.equal(inherit.missing, false);

      // 显式绑卡的口径不变
      const bound = body.scopes.find((scope) => scope.scope === 'cross:1');
      assert.match(bound.revision, /^甲@[0-9a-f]{8}$/);
      assert.equal(bound.missing, false);

      // 三处口径一致：bindings 列表 / prompt 的 role 段都用同一份「生效内容摘要」
      const prompt = (await call(port, '/api/socialV2/prompt?key=private%3A20004', { headers: ADMIN })).json;
      assert.equal(prompt.role.source, 'default');
      assert.equal(prompt.role.name, '甲');
      assert.equal(prompt.role.revision, inherit.revision, '两个端点的内容版本必须逐字相同');
    });
  } finally {
    await h.close();
  }
});

// ── 2c. 显式 none / 显式缺卡 / 默认卡被删 ───────────────────────────────────
await test('scopes[] 的 revision/missing：none 为 null，缺卡（含默认卡被删）都标 missing', async () => {
  const { h } = await makeHarness({
    config: baseConfig({ 'cross:1': { mode: 'none' }, 'cross:2': { mode: 'card', name: '幽灵' } })
  });
  try {
    await withServer(h, async (port) => {
      const before = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const byScope = Object.fromEntries(before.scopes.map((scope) => [scope.scope, scope]));
      // 显式 none：本来就没有卡 → revision null，且**不是**「缺卡」
      assert.equal(byScope['cross:1'].mode, 'none');
      assert.equal(byScope['cross:1'].revision, null);
      assert.equal(byScope['cross:1'].missing, false);
      // 显式绑了一张文件不存在的卡 → 有卡名但算不出内容
      assert.equal(byScope['cross:2'].revision, 'missing:幽灵');
      assert.equal(byScope['cross:2'].missing, true);
      // 继承默认且默认卡还在
      assert.match(byScope['isolated:private:20004'].revision, /^甲@[0-9a-f]{8}$/);
      assert.equal(byScope['isolated:private:20004'].missing, false);

      // 删掉默认卡：所有继承者都要标缺卡（而不是悄悄退回「无人格」）
      fs.rmSync(path.join(h.temp, 'roles', '甲.md'));
      const after = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const afterByScope = Object.fromEntries(after.scopes.map((scope) => [scope.scope, scope]));
      for (const scope of ['isolated:private:20004', 'cross:3']) {
        assert.equal(afterByScope[scope].source, 'default', `${scope} 仍然继承默认`);
        assert.equal(afterByScope[scope].revision, 'missing:甲', `${scope} 要能看出默认卡没了`);
        assert.equal(afterByScope[scope].missing, true, `${scope} 必须标缺卡`);
      }
      // 显式 none 不受默认卡被删影响
      assert.equal(afterByScope['cross:1'].revision, null);
      assert.equal(afterByScope['cross:1'].missing, false);

      // prompt 段同一口径：不注入正文、name 为 null、missing:true
      const prompt = (await call(port, '/api/socialV2/prompt?key=private%3A20004', { headers: ADMIN })).json;
      assert.equal(prompt.role.revision, 'missing:甲');
      assert.equal(prompt.role.missing, true);
      assert.equal(prompt.role.name, null);
      assert.equal(prompt.role.hint, '');
    });
  } finally {
    await h.close();
  }
});

// ── 3. apply：三处落盘 + 无关段保留 + 只退役 rebuild ────────────────────────
await test('apply 一次写三处、保留无关段、只退役 impact.rebuild 的会话', async () => {
  // 省掉 cross:1 的显式绑定（= 继承默认 甲）：apply 里显式写回同名同内容的卡 → rebindOnly。
  const { h, logs } = await makeHarness({
    config: baseConfig({ 'cross:2': { mode: 'card', name: '乙' } })
  });
  try {
    await withServer(h, async (port) => {
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      assert.equal(current.scopes.find((scope) => scope.scope === 'cross:1').source, 'default');

      const res = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: {
          baseRevision: current.revision,
          bindings: {
            'cross:1': { mode: 'card', name: '甲' },
            'cross:2': { mode: 'card', name: '丙' }
          },
          gids: [1, 2, 3]
        }
      });
      assert.equal(res.status, 200, res.body);
      const body = res.json;
      assert.equal(body.ok, true);
      assert.match(body.revision, /^r-[0-9a-f]{8}$/);
      assert.notEqual(body.revision, current.revision);
      assert.deepEqual(body.applied.rebuild, ['group:20002']);
      assert.deepEqual(body.applied.rebindOnly, ['group:10001', 'private:20001']);
      assert.equal(body.applied.unchanged, 1, '只有完全没动过的 isolated:private:20004 算「不变」');
      assert.deepEqual(body.retire.started, ['group:20002']);
      assert.deepEqual(body.retire.failed, []);
      assert.ok(body.notes.some((note) => note.includes('下一次唤醒')));

      // 落盘三处
      const onDisk = readConfig(h);
      assert.deepEqual(onDisk.role.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '丙' }
      });
      assert.deepEqual(onDisk.role.gids, [1, 2, 3]);
      assert.deepEqual(onDisk.socialV2.cross.groups, GROUPS);
      // 无关段原样
      assert.equal(onDisk.role.maxInjectChars, 13000);
      assert.deepEqual(onDisk.qzone, { enabled: true, adminQQ: ['123'] });
      assert.deepEqual(onDisk.social, { enabled: false });
      assert.deepEqual(onDisk.socialV2.voice, { enabled: true });
      assert.equal(onDisk.consoleToken, 'fixture-console-token');
      // 内存同步
      assert.deepEqual(h.cfg.role.bindings, onDisk.role.bindings);
      assert.deepEqual(h.cfg.role.gids, [1, 2, 3]);
      assert.deepEqual(h.cfg.socialV2.cross.groups, GROUPS);
      // 只退役 rebuild
      assert.equal(h.state.sessions['group:20002'], undefined, 'rebuild 的会话必须退役');
      assert.equal(h.state.sessions['group:10001'], 'sess-10001');
      assert.equal(h.state.sessions['private:20001'], 'sess-20001');
      assert.equal(h.state.sessions['private:20004'], 'sess-20004');
      const retired = retireLogs(logs);
      assert.equal(retired.length, 1, retired.join('\n'));
      assert.ok(retired[0].includes('group:20002') && !retired[0].includes('20001'));
    });
  } finally {
    await h.close();
  }
});

// ── 4. 旧 baseRevision → 409 零修改 ────────────────────────────────────────
await test('旧 baseRevision → 409 且零修改', async () => {
  const { h } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const bytesBefore = configBytes(h);
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const res = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: {
          baseRevision: 'r-00000000',
          bindings: { 'cross:1': { mode: 'none' } }
        }
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error, '配置已被其他页面修改，请刷新后重试');
      assert.equal(res.json.revision, current.revision);
      assert.ok(configBytes(h).equals(bytesBefore), '409 之后 config.json 必须一字未改');
      const after = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      assert.equal(after.revision, current.revision, 'revision 不得变化');
      assert.equal(h.state.sessions['group:10001'], 'sess-10001');
    });
  } finally {
    await h.close();
  }
});

// ── 5. 合并冲突 → 409 零修改 ───────────────────────────────────────────────
await test('两个不同人格的完整组合并 → 409 且零修改', async () => {
  const { h, logs } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const bytesBefore = configBytes(h);
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const res = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: {
          baseRevision: current.revision,
          // 组 2 的会话整个搬进组 1：两组合格人格不同（甲 / 乙），必须先选最终人格。
          groups: { ...GROUPS, 'group:20002': 1 }
        }
      });
      assert.equal(res.status, 409, res.body);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.conflicts.length, 1);
      assert.equal(res.json.conflicts[0].type, 'merge-persona');
      assert.equal(res.json.conflicts[0].scope, 'cross:1');
      assert.deepEqual(res.json.conflicts[0].candidates, [{ gid: 1, name: '甲' }, { gid: 2, name: '乙' }]);
      assert.ok(configBytes(h).equals(bytesBefore), '冲突未决时磁盘零修改');
      assert.equal(retireLogs(logs).length, 0);
      assert.equal(h.state.sessions['group:20002'], 'sess-20002');
    });
  } finally {
    await h.close();
  }
});

// ── 5b. apply 带 mergeChoice：一步解决合并冲突（契约 §3.1） ────────────────
await test('apply 带 mergeChoice：一步解决合并冲突，并按选定后的人格重算影响', async () => {
  const { h } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const res = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: {
          baseRevision: current.revision,
          // 组 2 的会话整个搬进组 1（完整合并 → merge-persona 冲突），同时选定最终人格。
          groups: { ...GROUPS, 'group:20002': 1 },
          mergeChoice: { 'cross:1': '乙' }
        }
      });
      assert.equal(res.status, 200, res.body);
      const body = res.json;
      assert.equal(body.ok, true);
      assert.deepEqual(body.resolvedConflicts, [{ scope: 'cross:1', name: '乙' }]);

      // 三处一次落盘，bindings 用用户选的那张卡
      const onDisk = readConfig(h);
      assert.deepEqual(onDisk.role.bindings, {
        'cross:1': { mode: 'card', name: '乙' },
        'cross:2': { mode: 'card', name: '乙' }
      });
      assert.deepEqual(onDisk.role.gids, [1, 2, 3]);
      assert.deepEqual(onDisk.socialV2.cross.groups, { ...GROUPS, 'group:20002': 1 });
      assert.deepEqual(h.cfg.role.bindings, onDisk.role.bindings, '内存同步');
      assert.deepEqual(h.cfg.socialV2.cross.groups, onDisk.socialV2.cross.groups);

      // 影响必须是「选定之后」的那一版：1 组三个会话全都要重建（内容变了 / 组变了），
      // gid=0 的继承者不动。
      assert.deepEqual(body.applied.rebuild, ['group:10001', 'group:20002', 'private:20001']);
      assert.deepEqual(body.retire.started, ['group:10001', 'group:20002', 'private:20001']);
      assert.deepEqual(body.retire.failed, []);
      assert.equal(h.state.sessions['private:20004'], 'sess-20004');
      assert.equal(h.state.sessions['group:10001'], undefined, 'rebuild 的会话必须退役');
    });
  } finally {
    await h.close();
  }
});

// ── 5c. mergeChoice 非法 → 400 零修改 ─────────────────────────────────────
await test('mergeChoice 非法（非候选 / 非本次冲突 / 形状坏）→ 400 且零修改', async () => {
  const { h, logs } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const bytesBefore = configBytes(h);
      const cases = [
        [{ 'cross:1': '丙' }, '候选只有 甲 / 乙'],
        [{ 'cross:9': '乙' }, 'cross:9 不是本次冲突'],
        [{ 'cross:1': 42 }, '值必须是字符串'],
        [[], 'mergeChoice 必须是对象']
      ];
      for (const [mergeChoice, why] of cases) {
        const res = await call(port, '/api/roles/bindings/apply', {
          method: 'POST',
          headers: ADMIN,
          body: { baseRevision: current.revision, groups: { ...GROUPS, 'group:20002': 1 }, mergeChoice }
        });
        assert.equal(res.status, 400, `${why}：${res.body}`);
        assert.equal(res.json.ok, false);
        assert.ok(configBytes(h).equals(bytesBefore), `${why}：400 之后 config.json 必须一字未改`);
      }
      const after = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      assert.equal(after.revision, current.revision, 'revision 不得变化');
      assert.equal(retireLogs(logs).length, 0, '400 不得退役任何会话');
      assert.equal(h.state.sessions['group:20002'], 'sess-20002');
    });
  } finally {
    await h.close();
  }
});

// ── 5d. mergeChoice 只解决点名的 scope：仍有未解决冲突 → 409 零修改 ────────
await test('两处独立合并只选了一处 → 剩下的冲突仍 409 且零修改', async () => {
  const mergeGroups = {
    'group:10001': 1,
    'private:20001': 1,
    'group:20002': 2,
    'group:30002': 3,
    'private:30003': 3,
    'group:40002': 4
  };
  const { h } = await makeHarness({
    config: {
      role: {
        maxInjectChars: 13000,
        bindings: {
          'cross:1': { mode: 'card', name: '甲' },
          'cross:2': { mode: 'card', name: '乙' },
          'cross:3': { mode: 'card', name: '甲' },
          'cross:4': { mode: 'card', name: '丙' }
        },
        gids: [1, 2, 3, 4]
      },
      socialV2: { cross: { groups: mergeGroups } },
      social: { enabled: false }
    }
  });
  try {
    await withServer(h, async (port) => {
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const bytesBefore = configBytes(h);
      const merged = { ...mergeGroups, 'group:20002': 1, 'group:40002': 3 };
      const res = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: { baseRevision: current.revision, groups: merged, mergeChoice: { 'cross:1': '乙' } }
      });
      assert.equal(res.status, 409, res.body);
      assert.equal(res.json.ok, false);
      assert.deepEqual(res.json.conflicts.map((item) => item.scope), ['cross:3'], '只剩没选的那一处');
      assert.deepEqual(res.json.conflicts[0].candidates, [{ gid: 3, name: '甲' }, { gid: 4, name: '丙' }]);
      assert.ok(configBytes(h).equals(bytesBefore), '冲突未决时磁盘零修改');

      // 把两处都选掉 → 一次通过
      const ok = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: {
          baseRevision: current.revision,
          groups: merged,
          mergeChoice: { 'cross:1': '乙', 'cross:3': '丙' }
        }
      });
      assert.equal(ok.status, 200, ok.body);
      assert.deepEqual(ok.json.resolvedConflicts, [
        { scope: 'cross:1', name: '乙' },
        { scope: 'cross:3', name: '丙' }
      ]);
      const onDisk = readConfig(h);
      assert.deepEqual(onDisk.role.bindings['cross:1'], { mode: 'card', name: '乙' });
      assert.deepEqual(onDisk.role.bindings['cross:3'], { mode: 'card', name: '丙' });
    });
  } finally {
    await h.close();
  }
});

// ── 6. 写盘失败 → 500 且内存不变 ───────────────────────────────────────────
await test('写盘失败（注入 renameSync 抛 EPERM）→ 500，内存 revision 与磁盘都不变', async () => {
  const failingFs = {
    ...fs,
    renameSync: (from, to) => {
      if (String(to).endsWith('config.json')) {
        const error = new Error('EPERM: simulated write failure');
        error.code = 'EPERM';
        throw error;
      }
      return fs.renameSync(from, to);
    }
  };
  const { h, logs } = await makeHarness({ fsOverride: failingFs });
  try {
    await withServer(h, async (port) => {
      const bytesBefore = configBytes(h);
      const current = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      const res = await call(port, '/api/roles/bindings/apply', {
        method: 'POST',
        headers: ADMIN,
        body: {
          baseRevision: current.revision,
          bindings: { 'cross:2': { mode: 'card', name: '丙' } }
        }
      });
      assert.equal(res.status, 500, res.body);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error, '写 config.json 失败，已记日志');
      assert.ok(configBytes(h).equals(bytesBefore), '写盘失败不能留下半份配置');
      const after = (await call(port, '/api/roles/bindings', { headers: ADMIN })).json;
      assert.equal(after.revision, current.revision, '内存 revision 不得变化');
      assert.deepEqual(h.cfg.role.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      }, '内存里的绑定不得热更新');
      assert.equal(h.state.sessions['group:20002'], 'sess-20002', '写盘失败不得退役会话');
      assert.equal(retireLogs(logs).length, 0);
    });
  } finally {
    await h.close();
  }
});

// ── 7. 既有写路径不能丢 role.bindings / role.gids ──────────────────────────
await test('既有配置写路径（socialV2/config、socialV2/cross）不丢 role.bindings', async () => {
  const { h } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const socialV2 = await call(port, '/api/socialV2/config', {
        method: 'POST',
        headers: ADMIN,
        body: { autoReplyCheckMs: 45000 }
      });
      assert.equal(socialV2.status, 200, socialV2.body);
      let onDisk = readConfig(h);
      assert.deepEqual(onDisk.role.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      });
      assert.deepEqual(onDisk.role.gids, [1, 2, 3]);
      assert.equal(onDisk.socialV2.autoReplyCheckMs, 45000, '本次提交的字段要写进去');

      const cross = await call(port, '/api/socialV2/cross', {
        method: 'POST',
        headers: ADMIN,
        body: { groups: { 'private:20004': 0 } }
      });
      assert.equal(cross.status, 200, cross.body);
      onDisk = readConfig(h);
      assert.deepEqual(onDisk.role.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      }, 'cross 保存端点只替换 socialV2.cross，不能把 role 段整块重写掉');
      assert.deepEqual(onDisk.role.gids, [1, 2, 3]);
      assert.deepEqual(onDisk.socialV2.cross.groups, GROUPS);

      // 改注入上限也不能丢绑定
      const limit = await call(port, '/api/roles/limit', {
        method: 'POST',
        headers: ADMIN,
        body: { maxInjectChars: 12000 }
      });
      assert.equal(limit.status, 200, limit.body);
      onDisk = readConfig(h);
      assert.equal(onDisk.role.maxInjectChars, 12000);
      assert.deepEqual(onDisk.role.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      });
    });
  } finally {
    await h.close();
  }
});

// ── 8. /api/roles 的 defaultRole / refs；/api/role 只重建继承者 ─────────────
await test('GET /api/roles 增 defaultRole + refs；POST /api/role 只退役继承者', async () => {
  const { h } = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const roles = await call(port, '/api/roles', { headers: ADMIN });
      assert.equal(roles.status, 200);
      assert.equal(roles.json.current, '甲', 'current 老字段不动');
      assert.equal(roles.json.defaultRole, '甲');
      assert.deepEqual(roles.json.refs['甲'], { isDefault: true, bindings: ['cross:1'], count: 2 });
      assert.deepEqual(roles.json.refs['乙'], { isDefault: false, bindings: ['cross:2'], count: 1 });
      assert.deepEqual(roles.json.refs['丙'], { isDefault: false, bindings: [], count: 0 });

      const set = await call(port, '/api/role', { method: 'POST', headers: ADMIN, body: { role: '乙' } });
      assert.equal(set.status, 200, set.body);
      assert.equal(set.json.ok, true);
      assert.equal(set.json.role, '乙');
      assert.deepEqual(set.json.impact.rebuild.map((item) => item.key), ['private:20004']);
      assert.equal(set.json.impact.rebuild[0].reason, 'default');
      assert.deepEqual(set.json.retired.started, ['private:20004']);
      assert.equal(h.state.sessions['private:20004'], undefined, '继承者必须退役');
      assert.equal(h.state.sessions['group:10001'], 'sess-10001', '显式绑卡的不受默认变化影响');
      assert.equal(h.state.sessions['group:20002'], 'sess-20002');

      const roleState = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'current-role.json'), 'utf8'));
      assert.equal(roleState.role, '乙');
      // 绑定本身没被这次调用改动
      const onDisk = readConfig(h);
      assert.deepEqual(onDisk.role.bindings, {
        'cross:1': { mode: 'card', name: '甲' },
        'cross:2': { mode: 'card', name: '乙' }
      });
    });
  } finally {
    await h.close();
  }
});

// ── 9. 迁移：老配置没有 role.bindings / role.gids 也能起来 ──────────────────
await test('老配置（无 role.bindings / role.gids）启动归一为「空绑定 + 从 groups 反推编号」', async () => {
  const { h } = await makeHarness({
    config: {
      role: { maxInjectChars: 13000 },
      socialV2: { cross: { groups: { ...GROUPS } } }
    }
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/roles/bindings', { headers: ADMIN });
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(res.json.bindings, {});
      assert.equal(res.json.nextGid, 3, 'gids 缺失时从 groups 反推：组 1、2 存在 → 下一号 3');
      assert.deepEqual(res.json.idleGids, []);
      assert.equal(res.json.defaultRole, '甲');
      const cross1 = res.json.scopes.find((scope) => scope.scope === 'cross:1');
      assert.equal(cross1.source, 'default', '没有绑定 = 继承默认');
      assert.equal(cross1.roleName, '甲');
    });
  } finally {
    await h.close();
  }
});

// ── 10. 坏绑定值：只丢坏项 + 记日志，桥接照样起来 ───────────────────────────
await test('坏绑定值只丢该项并记一行日志，桥接照常起得来', async () => {
  const { h, logs } = await makeHarness({
    config: {
      role: {
        maxInjectChars: 13000,
        bindings: {
          'cross:1': { mode: 'card', name: '甲' },
          'cross:2': 'garbage',
          'cross:0': { mode: 'none' }
        },
        gids: [1, 2, 3]
      },
      socialV2: { cross: { groups: { ...GROUPS } } }
    }
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/roles/bindings', { headers: ADMIN });
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(res.json.bindings, { 'cross:1': { mode: 'card', name: '甲' } }, '只丢坏项，好的一条要留住');
      assert.deepEqual(res.json.gids, [1, 2, 3]);
    });
    assert.ok(
      logs.some((line) => line.includes('人格绑定：丢弃 2 条不合法项')),
      `启动日志里必须有丢弃记录：\n${logs.join('\n')}`
    );
  } finally {
    await h.close();
  }
});

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
if (failures > 0) process.exitCode = 1;
