// Outbound gate for QQ Zone posts (I-09 §5).
//
// The model writes the post; this module decides whether it may leave the
// machine at all. The rules are absolute — no context, no exceptions — because
// the two failure modes they guard are exactly the ones that cannot be undone
// once the post is public:
//
//   * a privacy leak: a QQ number, a whitelisted group id, a link, an `@` or a
//     fullwidth bracket the model copied out of the chat instead of writing its
//     own thought;
//   * a public accident: a blocked term, or the same post twice.
//
// Pure by construction — no clock, no store, no config object — so each rule can
// be tested on its own, which the acceptance list requires. The caller learns
// only `{ ok, reason, len }`: the post text never comes back out of here.
import { containsTerm } from './terms.js';

export const POST_MIN_CHARS = 8;
export const POST_MAX_CHARS = 200;
export const REPEAT_LIMIT = 3;
export const REPEAT_SIMILARITY = 0.8;

// One reason per rule. The order is the order they are checked:
// length, then the specific leak checks, then the fuzzy one.
export const GUARD_REASONS = Object.freeze(['length', 'groupid', 'number', 'link', 'markup', 'term', 'repeat']);

const NUMBER_RE = /\d{5,12}/;
const LINK_RE = /https?:\/\/|www\./i;
// `【` / `】` are the brackets our own prompt markers use (see social/quote.js),
// and `[CQ:` is a serialised message segment rather than prose.
const MARKUP_RE = /[@【】]|\[cq:/i;

// Whitespace-, punctuation- and case-insensitive form, so "好耶！" and "好耶"
// compare as the same line.
const normalize = text => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

const bigrams = text => {
  const map = new Map();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
};

// Sørensen–Dice coefficient over character bigrams: 1 when the two texts are the
// same line, 0 when they share nothing. A post is "the same post again" when it
// clears REPEAT_SIMILARITY against any of the last REPEAT_LIMIT posts — a Dice
// score is symmetric and needs no tokenizer, which matters for Chinese text.
export function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const first = bigrams(a);
  const second = bigrams(b);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  let total = 0;
  for (const [gram, count] of first) {
    total += count;
    shared += Math.min(count, second.get(gram) ?? 0);
  }
  for (const count of second.values()) total += count;
  return total ? (2 * shared) / total : 0;
}

// `ctx`: `{ groupIds, blockTerms, recent }` — the last is the most recent post
// texts, newest first. Returns `{ ok, reason, len }`; `len` is the trimmed
// character count so the caller can log a length without logging the text.
export function guardPost(text, ctx = {}) {
  const body = String(text ?? '').trim();
  const len = Array.from(body).length;
  if (len < POST_MIN_CHARS || len > POST_MAX_CHARS) return { ok: false, reason: 'length', len };
  // Group ids are checked before the generic digit run: a whitelisted group id is
  // itself 5–12 digits, and "this text contains a group we watch" is the sharper
  // diagnosis for the same block. Without that order the rule could never fire.
  const groups = (ctx.groupIds ?? []).map(id => String(id)).filter(Boolean);
  if (groups.some(id => body.includes(id))) return { ok: false, reason: 'groupid', len };
  if (NUMBER_RE.test(body)) return { ok: false, reason: 'number', len };
  if (LINK_RE.test(body)) return { ok: false, reason: 'link', len };
  if (MARKUP_RE.test(body)) return { ok: false, reason: 'markup', len };
  if (containsTerm(body, ctx.blockTerms ?? [])) return { ok: false, reason: 'term', len };
  const recent = (ctx.recent ?? [])
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, REPEAT_LIMIT);
  if (recent.some(older => similarity(body, older) > REPEAT_SIMILARITY)) {
    return { ok: false, reason: 'repeat', len };
  }
  return { ok: true, reason: '', len };
}
