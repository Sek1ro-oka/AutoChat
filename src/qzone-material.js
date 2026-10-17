// Material for an autonomous QQ Zone post (I-09 §3).
//
// The post is supposed to come from "something that happened in a group", so
// the raw material is the group message ledger (`messages`, written by the
// social simulation and by QZone's own intake). Everything here is a *free*
// pre-filter: rules decide what may reach the model, the model only decides
// whether the remaining material is worth a post. A message that carries a
// number, a link or an `@` is dropped here, before it can be quoted, because
// the cheapest way to keep a QQ number out of a public post is to never send it.
//
// Pure by construction (no clock, no store), so the rules are unit-testable and
// the caller owns the policy knobs (`QZONE_MATERIAL_TTL_HOURS`, `BLOCK_TERMS`).
import { containsTerm } from './terms.js';

export const MATERIAL_MIN_CHARS = 4;
export const MATERIAL_MAX_CHARS = 200;
// One batch is one model call, so this bounds what a single evaluation costs.
export const MAX_BATCH = 60;

// One reason per drop rule; `null` means "usable material".
export const PREFILTER_REASONS = Object.freeze([
  'own', 'empty', 'command', 'length', 'emoji', 'link', 'number', 'mention', 'markup', 'term',
]);

const NUMBER_RE = /\d{5,12}/;
const LINK_RE = /https?:\/\/|www\./i;
// Emoji, punctuation and symbols are not material on their own: a message with
// no letter and no digit ("😂😂😂😂", "。。。。") says nothing to write about.
const MEANINGFUL_RE = /[\p{L}\p{N}]/u;

// Why this single message is unusable, as an enum — or null when it is fine.
export function prefilterReason({ text = '', userId = '', botId = '', blockTerms = [] } = {}) {
  const body = String(text ?? '').trim();
  if (botId && String(userId) === String(botId)) return 'own';
  if (!body) return 'empty';
  if (body.startsWith('/')) return 'command';
  const len = Array.from(body).length;
  if (len < MATERIAL_MIN_CHARS || len > MATERIAL_MAX_CHARS) return 'length';
  if (!MEANINGFUL_RE.test(body)) return 'emoji';
  if (LINK_RE.test(body)) return 'link';
  if (NUMBER_RE.test(body)) return 'number';
  if (body.includes('@')) return 'mention';
  if (body.includes('【')) return 'markup';
  if (containsTerm(body, blockTerms)) return 'term';
  return null;
}

// Ledger rows (`group_id, message_id, user_id, at, text`) -> the material of the
// current batch, oldest first. `cursor` is the highest `at` already consumed, so
// a batch is never evaluated twice; `ttlMs` keeps old chatter out — a post may
// only be about "what just happened", which is also what makes quoting a stale
// context less likely. Private chats never reach this table with a group scope,
// and the whitelist is re-checked here anyway.
export function selectMaterial(rows, {
  now = Date.now(), ttlMs = 0, groupIds = [], botId = '', blockTerms = [], cursor = 0,
} = {}) {
  const allowed = new Set((groupIds ?? []).map(id => String(id)));
  const cursorAt = Number(cursor) || 0;
  const kept = [];
  for (const row of rows ?? []) {
    const group = String(row?.group_id ?? '');
    if (!allowed.has(group)) continue;
    const at = Number(row?.at);
    if (!Number.isFinite(at)) continue;
    if (at <= cursorAt) continue;
    if (ttlMs > 0 && now - at > ttlMs) continue;
    const text = String(row?.text ?? '').trim();
    if (prefilterReason({ text, userId: row?.user_id, botId, blockTerms })) continue;
    kept.push({
      groupId: group, messageId: String(row?.message_id ?? ''),
      userId: String(row?.user_id ?? ''), at, text,
    });
  }
  return kept.sort((a, b) => a.at - b.at
    || a.messageId.length - b.messageId.length
    || a.messageId.localeCompare(b.messageId));
}

// Oldest `max` rows, still ascending. The oldest first because the cursor only
// advances over what was actually evaluated: taking the newest window would
// leave a growing unfunded backlog between the cursor and the batch.
export function chunkBatch(material, max = MAX_BATCH) {
  const limit = Math.max(1, Number(max) || MAX_BATCH);
  return (material ?? []).slice(0, limit);
}
