import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Personas } from '../src/personas.js';
import { Social } from '../src/social/engine.js';
import { Slang } from '../src/social/slang.js';
import { DEFAULT_PERSONA } from '../src/persona.js';
import { createConsole } from '../src/console/server.js';
import { buildSummary, buildConfig, buildCost, buildCostTurns, redact } from '../src/console/api.js';

const TOKEN = 'test-console-token-1234';

function fixture(t, overrides = {}) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, apiKey: 'sk-supersecret-key',
    onebotToken: 'onebot-supersecret', consoleToken: TOKEN, consolePort: 0,
    webSearchEnabled: true, visionEnabled: false, antiSpamEnabled: true, groupManagementEnabled: false,
    ...overrides,
  };
  const bot = { queued: 0, sendFailures: 0 };
  const transport = { ready: true, retry: 0 };
  const runtime = { stats: () => [{ name: 'core', failures: 0, lastError: null }] };
  const server = createConsole({ config, store, bot, transport, runtime, log: () => {}, port: 0 });
  return { store, config, server };
}

// A console wired to a real persona directory, for the Phase 2 write paths.
function personaFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-console-personas-'));
  const store = new Store();
  const personas = new Personas({ directory: root, store, log: () => {} });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0 };
  const server = createConsole({ config, store, personas, log: () => {}, port: 0 });
  return { store, personas, server };
}

// A console wired to a real Social engine, for the Phase 3 read/write paths.
function socialFixture(t) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000'],
    socialEnabled: false, socialThreshold: 6, socialCooldownSeconds: 45, socialDailyLimit: 20,
    socialContextMessages: 12, socialMaxChunks: 3, socialMinDelayMs: 0, socialMaxDelayMs: 0,
    socialMessageTtlMs: 24 * 3600000, botName: '', botNicknames: [],
    blockTerms: [], maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const model = { complete: async () => ({ text: '好', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  const social = new Social({ config, store, model, log: () => {}, now: () => 1800000000000 });
  const server = createConsole({ config, store, social, log: () => {}, port: 0 });
  return { store, social, server };
}

// A console wired to a real Slang library, for the Phase 4 read/write paths.
function slangFixture(t) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000'],
    slangEnabled: true, slangInjectMax: 20, slangExtractMessages: 120,
    slangAutoExtract: false, slangExtractIntervalHours: 12, webSearchEnabled: false,
    maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const model = {
    complete: async () => ({
      text: '[{"term":"yyds","meaning":"永远的神","example":"这才是 yyds"}]',
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
  };
  store.noteMessage({ groupId: '20000', messageId: 'm1', userId: '30001', at: Date.now() - 1000, text: '这才是 yyds' });
  const slang = new Slang({ config, store, model, log: () => {} });
  const server = createConsole({ config, store, slang, log: () => {}, port: 0 });
  return { store, slang, server };
}

const auth = { 'x-console-token': TOKEN };
const jsonPost = (base, path, body, extra = {}) => fetch(base + path, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

test('every api route requires the console token', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/summary', '/api/sessions', '/api/charges', '/api/logs', '/api/config',
    '/api/cost', '/api/cost/turns', '/api/personas', '/api/personas/file', '/api/social',
    '/api/settings', '/api/slang', '/api/slang/entry', '/api/slang/export']) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(`${base}/api/summary?token=wrong`)).status, 401);
  assert.equal((await fetch(`${base}/api/summary`, { headers: { 'x-console-token': 'wrong' } })).status, 401);
});

test('responses refuse to be framed and carry no external origin', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  // The write endpoints accept same-origin requests, so a third-party page that
  // could frame the console would have a clickjacking path into the persona and
  // slang editors. Both the legacy header and the CSP directive are sent.
  for (const path of ['/', '/app.js', '/api/summary?token=' + TOKEN]) {
    const response = await fetch(base + path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /base-uri 'none'/, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
  }
});

test('a valid token returns data through header and query string', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const header = await fetch(`${base}/api/summary`, { headers: auth });
  assert.equal(header.status, 200);
  const summary = await header.json();
  assert.equal(summary.budget.limitMicro, 1000000);
  assert.equal(summary.connection.ready, true);
  assert.equal(summary.participants[0].name, 'core');
  assert.equal((await fetch(`${base}/api/sessions?token=${TOKEN}`)).status, 200);
});

test('unknown api routes 404 and the shell page needs no token', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /AutoChat 控制台/);
  for (const page of ['social', 'slang', 'stickers', 'settings']) assert.match(html, new RegExp(`data-page="${page}"`), `${page} is reachable from the nav`);
  // Load order matters: pages.js defines the `pages` object, pages-extra.js,
  // pages-stickers.js and pages-settings.js add their pages to it, and app.js
  // renders the result.
  assert.match(html, /<script src="pages\.js"><\/script>\s*<script src="pages-extra\.js"><\/script>\s*<script src="pages-stickers\.js"><\/script>\s*<script src="pages-settings\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  // The script assets are served without a token: they are code, not data, and
  // the browser cannot attach a header to its own <script> fetch.
  for (const asset of ['app.js', 'pages.js', 'pages-extra.js', 'pages-stickers.js', 'pages-settings.js']) {
    const served = await fetch(`${base}/${asset}`);
    assert.equal(served.status, 200, asset);
    assert.match(served.headers.get('content-type'), /javascript/, asset);
  }
  assert.match(await (await fetch(`${base}/app.js`)).text(), /autochat\.console\.token/);
  assert.match(await (await fetch(`${base}/pages.js`)).text(), /async overview\(\)/);
  assert.match(await (await fetch(`${base}/pages-extra.js`)).text(), /async slang\(\)/);
  assert.match(await (await fetch(`${base}/pages-stickers.js`)).text(), /async stickers\(\)/);
  assert.match(await (await fetch(`${base}/pages-settings.js`)).text(), /async settings\(\)/);
  assert.equal((await fetch(`${base}/../src/config.js`)).status, 404, 'no path traversal out of public/');
  assert.equal((await fetch(`${base}/app.js.bak`)).status, 404);
});

test('credentials never appear in console responses', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const text = await (await fetch(`${base}/api/config`, { headers: auth })).text();
  for (const secret of ['sk-supersecret-key', 'onebot-supersecret', TOKEN]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.match(text, /sk-s••••ey/);
});

test('the console binds loopback only', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  assert.equal(server.address().address, '127.0.0.1');
});

test('summary and config builders are pure and redact secrets', () => {
  const store = new Store();
  const config = { budgetMicro: 500000, model: 'deepseek-flash', apiKey: 'sk-abcdefghijkl',
    onebotToken: 'tok', consoleToken: 'consoletokenvalue' };
  const summary = buildSummary({ config, store, bot: { queued: 3, sendFailures: 1 },
    transport: { ready: false, retry: 2 }, runtime: null, now: 1800000000000, startedAt: 1800000000000 });
  assert.equal(summary.queue.depth, 3);
  assert.equal(summary.connection.ready, false);
  assert.equal(summary.participants.length, 0);
  const built = buildConfig({ config });
  assert.equal(built.credentials.apiKey, 'sk-a••••kl');
  assert.ok(!JSON.stringify(built).includes('sk-abcdefghijkl'));
  assert.equal(redact({ nested: { secretKey: 'value' } }).nested.secretKey, '••••');
  store.close();
});

test('the cost dashboard zero-fills its range and prices samples supplied by the store', () => {
  const store = new Store();
  const config = { inputPrice: 2, outputPrice: 8, cacheHitPrice: 0.04, offPeakRatio: 0.5 };
  // 2026-10-08 10:30 Beijing -> peak; 2026-10-09 02:00 Beijing -> off.
  const peakAt = Date.UTC(2026, 9, 8, 2, 30);
  const offAt = Date.UTC(2026, 9, 8, 18, 0);
  const empty = buildCost({ config, store, range: '7d', now: peakAt });
  assert.equal(empty.series.length, 7);
  assert.equal(empty.unit, 'day');
  assert.equal(empty.totals.tokens, 0);
  assert.equal(empty.totals.hitRate, null);
  assert.equal(empty.series[6].t, Date.UTC(2026, 9, 8, -8, 0)); // last bucket starts at China midnight

  store.noteSample({ turnKey: 'private:1:1:1', session: 'private:1', turn: 1, seq: 1, at: peakAt,
    miss: 1000000, hit: 0, out: 0, bucket: 'peak' });
  store.noteSample({ turnKey: 'private:1:1:2', session: 'private:1', turn: 1, seq: 2, at: offAt,
    miss: 0, hit: 1000000, out: 0, bucket: 'off' });

  const cost = buildCost({ config, store, range: '7d', now: offAt });
  assert.equal(cost.totals.tokens, 2000000);
  assert.equal(cost.totals.turns, 1);
  assert.equal(cost.totals.calls, 2);
  assert.equal(cost.totals.peakMicro, 2000000); // 1M miss at 2 CNY/M
  assert.equal(cost.totals.offMicro, 20000); // 1M cache-hit at 0.02 CNY/M (off-peak half of 0.04)
  assert.equal(cost.totals.hitRate, 0.5);
  assert.equal(cost.sessions.length, 1);
  assert.equal(cost.sessions[0].session, 'private:1');
  assert.equal(cost.recent.length, 2);

  const turns = buildCostTurns({ config, store, session: 'private:1' });
  assert.equal(turns.turns.length, 1);
  assert.equal(turns.turns[0].calls, 2);
  assert.equal(turns.turns[0].peakMicro + turns.turns[0].offMicro, turns.turns[0].totalMicro);
  store.close();
});

test('persona writes require the header token and a loopback origin', async t => {
  const { server } = personaFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  // A query-string token is fine for reads (that is how the printed link works)
  // but never for writes: a URL can be replayed by a third party.
  const onlyQuery = await fetch(`${base}/api/personas/file?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '甲', content: '内容' }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');
  const foreign = await jsonPost(base, '/api/personas/file', { name: '甲', content: '内容' },
    { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');
  assert.equal((await jsonPost(base, '/api/personas/file', { name: '甲', content: '内容' })).status, 200);
});

test('a card saved in the console changes the very next resolved prompt', async t => {
  const { server, personas } = personaFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const saved = await (await jsonPost(base, '/api/personas/file', { name: '测试卡', content: '你是测试角色。' })).json();
  assert.equal(saved.saved.name, '测试卡');
  assert.equal(saved.characters.length, 1);
  assert.equal(saved.characters[0].active, false);

  const activated = await (await jsonPost(base, '/api/personas/active', { name: '测试卡' })).json();
  assert.equal(activated.source, 'card');
  assert.equal(personas.resolve(), '你是测试角色。');

  const file = await (await fetch(`${base}/api/personas/file?name=${encodeURIComponent('测试卡')}`, { headers: auth })).json();
  assert.equal(file.content, '你是测试角色。');
  assert.equal(file.exists, true);

  // Only client-caused failures get a real status code instead of a blanket 500.
  const bad = await jsonPost(base, '/api/personas/file', { name: '../evil', content: '内容' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'PERSONA_NAME_INVALID');
  assert.equal((await jsonPost(base, '/api/personas/file', { name: '测试卡', content: '' })).status, 400);
  assert.equal((await jsonPost(base, '/api/personas/active', { name: '不存在' })).status, 404);
  assert.equal((await jsonPost(base, '/api/personas/file', null)).status, 400, 'a malformed body is 400');

  const removed = await (await jsonPost(base, '/api/personas/delete', { name: '测试卡' })).json();
  assert.equal(removed.deleted, '测试卡');
  assert.equal(removed.active, '', 'deleting the active card clears the selection');
  assert.equal((await jsonPost(base, '/api/personas/delete', { name: '测试卡' })).status, 404);
});

test('the behaviour layer round-trips through the console but only applies after a restart', async t => {
  const { server, personas } = personaFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const before = await (await fetch(`${base}/api/personas/file?kind=behavior`, { headers: auth })).json();
  assert.equal(before.kind, 'behavior');
  assert.equal(before.exists, false);
  assert.equal(before.restart, true);

  const after = await (await jsonPost(base, '/api/personas/file', { kind: 'behavior', content: '先观察再开口。' })).json();
  assert.equal(after.restart, true);
  assert.equal(after.behavior.onDisk, true);
  assert.equal(after.behavior.loaded, false, 'the running process keeps its old protocol');
  assert.equal(after.behavior.pending, true);
  assert.equal(personas.resolve(), DEFAULT_PERSONA);
});

test('the simulation page reads state and accepts only guarded parameter writes', async t => {
  const { server } = socialFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const view = await (await fetch(`${base}/api/social`, { headers: auth })).json();
  assert.equal(view.available, true);
  assert.equal(view.enabled, false, 'off by default, matching a stock .env');
  assert.equal(view.groups[0].id, '20000');
  assert.equal(view.groups[0].state, 'observing');
  assert.equal(view.groups[0].decision, null);

  const onlyQuery = await fetch(`${base}/api/social/config?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');
  const foreign = await jsonPost(base, '/api/social/config', { enabled: true }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');

  const enabled = await (await jsonPost(base, '/api/social/config', { enabled: true, threshold: 3 })).json();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.params.threshold, 3);
  assert.equal((await jsonPost(base, '/api/social/config', { threshold: 999 })).status, 400);
  assert.equal((await jsonPost(base, '/api/social/config', { cooldownSeconds: 1 })).status, 400);
  assert.equal((await jsonPost(base, '/api/social/config', { group: '99999', muted: true })).status, 400);
});

test('the settings page lists configurable fields and applies guarded edits', async t => {
  const { server, store } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const view = await (await fetch(`${base}/api/settings`, { headers: auth })).json();
  assert.ok(view.fields.length > 0);
  assert.ok(view.groups.some(group => group.id === 'budget'));
  const budget = view.fields.find(field => field.name === 'budgetMicro');
  assert.equal(budget.value, '1', '1,000,000 micro = 1 yuan');
  assert.equal(budget.defaultValue, '1');

  // Writes need the header token and a loopback origin, like every other write.
  const onlyQuery = await fetch(`${base}/api/settings?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'budgetMicro', value: '2' }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');

  const edited = await (await jsonPost(base, '/api/settings', { name: 'budgetMicro', value: '2' })).json();
  assert.equal(edited.fields.find(field => field.name === 'budgetMicro').value, '2');
  assert.equal(store.setting('cfg:budget_cny', null), '2');

  // Out-of-range or unknown fields are rejected with a real status code.
  assert.equal((await jsonPost(base, '/api/settings', { name: 'budgetMicro', value: '-5' })).status, 400);
  assert.equal((await jsonPost(base, '/api/settings', { name: 'nope', value: '1' })).status, 400);

  // Clearing the value deletes the row, restoring the .env default.
  const cleared = await (await jsonPost(base, '/api/settings', { name: 'budgetMicro', value: '' })).json();
  assert.equal(cleared.fields.find(field => field.name === 'budgetMicro').value, '1');
  assert.equal(store.setting('cfg:budget_cny', null), null);
});

test('the slang page reads the library, guards its writes and keeps chat text out of the list', async t => {
  const { server, slang, store } = slangFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const empty = await (await fetch(`${base}/api/slang`, { headers: auth })).json();
  assert.equal(empty.available, true);
  assert.equal(empty.enabled, true);
  assert.equal(empty.stats.total, 0);
  assert.equal(empty.preview, '', 'nothing is injected before a human confirms anything');
  assert.deepEqual(empty.groups, ['20000']);

  // Writes need the header token and a loopback origin, like every other write.
  const onlyQuery = await fetch(`${base}/api/slang/config?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');
  const foreign = await jsonPost(base, '/api/slang/extract', { group: '20000' }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');

  // Extraction costs a model call, so the failure modes must be real statuses.
  assert.equal((await jsonPost(base, '/api/slang/extract', { group: '99999' })).status, 400);
  assert.equal((await jsonPost(base, '/api/slang/extract', { group: '20000' })).status, 200);

  const listed = await (await fetch(`${base}/api/slang`, { headers: auth })).json();
  assert.equal(listed.stats.candidate, 1);
  assert.equal(listed.entries[0].term, 'yyds');
  assert.equal(listed.entries[0].example, undefined, 'a verbatim group quote never rides along with the list');
  const id = listed.entries[0].id;

  const detail = await (await fetch(`${base}/api/slang/entry?id=${id}`, { headers: auth })).json();
  assert.equal(detail.entry.example, '这才是 yyds', 'it is served on an explicit click');

  const confirmed = await (await jsonPost(base, '/api/slang/status', { id, status: 'confirmed' })).json();
  assert.equal(confirmed.stats.confirmed, 1);
  assert.match(confirmed.preview, /yyds = 永远的神/, 'the page shows exactly what would be injected');
  assert.equal(store.listSlang({ status: 'confirmed' }).length, 1);

  assert.equal((await jsonPost(base, '/api/slang/status', { id, status: 'nonsense' })).status, 400);
  assert.equal((await jsonPost(base, '/api/slang/status', { id: 'missing', status: 'confirmed' })).status, 404);
  assert.equal((await jsonPost(base, '/api/slang/entry', { id })).status, 400);
  assert.equal((await jsonPost(base, '/api/slang/lookup', { id })).status, 409, 'web search is off in this fixture');
  assert.equal((await jsonPost(base, '/api/slang/delete', { id: 'missing' })).status, 404);

  // Backup export is a read; restore refuses a corrupt file instead of emptying the library.
  const exported = await (await fetch(`${base}/api/slang/export`, { headers: auth })).json();
  assert.equal(exported.version, 1);
  assert.equal(exported.entries.length, 1);
  assert.equal((await jsonPost(base, '/api/slang/import', { text: '{ broken' })).status, 400);
  assert.equal(store.countSlang().total, 1, 'a failed restore changes nothing');

  const removed = await (await jsonPost(base, '/api/slang/delete', { id })).json();
  assert.equal(removed.stats.total, 0);
  assert.equal(slang.describe().preview, '');
});
