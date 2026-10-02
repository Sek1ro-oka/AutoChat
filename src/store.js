import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function budgetDay(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, scope TEXT NOT NULL, history TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, due INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS charges (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER NOT NULL,
        actual INTEGER, state TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS charges_day ON charges(day);
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key, fallback = null) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, String(value));
  }
  claim(key, now) {
    return this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?)').run(key, now).changes === 1;
  }
  pruneEvents(now) {
    this.db.prepare('DELETE FROM events WHERE created < ?').run(now - 7 * 86400000);
  }
  history(key) {
    const row = this.db.prepare('SELECT history FROM sessions WHERE key=?').get(key);
    return row ? JSON.parse(row.history) : [];
  }
  save(key, scope, history) {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(key, scope, JSON.stringify(history));
  }
  clear(key) { this.db.prepare('DELETE FROM sessions WHERE key=?').run(key); }
  ensureGroup(id, now, period) {
    this.db.prepare('INSERT OR IGNORE INTO groups VALUES (?,?)').run(id, now + period);
    return this.groupDue(id);
  }
  groupDue(id) { return this.db.prepare('SELECT due FROM groups WHERE id=?').get(id)?.due; }
  cleanupGroups(now, period) {
    return this.transaction(() => {
      const expired = this.db.prepare('SELECT id,due FROM groups WHERE due <= ?').all(now);
      for (const group of expired) {
        this.db.prepare('DELETE FROM sessions WHERE scope=?').run(`group:${group.id}`);
        const due = group.due + (Math.floor((now - group.due) / period) + 1) * period;
        this.db.prepare('UPDATE groups SET due=? WHERE id=?').run(due, group.id);
      }
      return expired.length;
    });
  }
  balance(day, limit) {
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) AS used,
      COALESCE(SUM(CASE WHEN state!='settled' THEN reserved ELSE 0 END),0) AS held
      FROM charges WHERE day=?`).get(day);
    return { ...row, remaining: Math.max(0, limit - row.used - row.held) };
  }
  reserve(day, micro, limit, now) {
    if (!Number.isSafeInteger(micro) || micro < 0) throw new Error('Invalid reservation');
    return this.transaction(() => {
      if (this.setting(`overrun:${day}`) === '1' || this.balance(day, limit).remaining < micro) return null;
      const id = randomUUID();
      this.db.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?)').run(id, day, micro, null, 'reserved', now);
      return id;
    });
  }
  settle(id, micro) {
    if (!Number.isSafeInteger(micro) || micro < 0) throw new Error('Invalid settlement');
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM charges WHERE id=?').get(id);
      if (!row || row.state === 'settled') return;
      if (micro > row.reserved) this.set(`overrun:${row.day}`, '1');
      this.db.prepare("UPDATE charges SET actual=?,state='settled' WHERE id=?").run(micro, id);
    });
  }
  uncertain(id) {
    this.db.prepare("UPDATE charges SET state='uncertain' WHERE id=? AND state!='settled'").run(id);
  }
}
