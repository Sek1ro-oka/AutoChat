import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Personas } from '../src/personas.js';
import { Social } from '../src/social/engine.js';
import { Slang } from '../src/social/slang.js';
import { GROUP_KEYS, GROUP_LIMITS, clearGroupOverrides, numberOverride, withinRange } from '../src/group-settings.js';
import { createConsole } from '../src/console/server.js';

const TOKEN = 'test-console-token-1234';

// A persona / social / slang trio wired over one store, with two served groups,
// so the per-group layer can be exercised end to end.
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-groups-'));
  const store = new Store();
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000', '20001'],
    socialEnabled: false, socialThreshold: 6, socialCooldownSeconds: 45, socialDailyLimit: 20,
    socialContextMessages: 12, socialMaxChunks: 3, socialMinDelayMs: 0, socialMaxDelayMs: 0,
    socialMessageTtlMs: 24 * 3600000, botName: '', botNicknames: [],
    slangEnabled: true, slangInjectMax: 20, slangExtractMessages: 120,
    slangAutoExtract: false, webSearchEnabled: false,
    blockTerms: [], maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const personas = new Personas({ directory: root, store, log: () => {} });
  const model = { complete: async () => ({ text: '好', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  const social = new Social({ config, store, model, log: () => {} });
  const slang = new Slang({ config, store, model, log: () => {} });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, personas, social, slang, config };
}

test('a group with no overrides inherits the global persona, social and slang', t => {
  const { store, personas, social, slang } = harness(t);
  const p = personas.groupView('20000');
  assert.equal(p.override, null);
  assert.equal(p.source, 'builtin', 'no card selected anywhere -> builtin');
  const s = social.params('20000');
  assert.equal(s.enabled, false);
  assert.equal(s.threshold, 6);
  assert.equal(s.cooldownMs, 45000);
  assert.deepEqual(s.overridden, { enabled: false, threshold: false, cooldownSeconds: false, dailyLimit: false });
  assert.equal(slang.params('20000').enabled, true, 'inherits the global slang switch');
  assert.equal(slang.params('20000').override, null);
});

test('persona selection can be pinned per group, back to builtin, or back to inherit', t => {
  const { personas } = harness(t);
  personas.save('测试卡', '你是测试角色。');
  personas.setGroupActive('20000', '测试卡');
  assert.equal(personas.active('20000'), '测试卡');
  assert.equal(personas.groupView('20000').source, 'group');
  assert.equal(personas.resolve('20000'), '你是测试角色。');
  assert.equal(personas.active('20001'), '', 'another group is unaffected');

  personas.setGroupActive('20000', '');
  assert.equal(personas.active('20000'), '', 'empty string pins the built-in default');
  assert.equal(personas.groupView('20000').source, 'group');

  personas.setGroupActive('20000', null);
  assert.equal(personas.groupView('20000').override, null, 'null clears the override to inherit again');
});

test('social parameters override per group and null clears back to the global value', t => {
  const { store, social } = harness(t);
  social.setParams({ group: '20000', threshold: 42, dailyLimit: 7, enabled: true });
  const scoped = social.params('20000');
  assert.equal(scoped.threshold, 42);
  assert.equal(scoped.dailyLimit, 7);
  assert.equal(scoped.enabled, true);
  assert.equal(scoped.cooldownMs, 45000, 'unset fields inherit the global value');
  assert.deepEqual(scoped.overridden, { enabled: true, threshold: true, cooldownSeconds: false, dailyLimit: true });

  const other = social.params('20001');
  assert.equal(other.threshold, 6, 'the other group still sees the global value');

  social.setParams({ group: '20000', threshold: null });
  assert.equal(social.params('20000').threshold, 6, 'null clears the override');
  assert.equal(social.params('20000').overridden.threshold, false);
});

test('a slang term scoped to one group is injected only there; empty scope is global', t => {
  const { store, slang } = harness(t);
  const a = store.upsertSlang({ content: '666', meaning: '厉害' });
  const b = store.upsertSlang({ content: 'yyds', meaning: '永远的神' });
  store.setSlangStatus(a.id, 'confirmed');
  store.setSlangStatus(b.id, 'confirmed');
  slang.setScopes(a.id, ['20000']);        // 666 only in 20000; yyds has no scope -> global.

  const inA = slang.block({ group: '20000' });
  const inB = slang.block({ group: '20001' });
  assert.match(inA, /666 = 厉害/);
  assert.match(inA, /yyds = 永远的神/, 'a global term rides along everywhere');
  assert.doesNotMatch(inB, /666/, 'the scoped term stays out of other groups');
  assert.match(inB, /yyds/);

  assert.equal(slang.groupView('20000').terms, 2, 'group 20000 sees both terms');
  assert.equal(slang.groupView('20001').terms, 1, 'group 20001 sees only the global term');

  slang.setScopes(a.id, []);
  assert.match(slang.block({ group: '20001' }), /666/, 'clearing the scope makes it global again');
});

test('per-group slang switch overrides the global switch and null re-inherits', t => {
  const { store, slang } = harness(t);
  slang.setGroupEnabled('20000', false);
  assert.equal(slang.params('20000').enabled, false);
  assert.equal(slang.params('20000').override, false);
  assert.equal(slang.params('20001').enabled, true, 'the other group keeps the global switch');
  assert.equal(slang.block({ group: '20000' }), '', 'off for that group -> no table');

  slang.setGroupEnabled('20000', null);
  assert.equal(slang.params('20000').override, null);
  assert.equal(slang.params('20000').enabled, true);
});

test('clearGroupOverrides removes every per-group key but leaves global rows alone', t => {
  const { store, personas, social, slang } = harness(t);
  personas.setGroupActive('20000', '');
  social.setParams({ group: '20000', enabled: true, threshold: 9 });
  slang.setGroupEnabled('20000', false);
  assert.ok(clearGroupOverrides(store, '20000').length >= 4);

  assert.equal(personas.groupView('20000').override, null);
  assert.equal(social.params('20000').threshold, 6);
  assert.equal(social.params('20000').enabled, false);
  assert.equal(slang.params('20000').override, null);
  assert.equal(store.setting('social_enabled', 'absent'), 'absent', 'global rows were not touched');
});

// --- console round-trip ----------------------------------------------------

function consoleFixture(t) {
  const { store, personas, social, slang, config } = harness(t);
  const server = createConsole({ config, store, personas, social, slang, log: () => {}, port: 0 });
  return { store, personas, social, slang, server };
}

const auth = { 'x-console-token': TOKEN };
const jsonPost = (base, path, body) => fetch(base + path, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('the group page reads both groups and writes each subsystem through one endpoint', async t => {
  const { server, store } = consoleFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const view = await (await fetch(`${base}/api/groups`, { headers: auth })).json();
  assert.deepEqual(view.groups.map(g => g.id), ['20000', '20001']);
  assert.equal(view.groups[0].persona.source, 'builtin');
  assert.equal(view.groups[0].social.enabled, false);
  assert.equal(view.groups[0].slang.override, null);

  // Persona pin.
  const persona = await (await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'persona', name: '' })).json();
  assert.equal(persona.groups.find(g => g.id === '20000').persona.source, 'group');

  // Social override.
  const social = await (await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'social', threshold: 11, enabled: true })).json();
  const g20000 = social.groups.find(g => g.id === '20000').social;
  assert.equal(g20000.threshold, 11);
  assert.equal(g20000.enabled, true);

  // Slang switch.
  const slang = await (await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'slang', enabled: false })).json();
  assert.equal(slang.groups.find(g => g.id === '20000').slang.enabled, false);

  // Reset.
  const reset = await (await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'reset' })).json();
  const cleared = reset.groups.find(g => g.id === '20000');
  assert.equal(cleared.persona.override, null);
  assert.equal(cleared.social.threshold, 6);
  assert.equal(cleared.slang.override, null);

  // Guardrails.
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '99999', subsystem: 'social', enabled: true })).status, 404);
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'nope' })).status, 400);
  assert.equal((await jsonPost(base, '/api/groups/config', { subsystem: 'persona', name: '' })).status, 400);
});

// --- I-01 D-01: 空值不是 0（花钱路径）---------------------------------------

// The settings table is the whole state these writes can touch, so comparing a
// dump before and after a rejected patch is the strongest form of "nothing was
// written": not "the field I checked is fine" but "the row set is identical".
const settingsDump = store => store.db.prepare('SELECT key, value FROM settings ORDER BY key').all()
  .map(row => `${row.key}=${row.value}`).join('\n');

test('withinRange rejects blank and non-decimal text instead of reading it as 0', () => {
  const { threshold } = GROUP_LIMITS;
  assert.equal(withinRange('', threshold), null, '空串没有值，绝不能变成 0');
  assert.equal(withinRange('   ', threshold), null, '只有空白的输入同样没有值');
  assert.equal(withinRange(null, threshold), null);
  assert.equal(withinRange(undefined, threshold), null);
  assert.equal(withinRange(true, threshold), null);
  assert.equal(withinRange(NaN, threshold), null);
  assert.equal(withinRange(Infinity, threshold), null);
  assert.equal(withinRange('0x10', threshold), null, '十六进制不再被 Number() 顺手接下');
  assert.equal(withinRange('1e2', threshold), null, '指数写法同样不再被接下');
  assert.equal(withinRange('.5', threshold), null, '必须写成 0.5');
  assert.equal(withinRange('12abc', threshold), null);
  assert.equal(withinRange(0, threshold), 0, '0 仍然合法：它是阈值最低的一档，不是非法值');
  assert.equal(withinRange('0', threshold), 0);
  assert.equal(withinRange('50', threshold), 50);
  assert.equal(withinRange(' 50 ', threshold), 50, '两侧空白被 trim 掉');
  assert.equal(withinRange('6.5', threshold), 6.5);
  assert.equal(withinRange(101, threshold), null);
  assert.equal(withinRange('-1', threshold), null);
  assert.equal(withinRange('', GROUP_LIMITS.cooldownSeconds), null);
  assert.equal(withinRange('5', GROUP_LIMITS.cooldownSeconds), 5);
});

test('a blank number row is read as "no override" while a blank persona row stays a value', t => {
  const { store, personas, social } = harness(t);
  const rows = { [GROUP_KEYS.socialThreshold('20000')]: '' };
  assert.equal(numberOverride({ setting: (key, fallback) => (key in rows ? rows[key] : fallback) }, GROUP_KEYS.socialThreshold('20000')), undefined);
  rows[GROUP_KEYS.socialThreshold('20000')] = '   ';
  assert.equal(numberOverride({ setting: (key, fallback) => (key in rows ? rows[key] : fallback) }, GROUP_KEYS.socialThreshold('20000')), undefined);
  rows[GROUP_KEYS.socialThreshold('20000')] = '0';
  assert.equal(numberOverride({ setting: (key, fallback) => (key in rows ? rows[key] : fallback) }, GROUP_KEYS.socialThreshold('20000')), 0, '库里真的是 0 就要读出 0');

  // 同一个 store 里两种空串：人格行是真实值（rawOverride），数字行不是值（numberOverride）。
  store.set(GROUP_KEYS.persona('20000'), '');
  store.set(GROUP_KEYS.socialThreshold('20000'), '');
  const card = personas.groupView('20000');
  assert.equal(card.override, '', '空串是「显式使用内置默认」，不是「没有覆盖」');
  assert.equal(card.source, 'group');
  assert.equal(social.params('20000').threshold, 6, '数字行的空串回落到全局值，不是 0');
  assert.equal(social.params('20000').overridden.threshold, false);
  store.set('social_threshold', '   ');
  assert.equal(social.params('20001').threshold, 6, '全局行被写成空白时回落到 .env 默认值');
  store.set('social_threshold', '0');
  assert.equal(social.params('20001').threshold, 0, '全局行真的写 0 时仍然读回 0');
  assert.equal(clearGroupOverrides(store, '20000').length, 2, '两行都还在库里：谁都没有被折叠掉');
});

test('a blank number sent straight to the API is refused and writes nothing', async t => {
  const { server, store, social } = consoleFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = settingsDump(store);

  const scoped = await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'social', threshold: '' });
  assert.equal(scoped.status, 400, '客户端可以绕过输入框，服务端必须自己拒绝');
  assert.equal((await scoped.json()).error, 'SOCIAL_PARAM_INVALID');
  const global = await jsonPost(base, '/api/social/config', { threshold: '' });
  assert.equal(global.status, 400);
  assert.equal(settingsDump(store), before, '空值没有写进任何一行');
  assert.equal(social.params('20000').threshold, 6);
});

test('threshold 0 is still saveable and reads back as 0, per group and globally', async t => {
  const { server, store, social } = consoleFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const scoped = await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'social', threshold: 0 });
  assert.equal(scoped.status, 200);
  const view = (await scoped.json()).groups.find(g => g.id === '20000').social;
  assert.equal(view.threshold, 0);
  assert.equal(view.overridden.threshold, true);
  assert.equal(store.setting(GROUP_KEYS.socialThreshold('20000'), 'absent'), '0');

  assert.equal((await jsonPost(base, '/api/social/config', { threshold: 0 })).status, 200);
  assert.equal(store.setting('social_threshold', 'absent'), '0');
  assert.equal(social.params('20001').threshold, 0, '其他群继承这个 0');
});

test('a group-scoped idle-only patch is refused instead of silently ignored', async t => {
  const { server, store } = consoleFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = settingsDump(store);

  const res = await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'social', idleMinutes: 60 });
  assert.equal(res.status, 400, '界面必须看到失败，而不是「已保存」');
  assert.equal((await res.json()).error, 'SOCIAL_PARAM_NOT_GROUP_SCOPED');
  assert.equal(settingsDump(store), before, '一个字段都没写');
  assert.equal(store.setting('social_idle_minutes', 'absent'), 'absent');

  // 同一个字段在全局作用域下仍然可以改。
  assert.equal((await jsonPost(base, '/api/social/config', { idleMinutes: 60 })).status, 200);
  assert.equal(store.setting('social_idle_minutes', 'absent'), '60');
});

test('a group patch that fails validation writes nothing at all (E-05)', async t => {
  const { server, store, social } = consoleFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = settingsDump(store);

  // threshold 合法、cooldownSeconds 非法：旧实现会先把 threshold 写成 0 再报错。
  const res = await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'social', threshold: 0, cooldownSeconds: 0 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'SOCIAL_PARAM_INVALID');
  assert.equal(settingsDump(store), before, '抛错之后 settings 表逐字节不变');
  assert.equal(store.setting(GROUP_KEYS.socialThreshold('20000'), 'absent'), 'absent', '阈值没有被写成 0');
  assert.equal(store.setting(GROUP_KEYS.socialCooldown('20000'), 'absent'), 'absent');
  assert.equal(social.params('20000').threshold, 6, '这个群仍然继承全局阈值');

  // 对照组：同一个补丁只把非法项改对，就应该整体成功。
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'social', threshold: 0, cooldownSeconds: 45 })).status, 200);
  assert.equal(store.setting(GROUP_KEYS.socialThreshold('20000'), 'absent'), '0');
  assert.equal(store.setting(GROUP_KEYS.socialCooldown('20000'), 'absent'), '45');
});

test('the group list and the group writer agree on the same set of groups', async t => {
  const { server } = consoleFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const ids = (await (await fetch(`${base}/api/groups`, { headers: auth })).json()).groups.map(g => g.id);
  assert.deepEqual(ids, ['20000', '20001']);
  for (const id of ids) {
    assert.equal((await jsonPost(base, '/api/groups/config', { group: id, subsystem: 'slang', enabled: false })).status, 200, `${id} 在列表里就必须写得进去`);
  }
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '20002', subsystem: 'slang', enabled: false })).status, 404, '不在列表里的群号写不进去');
});

test('with no subsystem able to enumerate groups the list is empty and the writer refuses every group', async t => {
  const { store, personas, config } = harness(t);
  const server = createConsole({ config, store, personas, log: () => {}, port: 0 });
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = settingsDump(store);

  const view = await (await fetch(`${base}/api/groups`, { headers: auth })).json();
  assert.deepEqual(view.available, { personas: true, social: false, slang: false });
  // 读取端与写入端共用同一个集合：没有子系统能枚举群时它为空，`.env` 的 GROUP_QQS
  // 不再是兜底 —— 否则列表里会躺着一批根本没有子系统可以写入的群号。
  assert.deepEqual(view.groups, [], '枚举不出群时列表就是空的');

  // 「已知群号集合为空」的含义是「当前没有任何群可以操作」，不是「那就都放行」。
  for (const id of config.groupIds) {
    assert.equal((await jsonPost(base, '/api/groups/config', { group: id, subsystem: 'social', enabled: true })).status, 404, `${id} 写在 .env 里也一样写不进去`);
  }
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'slang', enabled: true })).status, 404);
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'reset' })).status, 404);
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '99999', subsystem: 'social', enabled: true })).status, 404);
  assert.equal((await jsonPost(base, '/api/groups/config', { group: '20000', subsystem: 'nope' })).status, 404, '群号检查在前，未知群号一律 404');
  assert.equal(settingsDump(store), before, '被拒绝的写入一个字节都没落库');
});
