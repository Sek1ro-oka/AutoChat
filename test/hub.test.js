// T-033: the read-only instance hub that answers `/api/instances`.
//
// Every test builds its own root under the OS temp directory. The hub reads
// `instances/*.env` and opens SQLite files, so it must never be pointed at the
// repository's own instances/ and data/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig } from '../src/config.js';
import { createHub } from '../src/console/hub.js';
import { defaultDatabasePath, instanceFile } from '../src/instances.js';
import { defaultIsAlive } from '../src/lifecycle.js';
import { Store } from '../src/store.js';

const WINDOWS = ['today', 'week', 'month'];

// Everything `loadConfig` insists on, so an instance env file can stand alone.
const ENV = {
  BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_VERIFIED_DATE: '2026-10-02',
  PRICE_INPUT_CNY_PER_MILLION: '2', PRICE_OUTPUT_CNY_PER_MILLION: '8',
};
const CONFIG = loadConfig({ ...ENV });
const ROW_KEYS = [
  'botQq', 'cards', 'consoleEnabled', 'consolePort', 'database', 'error', 'name', 'ok', 'pid',
  'running', 'warnings',
];
const ZERO = { totalMicro: 0, calls: 0 };

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-hub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The same surface `node scripts/instances.js add` writes: an env file per instance.
function writeInstance(root, name, values = {}) {
  mkdirSync(join(root, 'instances'), { recursive: true });
  const lines = Object.entries({ ...ENV, ...values }).map(([key, value]) => `${key}=${value}`);
  const file = instanceFile(root, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// The hub never creates a database, so a test that wants cards has to make one.
function seedDatabase(root, name, samples = []) {
  const path = resolve(root, defaultDatabasePath(name));
  mkdirSync(dirname(path), { recursive: true });
  const store = new Store(path);
  try {
    for (const sample of samples) store.noteSample(sample);
  } finally {
    store.close();
  }
  return path;
}

const databaseOf = (root, name) => resolve(root, defaultDatabasePath(name));
const lockOf = databasePath => join(dirname(databasePath), 'autochat.lock');

test('an empty checkout has no instances and an all-zero aggregate', t => {
  const snapshot = createHub({ root: tempRoot(t) }).list();
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['aggregate', 'counts', 'directory', 'instances', 'scannedAt']);
  assert.equal(snapshot.directory, 'instances');
  assert.equal(typeof snapshot.scannedAt, 'number');
  assert.deepEqual(snapshot.instances, []);
  assert.deepEqual(snapshot.counts, { total: 0, running: 0, ready: 0 });
  for (const window of WINDOWS) assert.deepEqual(snapshot.aggregate[window], ZERO);
});

test('one ready instance reports its settings and three zero cards', t => {
  const root = tempRoot(t);
  writeInstance(root, 'alpha', { BOT_QQ: '10000011', CONSOLE_PORT: '3210', CONSOLE_ENABLED: 'true' });
  seedDatabase(root, 'alpha');
  const snapshot = createHub({ root }).list();
  assert.deepEqual(snapshot.counts, { total: 1, running: 0, ready: 1 });
  const [row] = snapshot.instances;
  assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
  assert.equal(row.name, 'alpha');
  assert.equal(row.ok, true);
  assert.equal(row.error, null);
  assert.equal(row.database, true);
  assert.equal(row.running, false);
  assert.equal(row.pid, null);
  assert.equal(row.consolePort, 3210);
  assert.equal(row.consoleEnabled, true);
  assert.equal(row.botQq, '10000011');
  assert.deepEqual(row.warnings, []);
  for (const window of WINDOWS) assert.deepEqual(row.cards[window], ZERO);
  for (const window of WINDOWS) assert.deepEqual(snapshot.aggregate[window], ZERO);
});

test('liveness is the bot lock pid plus the injected isAlive', t => {
  const root = tempRoot(t);
  writeInstance(root, 'alpha');
  const lock = lockOf(seedDatabase(root, 'alpha'));
  // A pid the OS really does not have: the default check must call it dead.
  const dead = [999999, 888888, 777777, 666666].find(pid => !defaultIsAlive(pid));
  assert.ok(dead, 'no dead pid was available to test with');
  writeFileSync(lock, `${JSON.stringify({ pid: dead, startedAt: Date.now() })}\n`);
  const cold = createHub({ root }).list();
  assert.equal(cold.instances[0].running, false);
  assert.equal(cold.instances[0].pid, null);
  assert.equal(cold.counts.running, 0);

  writeFileSync(lock, `${JSON.stringify({ pid: 4242, startedAt: Date.now() })}\n`);
  const alive = createHub({ root, isAlive: pid => pid === 4242 }).list();
  assert.equal(alive.instances[0].running, true);
  assert.equal(alive.instances[0].pid, 4242);
  assert.equal(alive.counts.running, 1);
  assert.equal(alive.counts.ready, 1);
});

test('a missing database is reported and never created', t => {
  const root = tempRoot(t);
  writeInstance(root, 'ghost');
  const database = databaseOf(root, 'ghost');
  assert.equal(existsSync(database), false);
  const snapshot = createHub({ root }).list();
  const [row] = snapshot.instances;
  assert.equal(row.database, false);
  assert.equal(row.ok, false);
  assert.equal(row.error, 'DATABASE_MISSING');
  for (const window of WINDOWS) assert.deepEqual(row.cards[window], ZERO);
  // Opening it through `Store` would have created an empty sqlite and hidden the bug.
  assert.equal(existsSync(database), false);
  assert.deepEqual(snapshot.counts, { total: 1, running: 0, ready: 0 });
});

test('prices come from the instance env, else the local config with a warning', t => {
  const root = tempRoot(t);
  writeInstance(root, 'alpha', { DEEPSEEK_API_KEY: '' });
  seedDatabase(root, 'alpha');
  const strict = createHub({ root }).list();
  assert.equal(strict.instances[0].ok, false);
  assert.match(strict.instances[0].error, /缺少配置/);
  assert.equal(strict.instances[0].database, true);
  for (const window of WINDOWS) assert.deepEqual(strict.instances[0].cards[window], ZERO);

  const local = createHub({ root, config: CONFIG }).list();
  assert.equal(local.instances[0].ok, true);
  assert.deepEqual(local.instances[0].warnings, ['价格按本机配置估算']);
});

test('the snapshot is cached for ttlMs and restamped once it expires', t => {
  const root = tempRoot(t);
  writeInstance(root, 'alpha');
  seedDatabase(root, 'alpha');
  let clock = Date.UTC(2026, 0, 15, 4, 0, 0);
  const hub = createHub({ root, now: () => clock, ttlMs: 1000 });
  const first = hub.list();
  assert.equal(first.scannedAt, clock);
  clock += 999;
  assert.equal(hub.list().scannedAt, first.scannedAt);
  // Exactly ttlMs is already stale: the window is half-open.
  clock += 1;
  assert.equal(hub.list().scannedAt, clock);
});

test('the aggregate adds up exactly the readable rows', t => {
  const root = tempRoot(t);
  const at = Date.UTC(2026, 0, 15, 4, 0, 0);
  writeInstance(root, 'alpha');
  writeInstance(root, 'beta');
  seedDatabase(root, 'alpha', [{
    turnKey: 't1', session: 's1', turn: 1, seq: 0, at: at - 60000,
    miss: 1000, hit: 0, out: 100, bucket: 'peak',
  }]);
  const snapshot = createHub({ root, config: CONFIG, now: () => at }).list();
  const rows = new Map(snapshot.instances.map(row => [row.name, row]));
  assert.equal(rows.get('alpha').ok, true);
  // `beta` has no database: its row is not allowed to contribute a cent.
  assert.equal(rows.get('beta').ok, false);
  for (const window of WINDOWS) {
    assert.equal(snapshot.aggregate[window].calls, 1);
    assert.equal(snapshot.aggregate[window].totalMicro, rows.get('alpha').cards[window].totalMicro);
    assert.ok(snapshot.aggregate[window].totalMicro > 0);
  }
  assert.deepEqual(snapshot.counts, { total: 2, running: 0, ready: 1 });
});
