import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Billing and time-bucket boundaries are always China time (UTC+8, no DST).
export const CHINA_OFFSET_MS = 8 * 3600000;
const CHINA_SHIFT = CHINA_OFFSET_MS;

export function budgetDay(now = Date.now()) {
  return new Date(now + CHINA_OFFSET_MS).toISOString().slice(0, 10);
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
  CREATE INDEX IF NOT EXISTS token_samples_session ON token_samples(session, turn);
  -- Monotonic counters (Phase 5 uses 'turn'). Kept in SQLite, not in memory, so
  -- the value survives a restart: reused turn ids would overwrite old samples.
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

// Six non-overlapping peak/off splits. Every aggregate that reports money reuses
// this fragment so the console never has to guess which price a token paid.
const SPLITS = `
  COALESCE(SUM(CASE WHEN bucket='peak' THEN miss ELSE 0 END),0) AS missPeak,
  COALESCE(SUM(CASE WHEN bucket='peak' THEN hit ELSE 0 END),0) AS hitPeak,
  COALESCE(SUM(CASE WHEN bucket='peak' THEN out ELSE 0 END),0) AS outPeak,
  COALESCE(SUM(CASE WHEN bucket!='peak' THEN miss ELSE 0 END),0) AS missOff,
  COALESCE(SUM(CASE WHEN bucket!='peak' THEN hit ELSE 0 END),0) AS hitOff,
  COALESCE(SUM(CASE WHEN bucket!='peak' THEN out ELSE 0 END),0) AS outOff`;

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
  // --- Persona mirror (V2 · Phase 2) ---------------------------------------
  // Character cards live on disk; this table keeps the last content the console
  // saved so a damaged card file can still be served. It is never the source of
  // truth, and a deleted file is never resurrected from here.
  savePersona(name, content, now = Date.now()) {
    this.db.prepare(`INSERT INTO personas (name, content, updated) VALUES (?,?,?)
      ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated=excluded.updated`)
      .run(String(name), String(content), now);
  }
  getPersona(name) {
    return this.db.prepare('SELECT name, content, updated FROM personas WHERE name=?').get(String(name)) ?? null;
  }
  deletePersona(name) { this.db.prepare('DELETE FROM personas WHERE name=?').run(String(name)); }
  // --- Token samples (V2 · Phase 5) ----------------------------------------
  // Global monotonic turn id, allocated in SQLite so it never restarts at 1.
  nextTurn() {
    return this.db.prepare(`INSERT INTO counters (name, value) VALUES ('turn', 1)
      ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`).get().value;
  }
  // Append one server-reported sample. Idempotent: a replayed `turn_key` only
  // overwrites when it carries a strictly newer timestamp, so a retry after a
  // crash cannot double-count a turn.
  noteSample({ turnKey, session, turn, seq, at, miss, hit, out, bucket = 'peak' }) {
    return this.db.prepare(`INSERT INTO token_samples (turn_key, session, turn, seq, at, miss, hit, out, bucket)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(turn_key) DO UPDATE SET at=excluded.at, miss=excluded.miss, hit=excluded.hit,
        out=excluded.out, bucket=excluded.bucket
      WHERE excluded.at > token_samples.at`)
      .run(String(turnKey), String(session), turn, seq, at, miss, hit, out, bucket).changes;
  }
  costTotals({ since = 0, until = Number.MAX_SAFE_INTEGER } = {}) {
    return this.db.prepare(`SELECT ${SPLITS},
      COUNT(*) AS calls, COUNT(DISTINCT session || ':' || turn) AS turns
      FROM token_samples WHERE at >= ? AND at < ?`).get(since, until);
  }
  // Per time-slot aggregates. `slot` is derived in China time so a "day" bucket
  // matches the billing day, not the UTC day.
  costSeries({ since = 0, until = Number.MAX_SAFE_INTEGER, unitMs = 3600000 } = {}) {
    const unit = Math.max(60000, Number(unitMs) || 3600000);
    return this.db.prepare(`SELECT CAST((at + ${CHINA_SHIFT}) / ? AS INTEGER) AS slot, ${SPLITS},
      COUNT(*) AS calls FROM token_samples WHERE at >= ? AND at < ?
      GROUP BY slot ORDER BY slot`).all(unit, since, until)
      .map(row => ({ t: row.slot * unit - CHINA_SHIFT, ...row }));
  }
  costSessions({ since = 0, until = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    return this.db.prepare(`SELECT session, ${SPLITS}, COUNT(*) AS calls,
      COUNT(DISTINCT turn) AS turns, MAX(at) AS last FROM token_samples
      WHERE at >= ? AND at < ? GROUP BY session
      ORDER BY (COALESCE(SUM(miss),0)+COALESCE(SUM(hit),0)+COALESCE(SUM(out),0)) DESC LIMIT ?`)
      .all(since, until, Math.max(1, Math.min(200, Number(limit) || 50)));
  }
  costTurns({ session, limit = 100 } = {}) {
    return this.db.prepare(`SELECT turn, ${SPLITS}, COUNT(*) AS calls,
      MIN(at) AS at, MAX(at) AS last FROM token_samples WHERE session = ?
      GROUP BY turn ORDER BY turn DESC LIMIT ?`)
      .all(String(session), Math.max(1, Math.min(500, Number(limit) || 100)));
  }
  recentSamples(limit = 40) {
    return this.db.prepare(`SELECT turn_key, session, turn, seq, at, miss, hit, out, bucket
      FROM token_samples ORDER BY at DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit) || 40)));
  }
  // Bounded growth: keep the newest `cap` rows (the roadmap's 20000-row ceiling).
  pruneSamples(cap = 20000) {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM token_samples').get().n;
    const excess = total - Math.max(100, Number(cap) || 20000);
    if (excess <= 0) return 0;
    return this.db.prepare(`DELETE FROM token_samples WHERE turn_key IN
      (SELECT turn_key FROM token_samples ORDER BY at ASC LIMIT ?)`).run(excess).changes;
  }
}
