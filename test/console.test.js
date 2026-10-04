import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createConsole } from '../src/console/server.js';
import { buildSummary, buildConfig, redact } from '../src/console/api.js';

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
  for (const path of ['/api/summary', '/api/sessions', '/api/charges', '/api/logs', '/api/config']) {
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
