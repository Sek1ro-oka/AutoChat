// Sticker persistence (V2 · Phase 6), split out of store.js for the same reason
// the slang library was: a size ceiling, and a clear ownership boundary.
//
// `Store` extends this class, so every method is still reached as
// `store.listStickers(...)` and uses the same `this.db` / `this.transaction` the
// rest of the persistence layer does. The table contract lives in schema.js.
//
// The `id` column is the picture's own md5 (when QQ supplies one) or a hash of
// its URL — computed by stickers.js — so this layer never has to know how a
// picture is identified, only that the same id means the same picture.

import { SlangStore } from './store-slang.js';
import { MAX_STICKERS } from './stickers.js';

// `tags` is a JSON array; a row that fails to parse is treated as empty rather
// than throwing, so one bad row cannot hide the library.
const parseTags = value => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
};

const stickerRow = row => (row ? { ...row, tags: parseTags(row.tags) } : null);

// Extends SlangStore so `Store` can keep a single inheritance chain — Store
// extends StickerStore extends SlangStore — and every persistence method stays
// reachable as `store.*` regardless of which phase it belongs to.
export class StickerStore extends SlangStore {
  // One row per picture. `status` gates whether it is ever offered to the model
  // for sending; an unconfirmed candidate is inert on the way out.
  listStickers({ status = null, limit = 500 } = {}) {
    const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
    if (status) {
      return this.db.prepare(`SELECT * FROM stickers WHERE status=? ORDER BY use_count DESC, updated DESC LIMIT ?`)
        .all(String(status), cap).map(stickerRow);
    }
    // Confirmed first: that is the order a human reads the console list in.
    return this.db.prepare(`SELECT * FROM stickers ORDER BY (status='confirmed') DESC, use_count DESC, updated DESC LIMIT ?`)
      .all(cap).map(stickerRow);
  }
  getSticker(id) { return stickerRow(this.db.prepare('SELECT * FROM stickers WHERE id=?').get(String(id))); }
  countStickers() {
    return this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END),0) AS confirmed,
      COALESCE(SUM(CASE WHEN status='candidate' THEN 1 ELSE 0 END),0) AS candidate,
      COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rejected
      FROM stickers`).get();
  }
  // Observation semantics, mirroring slang: a new picture lands as a candidate,
  // a repeat only bumps the `seen` counter and keeps whatever the human decided.
  // `status` is deliberately never downgraded here — a rejection must survive
  // the next time the same picture is posted.
  upsertSticker({ id, md5 = '', url = '', file = '', desc = '', note = '', tags = [],
    source = 'qq', status = 'candidate', now = Date.now() }) {
    const key = String(id ?? '');
    if (!key) throw new Error('STICKER_ID_INVALID');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM stickers WHERE id=?').get(key);
      if (!existing) {
        this.db.prepare(`INSERT INTO stickers (id, md5, url, file, desc, note, tags, source, status,
          seen, use_count, last_used, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(key, String(md5), String(url), String(file), String(desc), String(note),
            JSON.stringify([...new Set((Array.isArray(tags) ? tags : []).map(String).filter(Boolean))].slice(0, 12)),
            String(source), String(status), 1, 0, 0, now, now);
        return { id: key, created: true, seen: 1 };
      }
      // A repeat fills in whatever the first sighting did not know (the local
      // file path, for example, which exists only after the download lands).
      this.db.prepare(`UPDATE stickers SET file=CASE WHEN ?!='' THEN ? ELSE file END, updated=?, seen=seen+1
        WHERE id=?`).run(String(file), String(file), now, key);
      return { id: key, created: false, seen: Number(existing.seen) + 1 };
    });
  }
  setStickerStatus(id, status, now = Date.now()) {
    return this.db.prepare('UPDATE stickers SET status=?, updated=? WHERE id=?')
      .run(String(status), now, String(id)).changes;
  }
  // Text fields plus tags, which the console edits.
  updateSticker(id, fields = {}, now = Date.now()) {
    const sets = [];
    const values = [];
    for (const key of ['desc', 'note', 'file', 'url']) {
      if (typeof fields[key] === 'string') { sets.push(`${key}=?`); values.push(fields[key]); }
    }
    if (Array.isArray(fields.tags)) {
      sets.push('tags=?');
      values.push(JSON.stringify([...new Set(fields.tags.map(String).filter(Boolean))].slice(0, 12)));
    }
    if (!sets.length) return null;
    this.db.prepare(`UPDATE stickers SET ${sets.join(', ')}, updated=? WHERE id=?`).run(...values, now, String(id));
    return this.getSticker(id);
  }
  // One use, counted and timestamped, so the injected block can rank by recency
  // and the console can show "用过 N 次".
  recordStickerUse(id, now = Date.now()) {
    return this.db.prepare('UPDATE stickers SET use_count=use_count+1, last_used=? WHERE id=?')
      .run(now, String(id)).changes;
  }
  deleteSticker(id) { return this.db.prepare('DELETE FROM stickers WHERE id=?').run(String(id)).changes; }
  exportStickers() { return this.db.prepare('SELECT * FROM stickers ORDER BY created, id').all(); }
  // Capacity ceiling, mirroring trimSlang. An unconfirmed, rarely used, stale
  // picture goes before a confirmed one. The caller removes the file too.
  trimStickers(cap = MAX_STICKERS) {
    const limit = Math.max(1, Number(cap) || MAX_STICKERS);
    const total = this.countStickers().total;
    if (total <= limit) return 0;
    return this.db.prepare(`DELETE FROM stickers WHERE id IN
      (SELECT id FROM stickers ORDER BY (status='confirmed') ASC, use_count ASC, updated ASC LIMIT ?)`)
      .run(total - limit).changes;
  }
}
