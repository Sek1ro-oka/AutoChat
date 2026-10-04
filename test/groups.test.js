import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Personas } from '../src/personas.js';
import { Social } from '../src/social/engine.js';
import { Slang } from '../src/social/slang.js';
import { clearGroupOverrides } from '../src/group-settings.js';
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
