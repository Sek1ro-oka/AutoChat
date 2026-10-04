import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Billing and time-bucket boundaries are always China time (UTC+8, no DST).
export const CHINA_OFFSET_MS = 8 * 3600000;
const CHINA_SHIFT = CHINA_OFFSET_MS;

export function budgetDay(now = Date.now()) {
  return new Date(now + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

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

// `source(s)`/`evidence` columns are JSON arrays; a row that fails to parse is
// treated as empty rather than throwing, so one bad row cannot hide the library.
const parseArray = value => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
const slangRow = row => (row ? { ...row, sources: parseArray(row.sources), evidence: parseArray(row.evidence) } : null);
const unique = list => [...new Set((Array.isArray(list) ? list : []).map(item => String(item)).filter(Boolean))];

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
    // One row per term (Phase 4). No released code path has ever written to
    // `slang`, so collapsing duplicates is only a safety net; both statements
    // are idempotent and safe to run on every startup.
    this.db.exec('DELETE FROM slang WHERE rowid NOT IN (SELECT MIN(rowid) FROM slang GROUP BY content)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS slang_content ON slang(content)');
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
  getMessage(groupId, messageId) {
    return this.db.prepare(`SELECT group_id, message_id, user_id, at, text, kind FROM messages
      WHERE group_id=? AND message_id=?`).get(String(groupId), String(messageId)) ?? null;
  }
  // --- Social simulation state (V2 · Phase 3) ------------------------------
  // One small row per group: the state machine's whole memory. `last_spoke_at`
  // is what every cooldown and idle calculation is measured from.
  getSimState(groupId) {
    return this.db.prepare(`SELECT group_id, state, last_spoke_at, energy, updated FROM sim_state
      WHERE group_id=?`).get(String(groupId)) ?? null;
  }
  saveSimState({ groupId, state, lastSpokeAt = null, energy = 0, updated = Date.now() }) {
    this.db.prepare(`INSERT INTO sim_state (group_id, state, last_spoke_at, energy, updated)
      VALUES (?,?,?,?,?)
      ON CONFLICT(group_id) DO UPDATE SET state=excluded.state, last_spoke_at=excluded.last_spoke_at,
        energy=excluded.energy, updated=excluded.updated`)
      .run(String(groupId), String(state), lastSpokeAt, Number(energy) || 0, updated);
  }
  listSimStates() {
    return this.db.prepare(`SELECT group_id, state, last_spoke_at, energy, updated FROM sim_state
      ORDER BY group_id`).all();
  }
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
  // --- Slang library (V2 · Phase 4) ----------------------------------------
  // One row per term. `status` is the only thing that decides whether a term is
  // ever injected into a prompt, so an unconfirmed candidate is inert. `count`
  // is how many times extraction has seen it; `sources`/`evidence` record where
  // the meaning came from and which group messages backed it.
  listSlang({ status = null, limit = 500 } = {}) {
    const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
    if (status) {
      return this.db.prepare(`SELECT * FROM slang WHERE status=? ORDER BY count DESC, updated DESC LIMIT ?`)
        .all(String(status), cap).map(slangRow);
    }
    // Confirmed first: that is the order a human reads the console list in.
    return this.db.prepare(`SELECT * FROM slang ORDER BY (status='confirmed') DESC, count DESC, updated DESC LIMIT ?`)
      .all(cap).map(slangRow);
  }
  getSlang(id) { return slangRow(this.db.prepare('SELECT * FROM slang WHERE id=?').get(String(id))); }
  countSlang() {
    return this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END),0) AS confirmed,
      COALESCE(SUM(CASE WHEN status='candidate' THEN 1 ELSE 0 END),0) AS candidate,
      COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rejected
      FROM slang`).get();
  }
  // Observation semantics: a new term is inserted as a candidate, an existing
  // one only accumulates evidence and a counter. The status is deliberately not
  // touched — a human rejection must survive the next extraction.
  upsertSlang({ content, meaning = '', usage = '', example = '', risk = '', status = 'candidate',
    source = 'ai', sources = [], evidence = [], now = Date.now() }) {
    const term = String(content ?? '').trim();
    if (!term) throw new Error('SLANG_TERM_INVALID');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM slang WHERE content=?').get(term);
      if (!existing) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO slang (id, content, meaning, usage, example, risk, status, source,
          count, sources, evidence, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, term, String(meaning), String(usage), String(example), String(risk), String(status),
            String(source), 1, JSON.stringify(unique(sources)), JSON.stringify(unique(evidence)), now, now);
        return { id, content: term, created: true, count: 1 };
      }
      const count = Number(existing.count) + 1;
      this.db.prepare(`UPDATE slang SET meaning=?, usage=?, example=?, risk=?, count=?,
        sources=?, evidence=?, updated=? WHERE id=?`)
        .run(existing.meaning || String(meaning), existing.usage || String(usage),
          existing.example || String(example), existing.risk || String(risk), count,
          JSON.stringify(unique([...parseArray(existing.sources), ...(Array.isArray(sources) ? sources : [])])),
          JSON.stringify(unique([...parseArray(existing.evidence), ...(Array.isArray(evidence) ? evidence : [])])),
          now, existing.id);
      return { id: existing.id, content: term, created: false, count };
    });
  }
  setSlangStatus(id, status, now = Date.now()) {
    return this.db.prepare('UPDATE slang SET status=?, updated=? WHERE id=?')
      .run(String(status), now, String(id)).changes;
  }
  // Text fields plus provenance (`source`/`sources`), which the web lookup sets
  // together with the meaning it proposes.
  updateSlang(id, fields = {}, now = Date.now()) {
    const sets = [];
    const values = [];
    for (const key of ['meaning', 'usage', 'example', 'risk']) {
      if (typeof fields[key] === 'string') { sets.push(`${key}=?`); values.push(fields[key]); }
    }
    if (typeof fields.source === 'string') { sets.push('source=?'); values.push(fields.source); }
    if (Array.isArray(fields.sources)) { sets.push('sources=?'); values.push(JSON.stringify(unique(fields.sources))); }
    if (!sets.length) return null;
    this.db.prepare(`UPDATE slang SET ${sets.join(', ')}, updated=? WHERE id=?`).run(...values, now, String(id));
    return this.getSlang(id);
  }
  deleteSlang(id) { return this.db.prepare('DELETE FROM slang WHERE id=?').run(String(id)).changes; }
  exportSlang() { return this.db.prepare('SELECT * FROM slang ORDER BY created, content').all(); }
  // Restore semantics for a backup file: keep every human decision that already
  // exists locally, take the larger count, and fill blanks. Runs as one
  // transaction so a partial import cannot leave half a library behind.
  restoreSlang(rows, now = Date.now()) {
    let added = 0; let merged = 0;
    return this.transaction(() => {
      for (const row of Array.isArray(rows) ? rows : []) {
        const term = String(row?.content ?? '').trim();
        if (!term) continue;
        const existing = this.db.prepare('SELECT * FROM slang WHERE content=?').get(term);
        if (!existing) {
          const status = ['candidate', 'confirmed', 'rejected'].includes(row.status) ? row.status : 'candidate';
          this.db.prepare(`INSERT INTO slang (id, content, meaning, usage, example, risk, status, source,
            count, sources, evidence, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(), term, String(row.meaning ?? ''), String(row.usage ?? ''), String(row.example ?? ''),
              String(row.risk ?? ''), status, String(row.source ?? 'import'),
              Math.max(1, Number(row.count) || 1), JSON.stringify(unique(row.sources)),
              JSON.stringify(unique(row.evidence)), Number(row.created) || now, now);
          added += 1;
          continue;
        }
        this.db.prepare(`UPDATE slang SET meaning=?, usage=?, example=?, risk=?, count=?,
          sources=?, evidence=?, updated=? WHERE id=?`)
          .run(existing.meaning || String(row.meaning ?? ''), existing.usage || String(row.usage ?? ''),
            existing.example || String(row.example ?? ''), existing.risk || String(row.risk ?? ''),
            Math.max(Number(existing.count) || 1, Number(row.count) || 1),
            JSON.stringify(unique([...parseArray(existing.sources), ...unique(row.sources)])),
            JSON.stringify(unique([...parseArray(existing.evidence), ...unique(row.evidence)])), now, existing.id);
        merged += 1;
      }
      return { added, merged };
    });
  }
  // Capacity ceiling. Trim lowest-keep-priority first: an unconfirmed, rarely
  // seen, stale term goes before a confirmed one.
  trimSlang(cap = 2000) {
    const limit = Math.max(1, Number(cap) || 2000);
    const total = this.countSlang().total;
    if (total <= limit) return 0;
    return this.db.prepare(`DELETE FROM slang WHERE id IN
      (SELECT id FROM slang ORDER BY (status='confirmed') ASC, count ASC, updated ASC LIMIT ?)`)
      .run(total - limit).changes;
  }
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
