import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

test('a fresh store exposes every V2 table', () => {
  const store = new Store();
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of ['settings', 'sessions', 'groups', 'events', 'charges',
    'messages', 'personas', 'slang', 'sim_state', 'token_samples']) {
    assert.ok(names.includes(table), `missing table ${table}`);
  }
  store.close();
});

test('a pre-V2 database is upgraded in place without losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-schema-'));
  const path = join(dir, 'legacy.sqlite');
  // Hand-build the old schema: sessions/charges without the V2 columns.
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (key TEXT PRIMARY KEY, scope TEXT NOT NULL, history TEXT NOT NULL);
    CREATE TABLE charges (id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER NOT NULL,
      actual INTEGER, state TEXT NOT NULL, created INTEGER NOT NULL);`);
  legacy.prepare('INSERT INTO settings VALUES (?,?)').run('enabled', '0');
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?)')
    .run('private:10000002', 'private', '[{"role":"user","content":"hi"}]');
  legacy.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?)')
    .run('c1', '2026-10-02', 100, 80, 'settled', 1);
  legacy.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?)')
    .run('c2', '2026-10-02', 50, null, 'reserved', 2);
  legacy.close();

  const store = new Store(path);
  assert.equal(store.setting('enabled'), '0');
  assert.equal(store.history('private:10000002').length, 1);
  const balance = store.balance('2026-10-02', 1000000);
  assert.equal(balance.used, 80);
  assert.equal(balance.held, 50);
  // New columns get safe defaults on old rows.
  assert.equal(store.db.prepare('SELECT bucket FROM charges WHERE id=?').get('c1').bucket, 'peak');
  assert.equal(store.db.prepare('SELECT session_key FROM charges WHERE id=?').get('c1').session_key, null);
  assert.equal(store.db.prepare('SELECT items FROM sessions WHERE key=?').get('private:10000002').items, 0);
  store.close();

  // Re-opening runs migrate() a second time: must be idempotent.
  const again = new Store(path);
  assert.equal(again.balance('2026-10-02', 1000000).used, 80);
  again.close();
  for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
  rmdirSync(dir);
});

test('session listing reports size and timestamp without loading history', () => {
  const store = new Store();
  store.save('private:10000002', 'private', [{ role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' }], 5000);
  const [row] = store.listSessions();
  assert.equal(row.key, 'private:10000002');
  assert.equal(row.scope, 'private');
  assert.equal(row.items, 2);
  assert.equal(row.updated, 5000);
  store.close();
});

test('message ledger dedups by (group, message) and prunes by time', () => {
  const store = new Store();
  store.noteMessage({ groupId: '10000003', messageId: '7', userId: '10000004', at: 1000, text: 'hi' });
  store.noteMessage({ groupId: '10000003', messageId: '7', userId: '10000004', at: 1000, text: 'hi again' });
  assert.equal(store.recentMessages('10000003', { since: 0 }).length, 1);
  assert.equal(store.recentMessages('10000003', { since: 0 })[0].text, 'hi again');
  store.noteMessage({ groupId: '10000003', messageId: '8', userId: '10000004', at: 500, text: 'old' });
  assert.equal(store.recentMessages('10000003', { since: 0 }).length, 2);
  assert.equal(store.pruneMessages(800), 1);
  assert.equal(store.recentMessages('10000003', { since: 0 }).length, 1);
  store.close();
});

test('charge history can be aggregated per day with reservation metadata', () => {
  const store = new Store();
  const a = store.reserve('2026-10-02', 100, 1000000, 1, { sessionKey: 'private:1', bucket: 'peak' });
  store.settle(a, 60);
  store.reserve('2026-10-03', 40, 1000000, 2, { sessionKey: 'group:9', bucket: 'off' });
  const days = store.chargeDays(10);
  assert.deepEqual(days.map(row => row.day), ['2026-10-03', '2026-10-02']);
  assert.equal(days[1].used, 60);
  assert.equal(days[0].held, 40);
  assert.equal(store.db.prepare('SELECT bucket FROM charges WHERE id=?').get(a).bucket, 'peak');
  store.close();
});
