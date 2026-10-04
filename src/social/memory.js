// Bounded in-memory memory of one group's recent lines (V2 · Phase 3).
//
// Why memory and not SQLite for the bot's own lines: NapCat does not reliably
// echo messages the bot itself sent, so the `messages` table is written by the
// engine for *other* members only. A line recorded twice — once locally, once by
// a late echo — would show up twice in the prompt and make the bot answer
// itself. Keeping our own lines here sidesteps that entirely, at the documented
// cost that a restart forgets what the bot just said.
//
// The ring is seeded from the database the first time a group is seen, so a
// restart still has some context, and it is capped so a busy group cannot grow
// the process heap.

export const RING_SIZE = 20;
const DEDUPE_WINDOW_MS = 10000;

export class GroupMemory {
  constructor({ store = null, ttlMs = 24 * 3600000, now = Date.now, size = RING_SIZE } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
    this.size = size;
    this.rings = new Map();   // group -> entries, ascending time
    this.labels = new Map();  // group -> Map<qq, 群友N>
  }

  ring(group) {
    if (!this.rings.has(group)) {
      const rows = this.store?.recentMessages?.(group, {
        since: this.now() - this.ttlMs, limit: this.size,
      }) ?? [];
      this.rings.set(group, rows.slice().reverse().map(row => ({
        id: row.message_id, at: row.at, user: row.user_id, text: row.text, bot: false,
      })));
    }
    return this.rings.get(group);
  }

  // QQ numbers never reach a prompt: members are relabelled in first-seen order.
  label(group, user) {
    if (!this.labels.has(group)) this.labels.set(group, new Map());
    const map = this.labels.get(group);
    if (!map.has(user)) map.set(user, `群友${map.size + 1}`);
    return map.get(user);
  }

  remember(entry) {
    const ring = this.ring(entry.group);
    const last = ring[ring.length - 1];
    // A self-echo of a line we just sent is the same line, not a new one.
    if (last && last.user === entry.user && last.text === entry.text
        && Math.abs(entry.at - last.at) < DEDUPE_WINDOW_MS) return;
    ring.push({ id: entry.id ?? null, at: entry.at, user: entry.user, text: entry.text, bot: Boolean(entry.fromBot) });
    if (ring.length > this.size) ring.splice(0, ring.length - this.size);
  }

  isBotLine(group, messageId) {
    if (!messageId) return false;
    return this.ring(group).some(entry => entry.bot && entry.id !== null && entry.id === String(messageId));
  }

  // The quoted line, from memory first and the database second (a member may
  // reply to something older than the ring still holds).
  lookup(group, messageId) {
    const hit = this.ring(group).find(entry => entry.id !== null && entry.id === String(messageId));
    if (hit) return hit;
    const row = this.store?.getMessage?.(group, messageId);
    return row ? { user: row.user_id, text: row.text, bot: false } : null;
  }

  recent(group, limit) {
    return this.ring(group).slice(-Math.max(1, limit));
  }

  botTexts(group, limit) {
    return this.ring(group).filter(entry => entry.bot).map(entry => entry.text).slice(-Math.max(1, limit));
  }

  active(group, windowMs) {
    const now = this.now();
    return this.ring(group).filter(entry => now - entry.at <= windowMs).length;
  }
}
