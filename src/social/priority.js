// Priority arbitration for a burst of group messages (I-06 · A-04).
//
// `attention.js` turns a message into one *scalar* score, which answers "may we
// speak at all". That number is deliberately unusable for ordering: it moves
// with the group's state and its energy, so the same line is worth 12 in one
// state and 4 in another, and the same score means different things on two
// days (research §3.2). Ordering needs a second, stable key — that is what this
// table is: a finite enum derived from the reasons the scorer already pushed,
// compared as integers.
//
// Pure by construction: no clock, no store, no logging of its own. `onUnknown`
// is handed in by the caller, so an unmapped reason is still visible without
// this module doing I/O.

export const PRIORITY = Object.freeze({
  addressed: 4,   // @-mentioned or called by name: the rule tier, bypasses the window
  reply: 3,       // quoting a line of ours
  name: 2,        // our name appears in the text
  question: 2,    // a question
  others: 1,      // talking to somebody else
  base: 1,        // plain chatter
});

// One utterance per group per window. A constant, not a config key: a setting
// would surface on the console settings page, which needs its own demo.
export const BURST_WINDOW_MS = 2000;

// `activity` is an environment reading; `night` and `repeat` only ever subtract
// from the score. None of them says "this candidate deserves the slot more", so
// they are skipped rather than reported as unknown — they are in `reasons` on
// almost every line (attention.js pushes them unconditionally when they apply).
const NOT_A_TIER = new Set(['activity', 'night', 'repeat']);

// Highest tier among `reasons`. An unknown reason counts as `base` and is
// reported once per occurrence, so a typo in attention.js cannot silently
// promote a candidate and cannot silently demote one either.
export function priorityOf(reasons, onUnknown = () => {}) {
  let best = 0;
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    if (NOT_A_TIER.has(reason)) continue;
    if (!Object.hasOwn(PRIORITY, reason)) { onUnknown(reason); best = Math.max(best, PRIORITY.base); continue; }
    best = Math.max(best, PRIORITY[reason]);
  }
  return best || PRIORITY.base;
}

// "Strictly higher" only: an equal-priority message inside the window is the
// same thing said twice, and gets dropped rather than answered twice.
export function shouldUpgrade(current, incoming) { return incoming > current; }

// The reason that carried a candidate to its tier, for the suppression log:
// `keptReason: 'base', droppedReason: 'question'` says more than `1 < 2` does.
export function reasonOf(reasons, priority = priorityOf(reasons)) {
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    if (!NOT_A_TIER.has(reason) && PRIORITY[reason] === priority) return reason;
  }
  return 'base';
}
