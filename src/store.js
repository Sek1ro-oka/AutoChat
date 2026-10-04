import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function budgetDay(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

// Base schema. Tables are created with the current shape; older databases are
// upgraded in place by `migrate()` below (see the ALTER TABLE notes there).
const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  PRAGMA secure_delete=ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY, scope TEXT NOT NULL, history TEXT NOT NULL,
    updated INTEGER, items INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, due INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS charges (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER NOT NULL,
    actual INTEGER, state TEXT NOT NULL, created INTEGER NOT NULL,
    session_key TEXT, bucket TEXT NOT NULL DEFAULT 'peak'
  );
  CREATE INDEX IF NOT EXISTS charges_day ON charges(day);
  -- Group message ledger: only what social simulation and slang learning need.
  CREATE TABLE IF NOT EXISTS messages (
    group_id TEXT NOT NULL, message_id TEXT NOT NULL, user_id TEXT NOT NULL,
    at INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
    PRIMARY KEY (group_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS messages_at ON messages(at);
  CREATE TABLE IF NOT EXISTS personas (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS slang (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '',
    usage TEXT NOT NULL DEFAULT '', example TEXT NOT NULL DEFAULT '', risk TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate', source TEXT NOT NULL DEFAULT 'ai',
    count INTEGER NOT NULL DEFAULT 1, sources TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS slang_status ON slang(status);
  CREATE TABLE IF NOT EXISTS sim_state (
    group_id TEXT PRIMARY KEY, state TEXT NOT NULL, last_spoke_at INTEGER,
    energy REAL NOT NULL DEFAULT 0, updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS token_samples (
    turn_key TEXT PRIMARY KEY, session TEXT NOT NULL, turn INTEGER NOT NULL,
    seq INTEGER NOT NULL, at INTEGER NOT NULL, miss INTEGER NOT NULL DEFAULT 0,
    hit INTEGER NOT NULL DEFAULT 0, out INTEGER NOT NULL DEFAULT 0,
    bucket TEXT NOT NULL DEFAULT 'peak'
  );
  CREATE INDEX IF NOT EXISTS token_samples_at ON token_samples(at);
`;

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrate();
  }
  // Bring pre-V2 databases up to the current column set. Idempotent: every step
  // is guarded by a PRAGMA check, so it is safe to run on every startup.
  migrate() {
    const add = (table, column, definition) => {
      if (!columns(this.db, table).has(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    add('sessions', 'updated', 'INTEGER');
    add('sessions', 'items', 'INTEGER NOT NULL DEFAULT 0');
    add('charges', 'session_key', 'TEXT');
    add('charges', 'bucket', "TEXT NOT NULL DEFAULT 'peak'");
    this.db.exec('CREATE INDEX IF NOT EXISTS charges_session ON charges(session_key)');
    return this;
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
  save(key, scope, history, now = Date.now()) {
    this.db.prepare(`INSERT OR REPLACE INTO sessions (key, scope, history, updated, items)
      VALUES (?,?,?,?,?)`).run(key, scope, JSON.stringify(history), now, history.length);
  }
  clear(key) { this.db.prepare('DELETE FROM sessions WHERE key=?').run(key); }
  // Read-only listing for the console: no history payload, just shape and size.
  listSessions(limit = 200) {
    return this.db.prepare(`SELECT key, scope, updated, items FROM sessions
      ORDER BY updated DESC LIMIT ?`).all(Math.max(1, Math.min(1000, Number(limit) || 200)));
  }
  ensureGroup(id, now, period) {
    this.db.prepare('INSERT OR IGNORE INTO groups VALUES (?,?)').run(id, now + period);
    return this.groupDue(id);
  }
  groupDue(id) { return this.db.prepare('SELECT due FROM groups WHERE id=?').get(id)?.due; }
  listGroups() { return this.db.prepare('SELECT id, due FROM groups ORDER BY id').all(); }
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
  chargeDays(limit = 30) {
    return this.db.prepare(`SELECT day,
      COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) AS used,
      COALESCE(SUM(CASE WHEN state!='settled' THEN reserved ELSE 0 END),0) AS held,
      COUNT(*) AS calls
      FROM charges GROUP BY day ORDER BY day DESC LIMIT ?`)
      .all(Math.max(1, Math.min(400, Number(limit) || 30)));
  }
  reserve(day, micro, limit, now, { sessionKey = null, bucket = 'peak' } = {}) {
    if (!Number.isSafeInteger(micro) || micro < 0) throw new Error('Invalid reservation');
    return this.transaction(() => {
      if (this.setting(`overrun:${day}`) === '1' || this.balance(day, limit).remaining < micro) return null;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO charges (id, day, reserved, actual, state, created, session_key, bucket)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, day, micro, null, 'reserved', now, sessionKey, bucket);
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
  // --- Group message ledger (V2) -------------------------------------------
  noteMessage({ groupId, messageId, userId, at, text, kind = 'text' }) {
    this.db.prepare(`INSERT OR REPLACE INTO messages (group_id, message_id, user_id, at, text, kind)
      VALUES (?,?,?,?,?,?)`).run(String(groupId), String(messageId), String(userId), at, String(text ?? ''), kind);
  }
  recentMessages(groupId, { since = 0, limit = 100 } = {}) {
    return this.db.prepare(`SELECT group_id, message_id, user_id, at, text, kind FROM messages
      WHERE group_id=? AND at>=? ORDER BY at DESC LIMIT ?`)
      .all(String(groupId), since, Math.max(1, Math.min(500, Number(limit) || 100)));
  }
  pruneMessages(cutoff) { return this.db.prepare('DELETE FROM messages WHERE at < ?').run(cutoff).changes; }
}
