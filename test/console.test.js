import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
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

const auth = { 'x-console-token': TOKEN };

test('every api route requires the console token', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/summary', '/api/sessions', '/api/charges', '/api/logs', '/api/config',
    '/api/cost', '/api/cost/turns']) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(`${base}/api/summary?token=wrong`)).status, 401);
  assert.equal((await fetch(`${base}/api/summary`, { headers: { 'x-console-token': 'wrong' } })).status, 401);
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
  assert.match(await page.text(), /AutoChat 控制台/);
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
