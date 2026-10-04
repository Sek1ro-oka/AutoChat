// The database contract, kept apart from the operations in store.js so adding a
// table to a phase never forces a reader through the query code — and so neither
// file has to grow past the project's 400-line ceiling.
//
// Tables are created with their *current* shape. A database created by an older
// version is upgraded in place by `Store.migrate()` (see the ALTER TABLE notes
// there); both paths must stay idempotent.

export const SCHEMA = `
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
  -- Slang library (Phase 4). The term column is unique: one row per term.
  CREATE TABLE IF NOT EXISTS slang (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '',
    usage TEXT NOT NULL DEFAULT '', example TEXT NOT NULL DEFAULT '', risk TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate', source TEXT NOT NULL DEFAULT 'ai',
    count INTEGER NOT NULL DEFAULT 1, sources TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS slang_status ON slang(status);
  -- Per-group slang scoping (per-group specialisation). A term with no row here
  -- is global — injected into every group — which keeps every pre-existing
  -- library behaving as before. A term with rows is injected only into those
  -- groups. No foreign key: the table is tiny and trimSlang/deleteSlang clean
  -- orphans explicitly, so a missing FK cannot leave dangling scopes.
  CREATE TABLE IF NOT EXISTS slang_groups (
    slang_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (slang_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS slang_groups_group ON slang_groups(group_id);
  CREATE TABLE IF NOT EXISTS sim_state (
    group_id TEXT PRIMARY KEY, state TEXT NOT NULL, last_spoke_at INTEGER,
    energy REAL NOT NULL DEFAULT 0, updated INTEGER NOT NULL
  );
  -- Sticker library (V2 · Phase 6). One row per collected picture. The id
  -- column is the picture's own md5 when QQ supplies one, else a hash of its
  -- URL, so the same picture collected twice never doubles up. The file column
  -- points at the local copy under data/stickers/; empty until it downloads.
  CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY, md5 TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL DEFAULT '', desc TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'qq',
    status TEXT NOT NULL DEFAULT 'candidate', seen INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS stickers_status ON stickers(status);
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
