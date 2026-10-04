// Slang persistence (V2 · Phase 4), split out of store.js when per-group
// scoping pushed that file past the project's size ceiling.
//
// `Store` extends this class, so every method is still reached as
// `store.listSlang(...)` and uses the same `this.db` / `this.transaction` the
// rest of the persistence layer does. The table contract lives in schema.js.
//
// Scoping rule, stated once here because it is the whole reason this file knows
// about groups: a term with no row in `slang_groups` is global (injected into
// every group); a term with rows is injected only into those groups.

import { randomUUID } from 'node:crypto';

// `sources`/`evidence` columns are JSON arrays; a row that fails to parse is
// treated as empty rather than throwing, so one bad row cannot hide the library.
const parseArray = value => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
const slangRow = row => (row ? { ...row, sources: parseArray(row.sources), evidence: parseArray(row.evidence) } : null);
const unique = list => [...new Set((Array.isArray(list) ? list : []).map(item => String(item)).filter(Boolean))];

export class SlangStore {
  // One row per term. `status` is the only thing that decides whether a term is
  // ever injected into a prompt, so an unconfirmed candidate is inert. `count`
  // is how many times extraction has seen it; `sources`/`evidence` record where
  // the meaning came from and which group messages backed it.
  listSlang({ status = null, limit = 500, group = null } = {}) {
    const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
    // Passing `group` is what the injection path does; passing nothing returns
    // the whole library, which is what the console lists.
    const scope = group === null ? '' :
      ` AND (NOT EXISTS (SELECT 1 FROM slang_groups sg WHERE sg.slang_id = slang.id)
        OR EXISTS (SELECT 1 FROM slang_groups sg WHERE sg.slang_id = slang.id AND sg.group_id = ?))`;
    const args = group === null ? [] : [String(group)];
    if (status) {
      return this.db.prepare(`SELECT * FROM slang WHERE status=?${scope} ORDER BY count DESC, updated DESC LIMIT ?`)
        .all(String(status), ...args, cap).map(slangRow);
    }
    // Confirmed first: that is the order a human reads the console list in.
    return this.db.prepare(`SELECT * FROM slang WHERE 1=1${scope} ORDER BY (status='confirmed') DESC, count DESC, updated DESC LIMIT ?`)
      .all(...args, cap).map(slangRow);
  }
  // Every id -> groups association, in one query, so the console can annotate a
  // whole list without an N+1 loop.
  slangGroupRows() { return this.db.prepare('SELECT slang_id, group_id FROM slang_groups').all(); }
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
    source = 'ai', sources = [], evidence = [], groups = [], now = Date.now() }) {
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
        // Extraction knows which group the term came from, so a new term starts
        // scoped to it; the operator widens or clears that in the console.
        this.addSlangGroups(id, groups);
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
      // A term seen in a second group belongs to both; scopes only ever widen here.
      this.addSlangGroups(existing.id, groups);
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
  // Scopes are dropped with the term: a dangling slang_groups row would be
  // harmless today but would resurface if the same id were ever reused.
  deleteSlang(id) {
    const target = String(id);
    return this.transaction(() => {
      this.db.prepare('DELETE FROM slang_groups WHERE slang_id=?').run(target);
      return this.db.prepare('DELETE FROM slang WHERE id=?').run(target).changes;
    });
  }
  // Widen only: a term that was already scoped keeps every group it had.
  addSlangGroups(id, groups = []) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO slang_groups (slang_id, group_id) VALUES (?,?)');
    for (const group of unique(groups)) insert.run(String(id), group);
  }
  // Replace: the console's scope editor sets the whole set at once. An empty
  // list clears every row, which makes the term global again.
  setSlangGroups(id, groups = []) {
    const target = String(id);
    const list = unique(groups);
    return this.transaction(() => {
      this.db.prepare('DELETE FROM slang_groups WHERE slang_id=?').run(target);
      this.addSlangGroups(target, list);
      return list;
    });
  }
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
    const removed = this.db.prepare(`DELETE FROM slang WHERE id IN
      (SELECT id FROM slang ORDER BY (status='confirmed') ASC, count ASC, updated ASC LIMIT ?)`)
      .run(total - limit).changes;
    // Scopes of the terms just dropped, so the table cannot grow past the
    // library it describes.
    this.db.prepare('DELETE FROM slang_groups WHERE slang_id NOT IN (SELECT id FROM slang)').run();
    return removed;
  }
}
